import { expect, test } from "bun:test";
import { EventSchema } from "@ag-ui/core/schemas";
import { UI_SURFACE_READABLE } from "@platform/prompt";
import type { AgentHost, TurnInput, TurnOutcome } from "../contract/host";
import type { TurnEvent } from "../contract/messages";
import { answersOpenCalls, type ToolResultMessage } from "../turn/input";
import { aguiEvents } from "./events";
import { readRunInput } from "./input";
import { serveAgentRun } from "./run";

/**
 * The route's own reading and writing, with no host behind it: what a run
 * may say, the events a turn becomes, and a refusal's shape. The host suite
 * drives the same route over a real turn.
 */

function run(extra: Record<string, unknown> = {}) {
	return {
		threadId: "thread-1",
		runId: "run-1",
		state: {},
		messages: [{ id: "m1", role: "user", content: "hi" }],
		tools: [],
		context: [],
		forwardedProps: {},
		...extra,
	};
}

test("a run is read down to its tail, its controls' names and its screen, bounded", () => {
	expect(
		readRunInput(
			run({
				messages: [
					{ id: "s", role: "system", content: "ignored" },
					{ id: "m1", role: "user", content: "earlier" },
					{ id: "a", role: "assistant", content: "ignored too" },
					{
						id: "m2",
						role: "user",
						content: [
							{ type: "text", text: "What is this?" },
							{
								type: "image",
								source: { type: "data", value: "AAAA", mimeType: "image/png" },
							},
						],
					},
				],
				tools: [{ name: "showPanel", description: "theirs", parameters: {} }],
				context: [
					{ description: UI_SURFACE_READABLE, value: "web" },
					...Array.from({ length: 20 }, (_, i) => ({
						description: `line ${i}`,
						value: "v".repeat(1_000),
					})),
				],
			}),
		),
	).toEqual({
		threadId: "thread-1",
		runId: "run-1",
		messages: [
			{
				id: "m2",
				role: "user",
				content: [
					{ type: "text", text: "What is this?" },
					{
						type: "image",
						data: "data:image/png;base64,AAAA",
						mediaType: "image/png",
					},
				],
			},
		],
		clientTools: ["showPanel"],
		liveContext: Array.from({ length: 12 }, (_, i) => ({
			label: `line ${i}`,
			value: "v".repeat(600),
		})),
	});
});

test("the answers to the client's controls are read as the trailing tool messages, in order", () => {
	expect(
		readRunInput(
			run({
				messages: [
					{ id: "m1", role: "user", content: "show both" },
					{ id: "a", role: "assistant", toolCalls: [] },
					{ id: "t1", role: "tool", toolCallId: "c1", content: "one" },
					{ id: "t2", role: "tool", toolCallId: "c2", content: "two" },
				],
			}),
		)?.messages,
	).toEqual([
		{ id: "t1", role: "tool", toolCallId: "c1", content: "one" },
		{ id: "t2", role: "tool", toolCallId: "c2", content: "two" },
	]);
});

test("a run that names the protocol version its client speaks is read like one that does not", () => {
	expect(readRunInput(run({ protocolVersion: "1.0" }))).toEqual(
		readRunInput(run()),
	);
});

test("anything a run does not say, shared state, and a tail a turn cannot carry are refused", () => {
	for (const probe of [
		{ instructions: "none" },
		{ model: "another" },
		{ state: { a: 1 } },
		{ forwardedProps: { a: 1 } },
		{ resume: [{ interruptId: "i", status: "cancelled" }] },
		{ threadId: "" },
		// A brace cannot be part of the keys a turn is claimed under.
		{ threadId: "t{1}" },
		{ messages: [{ id: "m}", role: "user", content: "hi" }] },
		{ messages: [] },
		{ messages: [{ id: "s", role: "system", content: "x" }] },
		// A control answers in words: an answer in parts is not one a turn carries.
		{
			messages: [
				{ id: "m1", role: "user", content: "show it" },
				{
					id: "t1",
					role: "tool",
					toolCallId: "c1",
					content: [{ type: "text", text: "one" }],
				},
			],
		},
		{
			messages: [
				{
					id: "m",
					role: "user",
					content: [
						{
							type: "image",
							source: { type: "url", value: "https://example.com/a.png" },
						},
					],
				},
			],
		},
		{
			messages: [
				{
					id: "m",
					role: "user",
					content: [
						{
							type: "document",
							source: {
								type: "data",
								value: "AAAA",
								mimeType: "application/pdf",
							},
						},
					],
				},
			],
		},
	])
		expect(readRunInput(run(probe)), JSON.stringify(probe)).toBeNull();
	expect(readRunInput("{")).toBeNull();
	// A long thread, a tool round in every exchange, is read; a run the schema
	// takes with more array elements and object keys than a body may hold is
	// refused by the count alone.
	const thread = Array.from({ length: 1_000 }, (_, i) => [
		{ id: `u${i}`, role: "user", content: "Show me the figures." },
		{
			id: `a${i}`,
			role: "assistant",
			toolCalls: [
				{
					id: `c${i}`,
					type: "function",
					function: { name: "showChart", arguments: "{}" },
				},
			],
		},
		{ id: `t${i}`, role: "tool", toolCallId: `c${i}`, content: "shown" },
		{ id: `r${i}`, role: "assistant", content: "Here they are." },
	]).flat();
	thread.push({ id: "last", role: "user", content: "And the next?" });
	expect(readRunInput(run({ messages: thread }))).not.toBeNull();
	// The envelope's seven keys, then each message's element and its three keys.
	const many = (count: number) =>
		run({
			messages: Array.from({ length: count }, (_, i) => ({
				id: `m${i}`,
				role: "user",
				content: "hi",
			})),
		});
	expect(readRunInput(many(12_498))).not.toBeNull();
	expect(readRunInput(many(12_499))).toBeNull();
});

