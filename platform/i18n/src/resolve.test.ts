import { expect, test } from "bun:test";
import { localeFromAcceptLanguage } from "./accept-language";
import { selectedLocaleFromCookieHeader } from "./cookie";
import { defineLocales, ENGLISH } from "./registry";
import { localeFromRequestHeaders } from "./resolve";

/** A product's list; the package itself knows only English. */
const registry = defineLocales({
	supported: [
		ENGLISH,
		{ code: "it", label: "Italiano", languageName: "Italian" },
		{ code: "es", label: "Español", languageName: "Spanish" },
		{ code: "fr", label: "Français", languageName: "French" },
		{ code: "de", label: "Deutsch", languageName: "German" },
	],
});

const cookie = (header: string | null) =>
	selectedLocaleFromCookieHeader(registry, header);
const accept = (header: string | null) =>
	localeFromAcceptLanguage(registry, header);
const resolve = (c: string | null, a: string | null) =>
	localeFromRequestHeaders(registry, c, a);

test("the cookie reading finds its own cookie among others, and nothing that merely contains the name", () => {
	expect(cookie("NEXT_LOCALE=it")).toBe("it");
	expect(cookie("session=abc; NEXT_LOCALE=de; theme=x")).toBe("de");
	expect(cookie("MY_NEXT_LOCALE=de")).toBeNull();
	expect(cookie("NEXT_LOCALE_OLD=de")).toBeNull();
});

test("the cookie reading tells a choice apart from no choice", () => {
	// Null is "they never said", which is not the same answer as English and
	// must not be pinned onto a transcriber.
	expect(cookie(null)).toBeNull();
	expect(cookie("")).toBeNull();
	expect(cookie("theme=dark")).toBeNull();
	expect(cookie("NEXT_LOCALE=")).toBeNull();
	// A locale we do not ship must not reach a transcriber's `language` as-is.
	expect(cookie("NEXT_LOCALE=klingon")).toBeNull();
});

test("a custom cookie name is honoured", () => {
	const named = defineLocales({ supported: [ENGLISH], cookieName: "lang" });
	expect(selectedLocaleFromCookieHeader(named, "NEXT_LOCALE=en; lang=en")).toBe(
		"en",
	);
	expect(selectedLocaleFromCookieHeader(named, "NEXT_LOCALE=en")).toBeNull();
});

test("Accept-Language takes the best language actually shipped", () => {
	expect(accept("fr-CH,fr;q=0.9,en;q=0.8")).toBe("fr");
	// A region not enumerated is still that language.
	expect(accept("de-AT")).toBe("de");
	expect(accept("EN-GB")).toBe("en");
	// Skips past languages with no catalogue rather than giving up.
	expect(accept("ja,ko;q=0.9,es;q=0.5")).toBe("es");
	// Weight beats listing order; equal weights keep the browser's order.
	expect(accept("en;q=0.4,it;q=0.9")).toBe("it");
	expect(accept("es,fr")).toBe("es");
	// q=0 is a refusal, not a preference; a q that is not a number is dropped.
	expect(accept("de;q=0,fr;q=0.1")).toBe("fr");
	expect(accept("de;q=.,fr;q=0.1")).toBe("fr");
});

test("Accept-Language answers null when it asks for nothing we have", () => {
	expect(accept(null)).toBeNull();
	expect(accept("")).toBeNull();
	expect(accept("ja,ko;q=0.9")).toBeNull();
	// "anything" is not evidence for a language.
	expect(accept("*")).toBeNull();
});

test("the one order: choice, then browser, then the default", () => {
	// A stated choice outranks the browser even when they disagree.
	expect(resolve("NEXT_LOCALE=en", "fr-FR,fr;q=0.9")).toBe("en");
	// Nothing stated: the header is the only thing they ever told us.
	expect(resolve(null, "fr-FR,fr;q=0.9")).toBe("fr");
	expect(resolve("theme=dark", "de")).toBe("de");
	// An unsupported cookie value is no choice at all, so the browser answers.
	expect(resolve("NEXT_LOCALE=klingon", "it")).toBe("it");
	expect(resolve(null, null)).toBe("en");
	expect(resolve(null, "ja")).toBe("en");
});

test("the default is the registry's, not English by assumption", () => {
	const french = defineLocales({
		supported: [
			{ code: "fr", label: "Français", languageName: "French" },
			ENGLISH,
		],
	});
	expect(localeFromRequestHeaders(french, null, null)).toBe("fr");
	expect(localeFromRequestHeaders(french, null, "en")).toBe("en");
});

test("a cookie that is not percent-encoding is no choice, and the browser answers", () => {
	expect(cookie("NEXT_LOCALE=%E0%A4%A")).toBeNull();
	expect(cookie("NEXT_LOCALE=%")).toBeNull();
	expect(() => resolve("NEXT_LOCALE=%E0%A4%A", null)).not.toThrow();
});

test("a q above 1 says no more than 1 does", () => {
	// Held to 1, the tie goes to the browser's order, as it does at 1.
	expect(accept("it,de;q=5")).toBe("it");
	expect(accept("it,de;q=1")).toBe("it");
});
