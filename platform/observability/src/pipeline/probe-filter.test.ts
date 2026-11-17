import { describe, expect, test } from "bun:test";
import { ApplicationInsightsSampler } from "@azure/monitor-opentelemetry-exporter";
import {
	context as apiContext,
	INVALID_TRACEID,
	type SpanContext,
	SpanKind,
	TraceFlags,
	trace,
} from "@opentelemetry/api";
import {
	BasicTracerProvider,
	type ReadableSpan,
	type Sampler,
	SamplingDecision,
	type SpanProcessor,
} from "@opentelemetry/sdk-trace-base";
import { installProbeFilter, ProbeFilteringSampler } from "./probe-filter";
import { ScrubbingSpanProcessor } from "./span-processor";

/**
 * The probe filter against a real tracer pipeline: `BasicTracerProvider` is
 * the class the distro builds its provider from and `ApplicationInsightsSampler`
 * the sampler it installs, so this is the deployed pipeline with a list where
 * the exporter would be. The assertion that matters is that a probe span never
 * reaches a processor's `onEnd` at all.
 *
 * The attribute bags are what the framework really sets when it starts a
 * request span: `http.target` and the `next.*` markers, with `next.route` and
 * `http.route` arriving only at the end — too late for a sampling decision.
 *
 * One file, a little over the usual length: every case below needs the same
 * assembled pipeline, and splitting them would copy the assembly.
 */

function recorder(): { seen: ReadableSpan[]; processor: SpanProcessor } {
	const seen: ReadableSpan[] = [];
	return {
		seen,
		processor: {
			onStart: () => {},
			onEnd: (s) => {
				seen.push(s);
			},
			forceFlush: () => Promise.resolve(),
			shutdown: () => Promise.resolve(),
		},
	};
}

function frameworkRequest(target: string): Record<string, string> {
	return {
		"next.span_category": "nextjs",
		"next.span_name": "GET",
		"next.span_type": "BaseServer.handleRequest",
		"http.method": "GET",
		"http.target": target,
	};
}

function pipeline(options: { ratio?: number; scrub?: boolean } = {}) {
	const { seen, processor } = recorder();
	const provider = new BasicTracerProvider({
		sampler: new ApplicationInsightsSampler(options.ratio ?? 1),
		spanProcessors: options.scrub
			? [new ScrubbingSpanProcessor(), processor]
			: [processor],
	});
	// A tracer copies the sampler out when constructed, and the real sequence
	// has instrumentations holding tracers before the filter is installed.
	provider.getTracer("next.js", "0.0.1");
	const installed = installProbeFilter(provider);
	return { seen, provider, installed };
}

function request(provider: BasicTracerProvider, target: string): void {
	provider
		.getTracer("next.js", "0.0.1")
		.startSpan("GET", {
			kind: SpanKind.SERVER,
			attributes: frameworkRequest(target),
		})
		.end();
}

const PROBE_ROUTES = [
	"/health",
	"/healthz",
	"/favicon.ico",
	"/health?probe=1",
	"/_next/static/chunks/main-0e1f2a.js",
];
const REAL_ROUTES = ["/", "/api/list", "/api/session", "/healthcheck"];

describe("the framework's own request spans", () => {
	test("a probe never reaches a span processor; a real route still does", () => {
		const { seen, provider, installed } = pipeline();
		expect(installed).toBe(true);
		for (const route of PROBE_ROUTES) request(provider, route);
		expect(seen).toHaveLength(0);
		for (const route of REAL_ROUTES) request(provider, route);
		expect(seen.map((s) => s.attributes["http.target"])).toEqual(REAL_ROUTES);
	});

	test("without the filter they all get through — which is the bug", () => {
		const { seen, processor } = recorder();
		const provider = new BasicTracerProvider({
			sampler: new ApplicationInsightsSampler(1),
			spanProcessors: [processor],
		});
		for (const route of PROBE_ROUTES) request(provider, route);
		expect(seen).toHaveLength(PROBE_ROUTES.length);
	});

	test("a route named only by `next.route` is caught too", () => {
		const { seen, provider } = pipeline();
		provider
			.getTracer("next.js", "0.0.1")
			.startSpan("GET /health", {
				attributes: { "next.span_category": "nextjs", "next.route": "/health" },
			})
			.end();
		expect(seen).toHaveLength(0);
	});
});

describe("what a probe drags with it", () => {
	test("the spans opened underneath a probe go too; under a real request they stay", () => {
		const { seen, provider } = pipeline();
		const tracer = provider.getTracer("next.js", "0.0.1");
		for (const [target, expected] of [
			["/health", 0],
			["/api/list", 2],
		] as const) {
			const parent = tracer.startSpan("GET", {
				kind: SpanKind.SERVER,
				attributes: frameworkRequest(target),
			});
			const ctx = trace.setSpan(apiContext.active(), parent);
			tracer
				.startSpan(
					"startResponse",
					{ attributes: { "next.span_category": "nextjs" } },
					ctx,
				)
				.end();
			parent.end();
			expect(seen).toHaveLength(expected);
		}
	});

	test("an unsampled REMOTE parent condemns nothing", () => {
		const { seen, provider } = pipeline();
		const remote: SpanContext = {
			traceId: "b7ad6b7169203331a1e1b2c3d4e5f607",
			spanId: "00f067aa0ba902b7",
			traceFlags: TraceFlags.NONE,
			isRemote: true,
		};
		const ctx = trace.setSpanContext(apiContext.active(), remote);
		provider
			.getTracer("next.js", "0.0.1")
			.startSpan("GET", { attributes: frameworkRequest("/api/list") }, ctx)
			.end();
		expect(seen).toHaveLength(1);
	});
});

