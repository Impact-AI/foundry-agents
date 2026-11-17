import { type AgentHost, agentKeys } from "@platform/agent";
import { foundryProjectEndpoint, foundryToken } from "@platform/agent/foundry";
import { envString } from "@platform/config";
import { configureLimits, setMeteringKeyPrefix } from "@platform/metering";
import { startBunTelemetry } from "@platform/observability/bun";
import type { KeyNamespace, SharedMemo } from "@platform/redis";
import { VoiceBroker, type VoiceBrokerDeps } from "@platform/voice";
import type { BackendProduct } from "./backend-product";

/**
 * What the packages leave to the app, wired in one place: the namespace
 * every key of this service sits under, the fleet-shared memo the limits
 * document goes through, the live voice broker and the ledger's sweeper
 * that cuts its sessions off, and telemetry. Each is a decision a second
 * product would make differently, which is why none of the packages makes
 * it.
 */
export interface Wiring {
	namespace: KeyNamespace;
	memo: SharedMemo;
	broker: VoiceBroker;
	telemetry: boolean;
	stop(): void;
}

/** Paths a probe hits, which get no span. */
const PROBE_PATHS = ["/health", "/ready"];

/**
 * Where the voice agent's socket is opened, and with what: the project and
 * the process's identity. A stand-in names its own (`testing/dev-fake.ts`).
 */
type VoiceAccess = Pick<VoiceBrokerDeps, "endpoint" | "token">;

const PROJECT: VoiceAccess = {
	endpoint: foundryProjectEndpoint,
	token: foundryToken,
};

export function wire(
	product: BackendProduct,
	host: AgentHost,
	voice: VoiceAccess = PROJECT,
): Wiring {
	const telemetry = startBunTelemetry({
		serviceName: product.serviceName,
		serviceVersion: envString("IMAGE_TAG"),
		probePaths: PROBE_PATHS,
	});
	// The agent's own namespace and memo, so every key of this service sits under one name.
	const { namespace, memo } = agentKeys(product.serviceName);
	setMeteringKeyPrefix(namespace.child("metering").prefix);
	configureLimits({ shared: memo });
	const broker = new VoiceBroker({
		host,
		namespace,
		...voice,
		enabled: product.voice !== undefined,
		surface: product.surfaces.live,
	});
	const stopSweeper = broker.startSweeper();
	return {
		namespace,
		memo,
		broker,
		telemetry,
		stop: stopSweeper,
	};
}
