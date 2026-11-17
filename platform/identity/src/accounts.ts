import {
	type ContainerDefinition,
	type CosmosDocument,
	cosmosDatabase,
	hasStatus,
	type PatchSet,
	type Stored,
} from "@platform/cosmos";
import { CALLER_ASSERTION_TTL_SECONDS } from "./assertions";
import { SESSION_MAX_AGE_SECONDS } from "./claims/session";
import { stringList } from "./claims/values";

/**
 * The durable record of a sign-in, and of the person behind it. Identity
 * still originates from the provider's token; this is its projection,
 * upserted on every sign-in so accounts can be listed, audited and
 * deactivated. `roles` and `groups` are the provider's claims as of the last
 * sign-in. `id` is the provider's stable subject, the same value every
 * owner-scoped record and the agent's memory are keyed by.
 *
 * One account is one person: `name`, `about` and `preferences` are theirs to
 * edit, and the agent reads them into its prompt.
 */
export interface Account {
	id: string;
	email: string | null;
	/** The display name: the provider's until the person sets their own. */
	name: string | null;
	/** What the person wrote about themselves. */
	about: string | null;
	/** How they want to be talked to. */
	preferences: string | null;
	roles: string[];
	groups: string[];
	/** Deactivated: blocks the next sign-in and every call that would spend. */
	disabled: boolean;
	/**
	 * A voice tester's tuning of their own live sessions, as they last saved
	 * it; null for everybody else. Stored as given and checked where it is
	 * used (`@platform/agent/foundry`'s `checkVoiceTuning`), never trusted
	 * from here.
	 */
	voiceTuning: Record<string, unknown> | null;
	/** Null on what an erased, deactivated account leaves behind. */
	createdAt: string | null;
	lastLoginAt: string | null;
}

/** The fields a person edits; absent leaves a field as it is. */
export interface PersonPatch {
	name?: string;
	about?: string | null;
	preferences?: string | null;
}

/** Bounds on what a form may store. The prompt reads these, so their size is a prompt cost. */
export const PERSON_NAME_MAX = 60;
export const PERSON_TEXT_MAX = 1000;

/**
 * One document per account in its own partition, so every read here is a
 * point read. The template declares the container; the indexing policy
 * there leaves `about` and `preferences` out, since nothing queries them.
 */
const ACCOUNTS: ContainerDefinition = {
	name: "accounts",
	partitionKey: "/id",
	// What an erased account leaves behind removes itself.
	itemTtl: true,
};

/** The containers this package reads, for an app's start to verify and a test to create. */
export const identityContainers: readonly ContainerDefinition[] = [ACCOUNTS];

/**
 * How far the clock of the web app that stamps a session's sign-in may stand
 * from this one, and how long its report of a sign-in may take to arrive: a
 * minute covers both. Every comparison of a session's time with a time kept
 * here allows it.
 */
export const CLOCK_SKEW_SECONDS = 60;

/**
 * How long an erase is kept. A session ends at `SESSION_MAX_AGE_SECONDS`,
 * and the last assertion it minted is good for `CALLER_ASSERTION_TTL_SECONDS`
 * after that; the margin is for the two clocks. Past this, no caller that
 * began before the erase can still present itself, so the erase is no
 * longer anything to anyone.
 */
export const ERASE_KEPT_SECONDS =
	SESSION_MAX_AGE_SECONDS + CALLER_ASSERTION_TTL_SECONDS + CLOCK_SKEW_SECONDS;

/**
 * How long an erase may stand unrenewed before a sign-in or another erase
 * takes it for abandoned and finishes it itself. The request that holds an
 * erase renews it while it sweeps (`ERASE_RENEW_SECONDS`, `underLease`), so
 * a sweep that is slow but alive is never taken over, however long it
 * runs; one whose process died stops renewing, and shuts the person out
 * for no longer than this.
 */
export const ERASE_STALLED_SECONDS = 300;

