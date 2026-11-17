/**
 * Every case overrides `initialDelayMs`: the shipped schedule is 2s, 4s, 8s,
 * and a suite that waited it out would be slower than the thing it tests.
 */
import { expect, test } from "bun:test";
import { APICallError, wrapLanguageModel } from "ai";
import { MockLanguageModelV4 } from "ai/test";
import {
	DEFAULT_RETRY_SCHEDULE,
	fullJitterMs,
	honouredRetryAfterMs,
	isRetryableModelError,
	modelRetryMiddleware,
	type RetryPolicy,
	withRetries,
} from "./retry";

function apiError(
	statusCode: number,
	responseHeaders?: Record<string, string>,
): APICallError {
	return new APICallError({
		message: `HTTP ${statusCode}`,
		url: "https://account.openai.azure.com/openai/v1/responses",
		requestBodyValues: {},
		statusCode,
		responseHeaders,
	});
}

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

/** A `doGenerate` that fails `failures` times before succeeding, counting calls. */
function flaky(failures: number, error: () => unknown) {
	const calls = { n: 0 };
	const doGenerate = async (): Promise<GenerateResult> => {
		calls.n++;
		if (calls.n <= failures) throw error();
		return COMPLETION;
	};
	return { calls, doGenerate };
}

function retried(
	doGenerate: () => Promise<GenerateResult>,
	policy: RetryPolicy,
) {
	return wrapLanguageModel({
		model: new MockLanguageModelV4({ doGenerate }),
		middleware: modelRetryMiddleware({ initialDelayMs: 1, ...policy }),
	});
}

test("a transient 429 or 503 is retried and the call still answers", async () => {
	const a = flaky(1, () => apiError(429));
	const b = flaky(2, () => apiError(503));
	expect(
		(await retried(a.doGenerate, {}).doGenerate(CALL)).finishReason.unified,
	).toBe("stop");
	await retried(b.doGenerate, {}).doGenerate(CALL);
	expect(a.calls.n).toBe(2);
	expect(b.calls.n).toBe(3);
});

test("the budget ends: a bounded number of attempts, then the provider's own error", async () => {
	const { calls, doGenerate } = flaky(Number.POSITIVE_INFINITY, () =>
		apiError(429),
	);
	const thrown = await Promise.resolve(
		retried(doGenerate, { maxRetries: 2 }).doGenerate(CALL),
	).catch((e: unknown) => e);
	expect(APICallError.isInstance(thrown)).toBe(true);
	expect((thrown as APICallError).statusCode).toBe(429);
	expect(calls.n).toBe(3);
});

test("the default budget is the shared schedule", async () => {
	const { calls, doGenerate } = flaky(Number.POSITIVE_INFINITY, () =>
		apiError(429),
	);
	await Promise.resolve(retried(doGenerate, {}).doGenerate(CALL)).catch(
		() => undefined,
	);
	expect(calls.n).toBe(DEFAULT_RETRY_SCHEDULE.maxRetries + 1);
});

test("a 400 or a non-provider error is not retried", async () => {
	const bad = flaky(Number.POSITIVE_INFINITY, () => apiError(400));
	const typed = flaky(
		Number.POSITIVE_INFINITY,
		() => new TypeError("bad input"),
	);
	await expect(retried(bad.doGenerate, {}).doGenerate(CALL)).rejects.toThrow(
		"HTTP 400",
	);
	await expect(retried(typed.doGenerate, {}).doGenerate(CALL)).rejects.toThrow(
		"bad input",
	);
	expect(bad.calls.n).toBe(1);
	expect(typed.calls.n).toBe(1);
});

test("a stream refused before it starts is retried", async () => {
	let calls = 0;
	const model = wrapLanguageModel({
		model: new MockLanguageModelV4({
			doStream: async (): Promise<StreamResult> => {
				calls++;
				if (calls === 1) throw apiError(429);
				return {
					stream: new ReadableStream({
						start(controller) {
							controller.enqueue({ type: "text-delta", id: "1", delta: "hi" });
							controller.close();
						},
					}),
				};
			},
		}),
		middleware: modelRetryMiddleware({ initialDelayMs: 1 }),
	});
	const { stream } = await model.doStream(CALL);
	await stream.getReader().read();
	expect(calls).toBe(2);
});

test("isRetryableModelError follows the provider's own verdict", () => {
	expect(isRetryableModelError(apiError(429))).toBe(true);
	expect(isRetryableModelError(apiError(500))).toBe(true);
	expect(isRetryableModelError(apiError(408))).toBe(true);
	expect(isRetryableModelError(apiError(401))).toBe(false);
	expect(isRetryableModelError(new Error("boom"))).toBe(false);
});

