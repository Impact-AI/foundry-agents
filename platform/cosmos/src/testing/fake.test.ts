import { expect, test } from "bun:test";
import { BATCH_MAX_BYTES } from "../container";
import { fakeCosmosDatabase } from "./fake";

/** A document's own lifetime, on a clock the test moves. */

const TIMED = { name: "timed", partitionKey: "/id", itemTtl: true } as const;
const KEPT = { name: "kept", partitionKey: "/id" } as const;

test("a document that names a lifetime is gone when it has run, counted from its last write, and one that names none or -1 is kept", async () => {
	let now = Date.UTC(2030, 0, 1);
	const database = fakeCosmosDatabase([TIMED], () => now);
	const timed = database.container("timed");
	await timed.create({ id: "short", ttl: 60 });
	await timed.create({ id: "never", ttl: -1 });
	await timed.create({ id: "plain" });

	now += 59_000;
	expect(await timed.read("short", "short")).not.toBeNull();
	// A write starts the lifetime again.
	await timed.patch("short", "short", [{ op: "set", path: "/seen", value: 1 }]);
	now += 59_000;
	expect(await timed.read("short", "short")).not.toBeNull();
	now += 1_000;
	expect(await timed.read("short", "short")).toBeNull();
	expect(
		await timed.patch("short", "short", [
			{ op: "set", path: "/seen", value: 2 },
		]),
	).toBeNull();
	expect(await timed.query({ query: "SELECT * FROM c" }, "short")).toEqual([]);
	// The id is free again, as after the service's own removal.
	await timed.create({ id: "short" });

	now += 365 * 24 * 60 * 60 * 1000;
	expect(await timed.read("never", "never")).not.toBeNull();
	expect(await timed.read("plain", "plain")).not.toBeNull();
});

test("a container not declared with a per-item lifetime ignores the field, as the service does", async () => {
	let now = Date.UTC(2030, 0, 1);
	const database = fakeCosmosDatabase([KEPT], () => now);
	await database.container("kept").create({ id: "a", ttl: 1 });
	now += 60_000;
	expect(await database.container("kept").read("a", "a")).not.toBeNull();
});

test("a lifetime the service would refuse is refused: zero, a fraction, a negative other than -1, and anything that is not a number", async () => {
	const database = fakeCosmosDatabase([TIMED, KEPT]);
	const timed = database.container("timed");
	await timed.create({ id: "held", ttl: 60 });
	for (const ttl of [0, 1.5, -2, "60", null, Number.NaN]) {
		for (const name of ["timed", "kept"])
			await expect(
				database.container(name).create({ id: `bad-${String(ttl)}`, ttl }),
			).rejects.toMatchObject({ statusCode: 400 });
		await expect(
			timed.patch("held", "held", [{ op: "set", path: "/ttl", value: ttl }]),
		).rejects.toMatchObject({ statusCode: 400 });
	}
	expect(await timed.read("held", "held")).toMatchObject({ ttl: 60 });
});

test("a batch whose payload is past the service's bound is refused whole, as the service refuses it", async () => {
	const kept = fakeCosmosDatabase([KEPT]).container("kept");
	const half = "x".repeat(BATCH_MAX_BYTES / 2);
	await expect(
		kept.batch("a", [
			{ type: "create", document: { id: "a", body: half } },
			{
				type: "patch",
				id: "a",
				operations: [{ op: "set", path: "/more", value: half }],
			},
		]),
	).rejects.toMatchObject({ statusCode: 413 });
	expect(await kept.read("a", "a")).toBeNull();
	await kept.batch("a", [
		{ type: "create", document: { id: "a", body: half } },
	]);
	expect(await kept.read("a", "a")).toMatchObject({ id: "a" });
});
