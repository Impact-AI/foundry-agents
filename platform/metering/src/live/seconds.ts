import type { Tier } from "@platform/identity/claims";
import { redisAnswers } from "@platform/redis";
import {
	refundCredits,
	spendCredits,
	UNAVAILABLE_RETRY_SECONDS,
} from "../credits/bucket";
import { rollingDay } from "../credits/script";
import { keys } from "../keys";
import { getLimits } from "../limits/document";
import { meteringProblems } from "../problems";
import type { UsageSubject } from "../subject";
import { type RateLimitRefusal, rateLimitRefusal } from "../surfaces/refusal";
import { isUnmetered } from "../tier";

/**
 * Seconds of realtime, charged upfront and refunded on settle. Every subject
 * draws on two buckets — its own day, then the pool the deployment shares —
 * with the first put back if the second refuses, so a refused handshake
 * leaves both as they were. Sign-in is open, so a per-account bound bounds
 * nothing on its own; the pool is what caps the day's spend.
 */

/**
 * The one line about premium still open. An unmetered account draws no day
 * of its own, but the pool is not per-account rate limiting: it is the
 * deployment's voice budget, and unlimited per-account voice does not create
 * capacity, it only decides who gets to hold it. False here would let a few
 * long premium calls drain the day out from under everyone else.
 */
export const PREMIUM_DRAWS_SHARED_POOL = true;

/** What a refusal no refill can lift asks the caller to wait: the limits are re-read long before. */
const SECONDS_PER_DAY = 86_400;

export type SecondsVerdict =
	/** `ownDay`: whether the subject's own day was drawn on, which is what a refund may put back. */
	| { ok: true; ownDay: boolean }
	| { ok: false; reason: "allowance" | "pool"; refusal: RateLimitRefusal }
	| { ok: false; reason: "unavailable"; retryAfterSeconds: number };

/**
 * Debit `seconds` from `subject`'s day and from the pool. Never throws, and
 * never refuses an account on infrastructure trouble — except before a
 * handshake, where it first asks whether Redis answers at all: the charges
 * fail open but the record that follows fails closed, so without this an
 * outage would admit the charge, let the caller mint a real, billable
 * session, and then refuse to write it down. One PING turns that into a
 * refusal that mints nothing. A renewal has no record to write and skips
 * the question.
 *
 * An allowance smaller than the seconds asked for refuses: the bucket would
 * otherwise take what it holds, and the settlement, which refunds the unused
 * part of what was asked for, would hand back more than was taken. So a day
 * or a pool set below one idle window admits no session at all.
 */
export async function chargeSeconds(
	subject: UsageSubject,
	seconds: number,
	tier: Tier,
	purpose: "handshake" | "renewal" = "handshake",
): Promise<SecondsVerdict> {
	const unmetered = isUnmetered(tier);
	if (purpose === "handshake" && !(await redisAnswers())) {
		return {
			ok: false,
			reason: "unavailable",
			retryAfterSeconds: UNAVAILABLE_RETRY_SECONDS,
		};
	}
	const limits = await getLimits();
	if (!unmetered && seconds > limits.realtime.secondsPerDay)
		return refused("allowance", SECONDS_PER_DAY);
	const drawsPool = !unmetered || PREMIUM_DRAWS_SHARED_POOL;
	if (drawsPool && seconds > limits.global.realtimeSecondsPerDay)
		return refused("pool", SECONDS_PER_DAY);
	if (!unmetered) {
		const own = await spendCredits(
			keys.seconds(subject),
			rollingDay(limits.realtime.secondsPerDay),
			seconds,
		);
		if (!own.allowed) return refused("allowance", own.retryAfterSeconds);
	}
	const ownDay = !unmetered;
	if (unmetered && !PREMIUM_DRAWS_SHARED_POOL) return { ok: true, ownDay };
	const pool = await spendCredits(
		keys.pool(),
		rollingDay(limits.global.realtimeSecondsPerDay),
		seconds,
	);
	if (pool.allowed) return { ok: true, ownDay };
	// Only what was taken goes back; premium debited nothing of its own.
	if (ownDay) {
		await refundCredits(
			keys.seconds(subject),
			rollingDay(limits.realtime.secondsPerDay),
			seconds,
		);
	}
	return refused("pool", pool.retryAfterSeconds);
}

/**
 * Return `seconds` to the pool, and to the subject's own day only when the
 * charge being undone drew on it (`ownDay`, as the charge answered). An
 * unmetered session never debited its own day, and refunding into one that a
 * base-tier session of the same account had spent would hand those seconds
 * back for free. Not the tier now: a tier changed mid-session must not
 * decide what an earlier charge took.
 */
export async function refundSeconds(
	subject: UsageSubject,
	seconds: number,
	ownDay: boolean,
): Promise<void> {
	const limits = await getLimits();
	if (ownDay) {
		await refundCredits(
			keys.seconds(subject),
			rollingDay(limits.realtime.secondsPerDay),
			seconds,
		);
	}
	await refundCredits(
		keys.pool(),
		rollingDay(limits.global.realtimeSecondsPerDay),
		seconds,
	);
}

function refused(
	reason: "allowance" | "pool",
	retryAfterSeconds: number,
): SecondsVerdict {
	const refusal = rateLimitRefusal("realtime", retryAfterSeconds, {
		pool: reason === "pool",
	});
	meteringProblems.report("metering.seconds.refused", {
		surface: "realtime",
		bound: reason,
		retryAfterSeconds: refusal.retryAfterSeconds,
	});
	return { ok: false, reason, refusal };
}
