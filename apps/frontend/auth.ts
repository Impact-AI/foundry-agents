import NextAuth from "next-auth";
import { authConfig } from "./auth.config";
import { reportSignIn } from "./src/sign-in";

/**
 * The full Auth.js instance, Node runtime. `handlers` backs
 * /api/auth/[...nextauth]; `auth` reads the session in pages and routes.
 *
 * No adapter, and the JWT strategy said out loud in the config: Auth.js
 * infers database sessions from an adapter's presence, and an adapter's mere
 * presence gates its whole OAuth account resolution. The record of a sign-in
 * is the backend's, reached through `reportSignIn`.
 */
const config = authConfig();

export const { handlers, auth } = NextAuth({
	...config,
	callbacks: {
		...config.callbacks,
		// The gate, in order: the claim rules first (edge-safe, also what the
		// proxy's copy applies), then the backend's answer — the account's
		// standing and its record — which only this runtime can ask for.
		signIn: async ({ user, profile: claims, account }) => {
			if (!config.callbacks.signIn({ user, profile: claims, account }))
				return false;
			const outcome = await reportSignIn({ user, claims, account });
			return outcome.ok ? true : `/login?error=${outcome.reason}`;
		},
		// What the account gets, baked onto the token on the call that mints
		// it. A snapshot: the backend re-resolves at every point of use.
		async jwt(params) {
			const token = await config.callbacks.jwt(params);
			if (!token || !params.account) return token;
			const outcome = await reportSignIn({
				user: params.user,
				claims: params.profile,
				account: params.account,
			});
			if (outcome.ok) {
				token.sub = outcome.accountId;
				token.tier = outcome.access.tier;
			}
			return token;
		},
	},
});
