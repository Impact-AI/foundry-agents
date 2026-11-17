import { ApplicationInsightsSampler } from "@azure/monitor-opentelemetry-exporter";
import type { Attributes, Context, Link, SpanKind } from "@opentelemetry/api";
import type { Sampler, SamplingResult } from "@opentelemetry/sdk-trace-base";
import { type ConfigKey, configTtlMs } from "@platform/config";
import { type TelemetrySettings, telemetrySettings } from "../settings";
import { eventSamplingResult } from "./event-sampling";

/**
 * A sampler whose ratio is the operator's stored setting, read live.
 *
 * `shouldSample` is synchronous, so it reads what the memo already holds and
 * nudges a refresh without waiting when the memo is old, at most once per
 * memo lifetime, so a span never costs a read. A structured line's span is
 * kept whatever the ratio (see `eventSamplingResult`). Every other decision
 * is delegated to `ApplicationInsightsSampler`,
 * which hashes the trace id the way every Application Insights SDK does — one
 * trace is sampled in or out as a whole across services — and writes the
 * sample rate onto the span so ingestion scales counts back up.
 */
export class ConfiguredSampler implements Sampler {
	private ratio: number;
	private delegate: ApplicationInsightsSampler;
	private refreshing = false;
	private nextRefreshAt = 0;

	constructor(
		private readonly settings: ConfigKey<TelemetrySettings> = telemetrySettings(),
		private readonly ttlMs: number = configTtlMs(),
	) {
		this.ratio = settings.cached().samplingRatio;
		this.delegate = new ApplicationInsightsSampler(this.ratio);
	}

	shouldSample(
		context: Context,
		traceId: string,
		spanName: string,
		spanKind: SpanKind,
		attributes: Attributes,
		links: Link[],
	): SamplingResult {
		this.refreshIfDue();
		const kept = eventSamplingResult(spanName, spanKind);
		if (kept) return kept;
		const ratio = this.settings.cached().samplingRatio;
		if (ratio !== this.ratio) {
			this.ratio = ratio;
			this.delegate = new ApplicationInsightsSampler(ratio);
		}
		return this.delegate.shouldSample(
			context,
			traceId,
			spanName,
			spanKind,
			attributes,
			links,
		);
	}

	toString(): string {
		return `ConfiguredSampler{${this.ratio}}`;
	}

	private refreshIfDue(): void {
		if (this.refreshing || Date.now() < this.nextRefreshAt) return;
		this.refreshing = true;
		this.nextRefreshAt = Date.now() + this.ttlMs;
		void this.settings
			.read()
			.catch(() => {})
			.finally(() => {
				this.refreshing = false;
			});
	}
}
