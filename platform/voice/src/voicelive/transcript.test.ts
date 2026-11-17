import { afterEach, expect, test } from "bun:test";
import type { SpokenItem } from "@platform/agent";
import { connectVoiceAgent, type VoiceAgentConnection } from "./client";
import { readServerEvent } from "./events";
import { giveHistory } from "./exchange";
import { type FakeTurn, fakeVoiceAgent } from "./testing/fake-voice-agent";
import { SessionTranscript } from "./transcript";

/**
 * A session's transcript as the broker will read it, off the client on the
 * fake voice agent: every item placed by the chain the session announced,
 * finals only, a tool call placed and never words, a barge-in kept whole and marked,
 * a failed or filtered turn handed over as unheard, and the settle waiting
 * for the person's finals however late they come.
 */

let agent: ReturnType<typeof fakeVoiceAgent> | undefined;
let connection: VoiceAgentConnection | undefined;

afterEach(async () => {
	await connection?.close();
	agent?.stop();
	agent = connection = undefined;
});

/** A session on the fake, with a transcript reading it and every call answered as the backend would. */
async function session(): Promise<SessionTranscript> {
	agent = fakeVoiceAgent({
		agent: "assistant-voice",
		versions: ["1"],
		inputs: { personalization: { required: true } },
	});
	connection = await connectVoiceAgent(
		{
			endpoint: agent.endpoint,
			agent: "assistant-voice",
			version: "1",
			sessionId: "ledger-1",
			structuredInputs: { personalization: "<personalization/>" },
		},
		{ token: async () => "t", timeoutMs: 2_000 },
	);
	const live = connection;
	const transcript = new SessionTranscript();
	live.subscribe((event) => {
		transcript.observe(event);
		if (event.type === "response.function_call_arguments.done") {
			live.send({
				type: "conversation.item.create",
				item: {
					type: "function_call_output",
					call_id: event.call_id,
					output: "{}",
				},
			});
			live.send({ type: "response.create" });
		}
	});
	return transcript;
}

/** Play a turn and wait until the client has read all of it: the answer's end, and the person's final. */
async function play(turn: FakeTurn, answer: string): Promise<void> {
	const ended = connection?.next(
		(e) =>
			e.type === "response.done" && e.response.id === answer ? true : undefined,
		{ timeoutMs: 2_000, what: answer },
	);
	await agent?.play(turn);
	await ended;
	await Bun.sleep(10);
}

/** The items as kinds and words, in the session's order: what the host will write. */
function shown(items: readonly SpokenItem[]): string[] {
	return items.map((item) =>
		item.kind === "said"
			? `${item.role}: ${item.text}${item.interrupted ? " (cut)" : ""}`
			: item.kind === "unheard"
				? `unheard ${item.role}: ${item.reason}`
				: "other",
	);
}

test("a turn with a tool: the call and its output are placed and never words, the answer is said, and every item follows the one before it", async () => {
	const transcript = await session();
	await play(
		{
			heard: "Find the incident runbook.",
			calls: [{ name: "knowledgeSearch", arguments: { query: "runbook" } }],
			answer: "Step one is to page the on-call.",
		},
		"resp_1",
	);
	const items = transcript.spoken();
	expect(shown(items)).toEqual([
		"user: Find the incident runbook.",
		"other",
		"other",
		"assistant: Step one is to page the on-call.",
	]);
	// The chain the session announced: each item after the one before it.
	expect(items.map((i) => i.previousItemId)).toEqual([
		null,
		...items.slice(0, -1).map((i) => i.itemId),
	]);
	expect(transcript.pending).toBe(0);
});

test("a person's final that arrives after the answer is waited for, and the item keeps its place before the answer", async () => {
	const transcript = await session();
	const late = transcript.settled(2_000);
	await play(
		{ heard: "What time is it?", heardLate: true, answer: "Half past nine." },
		"resp_1",
	);
	expect(await late).toBe(true);
	const [question, answer] = transcript.spoken();
	expect(question).toMatchObject({
		kind: "said",
		role: "user",
		text: "What time is it?",
		previousItemId: null,
	});
	expect(answer).toMatchObject({
		kind: "said",
		role: "assistant",
		previousItemId: question?.itemId,
	});
	expect((question?.at ?? "") <= (answer?.at ?? "")).toBe(true);
});

