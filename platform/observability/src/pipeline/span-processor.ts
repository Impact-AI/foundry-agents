import type { Context } from "@opentelemetry/api";
import type {
	ReadableSpan,
	Span,
	SpanProcessor,
} from "@opentelemetry/sdk-trace-base";
import {
	type AttributeBag,
	isProbeAttributes,
	scrubAttributes,
	scrubText,
	spanNameFor,
} from "../scrub";
import { demoteDuplicateServerSpan } from "./duplicate-server-span";

/**
 * The scrub, applied to every span whoever produced it, in `onEnd` — the
 * attributes that matter are set over the span's life, and the object handed
 * to every processor is the one the exporter serialises, so editing it in
 * place edits what leaves the process.
 *
 * Whether it can also *drop* a span depends on where it sits. In a pipeline
 * built here it wraps the batch processor and its silence stops the span; in
 * one the Azure distro builds it is registered beside the exporter's own
 * processor and its silence stops nothing, so probes there are refused above
 * the pipeline by `ProbeFilteringSampler`.
 */

const NO_DELEGATE: SpanProcessor = {
	onStart: () => {},
	onEnd: () => {},
	forceFlush: () => Promise.resolve(),
	shutdown: () => Promise.resolve(),
};

export interface ScrubbingOptions {
	/** The processor scrubbed spans go to. Omit it when the SDK owns the export pipeline. */
	delegate?: SpanProcessor;
	/** Withhold probe spans from the delegate. Only meaningful with one; the default when there is one. */
	dropProbes?: boolean;
}

export class ScrubbingSpanProcessor implements SpanProcessor {
	private readonly delegate: SpanProcessor;
	private readonly dropProbes: boolean;

	constructor(options: ScrubbingOptions = {}) {
		this.delegate = options.delegate ?? NO_DELEGATE;
		this.dropProbes = options.dropProbes ?? options.delegate !== undefined;
	}

	onStart(span: Span, parentContext: Context): void {
		demoteDuplicateServerSpan(span, parentContext);
		this.delegate.onStart(span, parentContext);
	}

	/**
	 * Never throws: a processor that throws in `onEnd` can take the request with
	 * it. A span that could not be scrubbed never reaches the delegate, and is
	 * emptied first: where the SDK owns the export pipeline this processor's
	 * silence withholds nothing, so what the exporter then serialises is a
	 * span with nothing on it. Failing closed is the only defensible direction
	 * for a redaction.
	 */
	onEnd(span: ReadableSpan): void {
		let probe = false;
		try {
			probe = scrubSpan(span);
		} catch {
			empty(span);
			return;
		}
		if (probe && this.dropProbes) return;
		this.delegate.onEnd(span);
	}

	forceFlush(): Promise<void> {
		return this.delegate.forceFlush();
	}

	shutdown(): Promise<void> {
		return this.delegate.shutdown();
	}
}

/** Take everything a span carries off it, as far as the object allows. Never throws. */
function empty(span: ReadableSpan): void {
	const strip = (bag: unknown) => {
		try {
			for (const key of Object.keys(bag as AttributeBag))
				delete (bag as AttributeBag)[key];
		} catch {}
	};
	try {
		strip(span.attributes);
		for (const event of span.events ?? []) strip(event.attributes);
		(span as { name: string }).name = "unscrubbed";
		const status = span.status as { message?: string } | undefined;
		if (status?.message) status.message = "";
	} catch {}
}

/**
 * Scrub one span in place — its attributes, its events', its name and its
 * status message — and say whether it was a probe.
 */
export function scrubSpan(span: ReadableSpan): boolean {
	const attributes = span.attributes as AttributeBag;
	const probe = isProbeAttributes(attributes);
	const route = scrubAttributes(attributes);
	// Read defensively although `events` is non-optional on the type: the caller
	// fails closed, so a `TypeError` here would drop the whole span.
	for (const event of span.events ?? []) {
		if (event.attributes) scrubAttributes(event.attributes as AttributeBag);
	}
	// An error's message is set as the status too, and a producer may name a
	// span after the URL it called.
	const status = span.status as { message?: string } | undefined;
	if (typeof status?.message === "string")
		status.message = scrubText(status.message);
	if (typeof span.name === "string")
		(span as { name: string }).name = scrubText(span.name);
	if (route) {
		const method =
			attributes["http.request.method"] ?? attributes["http.method"];
		if (typeof method === "string") {
			(span as { name: string }).name = spanNameFor(method, route);
		}
	}
	return probe;
}
