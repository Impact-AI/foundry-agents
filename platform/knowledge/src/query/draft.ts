import { z } from "zod";
import { type DocumentKind, documentKind } from "../types";
import { lexicalText } from "./lexical";
import type { QuerySpec } from "./spec";
import { keepKnownTags, type TagCount } from "./vocabulary";

/**
 * A model's draft of a query, and the validation that turns it into a plan.
 * Pure: no network, which is what makes the planner's judgement testable
 * without a model.
 */

/** Why a plan came back unplanned. Reported, never thrown. */
export type PlanSource =
	| "model"
	/** The `knowledge` document's `planner.enabled` is off. */
	| "disabled"
	/** The question held nothing a filter could act on, so no model was called: the planner working, not failing. */
	| "unfiltered"
	/** Over the in-flight cap. */
	| "capacity"
	/** Timed out, errored, or answered with something unusable. */
	| "unavailable"
	/** Not planned because nothing would be searched: the caller may read nothing. */
	| "refused";

export interface QueryPlan {
	/** The lexical arm's input: distinctive terms and quoted phrases. */
	searchText: string;
	/** The reranker's input: always the question, because it judges whether a passage answers it. */
	semanticQuery: string;
	/** The filters, already validated. Empty on any fallback. */
	spec: QuerySpec;
	source: PlanSource;
	/** Tags the model proposed that the corpus does not carry. */
	unknownTags?: string[];
}

/** The unplanned plan: the question, no filters. What retrieval did before the planner. */
export function fallbackPlan(question: string, source: PlanSource): QueryPlan {
	return {
		searchText: lexicalText(question),
		semanticQuery: question.trim(),
		spec: {},
		source,
	};
}

export function planHasFilters(plan: QueryPlan): boolean {
	return Object.keys(plan.spec).length > 0;
}

/**
 * Loose on purpose: every field is a string or an array of them, and
 * legality is decided below against the real enum, so one bad member costs
 * one filter rather than failing the whole object.
 */
export const draftSchema = z.object({
	searchText: z
		.string()
		.describe(
			"The keyword query. Distinctive names and terms from the question, " +
				"verbatim; multi-word proper names in double quotes. Drop question " +
				"scaffolding ('can you show me', 'what are', 'tell me about'). Never " +
				"add words the question did not contain.",
		),
	tags: z
		.array(z.string())
		.describe(
			"Tags from the provided vocabulary ONLY, or an empty array. A tag not " +
				"in the list matches nothing and will be discarded.",
		),
	tagMode: z
		.string()
		.describe(
			"'any' (default) or 'all'. Use 'all' only when the question genuinely " +
				"demands every tag at once.",
		),
	kinds: z
		.array(z.string())
		.describe(
			`Restrict to kinds of file, one of: ${documentKind.options.join(", ")}. ` +
				"This is the one to use for 'show me pictures' — ['picture']. Empty " +
				"unless the question asks for a kind.",
		),
});

export type QueryDraft = Partial<z.infer<typeof draftSchema>>;

/**
 * The crafted text made safe for the simple query syntax, or the fallback
 * held to the same rules when nothing of the draft survives them.
 */
export function sanitizeSearchText(raw: string, fallback: string): string {
	return lexicalText(raw) || lexicalText(fallback);
}

/**
 * A kind filter has to narrow to be worth having, and the cost of a wrong
 * one always lands on the pictures. A lone `["document"]` is the model
 * filling in a box: documents are most of a library, so the search succeeds
 * and the relaxation ladder never sees it, while every picture goes unseen.
 * Both kinds is the same mistake from the other side: a filter that
 * excludes nothing.
 */
function narrowingKinds(values: readonly string[] | undefined) {
	const kinds: DocumentKind[] = [];
	for (const raw of values ?? []) {
		const parsed = documentKind.safeParse(String(raw).trim().toLowerCase());
		if (parsed.success && !kinds.includes(parsed.data)) kinds.push(parsed.data);
	}
	return kinds.length === 1 && kinds[0] === "picture" ? kinds : undefined;
}

/** Drop what is illegal, keep what survives. */
export function validateDraft(
	draft: QueryDraft,
	question: string,
	vocabulary: readonly TagCount[],
): QueryPlan {
	const plan: QueryPlan = {
		searchText: sanitizeSearchText(draft.searchText ?? "", question),
		semanticQuery: question.trim(),
		spec: {},
		source: "model",
	};

	if (draft.tags?.length) {
		const { kept, dropped } = keepKnownTags(draft.tags, vocabulary);
		if (kept.length) plan.spec.tags = kept;
		if (dropped.length) plan.unknownTags = dropped;
		// "all" over one tag is "any", and recording it would claim a constraint that is not one.
		if (kept.length > 1 && draft.tagMode?.trim().toLowerCase() === "all")
			plan.spec.tagMode = "all";
	}

	const kinds = narrowingKinds(draft.kinds);
	if (kinds) plan.spec.kinds = kinds;
	return plan;
}
