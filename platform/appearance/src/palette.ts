import {
	contrast,
	HEX_COLOUR,
	hex,
	mix,
	opaque,
	over,
	parseHex,
	type Rgba,
	seriesHues,
} from "./colour";

/**
 * The palette: six primitives per colour scheme, and every colour the app's
 * token sheet derives from them.
 *
 * Six because the sheet is built that way. The surfaces are the `surface`
 * lifted or deepened, every wash is a rung cut from the colour it washes, and
 * the status colours are status only — so retinting is six choices, not the
 * forty-odd values the sheet declares. The primitives are named for what each
 * one does, not for the colour it ships as, because an operator retints them.
 *
 * ## The shipped look is not derived
 *
 * The frontend's stylesheet (`apps/frontend/app/globals.css`) keeps its own
 * hand-tuned values, and they are the answer whenever the palette is the
 * shipped one: an untouched deployment injects nothing and renders exactly
 * as it was built. The derivations below take over only once an operator has
 * changed a primitive (`data-palette` on the page). The stylesheet's
 * derivation blocks are written from {@link DERIVATIONS} and held to it by
 * the app's tests, as its shipped values are held to {@link SHIPPED_TOKENS}.
 */

export type Scheme = "dark" | "light";
export const SCHEMES: readonly Scheme[] = ["dark", "light"];

export interface Palette {
	/** The page. Panels, the band and the scrim are cut from it. */
	surface: string;
	/** The glow and motes behind the panels. Decoration only — never text, never a control. */
	ambient: string;
	/** The interface colour: buttons, links, focus, selection. */
	primary: string;
	/** Errors and warnings. */
	warning: string;
	/** Done, saved, nominal. Status only — never a decorative fill. */
	success: string;
	/** The chart anchor: the plotted series are a cool fan turned off it. */
	aux: string;
}

export const PALETTE_KEYS = [
	"surface",
	"ambient",
	"primary",
	"warning",
	"success",
	"aux",
] as const satisfies readonly (keyof Palette)[];

/**
 * The shipped primitives: each the stylesheet's own value for the token it
 * drives (`surface` is `--bg`, `primary` is `--accent`, `warning` is
 * `--danger`, `success` is `--success`, `ambient` is `--field-tint-3`, `aux`
 * is `--chan-2`). The app's tests read the sheet and fail if they part.
 */
export const SHIPPED_PALETTE: Record<Scheme, Palette> = {
	dark: {
		surface: "#0b0f17",
		ambient: "#be96ff",
		primary: "#7fb2ff",
		warning: "#ff8a7a",
		success: "#6fd9a3",
		aux: "#8aadf3",
	},
	light: {
		surface: "#f4f6fa",
		ambient: "#8c5adc",
		primary: "#2457c5",
		warning: "#b3261e",
		success: "#1b6e46",
		aux: "#8aadf3",
	},
};

/**
 * The stylesheet's shipped values for the tokens words are set on and the
 * grounds under them — what a contrast check reads for the shipped palette.
 * Held equal to `globals.css` by the app's tests.
 */
export const SHIPPED_TOKENS: Record<Scheme, Record<string, string>> = {
	dark: {
		bg: "#0b0f17",
		"pane-solid": "#151b27",
		pane: "rgba(20, 25, 36, 0.72)",
		text: "#eef1f7",
		muted: "#a9b2c4",
		line: "rgba(255, 255, 255, 0.14)",
		accent: "#7fb2ff",
		"accent-ink": "#081120",
		"accent-soft": "rgba(127, 178, 255, 0.14)",
		danger: "#ff8a7a",
		"danger-soft": "rgba(255, 138, 122, 0.14)",
		success: "#6fd9a3",
		"field-glow-1": "rgba(127, 178, 255, 0.16)",
		"field-glow-2": "rgba(190, 150, 255, 0.1)",
	},
	light: {
		bg: "#f4f6fa",
		"pane-solid": "#ffffff",
		pane: "rgba(255, 255, 255, 0.78)",
		text: "#171b24",
		muted: "#596274",
		line: "rgba(0, 0, 0, 0.12)",
		accent: "#2457c5",
		"accent-ink": "#ffffff",
		"accent-soft": "rgba(36, 87, 197, 0.1)",
		danger: "#b3261e",
		"danger-soft": "rgba(179, 38, 30, 0.08)",
		success: "#1b6e46",
		"field-glow-1": "rgba(36, 87, 197, 0.12)",
		"field-glow-2": "rgba(140, 90, 220, 0.08)",
	},
};

