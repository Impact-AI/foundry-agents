import { afterEach, beforeEach, expect, test } from "bun:test";
import { runInUsageScope, USAGE_EVENT } from "@platform/observability";
import { configure } from "../testing";
import { usageMiddleware } from "./middleware";

let lines: Record<string, unknown>[] = [];
const realLog = console.log;
let restore = () => {};

beforeEach(() => {
	lines = [];
	console.log = (arg: unknown) => {
		lines.push(JSON.parse(String(arg)));
	};
	restore = configure();
});

afterEach(() => {
	console.log = realLog;
	restore();
});

const MODEL = { provider: "azure.responses", modelId: "chat-deployment" };
const STOP = { unified: "stop", raw: "completed" };
const USAGE = {
	inputTokens: { total: 17_400, noCache: 12_800, cacheRead: 4_600 },
	outputTokens: { total: 380, text: 300, reasoning: 80 },
};

function generate(result: Record<string, unknown>) {
	// biome-ignore lint/style/noNonNullAssertion: both operations are defined.
	return usageMiddleware.wrapGenerate!({
		doGenerate: async () => result,
		doStream: async () => ({ stream: new ReadableStream() }),
		params: {},
		model: MODEL,
		// The middleware reads `usage`, `finishReason` and the two labels; the
		// fixture is kept to those rather than to a whole model.
	} as never) as Promise<unknown>;
}

function stream(parts: Record<string, unknown>[], delayMs = 0) {
	// biome-ignore lint/style/noNonNullAssertion: both operations are defined.
	return usageMiddleware.wrapStream!({
		doGenerate: async () => ({}),
		doStream: async () => ({
			stream: new ReadableStream({
				async start(controller) {
					for (const part of parts) {
						if (delayMs) await Bun.sleep(delayMs);
						controller.enqueue(part);
					}
					controller.close();
				},
			}),
			request: { body: "opaque" },
		}),
		params: {},
		model: MODEL,
	} as never) as unknown as Promise<{
		stream: ReadableStream<Record<string, unknown>>;
	}>;
}

async function drain(
	s: ReadableStream<Record<string, unknown>>,
): Promise<Record<string, unknown>[]> {
	const out: Record<string, unknown>[] = [];
	for await (const part of s) out.push(part);
	return out;
}

const TURN_PARTS = [
	{ type: "stream-start", warnings: [] },
	{ type: "reasoning-start", id: "r1" },
	{ type: "reasoning-delta", id: "r1", delta: "…" },
	{ type: "text-start", id: "t1" },
	{ type: "text-delta", id: "t1", delta: "Hello," },
	{ type: "text-end", id: "t1" },
	{ type: "finish", finishReason: STOP, usage: USAGE },
];

test("generate emits one line and returns the provider's result untouched", async () => {
	const result = await generate({
		content: [],
		finishReason: STOP,
		usage: USAGE,
	});
	expect(result).toEqual({ content: [], finishReason: STOP, usage: USAGE });
	expect(lines).toHaveLength(1);
	expect(lines[0]).toMatchObject({
		evt: USAGE_EVENT,
		kind: "chat",
		model: "chat-deployment",
		finishReason: "stop",
		inputTokens: 17_400,
		outputTokens: 380,
		totalTokens: 17_780,
		reasoningTokens: 80,
		cachedInputTokens: 4_600,
		ttftMs: null,
	});
	expect(typeof lines[0]?.durationMs).toBe("number");
});

test("a bare finish reason is read as well as the unified one", async () => {
	await generate({ content: [], finishReason: "length", usage: USAGE });
	await generate({ content: [], finishReason: { raw: "x" }, usage: USAGE });
	expect(lines[0]?.finishReason).toBe("length");
	expect(lines[1]?.finishReason).toBe("unknown");
});

test("stream emits one line and passes every part and the rest of the result through", async () => {
	const result = await stream(TURN_PARTS);
	expect(await drain(result.stream)).toEqual(TURN_PARTS);
	expect(lines).toHaveLength(1);
	expect(lines[0]).toMatchObject({
		finishReason: "stop",
		inputTokens: 17_400,
		outputTokens: 380,
	});
	expect((result as { request?: unknown }).request).toEqual({ body: "opaque" });
});

test("ttft is measured at the first content delta, before the total", async () => {
	const { stream: observed } = await stream(TURN_PARTS, 5);
	await drain(observed);
	const ttft = lines[0]?.ttftMs as number;
	const total = lines[0]?.durationMs as number;
	expect(typeof ttft).toBe("number");
	expect(ttft).toBeLessThan(total * 0.9);
});

test("a stream that ends without a finish part emits nothing", async () => {
	const { stream: observed } = await stream([
		{ type: "stream-start", warnings: [] },
		{ type: "error", error: "upstream 500" },
	]);
	await drain(observed);
	expect(lines).toHaveLength(0);
});

test("a throwing logger breaks neither generate nor stream", async () => {
	console.log = () => {
		throw new Error("stdout is gone");
	};
	const generated = (await generate({
		content: [],
		finishReason: STOP,
		usage: USAGE,
	})) as { finishReason: unknown };
	expect(generated.finishReason).toEqual(STOP);
	const { stream: observed } = await stream(TURN_PARTS);
	expect(await drain(observed)).toEqual(TURN_PARTS);
});

test("the scope stamps the line", async () => {
	await runInUsageScope({ turnId: "turn-9", surface: "web" }, () =>
		generate({ content: [], finishReason: STOP, usage: USAGE }),
	);
	expect(lines[0]).toMatchObject({ turnId: "turn-9", surface: "web" });
});
