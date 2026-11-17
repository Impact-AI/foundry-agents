import {
	type AccessSettings,
	AccessSettingsUnreadError,
	accessSettings,
} from "../config/access";
import { FIELD } from "../index/definition";
import { anyOf, group, hasValue } from "../index/odata";
import { type DocumentAccess, GLOBAL_ACCESS_GROUP } from "../types";

/**
 * The readers clause: who is asking, as a `$filter` every search carries
 * while access control is enforced. Built from the caller's verified claims
 * — the object id and the group ids the identity provider put on the token
 * — and never from anything a request body said. It is not part of the
 * query's spec on purpose: the relaxation ladder drops a spec's constraints
 * one by one to find rows, and this is the one constraint no empty result
 * may loosen.
 */

/** Who is asking, as the identity provider knows them. */
export interface CallerAccess {
	oid: string;
	groups: readonly string[];
}

/** Why a search returned nothing without being run. */
export type RetrievalRefusal =
	/** Enforcement is on and nobody is asking. */
	| "unidentified_caller"
	/** The `access` document has never been read, so whether enforcement is on is not known. */
	| "access_unreadable";

export type AccessClause =
	/** Enforcement is off: no clause. */
	| { kind: "open" }
	| { kind: "filter"; filter: string }
	/** Nothing may be read: nobody is asking under enforcement, or the settings are unread. */
	| { kind: "refused"; code: RetrievalRefusal };

/**
 * `oids/any(t: t eq '<oid>') or groups/any(t: search.in(t, '<g1>|<g2>|all', '|'))`,
 * every literal quoted by `odata.ts`. The group `all` is in the list only
 * while global document access is on, so switching it off hides every
 * document written as global at once rather than from the next ingest.
 */
export function accessFilter(
	access: CallerAccess,
	settings: Pick<AccessSettings, "globalDocumentAccess">,
): string {
	const groups = new Set(access.groups.filter((g) => g.length > 0));
	if (settings.globalDocumentAccess) groups.add(GLOBAL_ACCESS_GROUP);
	const byGroup = groups.size ? ` or ${anyOf("groups", [...groups])}` : "";
	return group(`${hasValue("oids", access.oid)}${byGroup}`);
}

/**
 * The same rule decided for one row in hand rather than sent to the index:
 * whether a document's declared readers admit the caller. For a read by id,
 * which no search filter ever sees.
 */
export function readerAdmits(
	readers: DocumentAccess,
	access: CallerAccess | null | undefined,
	settings: AccessSettings,
): boolean {
	if (!settings.enforceAccessControl) return true;
	if (!access?.oid) return false;
	if (readers.oids.includes(access.oid)) return true;
	const groups = new Set(access.groups);
	if (settings.globalDocumentAccess) groups.add(GLOBAL_ACCESS_GROUP);
	return readers.groups.some((g) => groups.has(g));
}

/**
 * The chunks Prompt Shields has read and found clean. A chunk it has not
 * read yet has no `injection` at all, and `null` is not `false`, so a chunk
 * the indexer has only just cut is never handed to a model.
 */
export const SHIELDED_CLEAN = `${FIELD.injection} eq false`;

/**
 * The chunks of a file a load described. The indexer reads every blob in
 * the container, and one nobody described — uploaded by hand, or under a
 * prefix no load has run for — is projected with no id, no library and no
 * readers; it belongs to no document, so it is never served.
 */
const DESCRIBED = `${FIELD.documentId} ne null`;

/** What every read of the index for a person or a model starts from. */
const SERVABLE = `${SHIELDED_CLEAN} and ${DESCRIBED}`;

/**
 * What every search, and every tag count a planner is shown, carries: clean
 * chunks of described files only, and under enforcement the caller's readers
 * clause beside it.
 */
export function servedFilter(
	clause: Exclude<AccessClause, { kind: "refused" }>,
): string {
	return clause.kind === "filter"
		? `${SERVABLE} and ${clause.filter}`
		: SERVABLE;
}

export async function accessClauseFor(
	access: CallerAccess | null | undefined,
): Promise<AccessClause> {
	const settings = await readableSettings();
	if (!settings) return refuseUnreadable();
	if (!settings.enforceAccessControl) return { kind: "open" };
	if (!access?.oid) return refuseUnidentified();
	return { kind: "filter", filter: accessFilter(access, settings) };
}

/** The settings, or null while they have never been read; any other failure is the caller's. */
export async function readableSettings(): Promise<AccessSettings | null> {
	try {
		return await accessSettings();
	} catch (err) {
		if (err instanceof AccessSettingsUnreadError) return null;
		throw err;
	}
}

function refuseUnreadable(): AccessClause & { kind: "refused" } {
	console.error(
		"[knowledge] search refused: the access document has not been read, so whether access control is enforced is not known",
	);
	return { kind: "refused", code: "access_unreadable" };
}

/** The refusal, said once on stderr where it happens; the caller carries the code onward. */
function refuseUnidentified(): AccessClause & { kind: "refused" } {
	console.error(
		"[knowledge] search refused: access control is enforced and the caller is unidentified",
	);
	return { kind: "refused", code: "unidentified_caller" };
}
