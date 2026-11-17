import { stringList } from "./values";

/**
 * The groups a token names, as object ids: what access control at the level
 * of a document is decided against. The registration's token configuration
 * must add the `groups` claim for them to be there at all.
 *
 * The provider stops listing at a bound of its own and marks the overage
 * instead (`hasgroups`, or `groups` under `_claim_names`); this package reads
 * no list for such a token and never calls Microsoft Graph for one.
 * Configure the registration to emit the ids of the groups assigned to the
 * application only, or use app roles. The cap here bounds the row.
 */
export const GROUPS_MAX = 200;

export type GroupsLike =
	| { groups?: unknown; hasgroups?: unknown; _claim_names?: unknown }
	| null
	| undefined;

export function groupsOf(claims: GroupsLike): string[] {
	if (groupsOverflowed(claims)) return [];
	return stringList(claims?.groups).slice(0, GROUPS_MAX);
}

/** The token names more groups than it carries. */
export function groupsOverflowed(claims: GroupsLike): boolean {
	if (claims?.hasgroups === true) return true;
	const names = claims?._claim_names;
	return typeof names === "object" && names !== null && "groups" in names;
}
