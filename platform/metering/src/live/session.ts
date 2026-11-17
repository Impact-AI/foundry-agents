import type { Tier } from "@platform/identity/claims";
import { getRedis } from "@platform/redis";
import { isKeyPart, keys } from "../keys";
import { getLimits } from "../limits/document";
import { reportUnavailable } from "../report";
import type { UsageSubject } from "../subject";
import {
	endReasonFor,
	type LiveSessionRecord,
	parseRecord,
	RECORD_FIELDS,
	readEndedNote,
	refundFor,
	renewalGrant,
	type SessionEndReason,
} from "./record";
import { CLAIM_ONE, RECORD, RENEW } from "./scripts";
import { chargeSeconds, refundSeconds } from "./seconds";

/**
 * A live session on the books: recorded under the subject's lock after the
 * handshake, renewed on evidence a person is there, settled by the browser's
 * end or the sweeper's deadline. Nothing the browser sends decides money —
 * the handle is the ledger's opaque id, the record carries the subject it was minted
 * for, and the seconds are charged on this side — so one account cannot end,
 * renew or refund another's session: unknown, someone else's and already
 * settled are one answer, so the id space cannot be probed.
 *
 * The record fails closed, for everyone. A session that cannot be written
 * down has no deadline, no sweeper and no early refund — the one open-ended
 * cost here — so the caller hangs it up rather than runs it.
 */

/**
 * How long a record outlives its hard ceiling, so a sweeper that was down
 * still finds what it missed and a server that never sees one does not fill
 * up. The lock outlives the ceiling by a minute only: a lost end and a dead
 * sweeper together should cost the subject a minute past the cutoff, not an
 * hour of being refused voice.
 */
const RECORD_GRACE_SECONDS = 3600;
const LOCK_GRACE_SECONDS = 60;

/** How long the sweeper's note outlives the cutoff: generous for a throttled tab's late beacon, short enough that nothing piles up. */
export const ENDED_NOTE_TTL_SECONDS = 600;

export type RecordOutcome =
	| { ok: true; id: string }
	| { ok: false; reason: "live" | "unavailable" };

/**
 * Write a session down. `live` is the lock refusing — the subject already has
 * one on the books — and `unavailable` is Redis not answering; both leave
 * the caller holding an open call to hang up. Both TTLs are sized off the
 * hard ceiling, so a renewal never has to extend them.
 */
export async function recordSession(input: {
	/**
	 * The handle to record it under, when the caller minted one before the
	 * session opened (a session named to the provider by the caller's own id); a new
	 * one otherwise. A UUID, as every handle here is.
	 */
	id?: string;
	subject: UsageSubject;
	callId: string;
	startedAt: number;
	/** The first idle window, in whole seconds — what was charged upfront. */
	debitedSeconds: number;
	/** The absolute ceiling in whole seconds from `startedAt`; never less than the debit. */
	hardSeconds: number;
	/** Whether the upfront charge drew on the subject's own day, as `chargeSeconds` answered. */
	ownDay: boolean;
}): Promise<RecordOutcome> {
	const redis = await getRedis();
	if (!redis) return { ok: false, reason: "unavailable" };
	const id = input.id ?? crypto.randomUUID();
	if (!isKeyPart(id)) throw new RangeError(`not a session handle: ${id}`);
	const deadlineAt = input.startedAt + input.debitedSeconds * 1000;
	const hardSeconds = Math.max(input.hardSeconds, input.debitedSeconds);
	const hardDeadlineAt = input.startedAt + hardSeconds * 1000;
	try {
		const recorded: unknown = await redis.send("EVAL", [
			RECORD,
			"3",
			keys.session(id),
			keys.deadlines(),
			keys.lock(input.subject),
			id,
			input.subject,
			input.callId,
			String(input.startedAt),
			String(input.debitedSeconds),
			String(deadlineAt),
			String(hardSeconds + RECORD_GRACE_SECONDS),
			String(hardSeconds + LOCK_GRACE_SECONDS),
			String(hardDeadlineAt),
			endReasonFor(deadlineAt, hardDeadlineAt),
			input.ownDay ? "1" : "0",
		]);
		return Number(recorded) === 1
			? { ok: true, id }
			: { ok: false, reason: "live" };
	} catch (err) {
		reportUnavailable(err);
		return { ok: false, reason: "unavailable" };
	}
}

export type RenewOutcome =
	| { ok: true; deadlineAt: number; boughtSeconds: number }
	| { ok: false; reason: "refused"; retryAfterSeconds: number }
	| { ok: false; reason: "gone" };

/**
 * Push a live session's deadline back to `now + idleSeconds`, buying the
 * seconds that takes. Called on evidence a person is still there — which
 * events count is the browser's contract, this end only checks the subject.
 * `boughtSeconds: 0` is the ordinary answer for a session renewed a moment
 * ago and the only one at the ceiling. A refused charge does not end the
 * session: it keeps the window it paid for, and the record remembers why so
 * the cutoff can say "allowance" rather than "silence". Nothing is charged
 * before the guard can be checked, and nothing kept if it fails.
 */
