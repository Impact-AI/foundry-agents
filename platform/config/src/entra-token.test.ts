import { expect, test } from "bun:test";
import {
	createEntraTokenProvider,
	type TokenCredentialLike,
} from "./entra-token";

const HOUR = 60 * 60_000;

function credential(
	mints: Array<
		() => Promise<{ token: string; expiresOnTimestamp: number } | null>
	>,
): TokenCredentialLike & { calls: number } {
	let calls = 0;
	return {
		get calls() {
			return calls;
		},
		getToken: async () => {
			const mint = mints[Math.min(calls, mints.length - 1)];
			calls++;
			return mint ? mint() : null;
		},
	};
}

test("concurrent callers share one mint, and the token is cached until the margin", async () => {
	let now = 0;
	const cred = credential([
		async () => ({ token: "t1", expiresOnTimestamp: HOUR }),
	]);
	const token = createEntraTokenProvider({
		credential: () => cred,
		scope: "https://example.test/.default",
		now: () => now,
	});
	const [a, b, c] = await Promise.all([token(), token(), token()]);
	expect([a, b, c]).toEqual(["t1", "t1", "t1"]);
	expect(cred.calls).toBe(1);
	now = HOUR - 10 * 60_000;
	expect(await token()).toBe("t1");
	expect(cred.calls).toBe(1);
});

test("past the margin a new token is minted; a failed refresh serves the still-valid one", async () => {
	let now = 0;
	const cred = credential([
		async () => ({ token: "t1", expiresOnTimestamp: HOUR }),
		async () => {
			throw new Error("imds down");
		},
		async () => ({ token: "t2", expiresOnTimestamp: 3 * HOUR }),
	]);
	const token = createEntraTokenProvider({
		credential: () => cred,
		scope: "s",
		now: () => now,
	});
	expect(await token()).toBe("t1");
	now = HOUR - 60_000;
	expect(await token()).toBe("t1");
	expect(cred.calls).toBe(2);
	now = HOUR + 1;
	expect(await token()).toBe("t2");
});

test("a mint that never settles fails its callers within the bound, and a late token is still cached", async () => {
	let release: (t: { token: string; expiresOnTimestamp: number }) => void =
		() => {};
	const cred = credential([
		() =>
			new Promise((resolve) => {
				release = resolve;
			}),
	]);
	const token = createEntraTokenProvider({
		credential: () => cred,
		scope: "s",
		mintTimeoutMs: 20,
	});
	await expect(token()).rejects.toThrow("did not settle within 20ms");
	release({ token: "late", expiresOnTimestamp: Date.now() + HOUR });
	await Bun.sleep(1);
	expect(await token()).toBe("late");
	expect(cred.calls).toBe(1);
});

test("a credential that answers with no token is an error that names the scope", async () => {
	const token = createEntraTokenProvider({
		credential: () => credential([async () => null]),
		scope: "https://example.test/.default",
		hint: "grant the role",
	});
	await expect(token()).rejects.toThrow(
		"no access token for https://example.test/.default. grant the role",
	);
});
