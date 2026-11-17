import { expect, test } from "bun:test";
import {
	defineToolGating,
	parseToolGating,
	storedToolGating,
	type ToolGatingConfig,
} from "./tool-gating";

const DEFAULTS: ToolGatingConfig = {
	enabledTools: ["knowledge", "webSearch"],
	skillsEnabled: true,
};

test("a stored document is merged over the default field by field", () => {
	expect(
		parseToolGating(
			{
				enabled_tools: ["knowledge", 3, ""],
				skills_enabled: false,
			},
			DEFAULTS,
		),
	).toEqual({
		enabledTools: ["knowledge"],
		skillsEnabled: false,
	});
	expect(parseToolGating({ skills_enabled: "no" }, DEFAULTS)).toEqual(DEFAULTS);
});

test("something that is not a document is the default whole", () => {
	expect(parseToolGating("oops", DEFAULTS)).toBe(DEFAULTS);
	expect(parseToolGating([1], DEFAULTS)).toBe(DEFAULTS);
});

test("the stored shape reads back as the config it was written from", () => {
	const narrowed = { ...DEFAULTS, enabledTools: [], skillsEnabled: false };
	expect(
		parseToolGating(
			JSON.parse(JSON.stringify(storedToolGating(narrowed))),
			DEFAULTS,
		),
	).toEqual(narrowed);
});

test("the key serves the default before any read, with the product's tools on", () => {
	const gating = defineToolGating({ defaultEnabledTools: ["knowledge"] });
	expect(gating.cached()).toEqual({
		enabledTools: ["knowledge"],
		skillsEnabled: true,
	});
});

test("two definitions with different defaults each serve their own", () => {
	const a = defineToolGating({ defaultEnabledTools: ["a"] });
	const b = defineToolGating({ defaultEnabledTools: ["b"] });
	expect(a.cached().enabledTools).toEqual(["a"]);
	expect(b.cached().enabledTools).toEqual(["b"]);
});
