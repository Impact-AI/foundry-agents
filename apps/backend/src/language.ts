import { type LocaleRegistry, localeFromAcceptLanguage } from "@platform/i18n";

/** A language as the voice handlers and the agent take it: the code for transcription, the English name for a model. */
export interface Language {
	code: string;
	name: string;
}

/**
 * The app's one language. The frontend resolves it by the one order — the
 * stated choice, then the browser's `Accept-Language`, then the default —
 * against the same list, and sends its answer as `Accept-Language` on every
 * call; a code the list does not hold is the default. A person has no
 * language of their own beside it. The list is the product's (`locales` on
 * its object), handed in, so this file names no product.
 */
export function languageOf(
	locales: LocaleRegistry<string>,
	headers: Headers,
): Language {
	const code =
		localeFromAcceptLanguage(locales, headers.get("accept-language")) ??
		locales.defaultLocale;
	return { code, name: locales.languageName(code) };
}
