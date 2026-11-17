import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { ApplicationInsightsSampler as ExporterSampler } from "@azure/monitor-opentelemetry-exporter";
import {
	context as apiContext,
	ROOT_CONTEXT,
	SpanKind,
	trace,
} from "@opentelemetry/api";
import { AsyncLocalStorageContextManager } from "@opentelemetry/context-async-hooks";
import {
	BasicTracerProvider,
	InMemorySpanExporter,
	type Sampler,
	SamplingDecision,
	SimpleSpanProcessor,
} from "@opentelemetry/sdk-trace-base";
import { defineConfigKey } from "@platform/config";
import { defineProblemCodes, PROBLEM_EVENT } from "../events/problem";
import { bridgeEvents, unbridgeEvents } from "../events/span-bridge";
import { emitUsage, USAGE_EVENT } from "../events/usage";
import type { TelemetrySettings } from "../settings";
import { ConfiguredSampler } from "./configured-sampler";
import { ProbeFilteringSampler } from "./probe-filter";

/**
 * The structured lines as they are really written — by the channel's bridge,
 * inside a request whose span the ratio sent away — through each sampler a
 * deployed pipeline has. A count of refusals is only a count when every one
 * is there.
 */

/** Rounds to a rate of zero: every request here is one the ratio sends away. */
const RATIO = 0.0001;

/**
 * The sampler the distro installs when it is given a ratio. It is not one of
 * the package's entries, so it is read from beside the entry that is.
 */
const { ApplicationInsightsSampler: DistroSampler } = createRequire(
	import.meta.url,
)(
	join(
		dirname(
			createRequire(import.meta.url).resolve("@azure/monitor-opentelemetry"),
		),
		"traces",
		"sampler.js",
	),
) as { ApplicationInsightsSampler: new (ratio: number) => Sampler };

function settings() {
	return defineConfigKey<TelemetrySettings>({
		key: "telemetry-event-sampling",
		defaultValue: { samplingRatio: RATIO },
		parse: (_stored, fallback) => fallback,
		read: async () => null,
	});
}

const SAMPLERS: [string, () => Sampler][] = [
	["the Bun server's", () => new ConfiguredSampler(settings(), 60_000)],
	[
		"the distro's own, behind the probe filter, as the Next server runs it",
		() => new ProbeFilteringSampler(new DistroSampler(RATIO)),
	],
	[
		"one that does not record what the ratio sends away, behind the probe filter",
		() => new ProbeFilteringSampler(new ExporterSampler(RATIO)),
	],
];

const problems = defineProblemCodes(["sampling.test.refused"]);

let quiet: ReturnType<typeof spyOn>;

beforeEach(() => {
	quiet = spyOn(console, "log").mockImplementation(() => {});
	apiContext.setGlobalContextManager(
		new AsyncLocalStorageContextManager().enable(),
	);
});

afterEach(() => {
	unbridgeEvents();
	trace.disable();
	apiContext.disable();
	quiet.mockRestore();
});

test("the distro's sampler records a request the ratio sent away without sampling it, which is what the probe filter's parent rule reads", () => {
	const result = new DistroSampler(RATIO).shouldSample(
		ROOT_CONTEXT,
		"0af7651916cd43dd8448eb211c80319c",
		"GET /api/list",
		SpanKind.SERVER,
		{},
		[],
	);
	expect(result.decision).toBe(SamplingDecision.RECORD);
});

for (const [name, make] of SAMPLERS) {
	test(`${name}: every line written inside a request the ratio sent away is exported and counted once`, () => {
		const memory = new InMemorySpanExporter();
		const provider = new BasicTracerProvider({
			sampler: make(),
			spanProcessors: [new SimpleSpanProcessor(memory)],
		});
		trace.setGlobalTracerProvider(provider);
		bridgeEvents();
		const tracer = provider.getTracer("test");

		for (let i = 0; i < 200; i++) {
			const request = tracer.startSpan("GET /api/list", {
				kind: SpanKind.SERVER,
			});
			apiContext.with(trace.setSpan(apiContext.active(), request), () => {
				problems.report("sampling.test.refused", { status: 429 });
				emitUsage({
					kind: "chat",
					provider: "test",
					model: "small",
					durationMs: 1,
					inputTokens: 10,
					outputTokens: 3,
				});
				// A request whose handler is named like a line is still a request.
				tracer.startSpan(PROBLEM_EVENT, { kind: SpanKind.SERVER }).end();
			});
			request.end();
		}

		const exported = memory.getFinishedSpans();
		const lines = exported.filter((s) => s.kind === SpanKind.INTERNAL);
		expect(lines.filter((s) => s.name === PROBLEM_EVENT)).toHaveLength(200);
		expect(lines.filter((s) => s.name === USAGE_EVENT)).toHaveLength(200);
		expect(
			lines.every((s) => s.attributes["microsoft.sample_rate"] === 100),
		).toBe(true);
		// The requests themselves went where the ratio sent them.
		expect(exported.filter((s) => s.kind === SpanKind.SERVER)).toHaveLength(0);
	});
}
