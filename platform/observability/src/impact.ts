import type { Context } from "@opentelemetry/api";
import type { Resource } from "@opentelemetry/resources";
import {
	BasicTracerProvider,
	type ReadableSpan,
	type Span,
	type SpanProcessor,
} from "@opentelemetry/sdk-trace-base";
import { reportFailure } from "@platform/config";
import type { ContentOptions } from "impact-ai";

/**
 * The optional Impact SDK route: every span to impact.ai as well as to Azure
 * Monitor, through the SDK's OTLP destination, and the SDK's own capture of
 * the model calls the process makes, with their content, to impact.ai alone.
 * The default is Azure Monitor by itself, which impact.ai reads through the
 * customer's Azure connection.
 *
 * Off unless the app hands in both the product's OTLP traces URL and its
 * ingest key (the template's `IMPACT_ENDPOINT` and `IMPACT_API_KEY`): then
 * nothing is loaded, nothing is sent, and nothing is instrumented. The
 * template keeps the key in Key Vault only once one is given; the vault's
 * placeholder for a secret nobody supplied (`unset`) reads as no key all
 * the same.
 *
 * Two routes, so Azure Monitor gets exactly what it got before:
 *
 * - The spans this package's provider makes are copied as the scrub leaves
 *   them, after Azure Monitor's own processor; the SDK never owns, flushes
 *   or replaces that provider (its external mode).
 * - The SDK's integrations (the OpenAI client, and others it supports) are
 *   on, as the SDK ships them: each captures its calls' inputs, outputs and
 *   tool content within the SDK's limits and the client's own telemetry
 *   settings, on a provider of the copy's own whose one destination is
 *   impact.ai. Those spans join the request's trace there and reach no other
 *   exporter.
 *
 * `content` is the SDK's capture control: a category set false is left out
 * of everything impact.ai gets. The SDK loads after the provider is built,
 * so the spans of the first moments are not copied; a failure to load or
 * start is a line on stderr, and the service runs on.
 */

/** The value the template's vault holds for a secret nobody supplied. */
const VAULT_PLACEHOLDER = "unset";

export interface ImpactSettings {
	/** The product's OTLP traces URL, ending in `/v1/traces`. */
	endpoint: string;
	/** The product's ingest key. */
	apiKey: string;
	/**
	 * The SDK's capture control, by category (`input`, `output`, `tools`,
	 * `retrieval`, `media`): one set false is left out. Every category the
	 * SDK captures is on unless set false here.
	 */
	content?: ContentOptions;
}

/** The settings, or undefined when either is missing or the key is the vault's placeholder. */
export function impactSettings(
	given: Partial<ImpactSettings> | undefined,
): ImpactSettings | undefined {
	const endpoint = given?.endpoint?.trim();
	const apiKey = given?.apiKey?.trim();
	if (!endpoint || !apiKey || apiKey === VAULT_PLACEHOLDER) return undefined;
	return given?.content
		? { endpoint, apiKey, content: given.content }
		: { endpoint, apiKey };
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
	private own: BasicTracerProvider | undefined;
	private runtime: { shutdown(): Promise<unknown> } | undefined;
	private connecting: Promise<boolean> | undefined;

	constructor(private readonly settings: ImpactSettings) {}

	/**
	 * Load the SDK, make its destination, and start it, once: its capture on
	 * a provider of its own with the process's resource, the release among
	 * it. Resolves whether the copy runs; never rejects.
	 */
	connect(serviceName: string, resource: Resource): Promise<boolean> {
		this.connecting ??= (async () => {
			try {
				const impact = await import("impact-ai");
				const destination = impact.createOtlpDestination({
					endpoint: this.settings.endpoint,
					apiKey: this.settings.apiKey,
				});
				const target = destination.spanProcessor as Target;
				const own = new BasicTracerProvider({
					resource,
					spanProcessors: [target as unknown as SpanProcessor],
				});
				this.own = own;
				this.runtime = await impact.init({
					serviceName,
					tracerProvider: own,
					destination,
					...(this.settings.content ? { content: this.settings.content } : {}),
				});
				this.target = target;
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
		await this.own?.forceFlush();
		await this.target?.forceFlush();
	}

	/** Waits for a start still under way, so a stop never leaves one running behind it. */
	async shutdown(): Promise<void> {
		await this.connecting;
		await this.own?.forceFlush();
		await this.runtime?.shutdown();
		await this.target?.shutdown();
		await this.own?.shutdown();
	}
}