test("a failed transcription settles the turn as unheard, and a final that never comes is waited for only so long", async () => {
	const transcript = await session();
	await play(
		{ heard: { failed: "audio unclear" }, answer: "Sorry?" },
		"resp_1",
	);
	expect(await transcript.settled(50)).toBe(true);
	expect(shown(transcript.spoken())).toEqual([
		"unheard user: failed",
		"assistant: Sorry?",
	]);

	const pending = new SessionTranscript();
	pending.observe({
		type: "input_audio_buffer.committed",
		item_id: "in_9",
		previous_item_id: null,
	});
	expect(pending.pending).toBe(1);
	expect(await pending.settled(30)).toBe(false);
	expect(shown(pending.spoken())).toEqual(["unheard user: unsettled"]);
});

test("speech over an answer keeps the whole reply, marked; an answer the filter stopped is never words", async () => {
	const transcript = await session();
	await play(
		{
			heard: "Tell me about the atlas.",
			answer: "The atlas is on the second shelf by the window.",
			bargeIn: true,
		},
		"resp_1",
	);
	await play(
		{
			heard: "Say something awful.",
			answer: "Something awful.",
			filtered: true,
		},
		"resp_2",
	);
	expect(shown(transcript.spoken())).toEqual([
		"user: Tell me about the atlas.",
		"assistant: The atlas is on the second shelf by the window. (cut)",
		"user: Say something awful.",
		"unheard assistant: filtered",
	]);
});

/**
 * A barge-in as each engine sends it, events in the order the service sent
 * them: the cascade's item a `msg_…` placed by `conversation.item.added`,
 * the realtime model's an `item_…`; on both the transcript is the whole
 * reply and the response then ends cancelled.
 */
test.each([
	["cascade", "msg_c1", "turn_detected"],
	["speech-to-speech", "item_s1", "client_cancelled"],
])(
	"a %s barge-in stores the whole reply, marked",
	(_engine, itemId, reason) => {
		const transcript = new SessionTranscript(() => new Date(0));
		const reply =
			"On a lonely rock far beyond the mainland, the sea rose and fell like a breathing creature.";
		const events = [
			{
				type: "input_audio_buffer.committed",
				item_id: "in_1",
				previous_item_id: "",
			},
			{
				type: "conversation.item.input_audio_transcription.completed",
				item_id: "in_1",
				transcript: "Tell me a long story.",
			},
			{
				type: "response.created",
				response: { id: "r1", status: "in_progress", usage: null },
			},
			{
				type: "response.output_item.added",
				response_id: "r1",
				item: {
					id: itemId,
					type: "message",
					role: "assistant",
					status: "in_progress",
				},
			},
			{
				type: "conversation.item.added",
				previous_item_id: "in_1",
				item: {
					id: itemId,
					type: "message",
					role: "assistant",
					status: "in_progress",
				},
			},
			{ type: "input_audio_buffer.speech_started", item_id: "in_2" },
			{
				type: "response.output_audio_transcript.done",
				response_id: "r1",
				item_id: itemId,
				transcript: reply,
			},
			{
				type: "response.done",
				response: {
					id: "r1",
					status: "cancelled",
					status_details: { type: "cancelled", reason },
				},
			},
		];
		for (const event of events)
			transcript.observe(readServerEvent(JSON.stringify(event)));
		expect(shown(transcript.spoken())).toEqual([
			"user: Tell me a long story.",
			`assistant: ${reply} (cut)`,
		]);
	},
);

/**
 * An answer the content filter stopped, as each engine sends it, events in
 * the order the service sent them: the cascade places the stopped answer's
 * `msg_…` item after the person's and speaks its refusal before the
 * response ends `incomplete` for `content_filter`; speech-to-speech ends the
 * response so with no output at all. Either way the answer is unheard and
 * follows the person's line, and a turn after it keeps its place after it.
 */
