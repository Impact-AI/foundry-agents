import { SpanKind } from "@opentelemetry/api";
import {
	SamplingDecision,
	type SamplingResult,
} from "@opentelemetry/sdk-trace-base";
import { PROBLEM_EVENT } from "../events/problem";
import { USAGE_EVENT } from "../events/usage";

/**
 * The span a structured line becomes is kept whatever the ratio says.
 *
 * The ratio thins traces, which are many and alike. A refusal or a cost
 * record is neither: a count of them is only a count when every one is
 * there, and a sum of tokens is only the bill. So a sampler asks this first,
 * and the answer for such a span is recorded and sampled at a rate of 100,
 * which is what tells ingestion to count it once and not scale it up as one
 * survivor of many.
 */

/** The attribute Azure Monitor reads an item's sample rate from, in percent. */
const SAMPLE_RATE = "microsoft.sample_rate";

const KEPT: SamplingResult = {
	decision: SamplingDecision.RECORD_AND_SAMPLED,
	attributes: { [SAMPLE_RATE]: 100 },
};

/** The decision for a structured line's span, or null for any other span. */
export function eventSamplingResult(
	spanName: string,
	spanKind: SpanKind,
): SamplingResult | null {
	if (spanKind !== SpanKind.INTERNAL) return null;
	return spanName === PROBLEM_EVENT || spanName === USAGE_EVENT ? KEPT : null;
}
