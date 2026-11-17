import { envString } from "@platform/config/env";
import {
	type AuthMode,
	authMode,
	holdsUnderMode,
	isSignInAllowed,
	localAccount,
	resolveSessionClaims,
	SESSION_MAX_AGE_SECONDS,
	signInAccountId,
	signInGroups,
	signInRoles,
} from "@platform/identity/claims";
import type { NextAuthConfig, Session } from "next-auth";
import Credentials from "next-auth/providers/credentials";
import MicrosoftEntraID from "next-auth/providers/microsoft-entra-id";
import { LOCAL_PROVIDER_ID } from "./src/auth-providers";

/**
 * Edge-safe Auth.js config: providers and callbacks only, no Node-only
 * import, so `proxy.ts` and `auth.ts` share it. The claim rules come from
 * `@platform/identity/claims`; the backend call that persists a sign-in and
 * decides what the account gets lives in `auth.ts`, which runs on Node. The
 * environment is read when the config is asked for, not when this module
 * loads, so an edge bundle that imports it reads nothing before it serves.
 */

const PUBLIC_PATHS = [
	"/login",
	"/privacy",
	"/health",
	"/api/auth",
	"/api/vitals",
	// The deployment's logo: the sign-in door draws it.
	"/api/appearance/logo",
];

export function isPublicPath(pathname: string): boolean {
	return PUBLIC_PATHS.some(
		(p) => pathname === p || pathname.startsWith(`${p}/`),
	);
}

/**
 * How long a session lasts from the sign-in that made it, however active its
 * holder: `@platform/identity`'s one figure, which the backend also keeps an
 * erased account's trace for. The provider's roles and groups reach the
 * account's row at a sign-in and nowhere else, so this bounds how long a
 * removal at the provider takes to reach what the backend reads.
 */
export { SESSION_MAX_AGE_SECONDS };

/**
 * Somebody is signed in, on an account that still holds under this
 * deployment's mode. One answer for the proxy, the door and every page: a
 * session the pages refuse but the proxy lets through sends a browser back
 * and forth between them.
 */
export function holdsSession(session: Session | null | undefined): boolean {
	const id = session?.user?.id;
	return id ? holdsUnderMode(id) : false;
}

/** The one provider the mode names: a deployment signs people in one way. */
function providerFor(mode: AuthMode) {
	if (mode === "local") {
		return Credentials({
			id: LOCAL_PROVIDER_ID,
			name: "Local account",
			credentials: { name: { label: "Name", type: "text" } },
			authorize: (credentials) => localAccount(credentials.name),
		});
	}
	return MicrosoftEntraID({
		clientId: envString("AUTH_MICROSOFT_ENTRA_ID_ID"),
		clientSecret: envString("AUTH_MICROSOFT_ENTRA_ID_SECRET"),
		issuer: envString("AUTH_MICROSOFT_ENTRA_ID_ISSUER"),
		// `select_account` is what makes signing out mean anything: the
		// provider keeps its own browser session, and without a prompt the next
		// request is answered silently with the account just signed out of.
		authorization: {
			params: {
				scope: "openid profile email",
				prompt: "select_account",
			},
		},
		// The stock profile() fetches a photo from Graph with a scope the
		// request above does not carry; that call can only fail.
		profile(claims) {
			return {
				id: claims.sub,
				name: claims.name,
				email: claims.email ?? claims.preferred_username,
			};
		},
	});
}

function nowSeconds(): number {
	return Math.floor(Date.now() / 1000);
}

export function buildAuthConfig(mode: AuthMode) {
	return {
		providers: [providerFor(mode)],
		// Both the door: refusals Auth.js routes to `pages.error` would otherwise
		// land on its own unbranded page, in English, with no disclosure on it.
		pages: { signIn: "/login", error: "/login" },
		// No adapter, so the session is the JWT; Auth.js re-issues it on every
		// read, so `maxAge` alone bounds only idleness, and `jwt` below bounds
		// the whole of it.
		session: { strategy: "jwt", maxAge: SESSION_MAX_AGE_SECONDS },
		callbacks: {
			signIn: ({ profile: claims, user, account }) =>
				isSignInAllowed({ claims, user, account }),
			jwt({ token, profile: claims, account, user }) {
				// `account` is set on a fresh sign-in and on nothing else.
				if (account) {
					const input = { claims, user, account };
					token.sub = signInAccountId(input) ?? token.sub;
					token.roles = signInRoles(input);
					token.groups = signInGroups(input);
					token.signedInAt = nowSeconds();
					return token;
				}
				// Null ends the session: Auth.js clears the cookie and the door opens.
				const signedInAt = Number(token.signedInAt);
				return nowSeconds() - signedInAt < SESSION_MAX_AGE_SECONDS
					? token
					: null;
			},
			session({ session, token }) {
				// Auth.js's token is an open record; what this app put on it is read back by name.
				const claims = resolveSessionClaims({
					id: token.sub,
					roles: token.roles as string[] | undefined,
					groups: token.groups as string[] | undefined,
					tier: token.tier,
				});
				session.user.id = claims.id;
				session.user.roles = claims.roles;
				session.user.groups = claims.groups;
				session.user.tier = claims.tier;
				// When this session was signed in: the backend refuses a session older than its account's erasure.
				const signedInAt = Number(token.signedInAt);
				if (Number.isFinite(signedInAt)) session.user.signedInAt = signedInAt;
				return session;
			},
		},
	} satisfies NextAuthConfig;
}

/** The config for the mode the environment names, built when first asked for. */
export function authConfig() {
	return buildAuthConfig(authMode());
}
