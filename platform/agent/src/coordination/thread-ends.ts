import { reportFailure } from "@platform/config";
import {
	getRedis,
	isRedisConfigured,
	type KeyNamespace,
	publish,
	type Subscription,
	subscribe,
} from "@platform/redis";

/**
 * A thread's end, told to the turns running on it wherever they run. A
 * delete or an erase stops this replica's turns itself; a turn another
 * replica is streaming is reached through Redis, two ways, because the
 * channel is at most once:
 *
 *   - every running turn is a member of its person's set, under its thread
 *     and its run, so the replica ending a thread — or, for an erase, every
 *     thread the person has — knows which turns to tell and when they are
 *     over;
 *   - each of those turns is left a note under its own run id, which it
 *     reads between its steps and before it writes, and the person and the
 *     thread are published so a turn whose replica is listening stops at
 *     once.
 *
 * Everything is under the person: a thread's id alone names no turn, so an
 * end asked for under one person never reaches a turn of another's, whatever
 * thread id it carries. The note is the turn's, not the thread's: a turn that
 * starts on the same thread id afterwards finds none. A member carries when
 * it lapses, renewed while its turn runs, so a turn whose replica died is
 * not waited for past that. Without Redis a replica knows its own turns
 * only, which is every turn there is on one replica; with Redis down, a turn
 * elsewhere is not told and is not waited for.
 */

/** How long a thread's end waits for the turns told of it to be over. */
export const END_WAIT_MS = 5_000;
const POLL_MS = 50;
/** A turn's membership outlives a replica that died by this much; renewed while the turn runs. */
const RUNNING_TTL_MS = 120_000;
/** Longer than a response may stay silent, so a turn mid-step still finds its note at the next one. */
const NOTE_TTL_MS = 600_000;
/** How often a turn that is over asks to be forgotten when Redis does not answer, and how long between. */
const FORGET_ATTEMPTS = 3;
const FORGET_RETRY_MS = 100;

type Redis = NonNullable<Awaited<ReturnType<typeof getRedis>>>;

export interface RunningTurn {
	/** Whether the thread ended under this turn: nothing more is asked of the model and nothing is written. */
	ended(): Promise<boolean>;
	/** Whether what ended was everything the person has, as far as this turn has been told: an erase, not one thread's delete. */
	whole(): boolean;
	/**
	 * The turn's first record in the fleet's set is written, or was tried and
	 * Redis did not answer: from here an end asked for anywhere finds it.
	 * Never rejects.
	 */
	registered(): Promise<void>;
	/** The turn is over, however it ended. */
	done(): Promise<void>;
}

export interface ThreadEnds {
	/** Record a turn as running on the person's thread; `onEnd` is called at once when the thread's end is heard, with whether it was every thread of theirs that ended. */
	running(
		resourceId: string,
		threadId: string,
		runId: string,
		onEnd: (whole: boolean) => void,
	): RunningTurn;
	/**
	 * Tell every turn running on the person's thread — on every thread of
	 * theirs when none is named — on any replica, that it ended, and wait
	 * until they are over, for `waitMs` at most — {@link END_WAIT_MS} unless
	 * the caller has spent part of it already. Whether none was left running.
	 */
	end(resourceId: string, threadId?: string, waitMs?: number): Promise<boolean>;
	/** Stop listening. */
	stop(): Promise<void>;
}

interface Heard {
	threadId: string;
	hear(whole: boolean): void;
}

/** What a note says: one thread ended, or all of them. */
const ONE = "1";
const ALL = "all";

