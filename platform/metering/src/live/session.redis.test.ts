import { expect, test } from "bun:test";
import { getRedis } from "@platform/redis";
import { keys } from "../keys";
import { useLimits } from "../testing/limits";
import { REDIS_AVAILABLE } from "../testing/real-server";
import {
	freshSubject,
	meteredSuite,
	recorded,
	secondsCredits,
	TOY_LIMITS,
} from "../testing/suite";
import { chargeSeconds } from "./seconds";
import {
	endSession,
	recordSession,
	renewSession,
	settleSession,
} from "./session";
import { isSubjectLive } from "./slots";
import { sweepDueSessions } from "./sweeper";

/**
 * One session's life on the books against a real server: recorded under the
 * lock, renewed, settled once, and what the browser is told afterwards.
 */

const t = test.skipIf(!REDIS_AVAILABLE);
meteredSuite();

const tenSeconds = (subject: ReturnType<typeof freshSubject>, callId: string) =>
	({
		subject,
		callId,
		startedAt: Date.now(),
		debitedSeconds: 10,
		hardSeconds: 10,
		ownDay: true,
	}) as const;

t("charge then settle refunds exactly debited minus used, once", async () => {
	const who = freshSubject("settle");
	expect((await chargeSeconds(who, 10, "base")).ok).toBe(true);
	expect(await secondsCredits(who)).toBeCloseTo(15, 1);
	const now = Date.now();
	const id = await recorded({
		...tenSeconds(who, "rtc_settle"),
		startedAt: now - 4_000,
	});
	const first = await settleSession(id, who, now);
	expect(first?.usedSeconds).toBe(4);
	expect(first?.refunded).toBe(6);
	expect(await secondsCredits(who)).toBeCloseTo(21, 1);
	// A replayed settlement finds nothing and moves nothing.
	expect(await settleSession(id, who, now)).toBeNull();
	expect(await secondsCredits(who)).toBeCloseTo(21, 1);
});

t(
	"a session that ran past its debit refunds nothing, not a negative amount",
	async () => {
		const who = freshSubject("overrun");
		expect((await chargeSeconds(who, 10, "base")).ok).toBe(true);
		const now = Date.now();
		const id = await recorded({
			...tenSeconds(who, "rtc_overrun"),
			startedAt: now - 60_000,
		});
		const settled = await settleSession(id, who, now);
		expect(settled?.usedSeconds).toBe(10);
		expect(settled?.refunded).toBe(0);
		expect(await secondsCredits(who)).toBeCloseTo(15, 1);
	},
);

t(
	"every key the record writes expires: the record, the lock and the deadline set",
	async () => {
		const who = freshSubject("ttl");
		const id = await recorded(tenSeconds(who, "rtc_ttl"));
		const redis = await getRedis();
		expect(await redis?.ttl(keys.session(id))).toBeGreaterThan(10);
		const lock = (await redis?.ttl(keys.lock(who))) ?? 0;
		// The lock outlives the ceiling by a minute, and no longer.
		expect(lock).toBeGreaterThan(10);
		expect(lock).toBeLessThanOrEqual(70);
		expect(await redis?.ttl(keys.deadlines())).toBeGreaterThan(10);
		await settleSession(id, who);
	},
);

t(
	"a second handshake while one is live is refused by the lock, atomically with the record",
	async () => {
		const who = freshSubject("twice");
		const now = Date.now();
		const first = await recorded(tenSeconds(who, "rtc_first"));
		expect(await isSubjectLive(who)).toBe(true);
		expect(await recordSession(tenSeconds(who, "rtc_second"))).toEqual({
			ok: false,
			reason: "live",
		});
		// The browser's end frees the subject in the same step as it settles.
		expect(await settleSession(first, who, now)).not.toBeNull();
		expect(await isSubjectLive(who)).toBe(false);
		const next = await recordSession(tenSeconds(who, "rtc_second"));
		expect(next.ok).toBe(true);
		if (next.ok) await settleSession(next.id, who, now);
	},
);

t(
	"a claim releases only the lock it owns: a stale settle leaves the next session's lock alone",
	async () => {
		const who = freshSubject("stale");
		const now = Date.now();
		const first = await recorded(tenSeconds(who, "rtc_first"));
		// The lock expires (a DEL stands in) and a newer session takes it.
		const redis = await getRedis();
		await redis?.del(keys.lock(who));
		const second = await recorded(tenSeconds(who, "rtc_second"));
		expect(await settleSession(first, who, now)).not.toBeNull();
		expect(await redis?.get(keys.lock(who))).toBe(second);
		expect(await settleSession(second, who, now)).not.toBeNull();
		expect(await isSubjectLive(who)).toBe(false);
	},
);