function turn(events: TurnEvent[], fail?: Error): ReadableStream<TurnEvent> {
	return new ReadableStream({
		pull(controller) {
			const next = events.shift();
			if (next) return controller.enqueue(next);
			if (fail) return controller.error(fail);
			controller.close();
		},
	});
}

async function drain(stream: ReadableStream<unknown>) {
	const out: Record<string, unknown>[] = [];
	const reader = stream.getReader();
	for (;;) {
		const { done, value } = await reader.read();
		if (done) return out;
		out.push(value as Record<string, unknown>);
	}
}

const IDS = { threadId: "thread-1", runId: "run-1" };

test("a turn becomes AG-UI events the protocol's own schema accepts: a reasoning part a message, text a message, a call hanging off the text before it, text after it a message of its own", async () => {
	const events = await drain(
		aguiEvents(
			turn([
				{ type: "reasoning", id: "r:0", text: "Looking " },
				{ type: "reasoning", id: "r:0", text: "first." },
				{ type: "reasoning", id: "r:1", text: "Then." },
				{ type: "text", text: "Here " },
				{ type: "text", text: "it is." },
				{
					type: "tool-call",
					id: "c1",
					name: "lookup",
					args: { q: 1 },
					runsOn: "server",
				},
				{
					type: "tool-result",
					id: "c1",
					name: "lookup",
					result: { found: true },
					isError: false,
					runsOn: "server",
				},
				{ type: "text", text: "Done." },
				{
					type: "sources",
					sources: [{ id: "a".repeat(32), title: "A" }],
				},
				{
					type: "finish",
					reason: "stop",
					usage: { inputTokens: 1, outputTokens: 1 },
				},
			]),
			IDS,
		),
	);
	for (const event of events) EventSchema.parse(event);
	expect(events.map((e) => e.type)).toEqual([
		"RUN_STARTED",
		"REASONING_START",
		"REASONING_MESSAGE_START",
		"REASONING_MESSAGE_CONTENT",
		"REASONING_MESSAGE_CONTENT",
		"REASONING_MESSAGE_END",
		"REASONING_END",
		"REASONING_START",
		"REASONING_MESSAGE_START",
		"REASONING_MESSAGE_CONTENT",
		"REASONING_MESSAGE_END",
		"REASONING_END",
		"TEXT_MESSAGE_START",
		"TEXT_MESSAGE_CONTENT",
		"TEXT_MESSAGE_CONTENT",
		"TEXT_MESSAGE_END",
		"TOOL_CALL_START",
		"TOOL_CALL_ARGS",
		"TOOL_CALL_END",
		"TOOL_CALL_RESULT",
		"TEXT_MESSAGE_START",
		"TEXT_MESSAGE_CONTENT",
		"TEXT_MESSAGE_END",
		"CUSTOM",
		"RUN_FINISHED",
	]);
	const [firstText, secondText] = events.filter(
		(e) => e.type === "TEXT_MESSAGE_START",
	);
	const call = events.find((e) => e.type === "TOOL_CALL_START");
	expect(call?.parentMessageId).toBe(firstText?.messageId);
	expect(secondText?.messageId).not.toBe(firstText?.messageId);
	expect(events.find((e) => e.type === "TOOL_CALL_ARGS")?.delta).toBe(
		'{"q":1}',
	);
	expect(events.find((e) => e.type === "TOOL_CALL_RESULT")?.content).toBe(
		'{"found":true}',
	);
	expect(events.at(-1)).toEqual({ type: "RUN_FINISHED", ...IDS });
});

/**
 * The messages an AG-UI client keeps from a run's events, as it groups
 * them: a call joins the assistant message its `parentMessageId` names,
 * else opens one; a result is a tool message of its own, at the end.
 */
