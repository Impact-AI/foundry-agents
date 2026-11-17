import { expect, test } from "bun:test";
import { readdir } from "node:fs/promises";
import { join } from "node:path";
import {
	ACCESS_MANIFEST_NAME,
	formatOf,
	GLOBAL_ACCESS_GROUP,
	manifestAccessFor,
	markdownSections,
	parseAccessManifest,
	parseMarkdownDocument,
	resolvePicturePath,
} from "@platform/knowledge";
import { SAMPLE_LIBRARY_DIR } from "./library";

/** A picture is a page's decoration, not a download. */
const PICTURE_MAX_BYTES = 300 * 1024;
const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

const files = (
	await readdir(SAMPLE_LIBRARY_DIR, { recursive: true, withFileTypes: true })
)
	.filter((entry) => entry.isFile())
	.map((entry) =>
		join(entry.parentPath, entry.name).slice(SAMPLE_LIBRARY_DIR.length + 1),
	)
	.sort();
const documents = await Promise.all(
	files
		.filter((path) => formatOf(path)?.kind === "document")
		.map(async (relPath) => ({
			relPath,
			...parseMarkdownDocument(
				await Bun.file(join(SAMPLE_LIBRARY_DIR, relPath)).text(),
			),
		})),
);
const pictures = files.filter((path) => formatOf(path)?.kind === "picture");

test("the library is nine Markdown documents, the pictures they show and its manifest, and nothing a library does not take", () => {
	expect(documents).toHaveLength(9);
	expect(documents.every((d) => d.relPath.endsWith(".md"))).toBe(true);
	expect(files.filter((path) => !formatOf(path))).toEqual([
		ACCESS_MANIFEST_NAME,
	]);
});

test("every document's front matter names, summarises and tags it", () => {
	for (const d of documents) {
		expect(d.title, d.relPath).toBeString();
		expect(d.summary?.length ?? 0, d.relPath).toBeGreaterThan(20);
		expect(d.tags.length, d.relPath).toBeGreaterThan(0);
		expect(d.body.startsWith("## "), d.relPath).toBe(true);
	}
	expect(new Set(documents.map((d) => d.title)).size).toBe(documents.length);
});

test("every document shows at least one picture, every picture exists, and every picture is shown", () => {
	const shown = new Set<string>();
	for (const d of documents) {
		expect(d.pictures.length, d.relPath).toBeGreaterThan(0);
		for (const p of d.pictures) {
			const path = resolvePicturePath(d.relPath, p.path);
			expect(path && pictures.includes(path), `${d.relPath} → ${p.path}`).toBe(
				true,
			);
			expect(p.alt.length, `${d.relPath} → ${p.path}`).toBeGreaterThan(20);
			shown.add(path as string);
		}
	}
	expect([...shown].sort()).toEqual(pictures);
});

test("every picture is a PNG under the size cap", async () => {
	for (const path of pictures) {
		const bytes = new Uint8Array(
			await Bun.file(join(SAMPLE_LIBRARY_DIR, path)).arrayBuffer(),
		);
		expect([...bytes.subarray(0, 8)], path).toEqual(PNG_SIGNATURE);
		expect(bytes.byteLength, path).toBeLessThan(PICTURE_MAX_BYTES);
	}
});

test("the reader pages each document by its sections as written, none of them empty", () => {
	for (const d of documents) {
		const headings = [...d.body.matchAll(/^## (.+)$/gm)].map(
			(m) => m[1] as string,
		);
		const sections = markdownSections(d.body);
		expect(
			sections.map((s) => s.heading),
			d.relPath,
		).toEqual(headings);
		for (const s of sections)
			expect(s.text.length, d.relPath).toBeGreaterThan(0);
	}
});

test("the access manifest makes every file readable by every signed-in person", async () => {
	const manifest = parseAccessManifest(
		await Bun.file(join(SAMPLE_LIBRARY_DIR, ACCESS_MANIFEST_NAME)).text(),
	);
	for (const path of [...documents.map((d) => d.relPath), ...pictures])
		expect(manifestAccessFor(manifest, path), path).toEqual({
			oids: [],
			groups: [GLOBAL_ACCESS_GROUP],
		});
});
