/**
 * For tests: the query drafter, the index, the indexer, Prompt Shields, the
 * blob store and the settings store stood in for at their boundaries.
 */
import { fakeBlob } from "@platform/storage/testing";
import { fakeIndexer } from "./fake-indexer";
import { fakeSearchClient } from "./fake-search";
import { plantedShield } from "./fake-shield";

export * from "./fake-config";
export * from "./fake-indexer";
export * from "./fake-models";
export * from "./fake-search";
export * from "./fake-shield";

/**
 * What the job's `index` step reads to define the pipeline, as a test sets
 * it: the account, the embedding deployment and its model, the store.
 */
export const PIPELINE_ENV = {
	AZURE_OPENAI_RESOURCE_NAME: "account",
	AZURE_OPENAI_EMBEDDING_DEPLOYMENT: "embedding",
	AZURE_OPENAI_EMBEDDING_MODEL: "text-embedding-3-large",
	AZURE_STORAGE_ACCOUNT: "store",
	AZURE_STORAGE_RESOURCE_ID:
		"/subscriptions/s/resourceGroups/rg/providers/Microsoft.Storage/storageAccounts/store",
} as const;

/**
 * The whole knowledge base stood in for at once — the store, the index, the
 * indexer over both, and Prompt Shields — for a test or a launcher that
 * loads a library as a deployment does.
 */
export function standInKnowledge() {
	const store = fakeBlob();
	const index = fakeSearchClient();
	return {
		store,
		index,
		indexer: fakeIndexer(store, index),
		shield: plantedShield(),
	};
}
