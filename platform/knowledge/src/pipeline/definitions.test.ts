import { afterEach, beforeEach, expect, test } from "bun:test";
import type {
	AzureOpenAIEmbeddingSkill,
	SearchIndex,
	SplitSkill,
} from "@azure/search-documents";
import { resetLlmSettings } from "@platform/llm";
import { scopedEnv } from "@platform/test-support";
import { DEFAULT_KNOWLEDGE_SETTINGS } from "../config/knowledge";
import { chunkIndexDefinition, FIELD } from "../index/definition";
import { METADATA } from "../library/metadata";
import { PIPELINE_ENV } from "../testing/index";
import {
	dataSourceDefinition,
	FIELD_MAPPINGS,
	indexerDefinition,
	PROJECTION_MAPPINGS,
	pipelineNames,
	skillsetDefinition,
} from "./definitions";

/**
 * The definitions the job hands the service, read as the service reads
 * them: keyless everywhere, every metadata key mapped with the function its
 * encoding needs, one chunk per page carrying the file's description, and
 * the manifests out of the indexer's reach.
 */

let restore = () => {};
beforeEach(() => {
	restore = scopedEnv({
		...PIPELINE_ENV,
		AZURE_SEARCH_INDEX: undefined,
		AZURE_STORAGE_CONTAINER: undefined,
		AZURE_OPENAI_EMBEDDING_DIMENSIONS: "1024",
		APP_CONFIG_ENDPOINT: undefined,
	});
	resetLlmSettings();
});
afterEach(() => {
	restore();
	resetLlmSettings();
});

const INDEXER = DEFAULT_KNOWLEDGE_SETTINGS.indexer;

test("the four objects are named for the index", () => {
	expect(pipelineNames()).toEqual({
		index: "chunks",
		dataSource: "chunks-library",
		skillset: "chunks-skillset",
		indexer: "chunks-indexer",
	});
});

test("the data source reads the library container with the service's identity and finds a deleted blob through soft delete", () => {
	expect(dataSourceDefinition()).toEqual({
		name: "chunks-library",
		type: "azureblob",
		connectionString: `ResourceId=${PIPELINE_ENV.AZURE_STORAGE_RESOURCE_ID};`,
		container: { name: "library" },
		dataDeletionDetectionPolicy: {
			odatatype:
				"#Microsoft.Azure.Search.NativeBlobSoftDeleteDeletionDetectionPolicy",
		},
	});
	process.env.AZURE_STORAGE_RESOURCE_ID = "";
	expect(() => dataSourceDefinition()).toThrow("AZURE_STORAGE_RESOURCE_ID");
});

test("every metadata key is mapped onto the parent with the function its encoding needs", () => {
	const by = Object.fromEntries(
		FIELD_MAPPINGS.map((m) => [m.sourceFieldName, m]),
	);
	expect(Object.keys(by).sort()).toEqual(Object.values(METADATA).sort());
	for (const key of [METADATA.path, METADATA.title, METADATA.summary])
		expect(by[key]?.mappingFunction).toEqual({
			name: "base64Decode",
			parameters: { useHttpServerUtilityUrlTokenDecode: false },
		});
	for (const key of [METADATA.tags, METADATA.oids, METADATA.groups])
		expect(by[key]?.mappingFunction).toEqual({
			name: "jsonArrayToStringCollection",
		});
	for (const key of [METADATA.id, METADATA.library, METADATA.kind])
		expect(by[key]?.mappingFunction).toBeUndefined();
	expect(by[METADATA.oids]?.targetFieldName).toBe(FIELD.oids);
	expect(by[METADATA.groups]?.targetFieldName).toBe(FIELD.groups);
});

test("each page is projected with its text, its vector and the file's description, readers included, into fields the index has", async () => {
	const index = (await chunkIndexDefinition()) as SearchIndex;
	const fields = new Set(index.fields.map((f) => f.name));
	for (const mapping of PROJECTION_MAPPINGS)
		expect(fields.has(mapping.name)).toBe(true);
	expect(PROJECTION_MAPPINGS).toContainEqual({
		name: FIELD.chunk,
		source: "/document/pages/*",
	});
	expect(PROJECTION_MAPPINGS).toContainEqual({
		name: FIELD.oids,
		source: "/document/oids",
	});
	expect(PROJECTION_MAPPINGS).toContainEqual({
		name: FIELD.groups,
		source: "/document/groups",
	});
	// The job's own fields are never the indexer's to write.
	expect(PROJECTION_MAPPINGS.map((m) => m.name)).not.toContain(FIELD.injection);
});

