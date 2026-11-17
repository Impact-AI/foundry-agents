import type { SearchHit } from "../types";
import { accessClauseFor, type RetrievalRefusal } from "./access";
import { fallbackPlan, planHasFilters, type QueryPlan } from "./draft";
import { type PlanOptions, planQuery } from "./planner";
import { type SearchOptions, searchChunks } from "./search";
import type { QuerySpec } from "./spec";
import { unmatchedQueryTerms } from "./unmatched-terms";

/**
 * Retrieval end to end: plan the question, run it, relax the plan if it was
 * wrong, and say what was given up.
 *
 * A planned search has a failure an unplanned one does not: a filter can be
 * right about the question and wrong about the corpus. "Pictures of the
 * depot" finds nothing if the library's depot pictures are all inside
 * documents, and the honest answer is the documents, said to be documents.
 * The ladder drops the tags first (inferences from the question, which the
 * corpus is the authority on), then the kinds (somebody who asked for
 * pictures asked for pictures, but an empty answer is worse than a
 * differently shaped one).
 *
 * `relaxed` is what lets a caller say "here are the pictures" only when it
 * is true. `unmatchedTerms` is the same idea one level down, for the words
 * the query carried that no filter ever expressed.
 *
 * The readers clause is not a rung. It rides on every search as `access`,
 * outside the spec the ladder rewrites, and a caller nobody can identify is
 * refused before the first search rather than widened by the last.
 */

export type RelaxedConstraint = "tags" | "kinds";

export interface RetrievalResult {
	hits: SearchHit[];
	/** The plan the search was built from, whether or not it survived the ladder. */
	plan: QueryPlan;
	/** Constraints dropped to get any results, in the order dropped. Empty means everything planned applied. */
	relaxed: RelaxedConstraint[];
	/** Distinctive words of the question that appear in none of the hits. */
	unmatchedTerms: string[];
	/** Why no search was run, when none was: the caller reports it, since an empty answer must not pass for a miss. */
	refused: RetrievalRefusal | null;
}

export interface RetrieveOptions
	extends Pick<
			SearchOptions,
			"topK" | "maxPerDocument" | "minScore" | "access" | "deadlineMs"
		>,
		Pick<PlanOptions, "brief" | "vocabulary"> {
	/** Use this plan instead of making one: the caller has already planned, or is relaying constraints a person set by hand. */
	plan?: QueryPlan;
	/** The search, injectable so the ladder is testable without an endpoint. */
	search?: (opts: SearchOptions) => Promise<SearchHit[]>;
}

interface Rung {
	spec: QuerySpec;
	dropped: RelaxedConstraint[];
}

function rungs(spec: QuerySpec): Rung[] {
	const out: Rung[] = [{ spec, dropped: [] }];
	if (spec.tags?.length && spec.kinds?.length)
		out.push({ spec: { kinds: spec.kinds }, dropped: ["tags"] });
	const last = out[out.length - 1] as Rung;
	if (Object.keys(last.spec).length)
		out.push({
			spec: {},
			dropped: [
				...(spec.tags?.length ? (["tags"] as const) : []),
				...(spec.kinds?.length ? (["kinds"] as const) : []),
			],
		});
	return out;
}

export async function retrieve(
	question: string,
	opts: RetrieveOptions = {},
): Promise<RetrievalResult> {
	const access = await accessClauseFor(opts.access);
	// Before the plan: a caller who may read nothing is not worth a model call.
	if (access.kind === "refused")
		return {
			hits: [],
			plan: opts.plan ?? fallbackPlan(question, "refused"),
			relaxed: [],
			unmatchedTerms: [],
			refused: access.code,
		};
	const plan =
		opts.plan ??
		(await planQuery(question, {
			brief: opts.brief,
			vocabulary: opts.vocabulary,
			access: opts.access,
		}));

	const search = opts.search ?? searchChunks;
	const query = plan.semanticQuery || question;
	const result = (hits: SearchHit[], relaxed: RelaxedConstraint[]) => ({
		hits,
		plan,
		relaxed,
		unmatchedTerms: unmatchedQueryTerms(query, hits),
		refused: null,
	});
	const base = {
		query,
		searchText: plan.searchText,
		topK: opts.topK,
		maxPerDocument: opts.maxPerDocument,
		minScore: opts.minScore,
		access: opts.access,
		deadlineMs: opts.deadlineMs,
	};

	if (!planHasFilters(plan)) return result(await search(base), []);

	const ladder = rungs(plan.spec);
	let last: SearchHit[] = [];
	for (const rung of ladder) {
		last = await search({ ...base, ...rung.spec });
		if (last.length) return result(last, rung.dropped);
	}
	// Every rung empty, the unfiltered one included: the library has nothing.
	// The full ladder is reported, because an empty `relaxed` would read as
	// "the plan applied and matched nothing".
	return result(last, ladder[ladder.length - 1]?.dropped ?? []);
}
