import { expect, test } from "bun:test";
import { readTurnRefusal, wasBlocked } from "./turn-refusal";

/** What CopilotKit reports for a run that ended with `RUN_ERROR`: the event's message, its code copied on. */
function runError(code: string): Error {
	return Object.assign(new Error(code), { code });
}

test("a run the content filter refused is told apart by its code alone, and is no allowance refusal", () => {
	expect(wasBlocked(runError("turn.blocked"))).toBe(true);
	expect(readTurnRefusal(runError("turn.blocked"))).toBeNull();
	for (const other of [
		runError("turn.failed"),
		new Error("HTTP 429: {}"),
		null,
		"turn.blocked",
	])
		expect(wasBlocked(other)).toBe(false);
});

test("a refusal the agent answered before running is read from its status, with the wait", () => {
	expect(
		readTurnRefusal(
			Object.assign(new Error("HTTP 429"), {
				status: 429,
				payload: { code: "turn.rate_limited", retryAfterSeconds: 7 },
			}),
		),
	).toEqual({ code: "rate_limited", retryAfter: 7 });
});

test("a typed turn refused while the voice channel still holds the thread is named, not reported as an answer cut off", () => {
	expect(
		readTurnRefusal(
			Object.assign(new Error("HTTP 409"), {
				status: 409,
				payload: { code: "thread.busy" },
			}),
		),
	).toEqual({ code: "refused_busy", retryAfter: 60 });
	expect(readTurnRefusal(new Error("HTTP 409: {}"))).toEqual({
		code: "refused_busy",
		retryAfter: 60,
	});
});
