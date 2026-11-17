import { type Context, type Span, SpanKind, trace } from "@opentelemetry/api";

/**
 * One inbound request, one request row.
 *
 * Two producers in a Next process open a SERVER span for the same request:
 * the HTTP instrumentation, which patches `node:http` and carries the status
 * written to the socket, and Next's own `BaseServer.handleRequest`, nested
 * inside it and carrying 200 whenever Next handled the request without
 * throwing. The exporter writes every SERVER span as a request row, so a
 * refusal counted as half a success. A SERVER span whose parent is a local,
 * recording SERVER span is a second view of the request already being
 * recorded; its kind becomes INTERNAL so it is exported as a dependency with
 * everything it carries intact.
 *
 * In `onStart` rather than `onEnd` because the distro's own processor,
 * registered ahead of this one, reads the kind for its metrics in its `onEnd`
 * and stamps the extractor attribute in its `onStart`. Not in the sampler,
 * because a sampler can only refuse a span, and refusing `handleRequest` would
 * take every Next span underneath it. A remote parent is excluded: another
 * process's request is not a duplicate of this one.
 *
 * @returns whether the span was demoted.
 */
export function demoteDuplicateServerSpan(
	span: Span,
	parentContext: Context,
): boolean {
	try {
		const kinded = span as unknown as KindBearing;
		if (kinded.kind !== SpanKind.SERVER) return false;
		const parent = trace.getSpan(parentContext);
		if (!parent || parent.spanContext().isRemote || !parent.isRecording())
			return false;
		if ((parent as unknown as KindBearing).kind !== SpanKind.SERVER)
			return false;
		kinded.kind = SpanKind.INTERNAL;
		span.setAttribute(EXTRACTOR_ATTRIBUTE, DEPENDENCY_EXTRACTOR);
		return true;
	} catch {
		// A span left as it was is the behaviour this replaces, not a new one.
		return false;
	}
}

/** What the Azure distro stamps so ingestion does not aggregate a span twice. */
const EXTRACTOR_ATTRIBUTE = "_MS.ProcessedByMetricExtractors";
const DEPENDENCY_EXTRACTOR = "(Name:'Dependencies', Ver:'1.1')";

/** The API's `Span` type declares no `kind`; the SDK's span carries one. */
interface KindBearing {
	kind?: SpanKind;
}
