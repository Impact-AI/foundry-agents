import { SpanKind, trace } from "@opentelemetry/api";
import { processSingleton } from "@platform/config/singleton";
import { type AttributeBag, scrubAttributes, stableTag } from "../scrub";
import { PROBLEM_EVENT, type ProblemLine, problemChannel } from "./problem";
import { USAGE_EVENT, type UsageLine, usageChannel } from "./usage";

/**
 * Each structured line, as a telemetry item of its own.
 *
 * A span event is a field of a span, not an item: it is exported if and only
 * if its span is, and the emitter cannot know whether the sampler, a
 * non-recording parent or a producer outside this pipeline will discard that
 * span. A refusal or a cost record that vanishes with somebody else's span is
 * the one record least wanted coupled to anything, so every line becomes a
 * short INTERNAL span of its own, which the samplers here keep whatever the
 * ratio (`eventSamplingResult`) — and is added to the open span as an event
 * as well, which costs nothing and keeps it beside the request for anyone
 * reading one trace end to end.
 *
 * Registered only once a provider is installed, so a process that never
 * configured telemetry never has a sink and a line stays one `JSON.stringify`
 * onto stdout.
 */

type SpanAttributes = Record<string, string | number>;

interface Bridge {
	listening: boolean;
}

function bridge(): Bridge {
	return processSingleton<Bridge>("observability:event-bridge", () => ({
		listening: false,
	}));
}

export function bridgeEvents(): void {
	const held = bridge();
	if (held.listening) return;
	held.listening = true;
	problemChannel.setSink((line) =>
		recordAsSpan(PROBLEM_EVENT, problemEventAttributes(line)),
	);
	usageChannel.setSink((line) =>
		recordAsSpan(USAGE_EVENT, usageAttributes(line)),
	);
}

/** Stop listening. Tests, and nothing else — a server has no reason to. */
export function unbridgeEvents(): void {
	bridge().listening = false;
	problemChannel.setSink(null);
	usageChannel.setSink(null);
}

/** Never throws: a telemetry failure is never worth a failed request. */
function recordAsSpan(name: string, attributes: SpanAttributes): void {
	try {
		trace.getActiveSpan()?.addEvent(name, attributes);
		trace
			.getTracer("platform.events")
			.startSpan(name, { kind: SpanKind.INTERNAL, attributes })
			.end();
	} catch {}
}

/**
 * The line's attributes, scrubbed, on a copy — the bag on the line belongs to
 * the caller. Every attribute today is a `problem.*` facet with nothing to
 * redact; the pass happens anyway so that a facet one day named after a URL
 * or an address is already refused. Anything that comes back as neither a
 * string nor a number is dropped rather than coerced.
 */
export function problemEventAttributes(line: ProblemLine): SpanAttributes {
	const bag: AttributeBag = { ...line.attributes };
	scrubAttributes(bag);
	const attributes: SpanAttributes = {};
	for (const [name, value] of Object.entries(bag)) {
		if (typeof value === "string" || typeof value === "number")
			attributes[name] = value;
	}
	return attributes;
}

/**
 * The usage line as span attributes: every measured number, no free text, and
 * the turn id tagged rather than copied. The attribute answers "were these
 * calls one turn", which a tag answers as well as the id, and a retained store
 * that holds no id of the product's has nothing to join on, should a product ever mint
 * one from something it should not have. Nulls are dropped rather than sent
 * as zero.
 */
export function usageAttributes(line: UsageLine): SpanAttributes {
	const attributes: SpanAttributes = {
		"llm.kind": line.kind,
		"llm.provider": line.provider,
		"llm.model": line.model,
		"llm.duration_ms": line.durationMs,
		"llm.turn_tag": stableTag(line.turnId),
	};
	if (line.surface) attributes["llm.surface"] = line.surface;
	if (line.finishReason) attributes["llm.finish_reason"] = line.finishReason;
	const numbers: [string, number | null][] = [
		["llm.input_tokens", line.inputTokens],
		["llm.output_tokens", line.outputTokens],
		["llm.total_tokens", line.totalTokens],
		["llm.reasoning_tokens", line.reasoningTokens],
		["llm.cached_input_tokens", line.cachedInputTokens],
		["llm.ttft_ms", line.ttftMs],
		["llm.audio_seconds", line.audioSeconds],
		["llm.audio_bytes", line.audioBytes],
		["llm.characters", line.characters],
		["llm.embedded_values", line.embeddedValues],
	];
	for (const [name, value] of numbers) {
		if (value !== null) attributes[name] = value;
	}
	return attributes;
}
