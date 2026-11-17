import { afterEach, expect, test } from "bun:test";
import {
	qualifyKey,
	resetAppConfigClient,
	setAppConfigClient,
} from "@platform/config";
import { DEFAULT_RETRY_SCHEDULE } from "./bounds/retry";
import {
	cachedLlmSettings,
	DEFAULT_LLM_SETTINGS,
	EMBEDDING_DIMENSIONS_VAR,
	LLM_SETTINGS_KEY,
	llmSettings,
	llmSettingsFromEnvironment,
	parseLlmSettings,
} from "./config";
import { configure } from "./testing";

let restore = () => {};

afterEach(() => {
	resetAppConfigClient();
	restore();
});

const DEFAULTS = { ...DEFAULT_LLM_SETTINGS, deployments: { chat: "chat-eu" } };

test("the environment names the deployments and nothing else", () => {
	restore = configure({
		AZURE_OPENAI_CHAT_DEPLOYMENT: " chat-eu ",
		AZURE_OPENAI_EMBEDDING_DEPLOYMENT: "",
	});
	const settings = llmSettingsFromEnvironment();
	expect(settings.deployments).toEqual({ chat: "chat-eu" });
	expect(settings.retry).toEqual(DEFAULT_RETRY_SCHEDULE);
	expect(settings.concurrency).toEqual(DEFAULT_LLM_SETTINGS.concurrency);
});

test("a stored document is merged over the defaults field by field, and its deployments section names nothing", () => {
	const settings = parseLlmSettings(
		{
			deployments: { chat: "chat-store", embedding: "embed-eu" },
			retry: { maxRetries: 0, backoffFactor: 1.5 },
			concurrency: { chat: 32 },
			embeddings: { dimensions: 1536 },
		},
		DEFAULTS,
	);
	expect(settings.deployments).toEqual({ chat: "chat-eu" });
	expect(settings.retry).toEqual({
		...DEFAULT_RETRY_SCHEDULE,
		maxRetries: 0,
		backoffFactor: 1.5,
	});
	expect(settings.concurrency).toEqual({
		...DEFAULT_LLM_SETTINGS.concurrency,
		chat: 32,
	});
});

test("the embedding width is the environment's: a stored width, which the index could not follow, is ignored", () => {
	restore = configure({ [EMBEDDING_DIMENSIONS_VAR]: "1536" });
	const fromEnvironment = llmSettingsFromEnvironment();
	expect(fromEnvironment.embeddings.dimensions).toBe(1536);
	const settings = parseLlmSettings(
		{ embeddings: { dimensions: 3072 } },
		fromEnvironment,
	);
	expect(settings.embeddings).toEqual({ dimensions: 1536 });
});

test("a field of the wrong shape keeps the default, so a portal edit can remove no bound", () => {
	const settings = parseLlmSettings(
		{
			retry: { maxRetries: -1, initialDelayMs: "2000", backoffFactor: 0.5 },
			concurrency: { chat: 0, smallChat: 2.5 },
			embeddings: { dimensions: 0 },
			deployments: "chat-eu",
		},
		DEFAULTS,
	);
	expect(settings).toEqual(DEFAULTS);
	// No retry is a schedule; a budget past ten further attempts is not one.
	expect(
		parseLlmSettings({ retry: { maxRetries: 0 } }, DEFAULTS).retry.maxRetries,
	).toBe(0);
	expect(
		parseLlmSettings({ retry: { maxRetries: 11 } }, DEFAULTS).retry.maxRetries,
	).toBe(DEFAULTS.retry.maxRetries);
	expect(parseLlmSettings("not a document", DEFAULTS)).toEqual(DEFAULTS);
	expect(parseLlmSettings(null, DEFAULTS)).toEqual(DEFAULTS);
});

test("without a store the settings are the environment's, with no warning", async () => {
	restore = configure({ AZURE_OPENAI_CHAT_DEPLOYMENT: "chat-eu" });
	const warnings: unknown[] = [];
	const warn = console.warn;
	console.warn = (...args: unknown[]) => warnings.push(args);
	try {
		expect((await llmSettings()).deployments).toEqual({ chat: "chat-eu" });
		expect(cachedLlmSettings().deployments).toEqual({ chat: "chat-eu" });
	} finally {
		console.warn = warn;
	}
	expect(warnings).toEqual([]);
});

test("the store's document retunes a bound at the memo's pace and never renames a deployment", async () => {
	restore = configure({
		APP_CONFIG_ENDPOINT: "https://store.test",
		AZURE_OPENAI_CHAT_DEPLOYMENT: "chat-eu",
	});
	setAppConfigClient({
		getConfigurationSetting: async ({ key }: { key: string }) => {
			expect(key).toBe(qualifyKey(LLM_SETTINGS_KEY));
			return {
				key,
				etag: "1",
				value: JSON.stringify({
					deployments: { chat: "chat-eu-2", smallChat: "small-eu" },
					concurrency: { chat: 4 },
				}),
			};
		},
	} as unknown as Parameters<typeof setAppConfigClient>[0]);

	const settings = await llmSettings();
	expect(settings.deployments).toEqual({ chat: "chat-eu" });
	expect(settings.concurrency.chat).toBe(4);
	expect(cachedLlmSettings().concurrency.chat).toBe(4);
});
