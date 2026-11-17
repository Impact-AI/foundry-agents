import {
	getRedis,
	isRedisConfigured,
	type KeyNamespace,
	withLock,
} from "@platform/redis";

/**
 * Work a turn leaves behind for its thread, run off the request path after
 * a wait: the memory's extraction and the thread's title. A thread queued
 * again while it waits has its wait moved, so a burst of turns is one run.
 * The wait is a Redis sorted set, scored by when each thread is due, that a
 * sweeper on one replica at a time works through: a replica that stops
 * before a thread is due leaves it for another. Each due thread is taken by
 * the replica whose remove of it wins, and run there, counted until it ends.
 * Without Redis the wait is this process's timer.
 *
 * A run that throws is handed to `failed` and not retried here: the next
 * turn on the thread queues it again. A process runs at most `MAX_RUNNING`
 * at once, however the work came to it — a wait that fell due here, one a
 * sweep took, one asked for now: each waits its turn in this process, and a
 * sweep takes no more waits than there is room for, so the rest stay in the
 * set for the next sweep, here or on another replica.
 */
export interface DueQueue {
	/** Run the work for the thread after `delayMs`; a thread already waiting waits from now. Zero runs it here as soon as there is room, and never holds the caller for it. */
	schedule(
		resourceId: string,
		threadId: string,
		delayMs: number,
	): Promise<void>;
	/** The waits for a person's threads, dropped. */
	unschedule(resourceId: string): Promise<void>;
	/** Everything waiting anywhere run now, here, and everything this process runs run to the end: a test's. */
	flush(): Promise<void>;
	start(): void;
	/**
	 * The sweeper ended, and what only this process holds finished: its own
	 * timers run now, its runs in flight waited for, both within
	 * `STOP_BOUND_MS`. Past the bound nothing more starts: a wait this
	 * process took from Redis and did not run goes back there for another
	 * replica, and one it kept itself is dropped with the process.
	 */
	stop(): Promise<void>;
}

export interface DueQueueOptions {
	/** The queue's keys under the namespace: `<name>-due`, and `<name>-sweep` for the sweeper's lock. */
	name: string;
	namespace: KeyNamespace;
	/** How often due threads are looked for. */
	sweepMs: number;
	work(resourceId: string, threadId: string): Promise<void>;
	failed(err: Error): void;
}

/** The due set never outlives a week of nothing added. */
const DUE_TTL_SECONDS = 7 * 86_400;
/** Runs one process holds at once: each is a model call and a handful of writes. */
const MAX_RUNNING = 8;
/** How long a stop waits for this process's runs: inside the platform's termination grace, beside everything else a stop does. */
const STOP_BOUND_MS = 5_000;

