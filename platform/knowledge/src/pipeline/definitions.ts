import type {
	FieldMapping,
	InputFieldMappingEntry,
	SearchIndexer,
	SearchIndexerDataSourceConnection,
	SearchIndexerSkill,
	SearchIndexerSkillset,
} from "@azure/search-documents";
import { envString } from "@platform/config";
import { llmSettings } from "@platform/llm";
import type { KnowledgeSettings } from "../config/knowledge";
import { FIELD, indexName } from "../index/definition";
import { aiServicesUrl, embeddingModel } from "../index/embedding";
import { indexedExtensions } from "../library/formats";
import { METADATA } from "../library/metadata";

/**
 * Azure's ingestion, as definitions: a blob data source over the library
 * container, a skillset that reads pictures (OCR), splits the text into
 * pages and embeds each page (integrated vectorization), and an indexer
 * that maps each blob's metadata onto its parent document and projects one
 * chunk document per page into the index. Search objects are not ARM
 * resources, so the job's `index` step makes them through the service's
 * own API, with the index; every connection is the service's identity.
 *
 * The mappings are data, exported, so the stand-in indexer the tests run
 * maps a blob's metadata through exactly these.
 */

export function pipelineNames() {
	const index = indexName();
	return {
		index,
		dataSource: `${index}-library`,
		skillset: `${index}-skillset`,
		indexer: `${index}-indexer`,
	};
}

/** The standard alphabet with padding, as `Buffer` writes it, not the URL-token form the function defaults to. */
const BASE64 = {
	name: "base64Decode",
	parameters: { useHttpServerUtilityUrlTokenDecode: false },
};
const JSON_ARRAY = { name: "jsonArrayToStringCollection" };

/** Each blob's metadata onto its parent document, and so into the enrichment tree at `/document/<target>`. */
export const FIELD_MAPPINGS: FieldMapping[] = [
	{ sourceFieldName: METADATA.id, targetFieldName: FIELD.documentId },
	{
		sourceFieldName: METADATA.path,
		targetFieldName: FIELD.path,
		mappingFunction: BASE64,
	},
	{ sourceFieldName: METADATA.library, targetFieldName: FIELD.library },
	{ sourceFieldName: METADATA.kind, targetFieldName: FIELD.kind },
	{
		sourceFieldName: METADATA.title,
		targetFieldName: FIELD.title,
		mappingFunction: BASE64,
	},
	{
		sourceFieldName: METADATA.summary,
		targetFieldName: FIELD.summary,
		mappingFunction: BASE64,
	},
	{
		sourceFieldName: METADATA.tags,
		targetFieldName: FIELD.tags,
		mappingFunction: JSON_ARRAY,
	},
	{
		sourceFieldName: METADATA.oids,
		targetFieldName: FIELD.oids,
		mappingFunction: JSON_ARRAY,
	},
	{
		sourceFieldName: METADATA.groups,
		targetFieldName: FIELD.groups,
		mappingFunction: JSON_ARRAY,
	},
];

/** Where the split skill's pages are, and so how many chunk documents a file becomes. */
export const PAGES = "/document/pages/*";

/** One chunk document per page: the page, its vector, and the file's description copied on. */
export const PROJECTION_MAPPINGS: InputFieldMappingEntry[] = [
	{ name: FIELD.chunk, source: PAGES },
	{ name: FIELD.vector, source: `${PAGES}/vector` },
	...FIELD_MAPPINGS.map((m) => {
		const field = m.targetFieldName as string;
		return { name: field, source: `/document/${field}` };
	}),
];

