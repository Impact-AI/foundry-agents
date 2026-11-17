import { getRedis } from "@platform/redis";
import { keys } from "../keys";
import { getLimits } from "../limits/document";
import { reportUnavailable } from "../report";
import type { UsageSubject } from "../subject";

/**
 * The two questions asked before a handshake spends anything: is this
 * subject already live, and does the deployment have a slot free. Both read,
 * neither decides — the lock is taken inside the record, and the provider
 * enforces its own cap — and both admit when they cannot answer, because the
 * record behind them fails closed and refusing twice is no safer.
 */

/** Whether `subject` has a session on the books, for the price of an EXISTS rather than a mint. */
export async function isSubjectLive(subject: UsageSubject): Promise<boolean> {
	const redis = await getRedis();
	if (!redis) return false;
	try {
		return await redis.exists(keys.lock(subject));
	} catch (err) {
		reportUnavailable(err);
		return false;
	}
}

/**
 * How many sessions hold a slot right now: those on the deadline set whose
 * deadline has not passed. A session the sweeper has not yet taken is not
 * counted once its deadline is behind `now`, so a settle that never ran costs
 * memory and never a refusal. Null is "could not be asked", which is not zero.
 */
export async function liveSessionCount(
	now = Date.now(),
): Promise<number | null> {
	const redis = await getRedis();
	if (!redis) return null;
	try {
		return await redis.zcount(keys.deadlines(), now, "+inf");
	} catch (err) {
		reportUnavailable(err);
		return null;
	}
}

export type CapacityVerdict =
	| { full: false; live: number | null; capacity: number }
	| { full: true; live: number; capacity: number; retryAfterSeconds: number };

/**
 * Whether the deployment has room for one more session, against the
 * configured concurrent-session cap. Asked before the seconds are charged,
 * so a refusal spends nothing and needs no refund. The provider's own
 * refusal of the next session is deliberately not fed back into the cap: the
 * provider answers 429 for throughput as well, and a ceiling that moved
 * itself on an ambiguous signal would clamp live voice to whatever happened
 * to be open at that instant. An operator moves the number, from the report.
 */
export async function liveCapacity(now = Date.now()): Promise<CapacityVerdict> {
	const capacity = (await getLimits()).realtime.concurrentSessions;
	const live = await liveSessionCount(now);
	if (live !== null && live >= capacity) {
		return {
			full: true,
			live,
			capacity,
			retryAfterSeconds: capacityRetrySeconds(),
		};
	}
	return { full: false, live, capacity };
}

/**
 * How long a caller refused for want of a slot might wait. Jittered, because
 * everybody refused inside one busy minute is waiting on the same handful of
 * slots, and one number for all of them synchronises their retries into a
 * burst that is refused together again.
 */
export function capacityRetrySeconds(): number {
	return 30 + Math.floor(Math.random() * 30);
}
