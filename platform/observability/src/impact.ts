import type { Context, TracerProvider } from "@opentelemetry/api";
import type {
	ReadableSpan,
	Span,
	SpanProcessor,
} from "@opentelemetry/sdk-trace-base";
import { reportFailure } from "@platform/config";

/**
 * A copy of every span to impact.ai, beside Azure Monitor, through the
 * Impact SDK's OTLP destination on the provider this package builds (the
 * SDK's external mode: it never owns, flushes or replaces that provider).
 *
 * Off unless the app hands in both the product's OTLP traces URL and its
 * ingest key (the template's `IMPACT_ENDPOINT` and `IMPACT_API_KEY`): then
 * nothing is loaded, nothing is sent, and Azure Monitor gets what it got
 * before. The template keeps the key in Key Vault, whose placeholder for a
 * secret nobody supplied (`unset`) reads as no key.
 *
 * The copy is of the spans as they leave the scrub, and adds none of its
 * own: the SDK's integrations are off, so no client is instrumented twice and
 * Azure Monitor sees no new span, and the content categories are off, so the
 * copy carries no text the scrub left in an error's message. The SDK loads
 * after the provider is built, so the spans of the first moments are not
 * copied; a failure to load or start is a line on stderr, and the service
 * runs on.
 */

/** The value the template's vault holds for a secret nobody supplied. */
const VAULT_PLACEHOLDER = "unset";

export interface ImpactSettings {
	/** The product's OTLP traces URL, ending in `/v1/traces`. */
	endpoint: string;
	/** The product's ingest key. */
	apiKey: string;
}

/** The settings, or undefined when either is missing or the key is the vault's placeholder. */
export function impactSettings(
	given: Partial<ImpactSettings> | undefined,
): ImpactSettings | undefined {
	const endpoint = given?.endpoint?.trim();
	const apiKey = given?.apiKey?.trim();
	if (!endpoint || !apiKey || apiKey === VAULT_PLACEHOLDER) return undefined;
	return { endpoint, apiKey };
}

/** What the SDK's processor is to this provider: the calls, whatever its OpenTelemetry release types them as. */
interface Target {
	onStart(span: unknown, context: unknown): void;
	onEnd(span: unknown): void;
	forceFlush(): Promise<void>;
	shutdown(): Promise<void>;
}

/**
 * The span processor that copies to impact.ai once {@link connect} has
 * started the SDK, and does nothing before. Never throws into the pipeline.
 */
export class ImpactCopy implements SpanProcessor {
	private target: Target | undefined;
	private runtime: { shutdown(): Promise<unknown> } | undefined;
	private connecting: Promise<boolean> | undefined;

	constructor(private readonly settings: ImpactSettings) {}

	/**
	 * Load the SDK, make its destination and start it on `provider`, once.
	 * Resolves whether the copy runs; never rejects.
	 */
	connect(provider: TracerProvider, serviceName: string): Promise<boolean> {
		this.connecting ??= (async () => {
			try {
				const impact = await import("impact-ai");
				const destination = impact.createOtlpDestination({
					endpoint: this.settings.endpoint,
					apiKey: this.settings.apiKey,
				});
				this.runtime = await impact.init({
					serviceName,
					tracerProvider: provider,
					destination,
					content: {
						input: false,
						output: false,
						tools: false,
						retrieval: false,
						media: false,
					},
					integrations: {
						vercelAI: "disabled",
						google: "disabled",
						googleADK: "disabled",
						openAI: "disabled",
						anthropic: "disabled",
						langChain: "disabled",
						openAIAgents: "disabled",
						awsBedrock: "disabled",
						mcp: "disabled",
					},
				});
				this.target = destination.spanProcessor as Target;
				return true;
			} catch (err) {
				reportFailure(
					"observability",
					"the copy to impact.ai failed to start — continuing without it",
					err,
				);
				return false;
			}
		})();
		return this.connecting;
	}

	onStart(span: Span, parentContext: Context): void {
		try {
			this.target?.onStart(span, parentContext);
		} catch {}
	}

	onEnd(span: ReadableSpan): void {
		try {
			this.target?.onEnd(span);
		} catch {}
	}

	async forceFlush(): Promise<void> {
		await this.target?.forceFlush();
	}

	/** Waits for a start still under way, so a stop never leaves one running behind it. */
	async shutdown(): Promise<void> {
		await this.connecting;
		await this.target?.shutdown();
		await this.runtime?.shutdown();
	}
}
