import { expect, test } from "bun:test";
import { defineLocales, ENGLISH, LOCALE_COOKIE } from "./registry";

test("with nothing given the registry is English only, under the usual cookie", () => {
	const registry = defineLocales();
	expect(registry.codes).toEqual(["en"]);
	expect(registry.defaultLocale).toBe("en");
	expect(registry.cookieName).toBe(LOCALE_COOKIE);
	expect(registry.isLocale("en")).toBe(true);
	expect(registry.isLocale("fr")).toBe(false);
	expect(registry.languageName("en")).toBe("English");
});

test("the product's list is kept in menu order, with the first as the default unless told otherwise", () => {
	const registry = defineLocales({
		supported: [
			{ code: "fr", label: "Français", languageName: "French" },
			ENGLISH,
			{ code: "de", label: "Deutsch", languageName: "German" },
		],
		default: "en",
		cookieName: "lang",
	});
	expect(registry.codes).toEqual(["fr", "en", "de"]);
	expect(registry.defaultLocale).toBe("en");
	expect(registry.cookieName).toBe("lang");
	expect(registry.label("fr")).toBe("Français");
	expect(registry.languageName("de")).toBe("German");
	expect(
		defineLocales({
			supported: [{ code: "fr", label: "Français", languageName: "French" }],
		}).defaultLocale,
	).toBe("fr");
});

test("a list that could not reach a transcriber or a model is refused at definition", () => {
	const fr = { code: "fr", label: "Français", languageName: "French" };
	expect(() =>
		defineLocales({ supported: [{ ...fr, code: "fr-CH" }] }),
	).toThrow(/bare lowercase/);
	expect(() => defineLocales({ supported: [{ ...fr, code: "FR" }] })).toThrow(
		/bare lowercase/,
	);
	expect(() => defineLocales({ supported: [fr, fr] })).toThrow(/twice/);
	expect(() =>
		defineLocales({ supported: [{ ...fr, languageName: " " }] }),
	).toThrow(/English language name/);
	expect(() => defineLocales({ supported: [] })).toThrow(/at least one/);
	expect(() =>
		defineLocales({ supported: [fr], default: "en" as "fr" }),
	).toThrow(/not among/);
});

test("an accent is a region of its own language, and a locale may leave the accent to the voice", () => {
	const registry = defineLocales({
		supported: [
			ENGLISH,
			{
				code: "fr",
				label: "Français",
				languageName: "French",
				accent: "fr-FR",
			},
			{ code: "de", label: "Deutsch", languageName: "German" },
		],
	});
	expect(registry.accent("en")).toBe("en-US");
	expect(registry.accent("fr")).toBe("fr-FR");
	expect(registry.accent("de")).toBeNull();
	const fr = { code: "fr", label: "Français", languageName: "French" };
	for (const accent of ["fr", "de-DE", "fr-fr", "fr_FR"])
		expect(() => defineLocales({ supported: [{ ...fr, accent }] })).toThrow(
			/a region of its own language/,
		);
});

test("a name is asked for only of a supported locale", () => {
	const registry = defineLocales();
	expect(() => registry.languageName("fr" as "en")).toThrow(/not supported/);
});
