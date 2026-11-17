import {
	integerBetween,
	type LeafRule,
	mergeOverDefault,
	oneOf,
} from "@platform/config/merge";
import { isLogoKey, isName, isWelcome } from "./brand";
import {
	contrastIssues,
	isPaletteColour,
	PALETTE_KEYS,
	type Palette,
	SCHEMES,
	type Scheme,
	SHIPPED_PALETTE,
} from "./palette";
import {
	DENSITIES,
	type Density,
	FONT_CHOICES,
	FONT_SIZE,
	type FontChoice,
	RADIUS,
	TYPE_STEPS,
	type TypeSteps,
} from "./tokens";

/**
 * The `appearance` settings document: how the frontend looks in one
 * deployment. Stored in App Configuration like every other document, merged
 * over these defaults leaf by leaf, each leaf refused back to its default
 * when it breaks its rule — so a hand edit in the portal can make the app
 * look different, never break it, and never put anything but a colour, a
 * number or a name from a closed list into the page.
 *
 * The fields and their shapes are the ones other tools that write this
 * document use, so one document reads the same wherever it is written. The
 * ones this frontend cannot honour (`layout`, `preview`) are not among the
 * defaults, so the merge passes over them without a word.
 *
 * The defaults are the shipped look exactly, and the shipped look injects
 * nothing: an untouched deployment renders as the app was built.
 */
export interface AppearanceSettings {
	/** `system` follows the device; `dark` or `light` pins one. */
	scheme: "system" | Scheme;
	palette: Record<Scheme, Palette>;
	type: { font: FontChoice; size: number; steps: TypeSteps };
	space: { density: Density };
	shape: { radius: number };
	brand: {
		/** Per language; empty is the catalogue's own name. */
		name: Record<string, string>;
		/** Per language; empty is the catalogue's own heading. */
		welcome: Record<string, string>;
		/** The logo's key in the appearance container (`appearance/logo/<sha256>.<ext>`), or empty for none. */
		logo: string;
	};
}

const SCHEME_CHOICES = ["system", ...SCHEMES] as const;

/** The key in the store (`app/appearance` with the deployment's prefix). */
export const APPEARANCE_CONFIG_KEY = "appearance";

/** The shipped look, with a name and a welcome line per language of the product's, each empty. */
export function appearanceDefaults(
	locales: readonly string[],
): AppearanceSettings {
	const perLocale = () =>
		Object.fromEntries(locales.map((code) => [code, ""])) as Record<
			string,
			string
		>;
	return {
		scheme: "system",
		palette: {
			dark: { ...SHIPPED_PALETTE.dark },
			light: { ...SHIPPED_PALETTE.light },
		},
		type: { font: "system", size: FONT_SIZE.shipped, steps: "standard" },
		space: { density: "comfortable" },
		shape: { radius: RADIUS.shipped },
		brand: { name: perLocale(), welcome: perLocale(), logo: "" },
	};
}

function rules(defaults: AppearanceSettings): Record<string, LeafRule> {
	const accept: Record<string, LeafRule> = {
		scheme: oneOf(SCHEME_CHOICES),
		"type.font": oneOf(FONT_CHOICES),
		"type.size": integerBetween(FONT_SIZE.min, FONT_SIZE.max),
		"type.steps": oneOf(TYPE_STEPS),
		"space.density": oneOf(DENSITIES),
		"shape.radius": integerBetween(RADIUS.min, RADIUS.max),
		"brand.logo": isLogoKey,
	};
	for (const scheme of SCHEMES)
		for (const key of PALETTE_KEYS)
			accept[`palette.${scheme}.${key}`] = isPaletteColour;
	for (const code of Object.keys(defaults.brand.name))
		accept[`brand.name.${code}`] = isName;
	for (const code of Object.keys(defaults.brand.welcome))
		accept[`brand.welcome.${code}`] = isWelcome;
	return accept;
}

/**
 * The stored document merged over the defaults; every refused leaf keeps its
 * default, and its path is pushed onto `refused`.
 *
 * Then the one rule no leaf can be held to alone: a scheme's palette is drawn
 * only if every pair of words and the ground under them reads at WCAG AA
 * (4.5:1). A palette with any pair below it is refused whole, back to the
 * shipped palette of that scheme, and reported as `palette.<scheme>`: six
 * colours that only work together are kept or dropped together, and nobody
 * is ever shown a page they cannot read.
 */
export function parseAppearance(
	stored: unknown,
	defaults: AppearanceSettings,
	refused?: string[],
): AppearanceSettings {
	const merged = mergeOverDefault(stored, defaults, {
		accept: rules(defaults),
		refused,
	});
	for (const scheme of SCHEMES)
		if (contrastIssues(merged.palette[scheme], scheme).length > 0) {
			merged.palette[scheme] = { ...SHIPPED_PALETTE[scheme] };
			refused?.push(`palette.${scheme}`);
		}
	return merged;
}
