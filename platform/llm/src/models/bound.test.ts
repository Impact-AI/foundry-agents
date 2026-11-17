import { afterEach, beforeEach, expect, test } from "bun:test";
import { APICallError } from "ai";
import { MockLanguageModelV4 } from "ai/test";
import { createLimiter } from "../bounds/limiter";
import { configure } from "../testing";
import { boundLanguageModel, roleLimiter } from "./bound";

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

type GenerateResult = Awaited<ReturnType<MockLanguageModelV4["doGenerate"]>>;

const COMPLETION: GenerateResult = {
	content: [{ type: "text", text: "ok" }],
	finishReason: { unified: "stop", raw: "stop" },
	usage: {
		inputTokens: {
			total: 10,
			noCache: 10,
			cacheRead: undefined,
			cacheWrite: undefined,
		},
		outputTokens: { total: 2, text: 2, reasoning: undefined },
	},
	warnings: [],
};

const CALL = { prompt: [] } as unknown as Parameters<
	MockLanguageModelV4["doGenerate"]
>[0];

function throttled(): APICallError {
	return new APICallError({
		message: "HTTP 429",
		url: "https://account.openai.azure.com/openai/v1/responses",
		requestBodyValues: {},
		statusCode: 429,
	});
}

test("a refused attempt is retried outside the cap and the usage line counts only the answer", async () => {
	const limiter = createLimiter(() => 1);
	let calls = 0;
	let activeDuringCall = 0;
	const model = boundLanguageModel(
		new MockLanguageModelV4({
			provider: "azure.responses",
			modelId: "chat-eu",
			doGenerate: async () => {
				calls++;
				activeDuringCall = limiter.active;
				if (calls === 1) throw throttled();
				return COMPLETION;
			},
		}),
		{ limiter, retry: { initialDelayMs: 1 } },
	);

	const result = await model.doGenerate(CALL);

	expect(result.finishReason.unified).toBe("stop");
	expect(calls).toBe(2);
	expect(activeDuringCall).toBe(1);
	expect(limiter.active).toBe(0);
	expect(lines).toHaveLength(1);
	expect(lines[0]).toMatchObject({
		kind: "chat",
		provider: "azure.responses",
		model: "chat-eu",
		inputTokens: 10,
		outputTokens: 2,
	});
});

test("each role has one limiter for the process, and no two roles share one", () => {
	expect(roleLimiter("chat")).toBe(roleLimiter("chat"));
	expect(roleLimiter("chat")).not.toBe(roleLimiter("smallChat"));
});
