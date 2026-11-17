import { expect, test } from "bun:test";
import { stableTag } from "./stable-tag";

test("the same input gives the same sixteen hex characters, and not the input", () => {
	const tag = stableTag("Someone@Example.test");
	expect(tag).toMatch(/^[0-9a-f]{16}$/);
	expect(tag).toBe(stableTag("  someone@example.test "));
	expect(tag).not.toContain("example");
});

test("two inputs differing in one character do not share a tag", () => {
	expect(stableTag("a::b:thread:1")).not.toBe(stableTag("a::b:thread:2"));
});

test("no value is '-', not a tag of the empty string", () => {
	expect(stableTag(null)).toBe("-");
	expect(stableTag(undefined)).toBe("-");
	expect(stableTag("   ")).toBe("-");
});
