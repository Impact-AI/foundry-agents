import { afterAll, beforeAll, expect, test } from "bun:test";
import { scopedEnv } from "@platform/test-support";
import { closeRedis } from "./client/connection";
import { withLock } from "./lock";

/** Without Redis the lock is the caller's own answer, and it is spelled out. */

let restore: () => void;

beforeAll(() => {
	restore = scopedEnv({ REDIS_URL: undefined });
});

afterAll(async () => {
	await closeRedis();
	restore();
});

test("'run' runs unlocked, 'skip' reports why it did not", async () => {
	let runs = 0;
	const ran = await withLock(
		{ key: "svc:lock:sweeper", ttlMs: 1000, whenUnavailable: "run" },
		async () => ++runs,
	);
	expect(ran).toEqual({ ran: true, value: 1 });
	const skipped = await withLock(
		{ key: "svc:lock:sweeper", ttlMs: 1000, whenUnavailable: "skip" },
		async () => ++runs,
	);
	expect(skipped).toEqual({ ran: false, reason: "unavailable" });
	expect(runs).toBe(1);
});

test("a TTL that bounds nothing is refused", async () => {
	await expect(
		withLock(
			{ key: "svc:lock:sweeper", ttlMs: 0, whenUnavailable: "run" },
			async () => 1,
		),
	).rejects.toThrow(RangeError);
});
