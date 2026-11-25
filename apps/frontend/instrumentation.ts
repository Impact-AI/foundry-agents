import {
	assertDeploymentSafe,
	requireNonEmpty,
} from "@platform/config/deployment-guard";
import { envString } from "@platform/config/env";

/**
 * Next's one startup hook, before the first request is routed. The deployed-
 * environment check runs at module scope as well as in `register()`: a throw
 * while this module is imported fails server initialisation whatever a Next
 * version makes of an error thrown by the hook. Telemetry is Node-only and
 * imported lazily so the edge bundle never sees the distro.
 *
 * `process.env.NEXT_RUNTIME` is read literally: it is a value the bundler
 * writes into each build, not a variable the running process holds, so a
 * read through a helper finds nothing at runtime and the Node-only half —
 * identity's deployment rules and telemetry — never runs
 * (`instrumentation.test.ts`).
 */
const rules = [
	requireNonEmpty(
		"BACKEND_URL",
		"it names the backend this app talks to; without it every page fails",
	),
	requireNonEmpty(
		"AUTH_SECRET",
		"it signs the session cookie and every caller assertion; without it nothing can be verified",
	),
];

assertDeploymentSafe(rules);

export async function register(): Promise<void> {
	assertDeploymentSafe(rules);
	if (process.env.NEXT_RUNTIME === "nodejs") {
		const { identityDeploymentRules } = await import("./src/identity");
		assertDeploymentSafe(identityDeploymentRules);
		const { startNextTelemetry } = await import("@platform/observability/next");
		await startNextTelemetry({
			serviceName: "frontend",
			serviceVersion: envString("IMAGE_TAG"),
			release: {
				id: envString("IMPACT_RELEASE_ID"),
				version: envString("IMPACT_RELEASE_VERSION"),
				environment: envString("IMPACT_RELEASE_ENVIRONMENT"),
				revision: envString("CONTAINER_APP_REVISION"),
			},
			impact: {
				endpoint: envString("IMPACT_ENDPOINT"),
				apiKey: envString("IMPACT_API_KEY"),
			},
		});
	}
}
