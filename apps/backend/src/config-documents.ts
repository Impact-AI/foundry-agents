/**
 * Every settings document in App Configuration, as this deployment's code
 * answers it before anything is stored: what the migrate job's settings step
 * seeds, so an operator edits the live numbers rather than an empty object.
 * Built from each document's own default, in the shape its parser reads, and
 * never copied; the defaults stay the answer when the store cannot be read or
 * a field is refused. The agent document's default is the deployment's: a
 * private one keeps memory in its own store; so is the access document's: a
 * hardened one enforces readers. The deployments the llm
 * document carries are the environment's and are left out.
 */
import {
	defaultAgentSettings,
	storedToolGating,
	toolGatingDefaults,
	toolGatingOptions,
} from "@platform/agent";
import { appearanceDefaults } from "@platform/appearance";
import { DEFAULT_EDGE_LIMITS } from "@platform/http";
import {
	defaultAccessSettings,
	defaultKnowledgeSettings,
} from "@platform/knowledge";
import { DEFAULT_LLM_SETTINGS } from "@platform/llm";
import { DEFAULT_LIMITS } from "@platform/metering";
import { DEFAULT_TELEMETRY } from "@platform/observability/settings";
import { DEFAULT_VOICE_SETTINGS } from "@platform/voice";
import { guardrails, product } from "./product";

export function configDocuments(): Record<string, unknown> {
	return {
		limits: DEFAULT_LIMITS,
		llm: DEFAULT_LLM_SETTINGS,
		voice: DEFAULT_VOICE_SETTINGS,
		agent: defaultAgentSettings(),
		tools: storedToolGating(toolGatingDefaults(toolGatingOptions(product))),
		guardrails: guardrails.defaults,
		telemetry: DEFAULT_TELEMETRY,
		edge: DEFAULT_EDGE_LIMITS,
		access: defaultAccessSettings(),
		knowledge: defaultKnowledgeSettings(),
		appearance: appearanceDefaults(product.locales.codes),
	};
}
