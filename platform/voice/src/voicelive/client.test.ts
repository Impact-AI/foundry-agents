import { afterEach, expect, spyOn, test } from "bun:test";
import {
	connectVoiceAgent,
	VOICE_LIVE_API_VERSION,
	type VoiceAgentClose,
	VoiceAgentClosed,
	VoiceAgentConnectError,
	type VoiceAgentConnection,
	type VoiceAgentTarget,
	VoiceAgentTimeout,
	voiceAgentUrl,
	voiceLiveUrl,
} from "./client";
import { readServerEvent, type ServerEvent } from "./events";
import {
	type FakeVoiceAgentOptions,
	fakeVoiceAgent,
} from "./testing/fake-voice-agent";

/**
 * The session socket's client on the fake voice agent: the upgrade the
 * service checks, the session the connect waits for, every way a connect
 * is refused, the audio appended and never queued, typed events in order —
 * the voice's audio among them — the send queue's bound, and how each end
 * of a session is named. The opening's update is `opening.test.ts`'s.
 */

const INPUTS = {
	personalization: { required: true },
	language: { required: true, enum: ["en", "it"] },
} as const;

let agent: ReturnType<typeof fakeVoiceAgent> | undefined;
const opened: VoiceAgentConnection[] = [];

afterEach(async () => {
	for (const connection of opened.splice(0)) await connection.close();
	agent?.stop();
	agent = undefined;
});

function serve(overrides: Partial<FakeVoiceAgentOptions> = {}) {
	agent = fakeVoiceAgent({
		agent: "assistant-voice",
		versions: ["3"],
		inputs: INPUTS,
		...overrides,
	});
	return agent;
}

function target(overrides: Partial<VoiceAgentTarget> = {}): VoiceAgentTarget {
	return {
		endpoint: agent?.endpoint ?? "",
		agent: "assistant-voice",
		version: "3",
		sessionId: "ledger-1",
		structuredInputs: { personalization: "<personalization/>", language: "it" },
		...overrides,
	};
}

async function connect(
	overrides: Partial<VoiceAgentTarget> = {},
	options: {
		timeoutMs?: number;
		maxQueued?: number;
		highWaterBytes?: number;
	} = {},
) {
	const connection = await connectVoiceAgent(target(overrides), {
		token: async () => "entra-token",
		timeoutMs: options.timeoutMs ?? 2_000,
		maxQueued: options.maxQueued,
		highWaterBytes: options.highWaterBytes,
	});
	opened.push(connection);
	return connection;
}

async function refusal(
	promise: Promise<unknown>,
): Promise<VoiceAgentConnectError> {
	const err = await promise.then(
		() => null,
		(e: unknown) => e,
	);
	expect(err).toBeInstanceOf(VoiceAgentConnectError);
	return err as VoiceAgentConnectError;
}

test("the URL pins the version, keeps nothing at Foundry, and never carries the person: they travel in a header", () => {
	const url = new URL(
		voiceAgentUrl({
			...target(),
			endpoint: "https://account.services.ai.azure.com/api/projects/p/",
		}),
	);
	expect(`${url.protocol}//${url.host}${url.pathname}`).toBe(
		"wss://account.services.ai.azure.com/api/projects/p/agents/assistant-voice/endpoint/protocols/voice",
	);
	expect(Object.fromEntries(url.searchParams)).toEqual({
		"api-version": "v1",
		"x-agent-version-override": "3",
		store: "false",
		transport: "websocket",
		agent_session_id: "ledger-1",
	});
	expect(url.toString()).not.toContain("personalization");
	expect(() =>
		voiceAgentUrl({ ...target(), endpoint: "http://account.example/api" }),
	).toThrow(/https/);
});

test("Voice Live is reached on the project's own host at /voice-live/realtime, on a generally available API version and a model, with nothing of a voice agent", async () => {
	const url = new URL(
		voiceLiveUrl({
			kind: "voiceLive",
			endpoint: "https://account.services.ai.azure.com/api/projects/p",
			model: "gpt-realtime-2.1",
		}),
	);
	expect(`${url.protocol}//${url.host}${url.pathname}`).toBe(
		"wss://account.services.ai.azure.com/voice-live/realtime",
	);
	expect(Object.fromEntries(url.searchParams)).toEqual({
		"api-version": VOICE_LIVE_API_VERSION,
		model: "gpt-realtime-2.1",
	});
	expect(VOICE_LIVE_API_VERSION).not.toContain("preview");

	const fake = fakeVoiceAgent({
		agent: "unused",
		versions: [],
		inputs: {},
		voiceLive: { model: "gpt-realtime-2.1" },
	});
	try {
		const connection = await connectVoiceAgent(
			{ kind: "voiceLive", endpoint: fake.endpoint, model: "gpt-realtime-2.1" },
			{ token: async () => "t", timeoutMs: 2_000 },
		);
		expect(fake.refusals).toEqual([]);
		expect(fake.upgrades[0]?.headers.get("authorization")).toBe("Bearer t");
		await connection.close();
	} finally {
		await fake.stop();
	}
});

