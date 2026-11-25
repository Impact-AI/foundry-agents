import type { Context } from "@opentelemetry/api";
import type {
	ReadableSpan,
	Span,
	SpanProcessor,
} from "@opentelemetry/sdk-trace-base";

/**
 * Several processors behind one, in order: what the scrub hands on reaches
 * each destination, and a probe it withholds reaches none. A flush and a
 * shutdown wait for every one.
 */
export class FanOutSpanProcessor implements SpanProcessor {
	constructor(private readonly processors: readonly SpanProcessor[]) {}

	onStart(span: Span, parentContext: Context): void {
		for (const processor of this.processors)
			processor.onStart(span, parentContext);
	}

	onEnd(span: ReadableSpan): void {
		for (const processor of this.processors) processor.onEnd(span);
	}

	async forceFlush(): Promise<void> {
		await Promise.all(this.processors.map((p) => p.forceFlush()));
	}

	async shutdown(): Promise<void> {
		await Promise.all(this.processors.map((p) => p.shutdown()));
	}
}
