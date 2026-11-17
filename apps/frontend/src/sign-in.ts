import {
	resolveAccess,
	resolveEmail,
	type SignInInput,
	signInAccountId,
	signInGroups,
	signInRoles,
} from "@platform/identity/claims";
import { backendUrl } from "./backend/client";
import { callerAssertion, type SignInOutcome } from "./identity";

/**
 * What this app's server tells the backend when a sign-in it verified
 * arrives, and what the backend decided. The assertion for this one call is
 * minted from the sign-in's own claims — there is no account on the session
 * yet — with the provider's stable subject as `sub`.
 *
 * Auth.js asks twice per sign-in, from `signIn` and from `jwt`, with the same
 * `account` object; the outcome is remembered on it so the backend is asked
 * once.
 */
const outcomes = new WeakMap<object, Promise<SignInOutcome>>();

export function reportSignIn(input: SignInInput): Promise<SignInOutcome> {
	const key = input.account;
	if (key && typeof key === "object") {
		const known = outcomes.get(key);
		if (known) return known;
		const pending = askBackend(input);
		outcomes.set(key, pending);
		return pending;
	}
	return askBackend(input);
}

/** A sign-in waits this long for the backend's decision, then is refused as unavailable. */
const SIGN_IN_DEADLINE_MS = 15_000;

export function providerOnly(
	account: SignInInput["account"],
): SignInInput["account"] {
	const provider = (account as { provider?: unknown } | null | undefined)
		?.provider;
	return typeof provider === "string" ? { provider } : null;
}

async function askBackend(input: SignInInput): Promise<SignInOutcome> {
	const sub = signInAccountId(input);
	if (!sub) return { ok: false, reason: "no_account" };
	const roles = signInRoles(input);
	const { token } = await callerAssertion.mint({
		sub,
		email: resolveEmail(input.claims, input.user),
		roles,
		groups: signInGroups(input),
		...resolveAccess(roles),
	});
	try {
		const res = await fetch(`${backendUrl()}/identity/sign-in`, {
			method: "POST",
			headers: {
				Authorization: `Bearer ${token}`,
				"Content-Type": "application/json",
			},
			body: JSON.stringify({
				claims: input.claims ?? null,
				user: input.user ?? null,
				// The provider's name is all the backend reads of the account; its
				// tokens are this server's and go no further.
				account: providerOnly(input.account),
			} satisfies SignInInput),
			cache: "no-store",
			signal: AbortSignal.timeout(SIGN_IN_DEADLINE_MS),
		});
		if (!res.ok) {
			console.error(`[sign-in] backend answered ${res.status}`);
			return { ok: false, reason: "unavailable" };
		}
		return (await res.json()) as SignInOutcome;
	} catch (err) {
		console.error("[sign-in] backend unreachable:", err);
		return { ok: false, reason: "unavailable" };
	}
}