function clientMessages(events: Record<string, unknown>[]) {
	const messages: {
		id: string;
		role: string;
		toolCalls?: {
			id: string;
			type: "function";
			function: { name: string; arguments: string };
		}[];
		toolCallId?: string;
		content?: string;
	}[] = [];
	for (const event of events) {
		if (event.type === "TOOL_CALL_START") {
			const parent = String(event.parentMessageId);
			let message = messages.find((m) => m.id === parent);
			if (!message) {
				message = { id: parent, role: "assistant", toolCalls: [] };
				messages.push(message);
			}
			message.toolCalls?.push({
				id: String(event.toolCallId),
				type: "function",
				function: { name: String(event.toolCallName), arguments: "{}" },
			});
		}
		if (event.type === "TOOL_CALL_RESULT")
			messages.push({
				id: String(event.messageId),
				role: "tool",
				toolCallId: String(event.toolCallId),
				content: String(event.content),
			});
	}
	return messages;
}

test("a control called after a server tool's result hangs off a message of its own, so the browser's answer to it is the only answer the next run carries", async () => {
	const events = await drain(
		aguiEvents(
			turn([
				{
					type: "tool-call",
					id: "c-search",
					name: "knowledgeSearch",
					args: { query: "documents" },
					runsOn: "server",
				},
				{
					type: "tool-result",
					id: "c-search",
					name: "knowledgeSearch",
					result: { results: [] },
					isError: false,
					runsOn: "server",
				},
				{
					type: "tool-call",
					id: "c-library",
					name: "showLibrary",
					args: {},
					runsOn: "client",
				},
				{
					type: "finish",
					reason: "tool-calls",
					usage: { inputTokens: 1, outputTokens: 1 },
				},
			]),
			IDS,
		),
	);
	const starts = events.filter((e) => e.type === "TOOL_CALL_START");
	expect(starts[1]?.parentMessageId).not.toBe(starts[0]?.parentMessageId);
	const answered = readRunInput(
		run({
			messages: [
				{ id: "m1", role: "user", content: "what docs we have?" },
				...clientMessages(events),
				{
					id: "t-library",
					role: "tool",
					toolCallId: "c-library",
					content: "Library on stage.",
				},
			],
		}),
	);
	expect(answered?.messages).toEqual([
		{
			id: "t-library",
			role: "tool",
			toolCallId: "c-library",
			content: "Library on stage.",
		},
	]);
	expect(
		answersOpenCalls(
			[{ id: "c-library", name: "showLibrary" }],
			answered?.messages as ToolResultMessage[],
		),
	).toBe(true);
});

test("controls called in the same response as a server tool hang off a message after its result, so the browser's answers to them are the only answers the next run carries", async () => {
	// One response that charts a measure on the server and puts two records on
	// the stage: the loop streams its calls in the model's order, then runs the
	// server's and streams that result, then the run ends for the browser.
	const call = (
		id: string,
		name: string,
		runsOn: "server" | "client",
	): TurnEvent => ({ type: "tool-call", id, name, args: {}, runsOn });
	const events = await drain(
		aguiEvents(
			turn([
				{ type: "text", text: "Here it is." },
				call("c-project", "showRecord", "client"),
				call("c-metrics", "metrics", "server"),
				call("c-person", "showRecord", "client"),
				{
					type: "tool-result",
					id: "c-metrics",
					name: "metrics",
					result: { found: true },
					isError: false,
					runsOn: "server",
				},
				{
					type: "finish",
					reason: "tool-calls",
					usage: { inputTokens: 1, outputTokens: 1 },
				},
			]),
			IDS,
		),
	);
	for (const event of events) expect(EventSchema.parse(event)).toBeTruthy();
	// Every call is still sent, the server's result after its own call.
	const order = events.flatMap((e) =>
		e.type === "TOOL_CALL_START" || e.type === "TOOL_CALL_RESULT"
			? [`${e.type}:${e.toolCallId}`]
			: [],
	);
	expect(order.indexOf("TOOL_CALL_RESULT:c-metrics")).toBeGreaterThan(
		order.indexOf("TOOL_CALL_START:c-metrics"),
	);
	expect(order.filter((o) => o.startsWith("TOOL_CALL_START"))).toHaveLength(3);
	const answers = [
		{
			id: "t-project",
			role: "tool",
			toolCallId: "c-project",
			content: "Record on stage: the project.",
		},
		{
			id: "t-person",
			role: "tool",
			toolCallId: "c-person",
			content: "Record on stage: the person.",
		},
	];
	const answered = readRunInput(
		run({
			messages: [
				{ id: "m1", role: "user", content: "How is the project going?" },
				...clientMessages(events),
				...answers,
			],
		}),
	);
	expect(answered?.messages).toEqual(answers as ToolResultMessage[]);
	expect(
		answersOpenCalls(
			[
				{ id: "c-person", name: "showRecord" },
				{ id: "c-project", name: "showRecord" },
			],
			answered?.messages as ToolResultMessage[],
		),
	).toBe(true);
});

