import { expect, test } from "bun:test";
import { StreamStalled, withinIdle } from "./client";

/**
 * A streamed response's bound between events: a stream that keeps writing
 * runs as long as it likes, and one that falls silent is given up, its
 * request aborted so the connection and the slot it holds are let go.
 */

async function* paced(gapsMs: number[]) {
	for (const [index, gap] of gapsMs.entries()) {
		await Bun.sleep(gap);
		yield index;
	}
}

test("a stream whose events keep coming is read to its end, however long it runs in all", async () => {
	const abort = new AbortController();
	const seen: number[] = [];
	for await (const event of withinIdle(paced([5, 5, 5, 5, 5, 5]), 20, abort))
		seen.push(event);
	expect(seen).toEqual([0, 1, 2, 3, 4, 5]);
	expect(abort.signal.aborted).toBe(false);
});

test("a stream that falls silent past the bound throws and aborts its request, keeping what arrived first", async () => {
	const abort = new AbortController();
	const seen: number[] = [];
	const reading = (async () => {
		for await (const event of withinIdle(paced([1, 1, 10_000]), 30, abort))
			seen.push(event);
	})();
	await expect(reading).rejects.toBeInstanceOf(StreamStalled);
	expect(seen).toEqual([0, 1]);
	expect(abort.signal.aborted).toBe(true);
});
