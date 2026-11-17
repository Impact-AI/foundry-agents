import { afterAll, beforeAll, expect, test } from "bun:test";
import { closeRedis, getRedis } from "@platform/redis";
import { meteringKeys, resetMeteringKeyPrefix } from "../keys";
import {
	REDIS_AVAILABLE,
	sweepMeteringKeys,
	useThrowawayPrefix,
} from "../testing/real-server";
import {
	awaitCredits,
	peekCredits,
	refundCredits,
	spendCredits,
} from "./bucket";

/**
 * The bucket against a real server: its atomicity and its clock are what is
 * under test, and a fake would only prove the fake.
 */

const t = test.skipIf(!REDIS_AVAILABLE);
const key = (name: string) => meteringKeys().key("bucket", name);
// 0.1 credits a second: slow enough that refill during a test is noise.
const SLOW = 6;

beforeAll(() => useThrowawayPrefix());

afterAll(async () => {
	await sweepMeteringKeys();
	resetMeteringKeyPrefix();
	await closeRedis();
});

async function stored(k: string): Promise<number> {
	const redis = await getRedis();
	return Number(await redis?.hget(k, "t"));
}

t(
	"admits a burst up to capacity, then refuses with a retry hint, and the key expires",
	async () => {
		const k = key("burst");
		const policy = { capacity: 3, refillPerMinute: 60 };
		for (let i = 0; i < 3; i++) {
			expect((await spendCredits(k, policy)).allowed).toBe(true);
		}
		const fourth = await spendCredits(k, policy);
		expect(fourth.allowed).toBe(false);
		expect(fourth.retryAfterSeconds).toBeGreaterThanOrEqual(1);
		const redis = await getRedis();
		expect(await redis?.pttl(k)).toBeGreaterThan(0);
	},
);

t("buckets are independent per key", async () => {
	const policy = { capacity: 1, refillPerMinute: 60 };
	expect((await spendCredits(key("a"), policy)).allowed).toBe(true);
	expect((await spendCredits(key("b"), policy)).allowed).toBe(true);
});

t("refills over time", async () => {
	const k = key("refill");
	// 600/min is 10/sec: drained, then back within ~150ms.
	const policy = { capacity: 1, refillPerMinute: 600 };
	expect((await spendCredits(k, policy)).allowed).toBe(true);
	expect((await spendCredits(k, policy)).allowed).toBe(false);
	await Bun.sleep(200);
	expect((await spendCredits(k, policy)).allowed).toBe(true);
});

t(
	"a stamp from the future does not refill the bucket, and is repaired",
	async () => {
		const k = key("skew");
		const policy = { capacity: 2, refillPerMinute: SLOW };
		expect((await spendCredits(k, policy)).allowed).toBe(true);
		expect((await spendCredits(k, policy)).allowed).toBe(true);
		expect((await spendCredits(k, policy)).allowed).toBe(false);
		const redis = await getRedis();
		await redis?.hset(k, { ts: String(Date.now() + 3_600_000) });
		const afterSkew = await spendCredits(k, policy);
		expect(afterSkew.allowed).toBe(false);
		expect(afterSkew.retryAfterSeconds).toBeGreaterThanOrEqual(1);
		expect(Number(await redis?.hget(k, "ts"))).toBeLessThan(
			Date.now() + 60_000,
		);
	},
);

t(
	"a cost debits what it says, and is refused whole when it does not fit",
	async () => {
		const k = key("cost");
		const policy = { capacity: 10, refillPerMinute: SLOW };
		expect((await spendCredits(k, policy, 4)).allowed).toBe(true);
		expect((await spendCredits(k, policy, 4)).allowed).toBe(true);
		const tooBig = await spendCredits(k, policy, 3);
		expect(tooBig.allowed).toBe(false);
		expect(tooBig.retryAfterSeconds).toBeGreaterThanOrEqual(1);
		// The refusal cost nothing: exactly the remaining 2 are still there.
		expect((await spendCredits(k, policy, 2)).allowed).toBe(true);
		expect((await spendCredits(k, policy, 1)).allowed).toBe(false);
	},
);

