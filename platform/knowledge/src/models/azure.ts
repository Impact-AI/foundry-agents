import { reasoningOptions, smallChatModel } from "@platform/llm";
import { generateObject } from "ai";
import type { DraftRequest, QueryDrafter } from "./contract";

/**
 * The drafter on `@platform/llm`'s small chat model, which owns the
 * account, the token, the deployment and the bounds every call carries.
 * What is left here is the shape of the call and its budget. An
 * unconfigured deployment is llm's `ModelNotConfiguredError`.
 */
export function azureQueryDrafter(): QueryDrafter {
	return {
		async draft<T>(request: DraftRequest<T>): Promise<T> {
			const { object } = await generateObject({
				model: await smallChatModel(),
				schema: request.schema,
				system: request.system,
				prompt: request.prompt,
				// Planning is a classification; a deliberating model spends the
				// deadline on reasoning tokens for a four-field answer.
				providerOptions: reasoningOptions("low"),
				maxOutputTokens: 800,
				// The model's own retry budget bounds each request, and the
				// caller's deadline ends it: a plan that failed has a fallback.
				maxRetries: 0,
				abortSignal: request.abortSignal,
			});
			return object as T;
		},
	};
}
