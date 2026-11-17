import { afterEach, expect, test } from "bun:test";
import { accountAccess, isPremium, NO_ACCESS, resolveAccess } from "./access";
import { isAdmitted } from "./admission";
import { normalizeEmail } from "./email";
import { GROUPS_MAX, groupsOf, groupsOverflowed } from "./groups";
import {
	authMode,
	holdsUnderMode,
	LOCAL_PROVIDER_ID,
	LOCAL_ROLES,
	localAccount,
	parseAuthMode,
} from "./local";
import { resolveSessionClaims } from "./session";
import {
	isSignInAllowed,
	resolveEmail,
	signInAccountId,
	signInGroups,
	signInRoles,
} from "./sign-in";

const VARIABLES = ["AUTH_MODE", "AUTH_REQUIRE_ROLE"] as const;
const saved = VARIABLES.map((name) => [name, process.env[name]] as const);

afterEach(() => {
	for (const [name, value] of saved) {
		if (value === undefined) delete process.env[name];
		else process.env[name] = value;
	}
});

function env(values: Partial<Record<(typeof VARIABLES)[number], string>>) {
	for (const name of VARIABLES) {
		const value = values[name];
		if (value === undefined) delete process.env[name];
		else process.env[name] = value;
	}
}

test("an address is normalised to one storage form, and non-addresses are refused", () => {
	expect(normalizeEmail("  Some One <Some.One@Example.COM> ")).toBe(
		"some.one@example.com",
	);
	expect(normalizeEmail("mailto:a@b.co")).toBe("a@b.co");
	expect(normalizeEmail("o'neill@example.com")).toBe("o'neill@example.com");
	for (const bad of [
		"email",
		"a@b",
		"@b.com",
		"a@@b.com",
		"a@b.com (note)",
		"a@.com",
		"",
	]) {
		expect(normalizeEmail(bad)).toBeNull();
	}
});

test("the tier comes from the app roles alone, spelled as the registration spells them", () => {
	expect(resolveAccess([])).toEqual({ tier: "base" });
	expect(resolveAccess(null)).toEqual({ tier: "base" });
	expect(resolveAccess(["user"])).toEqual({ tier: "base" });
	expect(resolveAccess(["premium"])).toEqual({ tier: "premium" });
	expect(resolveAccess(["user", "premium"])).toEqual({ tier: "premium" });
	expect(isPremium(["Premium"])).toBe(false);
	expect(isPremium(["admin"])).toBe(false);
	expect(accountAccess(null)).toBe(NO_ACCESS);
	expect(accountAccess({ roles: ["premium"], groups: ["g-1"] })).toEqual({
		tier: "premium",
		groups: ["g-1"],
	});
});

test("admission is open until a role is required, and then needs one this package knows", () => {
	env({ AUTH_REQUIRE_ROLE: undefined });
	expect(isAdmitted([])).toBe(true);
	expect(isAdmitted(null)).toBe(true);
	env({ AUTH_REQUIRE_ROLE: "true" });
	expect(isAdmitted([])).toBe(false);
	expect(isAdmitted(["stranger"])).toBe(false);
	expect(isAdmitted(["user"])).toBe(true);
	expect(isAdmitted(["stranger", "premium"])).toBe(true);
	env({ AUTH_REQUIRE_ROLE: "0" });
	expect(isAdmitted([])).toBe(true);
});

test("groups are read as strings, capped, and an overage marker reads as none", () => {
	expect(groupsOf({ groups: ["g-1", 2, "g-3"] })).toEqual(["g-1", "g-3"]);
	expect(groupsOf({})).toEqual([]);
	expect(groupsOf(null)).toEqual([]);
	const many = Array.from({ length: GROUPS_MAX + 5 }, (_, i) => `g-${i}`);
	expect(groupsOf({ groups: many })).toHaveLength(GROUPS_MAX);
	expect(groupsOverflowed({ groups: [] })).toBe(false);
	expect(groupsOverflowed({ hasgroups: true })).toBe(true);
	expect(
		groupsOverflowed({ _claim_names: { groups: "src1" }, groups: undefined }),
	).toBe(true);
	expect(groupsOverflowed({ _claim_names: { other: "x" } })).toBe(false);
	expect(groupsOf({ hasgroups: true, groups: ["g-1"] })).toEqual([]);
	expect(
		groupsOf({ _claim_names: { groups: "src1" }, groups: ["g-1"] }),
	).toEqual([]);
});