/** What text on the primary is drawn in: the darker or the lighter ink, whichever reads. */
const INKS = ["#081120", "#ffffff"] as const;

/**
 * One derivation, as data, so the same table writes the stylesheet's
 * `color-mix()` and computes the colour a contrast check needs.
 *
 * - `["var", name]` — another custom property: a primitive (`brand-*`), the
 *   scheme's `text`, or a token derived above it;
 * - `["hex", "#rrggbb"]` — a literal;
 * - `["mix", a, b, pct]` — `color-mix(in srgb, a, b pct%)`;
 * - `["alpha", a, pct]` — `color-mix(in srgb, a pct%, transparent)`.
 */
export type Expr =
	| readonly ["var", string]
	| readonly ["hex", string]
	| readonly ["mix", Expr, Expr, number]
	| readonly ["alpha", Expr, number];

const v = (name: string): Expr => ["var", name];
const white: Expr = ["hex", "#ffffff"];
const black: Expr = ["hex", "#000000"];
const surface = v("brand-surface");
const primary = v("brand-primary");
const warning = v("brand-warning");
const ambient = v("brand-ambient");

/** Every token a changed palette re-derives, per scheme, in declaration order. */
export const DERIVATIONS: Record<Scheme, readonly [string, Expr][]> = {
	dark: [
		["bg", surface],
		["pane-solid", ["mix", surface, white, 6]],
		["pane", ["alpha", v("pane-solid"), 72]],
		["band", ["alpha", surface, 80]],
		["scrim", ["alpha", ["mix", surface, black, 50], 78]],
		["muted", ["mix", v("text"), surface, 28]],
		["accent", primary],
		["accent-ink", v("brand-on-primary")],
		["accent-soft", ["alpha", primary, 14]],
		["accent-a40", ["alpha", primary, 40]],
		["accent-a60", ["alpha", primary, 60]],
		["focus", ["mix", primary, white, 25]],
		["danger", warning],
		["danger-soft", ["alpha", warning, 14]],
		["success", v("brand-success")],
		["field-tint", primary],
		["field-tint-3", ambient],
		["field-glow-1", ["alpha", primary, 16]],
		["field-glow-2", ["alpha", ambient, 10]],
	],
	light: [
		["bg", surface],
		["pane-solid", ["mix", surface, white, 80]],
		["pane", ["alpha", v("pane-solid"), 78]],
		["band", ["alpha", surface, 84]],
		["scrim", ["alpha", ["mix", surface, black, 85], 60]],
		["muted", ["mix", v("text"), surface, 30]],
		["accent", primary],
		["accent-ink", v("brand-on-primary")],
		["accent-soft", ["alpha", primary, 10]],
		["accent-a40", ["alpha", primary, 40]],
		["accent-a60", ["alpha", primary, 60]],
		["focus", primary],
		["danger", warning],
		["danger-soft", ["alpha", warning, 8]],
		["success", v("brand-success")],
		["field-tint", primary],
		["field-tint-3", ambient],
		["field-glow-1", ["alpha", primary, 12]],
		["field-glow-2", ["alpha", ambient, 8]],
	],
};

/** One expression as CSS. */
export function exprCss(expr: Expr): string {
	switch (expr[0]) {
		case "var":
			return `var(--${expr[1]})`;
		case "hex":
			return expr[1];
		case "mix":
			return `color-mix(in srgb, ${exprCss(expr[1])}, ${exprCss(expr[2])} ${expr[3]}%)`;
		case "alpha":
			return `color-mix(in srgb, ${exprCss(expr[1])} ${expr[2]}%, transparent)`;
	}
}

/** A CSS colour as the sheet writes it: `#rrggbb` or `rgba(r, g, b, a)`. */
export function parseColour(value: string): Rgba {
	const asHex = parseHex(value);
	if (asHex !== null) return opaque(asHex);
	const fn = /^rgba?\(([^)]+)\)$/.exec(value.trim())?.[1];
	if (fn) {
		const [r = 0, g = 0, b = 0, a = 1] = fn
			.split(/[\s,/]+/)
			.filter(Boolean)
			.map(Number);
		return { r, g, b, a };
	}
	throw new Error(`not a colour: ${value}`);
}

function evaluate(expr: Expr, scope: Record<string, Rgba>): Rgba {
	switch (expr[0]) {
		case "var": {
			const found = scope[expr[1]];
			if (!found) throw new Error(`--${expr[1]} is not declared above its use`);
			return found;
		}
		case "hex":
			return parseColour(expr[1]);
		case "mix":
			return mix(
				evaluate(expr[1], scope),
				evaluate(expr[2], scope),
				expr[3] / 100,
			);
		case "alpha":
			return mix(
				evaluate(expr[1], scope),
				{ r: 0, g: 0, b: 0, a: 0 },
				1 - expr[2] / 100,
			);
	}
}

