import { describe, expect, test } from "bun:test";

/**
 * Every pair of colours the token sheet puts words on meets AA (4.5:1) in
 * both schemes. The pairs are listed here by name, so a token renamed or a
 * surface added without a line below is a build failure rather than a
 * sentence nobody can read. Translucent surfaces are composited over the
 * ground they stand on before the ratio is taken.
 */
const sheet = await Bun.file(new URL("./globals.css", import.meta.url)).text();

type Rgba = { r: number; g: number; b: number; a: number };

function declarations(block: string): Record<string, string> {
	const out: Record<string, string> = {};
	for (const m of block.matchAll(/--([\w-]+):\s*([^;]+);/g)) {
		const [, name, value] = m;
		if (name && value) out[name] = value.trim();
	}
	return out;
}

/** The `:root` block of the dark scheme, and the one under the light media query (which `appearance.test.ts` holds equal to the pinned one). */
function schemes(): {
	dark: Record<string, string>;
	light: Record<string, string>;
} {
	const dark = sheet.match(/^:root\s*\{([\s\S]*?)\n\}/m)?.[1] ?? "";
	const light =
		sheet.match(
			/@media \(prefers-color-scheme: light\)\s*\{\s*:root:not\(\[data-scheme="dark"\]\)\s*\{([\s\S]*?)\n\t\}/,
		)?.[1] ?? "";
	if (!dark || !light) throw new Error("globals.css has lost a scheme block");
	const base = declarations(dark);
	return { dark: base, light: { ...base, ...declarations(light) } };
}

function parse(value: string): Rgba {
	const hex = value.match(/^#([0-9a-f]{6})$/i)?.[1];
	if (hex) {
		return {
			r: Number.parseInt(hex.slice(0, 2), 16),
			g: Number.parseInt(hex.slice(2, 4), 16),
			b: Number.parseInt(hex.slice(4, 6), 16),
			a: 1,
		};
	}
	const fn = value.match(/^rgba?\(([^)]+)\)$/);
	if (fn?.[1]) {
		const parts = fn[1]
			.split(/[\s,/]+/)
			.filter(Boolean)
			.map(Number);
		const [r = 0, g = 0, b = 0, a = 1] = parts;
		return { r, g, b, a };
	}
	throw new Error(`not a colour: ${value}`);
}

function over(top: Rgba, under: Rgba): Rgba {
	const a = top.a + under.a * (1 - top.a);
	const mix = (t: number, u: number) =>
		(t * top.a + u * under.a * (1 - top.a)) / (a || 1);
	return {
		r: mix(top.r, under.r),
		g: mix(top.g, under.g),
		b: mix(top.b, under.b),
		a,
	};
}

function luminance({ r, g, b }: Rgba): number {
	const lin = (c: number) => {
		const s = c / 255;
		return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
	};
	return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}

export function contrast(fg: Rgba, bg: Rgba): number {
	const [hi, lo] = [luminance(fg), luminance(bg)].sort((a, b) => b - a) as [
		number,
		number,
	];
	return (hi + 0.05) / (lo + 0.05);
}

/** A surface, as the eye sees it: the named layers composited bottom to top. */
function surface(tokens: Record<string, string>, ...layers: string[]): Rgba {
	return layers.reduce<Rgba | null>((under, name) => {
		const colour = parse(tokens[name] ?? "");
		return under ? over(colour, under) : colour;
	}, null) as Rgba;
}

/** [the words, the ground under them as layers bottom to top]. */
const PAIRS: [string, string[]][] = [
	["text", ["bg"]],
	["muted", ["bg"]],
	["text", ["pane-solid"]],
	["muted", ["pane-solid"]],
	["text", ["bg", "pane"]],
	["muted", ["bg", "pane"]],
	["text", ["bg", "glass"]],
	["muted", ["bg", "glass"]],
	["text", ["bg", "glass-2"]],
	["muted", ["bg", "glass-2"]],
	["text", ["bg", "field-bg"]],
	["muted", ["bg", "field-bg"]],
	["text", ["bg", "accent-soft"]],
	["muted", ["bg", "accent-soft"]],
	["text", ["bg", "band"]],
	["muted", ["bg", "band"]],
	["accent", ["bg"]],
	["accent", ["pane-solid"]],
	["accent", ["bg", "pane"]],
	["accent-ink", ["accent"]],
	["danger", ["bg"]],
	["danger", ["pane-solid"]],
	["danger", ["bg", "pane", "danger-soft"]],
	["text", ["bg", "pane", "danger-soft"]],
	["text", ["bg", "pane", "glass-2"]],
	["muted", ["bg", "pane", "glass-2"]],
	["text", ["pane-solid", "accent-soft"]],
	["muted", ["pane-solid", "accent-soft"]],
	["success", ["bg"]],
	["success", ["pane-solid"]],
];

const AA = 4.5;

describe("the token sheet's text on its grounds", () => {
	const { dark, light } = schemes();
	for (const [scheme, tokens] of [
		["dark", dark],
		["light", light],
	] as const) {
		for (const [fg, layers] of PAIRS) {
			test(`${scheme}: --${fg} on ${layers.map((l) => `--${l}`).join(" + ")} is AA`, () => {
				const ratio = contrast(
					parse(tokens[fg] ?? ""),
					surface(tokens, ...layers),
				);
				expect(ratio).toBeGreaterThanOrEqual(AA);
			});
		}
	}
});

describe("the sheet is the one place a value lives", () => {
	test("both schemes declare the same colour tokens", () => {
		const { dark } = schemes();
		const light = declarations(
			sheet.match(
				/@media \(prefers-color-scheme: light\)\s*\{\s*:root:not\(\[data-scheme="dark"\]\)\s*\{([\s\S]*?)\n\t\}/,
			)?.[1] ?? "",
		);
		for (const name of Object.keys(light)) expect(dark).toHaveProperty(name);
	});

	test("the ground, the type scale, the space scale and the motion are tokens", () => {
		const { dark } = schemes();
		for (const name of [
			"bg",
			"text",
			"muted",
			"accent",
			"text-xs",
			"text-sm",
			"text-md",
			"text-lg",
			"space-1",
			"space-4",
			"radius",
			"radius-pill",
			"control-h",
			"dur",
			"ease",
			"shadow-md",
		])
			expect(dark[name], name).toBeString();
	});
});
