import {
	afterEach,
	beforeEach,
	expect,
	type Mock,
	spyOn,
	test,
} from "bun:test";
import { SHUTDOWN, type ShutdownBounds, shutDown } from "./shutdown";

let warn: Mock<typeof console.warn>;
let error: Mock<typeof console.error>;
beforeEach(() => {
	warn = spyOn(console, "warn").mockImplementation(() => {});
	error = spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => {
	warn.mockRestore();
	error.mockRestore();
});

function steps(drain: () => Promise<void>) {
	const ran: string[] = [];
	return {
		ran,
		steps: {
			drain,
			stop: () => void ran.push("host"),
			close: [
				() => {
					ran.push("redis");
					throw new Error("already closed");
				},
				async () => void ran.push("cosmos"),
			],
			flush: async () => void ran.push("telemetry"),
		},
	};
}

test("a drain that finishes is followed by the host's stop, every close, then the flush", async () => {
	const { ran, steps: all } = steps(async () => {});
	expect(await shutDown(all, { drainMs: 1000 })).toBe(true);
	expect(ran).toEqual(["host", "redis", "cosmos", "telemetry"]);
	expect(warn).not.toHaveBeenCalled();
	expect(error).toHaveBeenCalledTimes(1);
});

test("a drain still running at its deadline is left, and everything is stopped, closed and flushed all the same", async () => {
	const { ran, steps: all } = steps(() => new Promise<void>(() => {}));
	expect(await shutDown(all, { drainMs: 5 })).toBe(false);
	expect(ran).toEqual(["host", "redis", "cosmos", "telemetry"]);
	expect(warn).toHaveBeenCalledTimes(1);
});

test("a drain that fails does not stop the closes", async () => {
	const { ran, steps: all } = steps(async () => {
		throw new Error("a socket would not close");
	});
	expect(await shutDown(all, { drainMs: 1000 })).toBe(true);
	expect(ran).toEqual(["host", "redis", "cosmos", "telemetry"]);
});

/** A grace a hundredth the size of the template's, shared out the same way. */
const SCALED: ShutdownBounds = {
	graceMs: SHUTDOWN.graceMs / 100,
	drainMs: SHUTDOWN.drainMs / 100,
	stopMs: SHUTDOWN.stopMs / 100,
	closeMs: SHUTDOWN.closeMs / 100,
	flushMs: SHUTDOWN.flushMs / 100,
	exitMs: SHUTDOWN.exitMs / 100,
};

test("the parts of a shutdown add up to the platform's grace, the host's stop has what the host asks for, and the live sessions' defaults settle inside the drain", async () => {
	const { graceMs, drainMs, stopMs, closeMs, flushMs, exitMs } = SHUTDOWN;
	expect(graceMs).toBe(30_000);
	expect(drainMs + stopMs + closeMs + flushMs + exitMs).toBe(graceMs);
	// What a stop of the host waits for at the most: the turns it ends, beside its queues.
	expect(stopMs).toBeGreaterThan(5_000);
	const { DEFAULT_VOICE_SETTINGS } = await import("@platform/voice");
	const { drainGraceMs, settleWaitMs } = DEFAULT_VOICE_SETTINGS.live;
	// What the settings page tells an operator to keep the two within.
	expect(drainGraceMs + settleWaitMs).toBeLessThanOrEqual(drainMs - 5_000);
});

test("a drain that runs to its deadline still leaves the host's stop its whole share, with everything it needs still open, and the exit inside the grace", async () => {
	const started = Date.now();
	const at = () => Date.now() - started;
	const times: Record<string, number> = {};
	let open = true;
	let stoppedWhileOpen = false;
	await shutDown(
		{
			drain: () => new Promise<void>(() => {}),
			// As long as a host that still has turns to end may take.
			stop: async () => {
				times.stopBegan = at();
				await Bun.sleep(SCALED.stopMs - 10);
				stoppedWhileOpen = open;
				times.stopEnded = at();
			},
			close: [
				() => {
					open = false;
					times.closed = at();
				},
				() => new Promise<void>(() => {}),
			],
			flush: async () => {
				times.flushed = at();
			},
		},
		SCALED,
	);
	const took = at();
	// The stop ran to its end, and nothing was closed under it.
	expect(stoppedWhileOpen).toBe(true);
	expect(times.closed).toBeGreaterThanOrEqual(times.stopEnded ?? Infinity);
	expect(times.flushed).toBeGreaterThanOrEqual(times.closed ?? Infinity);
	// A close that hangs costs the others nothing, and the whole of it ends before the kill.
	expect(took).toBeLessThan(SCALED.graceMs);
	expect(warn).toHaveBeenCalledTimes(2);
});

test("a host that never stops is left after its share, and the closes and the flush still run before the kill", async () => {
	const ran: string[] = [];
	const started = Date.now();
	const drained = await shutDown(
		{
			drain: () => new Promise<void>(() => {}),
			stop: () => new Promise<void>(() => {}),
			close: [
				() => new Promise<void>(() => {}),
				() => void ran.push("redis"),
				async () => void ran.push("cosmos"),
			],
			flush: async () => void ran.push("telemetry"),
		},
		SCALED,
	);
	expect(drained).toBe(false);
	expect(ran).toEqual(["redis", "cosmos", "telemetry"]);
	// Every part hung that can: the drain, the stop and a close. What is left is the flush's share and the exit's.
	expect(Date.now() - started).toBeLessThan(SCALED.graceMs - SCALED.exitMs / 2);
	expect(warn).toHaveBeenCalledTimes(3);
});

test("the host's stop is given what the grace still holds when the drain ended early, and no more", async () => {
	const started = Date.now();
	let finished = false;
	await shutDown(
		{
			drain: async () => {},
			// Slower than its least share, inside what an early drain leaves.
			stop: async () => {
				await Bun.sleep(SCALED.stopMs + 40);
				finished = true;
			},
			close: [],
			flush: async () => {},
		},
		SCALED,
	);
	expect(finished).toBe(true);
	expect(warn).not.toHaveBeenCalled();

	await shutDown(
		{
			drain: async () => {},
			stop: () => new Promise<void>(() => {}),
			close: [],
			flush: async () => {},
		},
		SCALED,
	);
	expect(Date.now() - started).toBeLessThan(2 * SCALED.graceMs);
	expect(warn).toHaveBeenCalledTimes(1);
});

test("a flush that never answers does not hold the exit", async () => {
	const started = Date.now();
	await shutDown(
		{
			drain: async () => {},
			stop: () => {},
			close: [],
			flush: () => new Promise(() => {}),
		},
		{ graceMs: 0, drainMs: 1000, stopMs: 20, closeMs: 20, flushMs: 20 },
	);
	expect(Date.now() - started).toBeLessThan(1000);
	expect(warn).toHaveBeenCalledTimes(1);
});