/** How often the request that holds an erase renews it while it sweeps: well inside `ERASE_STALLED_SECONDS`. */
export const ERASE_RENEW_SECONDS = 60;

/**
 * The record as it is stored. `erasedAt` (seconds since the epoch, by this
 * side's clock) is when the account behind this id was last erased, kept so
 * a session that began before the erase is refused; `admittedAt` is when the
 * first sign-in after that erase was recorded, which is what makes the row a
 * person's again; `ttl` is the service's own per-item lifetime, positive
 * only on what an erase of an active account leaves behind.
 */
type AccountDocument = Account &
	CosmosDocument & {
		erasedAt?: number | null;
		admittedAt?: number | null;
		/** When an erase of this row began or was last taken up (seconds, this side's clock), while it has not finished. */
		erasing?: number | null;
		/** Who holds that erase; null once its sweep failed and it let go. */
		erasingBy?: string | null;
		ttl?: number;
	};

/**
 * What a row is, read off its own fields:
 *
 * - `person`: an account somebody stands behind.
 * - `deactivated`: a person's, shut.
 * - `tombstone`: what the erase of a deactivated account leaves — the id
 *   and the deactivation, nothing of the person, for good. It is nobody's
 *   record: no edit lands on it, and no session is admitted on it.
 * - `marker`: what the erase of an active account leaves — the id and when,
 *   with a lifetime after which the service removes it. A sign-in makes a
 *   new account of it.
 * - `erasing`: a row an erase has emptied and shut and not yet finished:
 *   what the agent holds under the id is being swept. It admits no session
 *   and no sign-in and takes no edit, so nothing can be made under the id
 *   while the sweep runs; it keeps its deactivation, if it had one, and has
 *   no lifetime, so it cannot lapse into no row with the sweep undone.
 *
 * A deactivated row is never a marker, whatever else it carries: a
 * deactivation is never given a lifetime to lapse with.
 */
type RowKind = "person" | "deactivated" | "tombstone" | "marker" | "erasing";

function kindOf(d: AccountDocument): RowKind {
	if (typeof d.erasing === "number") return "erasing";
	if (d.disabled === true)
		return d.createdAt == null ? "tombstone" : "deactivated";
	return typeof d.ttl === "number" &&
		d.ttl > 0 &&
		typeof d.erasedAt === "number"
		? "marker"
		: "person";
}

const nowSeconds = () => Math.floor(Date.now() / 1000);

/** The erase a row still carries, or null: never, or longer ago than it is kept. */
const liveErase = (d: AccountDocument): number | null =>
	typeof d.erasedAt === "number" &&
	nowSeconds() - d.erasedAt <= ERASE_KEPT_SECONDS
		? d.erasedAt
		: null;

const accounts = () => cosmosDatabase().container(ACCOUNTS.name);

/** The stored document as the record, without the service's own fields. */
function toAccount(d: Stored<AccountDocument>): Account {
	return {
		id: d.id,
		email: d.email ?? null,
		name: d.name ?? null,
		about: d.about ?? null,
		preferences: d.preferences ?? null,
		roles: stringList(d.roles),
		groups: stringList(d.groups),
		disabled: d.disabled === true,
		voiceTuning:
			d.voiceTuning && typeof d.voiceTuning === "object"
				? { ...d.voiceTuning }
				: null,
		createdAt: d.createdAt ?? null,
		lastLoginAt: d.lastLoginAt ?? null,
	};
}

const set = (path: string, value: unknown): PatchSet => ({
	op: "set",
	path,
	value,
});

/** The name is filled only while the record holds none. */
const UNNAMED = "FROM c WHERE NOT IS_DEFINED(c.name) OR IS_NULL(c.name)";

/**
 * Holds only for a record a person stands behind, deactivated or not: an
 * edit never lands on what an erase left, with a lifetime (a marker) or
 * with a deactivation and no date of creation (a tombstone), nor on a row
 * an erase has begun on.
 */
