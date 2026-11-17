import type { DocumentSource } from "../contract/messages";

/**
 * The chips under an answer show what the reply drew on, not everything
 * the retrieval handed the model: a document is kept when the reply names
 * it — its title, in the text, case-insensitively, as the persona asks the
 * model to name the document it drew on in plain words. Markdown emphasis
 * is read past, so a title written in bold still counts. When the reply
 * names none of them, all are kept: a row that was retrieved from is never
 * empty, and the reader decides. A typed turn's chips and a live session's
 * are decided here alike.
 */

const EMPHASIS = /[*_~`]/g;
const SPACES = /\s+/g;

function plain(text: string): string {
	return text.replace(EMPHASIS, "").replace(SPACES, " ").toLowerCase();
}

export function namedSources(
	text: string,
	candidates: readonly DocumentSource[],
): DocumentSource[] {
	const reply = plain(text);
	const named = candidates.filter((source) => {
		const title = plain(source.title).trim();
		return title.length > 0 && reply.includes(title);
	});
	return named.length ? named : [...candidates];
}

/** Each document once, by id, in the order it first came. */
export function uniqueSources(
	...lists: readonly (readonly DocumentSource[])[]
): DocumentSource[] {
	const seen = new Map<string, DocumentSource>();
	for (const list of lists)
		for (const source of list)
			if (!seen.has(source.id)) seen.set(source.id, source);
	return [...seen.values()];
}
