import { expect, test } from "bun:test";
import { returnPath } from "./return-path";

test("a path on this origin is returned to, query and fragment kept", () => {
	expect(returnPath("/settings?tab=notes#top")).toBe("/settings?tab=notes#top");
});

test("anything a browser would take off this origin goes to the chat instead", () => {
	for (const elsewhere of [
		"//evil.example",
		"/\\evil.example",
		"/\t/evil.example",
		"https://evil.example/chat",
		"javascript:alert(1)",
		"",
		null,
	])
		expect(returnPath(elsewhere)).toBe("/chat");
});
