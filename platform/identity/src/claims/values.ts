/** The readers every claim shape shares: a token's fields are untyped until read. */

export function str(value: unknown): string | null {
	return typeof value === "string" && value.length > 0 ? value : null;
}

export function stringList(value: unknown): string[] {
	return Array.isArray(value)
		? value.filter((x): x is string => typeof x === "string")
		: [];
}
