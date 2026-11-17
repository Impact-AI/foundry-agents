import type {
	KnowledgeBase,
	SearchIndexKnowledgeSource,
} from "@azure/search-documents";
import { envString } from "@platform/config";
import { azureOpenAIResourceName } from "@platform/llm";
import { searchEndpoint } from "../index/client";
import {
	indexName,
	SEARCH_FIELDS,
	semanticConfigurationName,
} from "../index/definition";
import { HIT_FIELDS } from "../index/documents";

/**
 * The service's own retrieval over the one index, as the optional engine
 * (`retrieval.engine: "knowledgeBase"`): a search-index knowledge source
 * that wraps `chunks` as it is — nothing is ingested again — and one
 * knowledge base holding that source, which the backend's `knowledgeSearch`
 * asks on its `retrieve` route, for a typed turn and a live session alike
 * (`search.ts`). Both are data-plane objects of the search service, made by
 * the job's `index` step beside the index. Extractive retrieval, never the
 * service's answer synthesis; at `minimal` effort the question is searched
 * as it is, and above it the base's planning model splits it into
 * sub-queries (`retrieval.reasoningEffort`), the effort carried on each
 * call. The source is made on the GA API version; the base and its
 * `retrieve` calls are on the preview (`KNOWLEDGE_BASE_PREVIEW_API_VERSION`).
 *
 * What the base does not carry, by the GA version's shape: the readers
 * clause, the `injection eq false` filter (a persisted filter on a source is
 * the `2026-05-01-preview`'s `baseFilter`, which `@azure/search-documents`
 * 13.0.0 does not type), the reranker floor, the per-document cap and the
 * unmatched query terms. The backend reads the chunks the base chose back
 * under the clause and the filter (`search.ts`).
 */

/**
 * The preview version the base is written and asked on: the GA version
 * (`2026-04-01`) takes neither a model on a base nor a reasoning effort,
 * on the base or on a call ([Create a knowledge
 * base](https://learn.microsoft.com/en-us/azure/search/agentic-retrieval-how-to-create-knowledge-base)
 * lists both among what it does not support), and
 * `@azure/search-documents` 13.0.0 serializes neither. So the base is PUT,
 * and `retrieve` called, by REST on this version.
 */
export const KNOWLEDGE_BASE_PREVIEW_API_VERSION = "2026-08-01-preview";

export function knowledgeSourceName(): string {
	return `${indexName()}-source`;
}

/** The source: the index, its semantic configuration, the searchable fields, and the hit fields as what a passage carries. */
export function knowledgeSourceDefinition(): SearchIndexKnowledgeSource {
	return {
		name: knowledgeSourceName(),
		kind: "searchIndex",
		searchIndexParameters: {
			searchIndexName: indexName(),
			semanticConfigurationName: semanticConfigurationName(),
			searchFields: SEARCH_FIELDS.map((name) => ({ name })),
			sourceDataFields: HIT_FIELDS.map((name) => ({ name })),
		},
	};
}

/**
 * The model the base plans with above `minimal`: the deployment the template
 * makes for it alone (`models.knowledgeBase`, `AZURE_OPENAI_KNOWLEDGE_BASE_*`),
 * on the account's `openai.azure.com` host, reached keyless as the search
 * service's own identity, which holds Cognitive Services User on the
 * account — the same identity and route its vectorizer embeds every query
 * with. No `apiKey` and no `authIdentity`: both blank is the system identity
 * (Learn, "Configure a vectorizer", for the type this shares). Null while
 * either variable is unset, and then the base holds no model and every
 * search runs at `minimal`.
 */
export interface KnowledgeBasePlanner {
	resourceUri: string;
	deploymentId: string;
	modelName: string;
}

export function knowledgeBasePlanner(): KnowledgeBasePlanner | null {
	const deploymentId = envString("AZURE_OPENAI_KNOWLEDGE_BASE_DEPLOYMENT");
	const modelName = envString("AZURE_OPENAI_KNOWLEDGE_BASE_MODEL");
	const account = azureOpenAIResourceName();
	if (!deploymentId || !modelName || !account) return null;
	return {
		resourceUri: `https://${account}.openai.azure.com`,
		deploymentId,
		modelName,
	};
}

/**
 * The GA base plus the preview properties it carries: the effort it
 * defaults to, `minimal`, which every call overrides with its own; and,
 * while there is a planning model, the model and the output mode.
 * Extractive, always: the base hands back the chunks it found and the agent
 * writes the answer, so there is one voice and one guardrail on what a
 * person reads, and the base's own synthesis (`answerSynthesis`, refused at
 * `minimal`) is never asked for.
 */
export type KnowledgeBaseBody = KnowledgeBase & {
	retrievalReasoningEffort: { kind: "minimal" };
	models?: {
		kind: "azureOpenAI";
		azureOpenAIParameters: KnowledgeBasePlanner;
	}[];
	outputMode?: "extractiveData";
};

/**
 * The base's name: the index's with `-kb`. Without a planning model it
 * holds no model, and the service refuses a call above `minimal` on it
 * (HTTP 400 "A Knowledge Base model must be specified to use any reasoning
 * effort other than 'Minimal'").
 */
function knowledgeBaseName(): string {
	return `${indexName()}-kb`;
}

/**
 * Bases an earlier shape of the engine made beside this one, one per effort
 * above `minimal`, which the job deletes where they are left
 * (`ensure.ts`): every effort is a call's on the one base now.
 */
export function retiredKnowledgeBaseNames(): string[] {
	return [`${indexName()}-kb-low`, `${indexName()}-kb-medium`];
}

export function knowledgeBaseDefinition(
	planner: KnowledgeBasePlanner | null = null,
): KnowledgeBaseBody {
	const base = {
		name: knowledgeBaseName(),
		knowledgeSources: [{ name: knowledgeSourceName() }],
		retrievalReasoningEffort: { kind: "minimal" as const },
	};
	if (!planner) return base;
	return {
		...base,
		models: [{ kind: "azureOpenAI", azureOpenAIParameters: planner }],
		outputMode: "extractiveData",
	};
}

function knowledgeBasePath(): string {
	return `${searchEndpoint().replace(/\/$/, "")}/knowledgebases/${knowledgeBaseName()}`;
}

/** Where the job PUTs the base, on the preview version that accepts its model and effort. */
export function knowledgeBaseUrl(): string {
	return `${knowledgeBasePath()}?api-version=${KNOWLEDGE_BASE_PREVIEW_API_VERSION}`;
}

/** The base's `retrieve` route, which `knowledgeSearch` calls with the backend as the caller (`search.ts`). */
export function knowledgeBaseRetrieveUrl(): string {
	return `${knowledgeBasePath()}/retrieve?api-version=${KNOWLEDGE_BASE_PREVIEW_API_VERSION}`;
}
