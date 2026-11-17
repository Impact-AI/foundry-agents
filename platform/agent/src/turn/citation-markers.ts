/**
 * A citation the model writes into its answer's text is a marker nothing
 * draws, so it is taken out of the stream, across however many deltas it is
 * split over, and out of the history when a conversation is read back. Two
 * shapes: the service's web search writes `【6:0†source】` where it cites a
 * page, the page itself arriving as an annotation; and the model writes its
 * own, `cite<id>` over private-use characters, when asked
 * for a source a tool result named — invisible in a renderer, which leaves
 * the bare `cite<id>` on the screen.
 */
const MARKER = /【\d+:\d+†[^】]*】|[^]*/g;
/** What opens a marker, so a split one is held until it closes. */
const OPENERS = /[【]/g;
const CLOSER: Record<string, string> = { "【": "】", "": "" };
/** Longer than any marker: a held opener that grows past this was not one. */
const HOLD_MAX = 64;

/** A stored answer's text, read back without them. */
export function withoutCitationMarkers(text: string): string {
	return text.replace(MARKER, "");
}

function lastOpener(text: string): number {
	let at = -1;
	for (const match of text.matchAll(OPENERS)) at = match.index;
	return at;
}

export function citationMarkerFilter(): {
	push(delta: string): string;
	flush(): string;
} {
	let held = "";
	return {
		push(delta) {
			const text = withoutCitationMarkers(held + delta);
			const open = lastOpener(text);
			if (
				open === -1 ||
				text.includes(CLOSER[text[open] ?? ""] ?? "】", open) ||
				text.length - open > HOLD_MAX
			) {
				held = "";
				return text;
			}
			held = text.slice(open);
			return text.slice(0, open);
		},
		flush() {
			const rest = held;
			held = "";
			return rest;
		},
	};
}
