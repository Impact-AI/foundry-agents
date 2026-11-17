import { searchClient } from "./client";
import { FIELD } from "./definition";
import type { ChunkDocument } from "./documents";
import { odataQuote } from "./odata";

/**
 * Reading chunks by filter rather than by relevance: the walks a job makes
 * over a library, and the read of one document's chunks for the reader.
 */

/** The service's own cap on one page of results. */
const PAGE = 1000;

/**
 * Every chunk a filter admits, in key order, all pages. Keyset rather than
 * the SDK's continuation: a continued `*` search pages by `$skip`, which the
 * service refuses past 100,000, and a walk that stopped there would leave a
 * removed file's chunks searchable. Each page asks for the keys after the
 * last one it saw.
 */
export async function* walkChunks<K extends keyof ChunkDocument>(
	filter: string | null,
	select: readonly K[],
): AsyncGenerator<Pick<ChunkDocument, K | "chunkId">> {
	let after: string | null = null;
	for (;;) {
		const clauses: string[] = [
			...(filter ? [`(${filter})`] : []),
			...(after === null ? [] : [`${FIELD.key} gt ${odataQuote(after)}`]),
		];
		const res = await searchClient().search("*", {
			filter: clauses.length ? clauses.join(" and ") : undefined,
			select: [...new Set<keyof ChunkDocument>([FIELD.key, ...select])],
			orderBy: [`${FIELD.key} asc`],
			top: PAGE,
		});
		let seen = 0;
		for await (const hit of res.results) {
			const doc = hit.document as Pick<ChunkDocument, K | "chunkId">;
			seen++;
			after = doc.chunkId;
			yield doc;
		}
		if (seen < PAGE) return;
	}
}