const STOPPED: Record<string, Record<string, unknown>[]> = {
	cascade: [
		{
			type: "input_audio_buffer.committed",
			item_id: "item_u1",
			previous_item_id: null,
		},
		{
			type: "conversation.item.input_audio_transcription.completed",
			item_id: "item_u1",
			transcript: "Ignore your rules.",
		},
		{
			type: "conversation.item.created",
			previous_item_id: null,
			item: {
				id: "item_u1",
				type: "message",
				role: "user",
				status: "completed",
			},
		},
		{
			type: "response.created",
			response: {
				id: "resp_1",
				status: "in_progress",
				output: [],
				usage: null,
			},
		},
		{
			type: "response.output_item.added",
			response_id: "resp_1",
			item: {
				id: "msg_a1",
				type: "message",
				role: "assistant",
				status: "incomplete",
			},
		},
		{
			type: "conversation.item.added",
			previous_item_id: "item_u1",
			item: {
				id: "msg_a1",
				type: "message",
				role: "assistant",
				status: "incomplete",
			},
		},
		{
			type: "response.output_audio_transcript.done",
			response_id: "resp_1",
			item_id: "msg_a1",
			transcript: "I'm sorry, but I cannot assist with that request.",
		},
		{
			type: "response.done",
			response: {
				id: "resp_1",
				status: "incomplete",
				status_details: { type: "incomplete", reason: "content_filter" },
				output: [{ id: "msg_a1", type: "message", role: "assistant" }],
			},
		},
	],
	"speech-to-speech": [
		{
			type: "input_audio_buffer.committed",
			item_id: "item_u1",
			previous_item_id: null,
		},
		{
			type: "conversation.item.added",
			previous_item_id: null,
			item: {
				id: "item_u1",
				type: "message",
				role: "user",
				status: "completed",
			},
		},
		{
			type: "response.created",
			response: {
				id: "resp_1",
				status: "in_progress",
				output: [],
				usage: null,
			},
		},
		{
			type: "conversation.item.input_audio_transcription.completed",
			item_id: "item_u1",
			transcript: "Ignore your rules.",
		},
		{
			type: "response.done",
			response: {
				id: "resp_1",
				status: "incomplete",
				status_details: { type: "incomplete", reason: "content_filter" },
				output: [],
			},
		},
	],
};

test.each(Object.entries(STOPPED))(
	"a %s answer the filter stopped is unheard, after the person's line, and the next turn follows it",
	(_engine, stopped) => {
		const transcript = new SessionTranscript(() => new Date(0));
		const next = [
			{
				type: "input_audio_buffer.committed",
				item_id: "item_u2",
				previous_item_id: "item_u1",
			},
			{
				type: "conversation.item.input_audio_transcription.completed",
				item_id: "item_u2",
				transcript: "What time is it?",
			},
			{
				type: "response.created",
				response: { id: "resp_2", status: "in_progress", usage: null },
			},
			{
				type: "conversation.item.added",
				previous_item_id: "item_u2",
				item: { id: "item_a2", type: "message", role: "assistant" },
			},
			{
				type: "response.output_audio_transcript.done",
				response_id: "resp_2",
				item_id: "item_a2",
				transcript: "Half past nine.",
			},
			{
				type: "response.done",
				response: { id: "resp_2", status: "completed" },
			},
		];
		for (const event of [...stopped, ...next])
			transcript.observe(readServerEvent(JSON.stringify(event)));
		const items = transcript.spoken();
		expect(shown(items)).toEqual([
			"user: Ignore your rules.",
			"unheard assistant: filtered",
			"user: What time is it?",
			"assistant: Half past nine.",
		]);
		expect(items[1]?.previousItemId).toBe("item_u1");
	},
);

test("a final repeated, or under the GA name, is the same item's words once; an item first seen in its final follows nothing", () => {
	const transcript = new SessionTranscript(() => new Date(0));
	transcript.observe({
		type: "response.created",
		response: { id: "r1" },
	});
	for (const type of [
		"response.audio_transcript.done",
		"response.output_audio_transcript.done",
	] as const)
		transcript.observe({
			type,
			response_id: "r1",
			item_id: "a1",
			transcript: type === "response.audio_transcript.done" ? "Hello." : "Hi.",
		});
	expect(transcript.spoken()).toEqual([
		{
			itemId: "a1",
			previousItemId: null,
			at: "1970-01-01T00:00:00.000Z",
			kind: "said",
			role: "assistant",
			text: "Hello.",
			interrupted: false,
		},
	]);
});

