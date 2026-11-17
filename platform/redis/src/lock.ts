import { claimOnce, releaseClaim } from "./claim";

export interface LockOptions {
	key: string;
	/**
	 * Bounds `fn`. The lock is released when `fn` settles and expires on its
	 * own if the replica dies, which is also what happens if `fn` outlives it,
	 * so size it to the slowest run, not the usual one.
	 */
	ttlMs: number;
	/**
	 * The caller's own answer for a process without Redis: a sweeper on a
	 * single replica runs, a job that must never run twice skips.
	 */
	whenUnavailable: "run" | "skip";
}

export type LockOutcome<T> =
	| { ran: true; value: T }
	| { ran: false; reason: "held" | "unavailable" };

/**
 * Run `fn` on at most one replica at a time, while Redis answers. With
 * `whenUnavailable: "run"`, a claim whose answer never came runs `fn`
 * uncoordinated, possibly beside a holder: that choice is for work that is
 * safe to do twice. A throw from `fn` propagates, after the release.
 */
export async function withLock<T>(
	{ key, ttlMs, whenUnavailable }: LockOptions,
	fn: () => Promise<T>,
): Promise<LockOutcome<T>> {
	const token = `${process.pid}-${crypto.randomUUID()}`;
	const claim = await claimOnce(key, token, ttlMs);
	if (claim.outcome === "held") return { ran: false, reason: "held" };
	if (claim.outcome === "unavailable") {
		if (whenUnavailable === "skip")
			return { ran: false, reason: "unavailable" };
		return { ran: true, value: await fn() };
	}
	try {
		return { ran: true, value: await fn() };
	} finally {
		await releaseClaim(key, token);
	}
}
