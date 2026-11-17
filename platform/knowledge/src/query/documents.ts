import { type BlobEntry, blobProperties } from "@platform/storage";
import { knowledgeSettings } from "../config/knowledge";
import { searchClient } from "../index/client";
import { FIELD } from "../index/definition";
import { type ChunkDocument, chunkOrdinal } from "../index/documents";
import { equals } from "../index/odata";
import { walkChunks } from "../index/reads";
import { formatOf } from "../library/formats";
import {
	liftPictures,
	markdownSections,
	parseMarkdownDocument,
	resolvePicturePath,
} from "../library/markdown";
import { decodeMetadata } from "../library/metadata";
import { readText } from "../library/text";
import type { DocumentKind, SearchHit } from "../types";
import {
	accessClauseFor,
	type CallerAccess,
	type RetrievalRefusal,
	readableSettings,
	readerAdmits,
	servedFilter,
} from "./access";
import { anyTag } from "./spec";

/**
 * One document for the reader, and one picture for the media route, each
 * under the caller's readers. A document is what the index holds: the
 * reader finds it by id under the readers clause every search carries, so
 * absent and not yours are one answer and an id cannot be probed. A picture
 * a document shows may hold no text, and so no chunk, so its own blob's
 * metadata decides — the same rule, decided for one blob in hand.
 *
 * Nothing here reaches a model: the reader is a person reading, so it shows
 * a document whole, chunks Prompt Shields flagged included.
 */

export interface DocumentPicture {
	/** The picture's blob name, `<library>/<path>`. */
	path: string;
	/** What the document says it shows. */
	title?: string;
}

export interface DocumentCard {
	id: string;
	path: string;
	kind: DocumentKind;
	title: string;
	summary: string;
	tags: string[];
	/** What stands for the document: itself when it is a picture, else the first picture the chunk in hand shows. Absent when neither. */
	picture?: DocumentPicture;
}

/** A listing: its cards, whether the library holds more than it lists, and why it lists nothing when it was refused. */
export interface DocumentList {
	documents: DocumentCard[];
	/** The walk stopped at a bound with chunks still unread: this is not the whole catalogue. */
	truncated: boolean;
	/** Why nothing was read; null when the listing was made. */
	refused: RetrievalRefusal | null;
}

export interface DocumentView extends DocumentCard {
	sections: { heading: string; text: string }[];
	/** The sections' text is Markdown, for the reader to render; otherwise it is shown as written. */
	markdown: boolean;
	pictures: DocumentPicture[];
}

const DOCUMENT_ID = /^[0-9a-f]{32}$/;

/**
 * Pages of a document the reader is handed at most: a bound on one
 * response, a few megabytes of text, not a limit on what the library holds.
 */
const MAX_PAGES = 1000;

/** The readers clause for a read, or null for one that may read nothing. */
async function readersFilter(
	access: CallerAccess | null | undefined,
): Promise<{ filter: string | null } | null> {
	const clause = await accessClauseFor(access);
	if (clause.kind === "refused") return null;
	return { filter: clause.kind === "filter" ? clause.filter : null };
}

const and = (...clauses: (string | null)[]) =>
	clauses.filter(Boolean).join(" and ");

const CARD_FIELDS = [
	FIELD.documentId,
	FIELD.path,
	FIELD.kind,
	FIELD.title,
	FIELD.summary,
	FIELD.tags,
] as const;

/** The pictures a passage of a document shows, as blob names in its library. */
function picturesIn(text: string, path: string): DocumentPicture[] {
	const [library, ...rest] = path.split("/");
	const relPath = rest.join("/");
	return liftPictures(text).pictures.flatMap((picture) => {
		const resolved = resolvePicturePath(relPath, picture.path);
		return resolved && formatOf(resolved)?.kind === "picture"
			? [{ path: `${library}/${resolved}`, title: picture.alt || undefined }]
			: [];
	});
}

/** What a hit can be shown with: itself when it is a picture, else the pictures its passage shows. */
export function picturesOf(
	hit: Pick<SearchHit, "kind" | "path" | "title" | "text">,
): DocumentPicture[] {
	return hit.kind === "picture"
		? [{ path: hit.path, title: hit.title }]
		: picturesIn(hit.text, hit.path);
}

