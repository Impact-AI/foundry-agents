import { afterAll, afterEach, expect, spyOn, test } from "bun:test";
import { useDefaultLimits, useLimits } from "../testing/limits";
import { DEFAULT_LIMITS } from "./defaults";
import {
	cachedLimits,
	configureLimits,
	getLimits,
	limitsFromStored,
} from "./document";

const quiet: ReturnType<typeof spyOn>[] = [];

afterEach(() => {
	for (const spy of quiet.splice(0)) spy.mockRestore();
});

afterAll(() => {
	useDefaultLimits();
});

test("a process that has never read the store knows every limit, and it is the compiled one", () => {
	useDefaultLimits();
	expect(cachedLimits()).toEqual(DEFAULT_LIMITS);
	expect(cachedLimits().chat.perDay).toBeGreaterThan(0);
});

test("a stored document is merged over the defaults, and reaches the synchronous read", async () => {
	useLimits({ chat: { perDay: 3 }, realtime: { idleSeconds: 30 } });
	expect(cachedLimits().chat.perDay).toBe(DEFAULT_LIMITS.chat.perDay);
	const limits = await getLimits();
	expect(limits.chat.perDay).toBe(3);
	expect(limits.realtime.idleSeconds).toBe(30);
	expect(limits.realtime.maxSessionSeconds).toBe(
		DEFAULT_LIMITS.realtime.maxSessionSeconds,
	);
	expect(cachedLimits()).toEqual(limits);
});

test("a store that cannot be read serves the defaults, never nothing", async () => {
	quiet.push(spyOn(console, "warn").mockImplementation(() => {}));
	configureLimits({
		read: async () => {
			throw new Error("Forbidden");
		},
	});
	expect(await getLimits()).toEqual(DEFAULT_LIMITS);
	expect(cachedLimits()).toEqual(DEFAULT_LIMITS);
});

test("no stored value can make an account unmetered, and what was ignored is said once", async () => {
	const error = spyOn(console, "error").mockImplementation(() => {});
	quiet.push(error);
	useLimits({
		chat: { perDay: 0 },
		tts: { perDay: -1 },
		stt: { perDay: null },
		toolSearch: { burst: "unlimited" },
		media: { perDay: Number.POSITIVE_INFINITY },
		transcript: { perDay: undefined },
		premium: { unlimited: true, maxSessionSeconds: 0 },
	});
	const limits = await getLimits();
	expect(limits).toEqual(DEFAULT_LIMITS);
	expect(error).toHaveBeenCalledTimes(1);
	const line = String(error.mock.calls[0]?.[0]);
	expect(line).toContain("chat.perDay");
	expect(line).toContain("premium.maxSessionSeconds");
	expect(line).toContain("toolSearch.burst");
	expect(line).not.toContain("transcript.perDay");
});

test("limitsFromStored is the parser the key runs: pure, and the same answer", () => {
	quiet.push(spyOn(console, "error").mockImplementation(() => {}));
	expect(limitsFromStored(null)).toEqual(DEFAULT_LIMITS);
	expect(
		limitsFromStored({ global: { realtimeSecondsPerDay: 10 } }).global,
	).toEqual({ realtimeSecondsPerDay: 10 });
	expect(limitsFromStored({ global: { realtimeSecondsPerDay: 0 } })).toEqual(
		DEFAULT_LIMITS,
	);
});

test("seconds and sessions are whole: a fraction would reach Redis as an EX or HINCRBY it refuses", () => {
	const error = spyOn(console, "error").mockImplementation(() => {});
	quiet.push(error);
	const limits = limitsFromStored({
		realtime: {
			idleSeconds: 90.5,
			maxSessionSeconds: 1800.5,
			secondsPerDay: 600.25,
			concurrentSessions: 2.5,
			refillPerMinute: 0.5,
		},
		premium: { maxSessionSeconds: 3600.1 },
		global: { realtimeSecondsPerDay: 100.9 },
	});
	expect(limits).toEqual({
		...DEFAULT_LIMITS,
		// A credit rate may be a fraction; only the whole-number leaves fell back.
		realtime: { ...DEFAULT_LIMITS.realtime, refillPerMinute: 0.5 },
	});
	const line = String(error.mock.calls[0]?.[0]);
	for (const path of [
		"realtime.idleSeconds",
		"realtime.maxSessionSeconds",
		"realtime.secondsPerDay",
		"realtime.concurrentSessions",
		"premium.maxSessionSeconds",
		"global.realtimeSecondsPerDay",
	])
		expect(line).toContain(path);
	expect(line).not.toContain("refillPerMinute");
});

test("a voice allowance smaller than one idle window is said, since it admits no session", () => {
	const error = spyOn(console, "error").mockImplementation(() => {});
	quiet.push(error);
	const limits = limitsFromStored({
		realtime: { idleSeconds: 120, secondsPerDay: 60 },
	});
	expect(limits.realtime.secondsPerDay).toBe(60);
	const line = error.mock.calls.map((call) => String(call[0])).join("\n");
	expect(line).toContain("realtime.secondsPerDay");
	expect(line).toContain("realtime.idleSeconds (120)");
	expect(line).not.toContain("global.realtimeSecondsPerDay");
});