const A_PERSON =
	"FROM c WHERE (NOT IS_DEFINED(c.ttl) OR c.ttl < 0) AND (NOT IS_DEFINED(c.erasing) OR IS_NULL(c.erasing)) AND ((NOT IS_DEFINED(c.disabled) OR c.disabled != true) OR (IS_DEFINED(c.createdAt) AND NOT IS_NULL(c.createdAt)))";

/** A row read and written under a condition changed in between: the write is decided again on what is there now. */
const TRIES = 5;

/** The document a conditional write left, or null when its condition no longer held or the row was gone. */
async function written<T>(write: () => Promise<T | null>): Promise<T | null> {
	try {
		return await write();
	} catch (err) {
		if (hasStatus(err, 412)) return null;
		throw err;
	}
}

/**
 * A write decided on the row as it is read, and decided again whenever the
 * row had changed by the time it was written: `decide` answers null to be
 * asked again. False for an id with no row.
 */
async function onRow(
	id: string,
	doing: string,
	decide: (
		found: Stored<AccountDocument>,
		kind: RowKind,
	) => Promise<{ answer: boolean } | null>,
): Promise<boolean> {
	for (let attempt = 0; attempt < TRIES; attempt++) {
		const found = await accounts().read<AccountDocument>(id, id);
		if (!found) return false;
		const decided = await decide(found, kindOf(found));
		if (decided) return decided.answer;
	}
	throw new Error(`the account's record kept changing under the ${doing}`);
}

/** All of a batch or none of it: false when a condition no longer held or the row was gone. */
async function batched(write: () => Promise<void>): Promise<boolean> {
	try {
		await write();
		return true;
	} catch (err) {
		if (hasStatus(err, 412) || hasStatus(err, 404)) return false;
		throw err;
	}
}

/**
 * Insert on the first sign-in, refresh the snapshot on every later one. A
 * null email never blanks what was recorded; the name is filled only while
 * the record has none, so the person's own choice outlives the provider's.
 * Two sign-ins at once both try the insert, and the one refused with 409
 * refreshes what the other inserted.
 *
 * A sign-in on what an erase left makes a new account of it, and stamps
 * when (`admittedAt`): the erase stays on the row for as long as it is
 * kept, so a session from before it is still refused, and the stamp is what
 * tells this sign-in's session from those. Every write names the document
 * it read (its etag), the name's the document the refresh left: so a
 * refresh or a name never lands on what an erase made of the row in
 * between, and a new account is never made over a row somebody has
 * deactivated since. A tombstone takes nothing: there is no person on it to
 * refresh. A row an erase has begun on takes nothing either, and says so
 * (`EraseUnderWayError`): a new account made of it would be swept with the
 * old one.
 */
export async function upsertAccount(input: {
	id: string;
	email?: string | null;
	name?: string | null;
	roles?: readonly string[];
	groups?: readonly string[];
}): Promise<void> {
	const email = input.email ?? null;
	const name = cleanName(input.name);
	const roles = [...(input.roles ?? [])];
	const groups = [...(input.groups ?? [])];
	for (let attempt = 0; attempt < TRIES; attempt++) {
		const now = new Date().toISOString();
		try {
			await accounts().create<AccountDocument>({
				id: input.id,
				email,
				name,
				about: null,
				preferences: null,
				roles,
				groups,
				disabled: false,
				voiceTuning: null,
				createdAt: now,
				lastLoginAt: now,
			});
			return;
		} catch (err) {
			if (!hasStatus(err, 409)) throw err;
		}
		const found = await accounts().read<AccountDocument>(input.id, input.id);
		if (!found) continue;
		const kind = kindOf(found);
		if (kind === "tombstone") return;
		if (kind === "erasing") throw new EraseUnderWayError();
		// An erase no caller can predate any longer is no longer kept.
		const erasePassed =
			typeof found.erasedAt === "number" && liveErase(found) === null;
		if (kind === "marker") {
			const remade = await written(() =>
				accounts().patch<AccountDocument>(
					input.id,
					input.id,
					[
						set("/email", email),
						set("/name", name),
						set("/roles", roles),
						set("/groups", groups),
						set("/createdAt", now),
						set("/lastLoginAt", now),
						set("/admittedAt", erasePassed ? null : nowSeconds()),
						...(erasePassed ? [set("/erasedAt", null)] : []),
						// The service's own value for a document that does not expire.
						set("/ttl", -1),
					],
					{ ifMatch: found._etag },
				),
			);
			if (remade) return;
			continue;
		}
		const refreshed = await written(() =>
			accounts().patch<AccountDocument>(
				input.id,
				input.id,
				[
					set("/roles", roles),
					set("/groups", groups),
					set("/lastLoginAt", now),
					...(email ? [set("/email", email)] : []),
					...(erasePassed
						? [set("/erasedAt", null), set("/admittedAt", null)]
						: []),
				],
				{ ifMatch: found._etag },
			),
		);
		if (!refreshed) continue;
		if (name)
			await written(() =>
				accounts().patch<AccountDocument>(
					input.id,
					input.id,
					[set("/name", name)],
					{ ifMatch: refreshed._etag, condition: UNNAMED },
				),
			);
		return;
	}
	throw new Error("the account's record kept changing under the sign-in");
}

