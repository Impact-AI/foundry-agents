import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { resetAppConfigClient, setAppConfigClient } from "@platform/config";
import { resetBlobService } from "@platform/storage";
import { scopedEnv } from "@platform/test-support";
import {
	AccessSettingsUnreadError,
	resetAccessSettings,
} from "../config/access";
import { resetKnowledgeSettings } from "../config/knowledge";
import {
	resetSearchClients,
	searchIndexClient,
	searchRestWriter,
} from "../index/client";
import { stagedSettings } from "../testing/fake-config";
import { PIPELINE_ENV, standInKnowledge } from "../testing/index";
import {
	KNOWLEDGE_BASE_PREVIEW_API_VERSION,
	knowledgeBaseDefinition,
	knowledgeBasePlanner,
	knowledgeBaseRetrieveUrl,
	knowledgeBaseUrl,
	knowledgeSourceDefinition,
} from "./definition";
import {
	knowledgeBaseRetrieval,
	PLANNER_UNCONFIGURED,
	resetRetrievalEngineReports,
	retrievalEngine,
} from "./engine";
import { ensureKnowledgeBase } from "./ensure";

let restoreEnv = () => {};
let restoreSettings = () => {};
beforeEach(() => {
	restoreEnv = scopedEnv({
		...PIPELINE_ENV,
		AZURE_SEARCH_ENDPOINT: "https://svc.search.windows.net",
		AZURE_SEARCH_INDEX: undefined,
		APP_CONFIG_ENDPOINT: undefined,
	});
	restoreSettings = stagedSettings({});
	resetRetrievalEngineReports();
});
afterEach(() => {
	restoreSettings();
	restoreEnv();
	resetSearchClients();
	resetBlobService();
});

test("the source wraps the one index as it is, and the base holds that one source", () => {
	expect(knowledgeSourceDefinition()).toEqual({
		name: "chunks-source",
		kind: "searchIndex",
		searchIndexParameters: {
			searchIndexName: "chunks",
			semanticConfigurationName: "chunks-semantic",
			searchFields: [
				{ name: "title" },
				{ name: "summary" },
				{ name: "chunk" },
				{ name: "tags" },
			],
			sourceDataFields: [
				{ name: "chunkId" },
				{ name: "documentId" },
				{ name: "path" },
				{ name: "kind" },
				{ name: "title" },
				{ name: "summary" },
				{ name: "tags" },
				{ name: "chunk" },
			],
		},
	});
	expect(knowledgeBaseDefinition()).toEqual({
		name: "chunks-kb",
		knowledgeSources: [{ name: "chunks-source" }],
		retrievalReasoningEffort: { kind: "minimal" },
	});
	expect(knowledgeBaseRetrieveUrl()).toBe(
		"https://svc.search.windows.net/knowledgebases/chunks-kb/retrieve?api-version=2026-08-01-preview",
	);
});

test("the base is written, and asked, on the preview that takes its model and its effort", () => {
	expect(KNOWLEDGE_BASE_PREVIEW_API_VERSION).toBe("2026-08-01-preview");
	expect(knowledgeBaseUrl()).toBe(
		`https://svc.search.windows.net/knowledgebases/chunks-kb?api-version=${KNOWLEDGE_BASE_PREVIEW_API_VERSION}`,
	);
});

test("the engine is the hybrid search by default, and the job makes no knowledge base for it", async () => {
	const k = standInKnowledge();
	expect(await retrievalEngine()).toBe("hybrid");
	expect(await knowledgeBaseRetrieval("typed")).toBeNull();
	expect(await knowledgeBaseRetrieval("voice")).toBeNull();
	expect(await ensureKnowledgeBase()).toEqual({ made: null, retired: [] });
	expect(k.indexer.knowledgeSource).toBeNull();
	expect(k.indexer.knowledgeBase).toBeNull();
});

const PLANNER_ENV = {
	AZURE_OPENAI_RESOURCE_NAME: "acct",
	AZURE_OPENAI_KNOWLEDGE_BASE_DEPLOYMENT: "knowledge",
	AZURE_OPENAI_KNOWLEDGE_BASE_MODEL: "gpt-5-mini",
};
const PLANNER = {
	resourceUri: "https://acct.openai.azure.com",
	deploymentId: "knowledge",
	modelName: "gpt-5-mini",
};

function withPlanner(): void {
	restoreEnv();
	restoreEnv = scopedEnv({
		...PIPELINE_ENV,
		...PLANNER_ENV,
		AZURE_SEARCH_ENDPOINT: "https://svc.search.windows.net",
		AZURE_SEARCH_INDEX: undefined,
		APP_CONFIG_ENDPOINT: undefined,
	});
}

