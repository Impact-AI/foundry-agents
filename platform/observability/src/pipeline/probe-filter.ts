import {
	type Attributes,
	type Context,
	type Link,
	type SpanKind,
	type TracerProvider,
	trace,
} from "@opentelemetry/api";
import {
	type Sampler,
	SamplingDecision,
	type SamplingResult,
} from "@opentelemetry/sdk-trace-base";
import { type AttributeBag, isProbeAttributes } from "../scrub";
import { eventSamplingResult } from "./event-sampling";

/**
 * A sampler that refuses to create a span for a probe, keeps the span a
 * structured line becomes whatever the ratio (see `eventSamplingResult`), and
 * otherwise defers entirely to the sampler it wraps.
 *
 * A sampler because it is the one layer above every producer: `startSpan`
 * asks it before a span object exists, and `NOT_RECORD` means nothing is
 * created, serialised or billed. The HTTP instrumentation's own ignore hook
 * covers only the spans that package produces; Next's instrumentation is a
 * second producer that never goes near it.
 *
 * A probe's descendants go with it, a structured line excepted: Next opens spans underneath a request
 * that carry no path of their own, so a child whose parent is local and
 * non-recording is refused too. *Non-recording* is narrower than *unsampled*
 * on purpose — the distro's sampler answers RECORD for a span the ratio sent
 * away, so testing `isRecording()` leaves every ratio decision to the
 * delegate. A remote parent is never a reason: the context extracted from a
 * caller's headers is always non-recording, and dropping on it would empty
 * the downstream half of every cross-service trace.
 */
export class ProbeFilteringSampler implements Sampler {
	constructor(readonly delegate: Sampler) {}

	shouldSample(
		context: Context,
		traceId: string,
		spanName: string,
		spanKind: SpanKind,
		attributes: Attributes,
		links: Link[],
	): SamplingResult {
		if (isProbeAttributes(attributes as AttributeBag)) return NOT_RECORDED;
		// Asked before the parent is looked at: a line is kept under a request
		// the delegate did not record, whichever way that delegate says so.
		const kept = eventSamplingResult(spanName, spanKind);
		if (kept) return kept;
		const parent = trace.getSpan(context);
		if (parent && !parent.spanContext().isRemote && !parent.isRecording())
			return NOT_RECORDED;
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
		return `ProbeFilteringSampler{${this.delegate}}`;
	}
}

const NOT_RECORDED: SamplingResult = { decision: SamplingDecision.NOT_RECORD };

/** The SDK provider's private sampler slots, feature-detected rather than assumed. */
interface SamplerHolder {
	_tracerOptions?: { sampler?: Sampler };
	_tracers?: Map<unknown, { _sampler?: Sampler }>;
}

/** The API's proxy provider, which hides the SDK provider behind `getDelegate`. */
interface Delegating {
	getDelegate?: () => TracerProvider;
}

/**
 * Wrap a running provider's sampler in a {@link ProbeFilteringSampler}.
 *
 * Surgery because the distro offers no sampler option: it builds the provider
 * itself, and the only handle on the sampler afterwards is private. A shape
 * this does not recognise is left exactly as found and reported as `false` —
 * the failure mode is probe spans still exported, never telemetry that stops.
 * A tracer copies the sampler out when it is constructed, so tracers already
 * handed out are given the new one too.
 *
 * @returns whether the filter is now installed.
 */
export function installProbeFilter(provider: TracerProvider): boolean {
	const delegate = (provider as Delegating).getDelegate?.() ?? provider;
	const holder = delegate as SamplerHolder;
	const options = holder._tracerOptions;
	const existing = options?.sampler;
	if (!options || !existing || typeof existing.shouldSample !== "function")
		return false;
	if (existing instanceof ProbeFilteringSampler) return true;

	const filtered = new ProbeFilteringSampler(existing);
	options.sampler = filtered;
	if (holder._tracers instanceof Map) {
		for (const tracer of holder._tracers.values()) {
			if (tracer && typeof tracer === "object") tracer._sampler = filtered;
		}
	}
	return true;
}
