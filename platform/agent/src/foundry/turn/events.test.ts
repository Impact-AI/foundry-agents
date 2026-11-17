import { afterAll, beforeAll, expect, spyOn, test } from "bun:test";
import type { TurnEvent } from "../../contract/messages";
import { problems } from "../../keys";
import { readResponse, type StreamEvent } from "./events";

/**
 * How a response ends, read from the stream alone: the ways the service
 * says it filtered, failed or stopped short, which the stand-in's scripted
 * answers do not all reach.
 */

const quiet: ReturnType<typeof spyOn>[] = [];
beforeAll(() => {
	quiet.push(spyOn(console, "warn").mockImplementation(() => {}));
	quiet.push(spyOn(console, "error").mockImplementation(() => {}));
});
afterAll(() => {
	for (const q of quiet) q.mockRestore();
});

async function* stream(events: StreamEvent[], thenThrow?: Error) {
	for (const event of events) yield event;
	if (thenThrow) throw thenThrow;
}

async function read(
	events: StreamEvent[],
	thenThrow?: Error,
	signal?: AbortSignal,
) {
	const emitted: TurnEvent[] = [];
	const result = await readResponse(stream(events, thenThrow), {
		emit: (e) => emitted.push(e),
		runsOn: () => "server",
		signal,
	});
	return { result, emitted };
}

const call = {
	type: "function_call",
	id: "fc_1",
	call_id: "call_1",
	name: "shelf",
	arguments: '{"title":"Atlas"}',
};

test("a call announced as its item completes is not announced again by the completed response", async () => {
	const { result, emitted } = await read([
		{ type: "response.created", response: { id: "resp_1" } },
		{ type: "response.output_item.done", item: call },
		{
			type: "response.completed",
			response: {
				id: "resp_1",
				output: [call],
				usage: { input_tokens: 7, output_tokens: 2 },
			},
		},
	]);
	expect(emitted).toEqual([
		{
			type: "tool-call",
			id: "call_1",
			name: "shelf",
			args: { title: "Atlas" },
			runsOn: "server",
		},
	]);
	expect(result).toMatchObject({
		responseId: "resp_1",
		calls: [{ callId: "call_1", name: "shelf" }],
		usage: { inputTokens: 7, outputTokens: 2 },
		end: { kind: "completed", reason: "stop" },
	});
});

test("the filter refusing on the way out, as a failure or a stop, is a block; anything else is a failure", async () => {
	for (const ending of [
		{
			type: "response.failed",
			response: { id: "r", error: { code: "content_filter", message: "x" } },
		},
		{
			type: "response.incomplete",
			response: { id: "r", incomplete_details: { reason: "content_filter" } },
		},
	])
		expect((await read([ending])).result.end).toEqual({
			kind: "failed",
			event: { type: "error", code: "turn.blocked" },
		});
	for (const events of [
		[
			{
				type: "response.failed",
				response: { id: "r", error: { code: "server_error" } },
			},
		],
		[{ type: "error", code: "rate_limit_exceeded", message: "slow down" }],
		[{ type: "response.output_text.delta", delta: "half an ans" }],
	])
		expect((await read(events)).result.end).toEqual({
			kind: "failed",
			event: { type: "error", code: "turn.failed" },
		});
	expect(
		(await read([], new Error("socket hang up"))).result.end,
	).toMatchObject({
		kind: "failed",
	});
	expect(
		(
			await read([
				{
					type: "response.incomplete",
					response: {
						id: "r",
						incomplete_details: { reason: "max_output_tokens" },
					},
				},
			])
		).result.end,
	).toEqual({ kind: "completed", reason: "length" });
});

test("the pages the words cite are collected once each, for a reader that asks for them, and a reader that does not is handed none", async () => {
	const cite = (url: string, title: string): StreamEvent => ({
		type: "response.output_text.annotation.added",
		annotation: { type: "url_citation", url, title },
	});
	const events: StreamEvent[] = [
		{ type: "response.created", response: { id: "resp_1" } },
		cite("https://example.org/a", "A"),
		cite("https://example.org/a", "A again"),
		{
			type: "response.output_text.annotation.added",
			annotation: { type: "file_citation", file_id: "f" },
		},
		cite("https://example.org/b", "B"),
		{
			type: "response.completed",
			response: {
				id: "resp_1",
				output: [],
				usage: { input_tokens: 1, output_tokens: 1 },
			},
		},
	];
	const cited: { url: string; title: string }[] = [];
	await readResponse(stream(events), {
		cited,
		emit: () => {},
		runsOn: () => "service",
	});
	expect(cited).toEqual([
		{ url: "https://example.org/a", title: "A" },
		{ url: "https://example.org/b", title: "B" },
	]);
	const unread = await readResponse(stream(events), {
		emit: () => {},
		runsOn: () => "service",
	});
	expect(unread.end).toEqual({ kind: "completed", reason: "stop" });
});

const reasoning = {
	type: "reasoning",
	id: "rs_1",
	encrypted_content: "opaque",
	summary: [],
};

test("a stream that breaks after a reasoning item carries no reasoning without what it led to, and keeps what came before it", async () => {
	const { result } = await read(
		[
			{ type: "response.created", response: { id: "resp_1" } },
			{ type: "response.output_item.done", item: reasoning },
			{ type: "response.output_item.done", item: call },
			{
				type: "response.output_item.done",
				item: { ...reasoning, id: "rs_2" },
			},
			{ type: "response.output_text.delta", delta: "Half an ans" },
		],
		new Error("the connection dropped"),
	);
	expect(result.end.kind).toBe("failed");
	expect(result.items.map((item) => item.type)).toEqual([
		"reasoning",
		"function_call",
	]);
});

test("a stream its caller stopped ends the run without a problem reported; one that broke by itself reports the failure", async () => {
	const reported = spyOn(problems, "report");
	const info = spyOn(console, "info").mockImplementation(() => {});
	try {
		const stop = new AbortController();
		stop.abort();
		const stopped = await read(
			[{ type: "response.created", response: { id: "resp_1" } }],
			new Error("aborted"),
			stop.signal,
		);
		expect(stopped.result.end).toEqual({
			kind: "failed",
			event: { type: "error", code: "turn.failed" },
		});
		expect(reported).not.toHaveBeenCalled();
		await read([], new Error("the connection dropped"));
		expect(reported.mock.calls.map(([code]) => code)).toEqual([
			"agent.turn.failed",
		]);
	} finally {
		reported.mockRestore();
		info.mockRestore();
	}
});

test("the answer is kept as it was shown: without the citation markers the stream took out", async () => {
	const { result, emitted } = await read([
		{ type: "response.created", response: { id: "resp_1" } },
		{
			type: "response.output_text.delta",
			delta: "Rain tomorrow【6:0†source】.",
		},
		{
			type: "response.output_item.done",
			item: {
				type: "message",
				id: "msg_1",
				role: "assistant",
				content: [
					{ type: "output_text", text: "Rain tomorrow【6:0†source】." },
				],
			},
		},
		{ type: "response.completed", response: { id: "resp_1", output: [] } },
	]);
	expect(emitted).toEqual([{ type: "text", text: "Rain tomorrow." }]);
	expect(result.items).toEqual([
		{ type: "message", role: "assistant", content: "Rain tomorrow." },
	]);
});
