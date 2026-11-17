/**
 * Every knob this package reads, as one document.
 *
 * The compiled-in defaults are the answer on a bare checkout, and the `llm`
 * key in App Configuration is merged over them, field by field, refusing
 * anything of the wrong shape, so a portal edit can retune a bound and can
 * never remove one. The deployments and the embedding width ride on the
 * same object for the readers' convenience, but they are the environment's
 * alone and a stored value for either is ignored: a deployment name has no
 * default to compile in, and the width must equal the search index's vector
 * field, which cannot be resized, so a portal edit to it would break every
 * query rather than retune anything.
 */
import {
	atLeast,
	defineConfigKey,
	envInt,
	integerBetween,
	type MergeOptions,
	mergeOverDefault,
	positiveInteger,
	processSingleton,
	resetSingleton,
} from "@platform/config";
import { DEFAULT_RETRY_SCHEDULE, type RetrySchedule } from "./bounds/retry";
import { type Deployments, MODEL_ROLES } from "./deployment";

export const LLM_SETTINGS_KEY = "llm";

/** The roles a call of this package's goes to, each under its own cap: the embedding model is called by AI Search, never from here. */
export type CappedRole = "chat" | "smallChat";

export interface LlmSettings {
	deployments: Deployments;
	retry: RetrySchedule;
	/** Calls in flight at once per role, per process. */
	concurrency: Record<CappedRole, number>;
	embeddings: {
		/** Vector width asked of the model; it must equal the index's field width. The environment's, never the store's. */
		dimensions: number;
	};
}

export const DEFAULT_LLM_SETTINGS: Omit<LlmSettings, "deployments"> = {
	retry: DEFAULT_RETRY_SCHEDULE,
	concurrency: { chat: 16, smallChat: 8 },
	embeddings: { dimensions: 3072 },
};

/** The embedding width, set beside the deployment whose model fixes it. */
export const EMBEDDING_DIMENSIONS_VAR = "AZURE_OPENAI_EMBEDDING_DIMENSIONS";

/** The defaults, with the deployments and the embedding width the environment names. */
export function llmSettingsFromEnvironment(): LlmSettings {
	return {
		...DEFAULT_LLM_SETTINGS,
		embeddings: {
			...DEFAULT_LLM_SETTINGS.embeddings,
			dimensions: envInt(
				EMBEDDING_DIMENSIONS_VAR,
				DEFAULT_LLM_SETTINGS.embeddings.dimensions,
				{ min: 1 },
			),
		},
		deployments: MODEL_ROLES.fromEnvironment(),
	};
}

/** The most further attempts a stored schedule may ask for: past it a budget is a loop. */
const MAX_RETRIES = 10;

/**
 * A whole number for every bound; the two exceptions are what a retry
 * schedule means: no retry at all is a schedule, though never more than
 * {@link MAX_RETRIES}, and a backoff under one would shrink each wait.
 */
const ACCEPT: MergeOptions["accept"] = {
	"retry.maxRetries": integerBetween(0, MAX_RETRIES),
	"retry.backoffFactor": atLeast(1),
};

/** The stored document merged over `defaults`; a field of the wrong shape keeps the default, and the deployments and the embedding width stay the environment's. */
export function parseLlmSettings(
	stored: unknown,
	defaults: LlmSettings,
): LlmSettings {
	const { deployments, ...rest } = defaults;
	const merged = mergeOverDefault(stored, rest, {
		accept: ACCEPT,
		numbers: positiveInteger,
	});
	return {
		...merged,
		embeddings: {
			...merged.embeddings,
			dimensions: defaults.embeddings.dimensions,
		},
		deployments,
	};
}

const SINGLETON = "llm:settings";

function settingsKey() {
	return processSingleton(SINGLETON, () =>
		defineConfigKey<LlmSettings>({
			key: LLM_SETTINGS_KEY,
			defaultValue: llmSettingsFromEnvironment(),
			parse: parseLlmSettings,
		}),
	);
}

/** The current settings, through the memo. Never throws. */
export function llmSettings(): Promise<LlmSettings> {
	return settingsKey().read();
}

/** What the memo holds right now, for a synchronous reader. */
export function cachedLlmSettings(): LlmSettings {
	return settingsKey().cached();
}

/** Forget the memo, so the next read sees the environment and the store afresh. */
export function resetLlmSettings(): void {
	resetSingleton(SINGLETON);
}
