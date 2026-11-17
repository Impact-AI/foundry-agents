/**
 * The AI SDK's usage block, read into the numbers the usage line carries. The
 * line itself, its scope and its switch are `@platform/observability`'s; this
 * is only the part that knows the SDK's shapes.
 */
import type { UsageEmission } from "@platform/observability";

/** The two shapes a usage block comes in: flat (v2) and nested (v3, v4). */
interface FlatUsage {
	inputTokens?: number;
	outputTokens?: number;
	totalTokens?: number;
	reasoningTokens?: number;
	cachedInputTokens?: number;
}
interface NestedUsage {
	inputTokens?: { total?: number; cacheRead?: number };
	outputTokens?: { total?: number; reasoning?: number };
}

export type TokenCounts = Pick<
	UsageEmission,
	| "inputTokens"
	| "outputTokens"
	| "totalTokens"
	| "reasoningTokens"
	| "cachedInputTokens"
>;

/** A finite number, or null: providers omit fields and occasionally send junk. */
function count(value: unknown): number | null {
	return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/** The unified finish reason, comparable across providers; the raw one is dropped. */
export function finishReason(value: unknown): string {
	if (typeof value === "string") return value;
	const unified = (value as { unified?: unknown } | null)?.unified;
	return typeof unified === "string" ? unified : "unknown";
}

/**
 * A reported total is passed on as reported, since it can carry overhead the
 * halves do not; summing the halves is the line's own rule.
 */
export function tokenCounts(usage: unknown): TokenCounts {
	const flat = (usage ?? {}) as FlatUsage;
	const nested = (usage ?? {}) as NestedUsage;
	return {
		inputTokens: count(nested.inputTokens?.total) ?? count(flat.inputTokens),
		outputTokens: count(nested.outputTokens?.total) ?? count(flat.outputTokens),
		totalTokens: count(flat.totalTokens),
		reasoningTokens:
			count(nested.outputTokens?.reasoning) ?? count(flat.reasoningTokens),
		cachedInputTokens:
			count(nested.inputTokens?.cacheRead) ?? count(flat.cachedInputTokens),
	};
}
