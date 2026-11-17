import { DEFAULT_KNOWLEDGE_SETTINGS } from "../config/knowledge";
import { type EntityAliasTable, entitiesNamedIn } from "./entities";
import type { TagCount } from "./vocabulary";

/**
 * Is this question worth planning?
 *
 * The planner costs a small-model call in front of retrieval, and most
 * questions cannot use one: a plain topic question holds nothing a filter
 * could act on, and planning it buys an empty spec, or worse, a kind filter
 * nobody asked for. So this reads the question first, for free, and answers
 * one thing: does the sentence contain anything a filter could act on?
 *
 * It routes; it does not plan. Finding "images" does not set a kind and
 * finding an entity does not set a tag. A gate that guessed would be a
 * second, worse planner, and the two would disagree.
 *
 * Its two errors are not symmetric. Missing a signal costs a filter: the
 * question is searched unfiltered, which is a lost improvement. A false
 * signal costs seconds. Every judgement below leans toward the cheap mistake.
 */

export type SignalKind = "tag" | "media";

export interface SignalMatch {
	kind: SignalKind;
	term: string;
}

export interface SignalOptions {
	/** The product's named entities, so an alias in a question reaches its tag. */
	entities?: EntityAliasTable;
	/**
	 * Tags that name what the whole corpus is about, and so carry no intent.
	 * The selectivity rule cannot see this: the corpus's own name may be on a
	 * selective fraction of it and still be the subject of every question.
	 * The product's own and the operator's (`knowledge.planner.subjectTags`),
	 * joined by the planner.
	 */
	subjectTags?: readonly string[];
	/** Off, and every question is planned. The operator's `knowledge.planner.gate`. */
	gate?: boolean;
	/**
	 * How common a tag may be, as a fraction of the commonest tag's count, and
	 * still count as signal. A tag on most of the corpus is not a filter.
	 */
	tagSelectivity?: number;
}

const DEFAULTS = DEFAULT_KNOWLEDGE_SETTINGS.planner;

function subjectTags(tags: readonly string[] = []): Set<string> {
	return new Set(tags.map((t) => t.trim().toLowerCase()).filter(Boolean));
}

/** Words that ask for pictures, in the five languages. A regular English plural is matched from the singular. */
const MEDIA_WORDS = `
	image picture photo photograph diagram chart map screenshot illustration
	immagine immagini foto fotografia fotografie grafico mappa illustrazione
	imagen imágenes fotografía fotografías gráfico mapa ilustración
	photographie photographies graphique carte illustration
	bild bilder aufnahme aufnahmen diagramm karte abbildung
`
	.split(/\s+/)
	.filter(Boolean);

/** Padded, punctuation-free lowercase, so a term matches on whole words with a substring test. */
function normalize(text: string): string {
	return ` ${text
		.toLowerCase()
		.replace(/[^\p{L}\p{N}]+/gu, " ")
		.trim()} `;
}

function contains(haystack: string, term: string): boolean {
	const t = term
		.toLowerCase()
		.replace(/[^\p{L}\p{N}]+/gu, " ")
		.trim();
	if (!t) return false;
	return haystack.includes(` ${t} `) || haystack.includes(` ${t}s `);
}

/**
 * The tags selective enough to be signal. A vocabulary with no counts has
 * nothing to judge against, so every tag counts: "we don't know" errs toward
 * the cheap mistake. So does a vocabulary the cutoff would empty.
 */
export function selectiveTags(
	vocabulary: readonly TagCount[],
	subject: readonly string[] = [],
	selectivity: number = DEFAULTS.tagSelectivity,
): readonly TagCount[] {
	const excluded = subjectTags(subject);
	const named = vocabulary.filter((t) => !excluded.has(t.tag.toLowerCase()));
	let max = 0;
	for (const t of named) if (t.count > max) max = t.count;
	if (max <= 0) return named;
	const cutoff = max * selectivity;
	const selective = named.filter((t) => t.count <= cutoff);
	// Tags used about as often as one another: none stands out as the
	// corpus's commonplace, so the cutoff has nothing to exclude and would
	// exclude everything.
	return selective.length ? selective : named;
}

/**
 * Everything in the question a filter could act on. Empty means the planner
 * has nothing to find and is not paid for. Every match is reported, because
 * "why did this question cost seconds" is a question somebody asks of a log.
 */
export function filterableSignal(
	question: string,
	vocabulary: readonly TagCount[],
	options: SignalOptions = {},
): SignalMatch[] {
	if (options.gate === false) return [{ kind: "tag", term: "*gate-disabled*" }];

	const text = normalize(question);
	if (text.trim().length === 0) return [];
	const matches: SignalMatch[] = [];
	const seen = new Set<string>();
	const add = (kind: SignalKind, term: string) => {
		const key = `${kind}:${term}`;
		if (seen.has(key)) return;
		seen.add(key);
		matches.push({ kind, term });
	};

	const selective = new Set(
		selectiveTags(
			vocabulary,
			options.subjectTags,
			options.tagSelectivity ?? DEFAULTS.tagSelectivity,
		).map((t) => t.tag),
	);
	// A hyphenated tag is written as words in a sentence.
	for (const tag of selective) if (contains(text, tag)) add("tag", tag);
	// Matched against the raw question, so the aliases' own word boundaries
	// apply; gated on the vocabulary like any other tag.
	// An entity's tag is lowercase and the index's spelling is the library's.
	const spelled = new Map(
		[...selective].map((tag) => [tag.toLowerCase(), tag]),
	);
	for (const entity of entitiesNamedIn(options.entities ?? [], question)) {
		const tag = spelled.get(entity.tag.toLowerCase());
		if (tag) add("tag", tag);
	}
	for (const word of MEDIA_WORDS) if (contains(text, word)) add("media", word);
	return matches;
}
