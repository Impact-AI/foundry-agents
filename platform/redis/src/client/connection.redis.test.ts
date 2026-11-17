import { afterAll, expect, test } from "bun:test";
import { REDIS_AVAILABLE } from "../testing/real-server";
import {
	assertRedisReachable,
	closeRedis,
	getRedis,
	redisAnswers,
} from "./connection";

const t = test.skipIf(!REDIS_AVAILABLE);

afterAll(async () => {
	await closeRedis();
});

t(
	"one dial serves every caller the same bounded client, and PING answers",
	async () => {
		const [a, b] = await Promise.all([getRedis(), getRedis()]);
		expect(a).not.toBeNull();
		expect(b).toBe(a);
		expect(await a?.ping()).toBe("PONG");
		expect(await redisAnswers()).toBe(true);
	},
);

t(
	"closeRedis drops the connection and the next call dials afresh",
	async () => {
		const before = await getRedis();
		await closeRedis();
		const after = await getRedis();
		expect(after).not.toBeNull();
		expect(after).not.toBe(before);
		expect(await after?.ping()).toBe("PONG");
	},
);

t("the startup assertion passes against a server that is there", async () => {
	await closeRedis();
	await expect(assertRedisReachable()).resolves.toBeUndefined();
	expect(await redisAnswers()).toBe(true);
});
