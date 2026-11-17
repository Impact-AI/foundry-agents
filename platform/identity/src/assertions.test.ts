import { afterEach, beforeEach, expect, test } from "bun:test";
import { callerAssertion, defineAssertion, scopeAssertion } from "./assertions";

beforeEach(() => {
	process.env.AUTH_SECRET = "test-secret-value";
});

afterEach(() => {
	delete process.env.AUTH_SECRET;
});

test("a caller assertion round-trips, and the lesser answer is read for anything but the literal claim", async () => {
	const { token, expiresAt } = await callerAssertion.mint({
		sub: "acct-1",
		email: "a@b.test",
		roles: ["premium"],
		groups: ["g-1"],
		tier: "premium",
	});
	expect(expiresAt).toBeGreaterThan(Date.now());
	expect(await callerAssertion.verify(token)).toEqual({
		sub: "acct-1",
		email: "a@b.test",
		roles: ["premium"],
		groups: ["g-1"],
		tier: "premium",
	});
	const loose = defineAssertion<{
		sub: string;
		tier?: unknown;
	}>({
		label: "caller-assertion:v1",
		issuer: "frontend",
		audience: "backend",
		ttlSeconds: 60,
		read: (p) => ({ sub: String(p.sub) }),
	});
	const { token: sloppy } = await loose.mint({
		sub: "acct-2",
		tier: "gold",
	});
	expect(await callerAssertion.verify(sloppy)).toMatchObject({
		tier: "base",
		groups: [],
	});
});

test("a caller assertion carries when its session was signed in, and anything but a number is no sign-in time", async () => {
	const claims = {
		sub: "acct-1",
		email: null,
		roles: [],
		groups: [],
		tier: "base" as const,
	};
	const { token } = await callerAssertion.mint({
		...claims,
		signedInAt: 1_900_000_000,
	});
	expect(await callerAssertion.verify(token)).toEqual({
		...claims,
		signedInAt: 1_900_000_000,
	});
	const loose = defineAssertion<Record<string, unknown>>({
		label: "caller-assertion:v1",
		issuer: "frontend",
		audience: "backend",
		ttlSeconds: 60,
		read: (p) => p,
	});
	for (const signedInAt of ["1900000000", null, Number.NaN]) {
		const forged = await loose.mint({ ...claims, signedInAt });
		expect(await callerAssertion.verify(forged.token)).toEqual(claims);
	}
});

test("one purpose's token is not another's, tampering is refused, expiry is enforced, and the shape is checked", async () => {
	const { token } = await scopeAssertion.mint({ rid: "account-1" });
	expect(await scopeAssertion.verify(token)).toEqual({ rid: "account-1" });
	expect(await callerAssertion.verify(token)).toBeNull();
	const [body, signature] = token.split(".");
	expect(await scopeAssertion.verify(`${body}x.${signature}`)).toBeNull();
	expect(await scopeAssertion.verify(`${body}.${signature}.extra`)).toBeNull();
	expect(await scopeAssertion.verify("")).toBeNull();
	const { token: expired } = await scopeAssertion.mint(
		{ rid: "r" },
		{ ttlSeconds: -1 },
	);
	expect(await scopeAssertion.verify(expired)).toBeNull();
});

test("a token signed for the purpose by another issuer, or for another audience, is refused", async () => {
	const purpose = {
		label: "scope-assertion:v1",
		ttlSeconds: 60,
		read: (p: Record<string, unknown>) => ({ rid: String(p.rid) }),
	};
	const elsewhere = defineAssertion<{ rid: string }>({
		...purpose,
		issuer: "somebody-else",
		audience: "agent",
	});
	const forAnother = defineAssertion<{ rid: string }>({
		...purpose,
		issuer: "backend",
		audience: "somebody-else",
	});
	for (const other of [elsewhere, forAnother]) {
		const { token } = await other.mint({ rid: "account-1" });
		expect(await other.verify(token)).toEqual({ rid: "account-1" });
		expect(await scopeAssertion.verify(token)).toBeNull();
	}
});

test("without the secret, minting refuses rather than signing with nothing", async () => {
	delete process.env.AUTH_SECRET;
	await expect(scopeAssertion.mint({ rid: "r" })).rejects.toThrow(
		"AUTH_SECRET",
	);
});
