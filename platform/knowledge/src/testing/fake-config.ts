import { fakeConfigStore } from "@platform/config/testing";
import {
	ACCESS_SETTINGS_KEY,
	type AccessSettings,
	resetAccessSettings,
} from "../config/access";
import {
	KNOWLEDGE_SETTINGS_KEY,
	type KnowledgeSettings,
	resetKnowledgeSettings,
} from "../config/knowledge";

/**
 * The operator's documents, served from a store stood in for at the client;
 * every key not given is absent. The memos are reset on the way in and on
 * the way out, so a test reads what it staged and the next one reads the
 * default.
 */
export function stagedSettings(documents: Record<string, unknown>): () => void {
	const restore = fakeConfigStore(documents);
	resetAccessSettings();
	resetKnowledgeSettings();
	return () => {
		restore();
		resetAccessSettings();
		resetKnowledgeSettings();
	};
}

/** The `access` document alone. */
export function stagedAccessSettings(
	settings: Partial<AccessSettings>,
): () => void {
	return stagedSettings({ [ACCESS_SETTINGS_KEY]: settings });
}

/** The `knowledge` document alone; a partial document is merged over the defaults as a stored one would be. */
export function stagedKnowledgeSettings(
	settings: {
		[S in keyof KnowledgeSettings]?: Partial<KnowledgeSettings[S]>;
	},
): () => void {
	return stagedSettings({ [KNOWLEDGE_SETTINGS_KEY]: settings });
}
