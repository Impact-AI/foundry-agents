import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { context as apiContext, SpanKind, trace } from "@opentelemetry/api";
import { AsyncLocalStorageContextManager } from "@opentelemetry/context-async-hooks";
import {
	BasicTracerProvider,
	InMemorySpanExporter,
	SimpleSpanProcessor,
} from "@opentelemetry/sdk-trace-base";
import { stableTag } from "../scrub";
import { bridgeEvents, unbridgeEvents, usageAttributes } from "./span-bridge";
import {
	emitUsage,
	runInUsageScope,
	USAGE_EVENT,
	type UsageLine,
	usageChannel,
} from "./usage";

let lines: Record<string, unknown>[] = [];
const realLog = console.log;

beforeEach(() => {
	lines = [];
	console.log = (arg: unknown) => {
		lines.push(JSON.parse(String(arg)));
	};
	delete process.env.LLM_USAGE_LOG;
});

afterEach(() => {
	console.log = realLog;
	usageChannel.setSink(null);
	delete process.env.LLM_USAGE_LOG;
});

const CALL = {
	kind: "chat",
	provider: "azure",
	model: "chat-deployment",
	durationMs: 2140.66,
} as const;

const LINE_KEYS: (keyof UsageLine)[] = [
	"evt",
	"ts",
	"turnId",
	"surface",
	"kind",
	"provider",
	"model",
	"finishReason",
	"inputTokens",
	"outputTokens",
	"totalTokens",
	"reasoningTokens",
	"cachedInputTokens",
	"ttftMs",
	"durationMs",
	"audioSeconds",
	"audioBytes",
	"characters",
	"embeddedValues",
];

describe("the line", () => {
	test("exactly the declared keys, an unknown is null, and the total is summed only when both halves are known", () => {
		emitUsage({
			...CALL,
			inputTokens: 17_400,
			outputTokens: 320,
			cachedInputTokens: 4_600,
		});
		expect(lines).toHaveLength(1);
		expect(lines[0]).toMatchObject({
			evt: USAGE_EVENT,
			turnId: null,
			surface: null,
			kind: "chat",
			provider: "azure",
			model: "chat-deployment",
			finishReason: null,
			inputTokens: 17_400,
			outputTokens: 320,
			totalTokens: 17_720,
			reasoningTokens: null,
			cachedInputTokens: 4_600,
			ttftMs: null,
			durationMs: 2140.7,
			audioSeconds: null,
			embeddedValues: null,
		});
		expect(Object.keys(lines[0] ?? {}).sort()).toEqual([...LINE_KEYS].sort());
		emitUsage({ ...CALL, inputTokens: 100 });
		expect(lines[1]?.totalTokens).toBeNull();
		emitUsage({
			...CALL,
			inputTokens: 100,
			outputTokens: 20,
			totalTokens: 140,
		});
		expect(lines[2]?.totalTokens).toBe(140);
	});

	test("junk from a provider is null, not a number", () => {
		emitUsage({
			...CALL,
			inputTokens: Number.NaN,
			ttftMs: Number.POSITIVE_INFINITY,
		});
		expect(lines[0]).toMatchObject({ inputTokens: null, ttftMs: null });
	});

	test("a voice kind carries its own columns and the token columns stay null", () => {
		emitUsage({
			kind: "transcription",
			provider: "azure",
			model: "transcription-deployment",
			durationMs: 800.04,
			audioSeconds: 4.2,
			audioBytes: 67_000,
			characters: 54,
		});
		expect(lines[0]).toMatchObject({
			kind: "transcription",
			durationMs: 800,
			audioSeconds: 4.2,
			audioBytes: 67_000,
			characters: 54,
			finishReason: null,
			inputTokens: null,
			totalTokens: null,
			embeddedValues: null,
		});
	});

	test("the scope stamps the turn id and surface; a given surface wins", () => {
		runInUsageScope({ turnId: "turn-9", surface: "web" }, () => {
			emitUsage(CALL);
			emitUsage({ ...CALL, surface: "voice" });
		});
		expect(lines[0]).toMatchObject({ turnId: "turn-9", surface: "web" });
		expect(lines[1]).toMatchObject({ turnId: "turn-9", surface: "voice" });
	});

	test("LLM_USAGE_LOG=0 emits nothing on either path", () => {
		let delivered = 0;
		usageChannel.setSink(() => {
			delivered++;
		});
		process.env.LLM_USAGE_LOG = "0";
		emitUsage(CALL);
		expect(lines).toEqual([]);
		expect(delivered).toBe(0);
	});

	test("a throwing sink or a throwing console never reaches the caller; a working sink gets the printed line", () => {
		usageChannel.setSink(() => {
			throw new Error("down");
		});
		expect(() => emitUsage(CALL)).not.toThrow();
		expect(lines).toHaveLength(1);
		const seen: unknown[] = [];
		usageChannel.setSink((line) => seen.push(line));
		emitUsage(CALL);
		expect(seen).toEqual([lines[1]]);
		console.log = () => {
			throw new Error("stdout is gone");
		};
		expect(() => emitUsage(CALL)).not.toThrow();
	});
});

