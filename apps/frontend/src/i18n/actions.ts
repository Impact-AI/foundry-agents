"use server";

import { setUserLocale } from "./locale";
import { locales } from "./locales";

/** Writing the cookie inside an action re-renders the route in the new language. */
export async function setLocale(value: unknown): Promise<void> {
	if (locales.isLocale(value)) await setUserLocale(value);
}