t(
	"a renewal walks the deadline and the debit together, and the ceiling stops both",
	async () => {
		useLimits({
			...TOY_LIMITS,
			realtime: {
				...TOY_LIMITS.realtime,
				maxSessionSeconds: 30,
				secondsPerDay: 100,
			},
		});
		try {
			const who = freshSubject("renewing");
			const other = freshSubject("stranger");
			expect((await chargeSeconds(who, 10, "base")).ok).toBe(true);
			const now = Date.now();
			const id = await recorded({
				subject: who,
				callId: "rtc_renewing",
				startedAt: now - 4_000,
				debitedSeconds: 10,
				hardSeconds: 30,
				ownDay: true,
			});
			const redis = await getRedis();
			const hard = now - 4_000 + 30_000;

			expect(await renewSession(id, who, "base", now)).toEqual({
				ok: true,
				deadlineAt: now + 10_000,
				boughtSeconds: 4,
			});
			expect(
				Number(await redis?.hget(keys.session(id), "debitedSeconds")),
			).toBe(14);
			// The sweeper's list moved with it, or the cutoff would come at the old
			// deadline whatever the record says.
			expect(await redis?.zscore(keys.deadlines(), id)).toBe(now + 10_000);
			// Renewing again at once buys nothing.
			expect(await renewSession(id, who, "base", now)).toEqual({
				ok: true,
				deadlineAt: now + 10_000,
				boughtSeconds: 0,
			});
			// Late in the session only what fits under the ceiling is sold.
			expect(await renewSession(id, who, "base", now + 20_000)).toEqual({
				ok: true,
				deadlineAt: hard,
				boughtSeconds: 16,
			});
			expect(await renewSession(id, who, "base", now + 60_000)).toEqual({
				ok: true,
				deadlineAt: hard,
				boughtSeconds: 0,
			});
			expect(await redis?.hget(keys.session(id), "endReason")).toBe("length");
			// Another subject's renewal is the same answer as no session at all.
			expect(await renewSession(id, other, "base", now)).toEqual({
				ok: false,
				reason: "gone",
			});
			expect(await renewSession(crypto.randomUUID(), who, "base", now)).toEqual(
				{
					ok: false,
					reason: "gone",
				},
			);
			// Settling refunds what the session did not reach — the point of buying
			// the extension in pieces.
			const settled = await settleSession(id, who, now - 4_000 + 12_000);
			expect(settled?.usedSeconds).toBe(12);
			expect(settled?.refunded).toBe(18);
		} finally {
			useLimits(TOY_LIMITS);
		}
	},
);

t(
	"a renewal the allowance refuses ends the session as the allowance, not as silence",
	async () => {
		useLimits({
			...TOY_LIMITS,
			realtime: {
				...TOY_LIMITS.realtime,
				maxSessionSeconds: 30,
				secondsPerDay: 10,
			},
		});
		try {
			const who = freshSubject("refused");
			expect((await chargeSeconds(who, 10, "base")).ok).toBe(true);
			const now = Date.now();
			// Already past its deadline: the sweeper takes it as soon as it looks.
			const id = await recorded({
				subject: who,
				callId: "rtc_refused",
				startedAt: now - 11_000,
				debitedSeconds: 10,
				hardSeconds: 30,
				ownDay: true,
			});
			const redis = await getRedis();
			const refused = await renewSession(id, who, "base", now);
			expect(refused).toMatchObject({ ok: false, reason: "refused" });
			// The deadline did not move and nothing more was charged; the record
			// remembers why so the cutoff can say the true thing.
			expect(await redis?.zscore(keys.deadlines(), id)).toBe(now - 1_000);
			expect(
				Number(await redis?.hget(keys.session(id), "debitedSeconds")),
			).toBe(10);
			expect(await redis?.hget(keys.session(id), "endReason")).toBe(
				"allowance",
			);
			await sweepDueSessions(async () => ({ status: 200 }));
			expect(await endSession(id, who, now)).toEqual({ ended: "allowance" });
		} finally {
			useLimits(TOY_LIMITS);
		}
	},
);

t(
	"the end names who ended a session: the client first, and never twice",
	async () => {
		const who = freshSubject("ending");
		const now = Date.now();
		const polite = await recorded({
			...tenSeconds(who, "rtc_polite"),
			startedAt: now - 3_000,
		});
		const first = await endSession(polite, who, now);
		expect(first).toMatchObject({ ended: "client" });
		expect(await endSession(polite, who, now)).toBeNull();
		expect(await endSession(polite, freshSubject("other"), now)).toBeNull();
	},
);

t(
	"an id no key can carry is nobody's session: gone, null, and never an error",
	async () => {
		const who = freshSubject("braces");
		for (const id of ["{tag}", ""]) {
			expect(await renewSession(id, who, "base")).toEqual({
				ok: false,
				reason: "gone",
			});
			expect(await settleSession(id, who)).toBeNull();
			expect(await endSession(id, who)).toBeNull();
		}
	},
);
