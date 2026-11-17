import { expect, test } from "bun:test";
import {
	FrontMatterError,
	markdownSections,
	parseMarkdownDocument,
	resolvePicturePath,
} from "./markdown";

test("front matter names, summarises and tags the document, and leaves the body", () => {
	const document = parseMarkdownDocument(
		[
			"---",
			"title: Expense policy",
			"summary: 'What is paid back, and how fast.'",
			'tags: [finance, "people", finance]',
			"---",
			"",
			"## Travel",
			"",
			"Book through the portal.",
		].join("\n"),
	);
	expect(document).toEqual({
		title: "Expense policy",
		summary: "What is paid back, and how fast.",
		tags: ["finance", "people"],
		body: "## Travel\n\nBook through the portal.",
		pictures: [],
	});
	expect(parseMarkdownDocument("---\ntags: a, b\n---\nx").tags).toEqual([
		"a",
		"b",
	]);
});

test("a document without front matter is all body", () => {
	expect(parseMarkdownDocument("# Notes\n\nText.")).toEqual({
		tags: [],
		body: "# Notes\n\nText.",
		pictures: [],
	});
});

test("a picture on a line of its own at a relative path is lifted out of the text; a URL stays text", () => {
	const document = parseMarkdownDocument(
		[
			"Before.",
			"",
			"![The loading bay at dusk](pictures/bay.png)",
			"",
			"![Elsewhere](https://example.com/x.png)",
			"",
			"After, with ![inline](a.png) in a sentence.",
		].join("\n"),
	);
	expect(document.pictures).toEqual([
		{ alt: "The loading bay at dusk", path: "pictures/bay.png" },
	]);
	expect(document.body).toBe(
		"Before.\n\n![Elsewhere](https://example.com/x.png)\n\nAfter, with ![inline](a.png) in a sentence.",
	);
});

test("an unknown key, a repeated key or an unreadable line is the author's mistake, not body text", () => {
	for (const block of [
		"author: me",
		"title: a\ntitle: b",
		"just words",
		// The index's `search.in` has no escape for its delimiter.
		"tags: [finance, a|b]",
	])
		expect(() => parseMarkdownDocument(`---\n${block}\n---\nBody`)).toThrow(
			FrontMatterError,
		);
});

test("a picture resolves against its document and never climbs out of the directory", () => {
	expect(resolvePicturePath("guides/a.md", "../pictures/x.png")).toBe(
		"pictures/x.png",
	);
	expect(resolvePicturePath("a.md", "./pictures/x.png")).toBe("pictures/x.png");
	expect(resolvePicturePath("a.md", "../x.png")).toBeNull();
});

test("a body is paged by its headings, any text before the first a section of its own", () => {
	expect(
		markdownSections(
			"Lead-in.\n\n## Why\n\nBecause.\n\n### The three waves ##\n\nOne, two, three.\n",
		),
	).toEqual([
		{ heading: "", text: "Lead-in." },
		{ heading: "Why", text: "Because." },
		{ heading: "The three waves", text: "One, two, three." },
	]);
	expect(markdownSections("## Only\n\nText.")).toEqual([
		{ heading: "Only", text: "Text." },
	]);
	expect(markdownSections("")).toEqual([]);
});
