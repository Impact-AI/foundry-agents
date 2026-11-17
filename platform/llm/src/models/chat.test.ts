import { afterEach, beforeEach, expect, test } from "bun:test";
import { generateText } from "ai";
import { ModelNotConfiguredError } from "../model-roles";
import { completion, configure, fakeAzure, refusal } from "../testing";
import { smallChatModel } from "./chat";
import { reasoningOptions } from "./reasoning";

let lines: Record<string, unknown>[] = [];
const realLog = console.log;
let restore = () => {};

beforeEach(() => {
	lines = [];
	console.log = (arg: unknown) => {
		lines.push(JSON.parse(String(arg)));
	};
});

afterEach(() => {
	console.log = realLog;
	restore();
});

const ACCOUNT = { AZURE_OPENAI_RESOURCE_NAME: "account-eu" };

test("the small model is its own slot and never borrows the chat deployment", async () => {
	restore = configure({ ...ACCOUNT, AZURE_OPENAI_CHAT_DEPLOYMENT: "chat-eu" });
	const err = await smallChatModel().catch((e: unknown) => e);
	expect(err).toBeInstanceOf(ModelNotConfiguredError);
	expect((err as ModelNotConfiguredError).role).toBe("smallChat");
	expect((err as Error).message).toContain(
		"AZURE_OPENAI_SMALL_CHAT_DEPLOYMENT",
	);
});

test("a turn reaches the deployment with the token, survives a throttle, and is counted once", async () => {
	restore = configure({
		...ACCOUNT,
		AZURE_OPENAI_SMALL_CHAT_DEPLOYMENT: "small-eu",
	});
	let calls = 0;
	const { requests } = fakeAzure(() =>
		++calls === 1
			? refusal(429, { "retry-after-ms": "1" })
			: completion("hello"),
	);

	const { text } = await generateText({
		model: await smallChatModel(),
		prompt: "hi",
		maxRetries: 0,
	});

	expect(text).toBe("hello");
	expect(requests).toHaveLength(2);
	for (const request of requests) {
		expect(request.url).toStartWith(
			"https://account-eu.openai.azure.com/openai/v1/responses",
		);
		expect(request.headers.authorization).toBe("Bearer token-1");
		expect(request.body.model).toBe("small-eu");
	}
	expect(lines).toHaveLength(1);
	expect(lines[0]).toMatchObject({
		evt: "llm_usage",
		kind: "chat",
		model: "small-eu",
		inputTokens: 10,
		outputTokens: 3,
	});
});

// The deployed `small` dropped the effort with "reasoningEffort is not
// supported for non-reasoning models": the provider guessed from the name.
test("the reasoning cap reaches the request for a deployment named for its role", async () => {
	restore = configure({
		...ACCOUNT,
		AZURE_OPENAI_SMALL_CHAT_DEPLOYMENT: "small",
	});
	const { requests } = fakeAzure(() => completion("ok"));

	const { warnings } = await generateText({
		model: await smallChatModel(),
		system: "be brief",
		prompt: "hi",
		maxRetries: 0,
		providerOptions: reasoningOptions("low"),
	});

	const body = requests[0]?.body as {
		reasoning?: unknown;
		input?: unknown[];
	};
	expect(body.reasoning).toMatchObject({ effort: "low" });
	expect(body.input?.[0]).toMatchObject({ role: "developer" });
	expect(warnings ?? []).toEqual([]);
});
