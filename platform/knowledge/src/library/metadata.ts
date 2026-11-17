import { createHash } from "node:crypto";
import { type DocumentDescription, documentKind } from "../types";

/**
 * A file's description as its blob carries it, for the indexer to map onto
 * every chunk it cuts. Blob metadata is ASCII, and all of a blob's metadata
 * together is at most 8 KB, so:
 *
 * - text that may not be ASCII (the path, the title, the summary) is base64,
 *   which the indexer's `base64Decode` mapping reads back;
 * - lists (the tags, the readers) are JSON arrays with every non-ASCII
 *   character escaped, which `jsonArrayToStringCollection` parses;
 * - the id, the library and the kind are ASCII already, and travel as
 *   they are.
 *
 * The keys are lower case, because they come back over HTTP that way.
 */

/** The metadata keys, which are also the indexer's source field names. */
export const METADATA = {
	id: "id",
	path: "path",
	library: "library",
	kind: "kind",
	title: "title",
	summary: "summary",
	tags: "tags",
	oids: "oids",
	groups: "groups",
} as const;

/** What the service allows one blob's metadata, names and values together. */
export const METADATA_MAX_BYTES = 8 * 1024;

/**
 * Principals one file may name across `oids` and `groups`: about a hundred
 * object ids fit beside a title and a summary. More is a sign the readers
 * belong in a group.
 */
export const MAX_READERS = 100;

export class MetadataTooLargeError extends Error {
	constructor(path: string, problem: string) {
		super(`${path}: ${problem}`);
		this.name = "MetadataTooLargeError";
	}
}

/** A document's id: short, opaque and stable for its path, so a reload names it the same way. */
export function documentIdOf(path: string): string {
	return createHash("sha256").update(path).digest("hex").slice(0, 32);
}

const toBase64 = (text: string) => Buffer.from(text, "utf8").toString("base64");
const fromBase64 = (text: string) =>
	Buffer.from(text, "base64").toString("utf8");

/** JSON with every character past ASCII written as `\uXXXX`, which every JSON parser reads back. */
function asciiJson(values: readonly string[]): string {
	return JSON.stringify(values).replace(
		/[^ -~]/g,
		(c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`,
	);
}

function size(metadata: Record<string, string>): number {
	let bytes = 0;
	for (const [key, value] of Object.entries(metadata))
		bytes += key.length + value.length;
	return bytes;
}

/**
 * The description as metadata, or a typed error naming the file when it
 * cannot be carried: too many readers, or too much text in all.
 */
export function encodeMetadata(
	description: DocumentDescription,
): Record<string, string> {
	const readers =
		description.readers.oids.length + description.readers.groups.length;
	if (readers > MAX_READERS)
		throw new MetadataTooLargeError(
			description.path,
			`names ${readers} readers, more than the ${MAX_READERS} a file's metadata can carry; give them a group and name the group`,
		);
	const metadata = {
		[METADATA.id]: description.id,
		[METADATA.path]: toBase64(description.path),
		[METADATA.library]: description.library,
		[METADATA.kind]: description.kind,
		[METADATA.title]: toBase64(description.title),
		[METADATA.summary]: toBase64(description.summary),
		[METADATA.tags]: asciiJson(description.tags),
		[METADATA.oids]: asciiJson(description.readers.oids),
		[METADATA.groups]: asciiJson(description.readers.groups),
	};
	const bytes = size(metadata);
	if (bytes > METADATA_MAX_BYTES)
		throw new MetadataTooLargeError(
			description.path,
			`its description is ${bytes} bytes as metadata, more than the ${METADATA_MAX_BYTES} a blob may carry; shorten the summary or the tags`,
		);
	return metadata;
}

function stringArray(text: string | undefined): string[] | null {
	if (text === undefined) return null;
	try {
		const parsed: unknown = JSON.parse(text);
		return Array.isArray(parsed) && parsed.every((v) => typeof v === "string")
			? parsed
			: null;
	} catch {
		return null;
	}
}

/**
 * The description a blob carries, or null when it carries none, or one this
 * code did not write: a blob nobody described is no document.
 */
export function decodeMetadata(
	metadata: Record<string, string>,
): DocumentDescription | null {
	const kind = documentKind.safeParse(metadata[METADATA.kind]);
	const tags = stringArray(metadata[METADATA.tags]);
	const oids = stringArray(metadata[METADATA.oids]);
	const groups = stringArray(metadata[METADATA.groups]);
	const id = metadata[METADATA.id];
	const path = metadata[METADATA.path];
	const library = metadata[METADATA.library];
	if (!kind.success || !tags || !oids || !groups || !id || !path || !library)
		return null;
	return {
		id,
		path: fromBase64(path),
		library,
		kind: kind.data,
		title: fromBase64(metadata[METADATA.title] ?? ""),
		summary: fromBase64(metadata[METADATA.summary] ?? ""),
		tags,
		readers: { oids, groups },
	};
}
