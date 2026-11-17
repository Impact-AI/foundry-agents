import { afterEach, beforeEach, expect, test } from "bun:test";
import { signCompact, verifyCompact } from "./signed-token";

const VAR = "SIGNED_TOKEN_TEST_SECRET";

beforeEach(() => {
	process.env[VAR] = "first-secret";
});

afterEach(() => {
	delete process.env[VAR];
});

test("a payload round-trips under its label and verifies under no other", async () => {
	const token = await signCompact({ a: 1, b: "two" }, VAR, "one:v1");
	expect(token.split(".")).toHaveLength(2);
	expect(await verifyCompact(token, VAR, "one:v1")).toEqual({ a: 1, b: "two" });
	expect(await verifyCompact(token, VAR, "two:v1")).toBeNull();
	expect(await verifyCompact(token, VAR, "one:v2")).toBeNull();
});

test("a tampered body, a tampered signature, an extra segment and a non-object payload are null", async () => {
	const token = await signCompact({ a: 1 }, VAR, "one:v1");
	const [body, signature] = token.split(".");
	expect(
		await verifyCompact(`${body}x.${signature}`, VAR, "one:v1"),
	).toBeNull();
	expect(
		await verifyCompact(`${body}.${signature}x`, VAR, "one:v1"),
	).toBeNull();
	expect(await verifyCompact(`${token}.extra`, VAR, "one:v1")).toBeNull();
	expect(await verifyCompact("", VAR, "one:v1")).toBeNull();
	expect(await verifyCompact("not-a-token", VAR, "one:v1")).toBeNull();
	const list = await signCompact([1, 2] as unknown as object, VAR, "one:v1");
	expect(await verifyCompact(list, VAR, "one:v1")).toBeNull();
});

test("a rotated secret re-derives the key: the old token stops verifying, a new one verifies", async () => {
	const old = await signCompact({ a: 1 }, VAR, "one:v1");
	process.env[VAR] = "second-secret";
	expect(await verifyCompact(old, VAR, "one:v1")).toBeNull();
	const fresh = await signCompact({ a: 1 }, VAR, "one:v1");
	expect(await verifyCompact(fresh, VAR, "one:v1")).toEqual({ a: 1 });
	process.env[VAR] = "first-secret";
	expect(await verifyCompact(old, VAR, "one:v1")).toEqual({ a: 1 });
});

test("without the secret, signing refuses naming the variable, and nothing verifies", async () => {
	const token = await signCompact({ a: 1 }, VAR, "one:v1");
	delete process.env[VAR];
	await expect(signCompact({ a: 1 }, VAR, "one:v1")).rejects.toThrow(VAR);
	expect(await verifyCompact(token, VAR, "one:v1")).toBeNull();
});
