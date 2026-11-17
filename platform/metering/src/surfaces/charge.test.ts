import { afterAll, afterEach, beforeAll, expect, spyOn, test } from "bun:test";
import { closeRedis } from "@platform/redis";
import {
	type FakeRedisServer,
	startFakeRedisServer,
} from "@platform/redis/testing";
import { scopedEnv } from "@platform/test-support";
import { type UsageSubject, usageSubject } from "../subject";
import { useDefaultLimits } from "../testing/limits";
import { meterCall } from "./charge";
import { rateLimitedResponse, rateLimitRefusal } from "./refusal";

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

const who = usageSubject("account-1") as UsageSubject;

test("a subject is minted from a verified account id, and from nothing a key part cannot carry", () => {
	expect(usageSubject("  abc  ")).toBe("abc" as UsageSubject);
	expect(usageSubject("")).toBeNull();
	expect(usageSubject("   ")).toBeNull();
	expect(usageSubject(null)).toBeNull();
	expect(usageSubject(undefined)).toBeNull();
	expect(usageSubject("{tag}")).toBeNull();
});

test("a premium account is admitted without a single command being sent", async () => {
	server = startFakeRedisServer();
	restore = scopedEnv({ REDIS_URL: server.url });
	for (const surface of ["chat", "tts", "realtime", "media"] as const) {
		expect(await meterCall(who, surface, "premium")).toEqual({ ok: true });
	}
	expect(server.verbs()).toEqual([]);
	expect(server.dials()).toBe(0);
});

test("a base account without Redis is admitted: a cost bound, not an authorization control", async () => {
	restore = scopedEnv({ REDIS_URL: undefined });
	expect(await meterCall(who, "chat", "base")).toEqual({ ok: true });
	expect(await meterCall(who, "tts", "base")).toEqual({ ok: true });
});

test("the refusal is a code with a wait rounded up to a whole second, never under one", () => {
	expect(rateLimitRefusal("chat", 0.2)).toEqual({
		code: "rate_limited",
		surface: "chat",
		retryAfterSeconds: 1,
	});
	expect(rateLimitRefusal("realtime", 12.1, { pool: true })).toEqual({
		code: "rate_limited",
		surface: "realtime",
		retryAfterSeconds: 13,
		pool: true,
	});
	expect(rateLimitRefusal("tts", 0, { pool: false })).not.toHaveProperty(
		"pool",
	);
});

test("the 429 carries the refusal as its body, the wait as a header, and is never cached", async () => {
	const res = rateLimitedResponse(rateLimitRefusal("stt", 42));
	expect(res.status).toBe(429);
	expect(res.headers.get("Retry-After")).toBe("42");
	expect(res.headers.get("Cache-Control")).toBe("no-store");
	expect(await res.json()).toEqual({
		code: "rate_limited",
		surface: "stt",
		retryAfterSeconds: 42,
	});
});
