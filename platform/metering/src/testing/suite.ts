import { afterAll, beforeAll, spyOn } from "bun:test";
import { closeRedis, getRedis } from "@platform/redis";
import { keys, resetMeteringKeyPrefix } from "../keys";
import { recordSession } from "../live/session";
import type { Hangup } from "../live/sweeper";
import { type UsageSubject, usageSubject } from "../subject";
import { useDefaultLimits, useLimits } from "./limits";
import { sweepMeteringKeys, useThrowawayPrefix } from "./real-server";

/**
 * What a suite against a real server shares: its own prefix under limits of
 * its choosing, swept when it is done, and a way to mint a subject nobody
 * has spent — so every bucket it touches is full because it is new.
 */

/** A day of 25 seconds, sessions of 10: three handshakes will not fit. */
export const TOY_LIMITS = {
	realtime: {
		maxSessionSeconds: 10,
		idleSeconds: 10,
		secondsPerDay: 25,
		concurrentSessions: 1000,
	},
	global: { realtimeSecondsPerDay: 72_000 },
};

/** The hooks: a throwaway prefix under `limits`, a quiet console, everything swept after. */
export function meteredSuite(limits: unknown = TOY_LIMITS): void {
	const quiet: ReturnType<typeof spyOn>[] = [];
	beforeAll(() => {
		useThrowawayPrefix();
		quiet.push(spyOn(console, "warn").mockImplementation(() => {}));
		quiet.push(spyOn(console, "log").mockImplementation(() => {}));
		useLimits(limits);
	});
	afterAll(async () => {
		for (const spy of quiet) spy.mockRestore();
		useDefaultLimits();
		await sweepMeteringKeys();
		resetMeteringKeyPrefix();
		await closeRedis();
	});
}

export function freshSubject(name: string): UsageSubject {
	const subject = usageSubject(`${name}-${crypto.randomUUID().slice(0, 8)}`);
	if (!subject) throw new Error(`"${name}" cannot name a subject`);
	return subject;
}

/** What the subject's seconds bucket holds, straight off the hash. */
export async function secondsCredits(who: UsageSubject): Promise<number> {
	const redis = await getRedis();
	return Number(await redis?.hget(keys.seconds(who), "t"));
}

export async function resetPool(): Promise<void> {
	const redis = await getRedis();
	await redis?.del(keys.pool());
}

/** The id of a session that was recorded; a refusal is a thrown reason. */
export async function recorded(
	input: Parameters<typeof recordSession>[0],
): Promise<string> {
	const outcome = await recordSession(input);
	if (!outcome.ok) throw new Error(`not recorded: ${outcome.reason}`);
	return outcome.id;
}

/** A provider stub that remembers which calls it was asked to hang up. */
export function hangupRecorder(): { hangups: string[]; hangup: Hangup } {
	const hangups: string[] = [];
	return {
		hangups,
		hangup: async (callId) => {
			hangups.push(callId);
			return { status: 200 };
		},
	};
}