test("a connect resolves on the session the service announced, sent with the bearer, the preview opt-in and the person's inputs", async () => {
	serve({ expiresInMs: 60_000 });
	const connection = await connect();
	expect(connection.session).toEqual({
		id: "sess_1",
		conversationId: "voiceconv_1",
		expiresAt: expect.any(Number),
		instructions: null,
	});
	expect(connection.isOpen).toBe(true);
	const [upgrade] = agent?.upgrades ?? [];
	expect(upgrade?.headers.get("authorization")).toBe("Bearer entra-token");
	expect(upgrade?.headers.get("foundry-features")).toBe(
		"VoiceAgents=V1Preview",
	);
	expect(
		JSON.parse(upgrade?.headers.get("x-ms-voice-structured-inputs") ?? ""),
	).toEqual({ personalization: "<personalization/>", language: "it" });
});

test("a person's part in any language crosses in its header, escaped where a header cannot carry it, and arrives as it was", async () => {
	serve();
	const personalization =
		"<person>Zofia Wrzosek — Łódź, già, Straße, 東京</person>";
	await connect({
		structuredInputs: { personalization, language: "it" },
	});
	const header =
		agent?.upgrades[0]?.headers.get("x-ms-voice-structured-inputs") ?? "";
	expect(header).toMatch(/^[\x20-\x7e]+$/);
	expect(JSON.parse(header)).toEqual({ personalization, language: "it" });
});

test("every check of the upgrade refuses the connect, and the service's log says which", async () => {
	serve();
	const cases: [Partial<VoiceAgentTarget>, string][] = [
		[{ agent: "someone-else" }, "no such agent"],
		[{ version: "9" }, "no such version"],
		[{ structuredInputs: { personalization: "x" } }, "required input language"],
		[
			{ structuredInputs: { personalization: "x", language: "xx" } },
			"input language is one of en, it",
		],
		[
			{
				structuredInputs: {
					personalization: "x",
					language: "en",
					extra: "y",
				},
			},
			"undeclared input extra",
		],
	];
	for (const [overrides, why] of cases) {
		const err = await refusal(connect(overrides));
		expect(err.failure).toBe("refused");
		expect(agent?.refusals.at(-1)?.why).toBe(why);
	}
	expect(agent?.upgrades).toEqual([]);
});

test("an error before the session refuses the connect with the service's code; a socket that never announces one is bounded", async () => {
	serve({ failSession: { code: "agent_unavailable", message: "not today" } });
	const failed = await refusal(connect());
	expect(failed.failure).toBe("error");
	expect(failed.code).toBe("agent_unavailable");
	expect(failed.message).toBe("not today");
	agent?.stop();

	serve({ silent: true });
	const started = Date.now();
	const timedOut = await refusal(connect({}, { timeoutMs: 150 }));
	expect(timedOut.failure).toBe("timeout");
	expect(Date.now() - started).toBeLessThan(1_500);
});

test("an abandoned connect is refused as such, before or during the handshake", async () => {
	serve({ silent: true });
	const before = new AbortController();
	before.abort();
	const early = await refusal(
		connectVoiceAgent(target(), {
			token: async () => "t",
			timeoutMs: 1_000,
			signal: before.signal,
		}),
	);
	expect(early.failure).toBe("aborted");
	const during = new AbortController();
	const pending = connectVoiceAgent(target(), {
		token: async () => "t",
		timeoutMs: 5_000,
		signal: during.signal,
	});
	setTimeout(() => during.abort(), 50);
	expect((await refusal(pending)).failure).toBe("aborted");
});

test("the person's audio is appended as it comes, and a frame the socket cannot take now is dropped and counted, never queued", async () => {
	serve();
	const connection = await connect();
	const frame = Buffer.alloc(4_800, 7).toString("base64");
	for (let i = 0; i < 5; i++) expect(connection.append(frame)).toBe(true);
	await Bun.sleep(50);
	expect(agent?.appended()).toBe(5 * 4_800);
	expect(connection.dropped).toBe(0);
	// Nothing appended rides in the events the session reads back.
	expect(
		agent?.received.some((e) => e.type === "input_audio_buffer.append"),
	).toBe(false);

	const stuck = await connect({}, { highWaterBytes: -1 });
	expect(stuck.append(frame)).toBe(false);
	expect(stuck.dropped).toBe(1);
	await stuck.close();
	expect(stuck.append(frame)).toBe(false);
});

