import { AzureMonitorTraceExporter } from "@azure/monitor-opentelemetry-exporter";
import {
	context,
	propagation,
	SpanKind,
	SpanStatusCode,
	type TextMapGetter,
	trace,
} from "@opentelemetry/api";
import { AsyncLocalStorageContextManager } from "@opentelemetry/context-async-hooks";
import { W3CTraceContextPropagator } from "@opentelemetry/core";
import { resourceFromAttributes } from "@opentelemetry/resources";
import {
	BasicTracerProvider,
	BatchSpanProcessor,
	type SpanExporter,
} from "@opentelemetry/sdk-trace-base";
import { processSingleton, reportFailure } from "@platform/config";
import { bridgeEvents, unbridgeEvents } from "./events";
import { ConfiguredSampler, ScrubbingSpanProcessor } from "./pipeline";
import {
	isProbePath,
	pathOf,
	redactPath,
	registerProbePaths,
	spanNameFor,
} from "./scrub";
import { connectionString, telemetrySettings } from "./settings";

/**
 * Telemetry for a server on `Bun.serve`.
 *
 * Not auto-instrumentation: the HTTP instrumentation patches `node:http`,
 * which `Bun.serve` never goes through, so it would capture nothing here. This
 * is the exporter, which patches nothing, plus one span per request opened by
 * {@link withRequestSpan} around the fetch handler. What that gives up is
 * automatic client spans for the database and the cache; a call worth timing
 * is wrapped by hand. What it keeps is the request span, the trace id, and
 * continuity with a trace a caller started.
 *
 * Off unless configured: without a connection string or an exporter handed
 * in, {@link startBunTelemetry} builds nothing and {@link withRequestSpan}
 * hands the request straight to the handler.
 */

export interface BunTelemetryOptions {
	/** `cloud_RoleName` in the portal. One per service. */
	serviceName: string;
	/** The image tag, when the process knows it. */
	serviceVersion?: string;
	/** Paths this service treats as probes, beyond the defaults. */
	probePaths?: string[];
	/** Where spans go. Defaults to Azure Monitor under the connection string; a test passes an in-memory one. */
	exporter?: SpanExporter;
}

/**
 * Per process, so a development server's module re-evaluation does not build
 * a second provider with a second exporter competing with the first.
 */
interface Pipeline {
	provider?: BasicTracerProvider;
}

function pipeline(): Pipeline {
	return processSingleton<Pipeline>("observability:bun-pipeline", () => ({}));
}

/**
 * Build the trace pipeline, or do nothing. Idempotent; never throws — a
 * pipeline that will not build is a line on stderr, not a service that will
 * not start.
 *
 * @returns whether telemetry is running.
 */
export function startBunTelemetry(options: BunTelemetryOptions): boolean {
	const held = pipeline();
	if (held.provider) return true;
	const connection = connectionString();
	if (!connection && !options.exporter) return false;

	try {
		const exporter =
			options.exporter ??
			new AzureMonitorTraceExporter({ connectionString: connection });
		const provider = new BasicTracerProvider({
			resource: resourceFromAttributes({
				"service.name": options.serviceName,
				...(options.serviceVersion
					? { "service.version": options.serviceVersion }
					: {}),
			}),
			sampler: new ConfiguredSampler(),
			spanProcessors: [
				new ScrubbingSpanProcessor({
					delegate: new BatchSpanProcessor(exporter),
				}),
			],
		});
		registerProbePaths(options.probePaths ?? []);

		// Without a context manager a span opened around the handler is not the
		// active span inside it and nothing nests.
		context.setGlobalContextManager(
			new AsyncLocalStorageContextManager().enable(),
		);
		propagation.setGlobalPropagator(new W3CTraceContextPropagator());
		trace.setGlobalTracerProvider(provider);
		held.provider = provider;

		bridgeEvents();
		// Warm the sampling memo so the first request is sampled against the
		// operator's value; detached, so a slow store never delays accepting.
		void telemetrySettings().read();
		return true;
	} catch (err) {
		reportFailure(
			"observability",
			"telemetry failed to start — continuing without it",
			err,
		);
		return false;
	}
}

