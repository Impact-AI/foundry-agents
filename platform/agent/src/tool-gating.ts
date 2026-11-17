import { type ConfigKey, defineConfigKey } from "@platform/config";
import type { AgentProduct } from "./contract/product";

/**
 * Which of the product's tools the agent exposes, the service's web search among
 * them, and whether skills run, from the operator's `tools` document in App
 * Configuration.
 * One parser owns the document, so a briefing for another channel and the
 * agent cannot disagree about what ships enabled. Served from memory, never
 * per request, and a store that cannot be read serves the default: every
 * shipped tool on, because a blip must not quietly withdraw a capability
 * mid-conversation.
 */

export interface ToolGatingConfig {
	enabledTools: string[];
	/** The kill switch for skills: off, no channel carries one, whatever the rows say. */
	skillsEnabled: boolean;
}

export interface ToolGatingOptions {
	/** Every tool the product ships with, on. */
	defaultEnabledTools: readonly string[];
	ttlMs?: number;
}

/** How the host gates a product's tools: every tool it ships, on. The seeded `tools` document is built from the same answer. */
export function toolGatingOptions(
	product: Pick<AgentProduct, "toolKeys">,
): ToolGatingOptions {
	return { defaultEnabledTools: product.toolKeys };
}

function toStringList(input: unknown): string[] {
	if (!Array.isArray(input)) return [];
	return input.filter(
		(d): d is string => typeof d === "string" && d.length > 0,
	);
}

/** The stored document as a config, field by field over the default. Exported for its tests. */
export function parseToolGating(
	stored: unknown,
	defaults: ToolGatingConfig,
): ToolGatingConfig {
	if (!stored || typeof stored !== "object" || Array.isArray(stored))
		return defaults;
	const doc = stored as Record<string, unknown>;
	return {
		enabledTools: Array.isArray(doc.enabled_tools)
			? toStringList(doc.enabled_tools)
			: defaults.enabledTools,
		// On when unset, so skills are not silently lost on a document saved before the flag existed.
		skillsEnabled:
			typeof doc.skills_enabled === "boolean"
				? doc.skills_enabled
				: defaults.skillsEnabled,
	};
}

/** What the document answers before anything is stored. */
export function toolGatingDefaults(
	options: ToolGatingOptions,
): ToolGatingConfig {
	return {
		enabledTools: [...options.defaultEnabledTools],
		skillsEnabled: true,
	};
}

/** A config in the document's stored shape, the inverse of `parseToolGating`. */
export function storedToolGating(
	config: ToolGatingConfig,
): Record<string, unknown> {
	return {
		enabled_tools: config.enabledTools,
		skills_enabled: config.skillsEnabled,
	};
}

export function defineToolGating(
	options: ToolGatingOptions,
): ConfigKey<ToolGatingConfig> {
	return defineConfigKey<ToolGatingConfig>({
		key: "tools",
		defaultValue: toolGatingDefaults(options),
		parse: (stored, fallback) => parseToolGating(stored, fallback),
		ttlMs: options.ttlMs,
	});
}
