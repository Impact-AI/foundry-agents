import type { DocumentSource } from "@platform/agent";
import {
	type CallerAccess,
	chunkOrdinal,
	type DocumentCard,
	fallbackPlan,
	type KnowledgeBaseEffort,
	knowledgeBaseSearch,
	listDocuments,
	picturesOf,
	type RetrievalRefusal,
	readDocument as readLibraryDocument,
	retrieve,
	type SearchOptions,
} from "@platform/knowledge";
import { STAGE_MEDIA_ROUTE } from "./surfaces";

/**
 * The knowledge base as the stage sees it: a search whose pictures are
 * addressed by path on this deployment's own media route, grouped into the
 * cards the library draws, and one document rendered for the reader. The
 * knowledge search tool and the `/library` routes read through here, so the
 * agent and the interface are handed the same documents under the same ids.
 */

const MAX_PASSAGES = 6;

/**
 * Where the browser asks for a picture: the web app's media route
 * (`STAGE_MEDIA_ROUTE`) and then the picture's blob in the library
 * container. A path, never a URL into the store, so nothing a client holds
 * can open a blob, and short enough that a model retyping it into a stage
 * control does not damage it.
 */
export function mediaPath(path: string | null | undefined): string | null {
	return path
		? `${STAGE_MEDIA_ROUTE}${path.split("/").map(encodeURIComponent).join("/")}`
		: null;
}

export interface LibraryPassage {
	/** `<document>:<page>`: names the passage in a tool result; it is never written into an answer. */
	id: string;
	documentId: string;
	title: string;
	text: string;
	tags: string[];
	mediaUrl: string | null;
}

export interface LibraryDocument {
	id: string;
	title: string;
	summary: string;
	tags: string[];
	thumbnailUrl?: string;
}

/** A card as the sources under an answer show it: the id the chip opens, the title it reads, the picture it carries. */
export function sourceOf(card: LibraryDocument): DocumentSource {
	return {
		id: card.id,
		title: card.title,
		...(card.thumbnailUrl ? { thumbnailUrl: card.thumbnailUrl } : {}),
	};
}

export interface LibrarySearch {
	passages: LibraryPassage[];
	documents: LibraryDocument[];
	unmatchedTerms: string[];
	refused: RetrievalRefusal | null;
}

/** One card per document, in the order it first appeared, showing the first picture any of its passages had. */
function documentsOf(
	passages: LibraryPassage[],
	summaries: Map<string, string>,
) {
	const documents = new Map<string, LibraryDocument>();
	for (const passage of passages) {
		const card = documents.get(passage.documentId) ?? {
			id: passage.documentId,
			title: passage.title,
			summary: summaries.get(passage.documentId) ?? "",
			tags: passage.tags,
		};
		card.thumbnailUrl ??= passage.mediaUrl ?? undefined;
		documents.set(passage.documentId, card);
	}
	return [...documents.values()];
}

/** The catalogue's cards, whether it holds more than they show, and why it shows none when it was refused. */
export interface LibraryListing {
	documents: LibraryDocument[];
	truncated: boolean;
	refused: RetrievalRefusal | null;
}

/**
 * The catalogue as the caller may read it, as the library's cards: every
 * document, no query, no ranker. A picture is its own thumbnail; a
 * document's thumbnail is the first picture its first chunk shows, lifted
 * as a search lifts a passage's. A caller who may read nothing gets no
 * cards and the reason; `truncated` says the cards are not the whole
 * catalogue.
 */
export async function listLibrary(
	access: CallerAccess | null,
	options: { tags?: readonly string[] } = {},
): Promise<LibraryListing> {
	const listing = await listDocuments(access, options);
	return {
		documents: listing.documents.map(libraryDocument),
		truncated: listing.truncated,
		refused: listing.refused,
	};
}

function libraryDocument(card: DocumentCard): LibraryDocument {
	return {
		id: card.id,
		title: card.title,
		summary: card.summary,
		tags: card.tags,
		...(card.picture
			? { thumbnailUrl: mediaPath(card.picture.path) ?? undefined }
			: {}),
	};
}

