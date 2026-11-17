/**
 * The reasoning cap, as the provider reads it. Spelled once, because the AI
 * SDK's Azure language models read `azure` first and fall back to `openai`,
 * and a caller that writes the key by hand picks one of the two by accident.
 * The provider honours the cap only for a model it takes for a reasoning
 * one, which it guesses from the deployment's name; `reasoningModel` tells it
 * instead, for every role whose spec says so.
 */
import type { LanguageModelMiddleware } from "ai";

export type ReasoningEffort = "none" | "minimal" | "low" | "medium" | "high";

export const REASONING_EFFORTS: readonly ReasoningEffort[] = [
	"none",
	"minimal",
	"low",
	"medium",
	"high",
];

export function reasoningOptions(effort: ReasoningEffort): {
	azure: { reasoningEffort: ReasoningEffort };
} {
	return { azure: { reasoningEffort: effort } };
}

/** Every call on this model is a reasoning model's: the effort is kept and the system prompt goes in the developer role. */
export const reasoningModel: LanguageModelMiddleware = {
	transformParams: async ({ params }) => ({
		...params,
		providerOptions: {
			...params.providerOptions,
			azure: { ...params.providerOptions?.azure, forceReasoning: true },
		},
	}),
};
