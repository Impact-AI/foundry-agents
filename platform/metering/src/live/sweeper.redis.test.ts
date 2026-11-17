import { expect, spyOn, test } from "bun:test";
import { getRedis } from "@platform/redis";
import { keys } from "../keys";
import { REDIS_AVAILABLE } from "../testing/real-server";
import {
	freshSubject,
	hangupRecorder,
	meteredSuite,
	recorded,
} from "../testing/suite";
import { chargeSeconds } from "./seconds";
import { endSession, settleSession } from "./session";
import { isSubjectLive } from "./slots";
import { sweepDueSessions } from "./sweeper";

/**
 * The cutoff against a real server. The provider is a stub that records
 * which call it was asked to hang up; what the sweeper proves is that it
 * asked for exactly the right one, once.
 */

const t = test.skipIf(!REDIS_AVAILABLE);
meteredSuite();

t(
	"the sweeper hangs up and settles a due session once, skips one the browser ended, leaves a live one",
	async () => {
		const { hangups, hangup } = hangupRecorder();
		const who = freshSubject("sweep");
		const other = freshSubject("sweep-ended");
		const third = freshSubject("sweep-live");
		for (const s of [who, other, third]) {
			expect((await chargeSeconds(s, 10, "base")).ok).toBe(true);
		}
		const now = Date.now();
		const due = await recorded({
			subject: who,
			callId: "rtc_due",
			startedAt: now - 11_000,
			debitedSeconds: 10,
			hardSeconds: 10,
			ownDay: true,
		});
		const ended = await recorded({
			subject: other,
			callId: "rtc_ended",
			startedAt: now - 11_000,
			debitedSeconds: 10,
			hardSeconds: 10,
			ownDay: true,
		});
		const live = await recorded({
			subject: third,
			callId: "rtc_live",
			startedAt: now - 2_000,
			debitedSeconds: 10,
			hardSeconds: 10,
			ownDay: true,
		});
		expect(await settleSession(ended, other, now)).not.toBeNull();
		expect(await isSubjectLive(who)).toBe(true);

		const settled = await sweepDueSessions(hangup);
		expect(settled.map((s) => s.record.callId)).toEqual(["rtc_due"]);
		// Settled at its deadline: the whole window was used.
		expect(settled[0]?.refunded).toBe(0);
		expect(hangups).toEqual(["rtc_due"]);
		expect(await isSubjectLive(who)).toBe(false);
		expect(await isSubjectLive(third)).toBe(true);

		// A second sweep — a second replica — finds nothing to do.
		expect(await sweepDueSessions(hangup)).toEqual([]);
		expect(hangups).toHaveLength(1);
		const redis = await getRedis();
		expect(await redis?.zscore(keys.deadlines(), live)).toBe(now + 8_000);

		// The late beacon is told which cutoff it was, and only its own subject is.
		expect(await endSession(due, who, now)).toEqual({ ended: "length" });
		expect(await endSession(due, freshSubject("stranger"), now)).toBeNull();
		expect(await endSession(crypto.randomUUID(), who, now)).toBeNull();
		const ttl = (await redis?.ttl(keys.ended(due))) ?? 0;
		expect(ttl).toBeGreaterThan(0);
		expect(ttl).toBeLessThanOrEqual(600);
		await settleSession(live, third, now);
	},
);

t(
	"a deadline entry whose record is gone does not end the sweep before the session behind it",
	async () => {
		const { hangups, hangup } = hangupRecorder();
		const who = freshSubject("sweep-orphans");
		expect((await chargeSeconds(who, 10, "base")).ok).toBe(true);
		const now = Date.now();
		const redis = await getRedis();
		for (const n of [1, 2, 3]) {
			await redis?.send("ZADD", [
				keys.deadlines(),
				String(now - 60_000 - n),
				`orphan-${n}-${crypto.randomUUID()}`,
			]);
		}
		await recorded({
			subject: who,
			callId: "rtc_behind_orphans",
			startedAt: now - 11_000,
			debitedSeconds: 10,
			hardSeconds: 10,
			ownDay: true,
		});
		const settled = await sweepDueSessions(hangup);
		expect(settled.map((s) => s.record.callId)).toEqual(["rtc_behind_orphans"]);
		expect(hangups).toEqual(["rtc_behind_orphans"]);
		expect(await sweepDueSessions(hangup)).toEqual([]);
	},
);

t(
	"a hangup that throws still settles its session, and the next one in the batch",
	async () => {
		const error = spyOn(console, "error").mockImplementation(() => {});
		try {
			const first = freshSubject("sweep-throws");
			const second = freshSubject("sweep-after");
			const now = Date.now();
			for (const [subject, callId, age] of [
				[first, "rtc_throws", 12_000],
				[second, "rtc_after", 11_000],
			] as const) {
				expect((await chargeSeconds(subject, 10, "base")).ok).toBe(true);
				await recorded({
					subject,
					callId,
					startedAt: now - age,
					debitedSeconds: 10,
					hardSeconds: 10,
					ownDay: true,
				});
			}
			const asked: string[] = [];
			const settled = await sweepDueSessions(async (callId) => {
				asked.push(callId);
				if (callId === "rtc_throws") throw new Error("provider down");
				return { status: 200 };
			});
			expect(asked).toEqual(["rtc_throws", "rtc_after"]);
			expect(settled.map((s) => s.record.callId)).toEqual([
				"rtc_throws",
				"rtc_after",
			]);
			expect(await isSubjectLive(first)).toBe(false);
			expect(await isSubjectLive(second)).toBe(false);
		} finally {
			error.mockRestore();
		}
	},
);
