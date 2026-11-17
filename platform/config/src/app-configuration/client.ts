import { AppConfigurationClient } from "@azure/app-configuration";
import { azureCredential } from "../azure-credential";
import { envString } from "../env";
import {
	hasSingleton,
	processSingleton,
	resetSingleton,
	setSingleton,
} from "../singleton";

/**
 * The store is created with local authentication disabled, so the only way in
 * is Entra RBAC against its endpoint: readers hold App Configuration Data
 * Reader, the job that seeds documents Data Owner. An unset endpoint is a failure, not a cue to
 * read from somewhere else; callers on a render path catch it and serve their
 * compiled-in default.
 */

const CLIENT = "app-configuration-client";

export function appConfigEndpoint(): string | undefined {
	return envString("APP_CONFIG_ENDPOINT");
}

/** Whether there is a store to read: one configured, or a client a test injected. */
export function appConfigAvailable(): boolean {
	return appConfigEndpoint() !== undefined || hasSingleton(CLIENT);
}

/**
 * Keys are namespaced so the store stays legible in the portal, which groups on
 * `/`. Callers pass bare names; the prefix is applied here.
 */
export function appConfigKeyPrefix(): string {
	return envString("APP_CONFIG_KEY_PREFIX") ?? "app/";
}

export function qualifyKey(key: string): string {
	const prefix = appConfigKeyPrefix();
	return key.startsWith(prefix) ? key : `${prefix}${key}`;
}

export function appConfigClient(): AppConfigurationClient {
	return processSingleton(CLIENT, () => {
		const endpoint = appConfigEndpoint();
		if (!endpoint) {
			throw new Error(
				"APP_CONFIG_ENDPOINT is not set — there is no App Configuration store to read. " +
					"Leave it unset locally and callers fall back to their compiled-in defaults.",
			);
		}
		return new AppConfigurationClient(endpoint, azureCredential());
	});
}

export function setAppConfigClient(client: AppConfigurationClient): void {
	setSingleton(CLIENT, client);
}

export function resetAppConfigClient(): void {
	resetSingleton(CLIENT);
}
