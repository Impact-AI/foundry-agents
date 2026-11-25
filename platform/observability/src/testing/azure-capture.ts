/**
 * What Azure Monitor's exporter sends, as `release.test.ts` reads it:
 *
 *   bun azure-capture.ts <certificate.pem> <key.pem>
 *
 * The Bun pipeline with the real exporter, its ingestion endpoint a TLS
 * receiver on this machine (the exporter speaks HTTPS only, so the process
 * runs with NODE_TLS_REJECT_UNAUTHORIZED=0 and that certificate), a release
 * handed in as the backend hands it. One request, a flush on stop, and the
 * envelopes the exporter posted, printed as JSON.
 */
import { readFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import { startBunTelemetry, stopTelemetry, withRequestSpan } from "../bun";
import { CONNECTION_STRING_VAR } from "../settings";

const [certificate, key] = process.argv.slice(2);
if (!certificate || !key) {
	console.error("azure-capture: <certificate.pem> <key.pem>");
	process.exit(2);
}

const envelopes: unknown[] = [];
const ingestion = Bun.serve({
	port: 0,
	hostname: "127.0.0.1",
	tls: { cert: readFileSync(certificate), key: readFileSync(key) },
	async fetch(request) {
		let body = Buffer.from(await request.arrayBuffer());
		if (request.headers.get("content-encoding") === "gzip")
			body = gunzipSync(body);
		const sent = JSON.parse(body.toString()) as unknown;
		envelopes.push(...(Array.isArray(sent) ? sent : [sent]));
		return Response.json({ itemsReceived: 1, itemsAccepted: 1, errors: [] });
	},
});

process.env[CONNECTION_STRING_VAR] =
	`InstrumentationKey=00000000-0000-0000-0000-000000000000;IngestionEndpoint=https://127.0.0.1:${ingestion.port}/`;
const started = startBunTelemetry({
	serviceName: "assistant-backend",
	serviceVersion: "v12-4f2a9c1",
	release: {
		id: "rel_0123456789abcdef01234567",
		version: "12",
		environment: "development",
		revision: "ca-backend-abc--v12",
	},
});
await withRequestSpan(async () => new Response(null, { status: 200 }))(
	new Request("http://localhost/api/conversations"),
);
await stopTelemetry();
for (let waited = 0; envelopes.length === 0 && waited < 10_000; waited += 100)
	await Bun.sleep(100);

console.log(JSON.stringify({ started, envelopes }));
ingestion.stop(true);
process.exit(0);
