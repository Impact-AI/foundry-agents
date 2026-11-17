import { envInt, throttledReport } from "@platform/config";

/**
 * What this package says about itself on the console: a sweep's cutoff, and
 * the bucket being unable to answer. A refusal goes on the problem channel
 * instead (see ./problems). No subject ever appears on a line — a bucket key
 * is an account id, and a log is not where one goes.
 */

/**
 * The sweeper ended a session. The opaque id, never the provider's handle or
 * the subject; `lateMs` is how far past its deadline the cutoff landed.
 */
export function reportHangup(fields: {
	session: string;
	status: number;
	lateMs: number;
}): void {
	console.log(`[metering] session ended at its deadline`, fields);
}

export const DEFAULT_UNAVAILABLE_LOG_SECONDS = 60;

/**
 * The bucket could not be asked and the request was answered by its
 * fallback. One line per `METERING_UNAVAILABLE_LOG_SECONDS` (zero prints
 * one per request), carrying the count it suppressed.
 */
export const reportUnavailable = throttledReport("metering", "unavailable", {
	line: (count) =>
		`bucket unavailable; ${count} request(s) answered by their fallback since the last line`,
	everyMs: () =>
		envInt(
			"METERING_UNAVAILABLE_LOG_SECONDS",
			DEFAULT_UNAVAILABLE_LOG_SECONDS,
			{
				min: 0,
			},
		) * 1000,
});

/** Forget what has been reported so far. For tests. */
export function resetUnavailableReporting(): void {
	reportUnavailable.reset();
}
