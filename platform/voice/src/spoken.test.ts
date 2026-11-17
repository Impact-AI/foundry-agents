import { expect, test } from "bun:test";
import {
	AFTER_TOOL_EXAMPLES,
	afterToolRule,
	REACH_ASIDE_EXAMPLES,
	SPOKEN_DELIVERY,
} from "./spoken";

test("the spoken register says it is heard, and names nothing the ear cannot follow", () => {
	expect(SPOKEN_DELIVERY).toStartWith("YOU ARE SPEAKING, NOT WRITING.");
	expect(SPOKEN_DELIVERY).toContain("No markdown");
	expect(SPOKEN_DELIVERY).toContain("a tool's own name is never spoken");
});

test("the rule carries its examples as data, and reach-aside off replaces the permission with silence and drops them", () => {
	const on = afterToolRule();
	for (const line of [...REACH_ASIDE_EXAMPLES, ...AFTER_TOOL_EXAMPLES]) {
		expect(on).toContain(`"${line}"`);
	}
	const off = afterToolRule({ reachAside: false });
	expect(off).toContain("take the wait in SILENCE");
	for (const line of REACH_ASIDE_EXAMPLES) expect(off).not.toContain(line);
	for (const line of AFTER_TOOL_EXAMPLES) expect(off).toContain(line);
	expect(off).toContain("AFTER YOU DRIVE THE INTERFACE, SPEAK");
});
