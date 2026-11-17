import {
	type ConfigKey,
	defineConfigKey,
	type LeafRule,
	mergeOverDefault,
	positiveInteger,
	processSingleton,
	type SharedCache,
	setSingleton,
} from "@platform/config";
import { DEFAULT_LIMITS, type Limits } from "./defaults";

/**
 * The limits document, as an operator tunes it in the store: during an abuse
 * incident a quota tightens inside the memo's TTL rather than in a deploy.
 * Read through `@platform/config`'s key, which serves the compiled-in default
 * until the store has answered and the last good value over a failed refresh.
 */

export const LIMITS_KEY = "limits";

const SINGLETON = "metering:limits";

/**
 * The leaves that must be whole. A session's ceiling and idle window become a
 * lock's `EX`, a record's `EXPIRE` and the `HINCRBY` a renewal adds to, and
 * Redis refuses a fraction in every one of them — so a stored 90.5 would
 * refuse or hang up every live session. The day and pool allowances and the
 * concurrent cap are counts of seconds and sessions, whole by meaning. Every
 * other number here is a credit amount the bucket's arithmetic takes as a
 * float, where a fraction (half a credit a minute) is a legitimate setting.
 */
const WHOLE: Record<string, LeafRule> = Object.fromEntries(
	[
		"realtime.maxSessionSeconds",
		"realtime.idleSeconds",
		"realtime.secondsPerDay",
		"realtime.concurrentSessions",
		"premium.maxSessionSeconds",
		"global.realtimeSecondsPerDay",
	].map((path) => [path, positiveInteger]),
);

/**
 * The stored document over the defaults; what was ignored is said once per
 * read, and so is a voice allowance too small to hold the one idle window a
 * session is charged upfront, which `chargeSeconds` refuses.
 */
export function limitsFromStored(
	stored: unknown,
	defaults: Limits = DEFAULT_LIMITS,
): Limits {
	const refused: string[] = [];
	const limits = mergeOverDefault(stored, defaults, { accept: WHOLE, refused });
	if (refused.length > 0) {
		console.error(
			`[metering] limits: ignoring ${refused.join(", ")} — each wants a finite positive number of the default's kind, a whole one for seconds and sessions; serving the default for each`,
		);
	}
	const window = limits.realtime.idleSeconds;
	const short = [
		["realtime.secondsPerDay", limits.realtime.secondsPerDay],
		["global.realtimeSecondsPerDay", limits.global.realtimeSecondsPerDay],
	].filter(([, seconds]) => (seconds as number) < window);
	if (short.length > 0) {
		console.error(
			`[metering] limits: ${short.map(([path]) => path).join(", ")} is below realtime.idleSeconds (${window}) — a session is charged one idle window upfront, so no live session is admitted`,
		);
	}
	return limits;
}

export interface LimitsOptions {
	/** The fleet's shared layer under the process memo, such as `sharedMemo` from `@platform/redis`. */
	shared?: SharedCache;
	ttlMs?: number;
	/** The origin read. For tests; defaults to the store. */
	read?: (key: string) => Promise<unknown>;
}

function define(options: LimitsOptions): ConfigKey<Limits> {
	return defineConfigKey<Limits>({
		key: LIMITS_KEY,
		defaultValue: DEFAULT_LIMITS,
		parse: limitsFromStored,
		ttlMs: options.ttlMs,
		shared: options.shared,
		read: options.read,
	});
}

function document(): ConfigKey<Limits> {
	return processSingleton(SINGLETON, () => define({}));
}

/** How the document is read. Once, at start-up, before the first gate runs. */
export function configureLimits(options: LimitsOptions): void {
	setSingleton(SINGLETON, define(options));
}

/** The current limits, refreshed when the memo has expired. Never throws. */
export function getLimits(): Promise<Limits> {
	return document().read();
}

/**
 * What the memo holds, for a caller that cannot await: the default before the
 * first read, which is the same answer an unreachable store gets. A caller on
 * a hot path awaits `getLimits` once and reads this after.
 */
export function cachedLimits(): Limits {
	return document().cached();
}

/** Expire the memo so the next read goes to the store. */
export function invalidateLimits(): void {
	document().invalidate();
}
