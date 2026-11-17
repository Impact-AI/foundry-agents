import { afterEach, expect, test } from "bun:test";
import type { LiveHistoryLine } from "@platform/agent";
import {
	VoiceAgentClosed,
	VoiceAgentConnectError,
	type VoiceAgentConnection,
} from "./client";
import { giveHistory, openSession, SessionSettingsRefused } from "./exchange";
import {
	type FakeVoiceAgentOptions,
	fakeVoiceAgent,
} from "./testing/fake-voice-agent";

/**
 * The opening on the fake voice agent, which behaves as the service does: the
 * session announced, then a `session.updated` of the service's own — the
 * version applied — and only then the echo of anybody's update. The echo of
 * the person's update is the one after the service's own, never the first
 * one after sending (reading the first one would read the version's defaults
 * as the person's settings).
 */

const UPDATE = {
	type: "realtime" as const,
	audio: {
		input: { transcription: { model: "gpt-4o-transcribe", language: "it" } },
		output: { voice: "it-voice", voice_locale: "it-IT" },
	},
};

let agent: ReturnType<typeof fakeVoiceAgent> | undefined;
const opened: VoiceAgentConnection[] = [];

afterEach(async () => {
	for (const connection of opened.splice(0)) await connection.close();
	agent?.stop();
	agent = undefined;
});

function serve(
	overrides: Partial<FakeVoiceAgentOptions> = {},
): ReturnType<typeof fakeVoiceAgent> {
	agent = fakeVoiceAgent({
		agent: "assistant-voice",
		versions: ["3"],
		inputs: { language: { required: true } },
		...overrides,
	});
	return agent;
}

async function open(
	session: typeof UPDATE = UPDATE,
	ownUpdateMs?: number,
	history?: readonly LiveHistoryLine[],
) {
	const result = await openSession({
		target: {
			endpoint: agent?.endpoint ?? "",
			agent: "assistant-voice",
			version: "3",
			sessionId: "ledger-1",
			structuredInputs: { language: "it" },
		},
		connect: { token: async () => "t", timeoutMs: 2_000 },
		session,
		history,
		timeouts: { updateMs: 1_000, ownUpdateMs },
	});
	opened.push(result.connection);
	return result;
}

test("the person's update goes after the service's own session.updated, and its echo — not the service's — is what took", async () => {
	serve();
	const { update } = await open();
	expect(update).toEqual({
		kind: "updated",
		session: { ...UPDATE, object: "realtime.session" },
	});
	// One update, sent once.
	expect(
		agent?.received.filter((e) => e.type === "session.update"),
	).toHaveLength(1);
});

test("an update the service ignores is echoed as the version holds it: what the log then shows is the truth", async () => {
	serve({ ignoreUpdates: true });
	const { update } = await open();
	expect(update).toMatchObject({
		kind: "updated",
		session: { audio: { output: { voice: "the-version's-voice" } } },
	});
});

test("an update the service refuses says why, and the session still opens on the version's defaults", async () => {
	serve();
	const bad = { ...UPDATE, type: "transcription" } as unknown as typeof UPDATE;
	const { update, connection } = await open(bad);
	expect(update).toEqual({
		kind: "refused",
		code: "invalid_value",
		param: "session.type",
		message: "session.type is realtime",
	});
	expect(connection.isOpen).toBe(true);
});

test("a refused handshake throws and leaves nothing open", async () => {
	serve();
	const err = await openSession({
		target: {
			endpoint: agent?.endpoint ?? "",
			agent: "assistant-voice",
			version: "9",
			sessionId: "ledger-1",
			structuredInputs: { language: "it" },
		},
		connect: { token: async () => "t", timeoutMs: 1_000 },
		session: UPDATE,
		timeouts: { updateMs: 500 },
	}).catch((e: unknown) => e);
	expect(err).toBeInstanceOf(VoiceAgentConnectError);
	expect(agent?.openSessions()).toBe(0);
});

const THREAD: LiveHistoryLine[] = [
	{ id: "hist_0", role: "user", text: "The codename is Blue Heron." },
	{ id: "hist_1", role: "assistant", text: "Noted: Blue Heron." },
];

test("the thread so far is given after the person's update, in order, the person's words as input text and the voice's as output text, under the client's ids", async () => {
	serve();
	const { update, history } = await open(UPDATE, undefined, THREAD);
	expect(update.kind).toBe("updated");
	expect(history).toEqual({ kind: "given", lines: 2 });
	const sent = agent?.received ?? [];
	expect(sent.map((e) => e.type)).toEqual([
		"session.update",
		"conversation.item.create",
		"conversation.item.create",
	]);
	expect(sent.slice(1).map((e) => e.item)).toEqual([
		{
			id: "hist_0",
			type: "message",
			role: "user",
			content: [{ type: "input_text", text: "The codename is Blue Heron." }],
		},
		{
			id: "hist_1",
			type: "message",
			role: "assistant",
			content: [{ type: "output_text", text: "Noted: Blue Heron." }],
		},
	]);
	// Nothing asks for an answer: the person speaks first.
	expect(sent.some((e) => e.type === "response.create")).toBe(false);
});