/** A chunk as the index holds it, as one card: the document's description, with the chunk's first picture standing for it. */
function cardOf(
	doc: Pick<ChunkDocument, (typeof CARD_FIELDS)[number] | "chunk">,
): DocumentCard {
	const picture = picturesOf({
		kind: doc.kind,
		path: doc.path,
		title: doc.title ?? "",
		text: doc.chunk ?? "",
	})[0];
	return {
		id: doc.documentId,
		path: doc.path,
		kind: doc.kind,
		title: doc.title ?? "",
		summary: doc.summary ?? "",
		tags: doc.tags ?? [],
		...(picture ? { picture } : {}),
	};
}

/**
 * The shortest repeat taken for the split skill's overlap. A page whose
 * first few characters happen to equal the last few of the page before is
 * not a lead-in, and taking them off would eat the start of a word; an
 * overlap configured shorter than this is taken only at its full length.
 *
 * The rule reads the text, not the split: nothing on a chunk says how much
 * of it is lead-in. So it errs both ways at the edges, and both are kept
 * rare rather than removed. A real overlap shorter than this bound (the
 * skill cuts on sentence ends, and a short closing sentence can be the
 * whole of it) is left in, and the reader shows those few words twice. A
 * repeat at least this long that the author wrote — a table's rule line at
 * a page's end and the next page's start — is taken for the overlap and
 * shown once.
 */
const MIN_OVERLAP = 16;

/**
 * The chunks the indexer cut, in the order it cut them, each page's lead-in
 * (the split skill's overlap, a repeat of the page before) taken off again:
 * the longest repeat up to the configured overlap, and none shorter than
 * {@link MIN_OVERLAP}.
 */
export function pagesOf(
	chunks: Pick<ChunkDocument, "chunkId" | "chunk">[],
	overlap: number,
) {
	const ordered = [...chunks].sort(
		(a, b) => chunkOrdinal(a.chunkId) - chunkOrdinal(b.chunkId),
	);
	return ordered.map((c, i) => {
		const previous = ordered[i - 1]?.chunk ?? "";
		const text = c.chunk ?? "";
		const least = Math.min(overlap, MIN_OVERLAP);
		for (
			let k = Math.min(overlap, text.length, previous.length);
			k > 0 && k >= least;
			k--
		)
			if (previous.endsWith(text.slice(0, k))) return text.slice(k).trim();
		return text.trim();
	});
}

/** The most cards a listing returns, and the most chunks it reads to find them. */
const LIST_MAX_DOCUMENTS = 50;
const LIST_MAX_CHUNKS = 2_000;

/**
 * The catalogue: one card per document the caller may read, at most
 * {@link LIST_MAX_DOCUMENTS}, carrying one of `tags` when any are given.
 * No query, no ranker and no floor: "what documents do we have" is a list,
 * and a search's reranker scores a question about the catalogue below its
 * floor against every passage, so nothing would come back. It carries
 * what every search carries — clean chunks only, the readers clause under
 * enforcement — so a document a search would never serve is never listed.
 * A caller who may read nothing gets no cards and the reason, as a search
 * gives it (`refused`). The list says when it is not the whole catalogue:
 * `truncated` is true when the walk stopped at either bound with chunks
 * still unread.
 */
export async function listDocuments(
	access: CallerAccess | null | undefined,
	options: { tags?: readonly string[] } = {},
): Promise<DocumentList> {
	const clause = await accessClauseFor(access);
	if (clause.kind === "refused")
		return { documents: [], truncated: false, refused: clause.code };
	const tags = options.tags?.filter((t) => t.trim()) ?? [];
	const filter = and(servedFilter(clause), tags.length ? anyTag(tags) : null);
	// A card shows its document's first chunk's first picture, so the walk
	// reads the chunk text too and keeps, per document, the lowest page it
	// has seen: the key order is lexical, so page 10 can arrive before page 2.
	const first = new Map<
		string,
		{ ordinal: number; doc: Parameters<typeof cardOf>[0] }
	>();
	let read = 0;
	let truncated = false;
	for await (const doc of walkChunks(filter, [...CARD_FIELDS, FIELD.chunk])) {
		// The chunk past a bound is what says the catalogue goes on.
		if (
			read >= LIST_MAX_CHUNKS ||
			(first.size >= LIST_MAX_DOCUMENTS && !first.has(doc.documentId))
		) {
			truncated = true;
			break;
		}
		read++;
		const ordinal = chunkOrdinal(doc.chunkId);
		const held = first.get(doc.documentId);
		if (!held) first.set(doc.documentId, { ordinal, doc });
		else if (ordinal < held.ordinal) Object.assign(held, { ordinal, doc });
	}
	return {
		documents: [...first.values()].map(({ doc }) => cardOf(doc)),
		truncated,
		refused: null,
	};
}

