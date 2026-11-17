/**
 * A Server-Sent Events stream that is never silent for longer than an interval.
 *
 * A proxy severs a backend connection that has said nothing for N seconds, and
 * the first token of a long turn can be further away than the smallest N on
 * the path. The SSE grammar defines a line beginning with `:` as a comment
 * that yields no event, so a comment frame is traffic to every intermediary
 * and nothing at all to the consumer.
 */

/** One comment block: `:` opens a comment, the blank line closes the block. */
export const HEARTBEAT_FRAME = ": keepalive\n\n";

const LF = 10;
const CR = 13;
const encoder = new TextEncoder();

/** Where the line terminator ending at `end` begins — CRLF, LF or CR — or -1 when none ends there. */
function terminatorStart(chunk: Uint8Array, end: number): number {
	if (end < 1) return -1;
	const last = chunk[end - 1];
	if (last === LF) return end >= 2 && chunk[end - 2] === CR ? end - 2 : end - 1;
	return last === CR ? end - 1 : -1;
}

/**
 * A frame is only inert between blocks. The parser ends a block at a blank
 * line, whichever of the grammar's three line endings wrote it, so a comment
 * spliced into a half-written `data:` line is concatenated into it and breaks
 * the event it was keeping alive.
 */
function endsBlock(chunk: Uint8Array): boolean {
	const line = terminatorStart(chunk, chunk.length);
	return line >= 0 && terminatorStart(chunk, line) >= 0;
}

/** Two CRLFs: the most bytes a blank line's two terminators take. */
const TAIL_BYTES = 4;

/**
 * The last bytes written, carried from chunk to chunk: a blank line can be
 * cut anywhere by whoever chunked the stream, and a chunk of no bytes says
 * nothing about where the stream stands.
 */
function tailAfter(tail: Uint8Array, chunk: Uint8Array): Uint8Array {
	if (chunk.length >= TAIL_BYTES) return chunk.subarray(-TAIL_BYTES);
	const joined = new Uint8Array(tail.length + chunk.length);
	joined.set(tail);
	joined.set(chunk, tail.length);
	return joined.subarray(-TAIL_BYTES);
}

/**
 * The stream is declared as bytes, but an SSE encoder upstream may write
 * strings into it, and `"\n" === 10` is false: without this the boundary check
 * fails on the first chunk and no frame is ever injected.
 */
function toBytes(chunk: Uint8Array | string): Uint8Array {
	return typeof chunk === "string" ? encoder.encode(chunk) : chunk;
}

/**
 * The same stream, with a comment frame injected whenever it has been silent
 * for `intervalMs`. The timer re-arms on every chunk, so a stream that is
 * delivering carries no extra traffic. A non-positive interval returns the
 * source untouched.
 *
 * Pull-based rather than an eager pump: reading the source ahead of the
 * consumer would replace its backpressure with an unbounded queue here. The
 * heartbeat does not need the pump; it is timer-driven.
 */
export function heartbeatStream(
	source: ReadableStream<Uint8Array | string>,
	intervalMs: number,
): ReadableStream<Uint8Array> {
	if (!Number.isFinite(intervalMs) || intervalMs <= 0)
		return source as ReadableStream<Uint8Array>;

	const reader = source.getReader();
	const beat = encoder.encode(HEARTBEAT_FRAME);
	let timer: ReturnType<typeof setTimeout> | undefined;
	let over = false;
	// Nothing written yet is a boundary: the slow first token is the case that matters.
	let atBoundary = true;
	let tail: Uint8Array = new Uint8Array(0);

	const disarm = () => {
		if (timer !== undefined) {
			clearTimeout(timer);
			timer = undefined;
		}
	};

	const arm = (controller: ReadableStreamDefaultController<Uint8Array>) => {
		disarm();
		if (over) return;
		timer = setTimeout(() => {
			timer = undefined;
			if (over) return;
			// A consumer that has not drained what it already has is not an idle
			// connection: there are bytes queued for it.
			const drained =
				controller.desiredSize === null || controller.desiredSize > 0;
			if (atBoundary && drained) controller.enqueue(beat);
			arm(controller);
		}, intervalMs);
		// A keepalive must never be the reason a process refuses to exit.
		(timer as unknown as { unref?: () => void }).unref?.();
	};

	return new ReadableStream<Uint8Array>({
		start(controller) {
			arm(controller);
		},
		async pull(controller) {
			try {
				const { done, value } = await reader.read();
				if (over) return;
				if (done) {
					over = true;
					disarm();
					controller.close();
					return;
				}
				disarm();
				const bytes = toBytes(value);
				if (bytes.length) {
					tail = tailAfter(tail, bytes);
					atBoundary = endsBlock(tail);
				}
				controller.enqueue(bytes);
				arm(controller);
			} catch (err) {
				over = true;
				disarm();
				// Rejecting from `pull` errors the stream: a relayed failure, not a clean end.
				throw err;
			}
		},
		cancel(reason) {
			over = true;
			disarm();
			return reader.cancel(reason);
		},
	});
}
