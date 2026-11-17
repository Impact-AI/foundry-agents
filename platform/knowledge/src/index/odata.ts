/**
 * The OData fragments every filter is built from, so the quoting rules exist
 * once. `search.in` takes `|` as its delimiter rather than the default comma:
 * a tag or a name may legitimately contain a comma, and `search.in` has no
 * escape for its own delimiter.
 */

/** A string literal: single quotes are escaped by doubling. */
export function odataQuote(value: string): string {
	return `'${value.replace(/'/g, "''")}'`;
}

/**
 * The `search.in` list. A value holding the delimiter would be split into
 * two values that were never asked for — a readers clause admitting a group
 * nobody named — so it is refused rather than sent.
 */
function inList(values: readonly string[]): string {
	const split = values.find((v) => v.includes("|"));
	if (split !== undefined)
		throw new Error(
			`"${split}" holds "|", which search.in reads as a delimiter`,
		);
	return `${odataQuote(values.join("|"))}, '|'`;
}

/** `field` equals `value`. */
export function equals(field: string, value: string): string {
	return `${field} eq ${odataQuote(value)}`;
}

/** `field` is one of `values`. */
export function oneOf(field: string, values: readonly string[]): string {
	return `search.in(${field}, ${inList(values)})`;
}

/** The collection `field` carries any of `values`. */
export function anyOf(field: string, values: readonly string[]): string {
	return `${field}/any(t: search.in(t, ${inList(values)}))`;
}

/** The collection `field` carries `value`. */
export function hasValue(field: string, value: string): string {
	return `${field}/any(t: t eq ${odataQuote(value)})`;
}

/** The collection `field` carries every one of `values`: OData has no "contains all". */
export function allOf(field: string, values: readonly string[]): string {
	return values.map((v) => hasValue(field, v)).join(" and ");
}

/** Parenthesised, so a disjunction binds tightly inside an `and` chain. */
export function group(clause: string): string {
	return `(${clause})`;
}
