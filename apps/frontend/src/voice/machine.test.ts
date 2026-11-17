import { expect, test } from "bun:test";
import { machineEvent, readServerMessage } from "./events";
import {
	closeReason,
	endingError,
	INITIAL,
	type LiveSession,
	reduce,
	type VoiceEvent,
	type VoiceState,
} from "./machine";

const run = (events: VoiceEvent[], from: VoiceState = INITIAL) =>
	events.reduce(reduce, from);

const session: LiveSession = {
	id: "s1",
	idleMs: 60_000,
	maxMs: 600_000,
	openedAt: 0,
};
const live = run([{ type: "open" }, { type: "connected", session }]);

test("a session walks connecting → listening → thinking → speaking → listening", () => {
	let state = run([{ type: "open" }]);
	expect(state.phase).toBe("connecting");
	state = reduce(state, { type: "connected", session });
	expect(state).toMatchObject({ phase: "listening", session, error: null });
	state = run([{ type: "speech_started" }, { type: "speech_stopped" }], state);
	expect(state.phase).toBe("thinking");
	state = reduce(state, { type: "response_started" });
	expect(state).toMatchObject({ phase: "speaking", responding: true });
	state = reduce(state, { type: "response_done" });
	expect(state).toMatchObject({ phase: "listening", responding: false });
});

test("a stage call keeps the pane thinking until the browser answers it", () => {
	let state = run(
		[
			{ type: "tool_called", name: "showRecord" },
			{ type: "response_started" },
			{ type: "response_done" },
		],
		live,
	);
	expect(state).toMatchObject({
		phase: "thinking",
		pendingTools: 1,
		lastTool: "showRecord",
	});
	state = reduce(state, { type: "tool_answered" });
	expect(state.pendingTools).toBe(0);
	expect(reduce(state, { type: "tool_answered" }).pendingTools).toBe(0);
	// A call on a closed channel is not drawn.
	expect(reduce(INITIAL, { type: "tool_called", name: "x" })).toBe(INITIAL);
});

test("a blocked answer is said, and the next thing the person says clears it", () => {
	const blocked = reduce(live, { type: "blocked" });
	expect(blocked.blocked).toBe(true);
	expect(reduce(blocked, { type: "speech_started" }).blocked).toBe(false);
});

test("an answer that could not be had is said, the session goes on, and the next thing the person says clears it", () => {
	const unanswered = reduce(live, { type: "unanswered" });
	expect(unanswered).toMatchObject({
		unanswered: true,
		phase: "listening",
		error: null,
	});
	expect(reduce(unanswered, { type: "speech_started" }).unanswered).toBe(false);
	expect(reduce(unanswered, { type: "open" }).unanswered).toBe(false);
});

test("a typed message the session did not take is said, the session goes on, and the next answer or the next thing the person says clears it", () => {
	const refused = reduce(live, { type: "typed_refused", why: "fast" });
	expect(refused).toMatchObject({
		typedRefused: "fast",
		phase: "listening",
		error: null,
	});
	expect(
		reduce(live, { type: "typed_refused", why: "full" }).typedRefused,
	).toBe("full");
	expect(reduce(refused, { type: "speech_started" }).typedRefused).toBeNull();
	expect(reduce(refused, { type: "response_started" }).typedRefused).toBeNull();
	expect(reduce(refused, { type: "open" }).typedRefused).toBeNull();
});

test("mute survives a reconnect; close keeps only the mic choice", () => {
	const muted = reduce(live, { type: "mute" });
	expect(muted.micOpen).toBe(false);
	const reopened = reduce(reduce(muted, { type: "close" }), { type: "open" });
	expect(reopened).toMatchObject({
		phase: "connecting",
		micOpen: false,
		session: null,
	});
});

test("a failure names its code and drops the session and what was pending", () => {
	const pending = run([{ type: "tool_called", name: "x" }], live);
	expect(reduce(pending, { type: "failed", code: "micDenied" })).toMatchObject({
		phase: "error",
		error: "micDenied",
		session: null,
		pendingTools: 0,
		responding: false,
	});
});