/** What an erased, active account leaves behind is no account: nothing of a person is on it. A tombstone reads as the deactivated record it is, emptied. */
export async function getAccount(id: string): Promise<Account | null> {
	return (await readAccountRecord(id)).account;
}

/**
 * The erase an id still carries: when, and when the first sign-in after it
 * was recorded — null while there has been none.
 */
export interface KeptErase {
	at: number;
	admittedAt: number | null;
}

export interface AccountRecord {
	/** The record; null for an id with none, or with only a marker. */
	account: Account | null;
	/** Null for an id never erased, or erased longer ago than an erase is kept (`ERASE_KEPT_SECONDS`), whether or not the row still says when. */
	erase: KeptErase | null;
	/** What an erase left or is leaving, when the row is only that: nobody's record, admitting no session. */
	remains: "marker" | "tombstone" | "erasing" | null;
}

function recordOf(found: Stored<AccountDocument> | null): AccountRecord {
	if (!found) return { account: null, erase: null, remains: null };
	const kind = kindOf(found);
	if (kind === "erasing")
		return { account: null, erase: null, remains: "erasing" };
	const at = liveErase(found);
	if (kind === "marker")
		// One the service has not removed past its bound is nothing to anyone.
		return at === null
			? { account: null, erase: null, remains: null }
			: {
					account: null,
					erase: { at, admittedAt: null },
					remains: "marker",
				};
	if (kind === "tombstone")
		return { account: toAccount(found), erase: null, remains: "tombstone" };
	return {
		account: toAccount(found),
		erase:
			at === null
				? null
				: {
						at,
						// A row with no stamp admits nothing older than the erase itself.
						admittedAt:
							typeof found.admittedAt === "number"
								? found.admittedAt
								: at + CLOCK_SKEW_SECONDS + 1,
					},
		remains: null,
	};
}

/** The account, the erase its id still carries and whether the row is only what an erase left, in one point read. */
export async function readAccountRecord(id: string): Promise<AccountRecord> {
	return recordOf(await accounts().read<AccountDocument>(id, id));
}

/**
 * Whether a session is the record's own: one that began at or after the
 * sign-in that followed the last erase, allowing for the two clocks. What
 * an erase left is nobody's, and an id never erased is anybody's who names
 * it.
 */
export function ownedBy(
	record: Pick<AccountRecord, "erase" | "remains">,
	session: { signedInAt?: number },
): boolean {
	if (record.remains) return false;
	if (!record.erase) return true;
	return (
		record.erase.admittedAt !== null &&
		session.signedInAt !== undefined &&
		session.signedInAt >= record.erase.admittedAt - CLOCK_SKEW_SECONDS
	);
}

