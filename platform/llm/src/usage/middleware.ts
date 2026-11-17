/**
 * The usage line as middleware: the provider's result is returned untouched,
 * every stream part is forwarded before it is looked at, and a call that
 * throws emits nothing, since there is no usage block to read off a failure.
 */
import { emitUsage } from "@platform/observability";
import type { LanguageModelMiddleware } from "ai";
import { finishReason, tokenCounts } from "./sdk-usage";

/**
 * Not text alone: a reasoning model's first emission is usually a reasoning
 * delta, and a tool round-trip may produce no prose at all.
 */
function isContentDelta(type: unknown): boolean {
	return (
		type === "text-delta" ||
		type === "reasoning-delta" ||
		type === "tool-input-delta"
	);
}

export const usageMiddleware: LanguageModelMiddleware = {
	async wrapGenerate({ doGenerate, model }) {
		const startedAt = performance.now();
		const result = await doGenerate();
		emitUsage({
			kind: "chat",
			provider: model.provider,
			model: model.modelId,
			...tokenCounts(result.usage),
			finishReason: finishReason(result.finishReason),
			ttftMs: null,
			durationMs: performance.now() - startedAt,
		});
		return result;
	},

	async wrapStream({ doStream, model }) {
		const startedAt = performance.now();
		const { stream, ...rest } = await doStream();
		let ttftMs: number | null = null;
		let emitted = false;

		// A pass-through rather than `tee()`, which buffers the slower branch:
		// on a chat stream that is a whole answer held to read its last part.
		const observed = stream.pipeThrough(
			new TransformStream({
				transform(part, controller) {
					// Forward first, so the caller's stream never waits on the measurement.
					controller.enqueue(part);
					try {
						if (ttftMs === null && isContentDelta(part.type)) {
							ttftMs = performance.now() - startedAt;
						}
						if (part.type === "finish" && !emitted) {
							emitted = true;
							emitUsage({
								kind: "chat",
								provider: model.provider,
								model: model.modelId,
								...tokenCounts(part.usage),
								finishReason: finishReason(part.finishReason),
								ttftMs,
								durationMs: performance.now() - startedAt,
							});
						}
					} catch {}
				},
			}),
		);

		// A stream that ends without a `finish` part has no usage block, and a
		// line of nulls would dilute the distributions this exists to produce.
		return { stream: observed, ...rest };
	},
};
