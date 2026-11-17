import {
	processSingleton,
	resetSingleton,
	setSingleton,
	withDeadline,
} from "@platform/config";
import type { KnowledgeBaseEffort } from "../config/knowledge";
import { searchBearer, searchClient } from "../index/client";
import { FIELD } from "../index/definition";
import { HIT_FIELDS, type HitDocument, toHit } from "../index/documents";
import { oneOf } from "../index/odata";
import { accessClauseFor, servedFilter } from "../query/access";
import { type SearchOptions, searchDeadlineMs } from "../query/search";
import { buildFilter } from "../query/spec";
import type { SearchHit } from "../types";
import { knowledgeBaseRetrieveUrl, knowledgeSourceName } from "./definition";

/**
 * The knowledge base's retrieval with the backend as its caller: the
 * search `knowledgeSearch` runs while `retrieval.engine` is
 * `knowledgeBase`, for a typed turn and a live session alike. The base's
 * `retrieve` route chooses the chunks at the effort the call carries, and
 * answers each by its key with the
 * reranker's score. Every call carries the served filter as the source's
 * `filterAddOn`, and under enforcement the caller's readers clause beside
 * it, so the base chooses only among the chunks the hybrid query could
 * find. The backend sets it from the verified identity; the model never
 * sees it. The chunks are then read from the index by those keys under the
 * same clause again, as defense in depth: a key it does not admit is left
 * out and said once. Over the search private
 * endpoint the backend already queries, as its own identity.
 */

/** One chunk the base chose, in its order. */
export interface KnowledgeBaseChunk {
	key: string;
	rerankerScore: number | null;
}

/** The base's `retrieve` route, standable-in for tests. */
export interface KnowledgeBaseRetriever {
	retrieve(
		query: string,
		effort: KnowledgeBaseEffort,
		signal: AbortSignal,
		/** The served filter, with the readers clause under enforcement, as the source's `filterAddOn`. */
		filter?: string | null,
	): Promise<KnowledgeBaseChunk[]>;
}

const RETRIEVER = "knowledge:knowledge-base-retriever";

interface RetrieveResponse {
	references?: {
		type?: unknown;
		docKey?: unknown;
		rerankerScore?: unknown;
	}[];
}

/**
 * The references of a `retrieve` answer that name a chunk of the index, in
 * order: `docKey` is the chunk's key. Anything else names nothing.
 */
export function referencedChunks(body: unknown): KnowledgeBaseChunk[] {
	const references = (body as RetrieveResponse | null)?.references;
	if (!Array.isArray(references)) return [];
	return references.flatMap((ref) =>
		ref?.type === "searchIndex" && typeof ref.docKey === "string" && ref.docKey
			? [
					{
						key: ref.docKey,
						rerankerScore:
							typeof ref.rerankerScore === "number" ? ref.rerankerScore : null,
					},
				]
			: [],
	);
}

/**
 * The request the minimal base is asked, with the effort on the call, which
 * overrides the base's own query by query (Learn, "Set the retrieval
 * reasoning effort"). At `minimal` the question as one semantic intent: the
 * service refuses messages there ("Messages input not supported when
 * 'minimal' reasoning effort is requested"). Above it the question as a
 * user message, the conversation shape the planner is documented with. The
 * service plans an intent too above `minimal` — it answers a `low` call
 * with intents with a `modelQueryPlanning` step in its activity — although
 * the route's description calls intents queries "to execute without model
 * query planning". Extractive at every effort: the agent writes the answer.
 * A filter goes on the one source as its `filterAddOn`, an OData filter
 * applied to the index (Learn, "Retrieve data using a knowledge base").
 */
export function retrieveRequest(
	query: string,
	effort: KnowledgeBaseEffort,
	filter?: string | null,
): Record<string, unknown> {
	const kind = {
		retrievalReasoningEffort: { kind: effort },
		...(filter
			? {
					knowledgeSourceParams: [
						{
							knowledgeSourceName: knowledgeSourceName(),
							kind: "searchIndex",
							filterAddOn: filter,
						},
					],
				}
			: {}),
	};
	if (effort === "minimal")
		return { intents: [{ type: "semantic", search: query }], ...kind };
	return {
		messages: [{ role: "user", content: [{ type: "text", text: query }] }],
		outputMode: "extractiveData",
		...kind,
	};
}

