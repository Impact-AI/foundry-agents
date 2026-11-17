import type { Limits } from "../limits/defaults";

/**
 * A surface a request may be charged on: every section of the limits
 * document that bounds calls, by name. `premium` and `global` are not
 * surfaces; they are read by the ledger.
 */
export type CallSurface = Exclude<keyof Limits, "premium" | "global">;

/**
 * The one shape every refusal here takes: a code, never a sentence — the
 * client's own catalogue carries the words, in its reader's language. The
 * wait repeats the header because a client behind a streaming runtime sees
 * the status and the parsed body of a refused run and never its headers.
 * There is deliberately no remaining-budget readout: the person sees a
 * message, not a meter.
 */
export interface RateLimitRefusal {
	code: "rate_limited";
	surface: CallSurface;
	retryAfterSeconds: number;
	/**
	 * Set when what ran out was shared rather than this subject's own
	 * allowance — the deployment's pool — which wants a different sentence,
	 * because "you have had your share" is untrue of somebody who spent
	 * nothing.
	 */
	pool?: true;
}

export function rateLimitRefusal(
	surface: CallSurface,
	retryAfterSeconds: number,
	options: { pool?: boolean } = {},
): RateLimitRefusal {
	return {
		code: "rate_limited",
		surface,
		retryAfterSeconds: Math.max(1, Math.ceil(retryAfterSeconds)),
		...(options.pool ? { pool: true } : {}),
	};
}

/** The refusal as a 429: the body is the refusal, with `Retry-After` beside it. */
export function rateLimitedResponse(refusal: RateLimitRefusal): Response {
	return Response.json(refusal, {
		status: 429,
		headers: {
			"Retry-After": String(refusal.retryAfterSeconds),
			"Cache-Control": "no-store",
		},
	});
}
