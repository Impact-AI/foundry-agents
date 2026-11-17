import { describe, expect, test } from "bun:test";
import { HEARTBEAT_FRAME, heartbeatStream } from "./heartbeat";

const encoder = new TextEncoder();
const decode = (chunks: Uint8Array[]) =>
	chunks.map((c) => new TextDecoder().decode(c)).join("");

/** A stream that emits `chunks`, waiting `gapMs` before each; bytes or strings. */
function paced<T extends Uint8Array | string>(
	chunks: T[],
	gapMs: number,
): ReadableStream<T> {
	let i = 0;
	return new ReadableStream<T>({
		async pull(controller) {
			if (i >= chunks.length) {
				controller.close();
				return;
			}
			await Bun.sleep(gapMs);
			controller.enqueue(chunks[i] as T);
			i += 1;
		},
	});
}

const pacedBytes = (chunks: string[], gapMs: number) =>
	paced(
		chunks.map((c) => encoder.encode(c)),
		gapMs,
	);

async function drain(
	stream: ReadableStream<Uint8Array>,
): Promise<Uint8Array[]> {
	const out: Uint8Array[] = [];
	for await (const chunk of stream as unknown as AsyncIterable<Uint8Array>) {
		out.push(chunk);
	}
	return out;
}

/**
 * A live count of outstanding timeouts, so "no leaked timer" is an assertion.
 * `paced` waits with `Bun.sleep`, which does not go through `setTimeout`, so
 * everything counted belongs to the heartbeat.
 */
function censusTimers() {
	const realSet = globalThis.setTimeout;
	const realClear = globalThis.clearTimeout;
	const live = new Set<unknown>();
	globalThis.setTimeout = ((fn: () => void, ms?: number) => {
		let handle: unknown;
		handle = realSet(() => {
			live.delete(handle);
			fn();
		}, ms);
		live.add(handle);
		return handle;
	}) as typeof globalThis.setTimeout;
	globalThis.clearTimeout = ((handle: unknown) => {
		live.delete(handle);
		realClear(handle as Parameters<typeof realClear>[0]);
	}) as typeof globalThis.clearTimeout;
	return {
		live: () => live.size,
		restore: () => {
			globalThis.setTimeout = realSet;
			globalThis.clearTimeout = realClear;
		},
	};
}

describe("heartbeatStream", () => {
	test("a stream silent longer than the interval is not silent on the wire", async () => {
		const text = decode(
			await drain(heartbeatStream(pacedBytes(["data: a\n\n"], 130), 20)),
		);
		expect(text).toContain("data: a\n\n");
		expect(text.split(HEARTBEAT_FRAME).length - 1).toBeGreaterThanOrEqual(3);
	});

	test("the payload survives byte for byte, in order, and every injected block is a comment", async () => {
		const frames = ["data: 1\n\n", "data: 2\n\n", "data: 3\n\n"];
		const text = decode(
			await drain(heartbeatStream(pacedBytes(frames, 30), 20)),
		);
		expect(text.split(HEARTBEAT_FRAME).join("")).toBe(frames.join(""));
		for (const block of text.split("\n\n").filter((b) => b !== "")) {
			expect(block.startsWith(":") || block.startsWith("data:")).toBe(true);
		}
	});

	test("a busy stream carries no heartbeat at all", async () => {
		const text = decode(
			await drain(
				heartbeatStream(pacedBytes(["data: 1\n\n", "data: 2\n\n"], 5), 100),
			),
		);
		expect(text).not.toContain(HEARTBEAT_FRAME);
	});

	test("nothing is injected mid-block", async () => {
		const half = new ReadableStream<Uint8Array>({
			async start(controller) {
				controller.enqueue(encoder.encode('data: {"partial'));
				await Bun.sleep(120);
				controller.enqueue(encoder.encode('": true}\n\n'));
				controller.close();
			},
		});
		expect(decode(await drain(heartbeatStream(half, 20)))).toBe(
			'data: {"partial": true}\n\n',
		);
	});

	test("the source is not drained ahead of the consumer", async () => {
		let produced = 0;
		const source = new ReadableStream<Uint8Array>({
			pull(controller) {
				produced += 1;
				controller.enqueue(encoder.encode(`data: ${produced}\n\n`));
			},
		});
		const reader = heartbeatStream(source, 10_000).getReader();
		await reader.read();
		await Bun.sleep(20);
		// The read plus one chunk per default high-water mark, not everything the
		// source would produce.
		expect(produced).toBeLessThanOrEqual(3);
		await reader.cancel();
	});

	test("no timer outlives a stream that ended", async () => {
		const timers = censusTimers();
		try {
			await drain(heartbeatStream(pacedBytes(["data: a\n\n"], 60), 10));
			await Bun.sleep(30);
			expect(timers.live()).toBe(0);
		} finally {
			timers.restore();
		}
	});

	test("a client that hangs up stops the heartbeat and cancels the source", async () => {
		let cancelled = false;
		const source = new ReadableStream<Uint8Array>({
			start(controller) {
				controller.enqueue(encoder.encode("data: a\n\n"));
			},
			cancel() {
				cancelled = true;
			},
		});
		const timers = censusTimers();
		try {
			const reader = heartbeatStream(source, 10).getReader();
			await reader.read();
			await reader.cancel("client gone");
			await Bun.sleep(30);
			expect(cancelled).toBe(true);
			expect(timers.live()).toBe(0);
		} finally {
			timers.restore();
		}
	});

	test("a source error reaches the consumer and leaves no timer behind", async () => {
		const boom = new ReadableStream<Uint8Array>({
			async pull(controller) {
				await Bun.sleep(5);
				controller.error(new Error("upstream died"));
			},
		});
		const timers = censusTimers();
		try {
			await expect(drain(heartbeatStream(boom, 10))).rejects.toThrow(
				"upstream died",
			);
			await Bun.sleep(30);
			expect(timers.live()).toBe(0);
		} finally {
			timers.restore();
		}
	});

	test("a non-positive interval is the source, untouched", () => {
		const source = pacedBytes(["data: a\n\n"], 1);
		expect(heartbeatStream(source, 0)).toBe(source);
	});
});

