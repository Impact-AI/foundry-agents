/**
 * Just enough Markdown for the documentation's own tests: the sections a
 * page is cut into, the rows of its tables, the code spans in a cell, and
 * GitHub's anchor for a heading.
 */
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";

/** The repository root: the nearest directory above this one that holds the apps. */
export function repositoryRoot(): string {
	let dir = import.meta.dir;
	for (let i = 0; i < 6; i++) {
		if (existsSync(join(dir, "apps", "backend", "package.json"))) return dir;
		dir = dirname(dir);
	}
	throw new Error(`no repository root above ${import.meta.dir}`);
}

/** The text of a page with fenced code blocks and HTML comments blanked, so neither is read as prose. */
export function prose(markdown: string): string {
	return markdown
		.replace(/<!--[\s\S]*?-->/g, "")
		.replace(/^```[\s\S]*?^```/gm, "");
}

/** The body under the first heading at `level` whose text is `title`, up to the next heading at that level or above. */
export function section(
	markdown: string,
	level: number,
	title: string,
): string {
	const lines = prose(markdown).split("\n");
	const marker = "#".repeat(level);
	const start = lines.indexOf(`${marker} ${title}`);
	if (start < 0) throw new Error(`no heading "${marker} ${title}"`);
	const end = lines.findIndex(
		(line, i) => i > start && new RegExp(`^#{1,${level}} `).test(line),
	);
	return lines.slice(start + 1, end < 0 ? undefined : end).join("\n");
}

/** Every heading at `level` in `text`, with the body under it. */
export function subsections(text: string, level: number): Map<string, string> {
	const out = new Map<string, string>();
	const marker = `${"#".repeat(level)} `;
	let current: string | null = null;
	let body: string[] = [];
	for (const line of text.split("\n")) {
		if (line.startsWith(marker)) {
			if (current !== null) out.set(current, body.join("\n"));
			current = line.slice(marker.length).trim();
			body = [];
		} else body.push(line);
	}
	if (current !== null) out.set(current, body.join("\n"));
	return out;
}

/**
 * The body rows of every table in `text`, each as its cells. A pipe written
 * `\|` is the cell's own character, as GitHub reads it, and comes back bare.
 */
export function tableRows(text: string): string[][] {
	const rows: string[][] = [];
	let header = true;
	for (const line of text.split("\n")) {
		if (!line.startsWith("|")) {
			header = true;
			continue;
		}
		if (header) {
			header = false;
			continue;
		}
		if (/^\|[\s:|-]+\|$/.test(line)) continue;
		rows.push(
			line
				.slice(1, -1)
				.split(/(?<!\\)\|/)
				.map((cell) => cell.trim().replaceAll("\\|", "|")),
		);
	}
	return rows;
}

/**
 * The code spans of table rows that hold a bare pipe, each with its line
 * number. GitHub splits a row at every unescaped pipe, a code span's
 * included, so such a row loses the rest of its cell.
 */
export function barePipesInTables(markdown: string): string[] {
	const found: string[] = [];
	let fenced = false;
	markdown.split("\n").forEach((line, index) => {
		if (line.trimStart().startsWith("```")) fenced = !fenced;
		if (fenced || !line.startsWith("|")) return;
		for (const [span] of line.matchAll(/`[^`]+`/g))
			if (/(?<!\\)\|/.test(span)) found.push(`${index + 1}: ${span}`);
	});
	return found;
}

/** The code spans in a cell. */
export function codeSpans(cell: string): string[] {
	return [...cell.matchAll(/`([^`]+)`/g)].map((m) => m[1] as string);
}

/** GitHub's anchor for a heading, numbered as GitHub numbers repeats. */
export function anchors(markdown: string): Set<string> {
	const seen = new Map<string, number>();
	const out = new Set<string>();
	for (const [, text] of prose(markdown).matchAll(/^#{1,6} (.+)$/gm)) {
		const slug = (text as string)
			.toLowerCase()
			.replace(/[^\p{L}\p{N} _-]/gu, "")
			.replace(/ /g, "-");
		const n = seen.get(slug) ?? 0;
		seen.set(slug, n + 1);
		out.add(n === 0 ? slug : `${slug}-${n}`);
	}
	return out;
}
