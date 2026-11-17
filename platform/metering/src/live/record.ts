import { type UsageSubject, usageSubject } from "../subject";

/**
 * What the ledger writes down per live session, and the arithmetic over it.
 * Pure, so the decisions can be read and tested without a server.
 *
 * The invariant every settle depends on is
 *
 *     deadlineAt === startedAt + debitedSeconds * 1000
 *
 * which holds because every renewal buys exactly the whole seconds it moves
 * the deadline by, and moves it by nothing it did not buy.
 */

/**
 * Why a session the server ended, ended. The browser sees all three as a
 * peer connection failing, which is also what a dropped network looks like,
 * so the ledger says which: nobody spoke (`idle`), the absolute ceiling
 * (`length`), or a renewal the allowance refused (`allowance`) — the only one
 * of the three that is about a quota.
 */
export type SessionEndReason = "idle" | "length" | "allowance";

export interface LiveSessionRecord {
	/** The ledger's opaque handle, what the browser is given. */
	id: string;
	subject: UsageSubject;
	/** The provider's handle. Never sent to the browser. */
	callId: string;
	/** Epoch ms, by the clock of the replica that recorded the session. */
	startedAt: number;
	/** Everything charged so far: the first window plus every renewal bought. */
	debitedSeconds: number;
	/** Epoch ms at which the sweeper hangs the session up; renewable up to `hardDeadlineAt`. */
	deadlineAt: number;
	/** Epoch ms no renewal may push the deadline past, fixed at the mint. */
	hardDeadlineAt: number;
	/** Why it will end if nothing ends it first, kept current so the sweeper's note can carry it. */
	endReason: SessionEndReason;
	/**
	 * Whether the latest charge — the window a settle refunds from — drew on
	 * the subject's own day, so the refund returns only what was taken.
	 */
	ownDay: boolean;
}

/** The hash's fields, in the order the scripts and the reads name them. */
export const RECORD_FIELDS = [
	"subject",
	"callId",
	"startedAt",
	"debitedSeconds",
	"deadlineAt",
	"hardDeadlineAt",
	"endReason",
	"ownDay",
] as const;

/** A record from a flat field list, as a script returns a hash. Null when it is not one. */
export function parseRecord(
	id: string,
	flat: unknown,
): LiveSessionRecord | null {
	if (!Array.isArray(flat)) return null;
	const map: Record<string, string> = {};
	for (let i = 0; i + 1 < flat.length; i += 2) {
		map[String(flat[i])] = String(flat[i + 1]);
	}
	const subject = usageSubject(map.subject);
	const startedAt = Number(map.startedAt);
	const debitedSeconds = Number(map.debitedSeconds);
	const deadlineAt = Number(map.deadlineAt);
	const hardDeadlineAt = Number(map.hardDeadlineAt);
	if (
		!subject ||
		!map.callId ||
		!isEndReason(map.endReason) ||
		(map.ownDay !== "1" && map.ownDay !== "0") ||
		![startedAt, debitedSeconds, deadlineAt, hardDeadlineAt].every(
			Number.isFinite,
		)
	) {
		return null;
	}
	return {
		id,
		subject,
		callId: map.callId,
		startedAt,
		debitedSeconds,
		deadlineAt,
		hardDeadlineAt,
		endReason: map.endReason,
		ownDay: map.ownDay === "1",
	};
}

export function isEndReason(value: unknown): value is SessionEndReason {
	return value === "idle" || value === "length" || value === "allowance";
}

/**
 * Which deadline reason a session with this pair would end for: `length`
 * once the deadline is as far as the ceiling allows, `idle` while there is
 * room to renew into. `allowance` is not a property of the deadline but the
 * memory of a refused renewal, and only a renewal writes it.
 */
export function endReasonFor(
	deadlineAt: number,
	hardDeadlineAt: number,
): Exclude<SessionEndReason, "allowance"> {
	return deadlineAt >= hardDeadlineAt ? "length" : "idle";
}

/**
 * The whole seconds a renewal at `now` has to buy: the gap between the
 * deadline the session has and the one a person still being there earns it,
 * clamped at the ceiling. Floored, so what is charged and what is granted
 * are one number and a renewal with less than a second in it buys nothing.
 */
export function renewalGrant(
	record: Pick<LiveSessionRecord, "deadlineAt" | "hardDeadlineAt">,
	now: number,
	idleSeconds: number,
): number {
	const wanted = Math.min(now + idleSeconds * 1000, record.hardDeadlineAt);
	return Math.max(0, Math.floor((wanted - record.deadlineAt) / 1000));
}

/**
 * The refund for a session that ran until `endedAt`. Used seconds are
 * rounded up, so the rounding error is the deployment's to bear; clamped into [0, debited], so an
 * end before the start or after the deadline refunds nothing odd.
 */
export function refundFor(
	record: Pick<LiveSessionRecord, "startedAt" | "debitedSeconds">,
	endedAt: number,
): { usedSeconds: number; refund: number } {
	const elapsed = Math.ceil(Math.max(0, endedAt - record.startedAt) / 1000);
	const usedSeconds = Math.min(elapsed, record.debitedSeconds);
	return { usedSeconds, refund: record.debitedSeconds - usedSeconds };
}

/**
 * The sweeper's note read back: `{reason}:{subject}`, and null unless the
 * subject is the one asking — another account's cutoff is not this one's to
 * learn about. Split on the first colon only; a reason never contains one.
 */
export function readEndedNote(
	note: string | null,
	subject: UsageSubject,
): { ended: SessionEndReason } | null {
	if (!note) return null;
	const cut = note.indexOf(":");
	if (cut < 0) return null;
	const reason = note.slice(0, cut);
	if (!isEndReason(reason) || note.slice(cut + 1) !== subject) return null;
	return { ended: reason };
}
