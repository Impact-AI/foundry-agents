import { expect, test } from "bun:test";
import { cleanTitle } from "./generate-title";
import { TITLE_MAX, titleFrom } from "./title-from";

test("a short message is its own title; a long one is cut at a word and marked", () => {
	expect(titleFrom("  How far   is it\nfrom here? ")).toBe(
		"How far is it from here?",
	);
	const long = titleFrom(`${"word ".repeat(30)}end`);
	expect(long.length).toBeLessThanOrEqual(TITLE_MAX + 1);
	expect(long.endsWith("…")).toBe(true);
	expect(long).not.toContain("wor…");
	expect(titleFrom("")).toBe("");
});

test("a single word over the budget is hard cut rather than dropped", () => {
	const title = titleFrom("x".repeat(100));
	expect(title).toBe(`${"x".repeat(TITLE_MAX)}…`);
});

test("a cut never falls inside a character: the whole one is given up", () => {
	const title = titleFrom(`${"a".repeat(TITLE_MAX - 1)}😀 and more`);
	expect(title).toBe(`${"a".repeat(TITLE_MAX - 1)}…`);
	expect(title.isWellFormed()).toBe(true);
});

test("a title said wrong is repaired; prose and nothing are refused", () => {
	expect(cleanTitle('Title: "Rain on Tuesday."')).toBe("Rain on Tuesday");
	expect(cleanTitle("  «Les  pluies»\n")).toBe("Les pluies");
	expect(cleanTitle("")).toBeNull();
	expect(cleanTitle("a ".repeat(60))).toBeNull();
});
