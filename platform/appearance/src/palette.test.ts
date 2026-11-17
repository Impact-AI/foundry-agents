import { describe, expect, test } from "bun:test";
import {
	contrast,
	hex,
	opaque,
	parseHex,
	SERIES_MAX_CONTRAST,
	SERIES_MIN_CONTRAST,
	seriesHues,
} from "./colour";
import {
	AA,
	contrastIssues,
	DERIVATIONS,
	exprCss,
	isShippedPalette,
	onPrimary,
	PALETTE_KEYS,
	parseColour,
	primitiveDeclarations,
	resolveColours,
	SCHEMES,
	SHIPPED_PALETTE,
	SHIPPED_TOKENS,
} from "./palette";

/** Hue in degrees of an opaque colour. */
function hueOf(rgb: number): number {
	const { r, g, b } = opaque(rgb);
	const max = Math.max(r, g, b);
	const min = Math.min(r, g, b);
	const d = max - min;
	if (d === 0) return 0;
	const h =
		max === r
			? ((g - b) / d + (g < b ? 6 : 0)) * 60
			: max === g
				? ((b - r) / d + 2) * 60
				: ((r - g) / d + 4) * 60;
	return h;
}

describe("parsing", () => {
	test("a palette colour is #rrggbb, either case", () => {
		expect(parseHex("#7fb2ff")).toBe(0x7fb2ff);
		expect(parseHex("#7FB2FF")).toBe(0x7fb2ff);
		expect(hex(0x081120)).toBe("#081120");
	});

	test("anything else is not a colour", () => {
		for (const bad of ["7fb2ff", "#7fb2f", "#7fb2ffff", "red", "url(x)", ""])
			expect(parseHex(bad)).toBeNull();
	});

	test("the sheet's two spellings of a colour both read", () => {
		expect(parseColour("#ffffff")).toEqual({ r: 255, g: 255, b: 255, a: 1 });
		expect(parseColour("rgba(20, 25, 36, 0.72)")).toEqual({
			r: 20,
			g: 25,
			b: 36,
			a: 0.72,
		});
	});
});

describe("the shipped palette", () => {
	test("is its scheme's own, key for key, and any change is not", () => {
		for (const scheme of SCHEMES) {
			expect(isShippedPalette(SHIPPED_PALETTE[scheme], scheme)).toBe(true);
			for (const key of PALETTE_KEYS)
				expect(
					isShippedPalette(
						{ ...SHIPPED_PALETTE[scheme], [key]: "#123456" },
						scheme,
					),
				).toBe(false);
		}
	});

	test("resolves to the sheet's own values, not to the derivations", () => {
		for (const scheme of SCHEMES)
			expect(resolveColours(SHIPPED_PALETTE[scheme], scheme).muted).toEqual(
				parseColour(SHIPPED_TOKENS[scheme].muted as string),
			);
	});

	test("reads at AA on every pair, in both schemes", () => {
		for (const scheme of SCHEMES)
			expect(contrastIssues(SHIPPED_PALETTE[scheme], scheme)).toEqual([]);
	});

	test("derived instead, it still reads at AA — so changing one primitive starts from a legible page", () => {
		for (const scheme of SCHEMES) {
			// One shade off the shipped surface: every token comes from the derivations.
			const surface = hex((parseHex(SHIPPED_PALETTE[scheme].surface) ?? 0) ^ 1);
			const nudged = { ...SHIPPED_PALETTE[scheme], surface };
			expect(isShippedPalette(nudged, scheme)).toBe(false);
			expect(contrastIssues(nudged, scheme)).toEqual([]);
		}
	});
});

describe("derivations", () => {
	test("are written as color-mix(), and every one names only what is declared above it", () => {
		for (const scheme of SCHEMES) {
			const declared = new Set([
				...Object.keys(SHIPPED_TOKENS[scheme]),
				...primitiveDeclarations(SHIPPED_PALETTE[scheme]).map(([n]) => n),
			]);
			for (const [name, expr] of DERIVATIONS[scheme]) {
				const css = exprCss(expr);
				for (const [, used] of css.matchAll(/var\(--([\w-]+)\)/g))
					expect(declared.has(used as string), `${name} uses --${used}`).toBe(
						true,
					);
				declared.add(name);
			}
		}
		expect(exprCss(["alpha", ["var", "brand-primary"], 14])).toBe(
			"color-mix(in srgb, var(--brand-primary) 14%, transparent)",
		);
	});

	test("a wash keeps its colour and lowers its alpha, as color-mix() with transparent does", () => {
		const palette = { ...SHIPPED_PALETTE.dark, primary: "#336699" };
		const soft = resolveColours(palette, "dark")["accent-soft"];
		expect(soft?.a).toBeCloseTo(0.14, 6);
		expect([soft?.r, soft?.g, soft?.b].map((x) => Math.round(x ?? 0))).toEqual([
			0x33, 0x66, 0x99,
		]);
	});

	test("an unreadable choice is reported, pair by pair", () => {
		// A light page under the dark scheme's light text.
		const issues = contrastIssues(
			{ ...SHIPPED_PALETTE.dark, surface: "#f0f0f0" },
			"dark",
		);
		expect(issues.some((i) => i.text === "text" && i.ground[0] === "bg")).toBe(
			true,
		);
		for (const issue of issues) expect(issue.ratio).toBeLessThan(AA);
	});
});

describe("the ink on the primary", () => {
	test("is whichever of the two inks reads better", () => {
		expect(onPrimary({ ...SHIPPED_PALETTE.dark, primary: "#ffd400" })).toBe(
			"#081120",
		);
		expect(onPrimary({ ...SHIPPED_PALETTE.dark, primary: "#1b3a8a" })).toBe(
			"#ffffff",
		);
	});
});

describe("the series fan", () => {
	const anchors: [string, string][] = [
		["the shipped anchor", SHIPPED_PALETTE.dark.aux],
		["a red", "#e0302a"],
		["a yellow", "#e8c33d"],
		["a green", "#35db80"],
	];
	for (const [label, anchor] of anchors) {
		test(`stays in the cool arc, legible and inside its band, for ${label}`, () => {
			for (const page of [0x0b0f17, 0xf4f6fa]) {
				const hues = seriesHues(parseHex(anchor) as number, page);
				expect(new Set(hues).size).toBe(6);
				for (const h of hues) {
					const deg = hueOf(h);
					expect(deg).toBeGreaterThanOrEqual(165);
					expect(deg).toBeLessThanOrEqual(335);
					const ratio = contrast(opaque(h), opaque(page));
					expect(ratio).toBeGreaterThanOrEqual(SERIES_MIN_CONTRAST - 0.2);
					expect(ratio).toBeLessThanOrEqual(SERIES_MAX_CONTRAST + 0.2);
				}
			}
		});
	}
});

describe("primitive declarations", () => {
	test("re-serialise every colour, so nothing but a colour reaches the page", () => {
		const palette = { ...SHIPPED_PALETTE.dark, primary: "#ABCDEF" };
		for (const [name, value] of primitiveDeclarations(palette)) {
			expect(name).toMatch(/^(brand-[a-z-]+|chan-\d)$/);
			expect(value).toMatch(/^#[0-9a-f]{6}$/);
		}
	});
});
