import { defineLocales, ENGLISH } from "@platform/i18n";

/**
 * The product's languages: the one list. The backend names the language to
 * the model, the transcriber and the live voice from it, and the accent the
 * voice speaks each one with; the frontend
 * imports this same object for its catalogues, switcher and `<html lang>`,
 * so a language either side offers is one the other speaks. It imports
 * nothing but `@platform/i18n`, because the frontend's image copies this
 * file alone out of the backend.
 */
export const locales = defineLocales({
	supported: [
		ENGLISH,
		{
			code: "it",
			label: "Italiano",
			languageName: "Italian",
			accent: "it-IT",
		},
		{
			code: "es",
			label: "Español",
			languageName: "Spanish",
			accent: "es-ES",
		},
		{
			code: "fr",
			label: "Français",
			languageName: "French",
			accent: "fr-FR",
		},
		{
			code: "de",
			label: "Deutsch",
			languageName: "German",
			accent: "de-DE",
		},
	],
	default: "en",
});

export type Locale = (typeof locales.codes)[number];
