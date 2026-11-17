/**
 * The non-colour tokens an operator moves: the font, the base size and the
 * type scale, the spacing density and the corner radius. Each is a closed
 * choice or a bounded number, and each turns into the custom properties the
 * agent's token sheet already declares — so a choice reaches every component
 * without one of them knowing it exists.
 *
 * The shipped choice of each reproduces the sheet's own values exactly (held
 * by the app's tests), and is never emitted: a deployment that changes none
 * of them injects nothing.
 */

/** Font stacks of fonts a device already has: nothing is downloaded, so nothing reaches another host. */
export const FONT_STACKS = {
	system: 'system-ui, -apple-system, "Segoe UI", Roboto, sans-serif',
	humanist:
		'Seravek, "Gill Sans Nova", Ubuntu, Calibri, "DejaVu Sans", source-sans-pro, sans-serif',
	rounded: 'ui-rounded, "SF Pro Rounded", Nunito, system-ui, sans-serif',
	serif: 'Georgia, "Iowan Old Style", "Times New Roman", serif',
	condensed:
		'"Avenir Next Condensed", "Arial Narrow", "Roboto Condensed", sans-serif-condensed, sans-serif',
	mono: 'ui-monospace, "SF Mono", Menlo, Consolas, monospace',
} as const;
export type FontChoice = keyof typeof FONT_STACKS;
export const FONT_CHOICES = Object.keys(FONT_STACKS) as FontChoice[];

/** The base size, in px at 100% text size: what one rem is. */
export const FONT_SIZE = { min: 14, max: 20, shipped: 16 } as const;

/**
 * The type scale. `standard` is the sheet's own hand-set steps; the others
 * are geometric, a step apart by their ratio, for a quieter or a louder page.
 */
export const TYPE_STEPS = ["standard", "tight", "wide"] as const;
export type TypeSteps = (typeof TYPE_STEPS)[number];

const STANDARD_STEPS: Record<string, string> = {
	"text-xs": "0.75rem",
	"text-sm": "0.875rem",
	"text-md": "1rem",
	"text-lg": "1.125rem",
	"text-xl": "1.375rem",
	"text-2xl": "1.75rem",
	"text-3xl": "clamp(1.75rem, 3vw, 2.5rem)",
};

const RATIO: Record<Exclude<TypeSteps, "standard">, number> = {
	tight: 1.125,
	wide: 1.25,
};

const rem = (n: number) => `${Math.round(n * 1000) / 1000}rem`;

export function typeTokens(steps: TypeSteps): Record<string, string> {
	if (steps === "standard") return { ...STANDARD_STEPS };
	const r = RATIO[steps];
	const at = (k: number) => rem(r ** k);
	return {
		"text-xs": at(-2),
		"text-sm": at(-1),
		"text-md": at(0),
		"text-lg": at(1),
		"text-xl": at(2),
		"text-2xl": at(3),
		"text-3xl": `clamp(${at(3)}, 3vw, ${at(5)})`,
	};
}

/** Spacing: one multiplier over the sheet's 4px grid. */
export const DENSITIES = ["compact", "comfortable", "spacious"] as const;
export type Density = (typeof DENSITIES)[number];
const DENSITY: Record<Density, number> = {
	compact: 0.75,
	comfortable: 1,
	spacious: 1.25,
};
const SPACE_PX: Record<string, number> = {
	"space-1": 4,
	"space-2": 8,
	"space-3": 12,
	"space-4": 16,
	"space-5": 20,
	"space-6": 24,
	"space-8": 32,
	"space-10": 40,
	gutter: 16,
};

export function spaceTokens(density: Density): Record<string, string> {
	const m = DENSITY[density];
	return Object.fromEntries(
		Object.entries(SPACE_PX).map(([name, px]) => [
			name,
			`${Math.round(px * m)}px`,
		]),
	);
}

/** The card radius in px; the small, large and extra-large radii follow it. */
export const RADIUS = { min: 0, max: 24, shipped: 12 } as const;

export function radiusTokens(radius: number): Record<string, string> {
	const px = (n: number) => `${Math.round(n)}px`;
	return {
		"radius-sm": px((radius * 2) / 3),
		radius: px(radius),
		"radius-lg": px((radius * 4) / 3),
		"radius-xl": px((radius * 11) / 6),
	};
}
