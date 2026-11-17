import {
	SearchClient,
	SearchIndexClient,
	SearchIndexerClient,
} from "@azure/search-documents";
import {
	azureCredential,
	createEntraTokenProvider,
	envString,
	processSingleton,
	resetSingleton,
	setSingleton,
} from "@platform/config";
import { indexName } from "./definition";
import type { ChunkDocument } from "./documents";

/**
 * The three clients, keyless: the service runs with local authentication
 * off. A serving identity holds Search Index Data Reader and only queries;
 * the job's holds Search Service Contributor, to make the index, the data
 * source, the skillset and the indexer, and Search Index Data Contributor,
 * to delete a removed file's chunks and write what Prompt Shields said.
 * One instance each, on the process's one credential.
 */

const SEARCH_CLIENT = "knowledge:search-client";
const INDEX_CLIENT = "knowledge:search-index-client";
const INDEXER_CLIENT = "knowledge:search-indexer-client";
const REST_WRITER = "knowledge:search-rest";

/** The scope the SDK's own bearer policy asks for on the public cloud. */
const SEARCH_SCOPE = "https://search.azure.com/.default";

/**
 * One write the SDK cannot make: a PUT of a definition on a service version
 * the SDK does not carry, as the knowledge base's is (`knowledge-base/ensure.ts`).
 * A refusal is thrown with `statusCode`, the shape the SDK's errors have, so
 * `isConflict` and `applied` read it the same.
 */
export interface SearchRestWriter {
	put(url: string, body: unknown): Promise<void>;
}

export function searchEndpoint(): string {
	const url = envString("AZURE_SEARCH_ENDPOINT");
	if (!url) throw new Error("AZURE_SEARCH_ENDPOINT is not set");
	return url;
}

export function isSearchConfigured(): boolean {
	return envString("AZURE_SEARCH_ENDPOINT") !== undefined;
}

export function searchClient(): SearchClient<ChunkDocument> {
	return processSingleton(
		SEARCH_CLIENT,
		() =>
			new SearchClient<ChunkDocument>(
				searchEndpoint(),
				indexName(),
				azureCredential(),
			),
	);
}

export function searchIndexClient(): SearchIndexClient {
	return processSingleton(
		INDEX_CLIENT,
		() => new SearchIndexClient(searchEndpoint(), azureCredential()),
	);
}

export function searchIndexerClient(): SearchIndexerClient {
	return processSingleton(
		INDEXER_CLIENT,
		() => new SearchIndexerClient(searchEndpoint(), azureCredential()),
	);
}

const BEARER = "knowledge:search-bearer";

/** A bearer for the search service's REST routes the SDK does not carry, on the process's one credential. */
export function searchBearer(): () => Promise<string> {
	return processSingleton(BEARER, () =>
		createEntraTokenProvider({
			credential: azureCredential,
			scope: SEARCH_SCOPE,
		}),
	);
}

export function searchRestWriter(): SearchRestWriter {
	return processSingleton(REST_WRITER, (): SearchRestWriter => {
		const bearer = searchBearer();
		return {
			async put(url, body) {
				const response = await fetch(url, {
					method: "PUT",
					headers: {
						Authorization: `Bearer ${await bearer()}`,
						"Content-Type": "application/json",
					},
					body: JSON.stringify(body),
				});
				if (response.ok) return;
				throw Object.assign(
					new Error(
						`PUT ${url} answered ${response.status}: ${(await response.text()).slice(0, 500)}`,
					),
					{ statusCode: response.status },
				);
			},
		};
	});
}

/** Use `client` for every query and write. For tests. */
export function setSearchClient(client: SearchClient<ChunkDocument>): void {
	setSingleton(SEARCH_CLIENT, client);
}

export function setSearchIndexClient(client: SearchIndexClient): void {
	setSingleton(INDEX_CLIENT, client);
}

export function setSearchIndexerClient(client: SearchIndexerClient): void {
	setSingleton(INDEXER_CLIENT, client);
}

export function setSearchRestWriter(writer: SearchRestWriter): void {
	setSingleton(REST_WRITER, writer);
}

export function resetSearchClients(): void {
	resetSingleton(SEARCH_CLIENT);
	resetSingleton(INDEX_CLIENT);
	resetSingleton(INDEXER_CLIENT);
	resetSingleton(REST_WRITER);
	resetSingleton(BEARER);
}
