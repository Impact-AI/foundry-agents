import { afterEach, beforeEach, expect, test } from "bun:test";
import { type ProblemLine, problemChannel } from "@platform/observability";
import { getRedis } from "@platform/redis";
import { keys } from "../keys";
import { useLimits } from "../testing/limits";
import { REDIS_AVAILABLE } from "../testing/real-server";
import {
	freshSubject,
	meteredSuite,
	recorded,
	resetPool,
	secondsCredits,
	TOY_LIMITS,
} from "../testing/suite";
import { chargeSeconds, PREMIUM_DRAWS_SHARED_POOL } from "./seconds";
import { settleSession } from "./session";

/** The seconds charge against a real server: the subject's day, then the pool. */

const t = test.skipIf(!REDIS_AVAILABLE);
meteredSuite();

const problems: ProblemLine[] = [];
beforeEach(() => {
	problems.length = 0;
	problemChannel.setSink((line) => problems.push(line));
});
afterEach(() => problemChannel.setSink(null));

t(
	"the day refuses a third session, with no pool flag, and the bucket carries a TTL",
	async () => {
		const who = freshSubject("day");
		expect((await chargeSeconds(who, 10, "base")).ok).toBe(true);
		expect((await chargeSeconds(who, 10, "base")).ok).toBe(true);
		const third = await chargeSeconds(who, 10, "base");
		expect(third).toMatchObject({ ok: false, reason: "allowance" });
		if (third.ok || third.reason !== "allowance") return;
		expect(third.refusal).toEqual({
			code: "rate_limited",
			surface: "realtime",
			retryAfterSeconds: expect.any(Number),
		});
		const redis = await getRedis();
		expect(await redis?.pttl(keys.seconds(who))).toBeGreaterThan(0);
		// The refusal is reported on the problem channel as which bound, never as who.
		expect(problems.map((p) => p.attributes)).toEqual([
			{
				"problem.code": "metering.seconds.refused",
				"problem.surface": "realtime",
				"problem.bound": "allowance",
				"problem.retry_after_s": third.refusal.retryAfterSeconds,
			},
		]);
		expect(JSON.stringify(problems)).not.toContain(who);
	},
);

t(
	"the pool refuses when it is spent, the day is put back, and the flag says it was shared",
	async () => {
		await resetPool();
		useLimits({ ...TOY_LIMITS, global: { realtimeSecondsPerDay: 15 } });
		try {
			const first = freshSubject("pool-first");
			const second = freshSubject("pool-second");
			expect((await chargeSeconds(first, 10, "base")).ok).toBe(true);
			const refused = await chargeSeconds(second, 10, "base");
			expect(refused).toMatchObject({ ok: false, reason: "pool" });
			if (refused.ok || refused.reason !== "pool") return;
			expect(refused.refusal.pool).toBe(true);
			expect(refused.refusal.surface).toBe("realtime");
			expect(problems.at(-1)?.attributes["problem.bound"]).toBe("pool");
			// Charged, then refunded: the second account's whole day is still there.
			expect(await secondsCredits(second)).toBeCloseTo(25, 1);
			// A settle refunds the pool too, and then the same session fits.
			const id = await recorded({
				subject: first,
				callId: "rtc_pool",
				startedAt: Date.now(),
				debitedSeconds: 10,
				hardSeconds: 10,
				ownDay: true,
			});
			await settleSession(id, first, Date.now());
			expect((await chargeSeconds(second, 10, "base")).ok).toBe(true);
		} finally {
			useLimits(TOY_LIMITS);
			await resetPool();
		}
	},
);

t(
	"a premium session skips its own day entirely and still draws the shared pool",
	async () => {
		await resetPool();
		useLimits({ ...TOY_LIMITS, global: { realtimeSecondsPerDay: 100 } });
		try {
			const who = freshSubject("premium");
			const redis = await getRedis();
			// A base account gets two of these; premium gets five, and its own
			// bucket is never created — skipping a bound, not raising one.
			for (let i = 0; i < 5; i++) {
				expect((await chargeSeconds(who, 10, "premium")).ok).toBe(true);
			}
			expect(await redis?.exists(keys.seconds(who))).toBe(false);
			expect(Number(await redis?.hget(keys.pool(), "t"))).toBeCloseTo(50, 0);
			expect(PREMIUM_DRAWS_SHARED_POOL).toBe(true);
		} finally {
			useLimits(TOY_LIMITS);
			await resetPool();
		}
	},
);

t(
	"a premium session is refused by the pool exactly as anybody else, with nothing to put back",
	async () => {
		await resetPool();
		useLimits({ ...TOY_LIMITS, global: { realtimeSecondsPerDay: 15 } });
		try {
			const who = freshSubject("premium-spent");
			expect((await chargeSeconds(who, 10, "premium")).ok).toBe(true);
			expect(await chargeSeconds(who, 10, "premium")).toMatchObject({
				ok: false,
				reason: "pool",
			});
			const redis = await getRedis();
			expect(await redis?.exists(keys.seconds(who))).toBe(false);
		} finally {
			useLimits(TOY_LIMITS);
			await resetPool();
		}
	},
);

t(
	"a settle puts back only what the charge took: an unmetered session refunds the pool, never the account's own day",
	async () => {
		await resetPool();
		useLimits({ ...TOY_LIMITS, global: { realtimeSecondsPerDay: 100 } });
		try {
			const who = freshSubject("premium-refund");
			// Spent as base first, so the account's own day is part-drawn.
			expect(await chargeSeconds(who, 10, "base")).toEqual({
				ok: true,
				ownDay: true,
			});
			expect(await secondsCredits(who)).toBeCloseTo(15, 0);
			// Then a premium session, which draws the pool alone, ended at once.
			expect(await chargeSeconds(who, 10, "premium")).toEqual({
				ok: true,
				ownDay: false,
			});
			const startedAt = Date.now();
			const id = await recorded({
				subject: who,
				callId: "rtc_premium_refund",
				startedAt,
				debitedSeconds: 10,
				hardSeconds: 10,
				ownDay: false,
			});
			expect((await settleSession(id, who, startedAt))?.refunded).toBe(10);
			// The day is where the base session left it, not handed 10 seconds back.
			expect(await secondsCredits(who)).toBeCloseTo(15, 0);
			const redis = await getRedis();
			expect(Number(await redis?.hget(keys.pool(), "t"))).toBeCloseTo(90, 0);
		} finally {
			useLimits(TOY_LIMITS);
			await resetPool();
		}
	},
);

t(
	"an allowance below the seconds asked for refuses, and takes nothing a settlement could hand back",
	async () => {
		const who = freshSubject("short-day");
		// The day holds 25; a window of 30 does not fit.
		const verdict = await chargeSeconds(who, 30, "base");
		expect(verdict).toMatchObject({ ok: false, reason: "allowance" });
		const redis = await getRedis();
		expect(await redis?.exists(keys.seconds(who))).toBeFalsy();
		// A window that fits is still admitted, the day untouched by the refusal.
		expect((await chargeSeconds(who, 10, "base")).ok).toBe(true);
		expect((await chargeSeconds(who, 10, "base")).ok).toBe(true);
	},
);
