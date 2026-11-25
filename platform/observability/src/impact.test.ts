import { afterAll, beforeAll, expect, spyOn, test } from "bun:test";
import { SpanKind } from "@opentelemetry/api";
import {
	InMemorySpanExporter,
	type SpanExporter,
} from "@opentelemetry/sdk-trace-base";
import {
	impactCopyRunning,
	startBunTelemetry,
	stopTelemetry,
	withRequestSpan,
} from "./bun";
import { impactSettings } from "./impact";
import { CONNECTION_STRING_VAR } from "./settings";

/**
 * The copy to impact.ai end to end on the Bun pipeline: the Impact SDK, as
 * installed, sending to an OTLP receiver on this machine, beside an
 * in-memory exporter where Azure Monitor would be.
 */

type Received = { path: string; authorization: string | null; body: string };
const received: Received[] = [];
const receiver = Bun.serve({
	port: 0,
	hostname: "127.0.0.1",
	async fetch(request) {
		received.push({
			path: new URL(request.url).pathname,
			authorization: request.headers.get("authorization"),
			// The protobuf body holds its strings as written.
			body: Buffer.from(await request.arrayBuffer()).toString("latin1"),
		});
		return new Response(new Uint8Array(0), {
			headers: { "content-type": "application/x-protobuf" },
		});
	},
});

const memory = new InMemorySpanExporter();
const exporter: SpanExporter = {
	export: (spans, done) => memory.export(spans, done),
	shutdown: async () => {},
	forceFlush: async () => {},
};

const saved = process.env[CONNECTION_STRING_VAR];
let warn: ReturnType<typeof spyOn>;
let log: ReturnType<typeof spyOn>;

beforeAll(() => {
	delete process.env[CONNECTION_STRING_VAR];
	warn = spyOn(console, "warn").mockImplementation(() => {});
	log = spyOn(console, "log").mockImplementation(() => {});
});

afterAll(async () => {
	await stopTelemetry();
	receiver.stop(true);
	warn.mockRestore();
	log.mockRestore();
	if (saved === undefined) delete process.env[CONNECTION_STRING_VAR];
	else process.env[CONNECTION_STRING_VAR] = saved;
});

const RELEASE = {
	id: "rel_0123456789abcdef01234567",
	version: "12",
	environment: "development",
	revision: "ca-backend-abc--azd-1764064023",
};

test("the copy needs both values, and the vault's placeholder is no key", () => {
	const endpoint = "https://ingest.example/v1/traces";
	expect(impactSettings({ endpoint, apiKey: " key " })).toEqual({
		endpoint,
		apiKey: "key",
	});
	expect(impactSettings({ endpoint, apiKey: "unset" })).toBeUndefined();
	expect(impactSettings({ endpoint })).toBeUndefined();
	expect(impactSettings({ apiKey: "key" })).toBeUndefined();
	expect(impactSettings(undefined)).toBeUndefined();
});

test("without impact.ai's values nothing is copied, and Azure Monitor's pipeline is what it was", async () => {
	expect(
		startBunTelemetry({
			serviceName: "test",
			exporter,
			impact: { endpoint: `http://127.0.0.1:${receiver.port}/v1/traces` },
		}),
	).toBe(true);
	expect(await impactCopyRunning()).toBe(false);
	await withRequestSpan(async () => new Response(null, { status: 204 }))(
		new Request("http://localhost/api/list"),
	);
	await stopTelemetry();
	expect(memory.getFinishedSpans().map((s) => s.name)).toEqual([
		"GET /api/list",
	]);
	expect(received).toEqual([]);
	memory.reset();
});

test("with both, every span the scrub hands on reaches Azure Monitor and impact.ai, stamped with the release, and a probe reaches neither", async () => {
	expect(
		startBunTelemetry({
			serviceName: "assistant-backend",
			serviceVersion: "v12-4f2a9c1",
			release: RELEASE,
			impact: {
				endpoint: `http://127.0.0.1:${receiver.port}/v1/traces`,
				apiKey: "ingest-key",
			},
			exporter,
		}),
	).toBe(true);
	expect(await impactCopyRunning()).toBe(true);

	const handle = withRequestSpan(
		async () => new Response(null, { status: 200 }),
	);
	await handle(new Request("http://localhost/api/list/8412?token=secret"));
	await handle(new Request("http://localhost/health"));
	await stopTelemetry();

	const azure = memory
		.getFinishedSpans()
		.filter((s) => s.kind === SpanKind.SERVER);
	expect(azure.map((s) => s.name)).toEqual(["GET /api/list/:id"]);
	expect(azure[0]?.resource.attributes).toMatchObject({
		"service.name": "assistant-backend",
		"service.version": "12",
		"impact.release.id": RELEASE.id,
		"impact.release.version": "12",
		"impact.release.revision": RELEASE.revision,
		"deployment.environment.name": "development",
		"cloud.provider": "azure",
		"cloud.platform": "azure_container_apps",
	});

	expect(received.length).toBeGreaterThan(0);
	for (const request of received) {
		expect(request.path).toBe("/v1/traces");
		expect(request.authorization).toBe("Bearer ingest-key");
	}
	const sent = received.map((r) => r.body).join("");
	for (const value of [
		"GET /api/list/:id",
		"impact.release.id",
		RELEASE.id,
		"impact.release.revision",
		RELEASE.revision,
		"deployment.environment.name",
		"azure_container_apps",
	])
		expect(sent).toContain(value);
	// What the scrub took out of the span never left for impact.ai either.
	expect(sent).not.toContain("secret");
	expect(sent).not.toContain("8412");
	expect(sent).not.toContain("/health");
});
