import { type Account, ownedBy, readAccountRecord } from "./accounts";

/**
 * Whether the account behind a request may still spend, asked where it would.
 *
 * Deactivation is checked at sign-in, and on its own that reaches the next
 * sign-in and nothing else: a session is a stateless token. So every surface
 * that costs something asks here first, uncached. The answer comes with the
 * record it was read from, so the one point read that decides standing also
 * decides what the account gets: a second read of the same document would
 * pay its request units twice, on every request that spends. The
 * routes that serve a person their own data back, export and erasure, do not
 * ask: deactivation shuts the product, not the person's rights over what it
 * holds.
 *
 * An erase is checked the same way, on the same read. What an erase leaves
 * (`accounts`: a marker, or the tombstone of a deactivated account) admits
 * no session at all: every session that names the id began before it, and a
 * tombstone's stay refused for good. A row an erase has begun on admits
 * none either, from its first write: nothing is read or made under an id
 * while what the agent holds for it is being swept. Once a sign-in has made a new account
 * of a marker, the erase is still kept for as long as a caller from before
 * it could present itself, and a session is admitted only when it began at
 * or after that sign-in was recorded, allowing for the two clocks
 * (`CLOCK_SKEW_SECONDS`): the time of the admission is this side's, so a
 * web app whose clock runs up to that far behind does not have its new
 * session refused. A session that names no sign-in time is refused for as
 * long as the erase is kept, and no longer. `erased` belongs to the person
 * whose account is gone, and must not read or write under an id that may by
 * now be somebody's new account — so it is asked before deactivation: a
 * session from before an erase is `erased` on an account made since and
 * then deactivated, and keeps none of the rights a deactivated person has
 * over their own record.
 *
 * What two clocks cannot tell, stated exactly. A session that began within
 * the allowance before a sign-in that itself followed the erase within the
 * allowance is admitted, though it is from before the erase. And a web app
 * whose clock runs further behind than the allowance has the session it
 * opens after an erase refused, and every later one until its clock passes
 * the recorded admission less the allowance — a lag of ninety seconds is
 * thirty seconds of refused sign-ins. The admission is not stamped again
 * by a later sign-in: that would refuse the sessions the person opened on
 * other devices since the erase, and would never admit a clock that far
 * behind at all.
 */
export type AccountStanding = "active" | "deactivated" | "erased" | "unknown";

export interface AccountReading {
	standing: AccountStanding;
	/** The row; null when there is none, which is active (a first sign-in must work), or when it could not be read. */
	account: Account | null;
	/**
	 * On `erased` alone: true when a sign-in has made a new account of the id
	 * since, so there is somebody else's record under it; false while the row
	 * is only what the erase left.
	 */
	remade?: boolean;
	/** On `erased` alone: the erase was a deactivated account's, and what it left is the deactivation. */
	deactivated?: boolean;
	/** On `erased` alone: the erase has shut the row and not finished; asked for again, it is swept and finished. */
	erasing?: boolean;
}

/** Never throws: a read nobody could make is `unknown`, and the caller fails closed on it. */
export async function readAccountStanding(
	accountId: string | null | undefined,
	session: { signedInAt?: number } = {},
): Promise<AccountReading> {
	const id = accountId?.trim();
	if (!id) return { standing: "unknown", account: null };
	try {
		const record = await readAccountRecord(id);
		if (record.remains)
			return {
				standing: "erased",
				account: null,
				remade: false,
				...(record.remains === "tombstone" ? { deactivated: true } : {}),
				...(record.remains === "erasing" ? { erasing: true } : {}),
			};
		// Whose the record is comes first: a session from before an erase is
		// the erased person's whatever has become of the account made since,
		// a deactivation included.
		if (!ownedBy(record, session))
			return { standing: "erased", account: null, remade: true };
		return record.account?.disabled
			? { standing: "deactivated", account: record.account }
			: { standing: "active", account: record.account };
	} catch (err) {
		console.error("[identity] could not read the account's standing:", err);
		return { standing: "unknown", account: null };
	}
}

export const ACCOUNT_DEACTIVATED = "account_deactivated";
export const ACCOUNT_UNAVAILABLE = "account_unavailable";
export const ACCOUNT_ERASED = "account_erased";

export interface StandingRefusal {
	/** 401 for an erased account: the session is over, and a client that reads it signs out. */
	status: 401 | 403 | 503;
	code:
		| typeof ACCOUNT_DEACTIVATED
		| typeof ACCOUNT_UNAVAILABLE
		| typeof ACCOUNT_ERASED;
}

/** The refusal a standing earns, or `null` for one that may spend. Codes, not sentences. */
export function standingRefusal(
	standing: AccountStanding,
): StandingRefusal | null {
	if (standing === "active") return null;
	if (standing === "erased") return { status: 401, code: ACCOUNT_ERASED };
	return standing === "deactivated"
		? { status: 403, code: ACCOUNT_DEACTIVATED }
		: { status: 503, code: ACCOUNT_UNAVAILABLE };
}
