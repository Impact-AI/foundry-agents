import { envString } from "@platform/config/env";
import { APP_ROLES } from "./access";
import { LOCAL_PROVIDER_ID } from "./provider";

/**
 * How a deployment signs people in, decided once by `AUTH_MODE`. `entra`,
 * the identity provider, is the default and the only mode a hardened
 * deployment may run (`deployment-rules`). `local` is a sign-in with a name
 * and no password, for trying a deployment that has no app registration
 * yet: every local account is a member on the base tier, because access
 * comes from the provider's roles and a demo has no provider. An unknown
 * value reads as `entra`, so a typo opens nothing.
 */
export const AUTH_MODES = ["entra", "local"] as const;
export type AuthMode = (typeof AUTH_MODES)[number];

export function parseAuthMode(value: string | undefined): AuthMode | null {
	const mode = value?.trim();
	return AUTH_MODES.find((m) => m === mode) ?? null;
}

export function authMode(): AuthMode {
	return parseAuthMode(envString("AUTH_MODE")) ?? "entra";
}

export { LOCAL_PROVIDER_ID };

/** The roles every local account carries: a member, nothing more. */
export const LOCAL_ROLES: readonly string[] = [APP_ROLES.member];

/** A name that is one: a letter or digit, then up to 59 more with spaces, dots, dashes and underscores. */
const NAME = /^[\p{L}\p{N}][\p{L}\p{N} ._-]{0,59}$/u;

export interface LocalAccount {
	id: string;
	name: string;
	email: null;
}

/**
 * A new account for a name typed at the door, or null for a name that is not
 * one. The name is what the account is called and nothing more: with no
 * password a name proves nobody, so an id derived from it would hand whoever
 * typed "ada" Ada's conversations, notes and erasure. The id is random,
 * minted per sign-in and kept on the session, so every local sign-in is a new
 * person and none can be resumed; keeping history is the identity
 * provider's job.
 */
export function localAccount(name: unknown): LocalAccount | null {
	if (typeof name !== "string") return null;
	const trimmed = name.trim();
	if (!NAME.test(trimmed)) return null;
	return {
		id: `${LOCAL_PROVIDER_ID}:${crypto.randomUUID()}`,
		name: trimmed,
		email: null,
	};
}

export function isLocalAccountId(id: string | null | undefined): id is string {
	return id?.startsWith(`${LOCAL_PROVIDER_ID}:`) ?? false;
}

/**
 * Whether a session for `id` still holds. Sign-in checks the mode once, but a
 * session outlives it: a deployment moved from `local` to `entra` would go on
 * serving every local session it ever minted, so a local account holds only
 * while the mode is `local`.
 */
export function holdsUnderMode(id: string): boolean {
	return !isLocalAccountId(id) || authMode() === "local";
}
