import { type RateLimitRefusal, rateLimitedResponse } from "@platform/metering";

/**
 * Every answer that is not the thing asked for, as a code and never a
 * sentence: the client's catalogue carries the words, in its reader's
 * language. An allowance refusal is `@platform/metering`'s own shape with
 * the session's reason beside it, so a client that renders a 429 already
 * renders these; everything else is `refused` with a reason.
 */

type LiveRefusalReason =
	| "allowance"
	| "pool"
	| "capacity"
	| "busy"
	| "unavailable"
	| "unconfigured";

export type LiveRefusal =
	| (RateLimitRefusal & { reason: "allowance" | "pool" })
	| {
			code: "refused";
			surface: "realtime";
			reason: Exclude<LiveRefusalReason, "allowance" | "pool">;
			retryAfterSeconds?: number;
	  };

const NO_STORE = { "Cache-Control": "no-store" };

function withRetry(seconds: number | undefined): Record<string, string> {
	return seconds === undefined
		? NO_STORE
		: { ...NO_STORE, "Retry-After": String(Math.max(1, Math.ceil(seconds))) };
}

export function liveRefusedResponse(refusal: LiveRefusal): Response {
	if (refusal.code === "rate_limited") return rateLimitedResponse(refusal);
	// Busy is a conflict with the subject's own open session; the rest are the service short of something.
	const status = refusal.reason === "busy" ? 409 : 503;
	// Unconfigured carries no wait: a voice agent appears with a deploy, not a minute.
	const headers =
		refusal.reason === "unconfigured"
			? NO_STORE
			: withRetry(refusal.retryAfterSeconds);
	return Response.json(refusal, { status, headers });
}

/**
 * A fault of the service, as a code: the session could not be opened
 * (`handshake_failed`), or the service refused the session's own settings
 * and would answer nothing (`settings_refused`).
 */
export function faultResponse(
	fault: "handshake_failed" | "settings_refused",
): Response {
	return Response.json({ code: fault }, { status: 502, headers: NO_STORE });
}