export async function renewSession(
	id: string,
	subject: UsageSubject,
	tier: Tier,
	now = Date.now(),
): Promise<RenewOutcome> {
	const redis = await getRedis();
	if (!redis || !isKeyPart(id)) return { ok: false, reason: "gone" };
	let record: LiveSessionRecord | null;
	try {
		const values: unknown = await redis.send("HMGET", [
			keys.session(id),
			...RECORD_FIELDS,
		]);
		record = parseRecord(
			id,
			Array.isArray(values)
				? RECORD_FIELDS.flatMap((f, i) => [f, values[i]])
				: null,
		);
	} catch (err) {
		reportUnavailable(err);
		return { ok: false, reason: "gone" };
	}
	if (!record || record.subject !== subject)
		return { ok: false, reason: "gone" };
	const bought = renewalGrant(
		record,
		now,
		(await getLimits()).realtime.idleSeconds,
	);
	if (bought === 0) {
		return { ok: true, deadlineAt: record.deadlineAt, boughtSeconds: 0 };
	}
	const wanted = record.deadlineAt + bought * 1000;
	const verdict = await chargeSeconds(subject, bought, tier, "renewal");
	if (!verdict.ok) {
		// Best effort: a failed note costs the cutoff its wording, never its correctness.
		await applyRenewal(
			id,
			subject,
			record.deadlineAt,
			record.deadlineAt,
			0,
			"allowance",
			record.ownDay,
		);
		const retryAfterSeconds =
			verdict.reason === "unavailable"
				? verdict.retryAfterSeconds
				: verdict.refusal.retryAfterSeconds;
		return { ok: false, reason: "refused", retryAfterSeconds };
	}
	const applied = await applyRenewal(
		id,
		subject,
		record.deadlineAt,
		wanted,
		bought,
		endReasonFor(wanted, record.hardDeadlineAt),
		verdict.ownDay,
	);
	if (!applied) {
		// The record moved under us or went away: these seconds bought nothing.
		await refundSeconds(subject, bought, verdict.ownDay);
		return { ok: false, reason: "gone" };
	}
	return { ok: true, deadlineAt: wanted, boughtSeconds: bought };
}

async function applyRenewal(
	id: string,
	subject: UsageSubject,
	from: number,
	to: number,
	bought: number,
	reason: SessionEndReason,
	ownDay: boolean,
): Promise<boolean> {
	const redis = await getRedis();
	if (!redis) return false;
	try {
		const applied: unknown = await redis.send("EVAL", [
			RENEW,
			"2",
			keys.session(id),
			keys.deadlines(),
			id,
			subject,
			String(from),
			String(to),
			String(bought),
			reason,
			ownDay ? "1" : "0",
		]);
		return Number(applied) === 1;
	} catch (err) {
		reportUnavailable(err);
		return false;
	}
}

export interface Settlement {
	record: LiveSessionRecord;
	usedSeconds: number;
	refunded: number;
}

/**
 * End a session the browser reported, if it is `subject`'s, and refund what
 * it did not use. Null when there is no such session for this subject. Only
 * the ledger is settled: the peer connection is the browser's, and it has
 * already closed it.
 */
export async function settleSession(
	id: string,
	subject: UsageSubject,
	endedAt = Date.now(),
): Promise<Settlement | null> {
	const redis = await getRedis();
	if (!redis || !isKeyPart(id)) return null;
	let fields: unknown;
	try {
		fields = await redis.send("EVAL", [
			CLAIM_ONE,
			"3",
			keys.session(id),
			keys.deadlines(),
			keys.lockPrefix(),
			subject,
			id,
		]);
	} catch (err) {
		reportUnavailable(err);
		return null;
	}
	const record = parseRecord(id, fields);
	return record ? settle(record, endedAt) : null;
}

/** Refund the unused part of a claimed record. One place, because there is one claim. */
export async function settle(
	record: LiveSessionRecord,
	endedAt: number,
): Promise<Settlement> {
	const { usedSeconds, refund } = refundFor(record, endedAt);
	if (refund > 0) await refundSeconds(record.subject, refund, record.ownDay);
	return { record, usedSeconds, refunded: refund };
}

export type EndOutcome =
	| { ended: "client"; settlement: Settlement }
	| { ended: SessionEndReason }
	| null;

/**
 * How a session the browser is reporting over actually ended, settling it if
 * it is still open: `client` when this call settled it, the sweeper's reason
 * when it already had, null for no such session of this subject's. The note
 * is read after the claim, never instead of it, so it only ever explains an
 * absence.
 */
export async function endSession(
	id: string,
	subject: UsageSubject,
	endedAt = Date.now(),
): Promise<EndOutcome> {
	const settlement = await settleSession(id, subject, endedAt);
	if (settlement) return { ended: "client", settlement };
	const redis = await getRedis();
	if (!redis || !isKeyPart(id)) return null;
	try {
		return readEndedNote(await redis.get(keys.ended(id)), subject);
	} catch (err) {
		reportUnavailable(err);
		return null;
	}
}
