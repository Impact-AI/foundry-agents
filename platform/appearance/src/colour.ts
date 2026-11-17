/**
 * The colour arithmetic a palette needs: the ink on the primary, the series
 * fan, and the contrast ratios the document's reader holds a palette to.
 * Dependency-free, so a browser bundle can carry it.
 *
 * Colours are 24-bit integers (`0x7fb2ff`) where they are opaque, and
 * `{ r, g, b, a }` in 0..255 / 0..1 where a translucent wash has to be
 * composited over the ground it stands on before a contrast ratio means
 * anything.
 */

export interface Rgba {
	r: number;
	g: number;
	b: number;
	a: number;
}

/** A palette value as it is stored and typed: `#rrggbb`, either case. */
export const HEX_COLOUR = /^#[0-9a-fA-F]{6}$/;

/** `"#4aa5d8"` → `0x4aa5d8`; null for anything that is not a 6-digit hex. */
export function parseHex(value: string): number | null {
	return HEX_COLOUR.test(value.trim())
		? Number.parseInt(value.trim().slice(1), 16)
		: null;
}

/** `0x4aa5d8` → `"#4aa5d8"`. */
export function hex(rgb: number): string {
	return `#${rgb.toString(16).padStart(6, "0")}`;
}

function channel(value: number): number {
	return Math.min(255, Math.max(0, Math.round(value)));
}

function unpack(rgb: number): [number, number, number] {
	return [(rgb >> 16) & 0xff, (rgb >> 8) & 0xff, rgb & 0xff];
}

function pack(r: number, g: number, b: number): number {
	return (channel(r) << 16) | (channel(g) << 8) | channel(b);
}

export function opaque(rgb: number): Rgba {
	const [r, g, b] = unpack(rgb);
	return { r, g, b, a: 1 };
}

/** `color-mix(in srgb, a, b <share>)` of two colours, `share` in 0..1 being `b`'s. */
export function mix(a: Rgba, b: Rgba, share: number): Rgba {
	// Premultiplied, as color-mix() interpolates: mixing towards `transparent`
	// keeps the colour and lowers its alpha.
	const alpha = a.a * (1 - share) + b.a * share;
	const at = (x: number, y: number) =>
		alpha === 0 ? 0 : (x * a.a * (1 - share) + y * b.a * share) / alpha;
	return { r: at(a.r, b.r), g: at(a.g, b.g), b: at(a.b, b.b), a: alpha };
}

/** `top` drawn over `under`: what the eye sees of a wash on its ground. */
export function over(top: Rgba, under: Rgba): Rgba {
	const a = top.a + under.a * (1 - top.a);
	const at = (t: number, u: number) =>
		(t * top.a + u * under.a * (1 - top.a)) / (a || 1);
	return {
		r: at(top.r, under.r),
		g: at(top.g, under.g),
		b: at(top.b, under.b),
		a,
	};
}

/** WCAG relative luminance of an opaque colour. */
function luminance({ r, g, b }: Rgba): number {
	const lin = (v: number) => {
		const c = v / 255;
		return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
	};
	return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}