test("a new thread gives nothing, and a line the service refuses is an outcome, not a failed open", async () => {
	serve();
	expect((await open()).history).toEqual({ kind: "given", lines: 0 });
	expect(
		agent?.received.filter((e) => e.type === "conversation.item.create"),
	).toHaveLength(0);
	const bad = [
		{ id: "hist_0", role: "user", text: 42 },
	] as unknown as LiveHistoryLine[];
	const { history, connection } = await open(UPDATE, undefined, bad);
	expect(history).toMatchObject({ kind: "refused", code: "invalid_value" });
	expect(connection.isOpen).toBe(true);
});

test("a thread refused part-way is taken out whole, by the client's ids, and the session holds none of it", async () => {
	const fake = serve({ refuseHistoryLine: 1 });
	const lines: LiveHistoryLine[] = [
		...THREAD,
		{ id: "hist_2", role: "user", text: "And the colour?" },
	];
	const { history } = await open(UPDATE, undefined, lines);
	expect(history).toEqual({
		kind: "refused",
		code: "invalid_value",
		param: "item.content.0.type",
		fatal: false,
		rolledBack: 3,
	});
	const deletes = () =>
		fake.received
			.filter((e) => e.type === "conversation.item.delete")
			.map((e) => e.item_id);
	const deadline = Date.now() + 1_000;
	while (deletes().length < 3 && Date.now() < deadline) await Bun.sleep(5);
	expect(deletes()).toEqual(["hist_0", "hist_1", "hist_2"]);
	// The two that landed are gone; the refused one answered that it never was.
	expect(fake.items()).toEqual([]);
});

test("a service that echoes nothing does not hold the open: the update unanswered after its bound, the thread sent without a wait and kept", async () => {
	const fake = serve({ echoNothing: true });
	const began = performance.now();
	const { update, history, connection } = await open(UPDATE, 50, THREAD);
	expect(update.kind).toBe("unanswered");
	expect(history).toEqual({ kind: "unacknowledged", lines: 2 });
	// The own update's wait and the update's bound, and nothing for the thread.
	expect(performance.now() - began).toBeLessThan(1_500);
	expect(connection.isOpen).toBe(true);
	expect(fake.received.some((e) => e.type === "conversation.item.delete")).toBe(
		false,
	);
});

test("settings the service refuses outright close the socket and say which", async () => {
	const fake = serve({
		refuseUpdate: {
			code: "speech_frontend_not_available",
			message: "upstream_vad_owned",
		},
	});
	const err = await open().catch((e: unknown) => e);
	expect(err).toBeInstanceOf(SessionSettingsRefused);
	expect((err as SessionSettingsRefused).code).toBe(
		"speech_frontend_not_available",
	);
	const deadline = Date.now() + 1_000;
	while (fake.openSessions() && Date.now() < deadline) await Bun.sleep(5);
	expect(fake.openSessions()).toBe(0);
});

test("a session the service closes as the update is sent fails the open, and leaves no rejection unheard", async () => {
	const unheard: unknown[] = [];
	const hear = (reason: unknown) => unheard.push(reason);
	process.on("unhandledRejection", hear);
	// Announces the session and closes: the update's wait and its send both meet a closed socket.
	const server = Bun.serve({
		port: 0,
		fetch: (request, srv) =>
			srv.upgrade(request) ? undefined : new Response(null, { status: 400 }),
		websocket: {
			open(ws) {
				ws.send(
					JSON.stringify({ type: "session.created", session: { id: "s" } }),
				);
				ws.close(1011, "gone");
			},
			message() {},
		},
	});
	try {
		const failure = await openSession({
			target: {
				endpoint: `http://127.0.0.1:${server.port}/api/projects/fake`,
				agent: "assistant-voice",
				version: "3",
				sessionId: "ledger-1",
				structuredInputs: { language: "it" },
			},
			connect: { token: async () => "t", timeoutMs: 2_000 },
			session: UPDATE,
			history: [{ id: "hist_1", role: "user", text: "Ciao." }],
			timeouts: { updateMs: 1_000, ownUpdateMs: 1_000 },
		}).then(
			() => null,
			(err: unknown) => err,
		);
		expect(failure).toBeInstanceOf(VoiceAgentClosed);
		await Bun.sleep(20);
		expect(unheard).toEqual([]);
	} finally {
		process.off("unhandledRejection", hear);
		// Not awaited: a stop that waits on a socket the service already closed need not settle.
		void server.stop(true);
	}
});

test("a thread's line sent to a closed session throws, and the wait for its echo is not left to reject unheard", async () => {
	const unheard: unknown[] = [];
	const hear = (reason: unknown) => unheard.push(reason);
	process.on("unhandledRejection", hear);
	serve();
	const { connection } = await open();
	const closed = new VoiceAgentClosed({
		kind: "server",
		code: 1011,
		reason: "",
	});
	const stub = {
		...connection,
		next: () => Bun.sleep(5).then(() => Promise.reject(closed)),
		send: () => {
			throw closed;
		},
	} as unknown as VoiceAgentConnection;
	try {
		await expect(
			giveHistory(stub, [{ id: "hist_1", role: "user", text: "Ciao." }], 1_000),
		).rejects.toBe(closed);
		await Bun.sleep(20);
		expect(unheard).toEqual([]);
	} finally {
		process.off("unhandledRejection", hear);
	}
});