test("set to the knowledge base, both channels ask it at minimal by default, and the job makes the source and the one base, again unchanged", async () => {
	const k = standInKnowledge();
	restoreSettings();
	restoreSettings = stagedSettings({
		knowledge: { retrieval: { engine: "knowledgeBase" } },
	});
	expect(await retrievalEngine()).toBe("knowledgeBase");
	for (const channel of ["typed", "voice"] as const)
		expect(await knowledgeBaseRetrieval(channel)).toEqual({
			effort: "minimal",
		});
	const made = { made: "chunks-kb", retired: [] };
	expect(await ensureKnowledgeBase()).toEqual(made);
	expect(k.indexer.knowledgeSource?.name).toBe("chunks-source");
	expect(k.indexer.knowledgeBase).toEqual(knowledgeBaseDefinition());
	expect(k.indexer.knowledgeBaseUrl).toBe(knowledgeBaseUrl());
	expect(await ensureKnowledgeBase()).toEqual(made);
});

test("without a planning model the base holds none; with one it carries the model and extractive output, minimal its default, under the same name", () => {
	expect(knowledgeBaseDefinition()).toEqual({
		name: "chunks-kb",
		knowledgeSources: [{ name: "chunks-source" }],
		retrievalReasoningEffort: { kind: "minimal" },
	});
	expect(knowledgeBaseDefinition(PLANNER)).toEqual({
		name: "chunks-kb",
		knowledgeSources: [{ name: "chunks-source" }],
		retrievalReasoningEffort: { kind: "minimal" },
		models: [{ kind: "azureOpenAI", azureOpenAIParameters: PLANNER }],
		outputMode: "extractiveData",
	});
});

test("the planning model is the account's openai host, the deployment and the model the template names, and nothing while either is unset", () => {
	expect(knowledgeBasePlanner()).toBeNull();
	withPlanner();
	expect(knowledgeBasePlanner()).toEqual(PLANNER);
	restoreEnv();
	restoreEnv = scopedEnv({
		...PIPELINE_ENV,
		...PLANNER_ENV,
		AZURE_OPENAI_KNOWLEDGE_BASE_MODEL: undefined,
		AZURE_SEARCH_ENDPOINT: "https://svc.search.windows.net",
		APP_CONFIG_ENDPOINT: undefined,
	});
	expect(knowledgeBasePlanner()).toBeNull();
});

test("with a planning model the job writes it into the base, and each channel asks at its own effort, the spoken one the typed one's unless it names its own", async () => {
	withPlanner();
	const k = standInKnowledge();
	restoreSettings();
	restoreSettings = stagedSettings({
		knowledge: {
			retrieval: { engine: "knowledgeBase", reasoningEffort: "low" },
		},
	});
	await ensureKnowledgeBase();
	expect(k.indexer.knowledgeBase).toEqual(knowledgeBaseDefinition(PLANNER));
	expect(await knowledgeBaseRetrieval("typed")).toEqual({ effort: "low" });
	expect(await knowledgeBaseRetrieval("voice")).toEqual({ effort: "low" });
	restoreSettings();
	restoreSettings = stagedSettings({
		knowledge: {
			retrieval: {
				engine: "knowledgeBase",
				reasoningEffort: "low",
				voiceReasoningEffort: "medium",
			},
		},
	});
	expect(await knowledgeBaseRetrieval("typed")).toEqual({ effort: "low" });
	expect(await knowledgeBaseRetrieval("voice")).toEqual({ effort: "medium" });
});

test("an effort above minimal with no planning model runs at minimal, said once per window: a setting never reaches a base that cannot plan", async () => {
	standInKnowledge();
	restoreSettings();
	restoreSettings = stagedSettings({
		knowledge: {
			retrieval: { engine: "knowledgeBase", reasoningEffort: "medium" },
		},
	});
	const error = spyOn(console, "error").mockImplementation(() => {});
	try {
		expect(await knowledgeBaseRetrieval("typed")).toEqual({
			effort: "minimal",
		});
		expect(await knowledgeBaseRetrieval("voice")).toEqual({
			effort: "minimal",
		});
		const lines = error.mock.calls.filter(([line]) =>
			String(line).includes(PLANNER_UNCONFIGURED),
		);
		expect(lines).toHaveLength(1);
	} finally {
		error.mockRestore();
	}
});

