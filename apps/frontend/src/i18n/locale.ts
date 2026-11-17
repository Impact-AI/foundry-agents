import { localeFromRequestHeaders } from "@platform/i18n";
import { cookies, headers } from "next/headers";
import { type Locale, locales } from "./locales";

const ONE_YEAR = 60 * 60 * 24 * 365;

/**
 * The language to serve this request in: what they chose, else what their
 * browser asks for, else the default — the one order every surface uses.
 * The choice is read from the cookie store, not the request's `cookie`
 * header: the switcher's action writes the store and the route re-renders
 * in that same request, whose header still carries the old choice.
 */
export async function getUserLocale(): Promise<Locale> {
	const [h, store] = await Promise.all([headers(), cookies()]);
	const chosen = store.get(locales.cookieName)?.value;
	return localeFromRequestHeaders(
		locales,
		chosen ? `${locales.cookieName}=${encodeURIComponent(chosen)}` : null,
		h.get("accept-language"),
	);
}

export async function setUserLocale(locale: Locale): Promise<void> {
	const store = await cookies();
	store.set(locales.cookieName, locale, {
		path: "/",
		maxAge: ONE_YEAR,
		sameSite: "lax",
	});
}
