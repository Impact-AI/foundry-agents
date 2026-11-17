import type { SearchIndex } from "@azure/search-documents";
import { envString } from "@platform/config";
import { llmSettings } from "@platform/llm";
import { embeddingModel } from "./embedding";

/**
 * The one index, as the indexer fills it: one document per chunk the text
 * split skill cut, each carrying what its blob's metadata said about the
 * whole file.
 *
 * Four fields are searchable: `title`, `summary`, `chunk` and `tags`. They
 * are the whole input to the lexical arm, the vector and the reranker, so a
 * thing nobody wrote down in one of them cannot be found. A path, a kind and
 * an id are payload or filter, never a description. `tags` is both
 * searchable and filterable, which makes it the only way a query can say
 * "this and nothing else". `oids` and `groups` are the readers, filter
 * only: who may see a document is a clause every query carries under
 * enforcement, never a term in it. `injection` and `shieldedHash` are the
 * job's, written after Prompt Shields has read the chunk; a chunk it has
 * not read has no `injection`, and so no query that asks for `injection eq
 * false` can return it.
 */

export function indexName(): string {
	return envString("AZURE_SEARCH_INDEX") ?? "chunks";
}

export function semanticConfigurationName(): string {
	return `${indexName()}-semantic`;
}

/** The fields by role, so a query, a projection and the stand-in name them once. */
export const FIELD = {
	key: "chunkId",
	/** The parent's key, which the projection writes: opaque, the indexer's own. */
	parent: "parentId",
	documentId: "documentId",
	path: "path",
	library: "library",
	kind: "kind",
	title: "title",
	summary: "summary",
	tags: "tags",
	chunk: "chunk",
	vector: "vector",
	oids: "oids",
	groups: "groups",
	injection: "injection",
	shieldedHash: "shieldedHash",
} as const;

/** What the lexical arm reads: the key is searchable only because a projection's key must be. */
export const SEARCH_FIELDS = [
	FIELD.title,
	FIELD.summary,
	FIELD.chunk,
	FIELD.tags,
] as const;

/**
 * One analyzer for every searchable field, language-neutral: a corpus that
 * is written in several languages loses recall quietly under an English
 * stemmer. A property of the index definition, the same on all four fields
 * on purpose; a corpus in one language changes it here and re-indexes.
 */
export const ANALYZER = "standard.lucene";

/**
 * HNSW at m 16 / efConstruction 400, cosine. Vectors are scalar-quantised to
 * int8, which cuts the storage of a 3072-wide float vector about four times,
 * with rescoring against the originals left on so the recall cost is paid at
 * query time rather than baked into the index. The vectorizer is the
 * embedding deployment the skillset embeds with, so a query is embedded by
 * the service, with its own identity, into the same space.
 */
export async function chunkIndexDefinition(): Promise<SearchIndex> {
	const name = indexName();
	const { dimensions } = (await llmSettings()).embeddings;
	const algorithm = `${name}-hnsw`;
	const compression = `${name}-scalar-quantization`;
	const vectorizer = `${name}-vectorizer`;
	const profile = `${name}-vector-profile`;
	const searchable = (field: string) => ({
		name: field,
		type: "Edm.String" as const,
		searchable: true,
		analyzerName: ANALYZER,
	});
	const filterable = (field: string) => ({
		name: field,
		type: "Edm.String" as const,
		filterable: true,
	});
	return {
		name,
		fields: [
			{
				name: FIELD.key,
				type: "Edm.String",
				key: true,
				// A projection's key is matched whole, which is the keyword analyzer.
				searchable: true,
				analyzerName: "keyword",
				filterable: true,
				sortable: true,
			},
			filterable(FIELD.parent),
			filterable(FIELD.documentId),
			filterable(FIELD.path),
			filterable(FIELD.library),
			filterable(FIELD.kind),
			searchable(FIELD.title),
			searchable(FIELD.summary),
			searchable(FIELD.chunk),
			{
				name: FIELD.tags,
				type: "Collection(Edm.String)",
				searchable: true,
				filterable: true,
				facetable: true,
				analyzerName: ANALYZER,
			},
			{
				name: FIELD.vector,
				type: "Collection(Edm.Single)",
				searchable: true,
				// Never returned in a result, but stored: the shield's verdict is
				// merged onto a chunk afterwards, and a merge that omits a vector the
				// index does not store erases it, without an error. Every chunk the
				// search serves has been merged, so unstored, the vector arm finds
				// nothing and a question in another language than the library's has
				// only the keyword arm.
				hidden: true,
				stored: true,
				vectorSearchDimensions: dimensions,
				vectorSearchProfileName: profile,
			},
			// Who may read the document, as object ids: filterable only, because
			// an id is a key a filter matches, never a word anybody searches for.
			{ name: FIELD.oids, type: "Collection(Edm.String)", filterable: true },
			{ name: FIELD.groups, type: "Collection(Edm.String)", filterable: true },
			{ name: FIELD.injection, type: "Edm.Boolean", filterable: true },
			{ name: FIELD.shieldedHash, type: "Edm.String" },
		],
		vectorSearch: {
			algorithms: [
				{
					name: algorithm,
					kind: "hnsw",
					parameters: { m: 16, efConstruction: 400, metric: "cosine" },
				},
			],
			compressions: [
				{
					compressionName: compression,
					kind: "scalarQuantization",
					parameters: { quantizedDataType: "int8" },
					rescoringOptions: {
						enableRescoring: true,
						rescoreStorageMethod: "preserveOriginals",
					},
				},
			],
			vectorizers: [
				{
					vectorizerName: vectorizer,
					kind: "azureOpenAI",
					parameters: embeddingModel(),
				},
			],
			profiles: [
				{
					name: profile,
					algorithmConfigurationName: algorithm,
					compressionName: compression,
					vectorizerName: vectorizer,
				},
			],
		},
		semanticSearch: {
			configurations: [
				{
					name: semanticConfigurationName(),
					prioritizedFields: {
						titleField: { name: FIELD.title },
						contentFields: [{ name: FIELD.chunk }, { name: FIELD.summary }],
						keywordsFields: [{ name: FIELD.tags }],
					},
				},
			],
		},
	};
}
