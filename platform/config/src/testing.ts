import {
	appConfigKeyPrefix,
	resetAppConfigClient,
	setAppConfigClient,
} from "./app-configuration";

/**
 * For tests: the configuration store stood in for at its client, holding
 * `documents` by bare key and nothing else — any other key answers the 404
 * the service gives an absent one. Returns the restore.
 */
export function fakeConfigStore(
	documents: Record<string, unknown>,
): () => void {
	setAppConfigClient({
		getConfigurationSetting: async ({ key }: { key: string }) => {
			const prefix = appConfigKeyPrefix();
			const bare = key.startsWith(prefix) ? key.slice(prefix.length) : key;
			if (!(bare in documents))
				throw Object.assign(new Error("HTTP 404"), { statusCode: 404 });
			return { key, etag: "1", value: JSON.stringify(documents[bare]) };
		},
	} as unknown as Parameters<typeof setAppConfigClient>[0]);
	return resetAppConfigClient;
}

/** For tests: a configuration store that answers every read with a 503, as one that cannot be reached does. Returns the restore. */
export function unreadableConfigStore(): () => void {
	setAppConfigClient({
		getConfigurationSetting: async () => {
			throw Object.assign(new Error("HTTP 503"), { statusCode: 503 });
		},
	} as unknown as Parameters<typeof setAppConfigClient>[0]);
	return resetAppConfigClient;
}
