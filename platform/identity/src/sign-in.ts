import {
	beginErase,
	EraseUnderWayError,
	eraseUnderWay,
	finishErase,
	isAccountDisabled,
	releaseErase,
	underLease,
	upsertAccount,
} from "./accounts";
import { resolveAccess } from "./claims/access";
import { groupsOverflowed } from "./claims/groups";
import {
	isSignInAllowed,
	resolveEmail,
	type SignInInput,
	type SignInOutcome,
	signInAccountId,
	signInGroups,
	signInRoles,
} from "./claims/sign-in";

/**
 * What a backend does when a web app reports a sign-in it has verified.
 *
 * One call, in one order: the claim gate, then the standing of the account the
 * sign-in lands on, then the record, then the access decision the app bakes
 * onto its session. Refusals are answered, never thrown; a database that
 * cannot answer refuses, because an authorization decision it could not make
 * is not a yes.
 *
 * A sign-in that lands while the account is being erased is refused as
 * `unavailable`, which a web app asks again: an account made now would be
 * swept with the old one. An erase nobody holds any longer — its sweep
 * failed and it let go, or it has stood longer than one takes
 * (`ERASE_STALLED_SECONDS`) — is finished here first: `sweep` is the app's
 * own erasure of everything it holds under the id, run again whole, then
 * the row's last write. So neither a failed erase nor a process that died
 * part way through one shuts the person out for good. With no `sweep`
 * given there is nothing here that can finish it, and the sign-in stays
 * refused.
 */
export type { SignInOutcome };

export interface SignInOptions {
	/**
	 * Erase everything the app holds under an account id, apart from the
	 * account's own row. Idempotent. `stillHeld` is asked before each step:
	 * false once the erase is no longer this sign-in's, and the sweep stops.
	 */
	sweep?: (
		accountId: string,
		stillHeld: () => Promise<boolean>,
	) => Promise<unknown>;
}

export async function resolveSignIn(
	input: SignInInput,
	options: SignInOptions = {},
): Promise<SignInOutcome> {
	if (!isSignInAllowed(input)) return { ok: false, reason: "not_allowed" };
	const accountId = signInAccountId(input);
	if (!accountId) return { ok: false, reason: "no_account" };
	const email = resolveEmail(input.claims, input.user);
	const roles = signInRoles(input);
	const groups = signInGroups(input);
	if (groupsOverflowed(input.claims))
		console.warn(
			"[identity] the token names more groups than it carries, so none are recorded; emit the ids of the groups assigned to the application, or use app roles",
		);
	try {
		const { sweep } = options;
		if (await eraseUnderWay(accountId)) {
			const erase = sweep
				? await beginErase(accountId)
				: ({ phase: "busy" } as const);
			// Not this sign-in's to finish: a deactivation is still said as one.
			if (erase.phase === "busy")
				return {
					ok: false,
					reason: (await isAccountDisabled(accountId))
						? "deactivated"
						: "unavailable",
				};
			if (erase.phase === "resumed") {
				try {
					await underLease(accountId, erase.token, (stillHeld) =>
						sweep ? sweep(accountId, stillHeld) : Promise.resolve(),
					);
				} catch (err) {
					await releaseErase(accountId, erase.token);
					throw err;
				}
				await finishErase(accountId, erase.token);
			}
		}
		if (await isAccountDisabled(accountId))
			return { ok: false, reason: "deactivated" };
		await upsertAccount({
			id: accountId,
			email,
			name:
				input.user?.name ??
				(typeof input.claims?.name === "string" ? input.claims.name : null),
			roles,
			groups,
		});
	} catch (err) {
		// An erase that began as this sign-in was being recorded: asked again, it is over.
		if (err instanceof EraseUnderWayError)
			return { ok: false, reason: "unavailable" };
		console.error("[identity] sign-in could not reach the database:", err);
		return { ok: false, reason: "unavailable" };
	}
	return { ok: true, accountId, access: resolveAccess(roles) };
}
