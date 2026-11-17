import type { AppearanceSettings } from "./document";
import { isShippedPalette, primitiveDeclarations, SCHEMES } from "./palette";
import {
	FONT_SIZE,
	FONT_STACKS,
	RADIUS,
	radiusTokens,
	spaceTokens,
	typeTokens,
} from "./tokens";

/**
 * The page's side of a deployment's appearance: the attributes on `<html>`
 * and the one `<style>` the frontend's root layout injects.
 *
 * Every group is emitted only when it differs from the shipped choice, so an
 * untouched deployment gets no attribute and an empty sheet, and renders from
 * the token sheet alone.
 *
 * SAFETY. The sheet is written into a `<style>` element, so nothing but
 * values from closed lists, integers and re-serialised `#rrggbb` colours may
 * reach it. The caller passes a document the parser produced
 * (`parseAppearance`), every leaf of which has passed its rule; colours are
 * parsed and written back out rather than copied; and the result is refused
 * whole if it could close the element.
 */

const ROOT = ":root[data-appearance]";
const LIGHT_BY_PREFERENCE = `@media (prefers-color-scheme: light){${ROOT}:not([data-scheme="dark"]){%s}}`;
const LIGHT_PINNED = `${ROOT}[data-scheme="light"]{%s}`;

function block(declarations: [string, string][]): string {
	return declarations.map(([name, value]) => `--${name}:${value}`).join(";");
}

function paletteChanged(doc: AppearanceSettings): boolean {
	return SCHEMES.some(
		(scheme) => !isShippedPalette(doc.palette[scheme], scheme),
	);
}

/** The custom properties the non-colour groups change, shipped groups left out. */
function tokenDeclarations(doc: AppearanceSettings): [string, string][] {
	const out: [string, string][] = [];
	if (doc.type.font !== "system")
		out.push(["font-sans", FONT_STACKS[doc.type.font]]);
	if (doc.type.size !== FONT_SIZE.shipped)
		out.push(["font-base", `${doc.type.size}px`]);
	if (doc.type.steps !== "standard")
		out.push(...Object.entries(typeTokens(doc.type.steps)));
	if (doc.space.density !== "comfortable")
		out.push(...Object.entries(spaceTokens(doc.space.density)));
	if (doc.shape.radius !== RADIUS.shipped)
		out.push(...Object.entries(radiusTokens(doc.shape.radius)));
	return out;
}

export function appearanceCss(doc: AppearanceSettings): string {
	const parts: string[] = [];
	const root = tokenDeclarations(doc);
	if (paletteChanged(doc)) {
		root.push(...primitiveDeclarations(doc.palette.dark));
		const light = block(primitiveDeclarations(doc.palette.light));
		parts.push(
			LIGHT_BY_PREFERENCE.replace("%s", light),
			LIGHT_PINNED.replace("%s", light),
		);
	}
	if (root.length) parts.unshift(`${ROOT}{${block(root)}}`);
	const css = parts.join("");
	if (/[<\\]|\/\*/.test(css))
		throw new Error(
			"appearance: the generated sheet holds a character it may not",
		);
	return css;
}

/** The attributes `<html>` carries for a document; none for the shipped look. */
export function appearanceAttributes(
	doc: AppearanceSettings,
): Record<string, string> {
	const attributes: Record<string, string> = {};
	if (appearanceCss(doc)) attributes["data-appearance"] = "";
	if (paletteChanged(doc)) attributes["data-palette"] = "";
	if (doc.scheme !== "system") attributes["data-scheme"] = doc.scheme;
	return attributes;
}
