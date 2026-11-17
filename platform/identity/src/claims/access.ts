/**
 * What a signed-in person gets, decided from the identity provider's app
 * roles and from nothing else. Fails closed: with no role, everybody is on
 * the base tier. Which roles exist and how one is assigned is in the README;
 * no environment variable grants anything.
 */

export type Tier = "base" | "premium";

export interface Access {
	tier: Tier;
}

/** What the account's row decides, with the groups its token named beside it. */
export interface AccountAccess extends Access {
	groups: string[];
}

export const TIERS: readonly Tier[] = ["base", "premium"];

export function parseTier(value: unknown): Tier {
	return value === "premium" ? "premium" : "base";
}

/** The app roles this package reads, spelled as the registration must spell them. */
export const APP_ROLES = {
	premium: "premium",
	member: "user",
} as const;

export const KNOWN_ROLES: readonly string[] = Object.values(APP_ROLES);

type Roles = readonly string[] | null | undefined;

export function isPremium(roles: Roles): boolean {
	return roles?.includes(APP_ROLES.premium) ?? false;
}

/**
 * The app role that lets a person tune live voice for their own sessions
 * (Settings → Voice tuning). Not among {@link KNOWN_ROLES}: it admits nobody
 * on its own, and it changes nothing a tester shares with anyone else.
 */
export const VOICE_TESTER_ROLE = "tester";

/** Whether an account's roles, as its row holds them at the point of use, make it a voice tester. */
export function isVoiceTester(roles: Roles): boolean {
	return roles?.includes(VOICE_TESTER_ROLE) ?? false;
}

export function resolveAccess(roles: Roles): Access {
	return { tier: isPremium(roles) ? "premium" : "base" };
}

export const NO_ACCESS: AccountAccess = {
	tier: "base",
	groups: [],
};

/** What a stored account gets, at the point of use. No row is the lesser answer. */
export function accountAccess(
	account: { roles: readonly string[]; groups: readonly string[] } | null,
): AccountAccess {
	return account
		? { ...resolveAccess(account.roles), groups: [...account.groups] }
		: NO_ACCESS;
}