/**
 * The account a request was admitted on, as its gate read it: what a write
 * the request makes later must still find. Null when the gate found no
 * account. The account is told by when it was made (`createdAt`): no
 * write a person's own requests make changes it, and every way an account
 * stops being the one a request was admitted on does — an erase empties
 * it, a sign-in after an erase sets it again, a tombstone has none.
 * Comparing the document's etag instead would refuse a request whenever
 * the same person's sign-in on another device refreshed the row meanwhile.
 */
export type AdmittedAccount = Pick<Account, "createdAt"> | null;

/** Only the shape `toISOString` writes, so the value can stand in a predicate's text. */
const MADE_AT = /^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9:.]+Z$/;

/**
 * The condition a person's record must meet for a write: a person's, and,
 * when a request names the account it was admitted on, still that account.
 * Null when the write has nothing it could land on.
 */
function personCondition(admitted?: AdmittedAccount): string | null {
	if (admitted === undefined) return A_PERSON;
	const made = admitted?.createdAt;
	if (!made || !MADE_AT.test(made)) return null;
	return `${A_PERSON} AND c.createdAt = '${made}'`;
}

/**
 * A patch of a person's record: null for an id with none, with only what an
 * erase left, or — with `admitted` named — with an account that is no longer
 * the one the request was admitted on.
 */
async function patchPerson(
	id: string,
	operations: PatchSet[],
	admitted?: AdmittedAccount,
): Promise<Account | null> {
	const condition = personCondition(admitted);
	if (condition === null) return null;
	const updated = await written(() =>
		accounts().patch<AccountDocument>(id, id, operations, { condition }),
	);
	return updated ? toAccount(updated) : null;
}

function cleanName(name: string | null | undefined): string | null {
	return name?.trim().slice(0, PERSON_NAME_MAX) || null;
}

function cleanText(text: string | null | undefined): string | null {
	return text?.trim().slice(0, PERSON_TEXT_MAX) || null;
}

/**
 * The person's own fields, each trimmed and bounded; a blank text clears its
 * field, a blank name leaves the one there. Null for an id with no record,
 * or with only what an erase left: an edit never invents a principal, and
 * never writes a person back onto a row emptied of one.
 *
 * A request names the account its gate admitted it on (`admitted`), and
 * the edit lands only while the row is still that account: a request
 * admitted before an erase, whose body arrives after the erase and after
 * the sign-in that made a new account of the id, writes nothing to the new
 * account and is answered null. With nothing named — an operator's tool, a
 * test — any person's record under the id is written.
 */
export async function updatePerson(
	id: string,
	patch: PersonPatch,
	admitted?: AdmittedAccount,
): Promise<Account | null> {
	const name = patch.name === undefined ? null : cleanName(patch.name);
	const operations = [
		...(name ? [set("/name", name)] : []),
		...(patch.about !== undefined
			? [set("/about", cleanText(patch.about))]
			: []),
		...(patch.preferences !== undefined
			? [set("/preferences", cleanText(patch.preferences))]
			: []),
	];
	if (operations.length === 0) {
		const { account, remains } = await readAccountRecord(id);
		if (remains || !account) return null;
		return admitted === undefined || account.createdAt === admitted?.createdAt
			? account
			: null;
	}
	return patchPerson(id, operations, admitted);
}

/**
 * A voice tester's tuning, saved over what was there, or cleared with null.
 * The caller has checked it; false for an id with no record, or — with
 * `admitted` named, as `updatePerson` takes it — with an account that is no
 * longer the one the request was admitted on.
 */
export async function setVoiceTuning(
	id: string,
	tuning: Record<string, unknown> | null,
	admitted?: AdmittedAccount,
): Promise<boolean> {
	return (
		(await patchPerson(id, [set("/voiceTuning", tuning)], admitted)) !== null
	);
}

/**
 * An account with no record is not deactivated: first sign-ins must keep
 * working. Read off the row itself, so a deactivation holds through an erase
 * that has begun and not finished.
 */
export async function isAccountDisabled(id: string): Promise<boolean> {
	return (await accounts().read<AccountDocument>(id, id))?.disabled === true;
}

