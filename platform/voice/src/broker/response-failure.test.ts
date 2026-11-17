import { expect, test } from "bun:test";
import { DEFAULT_VOICE_SETTINGS } from "../settings";
import { responseFailureOf, retryDecision } from "./response-failure";

const POLICY = DEFAULT_VOICE_SETTINGS.live.responseRetry;

test("a response that completed or was cancelled is no failure; one that failed or was cut short is, read as tokens only", () => {
	expect(responseFailureOf({ status: "completed" })).toBeNull();
	expect(responseFailureOf({ status: "cancelled" })).toBeNull();
	expect(responseFailureOf({})).toBeNull();
	expect(
		responseFailureOf({
			status: "failed",
			status_details: {
				type: "failed",
				error: {
					type: "server_error",
					code: "rate_limit_exceeded",
					message: "the words of the line it refused",
				},
			},
		}),
	).toEqual({
		status: "failed",
		reason: null,
		errorType: "server_error",
		errorCode: "rate_limit_exceeded",
		retryable: true,
	});
	// Prose where a token belongs is not carried.
	expect(
		responseFailureOf({
			status: "failed",
			status_details: { error: { type: "quoted: what was said" } },
		})?.errorType,
	).toBeNull();
});

test("asking again is for a rate limit, a fault of the service's, or a failure that said nothing; never a refused request, a filter or a response cut short", () => {
	const retryable = (details: unknown, status = "failed") =>
		responseFailureOf({ status, status_details: details })?.retryable;
	expect(retryable(undefined)).toBe(true);
	expect(retryable({ error: { type: "server_error" } })).toBe(true);
	expect(
		retryable({
			error: { type: "invalid_request_error", code: "rate_limit_exceeded" },
		}),
	).toBe(true);
	expect(
		retryable({ error: { type: "invalid_request_error", code: "x" } }),
	).toBe(false);
	expect(retryable({ reason: "content_filter" }, "failed")).toBe(false);
	expect(retryable({ reason: "max_output_tokens" }, "incomplete")).toBe(false);
	expect(retryable({ error: { type: "something_new" } })).toBe(false);
});

test("the asks back off, doubling with jitter, and are spent after the policy's attempts; an unfixable failure is only logged", () => {
	const failure = responseFailureOf({ status: "failed" });
	if (!failure) throw new Error("a failure");
	expect(retryDecision(failure, 0, POLICY, () => 0)).toEqual({
		action: "retry",
		attempt: 1,
		delayMs: 1_000,
	});
	expect(retryDecision(failure, 1, POLICY, () => 1)).toEqual({
		action: "retry",
		attempt: 2,
		delayMs: 2_500,
	});
	expect(retryDecision(failure, 2, POLICY)).toEqual({ action: "give_up" });
	const filtered = responseFailureOf({
		status: "incomplete",
		status_details: { reason: "content_filter" },
	});
	if (!filtered) throw new Error("a failure");
	expect(retryDecision(filtered, 0, POLICY)).toEqual({ action: "log" });
});
