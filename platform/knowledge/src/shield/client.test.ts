import { afterEach, expect, test } from "bun:test";
import { configure, recordRequests, TOKEN } from "@platform/llm/testing";
import { azureShield } from "./client";

/**
 * Prompt Shields through the provider's one boundary, its fetch: what
 * reaches the account is the claim under test — the host, the version, the
 * token, the documents — and what a refusal or a short answer does.
 */

let restore = () => {};
afterEach(() => restore());

const answer = (analysis: boolean[]) =>
	Response.json({
		userPromptAnalysis: { attackDetected: false },
		documentsAnalysis: analysis.map((attackDetected) => ({ attackDetected })),
	});

test("the documents go to the account's own host as documents, with the process's token, and each verdict comes back in order", async () => {
	restore = configure({ AZURE_OPENAI_RESOURCE_NAME: "account-eu" });
	const { requests } = recordRequests(() => answer([false, true]));
	expect(await azureShield().scan(["fine", "an attack"])).toEqual([
		false,
		true,
	]);
	expect(requests).toHaveLength(1);
	expect(requests[0]).toMatchObject({
		method: "POST",
		url: "https://account-eu.cognitiveservices.azure.com/contentsafety/text:shieldPrompt?api-version=2024-09-01",
		headers: { authorization: `Bearer ${TOKEN}` },
		body: { documents: ["fine", "an attack"] },
	});
});

test("nothing to read asks nothing", async () => {
	restore = configure({ AZURE_OPENAI_RESOURCE_NAME: "account-eu" });
	const { requests } = recordRequests(() => answer([]));
	expect(await azureShield().scan([])).toEqual([]);
	expect(requests).toHaveLength(0);
});

test("a throttled request is asked again, as the account said to; a refusal of the request is not", async () => {
	restore = configure({ AZURE_OPENAI_RESOURCE_NAME: "account-eu" });
	let calls = 0;
	recordRequests(() =>
		++calls === 1
			? new Response("slow down", {
					status: 429,
					headers: { "retry-after-ms": "1" },
				})
			: answer([false]),
	);
	expect(await azureShield().scan(["fine"])).toEqual([false]);
	expect(calls).toBe(2);

	calls = 0;
	recordRequests(() => {
		calls++;
		return new Response('{"error":{"code":"InvalidRequestBody"}}', {
			status: 400,
		});
	});
	await expect(azureShield().scan(["fine"])).rejects.toThrow(
		"Prompt Shields answered 400",
	);
	expect(calls).toBe(1);
});

test("an answer that does not account for every document is an error, never a pass", async () => {
	restore = configure({ AZURE_OPENAI_RESOURCE_NAME: "account-eu" });
	recordRequests(() => answer([false]));
	await expect(azureShield().scan(["one", "two"])).rejects.toThrow(
		"answered for 1 of 2 documents",
	);
});
