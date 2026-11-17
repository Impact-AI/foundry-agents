import { resetAzureCredential, setAzureCredential } from "@platform/config";
import { scopedEnv } from "@platform/test-support";
import { resetCognitiveServicesToken } from "../azure-auth";
import { EMBEDDING_DIMENSIONS_VAR, resetLlmSettings } from "../config";
import { MODEL_ROLES } from "../deployment";
import { RESOURCE_NAME_VAR } from "../model-roles";
import { resetProviderFetch } from "../provider-fetch";

/** The token every stood-in credential mints. */
export const TOKEN = "token-1";

const ENV = [
	"APP_CONFIG_ENDPOINT",
	RESOURCE_NAME_VAR,
	EMBEDDING_DIMENSIONS_VAR,
	...MODEL_ROLES.names.map((role) => MODEL_ROLES.specs[role].envVar),
];

/**
 * The environment a test runs in: no store, a fake credential minting
 * `TOKEN`, and the given variables. `clearing` names further variables to
 * unset first and put back after, for a package whose roles are its own.
 * Returns the restore.
 */
export function configure(
	env: Record<string, string> = {},
	clearing: readonly string[] = [],
): () => void {
	const restoreEnv = scopedEnv({
		...Object.fromEntries(
			[...ENV, ...clearing].map((name) => [name, undefined]),
		),
		...env,
	});
	setAzureCredential({
		getToken: async () => ({
			token: TOKEN,
			expiresOnTimestamp: Date.now() + 3_600_000,
		}),
	});
	resetCognitiveServicesToken();
	resetLlmSettings();
	return () => {
		restoreEnv();
		resetProviderFetch();
		resetAzureCredential();
		resetCognitiveServicesToken();
		resetLlmSettings();
	};
}
