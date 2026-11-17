import { withDeadline } from "@platform/config";
import { knowledgeSettings } from "../config/knowledge";
import { searchClient } from "../index/client";
import {
	FIELD,
	SEARCH_FIELDS,
	semanticConfigurationName,
} from "../index/definition";
import { HIT_FIELDS, type HitDocument, toHit } from "../index/documents";
import type { SearchHit } from "../types";
import { accessClauseFor, type CallerAccess, servedFilter } from "./access";
import { lexicalText } from "./lexical";
import { buildFilter, type QuerySpec } from "./spec";

/**
 * The hybrid query: a vector arm and a BM25 arm fused and reranked by the
 * service in one request, then floored and diversified here.
 *
 * A nearest-neighbour lookup is not retrieval. The lexical arm is what finds
 * an exact name an embedding would blur into its category; the floor is what
 * keeps an off-topic question from yielding k irrelevant passages handed to
 * the model as knowledge; and the per-document cap is what stops one long
 * document holding every slot. The vector arm is the question as text: the
 * index's vectorizer embeds it with the service's own identity, into the
 * space the skillset embedded the chunks in. A chunk carries its lead-in in
 * the split skill's overlap, so nothing is stitched on afterwards.
 */

export interface SearchOptions extends QuerySpec {
	/** The question: the reranker's input, the vector arm's, and the lexical arm's unless `searchText` differs. */
	query: string;
	/**
	 * The lexical arm's input when it should differ from the question. BM25
	 * wants distinctive terms and quoted phrases; the reranker is a
	 * cross-encoder that wants the question as asked.
	 */
	searchText?: string;
	topK?: number;
	/** Reranker-score floor, 0–4. */
	minScore?: number;
	maxPerDocument?: number;
	/**
	 * Who is asking, from their verified claims. Read only while access
	 * control is enforced, when it becomes the readers clause; null then
	 * means nobody is asking, and nothing is returned.
	 */
	access?: CallerAccess | null;
	/** The bound on this one request; absent: the `knowledge` document's `retrieval.deadlineMs`. A live session's search passes its `retrieval.voiceDeadlineMs`. */
	deadlineMs?: number;
}

/** The service reranks at most this many documents per query. */
const MAX_CANDIDATES = 50;

/**
 * A bound on one request, so a slow service is a failed turn rather than a
 * hung one: the `knowledge` document's `retrieval.deadlineMs`, through its
 * memo, and its compiled-in default when the store cannot be read or holds
 * no whole number from a second to a minute.
 */
export async function searchDeadlineMs(): Promise<number> {
	return (await knowledgeSettings()).retrieval.deadlineMs;
}

export async function searchChunks(opts: SearchOptions): Promise<SearchHit[]> {
	const { retrieval } = await knowledgeSettings();
	const topK = Math.max(1, opts.topK ?? 6);
	const candidates = Math.min(
		topK * retrieval.candidateMultiplier,
		MAX_CANDIDATES,
	);
	const minScore = opts.minScore ?? retrieval.rerankerFloor;
	const maxPerDocument = Math.max(
		1,
		opts.maxPerDocument ?? retrieval.maxPerDocument,
	);
	// The reranker is billed per query; off, the search is still vector + BM25
	// fused by the service, with no absolute score to floor on.
	const semantic = retrieval.semanticRanker;
	const access = await accessClauseFor(opts.access);
	if (access.kind === "refused") return [];

	const question = opts.query.trim();
	// Whatever the caller passed, the lexical arm carries no operator; a
	// question that was nothing else matches on the vector arm alone.
	const lexical = lexicalText(opts.searchText?.trim() || question) || "*";
	const spec = buildFilter(opts);
	const common = {
		filter: spec ? `${servedFilter(access)} and ${spec}` : servedFilter(access),
		select: [...HIT_FIELDS],
		searchFields: [...SEARCH_FIELDS],
		top: candidates,
		vectorSearchOptions: {
			queries: [
				{
					kind: "text" as const,
					text: question,
					fields: [FIELD.vector],
					kNearestNeighborsCount: candidates,
					weight: retrieval.vectorWeight,
				},
			],
		},
	};

	const deadline = opts.deadlineMs ?? retrieval.deadlineMs;
	// Built as two shapes rather than one spread: `queryType: "semantic"`
	// implies `semanticSearchOptions`, and a spread collapses the SDK's union.
	const response = await withDeadline(
		(abortSignal) =>
			semantic
				? searchClient().search(lexical, {
						...common,
						abortSignal,
						queryType: "semantic",
						semanticSearchOptions: {
							configurationName: semanticConfigurationName(),
							// Partial results beat a failed turn when enrichment times out or
							// the quota is spent.
							errorMode: "partial",
							...(lexical === question ? {} : { semanticQuery: question }),
						},
					})
				: searchClient().search(lexical, { ...common, abortSignal }),
		deadline,
		() => new Error(`search did not answer within ${deadline}ms`),
	);

	const hits: SearchHit[] = [];
	const perDocument = new Map<string, number>();
	for await (const hit of response.results) {
		const rerankerScore = hit.rerankerScore ?? null;
		// No reranker score means the pass did not run; a row is not cut on a score it never had.
		if (rerankerScore !== null && rerankerScore < minScore) continue;
		const doc = hit.document as HitDocument;
		const used = perDocument.get(doc.documentId) ?? 0;
		if (used >= maxPerDocument) continue;
		perDocument.set(doc.documentId, used + 1);
		hits.push(toHit(doc, hit.score, rerankerScore));
		if (hits.length >= topK) break;
	}
	return hits;
}
