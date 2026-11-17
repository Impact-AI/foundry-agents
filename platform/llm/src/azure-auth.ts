/**
 * How this process proves who it is to Azure OpenAI: an Entra access token
 * minted by the process's one credential, never an API key. The account is
 * created with local authentication disabled, so there is no key to hand out;
 * the identity holds Cognitive Services OpenAI User on it. The token is cached
 * and refreshed before expiry, and a burst of calls shares one mint.
 */
import { type AzureOpenAIProvider, createAzure } from "@ai-sdk/azure";
import {
	azureCredential,
	createEntraTokenProvider,
	type EntraTokenProvider,
	type EntraTokenProviderOptions,
	envString,
	processSingleton,
	resetSingleton,
} from "@platform/config";
import { ModelNotConfiguredError, RESOURCE_NAME_VAR } from "./model-roles";
import { providerFetch } from "./provider-fetch";

/** The audience every Cognitive Services data plane accepts. */
export const COGNITIVE_SERVICES_SCOPE =
	"https://cognitiveservices.azure.com/.default";

const NO_TOKEN_HINT =
	"Check that AZURE_CLIENT_ID names the identity and that it holds Cognitive Services OpenAI User on the account.";

const TOKEN = "llm:cognitive-services-token";

export function createCognitiveServicesTokenProvider(
	options: Partial<Omit<EntraTokenProviderOptions, "scope" | "hint">> = {},
): EntraTokenProvider {
	return createEntraTokenProvider({
		credential: azureCredential,
		...options,
		scope: COGNITIVE_SERVICES_SCOPE,
		hint: NO_TOKEN_HINT,
	});
}

/** The process's cached token for Azure OpenAI. */
export function cognitiveServicesToken(): Promise<string> {
	return processSingleton(TOKEN, createCognitiveServicesTokenProvider)();
}

export function resetCognitiveServicesToken(): void {
	resetSingleton(TOKEN);
}

export function azureOpenAIResourceName(): string | undefined {
	return envString(RESOURCE_NAME_VAR);
}

/**
 * The AI SDK's Azure provider on this environment's account, presenting the
 * token on every request. One per call, cheaply: a provider holds no
 * connection, and the token cache is the singleton above.
 */
export function azureOpenAI(): AzureOpenAIProvider {
	const resourceName = azureOpenAIResourceName();
	if (!resourceName) throw new ModelNotConfiguredError("account");
	return createAzure({
		resourceName,
		tokenProvider: cognitiveServicesToken,
		fetch: providerFetch() as typeof fetch,
	});
}