test("a retry-after is obeyed over the curve, up to the cap, and never jittered", () => {
	expect(
		honouredRetryAfterMs(apiError(429, { "retry-after": "7" }), 2_000),
	).toBe(7_000);
	expect(
		honouredRetryAfterMs(apiError(429, { "retry-after-ms": "450" }), 2_000),
	).toBe(450);
	// Out of quota for an hour: the bound wins, unless we would wait longer anyway.
	expect(
		honouredRetryAfterMs(apiError(429, { "retry-after": "3600" }), 2_000),
	).toBeUndefined();
	// A wait of exactly the bound is within it.
	expect(
		honouredRetryAfterMs(apiError(429, { "retry-after": "60" }), 2_000),
	).toBe(60_000);
	expect(
		honouredRetryAfterMs(apiError(429, { "retry-after": "70" }), 120_000),
	).toBe(70_000);
	expect(
		honouredRetryAfterMs(apiError(429, { "retry-after": "70" }), 2_000, 90_000),
	).toBe(70_000);
	// No header, an unparseable one, or no provider error: the curve decides.
	expect(honouredRetryAfterMs(apiError(429), 4_000)).toBeUndefined();
	expect(
		honouredRetryAfterMs(apiError(429, { "retry-after": "soon" }), 4_000),
	).toBeUndefined();
	expect(honouredRetryAfterMs(new Error("boom"), 4_000)).toBeUndefined();
});

test("the exponential wait is jittered over its whole window", () => {
	expect(fullJitterMs(2_000, () => 0)).toBe(0);
	expect(fullJitterMs(2_000, () => 0.5)).toBe(1_000);
	expect(fullJitterMs(2_000, () => 0.999)).toBe(1_998);
});

test("a retry waits a jittered fraction of the curve; a retry-after is waited out as given", async () => {
	const jittered = flaky(1, () => apiError(429));
	let started = Date.now();
	await retried(jittered.doGenerate, {
		initialDelayMs: 10_000,
		random: () => 0,
	}).doGenerate(CALL);
	expect(Date.now() - started).toBeLessThan(2_000);

	const told = flaky(1, () => apiError(429, { "retry-after-ms": "120" }));
	started = Date.now();
	await retried(told.doGenerate, { random: () => 0 }).doGenerate(CALL);
	expect(Date.now() - started).toBeGreaterThanOrEqual(100);
});

test("aborting the request ends the wait at once and starts no further attempt", async () => {
	const { calls, doGenerate } = flaky(Number.POSITIVE_INFINITY, () =>
		apiError(429),
	);
	const model = retried(doGenerate, { initialDelayMs: 10_000 });
	const controller = new AbortController();
	setTimeout(() => controller.abort(), 20);
	const started = Date.now();
	const thrown = await Promise.resolve(
		model.doGenerate({ ...CALL, abortSignal: controller.signal }),
	).catch((e: unknown) => e);
	expect(Date.now() - started).toBeLessThan(2_000);
	expect((thrown as Error).name).toBe("AbortError");
	expect(calls.n).toBe(1);
});

test("a failure that lands after the abort is rethrown as it is, with no wait", async () => {
	const controller = new AbortController();
	let calls = 0;
	const thrown = await withRetries(
		async () => {
			calls++;
			controller.abort();
			throw apiError(429);
		},
		{ initialDelayMs: 10_000 },
		controller.signal,
	).catch((e: unknown) => e);
	expect(APICallError.isInstance(thrown)).toBe(true);
	expect(calls).toBe(1);
});

test("a provider that asks for a longer wait than the schedule takes ends the call: it is not asked again sooner", async () => {
	const told = flaky(1, () => apiError(429, { "retry-after": "3600" }));
	await expect(
		retried(told.doGenerate, { random: () => 0 }).doGenerate(CALL),
	).rejects.toMatchObject({ statusCode: 429 });
	expect(told.calls.n).toBe(1);
});

test("a field given as undefined keeps the schedule's own, so the budget still ends; the wait never grows past the honoured cap", async () => {
	const always = flaky(Number.POSITIVE_INFINITY, () => apiError(503));
	await expect(
		withRetries(always.doGenerate, {
			maxRetries: undefined,
			initialDelayMs: 1,
			backoffFactor: 1_000,
			maxHonouredDelayMs: 5,
			random: () => 1,
		}),
	).rejects.toMatchObject({ statusCode: 503 });
	expect(always.calls.n).toBe(DEFAULT_RETRY_SCHEDULE.maxRetries + 1);
});
