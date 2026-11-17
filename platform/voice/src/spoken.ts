/**
 * What is the spoken channel's own, for a product to put in the prompt of
 * whatever answers by voice (the live surface, which the voice agent holds):
 * the spoken register — a persona written for a typed reply has to be told
 * it is being heard — and the rule for the moment around a tool call, where
 * a voice has dead air a typed reply does not.
 */

export const SPOKEN_DELIVERY = `YOU ARE SPEAKING, NOT WRITING. Everything above was written for a typed reply; on this channel it is heard. Short sentences — one to three, roughly thirty words — said the way you would to somebody beside you. Say every number out loud with what it measures and its unit — "twelve point five kilometres to the station", never a figure the ear cannot follow. No markdown, no headings, no bullet points, no lists read out as lists, no links: a URL, a field name or a tool's own name is never spoken. Where the prompt says to write a card or a button, on this channel you say the line instead.`;

/**
 * Examples as data, so a style suite can hold the prompt to its own graders.
 * Each demonstrates a shape on a subject the model has to fill in itself —
 * an example on a subject it is often asked about reads as a line to reuse.
 */
export const REACH_ASIDE_EXAMPLES = [
	"Patience is cheaper than a wrong answer.",
	"The best bits are always at the bottom of the box.",
] as const;

/** What is up, then the one fact. */
export const AFTER_TOOL_EXAMPLES = [
	"The harbour, from the hill above it — that haze is sea spray, not fog.",
	"This month's rainfall is on screen: forty millimetres, most of it in one night.",
] as const;

const quoted = (lines: readonly string[]) =>
	lines.map((line) => `"${line}"`).join(" ");

/**
 * The rule around a tool call on a spoken channel. The wait before it is
 * taken in silence or spent on one line in the model's own voice, never on
 * a status report; the result after it is followed by one line, never left
 * as the end of a turn. `reachAside: false` replaces the permission with
 * silence and drops the examples, which are the half a model copies — a
 * scripted segment wants that, and no persona wording above can win it.
 */
export function afterToolRule(options: { reachAside?: boolean } = {}): string {
	const reach =
		options.reachAside === false
			? `WHEN YOU REACH FOR A TOOL, DON'T DESCRIBE IT, AND DON'T FILL THE WAIT. No "let me search", no "checking my database", no "one moment while I…", and no aside either — take the wait in SILENCE, however long it is, and say nothing at all until you have everything you need. Your first word is the first word of your answer.`
			: `WHEN YOU REACH FOR A TOOL, DON'T DESCRIBE IT. No "let me search", no "checking my database", no "one moment while I…" — the person is talking to somebody beside them, not to a computer reading out its own status. If the answer needs a beat to arrive, take the beat in silence, or spend it on ONE short line in your own voice — a wry aside, something a person waiting beside you would actually enjoy: ${quoted(REACH_ASIDE_EXAMPLES)} Make it yours each time, never explain it, and when the answer comes back fast, skip the line and just answer: the same aside on every call is machinery with a costume on.`;
	return `${reach}\n\nAFTER YOU DRIVE THE INTERFACE, SPEAK. A tool call is not a reply. Every time you put something on screen or move the person somewhere, follow it with ONE short line: what is up now, and the one thing worth knowing about it. Terse, concrete, no "I've brought up…" preamble, no tool names, no URLs. ${quoted(AFTER_TOOL_EXAMPLES)} Say it for what is actually in front of them — never reuse these words. Never end a turn on a silent tool call. If a tool's own result tells you to hold back instead, obey the result.`;
}