/**
 * A search as the caller: who is asking rides to the readers clause, so
 * under enforcement a person reads what their groups may and nothing else,
 * and a turn nobody verified gets no passages and a refusal, never the open
 * corpus. Tags are a constraint the caller set by hand, so they ride as the
 * plan rather than through the planner. The library's cards ask for one
 * passage a document, so a long one does not crowd the others off.
 */
export async function searchLibrary(
	query: string,
	access: CallerAccess | null,
	options: {
		tags?: readonly string[];
		topK?: number;
		maxPerDocument?: number;
		/**
		 * `knowledgeBase`: the knowledge base chooses the chunks
		 * (`knowledgeBaseSearch`), with no query planner of the backend's, since the
		 * base plans its own; the readers clause and the served filter still
		 * apply to what it chose. The hybrid query otherwise.
		 */
		engine?: "hybrid" | "knowledgeBase";
		/** The effort a `knowledgeBase` search is asked at. */
		effort?: KnowledgeBaseEffort;
		/** The bound on one search request; absent: the process's search deadline. */
		deadlineMs?: number;
	} = {},
): Promise<LibrarySearch> {
	const tags = options.tags?.filter((t) => t.trim()) ?? [];
	const onBase = options.engine === "knowledgeBase";
	const result = await retrieve(query, {
		topK: options.topK ?? MAX_PASSAGES,
		maxPerDocument: options.maxPerDocument,
		deadlineMs: options.deadlineMs,
		access,
		plan:
			tags.length || onBase
				? {
						...fallbackPlan(query, "unfiltered"),
						...(tags.length ? { spec: { tags } } : {}),
					}
				: undefined,
		...(onBase
			? {
					search: (opts: SearchOptions) =>
						knowledgeBaseSearch(opts, options.effort ?? "minimal"),
				}
			: {}),
	});
	// A passage is its chunk whole. The chunk's size is the indexer's
	// `chunkChars` (at most 8000), the one setting that bounds a passage, so
	// a call hands the model at most `topK` chunks of that size. No second
	// cap is applied here: one would cut a hit short of the sentence the
	// question was about, in a chunk every search finds and none can return
	// whole.
	const passages = result.hits.map((hit) => ({
		id: `${hit.documentId}:${chunkOrdinal(hit.chunkId)}`,
		documentId: hit.documentId,
		title: hit.title,
		text: hit.text,
		tags: hit.tags,
		mediaUrl: mediaPath(picturesOf(hit)[0]?.path),
	}));
	return {
		passages,
		documents: documentsOf(
			passages,
			new Map(result.hits.map((h) => [h.documentId, h.summary])),
		),
		unmatchedTerms: result.unmatchedTerms,
		refused: result.refused,
	};
}

export interface DocumentMedia {
	type: "image";
	url: string;
	title?: string;
}

export interface DocumentView extends LibraryDocument {
	sections: { heading: string; text: string }[];
	/** The sections' text is Markdown, for the reader to render; otherwise it is shown as written. */
	markdown: boolean;
	media: DocumentMedia[];
}

/**
 * One document for the reader: its sections in order and its pictures as
 * media. Null for a document that is absent or not this caller's to read —
 * the two are one answer, so an id cannot be probed.
 */
export async function readDocument(
	id: string,
	access: CallerAccess | null,
): Promise<DocumentView | null> {
	const document = await readLibraryDocument(id, access);
	if (!document) return null;
	const media = document.pictures.flatMap((picture) => {
		const url = mediaPath(picture.path);
		return url
			? [
					{
						type: "image" as const,
						url,
						...(picture.title ? { title: picture.title } : {}),
					},
				]
			: [];
	});
	return {
		id: document.id,
		title: document.title,
		summary: document.summary,
		tags: document.tags,
		...(media[0] ? { thumbnailUrl: media[0].url } : {}),
		sections: document.sections,
		markdown: document.markdown,
		media,
	};
}
