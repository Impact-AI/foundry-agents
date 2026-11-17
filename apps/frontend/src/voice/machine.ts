import type { ErrorCode } from "../errors";

/**
 * The voice pane's state, as a pure machine the live link feeds from the
 * session's socket. What the pane draws, and what an ending means to
 * the person, is decided here, once.
 */
export type VoicePhase =
	| "idle"
	| "connecting"
	| "listening"
	| "thinking"
	| "speaking"
	| "error";

export type VoiceErrorCode =
	| "insecure"
	| "mic"
	| "micDenied"
	| "micNone"
	| "capture"
	| "micLost"
	| "setup"
	| "session"
	| "sessionIdle"
	| "sessionLength"
	| "sessionExpired"
	| "sessionLost"
	| "sessionRestart"
	| ErrorCode;

export interface LiveSession {
	id: string;
	idleMs: number;
	maxMs: number;
	openedAt: number;
}

export interface VoiceState {
	phase: VoicePhase;
	micOpen: boolean;
	/** The voice has a response in flight. */
	responding: boolean;
	/** Stage calls the session made that the browser has not answered yet. */
	pendingTools: number;
	/** The last stage control the session reached for. */
	lastTool: string | null;
	/** The content filter stopped an answer; the session goes on. */
	blocked: boolean;
	/** An answer failed and asking again did not get it; the session goes on until the person speaks again. */
	unanswered: boolean;
	/** A typed message the session did not take: too many at once (`fast`), or more than one session takes in all (`full`). */
	typedRefused: "fast" | "full" | null;
	error: VoiceErrorCode | null;
	session: LiveSession | null;
}

/**
 * Why a session ended, as the server says it: the person (`client`), the
 * ledger (`idle`, `length`, `allowance`), the service's own limit
 * (`expired`), a replica going away (`restart`: reopening continues the
 * thread), the service or the connection (`service`, `failed`), the service
 * refusing the session's own settings (`refused`), or the replica holding it
 * dying (`lost`).
 */
export const SESSION_ENDINGS = [
	"client",
	"idle",
	"length",
	"allowance",
	"expired",
	"restart",
	"service",
	"refused",
	"failed",
	"lost",
] as const;
export type SessionEnding = (typeof SESSION_ENDINGS)[number];

export type VoiceEvent =
	| { type: "open" }
	| { type: "connected"; session: LiveSession }
	| { type: "speech_started" }
	| { type: "speech_stopped" }
	| { type: "response_started" }
	| { type: "response_done" }
	| { type: "blocked" }
	| { type: "unanswered" }
	| { type: "typed_refused"; why: "fast" | "full" }
	| { type: "mute" }
	| { type: "unmute" }
	| { type: "tool_called"; name: string }
	| { type: "tool_answered" }
	| { type: "failed"; code: VoiceErrorCode }
	| { type: "ended"; reason: SessionEnding }
	| { type: "close" };

export const INITIAL: VoiceState = {
	phase: "idle",
	micOpen: true,
	responding: false,
	pendingTools: 0,
	lastTool: null,
	blocked: false,
	unanswered: false,
	typedRefused: null,
	error: null,
	session: null,
};

/** What an ending says to the person. `client` is not a fault. */
export function endingError(reason: SessionEnding): VoiceErrorCode | null {
	switch (reason) {
		case "idle":
			return "sessionIdle";
		case "length":
			return "sessionLength";
		case "allowance":
			return "rate_limited";
		case "expired":
			return "sessionExpired";
		case "restart":
			return "sessionRestart";
		case "lost":
			return "sessionLost";
		case "refused":
			return "settings_refused";
		case "service":
		case "failed":
			return "session";
		default:
			return null;
	}
}

/** The phase once a response is over: still waiting on a control, or listening again. */
function between(state: VoiceState): VoicePhase {
	return state.pendingTools > 0 ? "thinking" : "listening";
}

const closed = (state: VoiceState) =>
	state.phase === "idle" || state.phase === "error";

export function reduce(state: VoiceState, event: VoiceEvent): VoiceState {
	switch (event.type) {
		case "open":
			return { ...INITIAL, micOpen: state.micOpen, phase: "connecting" };
		case "connected":
			return {
				...state,
				phase: "listening",
				session: event.session,
				error: null,
			};
		case "speech_started":
			return closed(state)
				? state
				: {
						...state,
						phase: "listening",
						blocked: false,
						unanswered: false,
						typedRefused: null,
					};
		case "speech_stopped":
			return closed(state) ? state : { ...state, phase: "thinking" };
		case "response_started":
			return closed(state)
				? state
				: { ...state, phase: "speaking", responding: true, typedRefused: null };
		case "response_done": {
			if (closed(state)) return state;
			const settled = { ...state, responding: false };
			return { ...settled, phase: between(settled) };
		}
		case "blocked":
			return { ...state, blocked: true };
		case "unanswered":
			return { ...state, unanswered: true };
		case "typed_refused":
			return { ...state, typedRefused: event.why };
		case "tool_called":
			return closed(state)
				? state
				: {
						...state,
						phase: "thinking",
						pendingTools: state.pendingTools + 1,
						lastTool: event.name,
					};
		case "tool_answered":
			return { ...state, pendingTools: Math.max(0, state.pendingTools - 1) };
		case "mute":
			return { ...state, micOpen: false };
		case "unmute":
			return { ...state, micOpen: true };
		case "failed":
			return {
				...state,
				phase: "error",
				responding: false,
				pendingTools: 0,
				error: event.code,
				session: null,
			};
		case "ended": {
			const error = endingError(event.reason);
			const settled = {
				...state,
				responding: false,
				pendingTools: 0,
				session: null,
			};
			return error
				? { ...settled, phase: "error", error }
				: { ...settled, phase: "idle" };
		}
		case "close":
			return { ...INITIAL, micOpen: state.micOpen };
	}
}

/**
 * Why the socket went when the server said nothing: the ledger hangs up at
 * the idle window and at the session ceiling, and the pane says which.
 */
export function closeReason(
	session: LiveSession | null,
	lastActivityAt: number,
	now: number,
): SessionEnding {
	if (!session) return "client";
	if (session.maxMs > 0 && now - session.openedAt >= session.maxMs)
		return "length";
	if (session.idleMs > 0 && now - lastActivityAt >= session.idleMs)
		return "idle";
	return "failed";
}
