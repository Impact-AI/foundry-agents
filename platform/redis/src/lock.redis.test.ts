import { afterAll, expect, test } from "bun:test";
import { closeRedis } from "./client/connection";
import { withLock } from "./lock";
import {
	REDIS_AVAILABLE,
	sweepNamespace,
	throwawayNamespace,
} from "./testing/real-server";

const t = test.skipIf(!REDIS_AVAILABLE);
const keys = throwawayNamespace();
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

afterAll(async () => {
	await sweepNamespace(keys);
	await closeRedis();
});

t(
	"two replicas arriving together: one runs, the other is told the lock is held; after the release the next wins",
	async () => {
		const options = {
			key: keys.key("lock", "sweeper"),
			ttlMs: 10_000,
			whenUnavailable: "skip" as const,
		};
		let running = 0;
		let peak = 0;
		const work = async () => {
			running++;
			peak = Math.max(peak, running);
			await sleep(100);
			running--;
			return "done";
		};
		const [a, b] = await Promise.all([
			withLock(options, work),
			withLock(options, work),
		]);
		expect([a, b].filter((o) => o.ran)).toHaveLength(1);
		expect([a, b].filter((o) => !o.ran && o.reason === "held")).toHaveLength(1);
		expect(peak).toBe(1);
		expect(await withLock(options, work)).toEqual({ ran: true, value: "done" });
	},
);

t(
	"a throw from fn propagates, and the lock is released on the way",
	async () => {
		const options = {
			key: keys.key("lock", "faulty"),
			ttlMs: 10_000,
			whenUnavailable: "skip" as const,
		};
		await expect(
			withLock(options, async () => {
				throw new Error("boom");
			}),
		).rejects.toThrow("boom");
		expect(await withLock(options, async () => 1)).toEqual({
			ran: true,
			value: 1,
		});
	},
);

t(
	"a lock that outlives its TTL is taken elsewhere, and the first holder's release leaves it alone",
	async () => {
		const key = keys.key("lock", "slow");
		const slow = withLock(
			{ key, ttlMs: 100, whenUnavailable: "skip" },
			async () => {
				await sleep(250);
				return "first";
			},
		);
		await sleep(150);
		const second = withLock(
			{ key, ttlMs: 10_000, whenUnavailable: "skip" },
			async () => {
				await sleep(250);
				return "second";
			},
		);
		expect(await slow).toEqual({ ran: true, value: "first" });
		// The first run has finished and released, with the second still inside.
		expect(
			await withLock(
				{ key, ttlMs: 10_000, whenUnavailable: "skip" },
				async () => 3,
			),
		).toEqual({ ran: false, reason: "held" });
		expect(await second).toEqual({ ran: true, value: "second" });
	},
);
