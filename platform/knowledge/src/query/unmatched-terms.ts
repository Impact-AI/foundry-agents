/**
 * Which of the asked-for words the results do not contain.
 *
 * Retrieval always answers: a hybrid search returns its k best rows however
 * near they are, and a near miss reaches the model in the same shape as a
 * hit. `relaxed` reports the constraints retrieval knowingly dropped; this
 * reports the one it never had a filter for, a word in the query the engine
 * silently declined to honour.
 *
 * Biased hard toward silence, because a false positive makes the agent
 * disown what it holds and a false negative merely leaves today's behaviour:
 * the whole hit is the haystack, matching is substring with a crude singular,
 * function words in five languages are ignored, and an empty result set
 * reports nothing, since "the archive has nothing" is already the clearer
 * statement.
 */

const MAX_REPORTED = 4;
/** Shorter than this is noise: "of", "km", a single initial. */
const MIN_TERM_LENGTH = 3;

/**
 * Function words, the words for asking to be shown something, and the names
 * of the media themselves, in English, Italian, Spanish, French and German.
 * Prose rather than an array literal because the formatter would put one
 * string per line, and a list of three hundred lines is one nobody reads to
 * check a word is missing. Generous on purpose: an extra entry costs one term
 * never reported; a missing one costs a false accusation about the corpus.
 */
const IGNORED = new Set(
	`
	show see look find search give tell get want need please know about some any
	more other thing things stuff example examples

	image images imagery picture pictures photo photos photograph photographs
	video videos footage frame frames shot shots post posts clip clips media
	document documents file files
	immagine immagini fotografia fotografie filmato filmati
	imagen imagenes imágenes fotografía fotografias fotografías vídeo vídeos
	photographie photographies vidéo vidéos cliché clichés
	bild bilder aufnahme aufnahmen foto fotos

	the and for you your yours our ours his her hers its their theirs they them
	this that these those there here what which who whom whose when where why
	how with without from into onto over under between than then also just like
	have has had was were are been being can could would should will shall may
	might must did does done not but all both each few many much own same too
	very out off one two

	che chi come cosa dei del della delle dello degli dal dalla con senza per
	una uno gli sono essere erano hanno avere mostra mostrami fammi vedere
	quale quali quando dove perche perché tuo tua tuoi sue suo sua loro questo
	questa questi queste qualche alcune alcuni anche molto piu più

	que quien como los las unos unas por para sin son ser eran tiene tienen
	tener muestra muestrame muéstrame ensename enséñame ver cual cuales cuál
	cuáles cuándo donde dónde porque qué sus esta este estos estas algunas
	algunos también tambien mas más

	les des une aux qui quoi comment pour avec sont etre être etaient étaient
	ont avoir montre montrez moi voir quel quelle quels quelles quand ou où
	pourquoi votre vos leur leurs cette ces cet quelques aussi plus tres très

	der die das den dem ein eine einen einem einer eines und oder aber wie wer
	wen wem wessen wann wo warum fur für mit ohne von vom zum zur sind ist sein
	waren haben hat hatte zeig zeige zeigen mir sehen ihre ihr ihren dies diese
	dieser dieses einige auch mehr sehr
`
		.split(/\s+/)
		.filter(Boolean),
);

/** The slice of a hit this reads. Structural, so any caller's hit fits. */
export interface SearchableHit {
	title?: string | null;
	summary?: string | null;
	text?: string | null;
	tags?: readonly string[] | null;
}

/** `\p{L}` rather than `\w`, or an accented name tokenises into fragments. */
function tokenize(text: string): string[] {
	return text
		.toLowerCase()
		.split(/[^\p{L}\p{N}]+/u)
		.filter(Boolean);
}

function haystack(hits: readonly SearchableHit[]): string {
	const parts: string[] = [];
	for (const h of hits) {
		parts.push(
			h.title ?? "",
			h.summary ?? "",
			h.text ?? "",
			(h.tags ?? []).join(" "),
		);
	}
	return parts.join("\n").toLowerCase();
}

/**
 * Terms of `query` that appear nowhere in `hits`, in query order, capped.
 * Empty when everything was found, when the query carried no distinctive
 * term, or when there were no hits at all.
 */
export function unmatchedQueryTerms(
	query: string,
	hits: readonly SearchableHit[],
): string[] {
	if (hits.length === 0) return [];
	const text = haystack(hits);
	const unmatched: string[] = [];
	const seen = new Set<string>();
	for (const term of tokenize(query)) {
		if (term.length < MIN_TERM_LENGTH || IGNORED.has(term)) continue;
		if (seen.has(term)) continue;
		seen.add(term);
		// Only the two cheap endings: a tie-breaker toward staying quiet, not a stemmer.
		const singular = term.endsWith("es")
			? term.slice(0, -2)
			: term.endsWith("s")
				? term.slice(0, -1)
				: null;
		if (text.includes(term)) continue;
		if (
			singular &&
			singular.length >= MIN_TERM_LENGTH &&
			text.includes(singular)
		)
			continue;
		unmatched.push(term);
		if (unmatched.length >= MAX_REPORTED) break;
	}
	return unmatched;
}