export async function readDocument(
	id: string,
	access: CallerAccess | null | undefined,
): Promise<DocumentView | null> {
	if (!DOCUMENT_ID.test(id)) return null;
	const readers = await readersFilter(access);
	if (!readers) return null;
	const byId = and(equals(FIELD.documentId, id), readers.filter);
	const found = await searchClient().search("*", {
		filter: byId,
		select: [...CARD_FIELDS],
		top: 1,
	});
	let card: DocumentCard | null = null;
	for await (const hit of found.results) {
		const doc = hit.document;
		card = {
			id: doc.documentId,
			path: doc.path,
			kind: doc.kind,
			title: doc.title ?? "",
			summary: doc.summary ?? "",
			tags: doc.tags ?? [],
		};
	}
	if (!card) return null;
	if (card.kind === "picture")
		return {
			...card,
			sections: [],
			markdown: false,
			pictures: [{ path: card.path, title: card.title }],
		};

	if (formatOf(card.path)?.readAsText) {
		const read = await readText(card.path);
		// The index says who could read the file as it was indexed; the blob
		// says who may read it as it is now. A blob a load has described for
		// this document decides: the text for those it admits, and for the
		// rest the same null as a document they cannot read, even while the
		// index still carries them. A file replaced since its last indexing
		// that no load has described yet is shown as the index holds it,
		// below, which is what a search serves.
		const described =
			read.kind === "text"
				? await describedFor(read.metadata, id, access)
				: "undescribed";
		if (described === "refused") return null;
		if (read.kind === "text" && described === "admitted") {
			const markdown = formatOf(card.path)?.markdown
				? parseMarkdownDocument(read.text)
				: null;
			const body = markdown ? markdown.body : read.text.trim();
			return {
				...card,
				sections: markdown
					? markdownSections(body)
					: [{ heading: "", text: body }],
				markdown: markdown !== null,
				pictures: markdown ? picturesIn(read.text, card.path) : [],
			};
		}
	}
	// A format only the indexer can read, or a text file too large to read
	// whole here: the reader shows what the indexer cut, in order.
	const chunks: Pick<ChunkDocument, "chunkId" | "chunk">[] = [];
	for await (const chunk of walkChunks(byId, [FIELD.chunk])) {
		chunks.push(chunk);
		if (chunks.length >= MAX_PAGES) break;
	}
	const { overlapChars } = (await knowledgeSettings()).indexer;
	return {
		...card,
		sections: pagesOf(chunks, overlapChars)
			.filter(Boolean)
			.map((text) => ({ heading: "", text })),
		markdown: false,
		pictures: [],
	};
}

/**
 * What a blob's own description, read with its bytes, says of the caller:
 * the rule a picture is served by (`pictureFor`), decided on the text in
 * hand. A blob nobody has described since it was written, or described as
 * another document, says nothing (`undescribed`); one described as this
 * document admits the caller or refuses them, and unread settings admit
 * nobody.
 */
async function describedFor(
	metadata: Record<string, string>,
	id: string,
	access: CallerAccess | null | undefined,
): Promise<"admitted" | "refused" | "undescribed"> {
	const description = decodeMetadata(metadata);
	if (!description || description.id !== id) return "undescribed";
	const settings = await readableSettings();
	return settings !== null &&
		readerAdmits(description.readers, access, settings)
		? "admitted"
		: "refused";
}

/**
 * The picture at `path` as the store describes it, when the caller may see
 * it: a blob of a library the job described as a picture, whose readers
 * admit them. Null otherwise, absent and not theirs alike. One read of the
 * blob's properties, which a caller that goes on to serve the picture has
 * no need to make again: its validator is on what comes back.
 */
export async function pictureFor(
	path: string,
	access: CallerAccess | null | undefined,
): Promise<BlobEntry | null> {
	if (formatOf(path)?.kind !== "picture") return null;
	const blob = await blobProperties(path);
	const description = blob && decodeMetadata(blob.metadata);
	if (!blob || description?.kind !== "picture" || description.path !== path)
		return null;
	const settings = await readableSettings();
	// Unread settings admit nobody: whether the readers are enforced is not known.
	return settings !== null &&
		readerAdmits(description.readers, access, settings)
		? blob
		: null;
}

/** Whether the caller may see the picture at `path` (`pictureFor`). */
export async function readablePicture(
	path: string,
	access: CallerAccess | null | undefined,
): Promise<boolean> {
	return (await pictureFor(path, access)) !== null;
}
