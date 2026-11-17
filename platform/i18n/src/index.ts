export { localeFromAcceptLanguage } from "./accept-language";
export { localeFromClientValue } from "./client-value";
export { selectedLocaleFromCookieHeader } from "./cookie";
export {
	defineLocales,
	ENGLISH,
	LOCALE_COOKIE,
	LocaleConfigError,
	type LocaleEntry,
	type LocaleRegistry,
	type LocalesConfig,
} from "./registry";
export { localeFromRequestHeaders } from "./resolve";
