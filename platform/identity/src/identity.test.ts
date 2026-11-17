import { afterAll, beforeAll, expect, test } from "bun:test";
import { setCosmosDatabase } from "@platform/cosmos";
import {
	fakeCosmosDatabase,
	openTestCosmos,
	type TestCosmos,
} from "@platform/cosmos/testing";
import {
	beginErase,
	CLOCK_SKEW_SECONDS,
	deleteAccount,
	ERASE_KEPT_SECONDS,
	ERASE_STALLED_SECONDS,
	ErasedSessionError,
	EraseUnderWayError,
	finishErase,
	getAccount,
	identityContainers,
	isAccountDisabled,
	PERSON_NAME_MAX,
	PERSON_TEXT_MAX,
	releaseErase,
	renewErase,
	setAccountDisabled,
	setVoiceTuning,
	underLease,
	updatePerson,
	upsertAccount,
} from "./accounts";
import { CALLER_ASSERTION_TTL_SECONDS } from "./assertions";
import { LOCAL_PROVIDER_ID, localAccount } from "./claims/local";
import { SESSION_MAX_AGE_SECONDS } from "./claims/session";
import { resolveSignIn } from "./sign-in";
import { readAccountStanding, standingRefusal } from "./standing";

/** On a database of its own: in memory, or the emulator under `COSMOS_TESTS=1`. */
let cosmos: TestCosmos;

beforeAll(async () => {
	cosmos = await openTestCosmos(identityContainers);
});

afterAll(async () => {
	await cosmos.drop();
});

test("an account is inserted on the first sign-in and refreshed after, and a null never blanks a value", async () => {
	await upsertAccount({
		id: "acct-1",
		email: "a@b.test",
		name: "A",
		roles: ["premium"],
		groups: ["g-1", "g-2"],
	});
	expect((await getAccount("acct-1"))?.groups).toEqual(["g-1", "g-2"]);
	await upsertAccount({ id: "acct-1", email: null, name: null, roles: [] });
	const account = await getAccount("acct-1");
	expect(account).toMatchObject({
		id: "acct-1",
		email: "a@b.test",
		name: "A",
		roles: [],
		groups: [],
		disabled: false,
	});
	expect(account?.lastLoginAt).not.toBeNull();
});

test("deactivation reaches standing, read with the row that says what the account gets; an unknown account is active; a missing row cannot be deactivated", async () => {
	expect(await readAccountStanding("acct-1")).toMatchObject({
		standing: "active",
		account: { id: "acct-1", roles: [], groups: [] },
	});
	expect(await setAccountDisabled("acct-1", true)).toBe(true);
	expect(await isAccountDisabled("acct-1")).toBe(true);
	const deactivated = await readAccountStanding("acct-1");
	expect(deactivated.standing).toBe("deactivated");
	expect(standingRefusal(deactivated.standing)).toEqual({
		status: 403,
		code: "account_deactivated",
	});
	expect(await setAccountDisabled("acct-1", false)).toBe(true);
	expect(await readAccountStanding("never-signed-in")).toEqual({
		standing: "active",
		account: null,
	});
	expect(await setAccountDisabled("never-signed-in", true)).toBe(false);
	const nobody = await readAccountStanding("");
	expect(standingRefusal(nobody.standing)).toEqual({
		status: 503,
		code: "account_unavailable",
	});
});

test("the person's fields are the account's: edited, trimmed, bounded, cleared, and kept across a sign-in", async () => {
	expect(
		await updatePerson("acct-1", {
			name: "  Ada Quill  ",
			about: " I collect maps. ",
			preferences: "Answer briefly.",
		}),
	).toMatchObject({
		name: "Ada Quill",
		about: "I collect maps.",
		preferences: "Answer briefly.",
	});
	expect(
		await updatePerson("acct-1", { about: "x".repeat(PERSON_TEXT_MAX + 5) }),
	).toMatchObject({
		about: "x".repeat(PERSON_TEXT_MAX),
		preferences: "Answer briefly.",
	});
	expect(
		await updatePerson("acct-1", {
			name: "   ",
			about: null,
			preferences: "",
		}),
	).toMatchObject({ name: "Ada Quill", about: null, preferences: null });
	expect(
		(await updatePerson("acct-1", { name: "n".repeat(PERSON_NAME_MAX + 1) }))
			?.name,
	).toHaveLength(PERSON_NAME_MAX);
	await updatePerson("acct-1", { name: "Ada" });
	await upsertAccount({ id: "acct-1", name: "Provider Name", roles: [] });
	expect((await getAccount("acct-1"))?.name).toBe("Ada");
	expect(await updatePerson("someone-else", { name: "Hijacked" })).toBeNull();
	expect(await getAccount("someone-else")).toBeNull();
});

/** The two variables the gate reads, set for one test and put back after. */
async function withEnv(
	values: { AUTH_MODE?: string; AUTH_REQUIRE_ROLE?: string },
	run: () => Promise<void>,
): Promise<void> {
	const before = {
		AUTH_MODE: process.env.AUTH_MODE,
		AUTH_REQUIRE_ROLE: process.env.AUTH_REQUIRE_ROLE,
	};
	for (const name of ["AUTH_MODE", "AUTH_REQUIRE_ROLE"] as const) {
		const value = values[name];
		if (value === undefined) delete process.env[name];
		else process.env[name] = value;
	}
	try {
		await run();
	} finally {
		for (const name of ["AUTH_MODE", "AUTH_REQUIRE_ROLE"] as const) {
			const value = before[name];
			if (value === undefined) delete process.env[name];
			else process.env[name] = value;
		}
	}
}