/** WCAG contrast ratio, 1..21, of two opaque colours. */
export function contrast(a: Rgba, b: Rgba): number {
	const la = luminance(a);
	const lb = luminance(b);
	return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

// ------------------------------------------------------- hue and legibility

/** sRGB → HSL, hue in degrees 0..360, s and l in 0..1. */
function toHsl(rgb: number): [number, number, number] {
	const [r255, g255, b255] = unpack(rgb);
	const r = r255 / 255;
	const g = g255 / 255;
	const b = b255 / 255;
	const max = Math.max(r, g, b);
	const min = Math.min(r, g, b);
	const l = (max + min) / 2;
	const d = max - min;
	if (d === 0) return [0, 0, l];
	const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
	const h =
		max === r
			? ((g - b) / d + (g < b ? 6 : 0)) * 60
			: max === g
				? ((b - r) / d + 2) * 60
				: ((r - g) / d + 4) * 60;
	return [h, s, l];
}

/** HSL → sRGB. */
function fromHsl(h: number, s: number, l: number): number {
	const hue = ((h % 360) + 360) % 360;
	if (s === 0) return pack(l * 255, l * 255, l * 255);
	const c = (1 - Math.abs(2 * l - 1)) * s;
	const x = c * (1 - Math.abs(((hue / 60) % 2) - 1));
	const m = l - c / 2;
	const wheel: [number, number, number][] = [
		[c, x, 0],
		[x, c, 0],
		[0, c, x],
		[0, x, c],
		[x, 0, c],
		[c, 0, x],
	];
	const [r, g, b] = wheel[Math.floor(hue / 60) % 6] ?? [c, x, 0];
	return pack((r + m) * 255, (g + m) * 255, (b + m) * 255);
}

/**
 * The plotted series' colours: one fan turned off the chart anchor (`aux`).
 *
 * A series' colour is assigned by position and carries no meaning, so it must
 * not borrow a hue that does — a series drawn in the warning's red or the
 * success's green reads as a status. The fan therefore spans a cool arc,
 * cyan through magenta, and an anchor outside it is folded in (hue only;
 * saturation and lightness are the operator's).
 *
 * Hue alone separates neighbours poorly across the blues, so neighbours also
 * alternate in weight — a contrast ratio against the page near each end of a
 * legible band — which is the one channel every kind of colour blindness
 * keeps. The rungs sit a tenth inside the band so 8-bit rounding cannot push a
 * series out of it.
 */
const DECORATIVE_ARC: readonly [number, number] = [170, 330];
const SERIES_OFFSETS = [-50, -30, -10, 10, 30, 50] as const;
const SERIES_MIN_CONTRAST = 4.5;
const SERIES_MAX_CONTRAST = 9;
const SERIES_WEIGHTS = SERIES_OFFSETS.map((_, i) =>
	i % 2 === 0 ? SERIES_MAX_CONTRAST - 0.1 : SERIES_MIN_CONTRAST + 0.1,
);
const FAN_REACH = Math.max(...SERIES_OFFSETS.map((d) => Math.abs(d)));
const ANCHOR_MIN = DECORATIVE_ARC[0] + FAN_REACH;
const ANCHOR_MAX = DECORATIVE_ARC[1] - FAN_REACH;

/** A chart anchor folded into the range from which the whole fan stays cool. */
function clampChartAnchor(rgb: number): number {
	const [h, s, l] = toHsl(rgb);
	if (h >= ANCHOR_MIN && h <= ANCHOR_MAX) return rgb;
	const around = (from: number, to: number) =>
		Math.abs(((to - from + 540) % 360) - 180);
	return fromHsl(
		around(h, ANCHOR_MIN) <= around(h, ANCHOR_MAX) ? ANCHOR_MIN : ANCHOR_MAX,
		s,
		l,
	);
}

/** Lightnesses at which a colour is still a colour, not white or black. */
const KEEPS_ITS_HUE: readonly [number, number] = [0.06, 0.94];

/** The colour at `hue` and `saturation` whose contrast against `against` comes closest to `target`. */
function toContrast(
	hue: number,
	saturation: number,
	against: number,
	target: number,
): number {
	let bestL = 0;
	let bestMiss = Number.POSITIVE_INFINITY;
	const ground = opaque(against);
	const consider = (l: number) => {
		const miss = Math.abs(
			contrast(opaque(fromHsl(hue, saturation, l)), ground) - target,
		);
		if (miss < bestMiss) {
			bestMiss = miss;
			bestL = l;
		}
	};
	// A sweep, not a bisection: against a light page contrast falls as
	// lightness rises, and an operator may set either.
	const step = (KEEPS_ITS_HUE[1] - KEEPS_ITS_HUE[0]) / 50;
	for (let i = 0; i <= 50; i++) consider(KEEPS_ITS_HUE[0] + i * step);
	const around = bestL;
	for (let i = -50; i <= 50; i++) {
		const l = around + (i * step) / 50;
		if (l >= KEEPS_ITS_HUE[0] && l <= KEEPS_ITS_HUE[1]) consider(l);
	}
	return fromHsl(hue, saturation, bestL);
}

/** The six series hues (`--chan-0..5`) for an anchor drawn on `page`. */
export function seriesHues(anchor: number, page: number): number[] {
	const [hue, saturation] = toHsl(clampChartAnchor(anchor));
	return SERIES_OFFSETS.map((degrees, i) =>
		toContrast(hue + degrees, saturation, page, SERIES_WEIGHTS[i] as number),
	);
}

export { SERIES_MAX_CONTRAST, SERIES_MIN_CONTRAST };
