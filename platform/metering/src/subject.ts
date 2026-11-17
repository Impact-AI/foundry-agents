/**
 * Whose allowance a charge is drawn on.
 *
 * The brand turns the boundary rule into a type error. A bucket keyed on
 * anything a caller sent — a body field, a query parameter, a cookie — is a
 * fresh quota per request, and a plain string cannot tell that apart from an
 * account id out of a verified session or assertion. Only `usageSubject`
 * mints one, so every call site that does so reads as the deliberate act it
 * is, in a diff.
 */
declare const verified: unique symbol;
export type UsageSubject = string & { readonly [verified]: true };

/**
 * The subject for a verified account id, or null when there is nothing to
 * meter: blank, or a value a key part cannot carry (braces are a cluster hash
 * tag, and an id that contained one would change which slot its keys land on).
 */
export function usageSubject(
	accountId: string | null | undefined,
): UsageSubject | null {
	const id = accountId?.trim();
	if (!id || /[{}]/.test(id)) return null;
	return id as UsageSubject;
}
