import { localeFromAcceptLanguage } from "./accept-language";
import { selectedLocaleFromCookieHeader } from "./cookie";
import type { LocaleRegistry } from "./registry";

/**
 * The language to serve a request in: what they chose, else what their
 * browser asks for, else the default. The one resolution order every surface
 * uses — page, typed chat, transcription, a live voice session — so the words
 * a person reads and the language a model hears cannot come from different
 * rules. A second reading of the cookie anywhere is a second answer waiting
 * to disagree with this one.
 */
export function localeFromRequestHeaders<L extends string>(
	registry: LocaleRegistry<L>,
	cookie: string | null | undefined,
	acceptLanguage: string | null | undefined,
): L {
	return (
		selectedLocaleFromCookieHeader(registry, cookie) ??
		localeFromAcceptLanguage(registry, acceptLanguage) ??
		registry.defaultLocale
	);
}
