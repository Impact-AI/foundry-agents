import type { Tier } from "@platform/identity/claims";

/**
 * Whether this package meters the caller at all.
 *
 * A premium account is bounded by nothing here: no allowance, no burst, no
 * seconds of its own. Every gate asks this first and admits without reading,
 * writing or reserving anything, and that is the whole mechanism — there is
 * no "unlimited" number anywhere, so no missing key, zero, negative or typo
 * in the store can be read as one. The only thing that lifts a bound is this
 * answering true, and the only thing that makes it true is a tier resolved
 * from the account at the point of use, never a session's snapshot.
 *
 * What premium gives up with the bounds is the burst breaker between a wedged
 * client holding a valid session and a very expensive afternoon; the
 * provider's own refusal is the ceiling that remains. What it still meets is
 * scarcity rather than spend — the shared pool, the one-session lock, the
 * idle reclaim and a finite deadline — each argued where it is applied.
 */
export function isUnmetered(tier: Tier): boolean {
	return tier === "premium";
}
