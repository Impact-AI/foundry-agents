import type { LocaleRegistry } from "./registry";

/**
 * The locale a raw `Cookie:` header states, or null when it states none.
 *
 * Null rather than the default is the point: "they chose English" and "they
 * have not chosen" are invisible in a bare locale, and the difference decides
 * real behaviour — a stated choice is pinned onto speech-to-text, an unstated
 * one lets the browser's `Accept-Language` answer. A value the registry does
 * not know is no choice at all, so it cannot reach a prompt or a transcriber;
 * so is one that is not percent-encoding, which a browser can be handed by
 * anything that writes its cookies.
 */
export function selectedLocaleFromCookieHeader<L extends string>(
	registry: LocaleRegistry<L>,
	header: string | null | undefined,
): L | null {
	if (!header) return null;
	for (const part of header.split(";")) {
		const eq = part.indexOf("=");
		if (eq === -1) continue;
		if (part.slice(0, eq).trim() !== registry.cookieName) continue;
		const value = decoded(part.slice(eq + 1).trim());
		return value !== null && registry.isLocale(value) ? value : null;
	}
	return null;
}

function decoded(value: string): string | null {
	try {
		return decodeURIComponent(value);
	} catch {
		return null;
	}
}
