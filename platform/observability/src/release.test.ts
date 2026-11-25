import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BasicTracerProvider } from "@opentelemetry/sdk-trace-base";
import {
	CONTAINER_APPS_CLOUD,
	ReleaseStampProcessor,
	releaseStamp,
	resourceAttributes,
} from "./release";

const RELEASE = {
	id: "rel_0123456789abcdef01234567",
	version: "12",
	environment: "development",
	revision: "ca-backend-abc--azd-1764064023",
};

test("every span starts with the stamp as attributes of its own, and nothing is added outside a release", () => {
	const stamped = new BasicTracerProvider({
		spanProcessors: [new ReleaseStampProcessor(RELEASE)],
	});
	const span = stamped.getTracer("t").startSpan("GET /x", {
		attributes: { "http.request.method": "GET" },
	});
	expect(
		(span as unknown as { attributes: Record<string, unknown> }).attributes,
	).toEqual({ "http.request.method": "GET", ...releaseStamp(RELEASE) });
	span.end();
	const bare = new BasicTracerProvider({
		spanProcessors: [new ReleaseStampProcessor(undefined)],
	})
		.getTracer("t")
		.startSpan("GET /x");
	expect(
		(bare as unknown as { attributes: Record<string, unknown> }).attributes,
	).toEqual({});
	bare.end();
});

test("a released process on Container Apps carries the whole stamp, and its version is the release's", () => {
	expect(
		resourceAttributes({
			serviceName: "assistant-backend",
			serviceVersion: "v12-4f2a9c1",
			release: RELEASE,
		}),
	).toEqual({
		"service.name": "assistant-backend",
		"service.version": "12",
		"impact.release.id": RELEASE.id,
		"impact.release.version": "12",
		"impact.release.revision": RELEASE.revision,
		"deployment.environment.name": "development",
		"cloud.provider": "azure",
		"cloud.platform": "azure_container_apps",
	});
	expect(CONTAINER_APPS_CLOUD).toEqual({
		provider: "azure",
		platform: "azure_container_apps",
	});
});

test("outside a release the version stays the image's tag, and nothing empty is sent", () => {
	expect(
		resourceAttributes({
			serviceName: "frontend",
			serviceVersion: "azd-deploy-1764064023",
			release: { id: "", version: " ", environment: undefined },
		}),
	).toEqual({
		"service.name": "frontend",
		"service.version": "azd-deploy-1764064023",
	});
	expect(resourceAttributes({ serviceName: "frontend" })).toEqual({
		"service.name": "frontend",
	});
});

test("only a process Container Apps runs, which names its revision, claims the cloud", () => {
	const { revision: _, ...offPlatform } = RELEASE;
	const attributes = resourceAttributes({
		serviceName: "frontend",
		release: offPlatform,
	});
	expect(attributes["impact.release.id"]).toBe(RELEASE.id);
	expect(attributes).not.toHaveProperty("cloud.provider");
	expect(attributes).not.toHaveProperty("cloud.platform");
	expect(attributes).not.toHaveProperty("impact.release.revision");
	// A revision with no release is still the platform's.
	expect(
		resourceAttributes({
			serviceName: "frontend",
			release: { revision: RELEASE.revision },
		}),
	).toMatchObject({
		"impact.release.revision": RELEASE.revision,
		"cloud.platform": "azure_container_apps",
	});
});

/**
 * What Azure Monitor's exporter, as installed, sends for one request of a
 * released process: a fixture runs the Bun pipeline against an ingestion
 * endpoint on this machine. The exporter speaks HTTPS only, so the endpoint
 * takes a certificate made here, which needs openssl.
 */
type Envelope = {
	name: string;
	tags: Record<string, string>;
	data: {
		baseType: string;
		baseData: {
			properties?: Record<string, string>;
			metrics?: { name: string }[];
		};
	};
};

const withOpenssl = test.skipIf(!Bun.which("openssl"));

withOpenssl(
	"Application Insights gets the stamp on every request row, as its own dimensions, and the release's version as the application's",
	() => {
		const dir = mkdtempSync(join(tmpdir(), "azure-capture-"));
		try {
			const made = Bun.spawnSync(
				[
					"openssl",
					"req",
					"-x509",
					"-newkey",
					"rsa:2048",
					"-nodes",
					"-keyout",
					join(dir, "key.pem"),
					"-out",
					join(dir, "cert.pem"),
					"-days",
					"1",
					"-subj",
					"/CN=127.0.0.1",
					"-addext",
					"subjectAltName=IP:127.0.0.1",
				],
				{ stderr: "pipe" },
			);
			expect(made.exitCode).toBe(0);
			const run = Bun.spawnSync(
				[
					process.execPath,
					join(import.meta.dir, "testing", "azure-capture.ts"),
					join(dir, "cert.pem"),
					join(dir, "key.pem"),
				],
				{
					env: {
						...process.env,
						NODE_TLS_REJECT_UNAUTHORIZED: "0",
						APPLICATIONINSIGHTS_STATSBEAT_DISABLED_ALL: "true",
					},
					stderr: "pipe",
				},
			);
			expect(run.exitCode, run.stderr.toString()).toBe(0);
			const { started, envelopes } = JSON.parse(run.stdout.toString()) as {
				started: boolean;
				envelopes: Envelope[];
			};
			expect(started).toBe(true);
			const request = envelopes.find((e) => e.data.baseType === "RequestData");
			expect(request?.data.baseData.properties).toEqual({
				"impact.release.id": RELEASE.id,
				"impact.release.version": "12",
				"impact.release.revision": "ca-backend-abc--v12",
				"deployment.environment.name": "development",
				"cloud.provider": "azure",
				"cloud.platform": "azure_container_apps",
			});
			expect(request?.tags["ai.application.ver"]).toBe("12");
			expect(request?.tags["ai.cloud.role"]).toBe("assistant-backend");
			// The resource's other attributes reach Application Insights only as
			// one metric row per export, which no span row points to.
			const resource = envelopes.find((e) =>
				e.data.baseData.metrics?.some((m) => m.name === "_OTELRESOURCE_"),
			);
			expect(resource?.data.baseData.properties?.["impact.release.id"]).toBe(
				RELEASE.id,
			);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	},
	60_000,
);