/**
 * Deactivate, or bring back. Reaches the next sign-in and every call that
 * re-reads standing at the point of use; the session itself is a stateless
 * token and is not revoked. A no-op against an id with no record, reported
 * as such, because deactivating would otherwise invent a principal.
 *
 * What an erase left can be shut too: a marker deactivated becomes a
 * tombstone, with no lifetime, so the id's next sign-in is refused rather
 * than made a new account. Bringing a tombstone back makes an empty record
 * of it, created then, which still carries when it was erased: no session
 * from before that erase is admitted on it.
 */
export async function setAccountDisabled(
	id: string,
	disabled: boolean,
): Promise<boolean> {
	return onRow(id, "deactivation", async (found, kind) => {
		if (kind === "marker" && !disabled) return { answer: false };
		if (kind === "tombstone" && disabled && (found.ttl ?? -1) < 0)
			return { answer: true };
		const operations =
			kind === "marker" || (kind === "tombstone" && disabled)
				? [set("/disabled", true), set("/ttl", -1)]
				: kind === "tombstone"
					? [
							set("/disabled", false),
							set("/createdAt", new Date(Date.now()).toISOString()),
						]
					: [set("/disabled", disabled)];
		const done = await written(() =>
			accounts().patch<AccountDocument>(id, id, operations, {
				ifMatch: found._etag,
			}),
		);
		return done ? { answer: true } : null;
	});
}

/** Everything of the person the row holds, emptied. Nine operations: one more fits a patch. */
const EMPTIED: PatchSet[] = [
	set("/email", null),
	set("/name", null),
	set("/about", null),
	set("/preferences", null),
	set("/roles", []),
	set("/groups", []),
	set("/voiceTuning", null),
	set("/createdAt", null),
	set("/lastLoginAt", null),
];

/** The session that asked for an erase is not the record's own: the id has been erased, and made somebody's account, since it began. */
export class ErasedSessionError extends Error {
	constructor() {
		super("the account under this id is not the session's to erase");
		this.name = "ErasedSessionError";
	}
}

/** A sign-in landed on a row an erase has begun on and not finished: asked again shortly, it finds the erase done. */
export class EraseUnderWayError extends Error {
	constructor() {
		super("the account under this id is being erased");
		this.name = "EraseUnderWayError";
	}
}

/**
 * What the first write of an erase found, and whose the erase now is:
 *
 * - `begun`: the row was a person's and is now shut — this erase's to sweep
 *   and finish, under `token`.
 * - `resumed`: an erase had shut it and then let go (its sweep failed) or
 *   stood longer than one takes (`ERASE_STALLED_SECONDS`); it is this
 *   erase's now, under a new `token`, to sweep again and finish.
 * - `busy`: another erase holds it and is sweeping. Two sweeps are never run
 *   side by side: the one that finished first would end the erase while the
 *   other still ran, under an id a sign-in could by then have made
 *   somebody's account.
 * - `finished`: only what a finished erase left; there is nothing to do.
 * - `none`: no row at all, or a marker the service did not remove past its
 *   bound; nothing to write.
 */
export type EraseStart =
	| { phase: "begun" | "resumed"; token: string }
	| { phase: "busy" | "finished" | "none" };

/** Whether an erase a row carries is still somebody's: held, and for no longer than one takes. */
const heldErase = (d: AccountDocument): boolean =>
	typeof d.erasingBy === "string" &&
	typeof d.erasing === "number" &&
	nowSeconds() - d.erasing <= ERASE_STALLED_SECONDS;

