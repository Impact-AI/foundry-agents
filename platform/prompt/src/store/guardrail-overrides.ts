import { type ConfigKey, defineConfigKey } from "@platform/config";

/**
 * The operator's guardrail slot overrides, from the `guardrails` document.
 * The failure direction is the whole point: a blip on tool gating costs a
 * tool, a blip here must not cost the guardrail, so no row, an unreadable
 * store and a nonsense document all resolve to `undefined`, which renders
 * the shipped block byte for byte. Validation is per slot and lives with
 * the renderer; nothing is narrowed here, because narrowing in two places is
 * how the two disagree.
 */
export type StoredGuardrails = Record<string, unknown>;

export function defineGuardrailOverrides(
	options: { ttlMs?: number } = {},
): ConfigKey<StoredGuardrails | undefined> {
	return defineConfigKey<StoredGuardrails | undefined>({
		key: "guardrails",
		defaultValue: undefined,
		parse: (stored) =>
			stored && typeof stored === "object" && !Array.isArray(stored)
				? (stored as StoredGuardrails)
				: undefined,
		ttlMs: options.ttlMs,
	});
}
