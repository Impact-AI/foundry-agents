import { afterEach, beforeEach, expect, test } from "bun:test";
import { ModelNotConfiguredError } from "@platform/llm";
import { completion, configure, fakeAzure } from "@platform/llm/testing";
import { z } from "zod";
import { azureQueryDrafter } from "./azure";

/**
 * The drafter through llm's whole stack to the provider's one boundary, its
 * fetch: what reaches Azure OpenAI is the claim under test.
 */

const ACCOUNT = { AZURE_OPENAI_RESOURCE_NAME: "account-eu" };
const realLog = console.log;
let restore = () => {};

beforeEach(() => {
	// The usage line each call writes is llm's claim, asserted there.
	console.log = () => {};
});

afterEach(() => {
	console.log = realLog;
	restore();
});

test("the drafter sends the system, the prompt and the schema to the small deployment, under its output budget", async () => {
	restore = configure({
		...ACCOUNT,
		AZURE_OPENAI_SMALL_CHAT_DEPLOYMENT: "small-eu",
	});
	const { requests } = fakeAzure(() =>
		completion(JSON.stringify({ searchText: "x" })),
	);
	const schema = z.object({ searchText: z.string() });

	const draft = await azureQueryDrafter().draft({
		system: "S",
		prompt: "P",
		schema,
		abortSignal: AbortSignal.timeout(10_000),
	});

	expect(draft).toEqual({ searchText: "x" });
	expect(requests).toHaveLength(1);
	expect(requests[0]?.body).toMatchObject({
		model: "small-eu",
		input: [
			{ role: "developer", content: "S" },
			{ role: "user", content: [{ type: "input_text", text: "P" }] },
		],
		max_output_tokens: 800,
		text: { format: { type: "json_schema", strict: true } },
	});
});

test("the drafter has no deployment to borrow: without its own, it is the typed error, before any bytes leave", async () => {
	restore = configure({ ...ACCOUNT, AZURE_OPENAI_SMALL_CHAT_DEPLOYMENT: "" });
	const { requests } = fakeAzure(() => completion("{}"));
	const err = await azureQueryDrafter()
		.draft({
			system: "S",
			prompt: "P",
			schema: z.object({}),
			abortSignal: AbortSignal.timeout(10_000),
		})
		.catch((e: unknown) => e);
	expect(err).toBeInstanceOf(ModelNotConfiguredError);
	expect(requests).toHaveLength(0);
});
