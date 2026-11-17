import type { Tier } from "@platform/identity/claims";
import { spendCredits } from "../credits/bucket";
import { rollingDay } from "../credits/script";
import { keys } from "../keys";
import { getLimits } from "../limits/document";
import { meteringProblems } from "../problems";
import type { UsageSubject } from "../subject";
import { isUnmetered } from "../tier";
import {
	type CallSurface,
	type RateLimitRefusal,
	rateLimitRefusal,
} from "./refusal";

/**
 * The gate every metered call goes through, so no two surfaces can drift.
 * The caller has already decided the request is billable — a runtime that
 * multiplexes housekeeping onto the same route decides that for itself.
 *
 * Burst first, then the day, so a refused burst does not also cost a credit
 * of the day; and the two in separate keys, because the script clamps a
 * bucket's stored count to whichever capacity it was last asked with, so two
 * policies on one key is one corrupted limiter. Never throws: an unreachable
 * Redis admits (see the bucket), an unreachable store serves the defaults.
 */

export type ChargeVerdict =
	| { ok: true }
	| { ok: false; refusal: RateLimitRefusal };

export interface ChargeOptions {
	/**
	 * Credits this call costs against the surface's burst bucket, when it is
	 * not the one the bucket is priced for: a session mint costs `mintCost`,
	 * and a renewal of a session already open costs one.
	 */
	burstCost?: number;
}

const ADMITTED: ChargeVerdict = { ok: true };

export async function meterCall(
	subject: UsageSubject,
	surface: CallSurface,
	tier: Tier,
	options: ChargeOptions = {},
): Promise<ChargeVerdict> {
	// Skipped, not widened: no bucket is read or written on this path.
	if (isUnmetered(tier)) return ADMITTED;
	const section = (await getLimits())[surface];
	if ("burst" in section) {
		const cost =
			options.burstCost ?? ("mintCost" in section ? section.mintCost : 1);
		const burst = await spendCredits(
			keys.burst(subject, surface),
			{ capacity: section.burst, refillPerMinute: section.refillPerMinute },
			cost,
		);
		if (!burst.allowed)
			return refused(surface, "burst", burst.retryAfterSeconds);
	}
	if ("perDay" in section) {
		const day = await spendCredits(
			keys.day(subject, surface),
			rollingDay(section.perDay),
		);
		if (!day.allowed) return refused(surface, "day", day.retryAfterSeconds);
	}
	return ADMITTED;
}

function refused(
	surface: CallSurface,
	bound: "burst" | "day",
	retryAfterSeconds: number,
): ChargeVerdict {
	const refusal = rateLimitRefusal(surface, retryAfterSeconds);
	meteringProblems.report("metering.call.rate_limited", {
		surface,
		bound,
		retryAfterSeconds: refusal.retryAfterSeconds,
	});
	return { ok: false, refusal };
}
