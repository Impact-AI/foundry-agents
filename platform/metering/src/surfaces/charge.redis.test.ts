import { afterEach, beforeEach, expect, test } from "bun:test";
import { type ProblemLine, problemChannel } from "@platform/observability";
import { getRedis } from "@platform/redis";
import { keys } from "../keys";
import { REDIS_AVAILABLE } from "../testing/real-server";
import { freshSubject, meteredSuite } from "../testing/suite";
import { meterCall } from "./charge";

/**
 * The gate around the bucket: the allowance that comes from the document,
 * the order of the two bounds, and the key a bucket is under, which is the
 * security-relevant one.
 */

const t = test.skipIf(!REDIS_AVAILABLE);
meteredSuite({
	chat: { perDay: 2 },
	tts: { perDay: 5, burst: 1, refillPerMinute: 1 },
	realtime: { burst: 30, refillPerMinute: 1, mintCost: 10 },
});

const problems: ProblemLine[] = [];
beforeEach(() => {
	problems.length = 0;
	problemChannel.setSink((line) => problems.push(line));
});
afterEach(() => problemChannel.setSink(null));

t(
	"a day-only surface admits its allowance and refuses the next call with the surface named",
	async () => {
		const who = freshSubject("chat");
		expect(await meterCall(who, "chat", "base")).toEqual({ ok: true });
		expect(await meterCall(who, "chat", "base")).toEqual({ ok: true });
		const third = await meterCall(who, "chat", "base");
		expect(third.ok).toBe(false);
		if (third.ok) return;
		expect(third.refusal).toEqual({
			code: "rate_limited",
			surface: "chat",
			retryAfterSeconds: expect.any(Number),
		});
		expect(third.refusal.retryAfterSeconds).toBeGreaterThanOrEqual(1);
		// Reported as which surface and which bound, never as who.
		expect(problems.map((p) => p.attributes)).toEqual([
			{
				"problem.code": "metering.call.rate_limited",
				"problem.surface": "chat",
				"problem.bound": "day",
				"problem.retry_after_s": third.refusal.retryAfterSeconds,
			},
		]);
		expect(JSON.stringify(problems)).not.toContain(who);
		const redis = await getRedis();
		expect(await redis?.exists(keys.day(who, "chat"))).toBe(true);
		expect(await redis?.exists(keys.burst(who, "chat"))).toBe(false);
	},
);

t(
	"burst comes before the day, so a refused burst does not also cost a credit of the day",
	async () => {
		const who = freshSubject("tts");
		expect(await meterCall(who, "tts", "base")).toEqual({ ok: true });
		expect((await meterCall(who, "tts", "base")).ok).toBe(false);
		expect(problems.at(-1)?.attributes["problem.bound"]).toBe("burst");
		const redis = await getRedis();
		expect(Number(await redis?.hget(keys.day(who, "tts"), "t"))).toBeCloseTo(
			4,
			1,
		);
	},
);

t(
	"a mint costs the realtime bucket its mint price; a renewal costs one",
	async () => {
		const who = freshSubject("mint");
		// Two mints of a bucket of thirty leave ten: exactly one more mint.
		expect(await meterCall(who, "realtime", "base")).toEqual({ ok: true });
		expect(await meterCall(who, "realtime", "base")).toEqual({ ok: true });
		// A renewal of an open session is priced at one, not ten — and that one
		// credit is what makes the third mint no longer fit.
		expect(await meterCall(who, "realtime", "base", { burstCost: 1 })).toEqual({
			ok: true,
		});
		const redis = await getRedis();
		expect(
			Number(await redis?.hget(keys.burst(who, "realtime"), "t")),
		).toBeCloseTo(9, 0);
		expect((await meterCall(who, "realtime", "base")).ok).toBe(false);
		// Realtime is seconds, not calls: there is no day bucket for it.
		expect(await redis?.exists(keys.day(who, "realtime"))).toBe(false);
	},
);

t(
	"a premium account draws no bucket on any surface: the keys never come to exist",
	async () => {
		const who = freshSubject("premium");
		const redis = await getRedis();
		for (const surface of ["chat", "tts", "realtime"] as const) {
			for (let i = 0; i < 4; i++) {
				expect(await meterCall(who, surface, "premium")).toEqual({ ok: true });
			}
			expect(await redis?.exists(keys.day(who, surface))).toBe(false);
			expect(await redis?.exists(keys.burst(who, surface))).toBe(false);
		}
	},
);

t(
	"two subjects are two budgets, and the key is the subject's own",
	async () => {
		const first = freshSubject("one");
		const second = freshSubject("two");
		expect(await meterCall(first, "chat", "base")).toEqual({ ok: true });
		expect(await meterCall(first, "chat", "base")).toEqual({ ok: true });
		expect((await meterCall(first, "chat", "base")).ok).toBe(false);
		expect(await meterCall(second, "chat", "base")).toEqual({ ok: true });
		expect(keys.day(first, "chat")).toContain(`{${first}}`);
	},
);
