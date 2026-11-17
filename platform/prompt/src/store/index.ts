/**
 * The operator's side of the prompt, read from where it is stored: the
 * persona's versions in Cosmos DB and the guardrail slot overrides in App
 * Configuration. A subpath, so the root stays pure for a web app's bundle.
 */
export {
	defineGuardrailOverrides,
	type StoredGuardrails,
} from "./guardrail-overrides";
export {
	definePrompt,
	type NamedPrompt,
	type PromptDefinition,
	type PromptSlot,
	type PromptSync,
	type PromptVersion,
	promptContainers,
} from "./prompt-slot";
