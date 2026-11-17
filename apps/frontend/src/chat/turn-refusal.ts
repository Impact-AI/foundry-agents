import { type ErrorCode, errorCodeOf, retryAfterSeconds } from "../errors";

/**
 * What a failed run was refused for, read off the error CopilotKit reports.
 * A refusal carries a status and a body when the agent client described it;
 * when only a message survived, the status is read out of the message so a
 * 429 still says "allowance" rather than "something went wrong".
 */
export interface TurnRefusal {
	code: ErrorCode;
	retryAfter: number;
}

/**
 * Whether the run ended because the content filter refused it: the agent's
 * `RUN_ERROR` says so in its code and in nothing else, and the person is
 * told only that, never what tripped it.
 */
export function wasBlocked(error: unknown): boolean {
	return (
		typeof error === "object" &&
		error !== null &&
		(error as { code?: unknown }).code === "turn.blocked"
	);
}

export function readTurnRefusal(error: unknown): TurnRefusal | null {
	if (typeof error !== "object" || error === null) return null;
	const failed = error as {
		status?: unknown;
		payload?: unknown;
		message?: unknown;
	};
	let status = typeof failed.status === "number" ? failed.status : null;
	if (status === null && typeof failed.message === "string") {
		const m = /\b(401|403|409|429|503)\b/.exec(failed.message);
		status = m ? Number(m[1]) : null;
	}
	if (status === null) return null;
	const payload = (failed.payload ?? {}) as {
		code?: unknown;
		error?: unknown;
		pool?: unknown;
		retryAfterSeconds?: unknown;
	};
	const body = {
		code: payload.code ?? payload.error,
		pool: payload.pool,
		retryAfterSeconds: payload.retryAfterSeconds,
	};
	if (typeof body.code === "string" && body.code.endsWith("rate_limited"))
		body.code = "rate_limited";
	const code = errorCodeOf(body, status);
	if (code === "generic") return null;
	return { code, retryAfter: retryAfterSeconds(body.retryAfterSeconds) };
}