export function telemetryRunning(): boolean {
	return pipeline().provider !== undefined;
}

/** Reads a W3C `traceparent` off an incoming request's headers. */
const HEADER_GETTER: TextMapGetter<Headers> = {
	keys: (headers) => Array.from(headers.keys()),
	get: (headers, key) => headers.get(key) ?? undefined,
};

/**
 * Wrap a fetch handler so each request gets a server span. Generic over the
 * handler's extra arguments so a router's `fetch(request, env, ctx)` and a
 * bare `fetch(request)` share one wrapper.
 *
 * It records the redacted path, never the raw URL; opens no span for a probe;
 * and never fails a request — a throw from the handler is recorded and
 * re-thrown unchanged. A 4xx is the gate working and is not an error; a 5xx
 * is.
 */
export function withRequestSpan<A extends unknown[]>(
	handler: (req: Request, ...rest: A) => Response | Promise<Response>,
): (req: Request, ...rest: A) => Promise<Response> {
	return async (req, ...rest) => {
		if (!telemetryRunning()) return await handler(req, ...rest);
		const path = pathOf(req.url);
		if (isProbePath(path)) return await handler(req, ...rest);

		const route = redactPath(path);
		const parent = propagation.extract(
			context.active(),
			req.headers,
			HEADER_GETTER,
		);
		return await trace.getTracer("platform.http").startActiveSpan(
			spanNameFor(req.method, route),
			{
				kind: SpanKind.SERVER,
				attributes: {
					"http.request.method": req.method,
					"url.path": route,
					"url.scheme": req.url.startsWith("https:") ? "https" : "http",
				},
			},
			parent,
			async (span) => {
				try {
					const response = await handler(req, ...rest);
					span.setAttribute("http.response.status_code", response.status);
					if (response.status >= 500)
						span.setStatus({ code: SpanStatusCode.ERROR });
					return response;
				} catch (err) {
					span.recordException(err as Error);
					span.setStatus({
						code: SpanStatusCode.ERROR,
						message: err instanceof Error ? err.message : String(err),
					});
					throw err;
				} finally {
					span.end();
				}
			},
		);
	};
}

/**
 * Name the route the request actually matched, once the router knows it. The
 * wrapper can only guess a route from the path; two different routes can
 * redact to the same guess. A no-op without an active span.
 */
export function recordRoute(method: string, route: string): void {
	const span = trace.getActiveSpan();
	if (!span) return;
	span.setAttribute("http.route", route);
	span.updateName(spanNameFor(method, route));
}

/**
 * Push whatever is queued, and stop. A batch processor holds spans for
 * seconds before it sends them, and `process.exit` after a drain would lose
 * the traces of exactly the requests in flight during a revision swap — so a
 * service calls this from its signal handler once the server has stopped
 * accepting. Never throws, and never holds the exit longer than
 * `STOP_DEADLINE_MS` for each of the flush and the shutdown: an ingestion
 * endpoint that does not answer must not outlast the platform's grace period.
 */
const STOP_DEADLINE_MS = 5_000;

/** `work`, or a rejection once the stop's deadline has passed. */
async function within(work: Promise<void>, step: string): Promise<void> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		await Promise.race([
			work,
			new Promise<never>((_resolve, reject) => {
				timer = setTimeout(
					() =>
						reject(
							new Error(`the ${step} did not finish in ${STOP_DEADLINE_MS}ms`),
						),
					STOP_DEADLINE_MS,
				);
			}),
		]);
	} finally {
		clearTimeout(timer);
	}
}

export async function stopTelemetry(): Promise<void> {
	const held = pipeline();
	const provider = held.provider;
	if (!provider) return;
	held.provider = undefined;
	unbridgeEvents();
	try {
		await within(provider.forceFlush(), "flush");
	} catch (err) {
		reportFailure("observability", "flush on shutdown failed", err);
	}
	try {
		await within(provider.shutdown(), "shutdown");
	} catch (err) {
		reportFailure("observability", "telemetry shutdown failed", err);
	}
	trace.disable();
	propagation.disable();
	context.disable();
}