test("every ending says why; one the person chose is not a fault", () => {
	expect(endingError("idle")).toBe("sessionIdle");
	expect(endingError("length")).toBe("sessionLength");
	expect(endingError("allowance")).toBe("rate_limited");
	expect(endingError("expired")).toBe("sessionExpired");
	expect(endingError("restart")).toBe("sessionRestart");
	expect(endingError("lost")).toBe("sessionLost");
	expect(endingError("service")).toBe("session");
	expect(endingError("failed")).toBe("session");
	// The service refused the session's own settings: its own line, not a fault of the channel.
	expect(endingError("refused")).toBe("settings_refused");
	expect(endingError("client")).toBeNull();
	expect(reduce(live, { type: "ended", reason: "restart" })).toMatchObject({
		phase: "error",
		error: "sessionRestart",
		session: null,
	});
	expect(reduce(live, { type: "ended", reason: "client" })).toMatchObject({
		phase: "idle",
		error: null,
	});
});

test("why the socket went when the server said nothing is read off the clocks", () => {
	expect(closeReason(null, 0, 1)).toBe("client");
	expect(closeReason(session, 0, 600_000)).toBe("length");
	expect(closeReason(session, 100_000, 170_000)).toBe("idle");
	expect(closeReason(session, 100_000, 120_000)).toBe("failed");
});

test("the socket's messages are read once — the session's answer, then the events mapped onto the machine — and anything unknown is dropped", () => {
	const read = (event: unknown) => {
		const message = readServerMessage(JSON.stringify(event));
		return message && message.type !== "ready" && message.type !== "refused"
			? message
			: null;
	};
	expect(
		readServerMessage(
			JSON.stringify({
				type: "ready",
				language: "it",
				audio: { sampleRate: 24_000 },
				session: { id: "s1", maxSessionSeconds: 600, idleSeconds: 60 },
			}),
		),
	).toMatchObject({ type: "ready", audio: { sampleRate: 24_000 } });
	expect(
		readServerMessage(
			JSON.stringify({
				type: "refused",
				status: 409,
				body: { code: "refused" },
			}),
		),
	).toEqual({ type: "refused", status: 409, body: { code: "refused" } });
	expect(read({ type: "speech", state: "started" })).toEqual({
		type: "speech",
		state: "started",
	});
	expect(read({ type: "speech", state: "sideways" })).toBeNull();
	// The documents an answer drew on: the list is read later, entry by entry, as a typed reply's.
	expect(
		read({
			type: "sources",
			sources: [{ id: "d1", title: "Depot checklist" }],
		}),
	).toEqual({
		type: "sources",
		sources: [{ id: "d1", title: "Depot checklist" }],
	});
	expect(read({ type: "sources", sources: "d1" })).toBeNull();
	expect(read({ type: "something-new" })).toBeNull();
	expect(readServerMessage("not json")).toBeNull();
	const mapped = [
		{ type: "speech", state: "started" },
		{ type: "speech", state: "stopped" },
		{ type: "response", state: "started" },
		{ type: "response", state: "done" },
		{ type: "error", code: "turn.blocked" },
		{ type: "error", code: "turn.unanswered" },
		{ type: "error", code: "text.too_fast" },
		{ type: "error", code: "text.session_full" },
		{ type: "error", code: "turn.something_new" },
		{ type: "ending", reason: "restart" },
		{ type: "ended", reason: "refused", written: 0 },
		{ type: "ended", reason: "client", written: 2 },
		{ type: "line", role: "user", text: "Hello." },
		{ type: "sources", sources: [] },
	].map((e) => {
		const event = read(e);
		return event ? machineEvent(event) : "unread";
	});
	expect(mapped).toEqual([
		{ type: "speech_started" },
		{ type: "speech_stopped" },
		{ type: "response_started" },
		{ type: "response_done" },
		{ type: "blocked" },
		{ type: "unanswered" },
		{ type: "typed_refused", why: "fast" },
		{ type: "typed_refused", why: "full" },
		null,
		{ type: "ended", reason: "restart" },
		{ type: "ended", reason: "refused" },
		{ type: "ended", reason: "client" },
		null,
		null,
	]);
});