const TURN_ID = "9f8e7d6c-5b4a-4321-9876-543210fedcba";

function line(over: Partial<UsageLine> = {}): UsageLine {
	return {
		evt: USAGE_EVENT,
		ts: "2026-09-05T10:00:00.000Z",
		turnId: TURN_ID,
		surface: "web",
		kind: "chat",
		provider: "azure",
		model: "chat-deployment",
		finishReason: "stop",
		inputTokens: 17_400,
		outputTokens: 320,
		totalTokens: 17_720,
		reasoningTokens: null,
		cachedInputTokens: 4_600,
		ttftMs: 812.4,
		durationMs: 2_140.7,
		audioSeconds: null,
		audioBytes: null,
		characters: null,
		embeddedValues: null,
		...over,
	};
}

describe("what the bridge carries, and what it refuses to", () => {
	test("the turn id is tagged, never copied; one turn shares a tag, two do not", () => {
		const attributes = usageAttributes(line());
		expect(JSON.stringify(attributes)).not.toContain(TURN_ID);
		expect(attributes["llm.turn_tag"]).toBe(stableTag(TURN_ID));
		expect(usageAttributes(line({ outputTokens: 99 }))["llm.turn_tag"]).toBe(
			attributes["llm.turn_tag"],
		);
		expect(
			usageAttributes(line({ turnId: `${TURN_ID}-other` }))["llm.turn_tag"],
		).not.toBe(attributes["llm.turn_tag"]);
		expect(usageAttributes(line({ turnId: null }))["llm.turn_tag"]).toBe("-");
	});

	test("every measured number under its own name; a null is absent rather than zero", () => {
		const attributes = usageAttributes(line());
		expect(attributes).toMatchObject({
			"llm.kind": "chat",
			"llm.surface": "web",
			"llm.finish_reason": "stop",
			"llm.input_tokens": 17_400,
			"llm.cached_input_tokens": 4_600,
			"llm.ttft_ms": 812.4,
			"llm.duration_ms": 2_140.7,
		});
		expect("llm.reasoning_tokens" in attributes).toBe(false);
		expect("llm.audio_seconds" in attributes).toBe(false);
	});

	test("audio's own units survive, since they are the only numbers it has", () => {
		const attributes = usageAttributes(
			line({
				kind: "transcription",
				inputTokens: null,
				outputTokens: null,
				totalTokens: null,
				audioSeconds: 12.5,
				audioBytes: 204_800,
				characters: 141,
			}),
		);
		expect(attributes).toMatchObject({
			"llm.audio_seconds": 12.5,
			"llm.audio_bytes": 204_800,
			"llm.characters": 141,
		});
	});

	test("no attribute holds free text", () => {
		for (const [name, value] of Object.entries(usageAttributes(line()))) {
			expect(name.startsWith("llm.")).toBe(true);
			if (typeof value === "string")
				expect(value.length).toBeLessThanOrEqual(64);
		}
	});
});

describe("a usage line reaches the exporter as a span of its own", () => {
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

	test("one is exported while a request span is open, and the open span carries the event", () => {
		const request = provider
			.getTracer("test")
			.startSpan("POST /api/session", { kind: SpanKind.SERVER });
		apiContext.with(trace.setSpan(apiContext.active(), request), () => {
			emitUsage({ ...CALL, inputTokens: 100, outputTokens: 20 });
		});
		request.end();
		const exported = exporter
			.getFinishedSpans()
			.filter((s) => s.name === USAGE_EVENT);
		expect(exported).toHaveLength(1);
		expect(exported[0]?.kind).toBe(SpanKind.INTERNAL);
		expect(exported[0]?.attributes["llm.model"]).toBe("chat-deployment");
		expect(
			exporter
				.getFinishedSpans()
				.find((s) => s.name === "POST /api/session")
				?.events.map((e) => e.name),
		).toEqual([USAGE_EVENT]);
	});

	test("the streamed path, which has no span open, is exported too", () => {
		emitUsage({ ...CALL, inputTokens: 100, outputTokens: 20 });
		expect(
			exporter.getFinishedSpans().filter((s) => s.name === USAGE_EVENT),
		).toHaveLength(1);
	});
});