/**
 * The first write of an erase: the row emptied of the person and shut
 * (`erasing`), in one batch that names the document that was read (its
 * etag). From that write no session is admitted on the id, no sign-in makes
 * an account of it and no edit lands on it, so what the agent holds can be
 * swept with nothing made under the id meanwhile. The row is emptied and
 * never deleted, because with no row a subject reads as a first sign-in;
 * and it is given no lifetime until it is finished, because a row that
 * lapsed with the sweep undone would hand the next sign-in what was not
 * erased.
 *
 * The erase is one caller's at a time: the write stamps who holds it
 * (`token`), and `finishErase` and `releaseErase` act only for that holder.
 *
 * Whatever lands on the row between the read and the write — a
 * deactivation, a re-activation, another erase and the sign-in after it —
 * the erase is decided again on what is there. With `session` named, a
 * person's record that is not that session's own (`ownedBy`) is left
 * untouched and `ErasedSessionError` is thrown: the account a sign-in made
 * after an erase is never erased by a session from before it. A write that
 * fails leaves the account as it was, to be erased again.
 */
export async function beginErase(
	id: string,
	session?: { signedInAt?: number },
): Promise<EraseStart> {
	const token = crypto.randomUUID();
	for (let attempt = 0; attempt < TRIES; attempt++) {
		const found = await accounts().read<AccountDocument>(id, id);
		if (!found) return { phase: "none" };
		const kind = kindOf(found);
		if (kind === "erasing") {
			if (heldErase(found)) return { phase: "busy" };
			const taken = await written(() =>
				accounts().patch<AccountDocument>(
					id,
					id,
					[set("/erasing", nowSeconds()), set("/erasingBy", token)],
					{ ifMatch: found._etag },
				),
			);
			if (taken) return { phase: "resumed", token };
			continue;
		}
		if (kind === "marker")
			return { phase: liveErase(found) === null ? "none" : "finished" };
		if (kind === "tombstone") {
			// A deactivation carries no lifetime, however the row came by one.
			if ((found.ttl ?? -1) < 0) return { phase: "finished" };
			const kept = await written(() =>
				accounts().patch<AccountDocument>(id, id, [set("/ttl", -1)], {
					ifMatch: found._etag,
				}),
			);
			if (kept) return { phase: "finished" };
			continue;
		}
		if (session && !ownedBy(recordOf(found), session))
			throw new ErasedSessionError();
		const shut = await batched(() =>
			accounts().batch(id, [
				{ type: "patch", id, operations: EMPTIED, ifMatch: found._etag },
				{
					type: "patch",
					id,
					operations: [
						set("/erasing", nowSeconds()),
						set("/erasingBy", token),
						set("/admittedAt", null),
						set("/ttl", -1),
					],
				},
			]),
		);
		if (shut) return { phase: "begun", token };
	}
	throw new Error("the account's record kept changing under the erase");
}

/**
 * The last write of an erase, once what the agent holds has been swept: the
 * shut row becomes what the erase leaves. A deactivated account's becomes a
 * tombstone: the deactivation, for good — deleting it would hand a
 * deactivated person their access back — and when it was erased, so that if
 * it is ever brought back no session from before is admitted. An active
 * account's becomes a marker: when it was erased, for as long as an erase
 * is kept and no longer — a session open on another device when the erase
 * ran would otherwise go on under the erased id.
 *
 * The write names the document it read, so a deactivation that landed while
 * the sweep ran is never given a lifetime and lost. False when the erase is
 * no longer this holder's (`token`): it stood too long and another took it,
 * and whether the id is swept is that one's to say.
 */
export async function finishErase(id: string, token: string): Promise<boolean> {
	return onRow(id, "erase", async (found, kind) => {
		if (kind !== "erasing" || found.erasingBy !== token)
			return { answer: false };
		const finished = await written(() =>
			accounts().patch<AccountDocument>(
				id,
				id,
				[
					set("/erasedAt", nowSeconds()),
					set("/admittedAt", null),
					set("/erasing", null),
					set("/erasingBy", null),
					set("/ttl", found.disabled === true ? -1 : ERASE_KEPT_SECONDS),
				],
				{ ifMatch: found._etag },
			),
		);
		return finished ? { answer: true } : null;
	});
}

/**
 * Let go of an erase whose sweep failed: the row stays shut, and whoever
 * asks next — the person again, or their next sign-in — takes it up at
 * once rather than after it has stood too long. Never throws: an erase not
 * let go is taken up once it has.
 */
