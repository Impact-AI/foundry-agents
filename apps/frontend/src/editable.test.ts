import { expect, test } from "bun:test";
import { isEditable } from "./editable";

test("a field keeps its own keys; anything else leaves them to the page", () => {
	for (const tagName of ["TEXTAREA", "input", "SELECT"])
		expect(isEditable({ tagName })).toBe(true);
	expect(isEditable({ tagName: "DIV", isContentEditable: true })).toBe(true);
	for (const target of [{ tagName: "BUTTON" }, { tagName: "DIV" }, null, {}])
		expect(isEditable(target)).toBe(false);
});
