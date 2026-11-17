import type { Access } from "./access";
import { isAdmitted } from "./admission";
import { normalizeEmail } from "./email";
import { type GroupsLike, groupsOf } from "./groups";
import {
	authMode,
	isLocalAccountId,
	LOCAL_PROVIDER_ID,
	LOCAL_ROLES,
} from "./local";
import { str, stringList } from "./values";

/**
 * The rules a web app applies to a sign-in before anything touches a
 * database: which account it is, which address it carries, which roles and
 * groups, whether it is admitted. Structural types, so an app passes its
 * auth library's own objects straight in: the token's claims, the user and
 * the account.
 */

/** The claims read off an OpenID Connect token. Entra puts the stable id in `oid`. */
export type TokenClaims =
	| ({
			oid?: unknown;
			roles?: unknown;
			email?: unknown;
			preferred_username?: unknown;
			upn?: unknown;
			name?: unknown;
	  } & NonNullable<GroupsLike>)
	| null
	| undefined;

export type UserLike =
	| { id?: string | null; email?: string | null; name?: string | null }
	| null
	| undefined;

export type AccountLike = { provider?: string | null } | null | undefined;

export interface SignInInput {
	claims?: TokenClaims;
	user?: UserLike;
	account?: AccountLike;
}

function isLocal(input: SignInInput): boolean {
	return input.account?.provider === LOCAL_PROVIDER_ID;
}

/**
 * The address, from the first claim that carries one: `email`, a work
 * account's `preferred_username` or `upn`, the user object. A claim holding
 * text that is no address is passed over, not taken as the answer.
 */
export function resolveEmail(
	claims: TokenClaims,
	user?: UserLike,
): string | null {
	for (const candidate of [
		str(claims?.email),
		str(claims?.preferred_username),
		str(claims?.upn),
		user?.email,
	]) {
		const email = normalizeEmail(candidate);
		if (email) return email;
	}
	return null;
}

/**
 * The account id this sign-in is: the provider's stable subject. One id,
 * everywhere. A provider token without `oid` names no account: the user
 * object's id is one an auth library mints per sign-in, and taking it would
 * make a new person of every sign-in.
 */
export function signInAccountId(input: SignInInput): string | null {
	if (isLocal(input)) {
		const id = str(input.user?.id);
		return isLocalAccountId(id) ? id : null;
	}
	return str(input.claims?.oid) ?? null;
}

/** The roles the provider asserted; a local account is a member and nothing more. */
export function signInRoles(input: SignInInput): string[] {
	if (isLocal(input)) return signInAccountId(input) ? [...LOCAL_ROLES] : [];
	return stringList(input.claims?.roles);
}

/** The groups the provider asserted; a local account is in none. */
export function signInGroups(input: SignInInput): string[] {
	return isLocal(input) ? [] : groupsOf(input.claims);
}

/** The gate: a local sign-in only in local mode, otherwise admission by role. */
export function isSignInAllowed(input: SignInInput): boolean {
	if (isLocal(input)) return authMode() === "local";
	return isAdmitted(signInRoles(input));
}

/** What a backend answers a web app that reported a sign-in; `resolveSignIn` is the call. */
export type SignInOutcome =
	| { ok: true; accountId: string; access: Access }
	| {
			ok: false;
			reason: "not_allowed" | "no_account" | "deactivated" | "unavailable";
	  };