export function dueQueue({
	name,
	namespace,
	sweepMs,
	work,
	failed,
}: DueQueueOptions): DueQueue {
	const dueKey = namespace.key(`${name}-due`);
	/** The waits this process keeps itself, without Redis. */
	const timers = new Map<string, ReturnType<typeof setTimeout>>();
	const inflight = new Set<Promise<void>>();
	/** What is to run here once there is room, by thread; whether Redis is where it came from. */
	const ready = new Map<string, { taken: boolean }>();
	let sweeper: ReturnType<typeof setInterval> | null = null;
	/** The sweep in flight, if any. */
	let sweeping: Promise<unknown> | null = null;
	/** A stop began: no sweep takes another wait. */
	let stopping = false;
	/** A stop's bound passed: nothing more starts. */
	let closed = false;

	/** Redis, when there is one to ask; a configured one that does not answer throws. */
	async function redis() {
		if (!isRedisConfigured()) return null;
		const client = await getRedis();
		if (!client) throw new Error("Redis is configured and does not answer");
		return client;
	}

	const member = (resourceId: string, threadId: string) =>
		JSON.stringify({ resourceId, threadId });
	const parsed = (key: string) =>
		JSON.parse(key) as { resourceId: string; threadId: string };

	/** One run, in the background, counted until it ends; the next in line starts as it does. */
	function run(key: string): void {
		const { resourceId, threadId } = parsed(key);
		const running = work(resourceId, threadId)
			.catch((err: Error) => failed(err))
			// A `failed` that throws has nothing left to tell: the run still ends.
			.catch((err: Error) =>
				console.error(`[${name}] a failure was not reported:`, err.message),
			)
			.finally(() => {
				inflight.delete(running);
				pump();
			});
		inflight.add(running);
	}

	/** What is ready, started while there is room for it. */
	function pump(): void {
		for (const key of ready.keys()) {
			if (inflight.size >= MAX_RUNNING) return;
			ready.delete(key);
			run(key);
		}
	}

	/** A thread's work, in line for room here: once, however often it is asked for meanwhile. Nothing joins the line once the process has closed, and the line is emptied as it does. */
	function enqueue(key: string, taken: boolean): void {
		if (closed) return;
		if (!ready.has(key)) ready.set(key, { taken });
		pump();
	}

	/** How many more this process may take on. */
	const room = () => MAX_RUNNING - inflight.size - ready.size;

	/** A wait run here once this replica's remove of it is the one that wins; false when another's did. */
	async function claim(
		client: NonNullable<Awaited<ReturnType<typeof redis>>>,
		key: string,
	): Promise<boolean> {
		if (((await client.send("ZREM", [dueKey, key])) as number) !== 1)
			return false;
		if (closed) {
			// Taken as the process closed: it is due, and another replica's to run.
			await client.send("ZADD", [dueKey, String(Date.now()), key]);
			return false;
		}
		enqueue(key, true);
		return true;
	}

	/** The waits that are due, each taken by the replica whose remove wins, then run here. */
	async function sweep(): Promise<number> {
		const client = await redis();
		if (!client || stopping) return 0;
		const free = room();
		if (free <= 0) return 0;
		const due = (await client.send("ZRANGEBYSCORE", [
			dueKey,
			"-inf",
			String(Date.now()),
			"LIMIT",
			"0",
			String(free),
		])) as string[];
		let taken = 0;
		for (const key of due) {
			if (stopping) break;
			if (await claim(client, key)) taken++;
		}
		return taken;
	}

	/** Every wait this process keeps itself, in line to run now. */
	function runTimers(): void {
		for (const [key, timer] of [...timers]) {
			clearTimeout(timer);
			timers.delete(key);
			enqueue(key, false);
		}
	}

	/** Until nothing runs here and nothing is in line. */
	async function idle(): Promise<void> {
		while (inflight.size) await Promise.all([...inflight]);
	}

	return {
		async schedule(resourceId, threadId, delayMs) {
			const key = member(resourceId, threadId);
			if (delayMs === 0) return enqueue(key, false);
			const client = await redis();
			if (client) {
				// The score is the due time; a thread already waiting has it moved.
				await client.send("ZADD", [dueKey, String(Date.now() + delayMs), key]);
				await client.send("EXPIRE", [dueKey, String(DUE_TTL_SECONDS)]);
				return;
			}
			clearTimeout(timers.get(key));
			timers.set(
				key,
				setTimeout(() => {
					timers.delete(key);
					enqueue(key, false);
				}, delayMs),
			);
		},

		async unschedule(resourceId) {
			for (const [key, timer] of timers)
				if (parsed(key).resourceId === resourceId) {
					clearTimeout(timer);
					timers.delete(key);
				}
			for (const key of [...ready.keys()])
				if (parsed(key).resourceId === resourceId) ready.delete(key);
			const client = await redis();
			if (!client) return;
			const waiting = (await client.send("ZRANGE", [
				dueKey,
				"0",
				"-1",
			])) as string[];
			const theirs = waiting.filter(
				(key) => parsed(key).resourceId === resourceId,
			);
			if (theirs.length) await client.send("ZREM", [dueKey, ...theirs]);
		},

		async flush() {
			const client = await redis();
			if (client) {
				const waiting = (await client.send("ZRANGE", [
					dueKey,
					"0",
					"-1",
				])) as string[];
				for (const key of waiting) await claim(client, key);
			}
			runTimers();
			await idle();
		},

		start() {
			if (sweeper) return;
			sweeper = setInterval(() => {
				if (sweeping || stopping) return;
				sweeping = withLock(
					{
						key: namespace.key(`${name}-sweep`),
						ttlMs: sweepMs,
						whenUnavailable: "skip",
					},
					sweep,
				)
					.catch((err) =>
						console.error(`[${name}] a sweep failed:`, (err as Error).message),
					)
					.finally(() => {
						sweeping = null;
					});
			}, sweepMs);
			sweeper.unref?.();
		},

		async stop() {
			if (sweeper) clearInterval(sweeper);
			sweeper = null;
			stopping = true;
			let bound: ReturnType<typeof setTimeout> | undefined;
			const expired = new Promise<void>((resolve) => {
				bound = setTimeout(resolve, STOP_BOUND_MS);
			});
			const finished = (async () => {
				// A sweep in flight takes nothing more, and what it took is in line.
				await sweeping;
				runTimers();
				await idle();
			})();
			await Promise.race([finished, expired]);
			clearTimeout(bound);
			closed = true;
			for (const timer of timers.values()) clearTimeout(timer);
			timers.clear();
			// What never got room: a wait taken from Redis goes back, due, for another replica.
			const back = [...ready].flatMap(([key, { taken }]) =>
				taken ? [key] : [],
			);
			ready.clear();
			if (!back.length) return;
			try {
				const client = await redis();
				const now = String(Date.now());
				if (client)
					await client.send("ZADD", [
						dueKey,
						...back.flatMap((key) => [now, key]),
					]);
			} catch (err) {
				console.error(
					`[${name}] waits taken and not run were not handed back:`,
					(err as Error).message,
				);
			}
		},
	};
}