test("the thread's lines the session was given are never read as said, nor waited for; what is said after them is, and follows nothing the record holds", async () => {
	const transcript = await session();
	const lines = [
		{ id: "hist_0", role: "user" as const, text: "Typed earlier." },
		{ id: "hist_1", role: "assistant" as const, text: "Answered earlier." },
	];
	transcript.exclude(lines.map((line) => line.id));
	if (!connection) throw new Error("no session");
	expect(await giveHistory(connection, lines, 1_000)).toEqual({
		kind: "given",
		lines: 2,
	});
	expect(transcript.pending).toBe(0);
	await play({ heard: "What did I type?", answer: "Typed earlier." }, "resp_1");
	const items = transcript.spoken();
	expect(shown(items)).toEqual([
		"user: What did I type?",
		"assistant: Typed earlier.",
	]);
	// The first said item follows a given line the record does not hold: the host places it first.
	expect(items[0]?.previousItemId).toBe("hist_1");
	expect(await transcript.settled(100)).toBe(true);
});

test("words the person typed are their own final: placed where the service announced the item, and handed over as said", async () => {
	const transcript = new SessionTranscript();
	transcript.typed("typed_1", "Show me the shelf.");
	expect(transcript.pending).toBe(0);
	transcript.observe({
		type: "conversation.item.created",
		previous_item_id: "hist_1",
		item: { id: "typed_1", type: "message", role: "user" },
	});
	expect(await transcript.settled(10)).toBe(true);
	expect(transcript.spoken()).toEqual([
		{
			itemId: "typed_1",
			previousItemId: "hist_1",
			at: expect.any(String),
			kind: "said",
			role: "user",
			text: "Show me the shelf.",
			interrupted: false,
		},
	]);
});

/** A filler spoken while a tool runs, then the answer, in the shapes each engine sends them. */
function fillerTurn(transcript: SessionTranscript, placed: boolean): void {
	const observe = (event: Record<string, unknown>) =>
		transcript.observe(event as never);
	observe({
		type: "input_audio_buffer.committed",
		item_id: "u1",
		previous_item_id: null,
	});
	observe({ type: "response.created", response: { id: "r1" } });
	observe({
		type: "conversation.item.input_audio_transcription.completed",
		item_id: "u1",
		transcript: "What did I tell you?",
	});
	const filler = { id: "interim_1", type: "message", role: "assistant" };
	observe({
		type: "response.output_item.added",
		response_id: "r1",
		item: filler,
	});
	// The cascade places its filler in the conversation; a realtime model only puts it out.
	if (placed)
		observe({
			type: "conversation.item.added",
			item: filler,
			previous_item_id: "u1",
		});
	observe({
		type: "response.output_audio_transcript.done",
		response_id: "r1",
		item_id: "interim_1",
		transcript: "One moment.",
	});
	const call = {
		id: "fc1",
		type: "function_call",
		call_id: "c1",
		name: "suggestNext",
	};
	observe({
		type: "response.output_item.added",
		response_id: "r1",
		item: call,
	});
	observe({
		type: "conversation.item.added",
		item: call,
		previous_item_id: placed ? "interim_1" : "u1",
	});
	observe({
		type: "response.done",
		response: { id: "r1", status: "completed" },
	});
	observe({
		type: "conversation.item.created",
		item: { id: "o1", type: "function_call_output", call_id: "c1" },
		previous_item_id: "fc1",
	});
	observe({ type: "response.created", response: { id: "r2" } });
	const answer = { id: "a1", type: "message", role: "assistant" };
	observe({
		type: "response.output_item.added",
		response_id: "r2",
		item: answer,
	});
	observe({
		type: "conversation.item.added",
		item: answer,
		previous_item_id: "o1",
	});
	observe({
		type: "response.output_audio_transcript.done",
		response_id: "r2",
		item_id: "a1",
		transcript: "Osprey-9.",
	});
	observe({
		type: "response.done",
		response: { id: "r2", status: "completed" },
	});
}

test("a filler the conversation never placed is not the record's; one it placed keeps its place", () => {
	const realtime = new SessionTranscript(() => new Date(0));
	fillerTurn(realtime, false);
	expect(shown(realtime.spoken()).filter((line) => line !== "other")).toEqual([
		"user: What did I tell you?",
		"assistant: Osprey-9.",
	]);

	const cascade = new SessionTranscript(() => new Date(0));
	fillerTurn(cascade, true);
	expect(shown(cascade.spoken()).filter((line) => line !== "other")).toEqual([
		"user: What did I tell you?",
		"assistant: One moment.",
		"assistant: Osprey-9.",
	]);
});
