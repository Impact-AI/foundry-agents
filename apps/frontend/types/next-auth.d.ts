import type { Tier } from "@platform/identity/claims";
import type { DefaultSession } from "next-auth";

// The fields the session callback derives (auth.config.ts): the account id,
// the provider's app roles and groups, and the snapshot of what the account
// gets, baked at sign-in and re-resolved by the backend at every point of
// use, and when the session was signed in. The token itself is Auth.js's open record and is read back by name
// where it is used.
declare module "next-auth" {
	interface Session {
		user: {
			id: string;
			roles: string[];
			groups: string[];
			tier: Tier;
			/** Seconds since the epoch at the sign-in that made the session. */
			signedInAt?: number;
		} & DefaultSession["user"];
	}
}
