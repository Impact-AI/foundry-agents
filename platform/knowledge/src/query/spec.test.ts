import { describe, expect, test } from "bun:test";
import { buildFilter } from "./spec";

describe("buildFilter", () => {
	test("nothing asked is no filter; tags default to any, 'all' requires every one", () => {
		expect(buildFilter({})).toBeNull();
		expect(buildFilter({ tags: [], kinds: [] })).toBeNull();
		expect(buildFilter({ tags: ["a", "b"] })).toBe(
			"tags/any(t: search.in(t, 'a|b', '|'))",
		);
		expect(buildFilter({ tags: ["a", "b"], tagMode: "all" })).toBe(
			"tags/any(t: t eq 'a') and tags/any(t: t eq 'b')",
		);
	});

	test("a comma or a quote in a tag round-trips", () => {
		expect(buildFilter({ tags: ["deflection, kinetic"] })).toContain(
			"'deflection, kinetic'",
		);
		expect(buildFilter({ tags: ["o'neill"] })).toContain("'o''neill'");
	});

	test("a tag holding search.in's delimiter is compared on its own, so no tag makes a filter that cannot be built", () => {
		expect(buildFilter({ tags: ["a|b"] })).toBe("tags/any(t: t eq 'a|b')");
		expect(buildFilter({ tags: ["x", "a|b"], kinds: ["picture"] })).toBe(
			"(tags/any(t: search.in(t, 'x', '|')) or tags/any(t: t eq 'a|b')) and search.in(kind, 'picture', '|')",
		);
	});

	test("a kind composes with the tags", () => {
		expect(buildFilter({ tags: ["a"], kinds: ["picture"] })).toBe(
			"tags/any(t: search.in(t, 'a', '|')) and search.in(kind, 'picture', '|')",
		);
	});
});