test("a sign-in is gated by role, records the roles and groups, and is refused for a deactivated account", async () => {
	const claims = {
		oid: "acct-signin",
		email: "s@x.test",
		name: "S",
		roles: ["premium"],
		groups: ["g-1", "g-2"],
	};
	await withEnv({}, async () => {
		expect(await resolveSignIn({ claims })).toEqual({
			ok: true,
			accountId: "acct-signin",
			access: { tier: "premium" },
		});
		expect(await getAccount("acct-signin")).toMatchObject({
			roles: ["premium"],
			groups: ["g-1", "g-2"],
		});
		await setAccountDisabled("acct-signin", true);
		expect(await resolveSignIn({ claims })).toEqual({
			ok: false,
			reason: "deactivated",
		});
		await setAccountDisabled("acct-signin", false);
		expect(await resolveSignIn({})).toEqual({
			ok: false,
			reason: "no_account",
		});
	});
	await withEnv({ AUTH_REQUIRE_ROLE: "true" }, async () => {
		expect(await resolveSignIn({ claims: { ...claims, roles: [] } })).toEqual({
			ok: false,
			reason: "not_allowed",
		});
		expect(
			await resolveSignIn({ claims: { ...claims, roles: ["user"] } }),
		).toMatchObject({ ok: true, access: { tier: "base" } });
	});
});

test("in local mode every sign-in is a new member on the base tier, whatever the name; outside it a local sign-in is refused", async () => {
	/** What the door's provider hands Auth.js for a typed name. */
	const local = (name: string) => ({
		account: { provider: LOCAL_PROVIDER_ID },
		user: localAccount(name),
	});
	await withEnv({}, async () => {
		expect(await resolveSignIn(local("Ada"))).toEqual({
			ok: false,
			reason: "not_allowed",
		});
	});
	await withEnv({ AUTH_MODE: "local", AUTH_REQUIRE_ROLE: "true" }, async () => {
		const first = local("Ada");
		const signedIn = await resolveSignIn(first);
		expect(signedIn).toEqual({
			ok: true,
			accountId: first.user?.id ?? "",
			access: { tier: "base" },
		});
		expect(await getAccount(first.user?.id ?? "")).toMatchObject({
			name: "Ada",
			roles: ["user"],
			groups: [],
		});
		// The same name typed again is somebody else, with nothing of the first.
		const again = local("Ada");
		expect(await resolveSignIn(again)).toMatchObject({
			ok: true,
			accountId: again.user?.id,
		});
		expect(again.user?.id).not.toBe(first.user?.id);
		expect(await resolveSignIn(local("admin"))).toMatchObject({
			ok: true,
			access: { tier: "base" },
		});
	});
});

test("deleting the account takes the person's words with it", async () => {
	await upsertAccount({ id: "acct-gone", name: "Gone" });
	await updatePerson("acct-gone", { about: "Here for a while." });
	expect(await deleteAccount("acct-gone")).toBe(true);
	expect(await getAccount("acct-gone")).toBeNull();
	expect(await deleteAccount("acct-gone")).toBe(false);
});

test("what an erase leaves is the id and when, never an account: no edit lands on it, and no session is admitted on it", async () => {
	const id = "acct-erased";
	await upsertAccount({ id, email: "e@b.test", name: "Erased" });
	const before = Math.floor(Date.now() / 1000) - 5;
	expect(await deleteAccount(id)).toBe(true);
	const left = await cosmos.database.container("accounts").read(id, id);
	expect(left).toMatchObject({
		id,
		email: null,
		name: null,
		about: null,
		roles: [],
		groups: [],
		createdAt: null,
		lastLoginAt: null,
		admittedAt: null,
		ttl: ERASE_KEPT_SECONDS,
	});
	expect(left?.erasedAt).toBeGreaterThanOrEqual(before);
	// Nothing reads or writes it as a person.
	expect(await getAccount(id)).toBeNull();
	expect(await updatePerson(id, { about: "Written after." })).toBeNull();
	expect(await setVoiceTuning(id, { engine: "cascade" })).toBe(false);
	expect(await setAccountDisabled(id, false)).toBe(false);
	// One from before the erase, one that names no sign-in time, one stamped after it: none is admitted on the marker alone.
	for (const session of [
		{ signedInAt: before },
		{},
		{ signedInAt: before + 3600 },
	]) {
		const reading = await readAccountStanding(id, session);
		expect(reading).toEqual({
			standing: "erased",
			account: null,
			remade: false,
		});
		expect(standingRefusal(reading.standing)).toEqual({
			status: 401,
			code: "account_erased",
		});
	}
});

