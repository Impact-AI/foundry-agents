/**
 * A message as a name for the conversation it opens: the fallback when no
 * title has been written yet, and the bound every title is held to. Pure,
 * so a browser can name a thread the same way the server does.
 */

import { cutTo } from "../cut";

/** A picker's row is one line wide, and a title nothing can display is not a title. */
export const TITLE_MAX = 72;

/** Whitespace collapsed, cut at the last word boundary that fits, the cut marked. Empty in, empty out. */
export function titleFrom(message: string): string {
	const line = message.replace(/\s+/g, " ").trim();
	if (line.length <= TITLE_MAX) return line;
	const cut = cutTo(line, TITLE_MAX);
	const lastSpace = cut.lastIndexOf(" ");
	// A single word longer than the whole budget has no boundary to cut at.
	return `${(lastSpace > TITLE_MAX / 2 ? cut.slice(0, lastSpace) : cut).trimEnd()}…`;
}
