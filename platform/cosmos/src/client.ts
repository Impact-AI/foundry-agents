import { CosmosClient } from "@azure/cosmos";
import {
	azureCredential,
	envString,
	hasSingleton,
	processSingleton,
	resetSingleton,
	setSingleton,
} from "@platform/config";
import type { CosmosDatabase } from "./container";
import { sdkDatabase } from "./sdk";

/**
 * The process's one database, keyless: `COSMOS_ENDPOINT` names the account,
 * `COSMOS_DATABASE` the database (default `app`), and the process's identity
 * holds Cosmos DB Built-in Data Contributor on that database alone, so local
 * authentication stays off on the account and nothing here holds a secret.
 *
 * `COSMOS_KEY` is the emulator's, for tests and the end-to-end run only: a
 * deployed replica refuses to start with it set (`cosmosDeploymentRules`).
 */

const KEY = "cosmos:database";
export const DEFAULT_DATABASE = "app";

/**
 * Throttling (429) is retried by the SDK, after the wait the service names
 * in `x-ms-retry-after-ms`, at most this many times and this long in all:
 * a sign-in or a turn would rather fail than sit behind a throttled account.
 */
const RETRY_ATTEMPTS = 5;
const RETRY_WAIT_SECONDS = 10;
/** One request, connection included. */
const REQUEST_TIMEOUT_MS = 10_000;

interface Held {
	database: CosmosDatabase;
	close(): void;
}

function open(): Held {
	const endpoint = envString("COSMOS_ENDPOINT");
	if (!endpoint)
		throw new Error(
			"No Cosmos DB account is configured: set COSMOS_ENDPOINT (and COSMOS_KEY for the emulator).",
		);
	const key = envString("COSMOS_KEY");
	const client = new CosmosClient({
		endpoint,
		...(key ? { key } : { aadCredentials: azureCredential() }),
		connectionPolicy: {
			requestTimeout: REQUEST_TIMEOUT_MS,
			retryOptions: {
				maxRetryAttemptCount: RETRY_ATTEMPTS,
				maxWaitTimeInSeconds: RETRY_WAIT_SECONDS,
			},
			// A key is only ever the emulator's, which is one region on the
			// address it was reached at: nothing to discover.
			enableEndpointDiscovery: !key,
		},
	});
	return {
		database: sdkDatabase(
			client.database(envString("COSMOS_DATABASE") ?? DEFAULT_DATABASE),
		),
		close: () => client.dispose(),
	};
}

export function cosmosDatabase(): CosmosDatabase {
	return processSingleton(KEY, open).database;
}

/** Use `database` instead of the configured one. For tests, and the stand-in the dev server runs on. */
export function setCosmosDatabase(database: CosmosDatabase): void {
	setSingleton<Held>(KEY, { database, close: () => {} });
}

/** Close the client, if one was opened; the next use opens another. */
export function closeCosmos(): void {
	if (!hasSingleton(KEY)) return;
	const held = processSingleton<Held>(KEY, open);
	resetSingleton(KEY);
	held.close();
}