test("a sign-in after an erase is a new account, and the session it opens is admitted where an older one stays refused", async () => {
	const id = "acct-reborn";
	await upsertAccount({ id, name: "First", roles: ["premium"] });
	await updatePerson(id, { about: "The first person's." });
	const old = Math.floor(Date.now() / 1000) - 5 * 60;
	expect(await deleteAccount(id)).toBe(true);
	expect(await resolveSignIn({ claims: { oid: id, name: "Second" } })).toEqual({
		ok: true,
		accountId: id,
		access: { tier: "base" },
	});
	expect(await getAccount(id)).toMatchObject({
		id,
		name: "Second",
		about: null,
		roles: [],
		disabled: false,
	});
	const now = Math.floor(Date.now() / 1000);
	expect((await readAccountStanding(id, { signedInAt: now })).standing).toBe(
		"active",
	);
	// The old session, and one that says nothing of when it began, are the erased person's: somebody else's record is under the id now.
	for (const session of [{ signedInAt: old }, {}])
		expect(await readAccountStanding(id, session)).toEqual({
			standing: "erased",
			account: null,
			remade: true,
		});
	// A later sign-in on the new account moves nothing: the old session stays refused.
	await upsertAccount({ id, name: "Second" });
	expect((await readAccountStanding(id, { signedInAt: old })).standing).toBe(
		"erased",
	);
	// The new account is nobody's to erase from the old session's side: a later erase is its own.
	expect(await deleteAccount(id)).toBe(true);
	expect(
		await cosmos.database.container("accounts").read(id, id),
	).toMatchObject({ admittedAt: null, ttl: ERASE_KEPT_SECONDS });
});

/** The database, with one thing done just before the accounts container's first write of a kind. */
function interposed(
	database: TestCosmos["database"],
	kind: "patch" | "batch",
	first: () => Promise<void>,
	/** How many writes of the kind go through untouched before the one interposed on. */
	after = 0,
): TestCosmos["database"] {
	let done = false;
	let seen = 0;
	return {
		...database,
		container(name) {
			const container = database.container(name);
			if (name !== "accounts") return container;
			return new Proxy(container, {
				get(target, property, receiver) {
					const member = Reflect.get(target, property, receiver);
					if (property !== kind || typeof member !== "function") return member;
					return async (...args: unknown[]) => {
						if (!done && seen++ >= after) {
							done = true;
							await first();
						}
						return member.apply(target, args);
					};
				},
			});
		},
	};
}

test("a deactivation that lands as an erase runs is kept: the erase leaves the deactivation, with no lifetime, and the person stays shut out", async () => {
	const id = "acct-raced";
	await upsertAccount({ id, email: "r@b.test", name: "Raced" });
	await updatePerson(id, { about: "Mine." });
	// The erase has read an active row; the operator deactivates it before the erase writes.
	setCosmosDatabase(
		interposed(cosmos.database, "batch", async () => {
			setCosmosDatabase(cosmos.database);
			expect(await setAccountDisabled(id, true)).toBe(true);
		}),
	);
	try {
		expect(await deleteAccount(id)).toBe(true);
	} finally {
		setCosmosDatabase(cosmos.database);
	}
	const left = await cosmos.database.container("accounts").read(id, id);
	expect(left).toMatchObject({ disabled: true, email: null, about: null });
	expect(left?.ttl ?? -1).toBeLessThan(0);
	expect(await isAccountDisabled(id)).toBe(true);
	// What is left is the deactivation and nothing of a person: no session is admitted on it.
	expect(await readAccountStanding(id, {})).toEqual({
		standing: "erased",
		account: null,
		remade: false,
		deactivated: true,
	});
	expect(await resolveSignIn({ claims: { oid: id } })).toEqual({
		ok: false,
		reason: "deactivated",
	});
	expect(await isAccountDisabled(id)).toBe(true);
});

test("a deactivated row is never read as what an erase left, whatever else it carries", async () => {
	const id = "acct-shut-marked";
	await cosmos.database.container("accounts").create({
		id,
		email: null,
		name: null,
		about: null,
		preferences: null,
		roles: [],
		groups: [],
		disabled: true,
		voiceTuning: null,
		createdAt: new Date().toISOString(),
		lastLoginAt: null,
		erasedAt: Math.floor(Date.now() / 1000),
		ttl: 3600,
	});
	expect((await getAccount(id))?.disabled).toBe(true);
	expect(await isAccountDisabled(id)).toBe(true);
	// Whose the record is comes before its deactivation: a session that names no time is from before the erase the row carries, one begun since is the record's own.
	expect(await readAccountStanding(id, {})).toMatchObject({
		standing: "erased",
		remade: true,
	});
	expect(
		(
			await readAccountStanding(id, {
				signedInAt: Math.floor(Date.now() / 1000) + 5,
			})
		).standing,
	).toBe("deactivated");
	expect(await resolveSignIn({ claims: { oid: id } })).toEqual({
		ok: false,
		reason: "deactivated",
	});
	// Erasing it takes the lifetime off, so the deactivation does not remove itself.
	expect(await deleteAccount(id)).toBe(true);
	const left = await cosmos.database.container("accounts").read(id, id);
	expect(left).toMatchObject({ disabled: true, ttl: -1 });
});

