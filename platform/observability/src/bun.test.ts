import { afterAll, beforeAll, describe, expect, spyOn, test } from "bun:test";
import { SpanKind, SpanStatusCode } from "@opentelemetry/api";
import {
	InMemorySpanExporter,
	type ReadableSpan,
	type SpanExporter,
} from "@opentelemetry/sdk-trace-base";
import {
	recordRoute,
	startBunTelemetry,
	stopTelemetry,
	telemetryRunning,
	withRequestSpan,
} from "./bun";
import { defineProblemCodes } from "./events";
import { resetProbePaths } from "./scrub";
import { CONNECTION_STRING_VAR } from "./settings";

/**
 * The Bun pipeline end to end, with memory where Azure would be. The batch
 * processor is real, so what reaches the exporter is what `stopTelemetry`
 * flushed — which is the guarantee a signal handler relies on.
 */

/** Keeps its spans across the shutdown that `stopTelemetry` performs. */
function memoryExporter(): {
	memory: InMemorySpanExporter;
	exporter: SpanExporter;
} {
	const memory = new InMemorySpanExporter();
	return {
		memory,
		exporter: {
			export: (spans, done) => memory.export(spans, done),
			shutdown: async () => {},
			forceFlush: async () => {},
		},
	};
}

const problems = defineProblemCodes(["list.refused.forbidden"]);
const saved = process.env[CONNECTION_STRING_VAR];
let warn: ReturnType<typeof spyOn>;
let log: ReturnType<typeof spyOn>;

beforeAll(() => {
	delete process.env[CONNECTION_STRING_VAR];
	// No store in a test: the sampler's refresh is served the default and says so once.
	warn = spyOn(console, "warn").mockImplementation(() => {});
	log = spyOn(console, "log").mockImplementation(() => {});
});

afterAll(async () => {
	await stopTelemetry();
	resetProbePaths();
	warn.mockRestore();
	log.mockRestore();
	if (saved === undefined) delete process.env[CONNECTION_STRING_VAR];
	else process.env[CONNECTION_STRING_VAR] = saved;
});

describe("off unless configured", () => {
	test("without a connection string or an exporter nothing starts, and the wrapper is a pass-through", async () => {
		expect(startBunTelemetry({ serviceName: "test" })).toBe(false);
		expect(telemetryRunning()).toBe(false);
		const response = await withRequestSpan(
			async () => new Response(null, { status: 204 }),
		)(new Request("http://localhost/api/list"));
		expect(response.status).toBe(204);
	});
});

describe("the pipeline", () => {
	const { memory, exporter } = memoryExporter();
	const finished = (): ReadableSpan[] => memory.getFinishedSpans();
	const request = (url: string, headers: Record<string, string> = {}) =>
		new Request(url, { headers });

	test("starts once with an exporter, serves requests, and flushes on stop", async () => {
		expect(
			startBunTelemetry({
				serviceName: "test",
				exporter,
				probePaths: ["/api/warm"],
			}),
		).toBe(true);
		expect(startBunTelemetry({ serviceName: "other", exporter })).toBe(true);
		expect(telemetryRunning()).toBe(true);

		const handle = withRequestSpan(async (req: Request, status: number) => {
			if (req.url.endsWith("/forbidden"))
				problems.report("list.refused.forbidden", { status: 403 });
			if (req.url.includes("/named/")) recordRoute("GET", "/api/named/:slug");
			if (status === 0) throw new Error("boom");
			return new Response(null, { status });
		});

		expect(
			(
				await handle(
					request("http://localhost/api/list/8412?token=secret"),
					200,
				)
			).status,
		).toBe(200);
		expect((await handle(request("http://localhost/health"), 200)).status).toBe(
			200,
		);
		expect(
			(await handle(request("http://localhost/api/warm"), 200)).status,
		).toBe(200);
		expect(
			(await handle(request("http://localhost/api/list"), 503)).status,
		).toBe(503);
		await expect(
			handle(request("http://localhost/api/list"), 0),
		).rejects.toThrow("boom");
		await handle(request("http://localhost/api/forbidden"), 403);
		await handle(request("http://localhost/api/named/some-slug"), 200);
		await handle(
			request("https://localhost/api/list", {
				traceparent: "00-b7ad6b7169203331a1e1b2c3d4e5f607-00f067aa0ba902b7-01",
			}),
			200,
		);

		// Nothing has left the batch processor yet; the stop is the flush.
		expect(finished()).toHaveLength(0);
		await stopTelemetry();
		expect(telemetryRunning()).toBe(false);

		const servers = finished().filter((s) => s.kind === SpanKind.SERVER);
		expect(servers.map((s) => s.name)).toEqual([
			"GET /api/list/:id",
			"GET /api/list",
			"GET /api/list",
			"GET /api/forbidden",
			"GET /api/named/:slug",
			"GET /api/list",
		]);
		const recorded = JSON.stringify(servers.map((s) => [s.name, s.attributes]));
		expect(recorded).not.toContain("secret");
		expect(recorded).not.toContain("8412");
		expect(servers[0]?.attributes).toMatchObject({
			"http.request.method": "GET",
			"url.path": "/api/list/:id",
			"url.scheme": "http",
			"http.response.status_code": 200,
		});
		expect(servers[0]?.status.code).toBe(SpanStatusCode.UNSET);
		expect(servers[1]?.status.code).toBe(SpanStatusCode.ERROR);
		expect(servers[2]?.status.code).toBe(SpanStatusCode.ERROR);
		expect(servers[2]?.events.map((e) => e.name)).toEqual(["exception"]);
		expect(servers[4]?.attributes["http.route"]).toBe("/api/named/:slug");
		expect(servers[5]?.spanContext().traceId).toBe(
			"b7ad6b7169203331a1e1b2c3d4e5f607",
		);
		expect(servers[5]?.parentSpanContext?.spanId).toBe("00f067aa0ba902b7");
		expect(servers[5]?.attributes["url.scheme"]).toBe("https");

		const problem = finished().find((s) => s.name === "problem");
		expect(problem?.attributes["problem.code"]).toBe("list.refused.forbidden");
		expect(problem?.parentSpanContext?.spanId).toBe(
			servers[3]?.spanContext().spanId,
		);
	});

	test("after the stop the wrapper is a pass-through again, and a fresh start builds anew", async () => {
		const response = await withRequestSpan(
			async () => new Response(null, { status: 204 }),
		)(request("http://localhost/api/list"));
		expect(response.status).toBe(204);
		const again = memoryExporter();
		expect(
			startBunTelemetry({ serviceName: "test", exporter: again.exporter }),
		).toBe(true);
		await stopTelemetry();
		expect(again.memory.getFinishedSpans()).toHaveLength(0);
	});
});
