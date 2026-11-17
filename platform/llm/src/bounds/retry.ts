/**
 * A bounded retry budget for a model call, as middleware.
 *
 * One schedule for every model kind, applied at the model so no call site can
 * opt out of it. It is a budget, not a limiter: at most `maxRetries` further
 * attempts per call, each after a wait that doubles with full jitter, obeying a
 * `retry-after` the provider sends, and none of them outliving the request's
 * own abort signal. A provider that asks for a longer wait than the schedule
 * will take is not asked again sooner: the call fails with its error. What
 * is in flight at once is `concurrency`'s job.
 */
import { APICallError, type LanguageModelMiddleware } from "ai";

export interface RetrySchedule {
	/** Further attempts after the first. */
	maxRetries: number;
	/** Wait before the first retry, multiplied by the factor each time. */
	initialDelayMs: number;
	backoffFactor: number;
	/**
	 * The longest a provider's own `retry-after` is obeyed for. A deployment
	 * out of quota for the next hour says so, and parking a call there is worse
	 * than failing it; a wait asked for past this bound, and past the
	 * schedule's own, ends the call. Also the ceiling on the schedule's own
	 * wait, however far the factor has carried it.
	 */
	maxHonouredDelayMs: number;
}

/** The AI SDK's own schedule, so every kind of call waits the same way. */
export const DEFAULT_RETRY_SCHEDULE: RetrySchedule = {
	maxRetries: 3,
	initialDelayMs: 2_000,
	backoffFactor: 2,
	maxHonouredDelayMs: 60_000,
};

export interface RetryPolicy extends Partial<RetrySchedule> {
	/** The jitter's source, in `[0, 1)`. For tests. */
	random?: () => number;
}

/**
 * Whether an error is worth another attempt: the provider's own verdict, true
 * for 408, 409, 429, 5xx and a connection that never reached a status. A 400,
 * a 401 or a content filter is a fact about the request, and repeating it
 * spends the budget on an answer that cannot change.
 */
export function isRetryableModelError(error: unknown): boolean {
	return APICallError.isInstance(error) && error.isRetryable === true;
}

/**
 * The wait the provider asked for, when it asked and the ask is reasonable:
 * `retry-after-ms`, else `retry-after` in seconds or as an HTTP date. A wait
 * we would have taken anyway is always obeyed; a longer one only up to the cap.
 */
export function honouredRetryAfterMs(
	error: unknown,
	exponentialDelayMs: number,
	maxHonouredDelayMs: number = DEFAULT_RETRY_SCHEDULE.maxHonouredDelayMs,
): number | undefined {
	const ms = requestedRetryAfterMs(error);
	if (ms === undefined) return undefined;
	return ms <= maxHonouredDelayMs || ms < exponentialDelayMs ? ms : undefined;
}

/** The wait the provider's headers name, whatever its length; undefined when they name none. */
function requestedRetryAfterMs(error: unknown): number | undefined {
	const headers = APICallError.isInstance(error)
		? error.responseHeaders
		: undefined;
	if (!headers) return undefined;

	let ms: number | undefined;
	const afterMs = headers["retry-after-ms"];
	if (afterMs !== undefined) {
		const parsed = Number.parseFloat(afterMs);
		if (!Number.isNaN(parsed)) ms = parsed;
	}
	const after = headers["retry-after"];
	if (ms === undefined && after !== undefined) {
		const seconds = Number.parseFloat(after);
		ms = Number.isNaN(seconds)
			? Date.parse(after) - Date.now()
			: seconds * 1000;
	}

	return ms === undefined || Number.isNaN(ms) || ms < 0 ? undefined : ms;
}

/**
 * Full jitter: a uniform draw from `[0, delayMs]`. A hundred calls refused in
 * the same second and all retried two seconds later are the same burst again;
 * spreading each wait over its window is what makes it a retry.
 */
export function fullJitterMs(
	delayMs: number,
	random: () => number = Math.random,
): number {
	return Math.round(random() * delayMs);
}

/** The rejection the AI SDK's own delay raises, so one reader covers both. */
function abortError(): DOMException {
	return new DOMException("Delay was aborted", "AbortError");
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
	return new Promise((resolve, reject) => {
		if (signal?.aborted) {
			reject(abortError());
			return;
		}
		const onAbort = () => {
			clearTimeout(timer);
			reject(abortError());
		};
		const timer = setTimeout(() => {
			signal?.removeEventListener("abort", onAbort);
			resolve();
		}, ms);
		signal?.addEventListener("abort", onAbort, { once: true });
	});
}

/**
 * Run `attempt` until it succeeds, fails with something not worth retrying,
 * or the budget runs out, in which case the last error is rethrown as it
 * arrived: a caller's handling reads the provider's error, not a wrapper.
 */
export async function withRetries<T>(
	attempt: () => PromiseLike<T>,
	policy: RetryPolicy = {},
	signal?: AbortSignal,
): Promise<T> {
	// A field given as undefined is a field not given: it must not unset a bound.
	const schedule: RetrySchedule = { ...DEFAULT_RETRY_SCHEDULE };
	for (const field of Object.keys(schedule) as (keyof RetrySchedule)[]) {
		const given = policy[field];
		if (given !== undefined) schedule[field] = given;
	}
	let delayMs = schedule.initialDelayMs;

	for (let remaining = schedule.maxRetries; ; remaining--) {
		try {
			return await attempt();
		} catch (error) {
			if (remaining <= 0 || !isRetryableModelError(error)) throw error;
			// A failure that arrived after the caller aborted is not one to repeat.
			if (signal?.aborted) throw error;
			const honoured = honouredRetryAfterMs(
				error,
				delayMs,
				schedule.maxHonouredDelayMs,
			);
			// Asked to wait longer than this schedule will: an earlier attempt
			// is one the provider has already said it will refuse.
			if (honoured === undefined && requestedRetryAfterMs(error) !== undefined)
				throw error;
			await sleep(honoured ?? fullJitterMs(delayMs, policy.random), signal);
			delayMs = Math.min(
				delayMs * schedule.backoffFactor,
				schedule.maxHonouredDelayMs,
			);
		}
	}
}

/**
 * Both operations are safe to re-run because both reject only before the
 * caller has been handed anything. A failure after a stream has started
 * arrives as an `error` part inside it and is deliberately not retried, since
 * replaying a half-delivered answer would duplicate what was already read.
 */
export function modelRetryMiddleware(
	policy: RetryPolicy = {},
): LanguageModelMiddleware {
	return {
		wrapGenerate: ({ doGenerate, params }) =>
			withRetries(doGenerate, policy, params.abortSignal),
		wrapStream: ({ doStream, params }) =>
			withRetries(doStream, policy, params.abortSignal),
	};
}