test("an erase whose write fails leaves the account whole, to be erased again", async () => {
	const id = "acct-retried";
	await upsertAccount({ id, email: "t@b.test", name: "Retried" });
	await updatePerson(id, { about: "Still here." });
	setCosmosDatabase(
		interposed(cosmos.database, "batch", async () => {
			throw new Error("the store did not answer");
		}),
	);
	try {
		await expect(deleteAccount(id)).rejects.toThrow("did not answer");
	} finally {
		setCosmosDatabase(cosmos.database);
	}
	// Nothing was half written: the account is a person's still, and its session is not over.
	expect(await getAccount(id)).toMatchObject({
		name: "Retried",
		about: "Still here.",
	});
	expect((await readAccountStanding(id, {})).standing).toBe("active");
	expect(await deleteAccount(id)).toBe(true);
	expect(await getAccount(id)).toBeNull();
});

test("a sign-in report that finds the row deactivated since it read what an erase left makes no account of it", async () => {
	const id = "acct-remake-raced";
	await upsertAccount({ id, name: "Once" });
	expect(await deleteAccount(id)).toBe(true);
	// The sign-in has read the marker; before it writes, another sign-in makes the account and it is deactivated.
	setCosmosDatabase(
		interposed(cosmos.database, "patch", async () => {
			setCosmosDatabase(cosmos.database);
			await upsertAccount({ id, name: "Other" });
			expect(await setAccountDisabled(id, true)).toBe(true);
		}),
	);
	try {
		await upsertAccount({ id, name: "Late" });
	} finally {
		setCosmosDatabase(cosmos.database);
	}
	expect(await isAccountDisabled(id)).toBe(true);
	expect((await getAccount(id))?.name).toBe("Other");
});

test("an erase is kept for as long as a caller from before it can present itself, and no longer", async () => {
	let now = Date.UTC(2030, 0, 1);
	const database = fakeCosmosDatabase(identityContainers, () => now);
	setCosmosDatabase(database);
	const realNow = Date.now;
	Date.now = () => now;
	const seconds = () => Math.floor(now / 1000);
	try {
		await upsertAccount({ id: "acct-timed", name: "Timed" });
		const began = seconds() - 1;
		expect(await deleteAccount("acct-timed")).toBe(true);
		const accounts = database.container("accounts");
		// The session's last second, and the last second of the last assertion it minted: both still meet the marker.
		now += (SESSION_MAX_AGE_SECONDS + CALLER_ASSERTION_TTL_SECONDS) * 1000;
		expect(await accounts.read("acct-timed", "acct-timed")).not.toBeNull();
		expect(
			(await readAccountStanding("acct-timed", { signedInAt: began })).standing,
		).toBe("erased");
		now += (CLOCK_SKEW_SECONDS + 1) * 1000;
		expect(await accounts.read("acct-timed", "acct-timed")).toBeNull();
		// With nothing left, the id is a first sign-in again and no session is refused.
		expect((await readAccountStanding("acct-timed", {})).standing).toBe(
			"active",
		);

		// An account made over a marker keeps the erase exactly as long, and no lifetime of its own.
		await upsertAccount({ id: "acct-kept", name: "Kept" });
		const old = seconds() - 1;
		expect(await deleteAccount("acct-kept")).toBe(true);
		const erased = seconds();
		now += 10 * 60_000;
		await upsertAccount({ id: "acct-kept", name: "Kept again" });
		now =
			(erased + SESSION_MAX_AGE_SECONDS + CALLER_ASSERTION_TTL_SECONDS) * 1000;
		expect(await getAccount("acct-kept")).toMatchObject({ name: "Kept again" });
		for (const session of [{ signedInAt: old }, {}])
			expect((await readAccountStanding("acct-kept", session)).standing).toBe(
				"erased",
			);
		// Past the bound the erase is nothing to anyone, before any sign-in has dropped it from the row.
		now = (erased + ERASE_KEPT_SECONDS + 1) * 1000;
		expect(await getAccount("acct-kept")).toMatchObject({ name: "Kept again" });
		expect((await readAccountStanding("acct-kept", {})).standing).toBe(
			"active",
		);
		expect(await accounts.read("acct-kept", "acct-kept")).toMatchObject({
			erasedAt: erased,
		});
		await upsertAccount({ id: "acct-kept" });
		expect(await accounts.read("acct-kept", "acct-kept")).toMatchObject({
			erasedAt: null,
			admittedAt: null,
		});
	} finally {
		Date.now = realNow;
		setCosmosDatabase(cosmos.database);
	}
});

test("the sign-in after an erase is admitted by this side's clock: a web app whose clock runs behind is not refused, and a session from well before the erase is", async () => {
	let now = Date.UTC(2030, 0, 2);
	const database = fakeCosmosDatabase(identityContainers, () => now);
	setCosmosDatabase(database);
	const realNow = Date.now;
	Date.now = () => now;
	const seconds = () => Math.floor(now / 1000);
	try {
		const id = "acct-skewed";
		await upsertAccount({ id, name: "Skewed" });
		const longBefore = seconds() - 10 * 60;
		expect(await deleteAccount(id)).toBe(true);
		// Signed in again two seconds after the erase, by a web app three seconds behind: stamped before the erase.
		now += 2_000;
		await upsertAccount({ id, name: "Skewed" });
		const stamped = seconds() - 3;
		expect(
			(await readAccountStanding(id, { signedInAt: stamped })).standing,
		).toBe("active");
		// The allowance is a minute and no more.
		expect(
			(
				await readAccountStanding(id, {
					signedInAt: seconds() - CLOCK_SKEW_SECONDS - 1,
				})
			).standing,
		).toBe("erased");
		expect(
			(await readAccountStanding(id, { signedInAt: longBefore })).standing,
		).toBe("erased");
	} finally {
		Date.now = realNow;
		setCosmosDatabase(cosmos.database);
	}
});

