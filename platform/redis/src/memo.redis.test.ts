import { afterAll, expect, test } from "bun:test";
import { defineConfigKey } from "@platform/config";
import { closeRedis, getRedis } from "./client/connection";
import { sharedMemo } from "./memo";
import {
	REDIS_AVAILABLE,
	sweepNamespace,
	throwawayNamespace,
} from "./testing/real-server";

const t = test.skipIf(!REDIS_AVAILABLE);
const keys = throwawayNamespace();
const memo = sharedMemo(keys);

afterAll(async () => {
	await sweepNamespace(keys);
	await closeRedis();
});

t(
	"a written value round-trips with the moment it was written, under a key that expires",
	async () => {
		const before = Date.now();
		await memo.write("palette", { accent: "#123456" }, 30);
		const hit = await memo.read<{ accent: string }>("palette");
		expect(hit?.value).toEqual({ accent: "#123456" });
		expect(hit?.at).toBeGreaterThanOrEqual(before);
		expect(hit?.at).toBeLessThanOrEqual(Date.now());
		const redis = await getRedis();
		const ttl = (await redis?.send("PTTL", [
			keys.key("memo", "v1", "palette"),
		])) as number;
		expect(ttl).toBeGreaterThan(0);
		expect(ttl).toBeLessThanOrEqual(30_000);
	},
);

t(
	"null is a value: an origin that answered 'nothing configured' is shared as such",
	async () => {
		await memo.write("unset", null, 30);
		const hit = await memo.read("unset");
		expect(hit).not.toBeNull();
		expect(hit?.value).toBeNull();
	},
);

t("an envelope this build cannot read is a miss, not a crash", async () => {
	const redis = await getRedis();
	await redis?.set(keys.key("memo", "v1", "junk"), "not json", "EX", 30);
	await redis?.set(keys.key("memo", "v1", "bare"), '{"value":1}', "EX", 30);
	expect(await memo.read("junk")).toBeNull();
	expect(await memo.read("bare")).toBeNull();
});

t("drop removes the key", async () => {
	await memo.write("to-drop", 42, 30);
	expect(await memo.read("to-drop")).not.toBeNull();
	await memo.drop("to-drop");
	expect(await memo.read("to-drop")).toBeNull();
});

t(
	"a config key takes it as its shared cache: a second replica reads the fleet's answer, not the origin",
	async () => {
		const name = `${keys.prefix}-limits`;
		let reads = 0;
		const define = (read: () => Promise<unknown>) =>
			defineConfigKey<{ perDay: number }>({
				key: name,
				defaultValue: { perDay: 100 },
				parse: (stored, fallback) => {
					const doc = (stored ?? {}) as { perDay?: unknown };
					return Number.isInteger(doc.perDay)
						? { perDay: doc.perDay as number }
						: fallback;
				},
				ttlMs: 30_000,
				shared: memo,
				read,
			});
		const first = define(async () => {
			reads++;
			return { perDay: 7 };
		});
		expect(await first.read()).toEqual({ perDay: 7 });
		const second = define(async () => {
			throw new Error("the origin is not asked");
		});
		expect(await second.read()).toEqual({ perDay: 7 });
		expect(reads).toBe(1);
	},
);