t(
	"a cost of zero still spends a credit, and one above capacity empties the bucket",
	async () => {
		const zero = key("zero-cost");
		const policy = { capacity: 1, refillPerMinute: SLOW };
		expect((await spendCredits(zero, policy, 0)).allowed).toBe(true);
		expect((await spendCredits(zero, policy, 0)).allowed).toBe(false);
		const over = key("over-cost");
		const two = { capacity: 2, refillPerMinute: SLOW };
		expect((await spendCredits(over, two, 50)).allowed).toBe(true);
		expect((await spendCredits(over, two, 1)).allowed).toBe(false);
	},
);

t("a refund never persists more credits than the bucket holds", async () => {
	// Admissions would survive an unclamped refund (the refill line re-clamps),
	// so the stored count is the assertion that separates the two scripts.
	const k = key("refund-clamp");
	const policy = { capacity: 3, refillPerMinute: SLOW };
	expect((await spendCredits(k, policy)).allowed).toBe(true);
	await refundCredits(k, policy, 5);
	expect(await stored(k)).toBeLessThanOrEqual(3);
	expect(await stored(k)).toBeGreaterThan(2.9);
	for (let i = 0; i < 3; i++) {
		expect((await spendCredits(k, policy)).allowed).toBe(true);
	}
	expect((await spendCredits(k, policy)).allowed).toBe(false);
});

t(
	"a refund restores exactly what it returns; zero or negative moves nothing",
	async () => {
		const k = key("round-trip");
		const policy = { capacity: 10, refillPerMinute: SLOW };
		expect((await spendCredits(k, policy, 8)).allowed).toBe(true);
		expect((await spendCredits(k, policy, 8)).allowed).toBe(false);
		await refundCredits(k, policy, 6);
		await refundCredits(k, policy, 0);
		await refundCredits(k, policy, -5);
		expect((await spendCredits(k, policy, 8)).allowed).toBe(true);
		expect((await spendCredits(k, policy, 1)).allowed).toBe(false);
	},
);

t("a peek answers what a spend would, and writes nothing", async () => {
	const k = key("peek");
	const policy = { capacity: 2, refillPerMinute: SLOW };
	const redis = await getRedis();
	expect((await peekCredits(k, policy, 2)).allowed).toBe(true);
	// Asking created no state: no key, no expiry.
	expect(await redis?.exists(k)).toBe(false);
	expect((await spendCredits(k, policy)).allowed).toBe(true);
	const before = await stored(k);
	expect((await peekCredits(k, policy, 2)).allowed).toBe(false);
	expect((await peekCredits(k, policy, 1)).allowed).toBe(true);
	expect(await stored(k)).toBe(before);
});

t("concurrent callers cannot double-spend one bucket", async () => {
	// The one reason the arithmetic is in Lua: the read, the compare and the
	// write are one command, so no two callers both see the last credit.
	const k = key("stampede");
	const capacity = 25;
	const policy = { capacity, refillPerMinute: SLOW };
	const verdicts = await Promise.all(
		Array.from({ length: capacity + 20 }, () => spendCredits(k, policy)),
	);
	expect(verdicts.filter((v) => v.allowed).length).toBe(capacity);
	expect((await spendCredits(k, policy)).allowed).toBe(false);
});

t(
	"awaitCredits waits out a drained bucket, and answers false at once when waiting cannot succeed",
	async () => {
		const quick = key("await");
		const fast = { capacity: 1, refillPerMinute: 600 };
		expect((await spendCredits(quick, fast)).allowed).toBe(true);
		expect(await awaitCredits(quick, fast, 2_000)).toBe(true);

		const hopeless = key("await-hopeless");
		const slow = { capacity: 1, refillPerMinute: 1 };
		expect((await spendCredits(hopeless, slow)).allowed).toBe(true);
		const started = Date.now();
		expect(await awaitCredits(hopeless, slow, 500)).toBe(false);
		expect(Date.now() - started).toBeLessThan(400);
	},
);