test("erasing a deactivated account leaves the deactivation and nothing of the person, so it stays shut", async () => {
	const signIn = { claims: { oid: "acct-shut", email: "shut@b.test" } };
	await upsertAccount({
		id: "acct-shut",
		email: "shut@b.test",
		name: "Shut",
		roles: ["premium"],
		groups: ["g-1"],
	});
	await updatePerson("acct-shut", { about: "Mine.", preferences: "Brief." });
	await setAccountDisabled("acct-shut", true);
	expect(await deleteAccount("acct-shut")).toBe(true);
	expect(await getAccount("acct-shut")).toEqual({
		id: "acct-shut",
		email: null,
		name: null,
		about: null,
		preferences: null,
		roles: [],
		groups: [],
		disabled: true,
		voiceTuning: null,
		createdAt: null,
		lastLoginAt: null,
	});
	// Nobody's record: every session that names the id began before the erase, and is over.
	expect(await readAccountStanding("acct-shut")).toEqual({
		standing: "erased",
		account: null,
		remade: false,
		deactivated: true,
	});
	expect(await resolveSignIn(signIn)).toEqual({
		ok: false,
		reason: "deactivated",
	});
	// No write lands on it: the person's session cannot put a word back.
	expect(
		await updatePerson("acct-shut", { name: "Back", about: "After." }),
	).toBeNull();
	expect(await updatePerson("acct-shut", {})).toBeNull();
	expect(await setVoiceTuning("acct-shut", { engine: "cascade" })).toBe(false);
	await upsertAccount({ id: "acct-shut", name: "Back", roles: ["premium"] });
	// A second erase finds nothing of a person and leaves it as it is.
	expect(await deleteAccount("acct-shut")).toBe(false);
	const left = await cosmos.database
		.container("accounts")
		.read("acct-shut", "acct-shut");
	expect(left).toMatchObject({
		disabled: true,
		email: null,
		name: null,
		about: null,
		preferences: null,
		roles: [],
		groups: [],
		voiceTuning: null,
		createdAt: null,
		lastLoginAt: null,
		admittedAt: null,
		ttl: -1,
	});
	expect(await isAccountDisabled("acct-shut")).toBe(true);
});

test("a provider token without its stable id names no account", async () => {
	expect(
		await resolveSignIn({ claims: { email: "a@b.test" }, user: { id: "x" } }),
	).toEqual({ ok: false, reason: "no_account" });
});

test("an erase is the session's own or nobody's: the account a sign-in made after an erase is not erased by a session from before it, read or raced", async () => {
	const id = "acct-not-yours";
	await upsertAccount({ id, name: "First" });
	const old = Math.floor(Date.now() / 1000) - 10 * 60;
	expect(await deleteAccount(id, { signedInAt: old })).toBe(true);
	// A marker is nobody's to erase again, whoever asks.
	expect(await deleteAccount(id, { signedInAt: old })).toBe(false);
	await upsertAccount({ id, name: "Second" });
	await updatePerson(id, { about: "The second person's." });
	const now = Math.floor(Date.now() / 1000);
	for (const session of [{ signedInAt: old }, {}])
		await expect(deleteAccount(id, session)).rejects.toThrow(
			ErasedSessionError,
		);
	expect(await getAccount(id)).toMatchObject({
		name: "Second",
		about: "The second person's.",
	});

	// The same, landing between the erase's read and its write: the session read its own account, and by the write it is somebody else's.
	const raced = "acct-not-yours-raced";
	await upsertAccount({ id: raced, name: "First" });
	setCosmosDatabase(
		interposed(cosmos.database, "batch", async () => {
			setCosmosDatabase(cosmos.database);
			expect(await deleteAccount(raced)).toBe(true);
			await upsertAccount({ id: raced, name: "Second" });
		}),
	);
	try {
		await expect(deleteAccount(raced, { signedInAt: old })).rejects.toThrow(
			ErasedSessionError,
		);
	} finally {
		setCosmosDatabase(cosmos.database);
	}
	expect(await getAccount(raced)).toMatchObject({ name: "Second" });
	// The new account's own session erases it.
	expect(await deleteAccount(raced, { signedInAt: now })).toBe(true);
});

