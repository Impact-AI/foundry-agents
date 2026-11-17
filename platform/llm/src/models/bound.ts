/**
 * What every model carries, in one order: the retry budget outermost, so a
 * backoff holds no slot; the concurrency cap next; the usage line innermost,
 * so each attempt is measured on its own and a wait is never counted as model
 * latency.
 */
import { processSingleton } from "@platform/config";
import { type LanguageModelMiddleware, wrapLanguageModel } from "ai";
import { concurrencyMiddleware } from "../bounds/concurrency";
import { createLimiter, type Limiter } from "../bounds/limiter";
import { modelRetryMiddleware, type RetryPolicy } from "../bounds/retry";
import { type CappedRole, cachedLlmSettings } from "../config";
import { usageMiddleware } from "../usage/middleware";

export type BoundLanguageModel = ReturnType<typeof wrapLanguageModel>;

export interface Bounds {
	limiter: Limiter;
	retry: RetryPolicy;
}

/** The process's limiter for `role`, reading its cap from the settings memo. */
export function roleLimiter(role: CappedRole): Limiter {
	return processSingleton(`llm:limiter:${role}`, () =>
		createLimiter(() => cachedLlmSettings().concurrency[role]),
	);
}

export function boundLanguageModel(
	model: Parameters<typeof wrapLanguageModel>[0]["model"],
	{ limiter, retry }: Bounds,
	shape: LanguageModelMiddleware[] = [],
): BoundLanguageModel {
	return wrapLanguageModel({
		model,
		middleware: [
			modelRetryMiddleware(retry),
			concurrencyMiddleware(limiter),
			usageMiddleware,
			...shape,
		],
	});
}
