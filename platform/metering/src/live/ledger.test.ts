import { afterAll, afterEach, beforeAll, expect, spyOn, test } from "bun:test";
import { closeRedis } from "@platform/redis";
import {
	type FakeRedisServer,
	startFakeRedisServer,
} from "@platform/redis/testing";
import { scopedEnv } from "@platform/test-support";
import { UNAVAILABLE_RETRY_SECONDS } from "../credits/bucket";
import { DEFAULT_LIMITS } from "../limits/defaults";
import { type UsageSubject, usageSubject } from "../subject";
import { useDefaultLimits } from "../testing/limits";
import { sessionBounds } from "./bounds";
import { chargeSeconds, refundSeconds } from "./seconds";
import {
	endSession,
	recordSession,
	renewSession,
	settleSession,
} from "./session";
import { isSubjectLive, liveCapacity, liveSessionCount } from "./slots";
import { startSweeper, sweepDueSessions } from "./sweeper";

/**
 * The ledger without a Redis worth the name. The charge fails open like the
 * bucket, but a session that cannot be written down does not run, so the
 * handshake is told so before anything is minted.
 */

const who = usageSubject("account-1") as UsageSubject;
const quiet: ReturnType<typeof spyOn>[] = [];
let restore: (() => void) | undefined;
let server: FakeRedisServer | undefined;

beforeAll(() => {
	useDefaultLimits();
	quiet.push(spyOn(console, "error").mockImplementation(() => {}));
	quiet.push(spyOn(console, "warn").mockImplementation(() => {}));
});

afterAll(() => {
	for (const spy of quiet) spy.mockRestore();
});

afterEach(async () => {
	await closeRedis();
	server?.stop();
	server = undefined;
	restore?.();
	restore = undefined;
});

test("a handshake with no Redis is refused as unavailable before anything is minted, with a short wait", async () => {
	restore = scopedEnv({ REDIS_URL: undefined });
	expect(await chargeSeconds(who, 120, "base")).toEqual({
		ok: false,
		reason: "unavailable",
		retryAfterSeconds: UNAVAILABLE_RETRY_SECONDS,
	});
	expect(await chargeSeconds(who, 120, "premium")).toMatchObject({
		reason: "unavailable",
	});
});

test("a renewal has no record to write, so its charge fails open like the bucket", async () => {
	restore = scopedEnv({ REDIS_URL: undefined });
	expect(await chargeSeconds(who, 10, "base", "renewal")).toEqual({
		ok: true,
		ownDay: true,
	});
	await refundSeconds(who, 10, true);
});

test("a Redis that is up but silent is the same refusal, promptly", async () => {
	server = startFakeRedisServer();
	restore = scopedEnv({
		REDIS_URL: server.url,
		REDIS_CONNECT_TIMEOUT_MS: "300",
		REDIS_COMMAND_TIMEOUT_MS: "100",
		REDIS_RETRY_COOLDOWN_MS: "0",
	});
	server.behave("mute");
	const started = Date.now();
	expect(await chargeSeconds(who, 120, "base")).toMatchObject({
		ok: false,
		reason: "unavailable",
	});
	expect(Date.now() - started).toBeLessThan(1_000);
	expect(server.verbs()).toContain("PING");
	expect(server.verbs()).not.toContain("EVAL");
});

test("the record fails closed, and every read admits or finds nothing", async () => {
	restore = scopedEnv({ REDIS_URL: undefined });
	expect(
		await recordSession({
			subject: who,
			callId: "rtc_1",
			startedAt: Date.now(),
			debitedSeconds: 10,
			hardSeconds: 10,
			ownDay: true,
		}),
	).toEqual({ ok: false, reason: "unavailable" });
	expect(await isSubjectLive(who)).toBe(false);
	expect(await liveSessionCount()).toBeNull();
	expect(await liveCapacity()).toEqual({
		full: false,
		live: null,
		capacity: DEFAULT_LIMITS.realtime.concurrentSessions,
	});
	expect(await renewSession("id", who, "base")).toEqual({
		ok: false,
		reason: "gone",
	});
	expect(await settleSession("id", who)).toBeNull();
	expect(await endSession("id", who)).toBeNull();
	expect(await sweepDueSessions(async () => ({ status: 200 }))).toEqual([]);
	// Nothing to sweep, so nothing starts; the stop is a no-op.
	expect(() =>
		startSweeper({ hangup: async () => ({ status: 200 }) })(),
	).not.toThrow();
});

test("a session's bounds follow the tier's ceiling, and the window never exceeds it", () => {
	expect(sessionBounds(DEFAULT_LIMITS, "base")).toEqual({
		maxSessionSeconds: DEFAULT_LIMITS.realtime.maxSessionSeconds,
		idleSeconds: DEFAULT_LIMITS.realtime.idleSeconds,
	});
	expect(sessionBounds(DEFAULT_LIMITS, "premium").maxSessionSeconds).toBe(
		DEFAULT_LIMITS.premium.maxSessionSeconds,
	);
	const tight = {
		...DEFAULT_LIMITS,
		realtime: { ...DEFAULT_LIMITS.realtime, maxSessionSeconds: 30 },
	};
	expect(sessionBounds(tight, "base")).toEqual({
		maxSessionSeconds: 30,
		idleSeconds: 30,
	});
});