test("a wait the service never answers times out, and a wait over a close ends with the close", async () => {
	serve();
	const connection = await connect();
	await expect(
		connection.next(() => undefined, { timeoutMs: 50, what: "nothing" }),
	).rejects.toBeInstanceOf(VoiceAgentTimeout);
	const waiting = connection.next(() => undefined, {
		timeoutMs: 5_000,
		what: "anything",
	});
	agent?.hangUp(4002, "maintenance");
	const err = await waiting.catch((e: unknown) => e);
	expect(err).toBeInstanceOf(VoiceAgentClosed);
	expect((err as VoiceAgentClosed).close).toEqual({
		kind: "server",
		code: 4002,
		reason: "maintenance",
	});
});

test("a played turn arrives typed and in order: the voice's tool call, then its audio and its words once the output and the response.create are in", async () => {
	serve({ answerAudioBytes: 9_600 });
	const connection = await connect();
	const seen: ServerEvent[] = [];
	connection.subscribe((event) => seen.push(event));
	connection.subscribe((event) => {
		if (event.type !== "response.function_call_arguments.done") return;
		connection.send({
			type: "conversation.item.create",
			item: {
				type: "function_call_output",
				call_id: event.call_id,
				output: '{"found":true}',
			},
		});
		connection.send({ type: "response.create" });
	});
	const answered = connection.next(
		(e) =>
			e.type === "response.done" && e.response.id === "resp_1"
				? true
				: undefined,
		{ timeoutMs: 2_000, what: "the answer's end" },
	);
	await agent?.play({
		heard: "Find the runbook.",
		calls: [{ name: "knowledgeSearch", arguments: { query: "runbook" } }],
		answer: "Step one is to page the on-call.",
	});
	await answered;
	const types = seen.map((e) => e.type);
	// `response.created` carries `usage: null`, as the service sends it: still a response, never malformed.
	expect(types).not.toContain("malformed");
	expect(types.filter((t) => t === "response.created")).toHaveLength(2);
	const call = types.indexOf("response.function_call_arguments.done");
	const audio = seen.filter((e) => e.type === "response.output_audio.delta");
	expect(audio).toHaveLength(2);
	expect(call).toBeLessThan(types.indexOf("response.output_audio.delta"));
	expect(
		agent?.received.find((e) => e.type === "conversation.item.create"),
	).toMatchObject({ item: { call_id: "call_1_0" } });
	expect(
		seen.filter((e) => e.type === "response.output_audio_transcript.done"),
	).toHaveLength(1);
});

test("an error the service raised itself, every detail null but its words, is an error and not malformed", () => {
	// The shape the voice agent sends when it refuses a session.update.
	const raw = JSON.stringify({
		event_id: "event_1",
		type: "error",
		error: {
			message: "'session.type' unexpected (extra fields not permitted)",
			type: "invalid_request_error",
			code: "invalid_session_update_message",
			param: "session.type",
			event_id: null,
		},
	});
	expect(readServerEvent(raw)).toMatchObject({
		type: "error",
		error: { code: "invalid_session_update_message", event_id: null },
	});
});

test("an item that follows nothing may say so with an empty previous id, as a cascaded session does: read as following nothing", () => {
	// The shape a voice agent on the chat's model sends.
	const raw = JSON.stringify({
		type: "conversation.item.created",
		previous_item_id: "",
		item: { id: "item_1", type: "message", role: "assistant", content: [] },
	});
	expect(readServerEvent(raw)).toMatchObject({
		type: "conversation.item.created",
		previous_item_id: null,
		item: { id: "item_1" },
	});
});

test("a type nothing reads is kept whole, and a known type missing what it is read for is malformed, never thrown", () => {
	expect(readServerEvent('{"type":"session.avatar.connecting","x":1}')).toEqual(
		{
			type: "unrecognized",
			name: "session.avatar.connecting",
			event: { type: "session.avatar.connecting", x: 1 },
		},
	);
	expect(
		readServerEvent(
			'{"type":"conversation.item.input_audio_transcription.completed","item_id":"a"}',
		),
	).toMatchObject({
		type: "malformed",
		name: "conversation.item.input_audio_transcription.completed",
		problem: expect.stringContaining("transcript"),
	});
	expect(readServerEvent("not json")).toMatchObject({
		type: "malformed",
		problem: "not JSON",
	});
	expect(readServerEvent("[1]")).toMatchObject({
		type: "malformed",
		problem: "not an object",
	});
	expect(
		readServerEvent(
			'{"type":"response.audio_transcript.done","response_id":"r","item_id":"i","transcript":"hi","extra":true}',
		),
	).toEqual({
		type: "response.audio_transcript.done",
		response_id: "r",
		item_id: "i",
		transcript: "hi",
		extra: true,
	});
});

