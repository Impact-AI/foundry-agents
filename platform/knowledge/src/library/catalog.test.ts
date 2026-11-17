import { expect, test } from "bun:test";
import { CATALOG_MANIFEST_NAME, describeFile, parseCatalog } from "./catalog";
import { ManifestError } from "./manifest";
import { FrontMatterError } from "./markdown";

const CATALOG = parseCatalog(
	JSON.stringify({
		"reports/q3.pdf": {
			title: "Third-quarter report",
			summary: "Revenue, cost and the depot count.",
			tags: ["finance", "finance", " quarterly "],
		},
		"reports/*.pdf": { tags: ["finance"] },
		"*": { tags: ["library"] },
	}),
);

test("a file the catalog names takes its title, summary and tags; a glob or `*` fills what they say, and the name is the title of last resort", () => {
	expect(describeFile("reports/q3.pdf", CATALOG, null)).toEqual({
		title: "Third-quarter report",
		summary: "Revenue, cost and the depot count.",
		tags: ["finance", "quarterly"],
	});
	expect(describeFile("reports/q2.pdf", CATALOG, null)).toEqual({
		title: "q2",
		summary: "",
		tags: ["finance"],
	});
	expect(describeFile("deck.pptx", CATALOG, null)).toEqual({
		title: "deck",
		summary: "",
		tags: ["library"],
	});
	expect(describeFile("pictures/a.png", null, null)).toEqual({
		title: "a",
		summary: "",
		tags: [],
	});
});

test("a Markdown file says what it is in its front matter, and the catalog is not read for it", () => {
	const markdown = "---\ntitle: Expense policy\ntags: [finance]\n---\n\nBody.";
	expect(describeFile("expense-policy.md", CATALOG, markdown)).toEqual({
		title: "Expense policy",
		summary: "",
		tags: ["finance"],
	});
	expect(describeFile("notes.md", CATALOG, "No front matter.")).toEqual({
		title: "notes",
		summary: "",
		tags: [],
	});
	expect(() =>
		describeFile("bad.md", CATALOG, "---\nauthor: me\n---\nBody."),
	).toThrow(FrontMatterError);
});

test("a malformed catalog is a typed error naming it and the entry", () => {
	const bad = (value: unknown, problem: RegExp) => {
		const path = `handbook/${CATALOG_MANIFEST_NAME}`;
		expect(() => parseCatalog(JSON.stringify(value), path)).toThrow(
			ManifestError,
		);
		expect(() => parseCatalog(JSON.stringify(value), path)).toThrow(problem);
	};
	bad({ "a.pdf": { title: 3 } }, /entry "a.pdf".title must be text/);
	bad({ "a.pdf": { tags: "finance" } }, /array of tags/);
	bad({ "a.pdf": { tags: [""] } }, /not a tag/);
	bad(
		{ "a.pdf": { tags: ["a|b"] } },
		/entry "a.pdf": the tag "a\|b" holds "\|"/,
	);
	bad({ "a.pdf": { author: "me" } }, /unknown field "author"/);
});
