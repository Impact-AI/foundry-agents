import { searchClient } from "./client";
import { FIELD } from "./definition";
import type { ChunkDocument } from "./documents";

/**
 * The only writes into the index that are not the indexer's: a removed
 * file's chunks deleted, and what Prompt Shields said merged onto a chunk.
 * A batch at a time rather than fanned out, so a large library does not
 * saturate the service every concurrent query is also using; the service
 * caps a batch at 1000 documents, and these documents are keys and a flag.
 */

const BATCH = 1000;

function batches<T>(items: readonly T[]): T[][] {
	const out: T[][] = [];
	for (let i = 0; i < items.length; i += BATCH)
		out.push(items.slice(i, i + BATCH));
	return out;
}

/** Delete chunks by key. Returns how many were asked for. */
export async function deleteChunks(keys: readonly string[]): Promise<number> {
	const client = searchClient();
	for (const batch of batches(keys))
		await client.deleteDocuments(FIELD.key, batch, { throwOnAnyFailure: true });
	return keys.length;
}

/**
 * A partial document for the merge action. The service reads the key and
 * leaves every absent field untouched; the SDK types every operation as the
 * full document, so the cast lives here and the key stays mandatory.
 */
export type ChunkPatch = Partial<ChunkDocument> & { chunkId: string };

/**
 * Merge the patches, and answer the keys the index no longer holds. A merge
 * names a document that must exist, and a chunk read a moment ago can have
 * been deleted since — its file removed, or cut again into other chunks —
 * by another run of the job; that is the chunk's end, not the merge's
 * failure. Any other refusal throws.
 */
export async function mergeChunks(
	patches: readonly ChunkPatch[],
): Promise<string[]> {
	const client = searchClient();
	const gone: string[] = [];
	for (const batch of batches(patches)) {
		const { results } = await client.mergeDocuments(batch as ChunkDocument[], {
			throwOnAnyFailure: false,
		});
		for (const result of results) {
			if (result.succeeded) continue;
			if (result.statusCode === 404) {
				gone.push(result.key);
				continue;
			}
			throw new Error(
				`the index refused a merge into "${result.key}" (${result.statusCode}): ${result.errorMessage ?? "no reason given"}`,
			);
		}
	}
	return gone;
}
