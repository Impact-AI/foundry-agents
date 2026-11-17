/** Longest lexical text sent, in characters. */
const MAX_SEARCH_TEXT = 400;

/**
 * Any text as the lexical arm may carry it, or empty when nothing but
 * operators and space was in it. An injection boundary: the string comes
 * from a person, sometimes through a model, into a query language where
 * `+ | - " * ( ) ?` are operators, and `-word` excludes and `*` expands
 * whoever wrote them. Every string that reaches the simple query syntax
 * passes here, a question searched as typed included. The phrase quote is
 * kept, because it is the point; quotes survive only if they balance. A
 * hyphen is stripped only where it negates, leading a token.
 */
export function lexicalText(raw: string): string {
	let text = raw.replace(/[\r\n\t]+/g, " ").trim();
	if ((text.match(/"/g) ?? []).length % 2 !== 0) text = text.replace(/"/g, "");
	text = text
		.replace(/[+|*?()]/g, " ")
		.replace(/(^|\s)-+/g, "$1")
		.replace(/\\/g, " ")
		.replace(/\s+/g, " ")
		.trim();
	if (text.length > MAX_SEARCH_TEXT) {
		const cut = text.lastIndexOf(" ", MAX_SEARCH_TEXT);
		text = text.slice(0, cut > 0 ? cut : MAX_SEARCH_TEXT).trim();
		if ((text.match(/"/g) ?? []).length % 2 !== 0)
			text = text.replace(/"/g, "");
	}
	return text.replace(/["\s]/g, "") ? text : "";
}
