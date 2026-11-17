/**
 * React keys for a list whose natural key is text somebody else wrote: the
 * text itself where it is the only one of its kind, and the text with its
 * count where it repeats. Two series the model named alike, or two tags
 * spelled the same, are then two elements and not one.
 */
export function uniqueKeys(names: readonly string[]): string[] {
	const seen = new Map<string, number>();
	return names.map((name) => {
		const count = (seen.get(name) ?? 0) + 1;
		seen.set(name, count);
		return count === 1 ? name : `${name}\u0000${count}`;
	});
}
