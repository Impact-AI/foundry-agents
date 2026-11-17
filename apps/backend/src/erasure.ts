import type { AgentHost } from "@platform/agent";
import {
	beginErase,
	finishErase,
	releaseErase,
	underLease,
} from "@platform/identity";

/** An erase of the same account is being swept by another request: this one has nothing to do but wait for it. */
export class EraseBusyError extends Error {
	constructor() {
		super("the account is being erased by another request");
		this.name = "EraseBusyError";
	}
}

/**
 * Forgetting a person, in one place and in three steps. The row is shut
 * first (`beginErase`): emptied of the person, and from that write no
 * session is admitted on the id, no sign-in makes an account of it and no
 * edit lands on it. Then what the agent holds under the account is swept —
 * threads and every message of them, what it remembers, every cached
 * copy — with nothing able to be made under the id meanwhile. Then the row
 * is finished (`finishErase`): a deactivated account's keeps its id and
 * the deactivation — erasure is a right over what is held, not a way back
 * in — and an active account's keeps its id and when it was erased, for as
 * long as a caller from before it could present itself. Either ends every
 * session that began before (`auth/standing`'s `refuseErasedSession`).
 *
 * One request sweeps at a time. A second erase of the same account while
 * the first sweeps is `EraseBusyError`: were both to sweep, the first to
 * finish would end the erase with the other still running, under an id a
 * sign-in could by then have made somebody's account. A sweep that fails
 * lets the erase go and throws, so whoever asks next — the person again,
 * or their next sign-in — sweeps again and finishes; every step is
 * idempotent.
 *
 * `session` is the one that asked. The row is shut only while it is that
 * session's own: an id erased and signed in under again since the session
 * began is somebody else's account, left untouched — no sweep, no write —
 * and `ErasedSessionError` is thrown. What a finished erase left is left
 * too. With no `session` there is nobody the row could belong to instead
 * (an open gate serves its one account), so the sweep runs whatever the
 * row is.
 */
export async function eraseAccount(
	host: AgentHost,
	accountId: string,
	session?: { signedInAt?: number },
): Promise<{ threads: number; account: boolean }> {
	const erase = await beginErase(accountId, session);
	if (erase.phase === "busy") throw new EraseBusyError();
	if (erase.phase === "finished" && session)
		return { threads: 0, account: false };
	const held = erase.phase === "begun" || erase.phase === "resumed";
	let threads: number;
	try {
		// Held while it sweeps: renewed, and asked before each step, so a
		// slow sweep is never taken over and one that was stops where it is.
		({ threads } = held
			? await underLease(accountId, erase.token, (stillHeld) =>
					host.eraseResource(accountId, { stillHeld }),
				)
			: await host.eraseResource(accountId));
	} catch (err) {
		if (held) await releaseErase(accountId, erase.token);
		throw err;
	}
	return {
		threads,
		account: held ? await finishErase(accountId, erase.token) : false,
	};
}