export async function releaseErase(id: string, token: string): Promise<void> {
	try {
		await onRow(id, "erase", async (found, kind) => {
			if (kind !== "erasing" || found.erasingBy !== token)
				return { answer: false };
			const released = await written(() =>
				accounts().patch<AccountDocument>(id, id, [set("/erasingBy", null)], {
					ifMatch: found._etag,
				}),
			);
			return released ? { answer: true } : null;
		});
	} catch (err) {
		console.error("[identity] an erase that failed was not let go:", err);
	}
}

/**
 * The erase renewed by the request that holds it: the time it stands from
 * moved to now, only while `token` still holds it. False once it does not
 * — another took it over, or it was finished or let go.
 */
export async function renewErase(id: string, token: string): Promise<boolean> {
	return (
		(await written(() =>
			accounts().patch<AccountDocument>(
				id,
				id,
				[set("/erasing", nowSeconds())],
				{
					condition: `FROM c WHERE c.erasingBy = '${token.replace(/[^0-9a-f-]/gi, "")}'`,
				},
			),
		)) !== null
	);
}

/** Whether `token` still holds the erase of an id. */
async function eraseHeld(id: string, token: string): Promise<boolean> {
	const found = await accounts().read<AccountDocument>(id, id);
	return (
		found !== null &&
		typeof found.erasing === "number" &&
		found.erasingBy === token
	);
}

/**
 * A sweep run under the erase `token` holds: renewed every
 * `ERASE_RENEW_SECONDS` while it runs, so it is never taken for abandoned,
 * and handed `stillHeld`, which the sweep asks before each step and which
 * answers false once the erase is no longer this holder's. A process that
 * stops renewing — frozen, or gone — loses the erase after
 * `ERASE_STALLED_SECONDS`, and if it then wakes, its next step finds that
 * out and goes no further: a sweep never runs under an id a sign-in has
 * made somebody's account since. The step it was in when it froze is the
 * one it may still finish.
 */
export async function underLease<T>(
	id: string,
	token: string,
	sweep: (stillHeld: () => Promise<boolean>) => Promise<T>,
	renewEveryMs = ERASE_RENEW_SECONDS * 1000,
): Promise<T> {
	let lost = false;
	// The renewal in flight, if any: the lease is not let go of until it has
	// landed, so none renews the erase after the sweep that held it returned.
	let renewing: Promise<void> = Promise.resolve();
	const renew = setInterval(() => {
		renewing = renewErase(id, token).then(
			(renewed) => {
				if (!renewed) lost = true;
			},
			// A renewal the store did not answer is tried again; the steps ask the row itself.
			(err) => console.warn("[identity] an erase could not be renewed:", err),
		);
	}, renewEveryMs);
	renew.unref?.();
	const stillHeld = async () => {
		if (lost) return false;
		lost = !(await eraseHeld(id, token));
		return !lost;
	};
	try {
		return await sweep(stillHeld);
	} finally {
		clearInterval(renew);
		await renewing;
	}
}

/** Whether an id's row is one an erase has shut and not finished. */
export async function eraseUnderWay(id: string): Promise<boolean> {
	const found = await accounts().read<AccountDocument>(id, id);
	return found !== null && kindOf(found) === "erasing";
}

/**
 * The row's two writes, one after the other: the whole erase where nothing
 * else is held under the id. The agent's memory and anything in object
 * storage are not reached from here, so where they exist the sweep goes
 * between the two (`beginErase`, the sweep, `finishErase`).
 *
 * True when there was a record to erase; what an erase already left is left
 * as it is, so no session can renew what refuses it, and an erase somebody
 * else is sweeping is theirs to finish.
 */
export async function deleteAccount(
	id: string,
	session?: { signedInAt?: number },
): Promise<boolean> {
	const start = await beginErase(id, session);
	if (start.phase !== "begun" && start.phase !== "resumed") return false;
	return finishErase(id, start.token);
}
