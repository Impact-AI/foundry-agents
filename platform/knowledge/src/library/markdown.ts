/**
 * A Markdown document as a library holds it: front matter that says what it
 * is, a body that is its text, and the pictures it shows, by relative path.
 * The front matter is the part of a document the index reads first — the
 * title, the summary, and the tags, its one filterable field — so it is
 * parsed strictly: a key this does not know, or a line it cannot read, is
 * the author's mistake and fails the file rather than being described
 * wrongly.
 *
 * Only the three keys and only their simple forms: `key: value`, a value in
 * optional quotes, and tags as `[a, b]` or `a, b`. This is not a YAML parser
 * and does not pretend to be one.
 */
import { tagProblem } from "./manifest";

export interface MarkdownPicture {
	/** The alt text: what the picture shows, in the author's words. */
	alt: string;
	/** As written, relative to the document. */
	path: string;
}

export interface MarkdownDocument {
	title?: string;
	summary?: string;
	tags: string[];
	/** The text without its front matter and without the picture lines. */
	body: string;
	pictures: MarkdownPicture[];
}

export class FrontMatterError extends Error {
	constructor(problem: string) {
		super(`front matter: ${problem}`);
		this.name = "FrontMatterError";
	}
}

const FENCE = /^---\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/;
/** A picture on a line of its own, at a path rather than a URL. */
const PICTURE_LINE = /^[ \t]*!\[([^\]]*)\]\(([^)\s]+)\)[ \t]*$/gm;
const KEYS = ["title", "summary", "tags"] as const;
type Key = (typeof KEYS)[number];

function unquote(value: string): string {
	const v = value.trim();
	const quoted = /^(["'])(.*)\1$/.exec(v);
	return (quoted ? quoted[2] : v)?.trim() ?? "";
}

function tagList(value: string): string[] {
	const inner = value.trim().replace(/^\[(.*)\]$/, "$1");
	const tags: string[] = [];
	for (const raw of inner.split(",")) {
		const tag = unquote(raw);
		const problem = tagProblem(tag);
		if (problem) throw new FrontMatterError(problem);
		if (tag && !tags.includes(tag)) tags.push(tag);
	}
	return tags;
}

function frontMatter(block: string): Partial<Record<Key, string>> {
	const fields: Partial<Record<Key, string>> = {};
	block.split(/\r?\n/).forEach((line, i) => {
		if (!line.trim() || line.trimStart().startsWith("#")) return;
		const match = /^([A-Za-z]+):(.*)$/.exec(line);
		if (!match) throw new FrontMatterError(`line ${i + 1} is not "key: value"`);
		const key = match[1]?.toLowerCase() as Key;
		if (!KEYS.includes(key))
			throw new FrontMatterError(
				`"${match[1]}" is not one of ${KEYS.join(", ")}`,
			);
		if (key in fields) throw new FrontMatterError(`"${key}" is given twice`);
		fields[key] = match[2] ?? "";
	});
	return fields;
}

function isRelativePath(path: string): boolean {
	return !/^[a-z][a-z0-9+.-]*:/i.test(path) && !path.startsWith("/");
}

/** The pictures `text` shows on lines of their own, lifted out of it. Front matter is not read. */
export function liftPictures(text: string): {
	text: string;
	pictures: MarkdownPicture[];
} {
	const pictures: MarkdownPicture[] = [];
	const rest = text
		.replace(PICTURE_LINE, (line, alt: string, path: string) => {
			if (!isRelativePath(path)) return line;
			pictures.push({ alt: alt.trim(), path });
			return "";
		})
		.replace(/\n{3,}/g, "\n\n")
		.trim();
	return { text: rest, pictures };
}

export function parseMarkdownDocument(text: string): MarkdownDocument {
	const fence = FENCE.exec(text);
	const fields = fence ? frontMatter(fence[1] ?? "") : {};
	const { text: body, pictures } = liftPictures(
		fence ? text.slice(fence[0].length) : text,
	);
	const title = fields.title === undefined ? "" : unquote(fields.title);
	const summary = fields.summary === undefined ? "" : unquote(fields.summary);
	return {
		...(title ? { title } : {}),
		...(summary ? { summary } : {}),
		tags: fields.tags === undefined ? [] : tagList(fields.tags),
		body,
		pictures,
	};
}

const HEADING = /^#{1,6}[ \t]+(.+?)[ \t#]*$/;

/**
 * A body as the reader pages it: a section per heading, any text before the
 * first heading a section of its own with none.
 */
export function markdownSections(
	body: string,
): { heading: string; text: string }[] {
	const sections: { heading: string; lines: string[] }[] = [];
	let current: { heading: string; lines: string[] } = {
		heading: "",
		lines: [],
	};
	for (const line of body.split(/\r?\n/)) {
		const heading = HEADING.exec(line);
		if (heading) {
			sections.push(current);
			current = { heading: heading[1] ?? "", lines: [] };
		} else current.lines.push(line);
	}
	sections.push(current);
	return sections
		.map((s) => ({ heading: s.heading, text: s.lines.join("\n").trim() }))
		.filter((s) => s.heading || s.text);
}

/**
 * A picture's path resolved against its document's directory, both relative
 * to the directory being loaded, or null when it climbs out of that
 * directory: a document may show what its corpus carries, never a file
 * beside the corpus.
 */
export function resolvePicturePath(
	documentPath: string,
	picturePath: string,
): string | null {
	const segments = documentPath.split("/").slice(0, -1);
	for (const segment of picturePath.split("/")) {
		if (segment === "" || segment === ".") continue;
		if (segment === "..") {
			if (segments.length === 0) return null;
			segments.pop();
		} else segments.push(segment);
	}
	return segments.length > 0 ? segments.join("/") : null;
}