test("each end is named: the client's, the service's at expiry, the service's otherwise, and a dropped connection", async () => {
	serve();
	const finished = await connect();
	expect(await finished.close("finished")).toEqual({
		kind: "client",
		code: 1000,
		reason: "finished",
	});
	expect(() => finished.send({ type: "response.create" })).toThrow(
		VoiceAgentClosed,
	);
	expect(finished.isOpen).toBe(false);

	const theirs = await connect();
	agent?.hangUp(1011, "internal");
	expect(await theirs.closed).toEqual({
		kind: "server",
		code: 1011,
		reason: "internal",
	} satisfies VoiceAgentClose);

	const dropped = await connect();
	agent?.drop();
	expect((await dropped.closed).kind).toBe("dropped");
	agent?.stop();

	serve({ expiresInMs: 300 });
	const expiring = await connect();
	expect((await expiring.closed).kind).toBe("expired");
});

test("a queue the socket cannot drain closes the session past its bound rather than growing", async () => {
	serve();
	const stuck = await connect({}, { maxQueued: 3, highWaterBytes: -1 });
	for (let i = 0; i < 3; i++) stuck.send({ type: "response.create" });
	expect(() => stuck.send({ type: "response.create" })).toThrow(
		VoiceAgentClosed,
	);
	expect(await stuck.closed).toMatchObject({ kind: "overflow" });
	expect(agent?.received.filter((e) => e.type === "response.create")).toEqual(
		[],
	);

	const flowing = await connect({}, { maxQueued: 3 });
	for (let i = 0; i < 10; i++) flowing.send({ type: "response.create" });
	await Bun.sleep(50);
	expect(
		agent?.received.filter((e) => e.type === "response.create"),
	).toHaveLength(10);
});

/**
 * A peer that answers the upgrade, announces a session and then reads
 * nothing and says nothing: no server built on a WebSocket library can be
 * made to ignore a close frame, so this one speaks the handshake by hand.
 */
function silentPeer() {
	const server = Bun.listen({
		hostname: "127.0.0.1",
		port: 0,
		socket: {
			data(socket, data) {
				const key = /sec-websocket-key: (.+)\r\n/i.exec(data.toString())?.[1];
				if (!key) return;
				const accept = new Bun.CryptoHasher("sha1")
					.update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`)
					.digest("base64");
				socket.write(
					`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\nSec-WebSocket-Protocol: realtime\r\n\r\n`,
				);
				const payload = Buffer.from(
					JSON.stringify({ type: "session.created", session: { id: "s" } }),
				);
				socket.write(
					Buffer.concat([Buffer.from([0x81, payload.length]), payload]),
				);
			},
		},
	});
	return {
		endpoint: `http://127.0.0.1:${server.port}/api/projects/fake`,
		stop: () => server.stop(true),
	};
}

test("a close the peer never answers is not waited for: the socket is torn down and the end is ours", async () => {
	const peer = silentPeer();
	try {
		const connection = await connectVoiceAgent(
			target({ endpoint: peer.endpoint }),
			{
				token: async () => "entra-token",
				timeoutMs: 2_000,
				closeTimeoutMs: 100,
			},
		);
		const started = Date.now();
		const close = await connection.close("done");
		expect(close.kind).toBe("client");
		expect(close.reason).toBe("done");
		expect(Date.now() - started).toBeLessThan(1_500);
		expect(connection.isOpen).toBe(false);
	} finally {
		peer.stop();
	}
});

test("sends that find the socket full wait on one retry, not one each", async () => {
	serve();
	const connection = await connect({}, { highWaterBytes: -1, maxQueued: 50 });
	const set = spyOn(globalThis, "setTimeout");
	const cleared = spyOn(globalThis, "clearTimeout");
	try {
		for (let i = 0; i < 20; i++) connection.send({ type: "response.create" });
		expect(
			set.mock.calls.length - cleared.mock.calls.length,
		).toBeLessThanOrEqual(1);
	} finally {
		set.mockRestore();
		cleared.mockRestore();
	}
});
