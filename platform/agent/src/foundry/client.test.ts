import { afterEach, expect, test } from "bun:test";
import {
	resetAppConfigClient,
	resetAzureCredential,
	setAppConfigClient,
	setAzureCredential,
} from "@platform/config";
import { resetLlmSettings, setProviderFetch } from "@platform/llm";
import { scopedEnv } from "@platform/test-support";
import { projectClient, resetFoundryClients } from "./client";

/**
 * The project client's own retries: a 429 that names no wait is asked again
 * on the model calls' schedule, where the SDK's retries leave it as one
 * refusal. A memory store throttled by the model behind it answers so, and
 * an erasure stopped part way on it.
 */

const ENDPOINT = "https://account.services.ai.azure.com/api/projects/project";
const restores: (() => void)[] = [];

afterEach(() => {
	for (const restore of restores.splice(0).reverse()) restore();
	resetFoundryClients();
	setProviderFetch(fetch);
	resetAppConfigClient();
	resetAzureCredential();
	resetLlmSettings();
});

/** The project behind a fetch answering `statuses` in turn, then 200; and the requests it saw. */
function project(statuses: number[]) {
	const seen: string[] = [];
	restores.push(
		scopedEnv({
			FOUNDRY_PROJECT_ENDPOINT: ENDPOINT,
			APP_CONFIG_ENDPOINT: "https://store.test",
		}),
	);
	setAzureCredential({
		getToken: async () => ({
			token: "token",
			expiresOnTimestamp: Date.now() + 3_600_000,
		}),
	});
	// A schedule whose waits are a millisecond, so the test does not sleep through it.
	setAppConfigClient({
		getConfigurationSetting: async ({ key }: { key: string }) => {
			if (!key.endsWith("llm"))
				throw Object.assign(new Error("not found"), { statusCode: 404 });
			return {
				key,
				etag: "1",
				value: JSON.stringify({
					retry: { maxRetries: 2, initialDelayMs: 1 },
				}),
			};
		},
	} as unknown as Parameters<typeof setAppConfigClient>[0]);
	resetLlmSettings();
	resetFoundryClients();
	setProviderFetch(async (input, init) => {
		seen.push(`${init?.method} ${new URL(String(input)).pathname}`);
		const next = statuses.shift();
		if (next !== undefined)
			return new Response(
				JSON.stringify({
					error: { code: "rate_limit_exceeded", message: "throttled" },
				}),
				{ status: next, headers: { "content-type": "application/json" } },
			);
		return new Response(
			JSON.stringify({ object: "memory_store.scope.deleted", deleted: true }),
			{ status: 200, headers: { "content-type": "application/json" } },
		);
	});
	return seen;
}

test("a 429 that names no wait is asked again, and the call succeeds", async () => {
	const seen = project([429]);
	await projectClient().beta.memoryStores.deleteScope("store", "person");
	expect(seen).toEqual([
		"POST /api/projects/project/memory_stores/store:delete_scope",
		"POST /api/projects/project/memory_stores/store:delete_scope",
	]);
});

test("the schedule's attempts are the bound: a 429 that never clears fails the call", async () => {
	const seen = project([429, 429, 429]);
	await expect(
		projectClient().beta.memoryStores.deleteScope("store", "person"),
	).rejects.toMatchObject({ statusCode: 429 });
	expect(seen).toHaveLength(3);
});
