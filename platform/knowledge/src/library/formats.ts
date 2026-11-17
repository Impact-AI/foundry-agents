import type { DocumentKind } from "../types";

/**
 * What a library may hold, by extension: everything the indexer cracks into
 * text, and the pictures OCR reads and the media route serves. The type is
 * the one a blob is stored under, so the indexer picks the right cracker and
 * the media route serves a picture as the image it is, whatever type the
 * tool that uploaded it guessed.
 *
 * JSON is not a format: the indexer selects files by extension, and a
 * library's own `access.json` and `catalog.json` would be indexed with it.
 */
const DOCUMENTS: Record<string, string> = {
	pdf: "application/pdf",
	docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
	doc: "application/msword",
	pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
	ppt: "application/vnd.ms-powerpoint",
	xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
	xls: "application/vnd.ms-excel",
	html: "text/html; charset=utf-8",
	htm: "text/html; charset=utf-8",
	md: "text/markdown; charset=utf-8",
	txt: "text/plain; charset=utf-8",
	csv: "text/csv; charset=utf-8",
};

const PICTURES: Record<string, string> = {
	png: "image/png",
	jpg: "image/jpeg",
	jpeg: "image/jpeg",
	gif: "image/gif",
};

/** The formats whose text the reader renders from the file itself, in order and whole. */
const READ_AS_TEXT = new Set(["md", "txt", "csv"]);

export interface FileFormat {
	kind: DocumentKind;
	contentType: string;
	/** Rendered by the reader from the file; anything else from the chunks the indexer cut. */
	readAsText: boolean;
	markdown: boolean;
}

function extension(path: string): string {
	const name = path.slice(path.lastIndexOf("/") + 1);
	const dot = name.lastIndexOf(".");
	return dot > 0 ? name.slice(dot + 1).toLowerCase() : "";
}

/** The format of a file by its name, or null for one a library does not take. */
export function formatOf(path: string): FileFormat | null {
	const ext = extension(path);
	const picture = PICTURES[ext];
	if (picture)
		return {
			kind: "picture",
			contentType: picture,
			readAsText: false,
			markdown: false,
		};
	const document = DOCUMENTS[ext];
	if (!document) return null;
	return {
		kind: "document",
		contentType: document,
		readAsText: READ_AS_TEXT.has(ext),
		markdown: ext === "md",
	};
}

/** The indexer's `indexedFileNameExtensions`: every format, and nothing else. */
export function indexedExtensions(): string {
	return [...Object.keys(DOCUMENTS), ...Object.keys(PICTURES)]
		.map((ext) => `.${ext}`)
		.join(",");
}
