/**
 * Named entities and the words people call them by: a table the product
 * supplies, so a question that names an entity in words reaches the tag the
 * library filed it under. {@link entitiesNamedIn} reads a question; the
 * planner tells the model what each tag means and what people call it
 * instead.
 */
export interface EntityAlias {
	/** The tag, lowercase, and what a caller filters on. */
	tag: string;
	/** Its name spelled out, with the abbreviation people search by. */
	name: string;
	/**
	 * Phrases that identify it, lowercase. Kept unambiguous on purpose: a word
	 * that matches every record filters nothing.
	 */
	aliases: readonly string[];
}

export type EntityAliasTable = readonly EntityAlias[];

/** Escaped and bounded by non-letters, so a short alias is not found inside a longer word. */
function aliasPattern(alias: string): RegExp {
	const escaped = alias.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	return new RegExp(`(?<![\\p{L}\\p{N}])${escaped}(?![\\p{L}\\p{N}])`, "iu");
}

const patterns = new WeakMap<EntityAliasTable, Map<string, RegExp[]>>();

function patternsOf(table: EntityAliasTable): Map<string, RegExp[]> {
	let compiled = patterns.get(table);
	if (!compiled) {
		compiled = new Map(table.map((e) => [e.tag, e.aliases.map(aliasPattern)]));
		patterns.set(table, compiled);
	}
	return compiled;
}

/** Every entity `text` names, in the table's order. */
export function entitiesNamedIn(
	table: EntityAliasTable,
	text: string,
): EntityAlias[] {
	if (!text || table.length === 0) return [];
	const compiled = patternsOf(table);
	return table.filter((e) =>
		(compiled.get(e.tag) ?? []).some((re) => re.test(text)),
	);
}
