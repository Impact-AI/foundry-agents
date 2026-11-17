import { envFlag } from "@platform/config/env";
import { KNOWN_ROLES } from "./access";

/**
 * Who may sign in. The registration decides first: with assignment required
 * on it, the provider refuses a token to anyone not assigned, before any of
 * this runs. `AUTH_REQUIRE_ROLE` is the second line, for a registration that
 * is not locked that way: on, a token carrying none of the roles this
 * package knows is refused here; off, everyone the provider authenticates
 * is admitted.
 */
export function roleRequired(): boolean {
	return envFlag("AUTH_REQUIRE_ROLE");
}

export function isAdmitted(
	roles: readonly string[] | null | undefined,
): boolean {
	if (!roleRequired()) return true;
	return roles?.some((role) => KNOWN_ROLES.includes(role)) ?? false;
}
