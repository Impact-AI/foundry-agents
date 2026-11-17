import { z } from "zod";
import { FIELD } from "../index/definition";
import { allOf, anyOf, group, hasValue, oneOf } from "../index/odata";
import type { DocumentKind } from "../types";

/**
 * The typed intent behind one retrieval, and the one place its `$filter` is
 * compiled. Plain data: no client, no clock, no network. Two things a
 * library says about a file can be filtered on: its tags, the one field
 * both searchable and filterable, and its kind, a document or a picture.
 */

export const tagMode = z.enum(["any", "all"]);
export type TagMode = z.infer<typeof tagMode>;

export interface QuerySpec {
	tags?: string[];
	/** Default "any". */
	tagMode?: TagMode;
	kinds?: DocumentKind[];
}

/**
 * A chunk carrying any of `tags`. `search.in` has no escape for its
 * delimiter, so a tag that holds one is compared on its own with `eq`
 * instead: a tag is whatever text a caller or an index holds, and none of
 * it may make a filter that cannot be built.
 */
export function anyTag(tags: readonly string[]): string {
	const listed = tags.filter((tag) => !tag.includes("|"));
	const clauses = [
		...(listed.length ? [anyOf(FIELD.tags, listed)] : []),
		...tags
			.filter((tag) => tag.includes("|"))
			.map((tag) => hasValue(FIELD.tags, tag)),
	];
	return clauses.length === 1
		? (clauses[0] as string)
		: group(clauses.join(" or "));
}

/** The spec as a `$filter`, or null when it constrains nothing. */
export function buildFilter(spec: QuerySpec): string | null {
	const clauses: string[] = [];
	if (spec.tags?.length)
		clauses.push(
			spec.tagMode === "all" ? allOf(FIELD.tags, spec.tags) : anyTag(spec.tags),
		);
	if (spec.kinds?.length) clauses.push(oneOf(FIELD.kind, spec.kinds));
	return clauses.length ? clauses.join(" and ") : null;
}