describe("a stream of strings, which is what an SSE encoder writes", () => {
	test("still beats while silent, and the output is bytes", async () => {
		const out = await drain(heartbeatStream(paced(["data: a\n\n"], 130), 20));
		expect(decode(out)).toContain(HEARTBEAT_FRAME);
		for (const chunk of out) expect(chunk).toBeInstanceOf(Uint8Array);
	});

	test("a beat lands between frames, never inside one", async () => {
		const text = decode(
			await drain(
				heartbeatStream(paced(["data: 1\n\n", "data: 2\n\n"], 60), 20),
			),
		);
		for (const block of text.split("\n\n").filter((b) => b !== "")) {
			expect(["data: 1", "data: 2", HEARTBEAT_FRAME.trim()]).toContain(block);
		}
		expect(text).toContain("data: 1\n\n");
		expect(text).toContain("data: 2\n\n");
	});

	test("a half-written block still refuses a beat", async () => {
		const text = decode(
			await drain(heartbeatStream(paced(["data: a\n\n", "data: b"], 60), 20)),
		);
		expect(text).toContain(HEARTBEAT_FRAME);
		expect(text.endsWith("data: b")).toBe(true);
	});
});

test("a block ended in CRLF or CR is a boundary too, and a half-written line in either is not", async () => {
	for (const [first, beats] of [
		["data: a\r\n\r\n", true],
		["data: a\r\r", true],
		["data: a\r\n", false],
		["data: a\r", false],
	] as const) {
		const out = decode(
			await drain(heartbeatStream(pacedBytes([first, "data: b\n\n"], 120), 30)),
		);
		// Before the first chunk the stream is at a boundary whatever follows.
		const after = out.slice(out.indexOf(first) + first.length);
		expect(after.includes(HEARTBEAT_FRAME)).toBe(beats);
	}
});

test("a blank line cut across chunks is still a boundary, and a chunk of no bytes moves nothing", async () => {
	for (const [chunks, beats] of [
		[["data: a\n", "\n"], true],
		[["data: a\r\n", "\r\n"], true],
		[["data: a\r\n\r", "\n"], true],
		[["data: a\n\n", ""], true],
		[["data: a", ""], false],
		[["data: a\n", "d"], false],
	] as const) {
		const sent = chunks.join("");
		const out = decode(
			await drain(
				heartbeatStream(pacedBytes([...chunks, "data: b\n\n"], 100), 25),
			),
		);
		// The silence after the second chunk: a frame there is the boundary read across the two.
		const [first, second] = chunks;
		const afterFirst = out.slice(
			out.indexOf(first) + first.length,
			out.lastIndexOf("data: b"),
		);
		const afterSecond = afterFirst.slice(
			afterFirst.indexOf(second) + second.length,
		);
		expect([sent, afterSecond.includes(HEARTBEAT_FRAME)]).toEqual([
			sent,
			beats,
		]);
	}
});
