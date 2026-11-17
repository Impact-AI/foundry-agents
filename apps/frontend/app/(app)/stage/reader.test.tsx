import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { NextIntlClientProvider } from "next-intl";
import { renderToStaticMarkup } from "react-dom/server";
import type { ReaderDocument } from "@/src/stage/stage";
import en from "../../../messages/en.json";
import { loadStreamdown } from "../../components/markdown/streamdown-lazy";
import { ReaderTile } from "./ReaderTile";

const ITEM =
	"- **Band Copper:** 41,000 to 48,000 EUR, *for associates*, see [the policy](https://example.com/pay).";

const memo = (markdown: boolean): ReaderDocument => ({
	id: "d1",
	title: "Salary bands",
	summary: "",
	tags: [],
	sections: [{ heading: "Bands", text: `Three bands.\n\n${ITEM}` }],
	markdown,
	media: [],
});

const draw = (document: ReaderDocument) =>
	renderToStaticMarkup(
		<NextIntlClientProvider locale="en" messages={en} timeZone="UTC">
			<ReaderTile instrument={{ section: "reader", document, page: 1 }} />
		</NextIntlClientProvider>,
	);

/** A server render has no document; an earlier file's stub must not make it one. */
let savedDocument: PropertyDescriptor | undefined;
beforeAll(async () => {
	savedDocument = Object.getOwnPropertyDescriptor(globalThis, "document");
	delete (globalThis as { document?: unknown }).document;
	await loadStreamdown();
});
afterAll(() => {
	if (savedDocument)
		Object.defineProperty(globalThis, "document", savedDocument);
});

describe("the reader's page", () => {
	test("of a Markdown document is rendered: a list item's bold, italics and link are elements", () => {
		const out = draw(memo(true));
		expect(out).toMatch(/<ul[^>]*>\s*<li[^>]*>/);
		expect(out).toMatch(/<(strong|span)[^>]*>Band Copper:<\/(strong|span)>/);
		expect(out).toContain("<em>for associates</em>");
		expect(out).toMatch(/<a[^>]*href="https:\/\/example\.com\/pay"[^>]*>/);
		expect(out).not.toContain("**");
		expect(out).not.toContain("- ");
	});

	test("of any other document is its text as written", () => {
		const out = draw(memo(false));
		expect(out).toContain(">Three bands.\n\n- **Band Copper:**");
		expect(out).not.toMatch(/<ul[^>]*>/);
	});
});
