import { expect, test } from "bun:test";
import { wrapLanguageModel } from "ai";
import { MockLanguageModelV4 } from "ai/test";
import { concurrencyMiddleware } from "./concurrency";
import { createLimiter } from "./limiter";

type GenerateResult = Awaited<ReturnType<MockLanguageModelV4["doGenerate"]>>;
type StreamResult = Awaited<ReturnType<MockLanguageModelV4["doStream"]>>;

const COMPLETION: GenerateResult = {
	content: [{ type: "text", text: "ok" }],
	finishReason: { unified: "stop", raw: "stop" },
	usage: {
		inputTokens: {
			total: 1,
			noCache: 1,
			cacheRead: undefined,
			cacheWrite: undefined,
		},
		outputTokens: { total: 1, text: 1, reasoning: undefined },
	},
	warnings: [],
};

const CALL = { prompt: [] } as unknown as Parameters<
	MockLanguageModelV4["doGenerate"]
>[0];

function counting() {
	let running = 0;
	let peak = 0;
	const enter = () => {
		running++;
		peak = Math.max(peak, running);
	};
	const leave = () => {
		running--;
	};
	return { enter, leave, peak: () => peak, running: () => running };
}

test("generate calls run at most the cap at once", async () => {
	const limiter = createLimiter(() => 2);
	const { enter, leave, peak } = counting();
	const model = wrapLanguageModel({
		model: new MockLanguageModelV4({
			doGenerate: async () => {
				enter();
				await Bun.sleep(5);
				leave();
				return COMPLETION;
			},
		}),
		middleware: concurrencyMiddleware(limiter),
	});
	await Promise.all(Array.from({ length: 6 }, () => model.doGenerate(CALL)));
	expect(peak()).toBe(2);
	expect(limiter.active).toBe(0);
});

function streaming(parts: number): StreamResult {
	return {
		stream: new ReadableStream({
			async start(controller) {
				for (let i = 0; i < parts; i++) {
					await Bun.sleep(1);
					controller.enqueue({ type: "text-delta", id: "1", delta: `${i}` });
				}
				controller.close();
			},
		}),
	};
}

test("a streamed call holds its slot until the stream is drained", async () => {
	const limiter = createLimiter(() => 1);
	const model = wrapLanguageModel({
		model: new MockLanguageModelV4({ doStream: async () => streaming(3) }),
		middleware: concurrencyMiddleware(limiter),
	});

	const first = await model.doStream(CALL);
	expect(limiter.active).toBe(1);
	const second = model.doStream(CALL);
	await Bun.sleep(5);
	expect(limiter.waiting).toBe(1);

	const seen: unknown[] = [];
	for await (const part of first.stream) seen.push(part);
	expect(seen).toHaveLength(3);
	expect(limiter.active).toBe(1);
	expect(limiter.waiting).toBe(0);

	for await (const _ of (await second).stream) {
	}
	expect(limiter.active).toBe(0);
});

test("cancelling the stream, or aborting the request, releases the slot", async () => {
	const limiter = createLimiter(() => 1);
	const model = wrapLanguageModel({
		model: new MockLanguageModelV4({ doStream: async () => streaming(50) }),
		middleware: concurrencyMiddleware(limiter),
	});

	const cancelled = await model.doStream(CALL);
	await cancelled.stream.cancel("closed tab");
	expect(limiter.active).toBe(0);

	const controller = new AbortController();
	await model.doStream({ ...CALL, abortSignal: controller.signal });
	expect(limiter.active).toBe(1);
	controller.abort();
	expect(limiter.active).toBe(0);
});

test("a stream that is refused releases the slot", async () => {
	const limiter = createLimiter(() => 1);
	const model = wrapLanguageModel({
		model: new MockLanguageModelV4({
			doStream: async () => {
				throw new Error("refused");
			},
		}),
		middleware: concurrencyMiddleware(limiter),
	});
	await expect(model.doStream(CALL)).rejects.toThrow("refused");
	expect(limiter.active).toBe(0);
});

test("a stream that ends takes its abort listener with it, so a signal that outlives the call holds nothing", async () => {
	const limiter = createLimiter(() => 1);
	const model = wrapLanguageModel({
		model: new MockLanguageModelV4({ doStream: async () => streaming(1) }),
		middleware: concurrencyMiddleware(limiter),
	});
	const controller = new AbortController();
	const added: unknown[] = [];
	const removed: unknown[] = [];
	const { addEventListener, removeEventListener } = controller.signal;
	controller.signal.addEventListener = ((...args: unknown[]) => {
		added.push(args[1]);
		return Reflect.apply(addEventListener, controller.signal, args);
	}) as typeof addEventListener;
	controller.signal.removeEventListener = ((...args: unknown[]) => {
		removed.push(args[1]);
		return Reflect.apply(removeEventListener, controller.signal, args);
	}) as typeof removeEventListener;
	const { stream } = await model.doStream({
		...CALL,
		abortSignal: controller.signal,
	});
	for await (const _ of stream as unknown as AsyncIterable<unknown>);
	expect(limiter.active).toBe(0);
	expect(added.length).toBeGreaterThan(0);
	expect(added.every((listener) => removed.includes(listener))).toBe(true);
});
