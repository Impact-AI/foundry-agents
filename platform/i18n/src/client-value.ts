import type { LocaleRegistry } from "./registry";

/**
 * A locale a client sent, narrowed to a supported one, or null.
 *
 * This is an injection boundary, not a formality: the value lands in a
 * model's instructions above the operator's own words, and a client is free
 * to send whatever it likes. Anything unrecognised is treated as a client
 * that never declared one. The code is accepted raw and JSON-encoded, because
 * a transport that serialises every readable sends `"fr"` as `"\"fr\""`.
 */
export function localeFromClientValue<L extends string>(
	registry: LocaleRegistry<L>,
	value: unknown,
): L | null {
	if (typeof value !== "string") return null;
	if (registry.isLocale(value)) return value;
	try {
		const decoded: unknown = JSON.parse(value);
		if (registry.isLocale(decoded)) return decoded;
	} catch {
		// Not JSON, and not a bare code either — nothing to recognise.
	}
	return null;
}