test("the sign-in mode is entra unless local is named; a typo opens nothing", () => {
	expect(parseAuthMode("local")).toBe("local");
	expect(parseAuthMode(" entra ")).toBe("entra");
	expect(parseAuthMode("open")).toBeNull();
	env({ AUTH_MODE: undefined });
	expect(authMode()).toBe("entra");
	env({ AUTH_MODE: "anything" });
	expect(authMode()).toBe("entra");
	env({ AUTH_MODE: "local" });
	expect(authMode()).toBe("local");
});

test("a local account is named, never identified, by what was typed: every sign-in is a new person, and every one is a member", () => {
	const ada = localAccount("  Ada ");
	expect(ada).toMatchObject({ name: "Ada", email: null });
	expect(ada?.id).toMatch(
		/^local:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
	);
	// The same name typed again — by Ada or by anybody — is somebody else.
	expect(localAccount("Ada")?.id).not.toBe(ada?.id);
	for (const bad of ["", " ", "<ada>", "a".repeat(61), ".ada", 42, null]) {
		expect(localAccount(bad)).toBeNull();
	}
	expect(LOCAL_ROLES).toEqual(["user"]);
});

test("a local session holds only while the mode is local", () => {
	env({ AUTH_MODE: "local" });
	expect(holdsUnderMode("local:ada")).toBe(true);
	expect(holdsUnderMode("oid-1")).toBe(true);
	env({ AUTH_MODE: "entra" });
	expect(holdsUnderMode("local:ada")).toBe(false);
	expect(holdsUnderMode("oid-1")).toBe(true);
});

test("a sign-in's id, email, roles and groups come off the provider's shapes", () => {
	const claims = {
		oid: "oid-1",
		preferred_username: "Work@Example.com",
		roles: ["premium", 3],
		groups: ["g-1"],
	};
	expect(signInAccountId({ claims, user: { id: "sub-1" } })).toBe("oid-1");
	expect(signInAccountId({ user: { id: "sub-1" } })).toBeNull();
	expect(signInAccountId({})).toBeNull();
	expect(resolveEmail(claims)).toBe("work@example.com");
	expect(resolveEmail({ email: "e@x.test", upn: "u@x.test" })).toBe("e@x.test");
	expect(resolveEmail(null, { email: "u@x.test" })).toBe("u@x.test");
	expect(resolveEmail({ email: "not an address" })).toBeNull();
	expect(resolveEmail({ email: "not an address", upn: "u@x.test" })).toBe(
		"u@x.test",
	);
	expect(signInRoles({ claims })).toEqual(["premium"]);
	expect(signInGroups({ claims })).toEqual(["g-1"]);
});

test("a local sign-in is its own shape: the id must be a local one, every name is a member, the groups are none", () => {
	const minted = localAccount("Ada");
	const ada = {
		account: { provider: LOCAL_PROVIDER_ID },
		user: minted,
	};
	const admin = { ...ada, user: localAccount("admin") };
	expect(signInAccountId(ada)).toBe(minted?.id ?? "");
	expect(signInRoles(ada)).toEqual(["user"]);
	expect(signInRoles(admin)).toEqual(["user"]);
	expect(signInGroups({ ...ada, claims: { groups: ["g-1"] } })).toEqual([]);
	const forged = { ...ada, user: { id: "oid-of-somebody" } };
	expect(signInAccountId(forged)).toBeNull();
	expect(signInRoles(forged)).toEqual([]);
});

test("the gate: a local sign-in only in local mode, an entra sign-in by role when one is required", () => {
	const local = {
		account: { provider: LOCAL_PROVIDER_ID },
		user: { id: "local:ada" },
	};
	env({ AUTH_MODE: undefined, AUTH_REQUIRE_ROLE: undefined });
	expect(isSignInAllowed(local)).toBe(false);
	expect(isSignInAllowed({ claims: { oid: "o", roles: [] } })).toBe(true);
	env({ AUTH_MODE: "local", AUTH_REQUIRE_ROLE: "true" });
	expect(isSignInAllowed(local)).toBe(true);
	expect(isSignInAllowed({ claims: { oid: "o", roles: [] } })).toBe(false);
	expect(isSignInAllowed({ claims: { oid: "o", roles: ["user"] } })).toBe(true);
});

test("session claims take what the token baked, fall back to the roles when it baked nothing, and carry the groups", () => {
	expect(
		resolveSessionClaims({ id: "a", roles: ["premium"], groups: ["g-1"] }),
	).toEqual({
		id: "a",
		roles: ["premium"],
		groups: ["g-1"],
		tier: "premium",
	});
	expect(
		resolveSessionClaims({
			id: "a",
			roles: ["premium"],
			groups: null,
			tier: "base",
		}),
	).toEqual({
		id: "a",
		roles: ["premium"],
		groups: [],
		tier: "base",
	});
	expect(resolveSessionClaims({ id: null, roles: null, groups: null }).id).toBe(
		"",
	);
});
