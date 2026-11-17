import { afterAll, afterEach, expect, test } from "bun:test";
import { closeRedis, type KeyNamespace } from "@platform/redis";
import {
	REDIS_AVAILABLE,
	sweepNamespace,
	throwawayNamespace,
} from "@platform/redis/testing";
import { dueQueue } from "./due-queue";

/**
 * The queue on its own, on Redis where there is one and on this process's
 * timers otherwise: how many runs a process holds at once, what a stop
 * finishes and what it leaves, and a failure that cannot be reported.
 */
const namespaces: KeyNamespace[] = [];

function queueOf(
	work: (resourceId: string, threadId: string) => Promise<void>,
	failed: (err: Error) => void = () => {},
	namespace = throwawayNamespace(),
	sweepMs = 60_000,
) {
	if (!namespaces.includes(namespace)) namespaces.push(namespace);
	return dueQueue({ name: "test", namespace, sweepMs, work, failed });
}

afterEach(async () => {
	await Promise.all(namespaces.splice(0).map(sweepNamespace));
});

afterAll(async () => {
	await closeRedis();
});

test("a process holds a bounded number of runs at once, however many are due", async () => {
	let running = 0;
	let most = 0;
	let done = 0;
	const queue = queueOf(async () => {
		running++;
		most = Math.max(most, running);
		await Bun.sleep(5);
		running--;
		done++;
	});
	for (let i = 0; i < 30; i++) await queue.schedule("person", `t${i}`, 60_000);
	await queue.flush();
	expect(done).toBe(30);
	expect(most).toBeGreaterThan(1);
	expect(most).toBeLessThanOrEqual(8);
	// A run asked for at once waits for room as a due one does.
	most = 0;
	await Promise.all(
		Array.from({ length: 20 }, (_, i) => queue.schedule("person", `n${i}`, 0)),
	);
	await queue.flush();
	expect(done).toBe(50);
	expect(most).toBeLessThanOrEqual(8);
});

test("a stop finishes what only this process holds, and leaves what waits in Redis for another replica", async () => {
	const ran: string[] = [];
	const work = async (_resourceId: string, threadId: string) => {
		await Bun.sleep(5);
		ran.push(threadId);
	};
	const namespace = throwawayNamespace();
	const queue = queueOf(work, undefined, namespace);
	// In flight: waited for either way.
	await queue.schedule("person", "now", 0);
	await queue.schedule("person", "later", 60_000);
	await queue.stop();
	expect(ran).toEqual(REDIS_AVAILABLE ? ["now"] : ["now", "later"]);
	// What stayed in the set is another replica's to run; the one that stopped starts nothing more.
	await queue.flush();
	expect(ran).toEqual(REDIS_AVAILABLE ? ["now"] : ["now", "later"]);
	const elsewhere = queueOf(work, undefined, namespace);
	await elsewhere.flush();
	expect(ran).toEqual(["now", "later"]);
	await elsewhere.stop();
});

test("a run asked for at once never holds the caller, and waits its turn for room", async () => {
	let running = 0;
	let most = 0;
	const gates: (() => void)[] = [];
	const queue = queueOf(async () => {
		running++;
		most = Math.max(most, running);
		await new Promise<void>((resolve) => gates.push(resolve));
		running--;
	});
	const started = Date.now();
	for (let i = 0; i < 12; i++) await queue.schedule("person", `t${i}`, 0);
	// Twelve asked for and eight running: the ninth was not waited for.
	expect(Date.now() - started).toBeLessThan(500);
	expect(running).toBe(8);
	// The same thread asked for again while it waits is one run, not two.
	await queue.schedule("person", "t11", 0);
	while (gates.length || running) {
		gates.shift()?.();
		await Bun.sleep(1);
	}
	await queue.flush();
	expect(most).toBe(8);
	await queue.stop();
});

test.skipIf(REDIS_AVAILABLE)(
	"waits that fall due together on this process's timers run within the bound too",
	async () => {
		let running = 0;
		let most = 0;
		let done = 0;
		const queue = queueOf(async () => {
			running++;
			most = Math.max(most, running);
			await Bun.sleep(20);
			running--;
			done++;
		});
		for (let i = 0; i < 20; i++) await queue.schedule("person", `t${i}`, 10);
		while (done < 20) await Bun.sleep(10);
		expect(most).toBeLessThanOrEqual(8);
		await queue.stop();
	},
);

test.skipIf(!REDIS_AVAILABLE)(
	"a sweep takes no more waits than there is room for, and leaves the rest in the set",
	async () => {
		let running = 0;
		let most = 0;
		let done = 0;
		const queue = queueOf(
			async () => {
				running++;
				most = Math.max(most, running);
				await Bun.sleep(30);
				running--;
				done++;
			},
			undefined,
			undefined,
			20,
		);
		for (let i = 0; i < 20; i++) await queue.schedule("person", `t${i}`, 1);
		queue.start();
		while (done < 20) await Bun.sleep(10);
		expect(most).toBeLessThanOrEqual(8);
		await queue.stop();
	},
);

test("past a stop's bound nothing starts: what was in line here is dropped, and what was taken from Redis goes back", async () => {
	const started: string[] = [];
	const release: (() => void)[] = [];
	const work = async (_resourceId: string, threadId: string) => {
		started.push(threadId);
		await new Promise<void>((resolve) => release.push(resolve));
	};
	const namespace = throwawayNamespace();
	const queue = queueOf(work, undefined, namespace);
	// Eight that never end fill the room; two more wait in line, one of them a wait Redis held.
	for (let i = 0; i < 8; i++) await queue.schedule("person", `held${i}`, 0);
	await queue.schedule("person", "local", 0);
	await queue.schedule("person", "shared", 60_000);
	const flushing = queue.flush();
	await Bun.sleep(50);
	await queue.stop();
	expect(started).toHaveLength(8);
	// Room appears after the bound: nothing takes it, and nothing asked for now starts either.
	for (const done of release.splice(0)) done();
	await flushing;
	await queue.schedule("person", "after", 0);
	await Bun.sleep(50);
	expect(started).toHaveLength(8);
	// The wait Redis held is another replica's again; with no Redis it went with the process.
	const elsewhere = queueOf(
		async (_r, threadId) => {
			started.push(`elsewhere:${threadId}`);
		},
		undefined,
		namespace,
	);
	await elsewhere.flush();
	expect(started.slice(8)).toEqual(REDIS_AVAILABLE ? ["elsewhere:shared"] : []);
	await elsewhere.stop();
}, 15_000);

test("a failure whose report throws still ends its run", async () => {
	const queue = queueOf(
		async () => {
			throw new Error("the work failed");
		},
		() => {
			throw new Error("and so did the report");
		},
	);
	await queue.schedule("person", "thread", 0);
	await queue.flush();
	await queue.stop();
});