describe("the ratio the operator tunes", () => {
	test("the wrapped sampler still decides everything that is not a probe", () => {
		const { seen, provider } = pipeline({ ratio: 0 });
		request(provider, "/api/list");
		expect(seen).toHaveLength(0);
	});

	test("a parent the ratio dropped does not condemn its children", () => {
		// The distro's sampler answers RECORD, not NOT_RECORD, for a span the
		// ratio sends away; the descendant rule must leave that to the ratio.
		const { seen, processor } = recorder();
		const distroShaped: Sampler = {
			shouldSample: () => ({ decision: SamplingDecision.RECORD }),
		};
		const provider = new BasicTracerProvider({
			sampler: distroShaped,
			spanProcessors: [processor],
		});
		expect(installProbeFilter(provider)).toBe(true);
		const tracer = provider.getTracer("next.js", "0.0.1");
		const parent = tracer.startSpan("GET", {
			attributes: frameworkRequest("/api/list"),
		});
		expect(parent.isRecording()).toBe(true);
		tracer
			.startSpan(
				"startResponse",
				{},
				trace.setSpan(apiContext.active(), parent),
			)
			.end();
		parent.end();
		expect(seen).toHaveLength(2);
	});

	test("a ratio below 1 gets exactly the answer it would have got alone", () => {
		// Decision and attributes: `microsoft.sample_rate` rides on the latter.
		// Driven with fixed trace ids, since the answer is a hash of the id.
		const bare = new ApplicationInsightsSampler(0.5);
		const filtered = new ProbeFilteringSampler(
			new ApplicationInsightsSampler(0.5),
		);
		for (const traceId of [
			"b7ad6b7169203331a1e1b2c3d4e5f607",
			"0af7651916cd43dd8448eb211c80319c",
			"4bf92f3577b34da6a3ce929d0e0e4736",
		]) {
			const ask = (sampler: Sampler) =>
				sampler.shouldSample(
					apiContext.active(),
					traceId,
					"GET",
					SpanKind.SERVER,
					frameworkRequest("/api/list"),
					[],
				);
			expect(ask(filtered)).toEqual(ask(bare));
		}
	});

	test("the delegate is passed through untouched, and never asked about a probe", () => {
		let asked = 0;
		const delegate: Sampler = {
			shouldSample: () => {
				asked++;
				return {
					decision: SamplingDecision.RECORD_AND_SAMPLED,
					attributes: { marker: "from the delegate" },
				};
			},
		};
		const filter = new ProbeFilteringSampler(delegate);
		const ask = (target: string) =>
			filter.shouldSample(
				apiContext.active(),
				INVALID_TRACEID,
				"GET",
				SpanKind.SERVER,
				frameworkRequest(target),
				[],
			);
		expect(ask("/api/list").attributes).toEqual({
			marker: "from the delegate",
		});
		expect(ask("/healthz").decision).toBe(SamplingDecision.NOT_RECORD);
		expect(asked).toBe(1);
	});
});

describe("the scrubber, still in the pipeline behind it", () => {
	test("a kept span is scrubbed and renamed as before", () => {
		const { seen, provider } = pipeline({ scrub: true });
		provider
			.getTracer("next.js", "0.0.1")
			.startSpan("GET", {
				kind: SpanKind.SERVER,
				attributes: {
					"http.request.method": "GET",
					"http.route": "/api/list/6f1c2b7e-9f0a-4d2e-b3c1-8a5e2f0d7c44",
					"url.full":
						"https://app.example.test/api/list/6f1c2b7e-9f0a-4d2e-b3c1-8a5e2f0d7c44?token=secret",
					"url.query": "token=secret",
					"client.address": "203.0.113.7",
				},
			})
			.end();
		const kept = seen[0] as ReadableSpan;
		expect(kept.name).toBe("GET /api/list/:id");
		expect(kept.attributes["client.address"]).toBeUndefined();
		expect(kept.attributes["url.query"]).toBeUndefined();
		expect(String(kept.attributes["url.full"])).not.toContain("secret");
	});
});

describe("installing it", () => {
	test("a shape it does not recognise is left alone", () => {
		expect(installProbeFilter({ getTracer: () => ({}) } as never)).toBe(false);
	});

	test("it unwraps the API's proxy provider", () => {
		const { processor } = recorder();
		const real = new BasicTracerProvider({
			sampler: new ApplicationInsightsSampler(1),
			spanProcessors: [processor],
		});
		expect(
			installProbeFilter({
				getDelegate: () => real,
				getTracer: real.getTracer,
			} as never),
		).toBe(true);
	});

	test("a second call does not stack a second filter", () => {
		const { provider } = pipeline();
		expect(installProbeFilter(provider)).toBe(true);
		const holder = provider as unknown as {
			_tracerOptions: { sampler: ProbeFilteringSampler };
		};
		expect(holder._tracerOptions.sampler).toBeInstanceOf(ProbeFilteringSampler);
		expect(holder._tracerOptions.sampler.delegate).toBeInstanceOf(
			ApplicationInsightsSampler,
		);
	});

	test("a probe gets a context to propagate but no span to export", () => {
		const { seen, provider } = pipeline();
		const span = provider
			.getTracer("next.js", "0.0.1")
			.startSpan("GET", { attributes: frameworkRequest("/healthz") });
		expect(span.isRecording()).toBe(false);
		expect(span.spanContext().traceFlags & TraceFlags.SAMPLED).toBe(0);
		span.end();
		expect(seen).toHaveLength(0);
	});
});
