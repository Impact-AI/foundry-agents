import type { Tier } from "@platform/identity/claims";
import type { Limits } from "../limits/defaults";
import { isUnmetered } from "../tier";

/** The two numbers a session is minted with. */
export interface SessionBounds {
	/** The absolute ceiling, a hangup deadline: `premium.maxSessionSeconds` for an unmetered tier. */
	maxSessionSeconds: number;
	/** The first window charged, and what each renewal buys: `realtime.idleSeconds`, never over the ceiling. */
	idleSeconds: number;
}

/**
 * What a session on `tier` runs within. One idle window for every tier,
 * premium included — it is not an allowance but the hold on a concurrent
 * slot, which an unmetered account does not create more of. The ceiling is
 * the one number premium carries, replaced rather than removed, because the
 * ledger derives the record's hard deadline, the sweeper's cutoff and the
 * lock's TTL from it.
 */
export function sessionBounds(limits: Limits, tier: Tier): SessionBounds {
	const maxSessionSeconds = isUnmetered(tier)
		? limits.premium.maxSessionSeconds
		: limits.realtime.maxSessionSeconds;
	return {
		maxSessionSeconds,
		idleSeconds: Math.min(limits.realtime.idleSeconds, maxSessionSeconds),
	};
}