test("the skillset reads pictures, splits, embeds keyless at the index's width, bills OCR to the account by identity, and projects one chunk per page", async () => {
	const skillset = await skillsetDefinition(INDEXER);
	expect(skillset.skills.map((s) => s.odatatype)).toEqual([
		"#Microsoft.Skills.Vision.OcrSkill",
		"#Microsoft.Skills.Text.MergeSkill",
		"#Microsoft.Skills.Text.SplitSkill",
		"#Microsoft.Skills.Text.AzureOpenAIEmbeddingSkill",
	]);
	const split = skillset.skills[2] as SplitSkill;
	expect(split).toMatchObject({
		maxPageLength: 2000,
		pageOverlapLength: 200,
		inputs: [{ name: "text", source: "/document/merged_content" }],
	});
	const embed = skillset.skills[3] as AzureOpenAIEmbeddingSkill;
	expect(embed).toMatchObject({
		resourceUrl: "https://account.openai.azure.com",
		deploymentId: "embedding",
		modelName: "text-embedding-3-large",
		dimensions: 1024,
	});
	expect(embed.apiKey).toBeUndefined();
	expect(skillset.cognitiveServicesAccount).toEqual({
		odatatype: "#Microsoft.Azure.Search.AIServicesByIdentity",
		subdomainUrl: "https://account.cognitiveservices.azure.com/",
	});
	expect(skillset.indexProjection).toMatchObject({
		selectors: [
			{
				targetIndexName: "chunks",
				parentKeyFieldName: FIELD.parent,
				sourceContext: "/document/pages/*",
			},
		],
		parameters: { projectionMode: "skipIndexingParentDocuments" },
	});

	const noOcr = await skillsetDefinition({ ...INDEXER, ocr: false });
	expect(noOcr.skills.map((s) => s.odatatype)).toEqual([
		"#Microsoft.Skills.Text.SplitSkill",
		"#Microsoft.Skills.Text.AzureOpenAIEmbeddingSkill",
	]);
	expect((noOcr.skills[0] as SplitSkill).inputs[0]?.source).toBe(
		"/document/content",
	);
});

test("the indexer runs only when the job asks, keeps going past a bad file, and never reads a manifest", () => {
	const indexer = indexerDefinition(INDEXER);
	expect(indexer.schedule).toBeUndefined();
	expect(indexer.fieldMappings).toBe(FIELD_MAPPINGS);
	expect(indexer.parameters).toMatchObject({
		maxFailedItems: -1,
		configuration: {
			dataToExtract: "contentAndMetadata",
			imageAction: "generateNormalizedImages",
		},
	});
	const extensions = String(
		indexer.parameters?.configuration?.indexedFileNameExtensions,
	).split(",");
	for (const ext of [".pdf", ".docx", ".pptx", ".xlsx", ".md", ".png"])
		expect(extensions).toContain(ext);
	expect(extensions).not.toContain(".json");
	expect(
		indexerDefinition({ ...INDEXER, ocr: false }).parameters?.configuration
			?.imageAction,
	).toBe("none");
});

test("the index embeds a query with the same deployment, keyless, and keys a projection by a keyword-analysed key", async () => {
	const index = (await chunkIndexDefinition()) as SearchIndex;
	expect(index.vectorSearch?.vectorizers).toEqual([
		{
			vectorizerName: "chunks-vectorizer",
			kind: "azureOpenAI",
			parameters: {
				resourceUrl: "https://account.openai.azure.com",
				deploymentId: "embedding",
				modelName: "text-embedding-3-large",
			},
		},
	]);
	const key = index.fields.find((f) => "key" in f && f.key);
	expect(key).toMatchObject({ name: FIELD.key, analyzerName: "keyword" });
	const vector = index.fields.find((f) => f.name === FIELD.vector);
	// Stored, so the shield's merge onto a chunk keeps its vector.
	expect(vector).toMatchObject({ vectorSearchDimensions: 1024, stored: true });
	const readers = index.fields.filter((f) =>
		[FIELD.oids, FIELD.groups].includes(f.name as "oids"),
	);
	for (const field of readers)
		expect(field).toEqual({
			name: field.name,
			type: "Collection(Edm.String)",
			filterable: true,
		});
	process.env.AZURE_OPENAI_EMBEDDING_MODEL = "";
	await expect(chunkIndexDefinition()).rejects.toThrow(
		"AZURE_OPENAI_EMBEDDING_MODEL",
	);
});
