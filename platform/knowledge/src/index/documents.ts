import type { DocumentKind, SearchHit } from "../types";

/**
 * A chunk as the index holds it: the indexer's projection of one page the
 * text split skill cut, with its file's description copied on. Only
 * `injection` and `shieldedHash` are written by anything but the indexer.
 */
export interface ChunkDocument {
	chunkId: string;
	parentId: string;
	documentId: string;
	path: string;
	library: string;
	kind: DocumentKind;
	title: string;
	summary: string;
	tags: string[];
	chunk: string;
	vector?: number[];
	oids: string[];
	groups: string[];
	/** Absent until Prompt Shields has read this chunk's text. */
	injection?: boolean | null;
	/** The SHA-256 of the text Prompt Shields read, so a changed chunk is read again. */
	shieldedHash?: string | null;
}

/** The fields a search hands back: everything but the vector and the readers. */
export const HIT_FIELDS = [
	"chunkId",
	"documentId",
	"path",
	"kind",
	"title",
	"summary",
	"tags",
	"chunk",
] as const satisfies readonly (keyof ChunkDocument)[];

export type HitDocument = Pick<ChunkDocument, (typeof HIT_FIELDS)[number]>;

export function toHit(
	doc: HitDocument,
	score: number,
	rerankerScore: number | null,
): SearchHit {
	return {
		documentId: doc.documentId,
		path: doc.path,
		kind: doc.kind,
		chunkId: doc.chunkId,
		score,
		rerankerScore,
		title: doc.title ?? "",
		summary: doc.summary ?? "",
		text: doc.chunk ?? "",
		tags: doc.tags ?? [],
	};
}

/**
 * Where a chunk sits in its document. The projection keys a page by its
 * position in the split skill's output (`…_pages_<n>`); that suffix is the
 * only order the index records, so a key without one sorts last.
 */
export function chunkOrdinal(chunkId: string): number {
	const match = /_(\d+)$/.exec(chunkId);
	return match ? Number(match[1]) : Number.MAX_SAFE_INTEGER;
}
