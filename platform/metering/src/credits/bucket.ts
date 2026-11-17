import { getRedis } from "@platform/redis";
import { reportUnavailable } from "../report";
import {
	type BucketMode,
	CREDIT_BUCKET,
	type CreditPolicy,
	type CreditVerdict,
	clampCost,
	clampRefund,
} from "./script";

/**
 * The one client of the bucket script. State lives in Redis and the
 * arithmetic in the script, so replicas cannot double-spend a credit between
 * a read and a write; what is here is the posture when Redis cannot answer.
 *
 * Fails open by default: a limiter is a cost bound, not an authorization
 * control, and turning a Redis blink into an outage for signed-in callers is
 * the worse trade. The authorization in front of every caller fails closed
 * on its own. `failClosed` is for a bound whose unmetered side is the thing
 * it exists to prevent; the refusal then carries a short wait, because the
 * honest answer to "the limiter is down" is "try again shortly", not "you
 * are over budget". A refund never fails closed — refusing to refund is not
 * a safer state — and a peek fails the way the spend it previews would.
 */

export interface SpendOptions {
	failClosed?: boolean;
}

/** What a fail-closed caller is told to wait: the outage it stands in for is measured in seconds. */
export const UNAVAILABLE_RETRY_SECONDS = 30;

const OPEN: CreditVerdict = { allowed: true, retryAfterSeconds: 0 };
const CLOSED: CreditVerdict = {
	allowed: false,
	retryAfterSeconds: UNAVAILABLE_RETRY_SECONDS,
};

/** Spend `cost` credits from `key`'s bucket. `cost` is clamped into [1, capacity]. */
export function spendCredits(
	key: string,
	policy: CreditPolicy,
	cost = 1,
	options: SpendOptions = {},
): Promise<CreditVerdict> {
	return run(key, policy, clampCost(cost, policy.capacity), "spend", options);
}

/** What `spendCredits` would answer for `cost`, without spending and without writing. */
export function peekCredits(
	key: string,
	policy: CreditPolicy,
	cost = 1,
	options: SpendOptions = {},
): Promise<CreditVerdict> {
	return run(key, policy, clampCost(cost, policy.capacity), "peek", options);
}

/**
 * Return `credits` to `key`'s bucket, for a debit taken upfront that turned
 * out larger than what was used. Never refused, and one lost to a Redis
 * blink costs the subject some budget, not the service its correctness.
 */
export async function refundCredits(
	key: string,
	policy: CreditPolicy,
	credits: number,
): Promise<void> {
	const amount = clampRefund(credits, policy.capacity);
	if (amount === 0) return;
	await run(key, policy, amount, "refund", {});
}

/**
 * Wait for a credit instead of being refused one, for a caller that has to
 * make the call and would rather queue behind the budget than fail. Polls
 * the bucket, sleeping its own retry hint between attempts, until a credit
 * is granted or `maxWaitMs` has passed. False means the deadline came first —
 * at once, when the hint already exceeds the time left. Without Redis this
 * inherits the fail-open answer and returns true immediately.
 */
export async function awaitCredits(
	key: string,
	policy: CreditPolicy,
	maxWaitMs: number,
): Promise<boolean> {
	const deadline = Date.now() + maxWaitMs;
	for (;;) {
		const verdict = await spendCredits(key, policy);
		if (verdict.allowed) return true;
		const waitMs = Math.max(1, verdict.retryAfterSeconds) * 1000;
		if (waitMs > deadline - Date.now()) return false;
		await new Promise((resolve) => setTimeout(resolve, waitMs));
	}
}

async function run(
	key: string,
	policy: CreditPolicy,
	amount: number,
	mode: BucketMode,
	options: SpendOptions,
): Promise<CreditVerdict> {
	const unavailable = options.failClosed && mode !== "refund" ? CLOSED : OPEN;
	// Null is "no Redis", already said once by the connection; a line per
	// request here would drown the one that matters.
	const redis = await getRedis();
	if (!redis) return unavailable;
	try {
		const reply: unknown = await redis.send("EVAL", [
			CREDIT_BUCKET,
			"1",
			key,
			String(policy.capacity),
			String(policy.refillPerMinute / 60),
			String(amount),
			mode,
		]);
		if (!Array.isArray(reply) || reply.length !== 2) {
			throw new Error(`bucket script answered ${JSON.stringify(reply)}`);
		}
		return {
			allowed: Number(reply[0]) === 1,
			retryAfterSeconds: Number(reply[1]),
		};
	} catch (err) {
		reportUnavailable(err);
		return unavailable;
	}
}
