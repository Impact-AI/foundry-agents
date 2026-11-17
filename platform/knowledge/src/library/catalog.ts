import {
	entryObject,
	type Manifest,
	manifestEntryFor,
	parseManifest,
	stringEntries,
	tagProblem,
} from "./manifest";
import { parseMarkdownDocument } from "./markdown";

/**
 * What a library says each file is: its title, its summary and its tags, the
 * part of a document the index reads first. A Markdown file says it in its
 * front matter, read strictly; any other file in an optional `catalog.json`
 * beside `access.json`, under the manifests' one rule; and a file nobody
 * described is its own name, with no summary and no tags.
 */

export const CATALOG_MANIFEST_NAME = "catalog.json";

export interface CatalogEntry {
	title?: string;
	summary?: string;
	tags: string[];
}

export type Catalog = Manifest<CatalogEntry>;

function optionalText(value: unknown, where: string): string | undefined {
	if (value === undefined) return undefined;
	if (typeof value !== "string") throw new Error(`${where} must be text`);
	return value.trim() || undefined;
}

function entryCatalog(value: unknown, key: string): CatalogEntry {
	const given = entryObject(value, key, ["title", "summary", "tags"]);
	const title = optionalText(given.title, `entry "${key}".title`);
	const summary = optionalText(given.summary, `entry "${key}".summary`);
	const tags = stringEntries(given.tags, `entry "${key}".tags`, {
		one: "a tag",
		many: "tags",
	});
	for (const tag of tags) {
		const problem = tagProblem(tag);
		if (problem) throw new Error(`entry "${key}": ${problem}`);
	}
	return {
		...(title ? { title } : {}),
		...(summary ? { summary } : {}),
		tags,
	};
}

export function parseCatalog(
	text: string,
	path = CATALOG_MANIFEST_NAME,
): Catalog {
	return parseManifest(text, path, entryCatalog);
}

/** The file's name without its extension: what a file nobody described is called. */
function nameOf(relPath: string): string {
	const name = relPath.slice(relPath.lastIndexOf("/") + 1);
	const dot = name.lastIndexOf(".");
	return dot > 0 ? name.slice(0, dot) : name;
}

/**
 * Title, summary and tags for one file: the Markdown's own front matter
 * (which throws `FrontMatterError` on a key or a line it cannot read), else
 * the catalog's entry, else the file's name.
 */
export function describeFile(
	relPath: string,
	catalog: Catalog | null,
	markdown: string | null,
): { title: string; summary: string; tags: string[] } {
	const entry: CatalogEntry =
		markdown !== null
			? parseMarkdownDocument(markdown)
			: (manifestEntryFor(catalog, relPath) ?? { tags: [] });
	return {
		title: entry.title ?? nameOf(relPath),
		summary: entry.summary ?? "",
		tags: entry.tags,
	};
}
