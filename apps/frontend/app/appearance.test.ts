import { describe, expect, test } from "bun:test";
import {
	appearanceAttributes,
	appearanceCss,
	appearanceDefaults,
	DERIVATIONS,
	exprCss,
	FONT_STACKS,
	parseColour,
	radiusTokens,
	SHIPPED_PALETTE,
	SHIPPED_TOKENS,
	spaceTokens,
	typeTokens,
} from "@platform/appearance";
import { locales } from "@/src/i18n/locales";

/**
 * An untouched deployment is pixel-identical to the app as it was built,
 * proved from both ends: the defaults inject nothing, and every value the
 * appearance package would write for its shipped choices is the value the
 * sheet already declares. A token renamed or retuned in `globals.css` without
 * the package (or the reverse) fails here.
 */
const sheet = await Bun.file(new URL("./globals.css", import.meta.url)).text();

function declarations(block: string): Record<string, string> {
	const out: Record<string, string> = {};
	for (const m of block.matchAll(/--([\w-]+):\s*([^;]+);/g)) {
		const [, name, value] = m;
		// The formatter wraps a long value; whitespace is not part of it.
		if (name && value)
			out[name] = value
				.replace(/\s+/g, " ")
				.replace(/\(\s/g, "(")
				.replace(/\s\)/g, ")")
				.trim();
	}
	return out;
}

const blockOf = (pattern: RegExp): string => {
	const found = pattern.exec(sheet)?.[1];
	if (found === undefined) throw new Error(`globals.css has lost ${pattern}`);
	return found;
};

const dark = declarations(blockOf(/^:root\s*\{([\s\S]*?)\n\}/m));
const lightPreferred = declarations(
	blockOf(
		/@media \(prefers-color-scheme: light\)\s*\{\s*:root:not\(\[data-scheme="dark"\]\)\s*\{([\s\S]*?)\n\t\}/,
	),
);
const lightPinned = declarations(
	blockOf(/^:root\[data-scheme="light"\]\s*\{([\s\S]*?)\n\}/m),
);
const light = { ...dark, ...lightPreferred };
const scheme = { dark, light };

const defaults = appearanceDefaults(locales.codes);

describe("an untouched deployment", () => {
	test("injects no sheet and no attribute", () => {
		expect(appearanceCss(defaults)).toBe("");
		expect(appearanceAttributes(defaults)).toEqual({});
	});

	test("pinning the light scheme draws exactly the light scheme the device would", () => {
		expect(lightPinned).toEqual(lightPreferred);
	});

	test("pinning the dark scheme draws the sheet's own dark scheme: the light block stands aside", () => {
		expect(sheet).toContain(
			'@media (prefers-color-scheme: light) {\n\t:root:not([data-scheme="dark"]) {',
		);
	});
});

describe("the shipped choices are the sheet's own values", () => {
	test("the palette's primitives are the tokens they drive", () => {
		for (const s of ["dark", "light"] as const) {
			const p = SHIPPED_PALETTE[s];
			const t = scheme[s];
			expect(p.surface).toBe(t.bg as string);
			expect(p.primary).toBe(t.accent as string);
			expect(p.warning).toBe(t.danger as string);
			expect(p.success).toBe(t.success as string);
			expect(parseColour(p.ambient)).toEqual(
				parseColour(t["field-tint-3"] as string),
			);
			expect(p.aux).toBe(t["chan-2"] as string);
		}
	});

	test("the colours a contrast check reads are the sheet's", () => {
		for (const s of ["dark", "light"] as const)
			for (const [name, value] of Object.entries(SHIPPED_TOKENS[s]))
				expect(scheme[s][name], `${s} --${name}`).toBe(value);
	});

	test("the font, the base size, the type scale, the spacing and the radii", () => {
		expect(dark["font-sans"]).toBe(FONT_STACKS.system);
		expect(dark["font-base"]).toBe("16px");
		expect(sheet).toContain(
			"font-size: calc(var(--font-base) * var(--text-scale));",
		);
		for (const tokens of [
			typeTokens("standard"),
			spaceTokens("comfortable"),
			radiusTokens(defaults.shape.radius),
		])
			for (const [name, value] of Object.entries(tokens))
				expect(dark[name], `--${name}`).toBe(value);
	});
});

describe("a deployment's own palette", () => {
	test("is re-derived in the sheet exactly as the package derives it, per scheme", () => {
		const derived = (pattern: RegExp) => declarations(blockOf(pattern));
		const expected = (s: "dark" | "light") =>
			Object.fromEntries(DERIVATIONS[s].map(([n, e]) => [n, exprCss(e)]));
		expect(derived(/^:root\[data-palette\]\s*\{([\s\S]*?)\n\}/m)).toEqual(
			expected("dark"),
		);
		expect(
			derived(
				/:root\[data-palette\]:not\(\[data-scheme="dark"\]\)\s*\{([\s\S]*?)\n\t\}/,
			),
		).toEqual(expected("light"));
		expect(
			derived(
				/^:root\[data-palette\]\[data-scheme="light"\]\s*\{([\s\S]*?)\n\}/m,
			),
		).toEqual(expected("light"));
	});
});
