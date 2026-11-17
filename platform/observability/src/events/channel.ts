import { envFlag } from "@platform/config/env";
import { processSingleton } from "@platform/config/singleton";

/**
 * A structured line: one JSON object on stdout per occurrence, and a sink that
 * hears about each line in addition. Both lines this package writes — a
 * refusal and a model call — are one of these.
 *
 * Stdout first and the sink after it inside its own guard: the stdout line is
 * the older and more reliable record, and a subscriber that throws must not be
 * able to suppress it. Nothing here throws into the caller, not even for a
 * console that has been replaced with something that does — reporting the
 * failure through the stdout that just failed buys nothing, and a request that
 * was being refused for a reason the caller can act on must not become a
 * failed one over a missing data point.
 */
export type EventSink<L> = (line: L) => void;

export interface EventChannel<L> {
	readonly event: string;
	/** Write the line, or write nothing when the switch is off. Never throws. */
	emit(line: L): void;
	/** Register the one sink, or clear it with `null`. */
	setSink(sink: EventSink<L> | null): void;
	/** Whether lines are being written: the switch, which defaults to on. */
	enabled(): boolean;
}

export interface EventChannelOptions<L> {
	/** The `evt` value every line carries; the sink's registry key too. */
	event: string;
	/** The variable that switches the line off: on unless it holds an off-value in `envFlag`'s sense. */
	switchVar: string;
	/** What stdout gets, when it is not the line itself (a flattened bag, say). */
	printed?: (line: L) => object;
}

/**
 * The sinks are per process, keyed by event name, so a development server's
 * module re-evaluation neither forgets one nor doubles it.
 */
function sinks(): Map<string, EventSink<unknown>> {
	return processSingleton("observability:event-sinks", () => new Map());
}

export function defineEventChannel<L extends object>(
	options: EventChannelOptions<L>,
): EventChannel<L> {
	const { event, switchVar, printed } = options;
	// Read per emission, not at definition: the models and routes that emit
	// are built at module load, before a test or an operator could set it.
	const enabled = () => envFlag(switchVar, true);
	return {
		event,
		enabled,
		emit(line) {
			try {
				if (!enabled()) return;
				console.log(JSON.stringify(printed ? printed(line) : line));
				const sink = sinks().get(event);
				if (!sink) return;
				try {
					sink(line);
				} catch {
					// A throwing subscriber loses its own line and nothing else.
				}
			} catch {
				// See the header.
			}
		},
		setSink(sink) {
			if (sink) sinks().set(event, sink as EventSink<unknown>);
			else sinks().delete(event);
		},
	};
}