export function threadEnds(keys: KeyNamespace): ThreadEnds {
	const channel = keys.key("thread-ended");
	/** The turns this replica runs, by person. */
	const listeners = new Map<string, Set<Heard>>();
	let subscription: Promise<Subscription | null> | null = null;

	/** Null for an id no key can carry, which no turn runs under either. */
	const named = (kind: string, id: string): string | null => {
		try {
			return keys.key(kind, id);
		} catch {
			return null;
		}
	};
	const member = (threadId: string, runId: string) =>
		JSON.stringify([threadId, runId]);
	const parsed = (raw: string): [threadId: string, runId: string] | null => {
		try {
			const [threadId, runId] = JSON.parse(raw) as unknown[];
			return typeof threadId === "string" && typeof runId === "string"
				? [threadId, runId]
				: null;
		} catch {
			return null;
		}
	};
	/** A command against Redis, null without one or when it does not answer: every use here is best effort. */
	async function run<T>(
		what: string,
		command: (redis: Redis) => Promise<T>,
	): Promise<T | null> {
		try {
			const redis = await getRedis();
			return redis ? await command(redis) : null;
		} catch (err) {
			reportFailure("agent", `a thread's end could not ${what}`, err);
			return null;
		}
	}
	const listen = () => {
		subscription ??= subscribe(channel, (message) => {
			let said: { resourceId?: unknown; threadId?: unknown };
			try {
				said = JSON.parse(message) as typeof said;
			} catch {
				return;
			}
			if (typeof said.resourceId !== "string") return;
			for (const turn of listeners.get(said.resourceId) ?? [])
				if (said.threadId === undefined || said.threadId === turn.threadId)
					turn.hear(said.threadId === undefined);
		}).then((made) => {
			// Not heard this time: the next turn asks again, and the note stands in meanwhile.
			if (!made) subscription = null;
			return made;
		});
	};

	return {
		running(resourceId, threadId, runId, onEnd) {
			const turns = named("resource-turns", resourceId);
			const note = named("turn-end", runId);
			const mine = member(threadId, runId);
			let heard = false;
			let whole = false;
			const entry: Heard = {
				threadId,
				hear(all) {
					heard = true;
					whole ||= all;
					onEnd(all);
				},
			};
			const held = listeners.get(resourceId) ?? new Set();
			held.add(entry);
			listeners.set(resourceId, held);
			let over = false;
			// One write at a time, and none once the turn is over: a renewal
			// that was on its way when the turn ended cannot put the member
			// back after it was taken out. Members past their time go as the
			// set is written, so a person's set holds only turns that may run.
			let written: Promise<unknown> = Promise.resolve();
			const join = () => {
				written = written.then(() =>
					over || !turns
						? null
						: run("record a running turn", (redis) =>
								redis.send("EVAL", [
									"redis.call('ZREMRANGEBYSCORE', KEYS[1], '-inf', '(' .. ARGV[4]) redis.call('ZADD', KEYS[1], ARGV[1], ARGV[2]) return redis.call('PEXPIRE', KEYS[1], ARGV[3])",
									"1",
									turns,
									String(Date.now() + RUNNING_TTL_MS),
									mine,
									String(RUNNING_TTL_MS),
									String(Date.now()),
								]),
							),
				);
			};
			listen();
			join();
			const first = written;
			const renew = setInterval(join, RUNNING_TTL_MS / 3);
			renew.unref?.();
			return {
				async ended() {
					if (heard || !note) return heard;
					const left = await run("read its note", (r) => r.get(note));
					heard = left !== null;
					whole ||= left === ALL;
					return heard;
				},
				whole: () => whole,
				async registered() {
					await first;
				},
				async done() {
					over = true;
					clearInterval(renew);
					held.delete(entry);
					if (held.size === 0) listeners.delete(resourceId);
					await written;
					// Without Redis nothing was recorded, so there is nothing to forget and nothing to ask again.
					if (!turns || !note || !isRedisConfigured()) return;
					// Asked again when it does not answer: a member left behind is
					// a turn every end of its thread waits its bound out for.
					for (let attempt = 0; attempt < FORGET_ATTEMPTS; attempt++) {
						const forgotten = await run("forget a turn that is over", (redis) =>
							redis.send("EVAL", [
								"redis.call('ZREM', KEYS[1], ARGV[1]) redis.call('DEL', KEYS[2]) return 1",
								"2",
								turns,
								note,
								mine,
							]),
						);
						if (forgotten !== null) return;
						await Bun.sleep(FORGET_RETRY_MS);
					}
				},
			};
		},

		async end(resourceId, threadId, waitMs = END_WAIT_MS) {
			const turns = named("resource-turns", resourceId);
			if (!turns) return true;
			const until = Date.now() + waitMs;
			let told = false;
			for (;;) {
				// A member past its time is a turn whose replica stopped renewing it.
				const members = await run("read the turns running on it", (redis) =>
					redis.send("ZRANGEBYSCORE", [turns, String(Date.now()), "+inf"]),
				);
				const running = (Array.isArray(members) ? (members as string[]) : [])
					.map(parsed)
					.filter(
						(turn): turn is [string, string] =>
							turn !== null && (threadId === undefined || turn[0] === threadId),
					);
				// No Redis, or one that did not answer: nobody elsewhere to wait for.
				if (!running.length) return true;
				for (const [, runId] of running) {
					const note = named("turn-end", runId);
					if (note)
						await run("leave a turn its note", (redis) =>
							redis.send("SET", [
								note,
								threadId === undefined ? ALL : ONE,
								"PX",
								String(NOTE_TTL_MS),
								// One thread's end never writes over an erase's: the turn is told the most that ended.
								...(threadId === undefined ? [] : ["NX"]),
							]),
						);
				}
				if (!told) {
					told = true;
					await publish(
						channel,
						JSON.stringify(
							threadId === undefined
								? { resourceId }
								: { resourceId, threadId },
						),
					);
				}
				if (Date.now() >= until) return false;
				await Bun.sleep(POLL_MS);
			}
		},

		async stop() {
			const made = await subscription;
			subscription = null;
			await made?.close();
		},
	};
}
