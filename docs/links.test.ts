/**
 * Every relative link in the documentation resolves: the file exists, and an
 * anchor names a heading of the page it points at. The documentation is
 * these pages, the Markdown files at the root, and each package's and each
 * app's README. No link leaves the repository. Inline links and images are
 * read; reference-style links are not, and no page uses one. A table row
 * keeps its cells: no code span in one holds a bare pipe.
 */
import { expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import {
	anchors,
	barePipesInTables,
	prose,
	repositoryRoot,
	tableRows,
} from "./markdown";

const ROOT = repositoryRoot();

/** The Markdown files directly in `dir`. */
const markdownIn = (dir: string) =>
	readdirSync(dir)
		.filter((name) => name.endsWith(".md"))
		.map((name) => join(dir, name));

/** The README of each directory under `dir` that has one. */
const readmesUnder = (dir: string) =>
	readdirSync(join(ROOT, dir))
		.map((name) => join(ROOT, dir, name, "README.md"))
		.filter((file) => existsSync(file));

const pages = [
	...markdownIn(ROOT),
	...markdownIn(import.meta.dir),
	...readmesUnder("platform"),
	...readmesUnder("apps"),
];

/**
 * Every link target in a page's prose, inline code aside: inline links and
 * images alike. A target may hold one level of parentheses, as a route
 * group's folder does.
 */
function links(markdown: string): string[] {
	const text = prose(markdown).replace(/`[^`\n]*`/g, "");
	return [
		...text.matchAll(/\]\(((?:[^()\s]|\([^()\s]*\))+)(?:\s+"[^"]*")?\)/g),
	].map((m) => m[1] as string);
}

const external = (target: string) => /^[a-z][a-z0-9+.-]*:/i.test(target);

test("there are pages to check: the root's, the docs, and a README per package and app", () => {
	const names = pages.map((page) => relative(ROOT, page));
	expect(names).toContain("README.md");
	expect(names).toContain("CONTRIBUTING.md");
	expect(names).toContain("docs/configuration.md");
	expect(names).toContain("platform/agent/README.md");
	expect(names).toContain("apps/frontend/README.md");
	expect(pages.length).toBeGreaterThan(30);
});

test("a link target may hold a route group's parentheses", () => {
	expect(
		links("see [the page](../app/(app)/chat/page.tsx) and [b](c.md)"),
	).toEqual(["../app/(app)/chat/page.tsx", "c.md"]);
});

for (const page of pages) {
	const name = relative(ROOT, page);
	const text = readFileSync(page, "utf8");

	test(`${name}: every relative link resolves, anchors included`, () => {
		const broken: string[] = [];
		for (const target of links(text)) {
			if (external(target)) continue;
			const [path = "", anchor] = target.split("#", 2);
			const file = path ? resolve(dirname(page), decodeURI(path)) : page;
			if (!existsSync(file)) {
				broken.push(`${target}: no such file`);
				continue;
			}
			if (
				anchor &&
				!(
					statSync(file).isFile() &&
					anchors(readFileSync(file, "utf8")).has(anchor)
				)
			)
				broken.push(`${target}: no such heading`);
		}
		expect(broken).toEqual([]);
	});

	test(`${name}: no relative link leaves the repository`, () => {
		const outside = links(text)
			.filter((target) => !external(target) && !target.startsWith("#"))
			.map((target) =>
				resolve(dirname(page), decodeURI(target.split("#")[0] ?? "")),
			)
			.filter((file) => relative(ROOT, file).startsWith(".."));
		expect(outside).toEqual([]);
	});
}

test("a pipe in a table cell is escaped, and read back as the cell's own", () => {
	expect(barePipesInTables("| a | `x|y` |\n| b | `x\\|y` |")).toEqual([
		"1: `x|y`",
	]);
	expect(barePipesInTables("```\n| a | `x|y` |\n```\nnot a | `row|`")).toEqual(
		[],
	);
	expect(tableRows("| h | i |\n| --- | --- |\n| a | `x\\|y` z |")).toEqual([
		["a", "`x|y` z"],
	]);
});

for (const page of pages)
	test(`${relative(ROOT, page)}: no table row is cut at a code span's pipe`, () => {
		expect(barePipesInTables(readFileSync(page, "utf8"))).toEqual([]);
	});