export function dataSourceDefinition(): SearchIndexerDataSourceConnection {
	const storage = envString("AZURE_STORAGE_RESOURCE_ID");
	if (!storage)
		throw new Error(
			"AZURE_STORAGE_RESOURCE_ID is not set: the indexer's data source names the storage account by its resource id",
		);
	return {
		name: pipelineNames().dataSource,
		type: "azureblob",
		// A resource id and no key: the service reads with its own identity.
		connectionString: `ResourceId=${storage};`,
		container: { name: envString("AZURE_STORAGE_CONTAINER") ?? "library" },
		// A blob deleted by hand drops out at the next run, while the account
		// still keeps it soft-deleted; the job's own prune does not wait for it.
		dataDeletionDetectionPolicy: {
			odatatype:
				"#Microsoft.Azure.Search.NativeBlobSoftDeleteDeletionDetectionPolicy",
		},
	};
}

export async function skillsetDefinition(
	settings: KnowledgeSettings["indexer"],
): Promise<SearchIndexerSkillset> {
	const { dimensions } = (await llmSettings()).embeddings;
	const text = settings.ocr ? "/document/merged_content" : "/document/content";
	const ocr: SearchIndexerSkill[] = settings.ocr
		? [
				{
					odatatype: "#Microsoft.Skills.Vision.OcrSkill",
					name: "ocr",
					context: "/document/normalized_images/*",
					inputs: [{ name: "image", source: "/document/normalized_images/*" }],
					outputs: [{ name: "text", targetName: "text" }],
				},
				{
					odatatype: "#Microsoft.Skills.Text.MergeSkill",
					name: "merge",
					context: "/document",
					inputs: [
						{ name: "text", source: "/document/content" },
						{
							name: "itemsToInsert",
							source: "/document/normalized_images/*/text",
						},
						{
							name: "offsets",
							source: "/document/normalized_images/*/contentOffset",
						},
					],
					outputs: [{ name: "mergedText", targetName: "merged_content" }],
				},
			]
		: [];
	return {
		name: pipelineNames().skillset,
		skills: [
			...ocr,
			{
				odatatype: "#Microsoft.Skills.Text.SplitSkill",
				name: "split",
				context: "/document",
				textSplitMode: "pages",
				maxPageLength: settings.chunkChars,
				pageOverlapLength: settings.overlapChars,
				inputs: [{ name: "text", source: text }],
				outputs: [{ name: "textItems", targetName: "pages" }],
			},
			{
				odatatype: "#Microsoft.Skills.Text.AzureOpenAIEmbeddingSkill",
				name: "embed",
				context: PAGES,
				...embeddingModel(),
				dimensions,
				inputs: [{ name: "text", source: PAGES }],
				outputs: [{ name: "embedding", targetName: "vector" }],
			},
		],
		// OCR bills to the account by the service's identity; no key is written here.
		cognitiveServicesAccount: {
			odatatype: "#Microsoft.Azure.Search.AIServicesByIdentity",
			subdomainUrl: aiServicesUrl(),
		},
		indexProjection: {
			selectors: [
				{
					targetIndexName: indexName(),
					parentKeyFieldName: FIELD.parent,
					sourceContext: PAGES,
					mappings: PROJECTION_MAPPINGS,
				},
			],
			parameters: { projectionMode: "skipIndexingParentDocuments" },
		},
	};
}

/**
 * On demand only: no schedule, because the job runs it after it has
 * described every blob, and waits for it. A file that fails does not stop
 * the rest; the job reads the failures and fails its step.
 */
export function indexerDefinition(
	settings: KnowledgeSettings["indexer"],
): SearchIndexer {
	const names = pipelineNames();
	return {
		name: names.indexer,
		dataSourceName: names.dataSource,
		skillsetName: names.skillset,
		targetIndexName: names.index,
		fieldMappings: FIELD_MAPPINGS,
		parameters: {
			maxFailedItems: -1,
			maxFailedItemsPerBatch: -1,
			configuration: {
				parsingMode: "default",
				dataToExtract: "contentAndMetadata",
				imageAction: settings.ocr ? "generateNormalizedImages" : "none",
				indexedFileNameExtensions: indexedExtensions(),
				failOnUnsupportedContentType: false,
			},
		},
	};
}
