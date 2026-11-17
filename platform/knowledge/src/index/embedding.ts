import type { AzureOpenAIParameters } from "@azure/search-documents";
import { envString } from "@platform/config";
import {
	azureOpenAIResourceName,
	MODEL_ROLES,
	ModelNotConfiguredError,
	requireDeployment,
} from "@platform/llm";

/**
 * The account AI Search reaches with its own identity: the embedding
 * deployment its skillset embeds every chunk with and its vectorizer embeds
 * every query with, and the account its skillset bills OCR to. Keyless: no
 * key is ever written into a definition, the service's identity holds
 * Cognitive Services User on the account.
 */

const MODEL_VAR = "AZURE_OPENAI_EMBEDDING_MODEL";

function resourceName(): string {
	const name = azureOpenAIResourceName();
	if (!name) throw new ModelNotConfiguredError("account");
	return name;
}

/**
 * The embedding deployment as the skill and the vectorizer name it. The
 * model's name is required beside the deployment's, and like a deployment
 * it has no compiled-in default: it is a fact about one account.
 */
export function embeddingModel(): AzureOpenAIParameters {
	const modelName = envString(MODEL_VAR);
	if (!modelName)
		throw new Error(
			`${MODEL_VAR} is not set: the indexer and the vectorizer name the embedding model as well as its deployment`,
		);
	return {
		resourceUrl: `https://${resourceName()}.openai.azure.com`,
		deploymentId: requireDeployment(MODEL_ROLES.fromEnvironment(), "embedding"),
		modelName,
	};
}

/** The account's own host, where OCR is billed and Prompt Shields answers. */
export function aiServicesUrl(): string {
	return `https://${resourceName()}.cognitiveservices.azure.com/`;
}
