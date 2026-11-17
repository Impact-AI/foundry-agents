import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { context as apiContext, SpanKind, trace } from "@opentelemetry/api";
import { AsyncLocalStorageContextManager } from "@opentelemetry/context-async-hooks";
import {
	BasicTracerProvider,
	InMemorySpanExporter,
	SimpleSpanProcessor,
} from "@opentelemetry/sdk-trace-base";
import {
	ATTRIBUTE_PREFIX,
	defineProblemCodes,
	PROBLEM_EVENT,
	type ProblemLine,
	problemAttributes,
	problemChannel,
	UNSAFE_VALUE,
} from "./problem";
import {
	bridgeEvents,
	problemEventAttributes,
	unbridgeEvents,
} from "./span-bridge";

/**
 * The channel that carries a refusal, and the guarantees it is worth nothing
 * without: it cannot carry prose, it cannot hurt its caller, and once bridged
 * it reaches the exporter as an item of its own.
 */

const problems = defineProblemCodes([
	"chat.refused.image_too_large",
	"chat.refused.unauthenticated",
	"usage.refused.rate_limit",
	"voice.mint.no_deployment",
	"turns.write_failed",
]);

let printed: string[] = [];
let originalLog: typeof console.log;

beforeEach(() => {
	delete process.env.PROBLEM_LOG;
	printed = [];
	originalLog = console.log;
	console.log = (...args: unknown[]) => {
		printed.push(args.map(String).join(" "));
	};
});

afterEach(() => {
	console.log = originalLog;
	problemChannel.setSink(null);
	delete process.env.PROBLEM_LOG;
});

function collector(): ProblemLine[] {
	const lines: ProblemLine[] = [];
	problemChannel.setSink((line) => {
		lines.push(line);
	});
	return lines;
}

describe("the vocabulary", () => {
	test("a code that is not area.reason, or is listed twice, is refused at definition", () => {
		expect(() => defineProblemCodes(["Refused because of x"])).toThrow(
			/not area/,
		);
		expect(() => defineProblemCodes(["a.b", "a.b"])).toThrow(/twice/);
		expect(problems.codes).toHaveLength(5);
	});
});

describe("the attribute bag", () => {
	test("carries the code and namespaces every facet", () => {
		expect(
			problemAttributes("usage.refused.rate_limit", {
				surface: "chat",
				tier: "base",
				status: 429,
				retryAfterSeconds: 43,
			}),
		).toEqual({
			"problem.code": "usage.refused.rate_limit",
			"problem.surface": "chat",
			"problem.tier": "base",
			"problem.status": 429,
			"problem.retry_after_s": 43,
		});
	});

	test("an absent facet stays absent rather than becoming 0 or empty", () => {
		expect(
			Object.keys(problemAttributes("chat.refused.unauthenticated")),
		).toEqual(["problem.code"]);
	});

	test.each([
		["a sentence", "the turn from anna@example.test was rejected"],
		["an email address", "anna.smith@example.test"],
		["a long opaque blob", "x".repeat(65)],
	])("%s is replaced, not emitted", (_name, value) => {
		expect(
			problemAttributes("turns.write_failed", { reason: value })[
				"problem.reason"
			],
		).toBe(UNSAFE_VALUE);
	});

	test("a bare token is kept; a non-finite number is dropped rather than sent as null", () => {
		const attributes = problemAttributes("chat.refused.image_too_large", {
			reason: "unavailable",
			measured: Number.NaN,
			limit: 20_971_520,
		});
		expect(attributes["problem.reason"]).toBe("unavailable");
		expect(attributes).not.toHaveProperty(`${ATTRIBUTE_PREFIX}measured`);
		expect(attributes[`${ATTRIBUTE_PREFIX}limit`]).toBe(20_971_520);
	});
});

describe("what report does", () => {
	test("writes one flat JSON line to stdout and hands the sink the same bag", () => {
		const lines = collector();
		problems.report("chat.refused.image_too_large", { status: 413 });
		expect(printed).toHaveLength(1);
		const written = JSON.parse(printed[0] ?? "{}");
		expect(written).toMatchObject({
			evt: "problem",
			"problem.code": "chat.refused.image_too_large",
			"problem.status": 413,
		});
		expect(typeof written.ts).toBe("string");
		expect(lines[0]?.attributes).toEqual({
			"problem.code": "chat.refused.image_too_large",
			"problem.status": 413,
		});
	});

	test("PROBLEM_LOG=0 emits nothing on either path; any on-value leaves it on", () => {
		const lines = collector();
		process.env.PROBLEM_LOG = "0";
		problems.report("chat.refused.unauthenticated", { status: 401 });
		expect(printed).toEqual([]);
		expect(lines).toEqual([]);
		process.env.PROBLEM_LOG = "1";
		problems.report("chat.refused.unauthenticated", { status: 401 });
		expect(printed).toHaveLength(1);
	});
});

