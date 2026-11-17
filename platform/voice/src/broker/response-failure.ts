/**
 * A live response that ended without finishing, and what the owner does
 * about it. After a tool's answer the follow-up response can open and close
 * within a fraction of a second with no output: `response.done` with
 * `status: "failed"`. The person has heard a filler ("Let me check.") and
 * then nothing, for good, unless somebody asks again. Known from how the
 * service behaves; the likeliest cause is the realtime deployment's rate
 * limit under concurrency, which is why every failure is logged with its
 * `status_details.error` type and code.
 *
 * Only tokens are read from a failure — the type, the code, the reason —
 * never its message, which can quote what was refused.
 */

/** How a failed response is asked again: the `voice` document's `live.responseRetry`. */
export interface ResponseRetryPolicy {
	/** Asks after the first failure, before the voice is told to say it could not answer. */
	attempts: number;
	/** The first wait, doubled for each further attempt. */
	backoffMs: number;
	/** Up to this much is added at random to each wait, so sessions refused together do not come back together. */
	jitterMs: number;
}

/** What a `response.done` that did not finish says about itself. */
export interface ResponseFailure {
	/** `failed`, or `incomplete`: a response that ran and was cut short. */
	status: "failed" | "incomplete";
	/** `status_details.reason`: `content_filter`, `max_output_tokens`, … */
	reason: string | null;
	/** `status_details.error.type`: `server_error`, `invalid_request_error`, … */
	errorType: string | null;
	/** `status_details.error.code`: `rate_limit_exceeded`, … */
	errorCode: string | null;
	/** Whether asking again could plausibly get an answer. */
	retryable: boolean;
}

/** A provider token, or null: never prose. */
const TOKEN = /^[A-Za-z0-9_.:-]{1,64}$/;
function token(value: unknown): string | null {
	return typeof value === "string" && TOKEN.test(value) ? value : null;
}

/**
 * Worth asking again for: a rate limit, a fault of the service's, or a
 * failure that said nothing at all. Never a refusal of the request
 * (`invalid_request_error`), a content filter or a policy — asking again gets
 * the same answer — and never `incomplete`, a response that ran and was cut.
 */
function isRetryable(failure: Omit<ResponseFailure, "retryable">): boolean {
	if (failure.status !== "failed") return false;
	const words = [failure.reason, failure.errorType, failure.errorCode]
		.filter((word): word is string => word !== null)
		.map((word) => word.toLowerCase());
	if (!words.length) return true;
	if (words.some((w) => w.includes("rate_limit") || w.includes("too_many")))
		return true;
	if (
		words.some(
			(w) =>
				w.includes("content_filter") ||
				w.includes("policy") ||
				w.includes("invalid"),
		)
	)
		return false;
	return words.some(
		(w) =>
			w.includes("server_error") ||
			w.includes("internal") ||
			w.includes("overloaded") ||
			w.includes("unavailable") ||
			w.includes("timeout"),
	);
}

/**
 * The failure a `response.done`'s response reports, or null for one that
 * completed, was cancelled (a barge-in: never a failure) or said nothing of
 * its status.
 */
export function responseFailureOf(response: {
	status?: string;
	status_details?: unknown;
}): ResponseFailure | null {
	const { status } = response;
	if (status !== "failed" && status !== "incomplete") return null;
	const details = (response.status_details ?? {}) as {
		reason?: unknown;
		error?: { type?: unknown; code?: unknown } | null;
	};
	const base = {
		status,
		reason: token(details.reason),
		errorType: token(details.error?.type),
		errorCode: token(details.error?.code),
	} as const;
	return { ...base, retryable: isRetryable(base) };
}

/** What the owner does next about one failure. */
export type RetryDecision =
	| { action: "retry"; attempt: number; delayMs: number }
	| { action: "give_up" }
	| { action: "log" };

/**
 * One failure, given how many asks this turn has already made: `retry`
 * after `delayMs` (attempts numbered from 1), `give_up` once the policy is
 * spent, or `log` for a failure asking again would not fix.
 */
export function retryDecision(
	failure: ResponseFailure,
	attemptsMade: number,
	policy: ResponseRetryPolicy,
	random: () => number = Math.random,
): RetryDecision {
	if (!failure.retryable) return { action: "log" };
	if (attemptsMade >= policy.attempts) return { action: "give_up" };
	const attempt = attemptsMade + 1;
	return {
		action: "retry",
		attempt,
		delayMs: Math.round(
			policy.backoffMs * 2 ** (attempt - 1) +
				Math.max(0, Math.min(1, random())) * policy.jitterMs,
		),
	};
}

/**
 * The note the voice is handed once the last ask has failed too, so it says
 * so rather than leaving a filler hanging. Sent as a system item before one
 * `response.create`. English, like every other instruction the session
 * holds: the language directive is what it answers in, and the note says so.
 */
export const UNANSWERED_NOTE =
	"Your last answer could not be generated: the voice service did not respond. In one short sentence, in the language you have been speaking, tell the person you couldn't get that just now and ask them to try again. Do not guess at the answer.";
