import { getRedis, withLock } from "@platform/redis";
import { type AgentKeys, problems } from "../keys";

/**
 * A forget the memory store could not finish in the request, finished
 * later: a `memory` target is settled when every update pending at the
 * forget has, and the scope has been deleted after them. The targets wait
 * in a Redis set a sweeper works through every minute. The same pass
 * runs `inspect`, the store's look at the hand-overs it is watching, so
 * one replica's one timer carries both. Redis is never required, but
 * without it nothing can wait, so a deferral throws.
 */

export type PurgeTarget = { kind: "memory"; resourceId: string };

/** The memory store's half of a forget: true once it is final. */
export type SettleMemory = (resourceId: string) => Promise<boolean>;

const SWEEP_MS = 60_000;
/** Long past any outage worth waiting out; the set never outlives a week of nothing added. */
const SET_TTL_SECONDS = 7 * 86_400;

export interface Purger {
	/** Left for the sweeper from the start: a forget waiting for the store. Throws when nothing would sweep it. */
	defer(target: PurgeTarget): Promise<void>;
	/** One pass over what is waiting. */
	sweep(): Promise<number>;
	start(): void;
	stop(): void;
}

export function purger(
	keys: AgentKeys,
	settleMemory: SettleMemory,
	inspect?: () => Promise<unknown>,
): Purger {
	const setKey = keys.namespace.key("purge");
	let timer: ReturnType<typeof setInterval> | null = null;

	async function defer(target: PurgeTarget): Promise<void> {
		const redis = await getRedis();
		if (!redis) {
			problems.report("agent.memory.erase_unfinished", {});
			throw new Error("nothing can finish this later without Redis");
		}
		await redis.send("SADD", [setKey, JSON.stringify(target)]);
		await redis.send("EXPIRE", [setKey, String(SET_TTL_SECONDS)]);
	}

	async function sweep(): Promise<number> {
		const redis = await getRedis();
		if (!redis) return 0;
		const waiting = (await redis.send("SMEMBERS", [setKey])) as string[];
		let done = 0;
		for (const entry of waiting) {
			const target = JSON.parse(entry) as PurgeTarget;
			// Not due yet, or the store did not answer: the next sweep tries again.
			if (!(await settleMemory(target.resourceId).catch(() => false))) continue;
			await redis.send("SREM", [setKey, entry]);
			done++;
		}
		await inspect?.().catch((err) =>
			console.error(
				"[purge] the memory store's updates were not inspected:",
				(err as Error).message,
			),
		);
		return done;
	}

	return {
		defer,
		sweep,
		start() {
			if (timer) return;
			timer = setInterval(() => {
				void withLock(
					{
						key: keys.namespace.key("purge-sweep"),
						ttlMs: SWEEP_MS,
						whenUnavailable: "skip",
					},
					sweep,
				).catch((err) =>
					console.error("[purge] a sweep failed:", (err as Error).message),
				);
			}, SWEEP_MS);
			timer.unref?.();
		},
		stop() {
			if (timer) clearInterval(timer);
			timer = null;
		},
	};
}