test("a sign-in's refresh and the name it fills never land on what an erase made of the row in between", async () => {
	// The erase lands after the sign-in read the row and before its refresh: the refresh is decided again, and makes a new account of the marker.
	const refreshed = "acct-refresh-raced";
	await upsertAccount({ id: refreshed, name: "Before" });
	await updatePerson(refreshed, { about: "The first person's." });
	setCosmosDatabase(
		interposed(cosmos.database, "patch", async () => {
			setCosmosDatabase(cosmos.database);
			expect(await deleteAccount(refreshed)).toBe(true);
		}),
	);
	try {
		await upsertAccount({ id: refreshed, name: "After", roles: ["premium"] });
	} finally {
		setCosmosDatabase(cosmos.database);
	}
	expect(await getAccount(refreshed)).toMatchObject({
		name: "After",
		about: null,
		roles: ["premium"],
	});
	expect(
		await cosmos.database.container("accounts").read(refreshed, refreshed),
	).toMatchObject({ ttl: -1, admittedAt: expect.any(Number) });

	// The erase lands after the refresh and before the name: nothing of the person is written onto the marker.
	const named = "acct-name-raced";
	await upsertAccount({ id: named });
	setCosmosDatabase(
		interposed(
			cosmos.database,
			"patch",
			async () => {
				setCosmosDatabase(cosmos.database);
				expect(await deleteAccount(named)).toBe(true);
			},
			1,
		),
	);
	try {
		await upsertAccount({ id: named, name: "Ada Lovelace" });
	} finally {
		setCosmosDatabase(cosmos.database);
	}
	expect(
		await cosmos.database.container("accounts").read(named, named),
	).toMatchObject({ name: null, admittedAt: null, ttl: ERASE_KEPT_SECONDS });
});

test("a re-activation that lands as a deactivated account's erase runs is kept: what is left is an active account's marker, not a tombstone", async () => {
	const id = "acct-reopened-raced";
	await upsertAccount({ id, name: "Reopened" });
	expect(await setAccountDisabled(id, true)).toBe(true);
	setCosmosDatabase(
		interposed(cosmos.database, "batch", async () => {
			setCosmosDatabase(cosmos.database);
			expect(await setAccountDisabled(id, false)).toBe(true);
		}),
	);
	try {
		expect(await deleteAccount(id)).toBe(true);
	} finally {
		setCosmosDatabase(cosmos.database);
	}
	expect(
		await cosmos.database.container("accounts").read(id, id),
	).toMatchObject({ disabled: false, name: null, ttl: ERASE_KEPT_SECONDS });
	expect(await isAccountDisabled(id)).toBe(false);
});

test("what an erase left can be shut: a marker deactivated is a tombstone, and the id's next sign-in is refused", async () => {
	const id = "acct-marker-shut";
	await upsertAccount({ id, name: "Gone" });
	expect(await deleteAccount(id)).toBe(true);
	expect(await setAccountDisabled(id, true)).toBe(true);
	expect(
		await cosmos.database.container("accounts").read(id, id),
	).toMatchObject({ disabled: true, name: null, createdAt: null, ttl: -1 });
	expect(await resolveSignIn({ claims: { oid: id } })).toEqual({
		ok: false,
		reason: "deactivated",
	});
	expect(await readAccountStanding(id, {})).toEqual({
		standing: "erased",
		account: null,
		remade: false,
		deactivated: true,
	});
	expect(await setAccountDisabled(id, true)).toBe(true);
});

test("a tombstone brought back is an empty record created then, and admits no session from before the erase that made it", async () => {
	let now = Date.UTC(2030, 0, 3);
	const database = fakeCosmosDatabase(identityContainers, () => now);
	setCosmosDatabase(database);
	const realNow = Date.now;
	Date.now = () => now;
	const seconds = () => Math.floor(now / 1000);
	try {
		const id = "acct-brought-back";
		await upsertAccount({ id, name: "First" });
		expect(await deleteAccount(id)).toBe(true);
		now += 60_000;
		await upsertAccount({ id, name: "Second" });
		// A session of the second account, admitted on it.
		const second = seconds();
		expect(
			(await readAccountStanding(id, { signedInAt: second })).standing,
		).toBe("active");
		now += 10 * 60_000;
		expect(await setAccountDisabled(id, true)).toBe(true);
		expect(await deleteAccount(id)).toBe(true);
		const erased = seconds();
		now += 60_000;
		expect(await setAccountDisabled(id, false)).toBe(true);
		const row = await database.container("accounts").read(id, id);
		expect(row).toMatchObject({
			disabled: false,
			name: null,
			erasedAt: erased,
			admittedAt: null,
		});
		expect(row?.createdAt).toBe(new Date(now).toISOString());
		// The second account's session began before that erase; one stamped within the allowance before it is refused too, with no admission on the row to measure from.
		for (const signedInAt of [second, erased - 30, erased])
			expect((await readAccountStanding(id, { signedInAt })).standing).toBe(
				"erased",
			);
		expect((await readAccountStanding(id, {})).standing).toBe("erased");
		// A session opened since is the record's own.
		expect(
			(await readAccountStanding(id, { signedInAt: erased + 1 })).standing,
		).toBe("active");
		await upsertAccount({ id, name: "Third" });
		expect(await getAccount(id)).toMatchObject({ name: "Third" });
	} finally {
		Date.now = realNow;
		setCosmosDatabase(cosmos.database);
	}
});

