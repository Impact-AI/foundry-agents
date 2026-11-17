import { z } from "zod";

/**
 * What a document is to the stage: something to read, or a picture to show.
 * A Zod enum because the query planner validates a model's answer against it.
 */
export const documentKind = z.enum(["document", "picture"]);
export type DocumentKind = z.infer<typeof documentKind>;

/**
 * Who may read a document, as the identity provider's object ids: the people
 * by `oid`, the groups by id. Empty lists admit nobody while access control
 * is enforced; the group {@link GLOBAL_ACCESS_GROUP} admits every signed-in
 * person.
 */
export interface DocumentAccess {
	oids: string[];
	groups: string[];
}

/** The `groups` value that marks a document every signed-in person may read. */
export const GLOBAL_ACCESS_GROUP = "all";

/** What a library says about one file, as its blob carries it and the indexer copies onto every chunk. */
export interface DocumentDescription {
	/** Short and opaque: the id the stage and the agent name a document by. */
	id: string;
	/** `<library>/<path in the library>`: the blob's name. */
	path: string;
	library: string;
	kind: DocumentKind;
	title: string;
	summary: string;
	tags: string[];
	readers: DocumentAccess;
}

/** One hit: a chunk the indexer cut, with what its document says about itself. */
export interface SearchHit {
	documentId: string;
	path: string;
	kind: DocumentKind;
	/** The chunk's key in the index. */
	chunkId: string;
	/** The service's fused score: orders one result set, comparable across none. */
	score: number;
	/** The semantic reranker's 0–4 judgement, absolute and thresholdable; null when the rerank did not run. */
	rerankerScore: number | null;
	title: string;
	summary: string;
	text: string;
	tags: string[];
}
