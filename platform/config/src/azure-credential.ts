import { DefaultAzureCredential, type TokenCredential } from "@azure/identity";
import { processSingleton, resetSingleton, setSingleton } from "./singleton";

const KEY = "azure-credential";

/**
 * The one identity this process speaks to Azure with.
 *
 * `DefaultAzureCredential` with no arguments: `AZURE_CLIENT_ID` selects the
 * managed identity in a container, and a developer's sign-in covers a laptop.
 * One instance for every client, because a credential caches tokens per scope
 * and a second instance is a second cache paying its own first round trip.
 */
export function azureCredential(): TokenCredential {
	return processSingleton(KEY, () => new DefaultAzureCredential());
}

/** Use `credential` instead of the default chain. For tests. */
export function setAzureCredential(credential: TokenCredential): void {
	setSingleton(KEY, credential);
}

export function resetAzureCredential(): void {
	resetSingleton(KEY);
}