test("a marker the service did not remove is nothing to anyone past its bound: no session is refused on it, it can be shut, and a sign-in makes a clean account of it", async () => {
	let now = Date.UTC(2030, 0, 4);
	// A container with no per-item lifetime: the marker stays where the service would have removed it.
	const database = fakeCosmosDatabase(
		[{ name: "accounts", partitionKey: "/id" }],
		() => now,
	);
	setCosmosDatabase(database);
	const realNow = Date.now;
	Date.now = () => now;
	try {
		for (const id of ["acct-stale", "acct-stale-shut"]) {
			await upsertAccount({ id, name: "Stale" });
			expect(await deleteAccount(id)).toBe(true);
		}
		now += (ERASE_KEPT_SECONDS + 3600) * 1000;
		const accounts = database.container("accounts");
		expect(await accounts.read("acct-stale", "acct-stale")).not.toBeNull();
		expect(await readAccountStanding("acct-stale", {})).toEqual({
			standing: "active",
			account: null,
		});
		expect(await getAccount("acct-stale")).toBeNull();
		expect(await setAccountDisabled("acct-stale-shut", true)).toBe(true);
		expect(await isAccountDisabled("acct-stale-shut")).toBe(true);
		await upsertAccount({ id: "acct-stale", name: "Fresh" });
		expect(await accounts.read("acct-stale", "acct-stale")).toMatchObject({
			name: "Fresh",
			erasedAt: null,
			admittedAt: null,
			ttl: -1,
		});
		expect((await readAccountStanding("acct-stale", {})).standing).toBe(
			"active",
		);
	} finally {
		Date.now = realNow;
		setCosmosDatabase(cosmos.database);
	}
});

/** The row as it is stored, the service's own fields with it. */
const row = (id: string) =>
	cosmos.database
		.container("accounts")
		.read<{ id: string } & Record<string, unknown>>(id, id);

test("an erase shuts the row with its first write: until it is finished no session is admitted, no sign-in makes an account, no edit lands, and nothing of the person is on it", async () => {
	const id = "acct-shutting";
	await upsertAccount({ id, email: "s@example.com", name: "Shutting" });
	await updatePerson(id, { about: "Mine until it is gone." });
	const erase = await beginErase(id);
	expect(erase.phase).toBe("begun");
	expect(await row(id)).toMatchObject({
		email: null,
		name: null,
		about: null,
		ttl: -1,
	});
	const later = Math.floor(Date.now() / 1000) + 5;
	expect(await readAccountStanding(id, { signedInAt: later })).toEqual({
		standing: "erased",
		account: null,
		remade: false,
		erasing: true,
	});
	expect(await getAccount(id)).toBeNull();
	expect(
		await updatePerson(id, { about: "Written under the sweep." }),
	).toBeNull();
	expect(await setVoiceTuning(id, { voice: "x" })).toBe(false);
	expect(await resolveSignIn({ claims: { oid: id } })).toEqual({
		ok: false,
		reason: "unavailable",
	});
	expect((await row(id))?.about).toBeNull();

	if (erase.phase !== "begun") throw new Error("the erase was not begun");
	expect(await finishErase(id, erase.token)).toBe(true);
	expect(await row(id)).toMatchObject({ ttl: ERASE_KEPT_SECONDS });
	expect((await row(id))?.erasing ?? null).toBeNull();
	expect(await resolveSignIn({ claims: { oid: id } })).toMatchObject({
		ok: true,
	});
});

test("a sign-in recorded as an erase begins lands nothing on the shut row and says the erase is under way", async () => {
	const id = "acct-shut-mid-sign-in";
	await upsertAccount({ id, name: "First" });
	const erase = await beginErase(id);
	if (erase.phase !== "begun") throw new Error("the erase was not begun");
	const shut = await row(id);
	await expect(
		upsertAccount({
			id,
			email: "late@example.com",
			name: "Late",
			roles: ["x"],
		}),
	).rejects.toBeInstanceOf(EraseUnderWayError);
	expect(await row(id)).toEqual(shut);
	expect(await finishErase(id, erase.token)).toBe(true);
});

test("an erase is one holder's at a time: a second finds it busy, and only the holder finishes it", async () => {
	const id = "acct-held";
	await upsertAccount({ id });
	const first = await beginErase(id);
	if (first.phase !== "begun") throw new Error("the erase was not begun");
	expect(await beginErase(id)).toEqual({ phase: "busy" });
	expect(await deleteAccount(id)).toBe(false);
	expect(await finishErase(id, "somebody-else")).toBe(false);
	expect((await row(id))?.erasing).toBeNumber();
	expect(await finishErase(id, first.token)).toBe(true);
	expect(await beginErase(id)).toEqual({ phase: "finished" });
});

test("an erase whose sweep failed lets go, and the next ask takes it up at once: the person's sign-in sweeps again, finishes it and is a new account", async () => {
	const id = "acct-let-go";
	await upsertAccount({ id, name: "First" });
	const failed = await beginErase(id);
	if (failed.phase !== "begun") throw new Error("the erase was not begun");
	await releaseErase(id, failed.token);
	// With nothing to sweep with, a sign-in cannot finish it and stays refused.
	expect(await resolveSignIn({ claims: { oid: id } })).toEqual({
		ok: false,
		reason: "unavailable",
	});
	const swept: string[] = [];
	const outcome = await resolveSignIn(
		{ claims: { oid: id, name: "Second" } },
		{ sweep: async (accountId) => void swept.push(accountId) },
	);
	expect(outcome).toMatchObject({ ok: true, accountId: id });
	expect(swept).toEqual([id]);
	expect(await getAccount(id)).toMatchObject({ name: "Second", about: null });
	// The one that let go has nothing left to finish.
	expect(await finishErase(id, failed.token)).toBe(false);
	expect((await getAccount(id))?.name).toBe("Second");
});