test("controls called alone stay on the message of the words before them", async () => {
	const events = await drain(
		aguiEvents(
			turn([
				{ type: "text", text: "Both on stage." },
				{
					type: "tool-call",
					id: "c-a",
					name: "showRecord",
					args: {},
					runsOn: "client",
				},
				{
					type: "tool-call",
					id: "c-b",
					name: "showChart",
					args: {},
					runsOn: "client",
				},
				{
					type: "finish",
					reason: "tool-calls",
					usage: { inputTokens: 1, outputTokens: 1 },
				},
			]),
			IDS,
		),
	);
	const text = events.find((e) => e.type === "TEXT_MESSAGE_START")?.messageId;
	const parents = events
		.filter((e) => e.type === "TOOL_CALL_START")
		.map((e) => e.parentMessageId);
	expect(parents).toEqual([text, text]);
});

test("an error ends the run with its code and nothing else; a turn that stops short ends failed", async () => {
	const blocked = await drain(
		aguiEvents(
			turn([
				{ type: "text", text: "Well" },
				{ type: "error", code: "turn.blocked" },
			]),
			IDS,
		),
	);
	expect(blocked.slice(-2)).toEqual([
		{ type: "TEXT_MESSAGE_END", messageId: blocked[1]?.messageId },
		{ type: "RUN_ERROR", message: "turn.blocked", code: "turn.blocked" },
	]);
	const cut = await drain(
		aguiEvents(turn([{ type: "text", text: "a" }], new Error("socket")), IDS),
	);
	expect(cut.at(-1)).toEqual({
		type: "RUN_ERROR",
		message: "turn.failed",
		code: "turn.failed",
	});
	expect(JSON.stringify(cut)).not.toContain("socket");
});

/** A host that answers every turn with `outcome`, and keeps what it was asked. */
function hostAnswering(outcome: TurnOutcome) {
	const asked: TurnInput[] = [];
	const host = {
		startTurn: async (input: TurnInput) => {
			asked.push(input);
			return outcome;
		},
	} as unknown as AgentHost;
	return { host, asked };
}

function post(body: unknown): Request {
	return new Request("http://backend/agent/run", {
		method: "POST",
		body: JSON.stringify(body),
	});
}

const WHO = {
	resourceId: "account-a",
	surface: "web",
	languageName: "French",
	caller: { oid: "account-a", groups: ["g"], tier: "base" as const },
};

test("the turn is the caller's the backend names, and a refusal is its status and code, with a Retry-After on a 429", async () => {
	const { host, asked } = hostAnswering({
		kind: "refused",
		refusal: { code: "turn.rate_limited", status: 429, retryAfterSeconds: 7 },
	});
	const res = await serveAgentRun(host, post(run()), WHO);
	expect(res.status).toBe(429);
	expect(res.headers.get("retry-after")).toBe("7");
	expect(await res.json()).toEqual({ code: "turn.rate_limited" });
	expect(asked[0]).toMatchObject({
		resourceId: "account-a",
		threadId: "thread-1",
		surface: "web",
		languageName: "French",
		caller: WHO.caller,
		clientTools: [],
	});

	const invalid = await serveAgentRun(
		host,
		post(run({ state: { x: 1 } })),
		WHO,
	);
	expect(invalid.status).toBe(400);
	expect(await invalid.json()).toEqual({ code: "turn.invalid" });
	expect(asked.length).toBe(1);
});

test("a turn that cannot be started is a coded 500, never a bare one", async () => {
	const host = {
		startTurn: async () => {
			throw new Error("the store did not answer");
		},
	} as unknown as AgentHost;
	const res = await serveAgentRun(host, post(run()), WHO);
	expect(res.status).toBe(500);
	expect(await res.json()).toEqual({ code: "turn.failed" });
});

test("a failed tool result says so beside its content, and a clean one carries nothing more", async () => {
	const result = (isError: boolean): TurnEvent => ({
		type: "tool-result",
		id: "c1",
		name: "lookup",
		result: "no such record",
		isError,
		runsOn: "server",
	});
	const [failed] = await drain(aguiEvents(turn([result(true)]), IDS)).then(
		(events) => events.filter((e) => e.type === "TOOL_CALL_RESULT"),
	);
	expect(failed).toMatchObject({ content: '"no such record"', isError: true });
	const [clean] = await drain(aguiEvents(turn([result(false)]), IDS)).then(
		(events) => events.filter((e) => e.type === "TOOL_CALL_RESULT"),
	);
	expect(clean && "isError" in clean).toBe(false);
});