function knowledgeBaseRetriever(): KnowledgeBaseRetriever {
	return processSingleton(RETRIEVER, (): KnowledgeBaseRetriever => {
		const bearer = searchBearer();
		return {
			async retrieve(query, effort, signal, filter) {
				const response = await fetch(knowledgeBaseRetrieveUrl(), {
					method: "POST",
					headers: {
						Authorization: `Bearer ${await bearer()}`,
						"Content-Type": "application/json",
					},
					body: JSON.stringify(retrieveRequest(query, effort, filter)),
					signal,
				});
				if (!response.ok)
					throw new Error(
						`knowledge base retrieve answered ${response.status}: ${(await response.text()).slice(0, 300)}`,
					);
				return referencedChunks(await response.json());
			},
		};
	});
}

/** Use `retriever` for the base's route. For tests. */
export function setKnowledgeBaseRetriever(
	retriever: KnowledgeBaseRetriever,
): void {
	setSingleton(RETRIEVER, retriever);
}

export function resetKnowledgeBaseRetriever(): void {
	resetSingleton(RETRIEVER);
}

/**
 * A search on the base, in `searchChunks`' shape, so `retrieve` runs it as
 * it runs the hybrid query: the question to the base, then the chunks it
 * chose read under the clause and the spec's filter, in its order, capped
 * per document and at `topK`. No reranker floor: the base's own ranking
 * stands.
 */
export async function knowledgeBaseSearch(
	opts: SearchOptions,
	effort: KnowledgeBaseEffort = "minimal",
): Promise<SearchHit[]> {
	const access = await accessClauseFor(opts.access);
	if (access.kind === "refused") return [];
	const deadline = opts.deadlineMs ?? (await searchDeadlineMs());
	const chosen = await withDeadline(
		(signal) =>
			knowledgeBaseRetriever().retrieve(
				opts.query.trim(),
				effort,
				signal,
				servedFilter(access),
			),
		deadline,
		() => new Error(`knowledge base did not answer within ${deadline}ms`),
	);
	const keys = [...new Set(chosen.map((ref) => ref.key))].filter(
		(key) => !key.includes("|"),
	);
	if (!keys.length) return [];
	const spec = buildFilter(opts);
	// The read-back is a second request, under the same bound as the first.
	const found = await withDeadline(
		(abortSignal) =>
			searchClient().search("*", {
				filter: [servedFilter(access), spec, oneOf(FIELD.key, keys)]
					.filter(Boolean)
					.join(" and "),
				select: [...HIT_FIELDS],
				top: keys.length,
				abortSignal,
			}),
		deadline,
		() =>
			new Error(
				`the knowledge base's chunks were not read back within ${deadline}ms`,
			),
	);
	const byKey = new Map<string, HitDocument>();
	for await (const hit of found.results)
		byKey.set(hit.document.chunkId, hit.document as HitDocument);
	const unserved = keys.filter((key) => !byKey.has(key));
	if (unserved.length)
		console.info(
			`[knowledge] knowledge.cited_unserved: ${unserved.length} of ${keys.length} chunk(s) the knowledge base chose are not served (no verdict, flagged, not the caller's to read, or outside the search's filter); left out: ${unserved.join(", ")}`,
		);
	const topK = Math.max(1, opts.topK ?? 6);
	const maxPerDocument = Math.max(1, opts.maxPerDocument ?? topK);
	const hits: SearchHit[] = [];
	const perDocument = new Map<string, number>();
	for (const ref of chosen) {
		const doc = byKey.get(ref.key);
		if (!doc) continue;
		byKey.delete(ref.key);
		const used = perDocument.get(doc.documentId) ?? 0;
		if (used >= maxPerDocument) continue;
		perDocument.set(doc.documentId, used + 1);
		hits.push(toHit(doc, ref.rerankerScore ?? 0, ref.rerankerScore));
		if (hits.length >= topK) break;
	}
	return hits;
}