describe("a failing subscriber cannot reach the caller", () => {
	test("a throwing sink neither throws nor suppresses the stdout line", () => {
		problemChannel.setSink(() => {
			throw new Error("the exporter is down");
		});
		expect(() =>
			problems.report("voice.mint.no_deployment", { status: 503 }),
		).not.toThrow();
		expect(printed[0]).toContain("voice.mint.no_deployment");
	});

	test("a console that throws does not throw into the caller either", () => {
		console.log = () => {
			throw new Error("stdout is gone");
		};
		expect(() =>
			problems.report("turns.write_failed", { status: 500 }),
		).not.toThrow();
	});
});

const SIGNED_BLOB =
	"https://stexample.blob.core.windows.net/assets/photos/6f1c2b7e-9f0a-4d2e-b3c1-8a5e2f0d7c44/portrait.jpg?sig=Kx9%2BQ0dR7mZ1u3s8";

function line(attributes: Record<string, string | number>): ProblemLine {
	return { evt: PROBLEM_EVENT, ts: "2026-09-06T10:00:00.000Z", attributes };
}

describe("the scrub runs over a problem's attributes on its way to a span", () => {
	// Bags built by hand: what a future facet would look like, not what any
	// call site sends now.
	test("a credential in a URL attribute and a caller's address do not survive", () => {
		const attributes = problemEventAttributes(
			line({
				"problem.code": "chat.refused.image_too_large",
				"url.full": `https://app.example.test/api/media?url=${encodeURIComponent(SIGNED_BLOB)}`,
				"client.address": "203.0.113.7",
			}),
		);
		const exported = JSON.stringify(attributes);
		expect(exported).not.toContain("sig=");
		expect(exported).not.toContain("203.0.113.7");
		expect(attributes["problem.code"]).toBe("chat.refused.image_too_large");
	});

	test("the line's own bag is not edited — the sink gets a copy", () => {
		const original = line({
			"problem.code": "usage.refused.rate_limit",
			"client.address": "203.0.113.7",
		});
		problemEventAttributes(original);
		expect(original.attributes["client.address"]).toBe("203.0.113.7");
	});
});

describe("a refusal reaches the exporter as a telemetry item of its own", () => {
	let exporter: InMemorySpanExporter;
	let provider: BasicTracerProvider;

	beforeEach(() => {
		exporter = new InMemorySpanExporter();
		provider = new BasicTracerProvider({
			spanProcessors: [new SimpleSpanProcessor(exporter)],
		});
		apiContext.setGlobalContextManager(
			new AsyncLocalStorageContextManager().enable(),
		);
		trace.setGlobalTracerProvider(provider);
		bridgeEvents();
	});

	afterEach(() => {
		unbridgeEvents();
		trace.disable();
		apiContext.disable();
		exporter.reset();
	});

	test("one is exported even while a request span is open, as that span's child, and the span carries the event too", () => {
		const request = provider
			.getTracer("test")
			.startSpan("POST /api/session", { kind: SpanKind.SERVER });
		apiContext.with(trace.setSpan(apiContext.active(), request), () => {
			problems.report("chat.refused.image_too_large", {
				status: 400,
				measured: 12_000_000,
				limit: 8_000_000,
			});
		});
		request.end();

		const problem = exporter
			.getFinishedSpans()
			.find((s) => s.name === PROBLEM_EVENT);
		expect(problem?.kind).toBe(SpanKind.INTERNAL);
		expect(problem?.attributes["problem.code"]).toBe(
			"chat.refused.image_too_large",
		);
		expect(problem?.attributes["problem.status"]).toBe(400);
		expect(problem?.spanContext().traceId).toBe(request.spanContext().traceId);
		expect(problem?.parentSpanContext?.spanId).toBe(
			request.spanContext().spanId,
		);

		const served = exporter
			.getFinishedSpans()
			.find((s) => s.name === "POST /api/session");
		expect(served?.events.map((e) => e.name)).toEqual([PROBLEM_EVENT]);
	});

	test("a refusal with no span open is exported exactly once", () => {
		problems.report("turns.write_failed", { status: 500 });
		expect(
			exporter.getFinishedSpans().filter((s) => s.name === PROBLEM_EVENT),
		).toHaveLength(1);
	});
});