/** Whether a scheme's palette is the shipped one, key for key, case aside. */
export function isShippedPalette(palette: Palette, scheme: Scheme): boolean {
	return PALETTE_KEYS.every(
		(key) =>
			palette[key].toLowerCase() === SHIPPED_PALETTE[scheme][key].toLowerCase(),
	);
}

/** The ink drawn on the primary: whichever of the two reads better on it. */
export function onPrimary(palette: Palette): string {
	const ground = parseColour(palette.primary);
	const [dark, light] = INKS;
	return contrast(parseColour(dark), ground) >=
		contrast(parseColour(light), ground)
		? dark
		: light;
}

/** `--chan-0..5` for a palette: the series fan off its anchor, weighed against its page. */
function seriesColours(palette: Palette): string[] {
	const anchor = parseHex(palette.aux) ?? 0;
	const page = parseHex(palette.surface) ?? 0;
	return seriesHues(anchor, page).map(hex);
}

/**
 * The primitives as custom properties, plus the two values the sheet cannot
 * compute for itself — the ink on the primary, which is a choice between two
 * colours by contrast, and the series fan, which is a hue rotation weighed by
 * contrast. Values are re-serialised from the parsed colour, so nothing but
 * a colour reaches the page.
 */
export function primitiveDeclarations(palette: Palette): [string, string][] {
	const out: [string, string][] = PALETTE_KEYS.map((key) => [
		`brand-${key}`,
		hex(parseHex(palette[key]) ?? 0),
	]);
	out.push(["brand-on-primary", onPrimary(palette)]);
	seriesColours(palette).forEach((value, i) => {
		out.push([`chan-${i}`, value]);
	});
	return out;
}

/**
 * The colours a scheme draws with, as numbers: the stylesheet's own for the
 * shipped palette, the derivations for any other: what a contrast check
 * reads.
 */
export function resolveColours(
	palette: Palette,
	scheme: Scheme,
): Record<string, Rgba> {
	const shipped = SHIPPED_TOKENS[scheme];
	const scope: Record<string, Rgba> = {};
	for (const [name, value] of Object.entries(shipped))
		scope[name] = parseColour(value);
	if (isShippedPalette(palette, scheme)) return scope;
	for (const [name, value] of primitiveDeclarations(palette))
		scope[name] = parseColour(value);
	for (const [name, expr] of DERIVATIONS[scheme])
		scope[name] = evaluate(expr, scope);
	return scope;
}

/**
 * The pairs words are set on, as [the words, the ground under them, bottom
 * to top]. A translucent ground is composited over the one under it before
 * the ratio is taken.
 */
const TEXT_PAIRS: readonly [string, readonly string[]][] = [
	["text", ["bg"]],
	["muted", ["bg"]],
	["text", ["pane-solid"]],
	["muted", ["pane-solid"]],
	["text", ["bg", "pane"]],
	["muted", ["bg", "pane"]],
	["text", ["pane-solid", "accent-soft"]],
	["accent", ["bg"]],
	["accent", ["pane-solid"]],
	["accent-ink", ["accent"]],
	["danger", ["bg"]],
	["danger", ["pane-solid"]],
	["text", ["bg", "pane", "danger-soft"]],
	["success", ["bg"]],
	["success", ["pane-solid"]],
];

/** WCAG AA for body text. */
export const AA = 4.5;

export interface ContrastIssue {
	scheme: Scheme;
	text: string;
	ground: readonly string[];
	ratio: number;
}

/** Every pair a scheme's palette would draw below AA. */
export function contrastIssues(
	palette: Palette,
	scheme: Scheme,
): ContrastIssue[] {
	const colours = resolveColours(palette, scheme);
	const issues: ContrastIssue[] = [];
	for (const [text, ground] of TEXT_PAIRS) {
		const under = ground
			.map((name) => colours[name] as Rgba)
			.reduce((below, layer) => over(layer, below));
		const ratio = contrast(colours[text] as Rgba, under);
		if (ratio < AA) issues.push({ scheme, text, ground, ratio });
	}
	return issues;
}

/** Whether a stored value is a palette colour. */
export function isPaletteColour(value: unknown): boolean {
	return typeof value === "string" && HEX_COLOUR.test(value);
}