test("a sign-in whose own sweep fails lets the erase go again and is refused, and the one after finishes it", async () => {
	const id = "acct-sweep-fails";
	await upsertAccount({ id });
	const failed = await beginErase(id);
	if (failed.phase !== "begun") throw new Error("the erase was not begun");
	await releaseErase(id, failed.token);
	const quiet = console.error;
	console.error = () => {};
	try {
		expect(
			await resolveSignIn(
				{ claims: { oid: id } },
				{
					sweep: async () => {
						throw new Error("the service did not answer");
					},
				},
			),
		).toEqual({ ok: false, reason: "unavailable" });
	} finally {
		console.error = quiet;
	}
	expect((await row(id))?.erasingBy ?? null).toBeNull();
	expect(
		await resolveSignIn({ claims: { oid: id } }, { sweep: async () => {} }),
	).toMatchObject({ ok: true });
});

test("an erase held and never finished is taken up once it has stood longer than one takes, and not before", async () => {
	const id = "acct-stalled";
	await upsertAccount({ id });
	const died = await beginErase(id);
	if (died.phase !== "begun") throw new Error("the erase was not begun");
	let sweeps = 0;
	const sweep = async () => void sweeps++;
	// Held and fresh: somebody is sweeping, so a sign-in waits.
	expect(await resolveSignIn({ claims: { oid: id } }, { sweep })).toEqual({
		ok: false,
		reason: "unavailable",
	});
	expect(sweeps).toBe(0);
	// Its holder gone for longer than an erase takes.
	const stood = Math.floor(Date.now() / 1000) - ERASE_STALLED_SECONDS - 1;
	await cosmos.database
		.container("accounts")
		.patch(id, id, [{ op: "set", path: "/erasing", value: stood }]);
	expect(await resolveSignIn({ claims: { oid: id } }, { sweep })).toMatchObject(
		{ ok: true },
	);
	expect(sweeps).toBe(1);
	// The holder that was taken for gone finishes nothing.
	expect(await finishErase(id, died.token)).toBe(false);
	expect(await getAccount(id)).not.toBeNull();
});

test("an erase whose holder is sweeping, however slowly, is renewed and never taken over; once taken, its holder's sweep is told", async () => {
	const id = "acct-slow-sweep";
	await upsertAccount({ id });
	const erase = await beginErase(id);
	if (erase.phase !== "begun") throw new Error("the erase was not begun");
	const stood = Math.floor(Date.now() / 1000) - ERASE_STALLED_SECONDS - 1;
	const age = () =>
		cosmos.database
			.container("accounts")
			.patch(id, id, [{ op: "set", path: "/erasing", value: stood }]);
	const asked: boolean[] = [];
	await underLease(
		id,
		erase.token,
		async (stillHeld) => {
			// A sweep that runs long: the stamp it stood from is old, and the renewal moves it.
			await age();
			await Bun.sleep(120);
			expect(await beginErase(id)).toEqual({ phase: "busy" });
			asked.push(await stillHeld());
		},
		20,
	);
	expect(asked).toEqual([true]);
	// Not renewed — its process frozen — it is taken over, and its sweep then hears so.
	await age();
	const taken = await beginErase(id);
	expect(taken.phase).toBe("resumed");
	expect(await renewErase(id, erase.token)).toBe(false);
	await underLease(id, erase.token, async (stillHeld) => {
		asked.push(await stillHeld());
	});
	expect(asked).toEqual([true, false]);
});

test("a deactivation that lands while an erase sweeps is kept: the erase ends as the tombstone, and the sign-in is refused as deactivated throughout", async () => {
	const id = "acct-shut-under-sweep";
	await upsertAccount({ id, name: "Shut" });
	const erase = await beginErase(id);
	if (erase.phase !== "begun") throw new Error("the erase was not begun");
	expect(await setAccountDisabled(id, true)).toBe(true);
	expect(await resolveSignIn({ claims: { oid: id } })).toEqual({
		ok: false,
		reason: "deactivated",
	});
	expect(await finishErase(id, erase.token)).toBe(true);
	expect(await row(id)).toMatchObject({
		disabled: true,
		ttl: -1,
		createdAt: null,
	});
	expect(await readAccountStanding(id, {})).toMatchObject({
		standing: "erased",
		deactivated: true,
	});
	expect(await resolveSignIn({ claims: { oid: id } })).toEqual({
		ok: false,
		reason: "deactivated",
	});
});

test("a session from before an erase is the erased person's on the account made since, deactivated or not", async () => {
	const id = "acct-remade-shut";
	const before = Math.floor(Date.now() / 1000) - 10 * 60;
	await upsertAccount({ id, name: "First" });
	expect(await deleteAccount(id)).toBe(true);
	await upsertAccount({ id, name: "Second" });
	const after = Math.floor(Date.now() / 1000);
	expect(await setAccountDisabled(id, true)).toBe(true);
	expect(await readAccountStanding(id, { signedInAt: before })).toEqual({
		standing: "erased",
		account: null,
		remade: true,
	});
	// The account's own session is deactivated, and keeps a deactivated person's rights.
	expect((await readAccountStanding(id, { signedInAt: after })).standing).toBe(
		"deactivated",
	);
});
