import {
	type ConfigKey,
	defineConfigKey,
	processSingleton,
	resetSingleton,
	withDeadline,
} from "@platform/config";
import { knowledgeSettings } from "../config/knowledge";
import { isSearchConfigured, searchClient } from "../index/client";
import { accessClauseFor, type CallerAccess, servedFilter } from "./access";
import { searchDeadlineMs } from "./search";

/**
 * The tag vocabulary, read from the index rather than guessed at.
 *
 * A model asked to filter is confident and wrong about tags: it emits
 * plausible English that matches nothing, and a filter on a tag nobody uses
 * does not narrow a search, it empties it. So the planner is told what
 * exists, and anything it invents anyway is dropped before it reaches a
 * filter ({@link keepKnownTags}).
 *
 * A facet rather than the catalogue's distinct tags, because the facet counts
 * tags on chunks a model may actually be handed, under the filter every
 * search carries — the caller's readers clause among them. A tag's name and
 * count say what a document is about, and they reach the planner's prompt, so
 * a caller is told only the tags of documents they may read. One `top: 0`
 * facet query per readers clause, memoised per process; a failed read keeps
 * the last vocabulary, and no vocabulary at all is `[]`, which the planner
 * reads as "you may not filter by tag". A lookup never costs a search.
 */

export interface TagCount {
	tag: string;
	count: number;
}

/**
 * Tags change when a library is loaded again: minutes-scale events. A stale
 * vocabulary only means a new tag is not yet offered to the planner; the
 * lexical arm still matches the word.
 */
const VOCABULARY_TTL_MS = 600_000;

/**
 * Readers clauses held at once. Under enforcement a clause names its caller,
 * so this is a count of recent people; past it the least recently asked is
 * forgotten and pays one facet query when it next asks.
 */
const MAX_CLAUSES = 256;

/**
 * One facet query, under the bound every search has and aborted at it; its
 * cap truncates by count, so overflowing loses the rarest tags first.
 */
async function fetchTags(filter: string): Promise<TagCount[]> {
	const { tagVocabularyMax } = (await knowledgeSettings()).retrieval;
	const deadline = await searchDeadlineMs();
	const response = await withDeadline(
		(abortSignal) =>
			searchClient().search("*", {
				top: 0,
				filter,
				facets: [`tags,count:${tagVocabularyMax}`],
				abortSignal,
			}),
		deadline,
		() => new Error(`the tag vocabulary did not answer within ${deadline}ms`),
	);
	const facet = response.facets?.tags ?? [];
	const out: TagCount[] = [];
	for (const entry of facet) {
		const tag = typeof entry.value === "string" ? entry.value.trim() : "";
		if (tag) out.push({ tag, count: entry.count ?? 0 });
	}
	return out;
}

const SINGLETON = "knowledge:tag-vocabulary";

/** The memo for one served filter, most recently asked last. */
function vocabularyKey(filter: string): ConfigKey<TagCount[]> {
	const keys = processSingleton(
		SINGLETON,
		() => new Map<string, ConfigKey<TagCount[]>>(),
	);
	const name = filter;
	let key = keys.get(name);
	if (key) keys.delete(name);
	else
		key = defineConfigKey<TagCount[]>({
			key: "knowledge:tag-vocabulary",
			defaultValue: [],
			parse: (stored) => (Array.isArray(stored) ? (stored as TagCount[]) : []),
			ttlMs: VOCABULARY_TTL_MS,
			read: () => fetchTags(filter),
		});
	keys.set(name, key);
	for (const oldest of keys.keys()) {
		if (keys.size <= MAX_CLAUSES) break;
		keys.delete(oldest);
	}
	return key;
}

/**
 * Every tag a served chunk the caller may read carries, commonest
 * first. With enforcement off every caller reads the one vocabulary; with it
 * on, a caller nobody can identify gets none. Never throws.
 */
export async function getTagVocabulary(
	access?: CallerAccess | null,
): Promise<readonly TagCount[]> {
	if (!isSearchConfigured()) return [];
	const clause = await accessClauseFor(access);
	if (clause.kind === "refused") return [];
	return vocabularyKey(servedFilter(clause)).read();
}

/** Forget every memo, so the next read sees the index afresh. */
export function invalidateTagVocabulary(): void {
	resetSingleton(SINGLETON);
}

/**
 * The tags of `wanted` the corpus carries, case-folded to the index's
 * spelling, and the rejects beside them: a question whose every tag was
 * invented is a question the planner misread, and that belongs in a log.
 */
export function keepKnownTags(
	wanted: readonly string[],
	vocabulary: readonly TagCount[],
): { kept: string[]; dropped: string[] } {
	const known = new Map(vocabulary.map((t) => [t.tag.toLowerCase(), t.tag]));
	const kept: string[] = [];
	const dropped: string[] = [];
	const seen = new Set<string>();
	for (const raw of wanted) {
		const folded = raw.trim().toLowerCase();
		if (!folded) continue;
		const real = known.get(folded);
		if (!real) {
			dropped.push(raw);
			continue;
		}
		if (seen.has(real)) continue;
		seen.add(real);
		kept.push(real);
	}
	return { kept, dropped };
}
