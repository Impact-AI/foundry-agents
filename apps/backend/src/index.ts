import { createFoundryAgentHost } from "@platform/agent/foundry";
import { assertDeploymentSafe } from "@platform/config/deployment-guard";
import { envInt } from "@platform/config/env";
import { closeCosmos, cosmosDeploymentRules } from "@platform/cosmos";
import { identityDeploymentRules } from "@platform/identity";
import { checkChunkIndex } from "@platform/knowledge";
import { stopTelemetry, withRequestSpan } from "@platform/observability/bun";
import {
	assertRedisReachable,
	closeRedis,
	closeSubscriber,
} from "@platform/redis";
import type { BrowserSocket } from "@platform/voice";
import { createApp } from "./app";
import { callerGateOpen } from "./auth/caller";
import { product } from "./product";
import { shutDown } from "./shutdown";
import { startWhenAdmitted } from "./startup";
import { wire } from "./wiring";

// Before anything is built: a production process without the control that
// keeps the gate closed crash-loops rather than serves. A no-op on a laptop.
assertDeploymentSafe([...identityDeploymentRules, ...cosmosDeploymentRules]);
// A cache that is configured and was never reachable is misconfiguration;
// the fallbacks every module names are for a Redis that goes away later.
await assertRedisReachable();
const host = createFoundryAgentHost(product);
const wiring = wire(product, host);
// What a first deploy's replica may meet before its role assignments have
// applied — Cosmos DB, the search index, the agent service — is waited for
// rather than crash-looped on, with the readiness route answering 503.
const startup = startWhenAdmitted(async () => {
	// A search service that is configured and cannot answer is
	// misconfiguration, as the cache is. The index itself is the job's
	// `index` step to make, with the indexer that fills it; a replica starts
	// without it and says so, since on a first deploy the app starts before
	// the job has run.
	if ((await checkChunkIndex()) === "awaiting-index")
		console.warn(
			"[backend] the search index does not exist yet: the job's index step makes it; every search fails until it has run",
		);
	await host.start();
});
const app = createApp({
	host,
	product,
	broker: wiring.broker,
	ready: startup.ready,
});

const server = Bun.serve<BrowserSocket>({
	fetch: withRequestSpan(app.fetch),
	port: envInt("PORT", 4111, { min: 1, max: 65535 }),
	// An open gate serves every route as one local account, so it is reachable
	// from this machine only; a closed one listens for the platform's ingress.
	hostname: callerGateOpen() ? "127.0.0.1" : "0.0.0.0",
	// A turn streams for longer than Bun's default; 255 s is its ceiling.
	idleTimeout: 255,
	// The browsers' live voice sockets, upgraded by `GET /voice/live`.
	websocket: wiring.broker.websocket,
});

// The platform sends SIGTERM on scale-in and on every revision swap: report
// not ready, tell every live session held here to reopen elsewhere and settle
// it after the grace, stop accepting and let the turns in flight finish —
// all of it inside a deadline the platform's grace covers — then stop the
// host, which ends what is still running, and close what was opened, each
// step inside its own share of that grace (`./shutdown`).
let draining = false;
async function shutdown(signal: string): Promise<void> {
	if (draining) return;
	draining = true;
	console.log(`[backend] ${signal} — draining`);
	await shutDown({
		drain: async () => {
			await wiring.broker.drain();
			await server.stop(false);
		},
		stop: () => host.stop(),
		close: [
			() => server.stop(true),
			() => wiring.stop(),
			() => closeSubscriber(),
			() => closeRedis(),
			() => closeCosmos(),
		],
		flush: stopTelemetry,
	});
	process.exit(0);
}
process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));

if (callerGateOpen())
	console.warn(
		"[backend] caller authentication is OFF: AUTH_SECRET is unset and this is neither a deployment nor the production image",
	);
console.log(
	`${product.serviceName} listening on ${server.hostname}:${server.port}${wiring.telemetry ? " (telemetry on)" : ""}`,
);
startup.run().then(
	() => void host.warmUp(),
	(err) => {
		console.error("[backend] the agent host failed to start:", err);
		process.exit(1);
	},
);