test("the job deletes the per-effort bases an earlier shape made, on either engine; one already gone is done and not reported deleted, and any other refusal fails the step", async () => {
	const k = standInKnowledge();
	k.indexer.otherKnowledgeBases.add("chunks-kb-low");
	k.indexer.otherKnowledgeBases.add("chunks-kb-medium");
	k.indexer.otherKnowledgeBases.add("someone-elses-kb");
	expect(await ensureKnowledgeBase()).toEqual({
		made: null,
		retired: ["chunks-kb-low", "chunks-kb-medium"],
	});
	expect([...k.indexer.otherKnowledgeBases]).toEqual(["someone-elses-kb"]);
	expect(await ensureKnowledgeBase()).toEqual({ made: null, retired: [] });
	k.indexer.otherKnowledgeBases.add("chunks-kb-low");
	const del = spyOn(searchIndexClient(), "deleteKnowledgeBase");
	try {
		del.mockReturnValueOnce(
			Promise.reject(Object.assign(new Error("HTTP 403"), { statusCode: 403 })),
		);
		await expect(ensureKnowledgeBase()).rejects.toThrow("HTTP 403");
	} finally {
		del.mockRestore();
	}
});

test("under enforced access control the knowledge base still answers, both channels ask it, and the job makes it", async () => {
	const k = standInKnowledge();
	restoreSettings();
	restoreSettings = stagedSettings({
		knowledge: { retrieval: { engine: "knowledgeBase" } },
		access: { enforceAccessControl: true },
	});
	const error = spyOn(console, "error").mockImplementation(() => {});
	try {
		expect(await retrievalEngine()).toBe("knowledgeBase");
		expect(await knowledgeBaseRetrieval("typed")).toEqual({
			effort: "minimal",
		});
		expect(await knowledgeBaseRetrieval("voice")).toEqual({
			effort: "minimal",
		});
		expect(await ensureKnowledgeBase()).toMatchObject({ made: "chunks-kb" });
		expect(error).not.toHaveBeenCalled();
	} finally {
		error.mockRestore();
	}
	expect(k.indexer.knowledgeBase?.name).toBe("chunks-kb");
});

test("a 409 on either write is the write already applied; a 500 is still a failure", async () => {
	standInKnowledge();
	restoreSettings();
	restoreSettings = stagedSettings({
		knowledge: { retrieval: { engine: "knowledgeBase" } },
	});
	const refuse = (statusCode: number) =>
		Promise.reject(
			Object.assign(new Error(`HTTP ${statusCode}`), { statusCode }),
		);
	const write = spyOn(searchIndexClient(), "createOrUpdateKnowledgeSource");
	const put = spyOn(searchRestWriter(), "put");
	try {
		write.mockReturnValueOnce(refuse(409));
		expect(await ensureKnowledgeBase()).toMatchObject({ made: "chunks-kb" });
		write.mockReturnValueOnce(refuse(500));
		await expect(ensureKnowledgeBase()).rejects.toMatchObject({
			statusCode: 500,
		});
		put.mockReturnValueOnce(refuse(409));
		expect(await ensureKnowledgeBase()).toMatchObject({ made: "chunks-kb" });
		put.mockReturnValueOnce(refuse(500));
		await expect(ensureKnowledgeBase()).rejects.toMatchObject({
			statusCode: 500,
		});
	} finally {
		write.mockRestore();
		put.mockRestore();
	}
});

test("with the engine set to the knowledge base, an access document the store will not give fails the step, where reading it as the hybrid search would leave the base unmade", async () => {
	const k = standInKnowledge();
	restoreSettings();
	setAppConfigClient({
		getConfigurationSetting: async ({ key }: { key: string }) => {
			if (key.endsWith("access")) throw new Error("the store is unreachable");
			if (key.endsWith("knowledge"))
				return {
					value: JSON.stringify({ retrieval: { engine: "knowledgeBase" } }),
				};
			throw Object.assign(new Error("HTTP 404"), { statusCode: 404 });
		},
	} as unknown as Parameters<typeof setAppConfigClient>[0]);
	resetAccessSettings();
	resetKnowledgeSettings();
	restoreSettings = () => {
		resetAppConfigClient();
		resetAccessSettings();
		resetKnowledgeSettings();
	};
	const warned = spyOn(console, "warn").mockImplementation(() => {});
	try {
		// A search falls to the hybrid query, which refuses on the same reading.
		expect(await retrievalEngine()).toBe("hybrid");
		await expect(ensureKnowledgeBase()).rejects.toBeInstanceOf(
			AccessSettingsUnreadError,
		);
		expect(k.indexer.knowledgeSource).toBeNull();
	} finally {
		warned.mockRestore();
	}
});
