import type { LocaleRegistry } from "./registry";

/**
 * The best supported language out of a browser's `Accept-Language`, or null
 * when it asks for none of them.
 *
 * The header is the one statement of language a first-time visitor makes, set
 * once and never thought about again. Ranked by its `q` weights, ties broken
 * by the browser's own order; a region is dropped before matching (`fr-CH` is
 * French, since the registry holds bare subtags); `*` matches nothing, since
 * "anything" is not evidence for one language over another.
 */
export function localeFromAcceptLanguage<L extends string>(
	registry: LocaleRegistry<L>,
	header: string | null | undefined,
): L | null {
	if (!header) return null;
	const ranked = header
		.split(",")
		.map((part, order) => {
			const [tag, ...params] = part.split(";");
			const q = params
				.map((p) => /^\s*q\s*=\s*([0-9.]+)\s*$/i.exec(p)?.[1])
				.find((v) => v !== undefined);
			const weight = q === undefined ? 1 : Number.parseFloat(q);
			return {
				primary: (tag ?? "").trim().toLowerCase().split("-")[0],
				// A malformed q is not a preference, and NaN sorts nowhere useful;
				// one above 1 is held to 1, the most the header can say.
				weight: Number.isFinite(weight) ? Math.min(weight, 1) : 0,
				order,
			};
		})
		.filter((entry) => entry.primary && entry.weight > 0)
		.sort((a, b) => b.weight - a.weight || a.order - b.order);

	for (const { primary } of ranked) {
		if (registry.isLocale(primary)) return primary;
	}
	return null;
}
