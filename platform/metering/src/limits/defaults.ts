/**
 * The compiled-in limits: what a bare checkout runs, and what a missing or
 * broken store falls back to. Never unlimited and never zero.
 *
 * One section per metered surface, holding every bound on that surface so
 * the two are tuned side by side: `perDay` is a rolling daily allowance that
 * refills continuously at a 1440th of itself a minute (no reset, nothing to
 * stampede at midnight), and `burst` / `refillPerMinute` are the per-minute
 * bucket — burst is abuse, day is cost. A credit is one call; realtime is
 * metered in seconds instead, because a session's cost is its length.
 *
 * The `Limits` type is derived from this object, and the merge walks its
 * shape: a leaf added here is a leaf the store can tune and the gates can
 * reach, with nothing to keep in step by hand.
 */
export const DEFAULT_LIMITS = {
	chat: { perDay: 200 },
	/** A reply is synthesised a sentence at a time, so a small multiple of stt. */
	tts: { perDay: 400, burst: 30, refillPerMinute: 60 },
	/** One transcription per spoken turn; a burst absorbs a flurry of short ones. */
	stt: { perDay: 400, burst: 12, refillPerMinute: 30 },
	/**
	 * One chat turn can run several web searches, each billed on its own, so
	 * they are charged per search on top of the turn's `chat` credit.
	 */
	toolSearch: { burst: 6, refillPerMinute: 12 },
	/** Pictures read from the deployment's store: every result names one, so the day bounds the harvest. */
	media: { perDay: 2000 },
	/** A live session's turns written back into memory: bounds on a record, not a price. */
	transcript: { perDay: 3000, burst: 30, refillPerMinute: 60 },
	realtime: {
		/** A mint costs ten, not one: the session behind it bills minutes of audio. */
		burst: 30,
		refillPerMinute: 30,
		mintCost: 10,
		/**
		 * The absolute ceiling on one session, a backstop rather than the clock a
		 * conversation runs against. What ends an ordinary session is
		 * `idleSeconds`; this only stops a renewal loop running for ever.
		 */
		maxSessionSeconds: 1800,
		/**
		 * How long nobody may speak before the session is reclaimed, and the
		 * window each renewal buys. One number for every tier: it is not an
		 * allowance but the hold on a concurrent slot, which premium does not
		 * create more of.
		 */
		idleSeconds: 120,
		/** The seconds a base account may talk in a rolling day. */
		secondsPerDay: 1800,
		/**
		 * The provider deployment's concurrent-session cap, written down so the
		 * next caller is refused before a mint rather than by the provider after
		 * one. An operator's number: nothing here can discover it.
		 */
		concurrentSessions: 10,
	},
	/**
	 * The one number premium carries, and it is a hangup deadline rather than an
	 * allowance: the ledger derives a record's hard ceiling, the sweeper's cutoff
	 * and the lock's TTL from it, so a session without one has no deadline, no
	 * sweeper and a lock that never frees.
	 */
	premium: { maxSessionSeconds: 3600 },
	/** The deployment's realtime seconds for a rolling day, drawn on by every tier. */
	global: { realtimeSecondsPerDay: 72000 },
};

export type Limits = typeof DEFAULT_LIMITS;
