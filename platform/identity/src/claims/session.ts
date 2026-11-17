import { type Access, parseTier, resolveAccess, type Tier } from "./access";

/**
 * What a web app puts on its session from the token it holds.
 *
 * The token carries a snapshot taken at sign-in. It draws the interface; it
 * never authorizes. Anything that costs something re-resolves at the point of
 * use, from the backend, against the database.
 */
export interface SessionClaims extends Access {
	id: string;
	roles: string[];
	groups: string[];
}

/**
 * How long a browser session lasts from its sign-in, whatever its use. The
 * web app ends a session at this age. What an erased account leaves behind
 * is kept longer than this by the life of the last assertion such a session
 * can mint and a margin for the clocks (`accounts`' `ERASE_KEPT_SECONDS`),
 * so no caller older than the erase outlives it.
 */
export const SESSION_MAX_AGE_SECONDS = 8 * 60 * 60;

export function resolveSessionClaims(input: {
	id: string | null | undefined;
	roles: readonly string[] | null | undefined;
	groups: readonly string[] | null | undefined;
	/** The tier baked onto the token at sign-in, when the app did so. */
	tier?: unknown;
}): SessionClaims {
	const roles = [...(input.roles ?? [])];
	const tier: Tier =
		input.tier === undefined || input.tier === null
			? resolveAccess(roles).tier
			: parseTier(input.tier);
	return {
		id: input.id ?? "",
		roles,
		groups: [...(input.groups ?? [])],
		tier,
	};
}
