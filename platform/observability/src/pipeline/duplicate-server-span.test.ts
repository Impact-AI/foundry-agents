import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
	context as apiContext,
	ROOT_CONTEXT,
	SpanKind,
	TraceFlags,
	trace,
} from "@opentelemetry/api";
import { AsyncLocalStorageContextManager } from "@opentelemetry/context-async-hooks";
import {
	BasicTracerProvider,
	InMemorySpanExporter,
	SimpleSpanProcessor,
} from "@opentelemetry/sdk-trace-base";
import { ScrubbingSpanProcessor } from "./span-processor";

/**
 * One request, one request row — against a real provider, because parentage
 * cannot honestly be faked. The two spans are the two producers a Next
 * process runs: the HTTP instrumentation's, carrying the status written to the
 * socket, and the framework's own request span nested inside it.
 */
const FRAMEWORK_REQUEST = {
	"next.span_category": "nextjs",
	"next.span_name": "POST",
	"next.span_type": "BaseServer.handleRequest",
};

function serve(
	provider: BasicTracerProvider,
	options: { httpSpan?: boolean; nested?: number } = {},
): void {
	const { httpSpan = true, nested = 1 } = options;
	const tracer = provider.getTracer("test");
	const inner = () => {
		for (let i = 0; i < nested; i++)
			tracer
				.startSpan("POST", {
					kind: SpanKind.SERVER,
					attributes: FRAMEWORK_REQUEST,
				})
				.end();
	};
	if (!httpSpan) {
		inner();
		return;
	}
	const http = tracer.startSpan("POST /api/session", {
		kind: SpanKind.SERVER,
		attributes: { "http.request.method": "POST", "http.route": "/api/session" },
	});
	apiContext.with(trace.setSpan(apiContext.active(), http), inner);
	http.setAttribute("http.response.status_code", 401);
	http.end();
}

function pipeline(): {
	provider: BasicTracerProvider;
	exporter: InMemorySpanExporter;
} {
	const exporter = new InMemorySpanExporter();
	const provider = new BasicTracerProvider({
		spanProcessors: [
			new ScrubbingSpanProcessor(),
			new SimpleSpanProcessor(exporter),
		],
	});
	return { provider, exporter };
}

describe("two producers, one request", () => {
	beforeEach(() => {
		apiContext.setGlobalContextManager(
			new AsyncLocalStorageContextManager().enable(),
		);
	});
	afterEach(() => {
		apiContext.disable();
	});

	const servers = (exporter: InMemorySpanExporter) =>
		exporter.getFinishedSpans().filter((s) => s.kind === SpanKind.SERVER);

	test("only one exported span is a SERVER span, and it is the honest one", () => {
		const { provider, exporter } = pipeline();
		serve(provider);
		expect(servers(exporter)).toHaveLength(1);
		expect(servers(exporter)[0]?.attributes["http.response.status_code"]).toBe(
			401,
		);
	});

	test("the nested span survives in full, as a dependency rather than a request", () => {
		const { provider, exporter } = pipeline();
		serve(provider);
		const nested = exporter
			.getFinishedSpans()
			.find(
				(s) => s.attributes["next.span_type"] === "BaseServer.handleRequest",
			);
		expect(nested?.kind).toBe(SpanKind.INTERNAL);
		expect(nested?.attributes["next.span_category"]).toBe("nextjs");
		expect(nested?.attributes["_MS.ProcessedByMetricExtractors"]).toBe(
			"(Name:'Dependencies', Ver:'1.1')",
		);
	});

	test("a route that opens the nested span twice still yields one request", () => {
		const { provider, exporter } = pipeline();
		serve(provider, { nested: 2 });
		expect(servers(exporter)).toHaveLength(1);
		expect(exporter.getFinishedSpans()).toHaveLength(3);
	});

	test("where the HTTP span is absent, the framework's stays the request", () => {
		const { provider, exporter } = pipeline();
		serve(provider, { httpSpan: false });
		expect(servers(exporter)).toHaveLength(1);
		expect(servers(exporter)[0]?.attributes["next.span_type"]).toBe(
			"BaseServer.handleRequest",
		);
	});

	test("a genuine cross-service child is not demoted", () => {
		const { provider, exporter } = pipeline();
		const remote = trace.setSpanContext(ROOT_CONTEXT, {
			traceId: "b63e07147d297bccf20bd872f0a544ff",
			spanId: "1132d5172d622f4f",
			traceFlags: TraceFlags.SAMPLED,
			isRemote: true,
		});
		apiContext.with(remote, () => {
			provider
				.getTracer("test")
				.startSpan("POST /agent/run", { kind: SpanKind.SERVER })
				.end();
		});
		expect(servers(exporter)).toHaveLength(1);
	});

	test("a client span under a server span is untouched", () => {
		const { provider, exporter } = pipeline();
		const tracer = provider.getTracer("test");
		const http = tracer.startSpan("POST /api/session", {
			kind: SpanKind.SERVER,
		});
		apiContext.with(trace.setSpan(apiContext.active(), http), () => {
			tracer.startSpan("pg.query", { kind: SpanKind.CLIENT }).end();
		});
		http.end();
		const kinds = exporter.getFinishedSpans().map((s) => s.kind);
		expect(kinds.filter((k) => k === SpanKind.CLIENT)).toHaveLength(1);
		expect(kinds.filter((k) => k === SpanKind.SERVER)).toHaveLength(1);
	});
});
