import { afterAll, afterEach, expect, test } from "bun:test";
import { closeRedis, getRedis, type KeyNamespace } from "@platform/redis";
import {
	REDIS_AVAILABLE,
	sweepNamespace,
	throwawayNamespace,
} from "@platform/redis/testing";
import { END_WAIT_MS, threadEnds } from "./thread-ends";

/**
 * A thread's end between two replicas, against a real server: the turn is
 * told on the channel and by its note, the end waits for it, and neither
 * reaches a turn that starts afterwards or one on another thread.
 */
const withRedis = test.skipIf(!REDIS_AVAILABLE);
const namespaces: KeyNamespace[] = [];

function replicas() {
	const ns = throwawayNamespace();
	namespaces.push(ns);
	return [threadEnds(ns), threadEnds(ns), ns] as const;
}

afterEach(async () => {
	await Promise.all(namespaces.splice(0).map(sweepNamespace));
});

afterAll(async () => {
	await closeRedis();
});

withRedis(
	"a turn on one replica hears the end another makes, and the end waits until the turn is over",
	async () => {
		const [here, there] = replicas();
		let heard = 0;
		const turn = there.running("me", "thread-a", "run-1", () => heard++);
		const other = there.running("me", "thread-b", "run-2", () => heard++);
		// The membership is written before the end reads it.
		expect(await turn.ended()).toBe(false);
		let over = false;
		const ending = here.end("me", "thread-a").then((none) => {
			over = true;
			return none;
		});
		while (!(await turn.ended())) await Bun.sleep(10);
		expect(over).toBe(false);
		await turn.done();
		expect(await ending).toBe(true);
		expect(heard).toBe(1);
		expect(await other.ended()).toBe(false);
		// The note was that turn's alone.
		const next = there.running("me", "thread-a", "run-3", () => heard++);
		expect(await next.ended()).toBe(false);
		await Promise.all([other.done(), next.done()]);
		expect(await here.end("me", "thread-a")).toBe(true);
		await Promise.all([here.stop(), there.stop()]);
	},
);

withRedis(
	"a turn that never ends is waited for no longer than the bound, and still finds its note",
	async () => {
		const [here, there] = replicas();
		const turn = there.running("me", "thread-c", "run-4", () => {});
		expect(await turn.ended()).toBe(false);
		const started = Date.now();
		expect(await here.end("me", "thread-c")).toBe(false);
		expect(Date.now() - started).toBeLessThan(END_WAIT_MS + 2_000);
		expect(await turn.ended()).toBe(true);
		await turn.done();
		await Promise.all([here.stop(), there.stop()]);
	},
	END_WAIT_MS + 5_000,
);

withRedis(
	"an end asked for under one person never reaches another person's turn, whatever thread id it names; an end of every thread reaches each of the person's",
	async () => {
		const [here, there] = replicas();
		const heard: string[] = [];
		const theirs = there.running("them", "thread-x", "run-6", () =>
			heard.push("theirs"),
		);
		const mine = there.running("me", "thread-y", "run-7", () =>
			heard.push("mine"),
		);
		const other = there.running("me", "thread-z", "run-8", () =>
			heard.push("other"),
		);
		expect(await theirs.ended()).toBe(false);
		// The other person's thread id, asked for as this person: nobody is told, and nothing is waited for.
		expect(await here.end("me", "thread-x")).toBe(true);
		await Bun.sleep(100);
		expect(heard).toEqual([]);
		expect(await theirs.ended()).toBe(false);
		// Every thread of this person's, and still not the other's.
		const ending = here.end("me");
		while (!(await mine.ended()) || !(await other.ended())) await Bun.sleep(10);
		await Promise.all([mine.done(), other.done()]);
		expect(await ending).toBe(true);
		expect(heard.sort()).toEqual(["mine", "other"]);
		expect(await theirs.ended()).toBe(false);
		await theirs.done();
		await Promise.all([here.stop(), there.stop()]);
	},
);

test.skipIf(REDIS_AVAILABLE)(
	"without Redis there is nobody elsewhere: an end waits for nothing and a turn hears none",
	async () => {
		const ends = threadEnds(throwawayNamespace());
		const turn = ends.running("me", "thread-d", "run-5", () => {});
		expect(await ends.end("me", "thread-d")).toBe(true);
		expect(await turn.ended()).toBe(false);
		// Nothing was recorded, so a turn's end asks nothing again: every turn and every live session passes through it.
		const started = performance.now();
		await turn.done();
		expect(performance.now() - started).toBeLessThan(50);
		await ends.stop();
	},
);

withRedis(
	"one thread's end never writes over an erase's note: a turn that only reads its note still learns that everything went",
	async () => {
		const [here, there] = replicas();
		const turn = there.running("me", "thread-a", "run-1", () => {});
		expect(await turn.ended()).toBe(false);
		// Deaf to the channel: the note is all this turn has.
		await there.stop();
		// An erase tells it, then deletes the person's threads one by one.
		expect(await here.end("me", undefined, 0)).toBe(false);
		expect(await here.end("me", "thread-a", 0)).toBe(false);
		expect(await turn.ended()).toBe(true);
		expect(turn.whole()).toBe(true);
		await turn.done();
		await here.stop();
	},
);

withRedis(
	"a turn that joins takes the members past their time out of its person's set, and leaves nothing of itself when it is over",
	async () => {
		const [here, , ns] = replicas();
		const redis = await getRedis();
		const set = ns.key("resource-turns", "me");
		// Two turns whose replica died long ago.
		await redis?.send("ZADD", [
			set,
			String(Date.now() - 1_000),
			JSON.stringify(["thread-a", "run-dead-1"]),
			String(Date.now() - 2_000),
			JSON.stringify(["thread-b", "run-dead-2"]),
		]);
		const turn = here.running("me", "thread-c", "run-live", () => {});
		expect(await turn.ended()).toBe(false);
		expect(await redis?.send("ZCARD", [set])).toBe(1);
		await turn.done();
		expect(await redis?.send("ZCARD", [set])).toBe(0);
		await here.stop();
	},
);
