import { isNotFound } from "@platform/config";
import { isSearchConfigured, searchClient } from "./client";
import { indexName } from "./definition";

/**
 * For a process's startup, as a cache is checked: a search service that is
 * configured and cannot answer is misconfiguration, and serving on it would
 * be the silent failure — every question answered "nothing found" by a model
 * that cannot tell an outage from an empty library.
 *
 * The index is the job's to make, with the data source, the skillset and
 * the indexer that fill it: they are one pipeline, and an index made alone
 * would be an index nothing fills. A serving identity only reads. So an
 * absent index is waited for, not made, and the check answers three ways.
 */
export type ChunkIndexReadiness =
	/** No search service named: knowledge search is off, by configuration. */
	| "unconfigured"
	| "present"
	/** Absent: the job's `index` step makes it. */
	| "awaiting-index";

export class SearchIndexUnavailableError extends Error {
	constructor(index: string, cause: unknown) {
		super(
			`AI Search is configured but the index "${index}" could not be read: ${cause instanceof Error ? cause.message : String(cause)}`,
			{ cause },
		);
		this.name = "SearchIndexUnavailableError";
	}
}

/** Asked with the data-plane role a serving identity holds: a count of the documents. */
export async function checkChunkIndex(): Promise<ChunkIndexReadiness> {
	if (!isSearchConfigured()) return "unconfigured";
	try {
		await searchClient().getDocumentsCount();
		return "present";
	} catch (err) {
		if (isNotFound(err)) return "awaiting-index";
		throw new SearchIndexUnavailableError(indexName(), err);
	}
}
