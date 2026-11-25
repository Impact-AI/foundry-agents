import { trace } from "@opentelemetry/api";
import { resourceFromAttributes } from "@opentelemetry/resources";
import { processSingleton, reportFailure } from "@platform/config";
import { bridgeEvents } from "./events";
import { ImpactCopy, type ImpactSettings, impactSettings } from "./impact";
import {
	installProbeFilter,
	ScrubbingLogRecordProcessor,
	ScrubbingSpanProcessor,
} from "./pipeline";
import { type Release, resourceAttributes } from "./release";
import { isProbePath, pathOf, registerProbePaths } from "./scrub";
import { connectionString, telemetrySettings } from "./settings";

/**
 * Telemetry for a Next server on Node, from inside its `register()` hook.
 *
 * Here the Azure Monitor distro earns its keep: the server goes through
 * `node:http`, so the HTTP instrumentation yields request spans, outbound
 * fetches and database clients without per-route code. The distro builds its
 * own exporter and batch processor and registers the processors it is handed
 * *beside* them, which decides how filtering is done: the scrubber still
 * edits every span in place, but its silence stops nothing, so probes are
 * refused above the pipeline — by the HTTP instrumentation's ignore hook for
 * its own spans, and by the sampler {@link installProbeFilter} installs for
 * Next's own instrumentation, a second producer that never sees that hook.
 *
 * The ratio is read once: the distro takes it at build and keeps it until the
 * next restart. A portal edit therefore reaches a Bun service live and a Next
 * server on its next revision.
 *
 * With impact.ai's endpoint and key handed in, the copy there (`./impact`)
 * is registered after the scrub, so it copies each span as the scrub left
 * it; every span carries the release (`./release`).
 */

export interface NextTelemetryOptions {
	/** `cloud_RoleName` in the portal. One per service. */
	serviceName: string;
	/** The image tag, when the process knows it: the version outside a release. */
	serviceVersion?: string;
	/** The release the process runs as, which every span carries. */
	release?: Release;
	/** The impact.ai product to copy every span to; without both values, no copy. */
	impact?: Partial<ImpactSettings>;
	/** Paths this service treats as probes, beyond the defaults. */
	probePaths?: string[];
}

interface Distro {
	started: boolean;
}

function distro(): Distro {
	return processSingleton<Distro>("observability:next-distro", () => ({
		started: false,
	}));
}

/**
 * The distro types the HTTP instrumentation's slot as the base config, which
 * declares only `enabled`, but forwards the whole object — so the hook is
 * honoured at runtime and this is how to say so without an `any`.
 */
interface HttpInstrumentationConfig {
	enabled?: boolean;
	ignoreIncomingRequestHook?: (request: { url?: string }) => boolean;
}

/**
 * Start the distro, or do nothing. Never throws: `register()` failing takes
 * the server down with it. Imported dynamically from the hook, because
 * `instrumentation.ts` is bundled for the edge runtime too and the distro is
 * Node-only.
 *
 * @returns whether telemetry started.
 */
export async function startNextTelemetry(
	options: NextTelemetryOptions,
): Promise<boolean> {
	const held = distro();
	if (held.started) return true;
	const connection = connectionString();
	if (!connection) return false;

	try {
		const { useAzureMonitor } = await import("@azure/monitor-opentelemetry");
		const { samplingRatio } = await telemetrySettings().read();
		registerProbePaths(options.probePaths ?? []);

		const impactTo = impactSettings(options.impact);
		const impact = impactTo ? new ImpactCopy(impactTo) : undefined;

		const http: HttpInstrumentationConfig = {
			enabled: true,
			ignoreIncomingRequestHook: (request) =>
				isProbePath(pathOf(request.url ?? "/")),
		};

		useAzureMonitor({
			azureMonitorExporterOptions: { connectionString: connection },
			resource: resourceFromAttributes(resourceAttributes(options)),
			samplingRatio,
			// The distro's default rate limit of 5 traces per second silently
			// overrides the ratio. Zero means "use the ratio".
			tracesPerSecond: 0,
			// Off: the distro's own span processor runs ahead of the scrub and
			// builds a Live Metrics document from each span as it ends, URL and
			// attributes included, so that stream would carry what the scrub
			// exists to remove.
			enableLiveMetrics: false,
			// In this order: the scrub edits the span in place, then the copy reads it.
			spanProcessors: [
				new ScrubbingSpanProcessor(),
				...(impact ? [impact] : []),
			],
			logRecordProcessors: [new ScrubbingLogRecordProcessor()],
			instrumentationOptions: {
				http,
				// Off: these turn a log message into a telemetry record, and a
				// message is prose the scrubber can clean an attribute of but not a
				// sentence. Stdout already reaches the platform's log stream.
				console: { enabled: false },
				bunyan: { enabled: false },
				winston: { enabled: false },
			},
		});

		if (!installProbeFilter(trace.getTracerProvider())) {
			console.warn(
				"[observability] probe span filter not installed — the framework's own health-check spans will be exported",
			);
		}
		bridgeEvents();
		held.started = true;
		// Not awaited: the server starts whether or not the SDK does.
		void impact?.connect(trace.getTracerProvider(), options.serviceName);
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
