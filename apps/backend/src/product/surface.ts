import { type ProductTurn, WEB_SEARCH } from "@platform/agent";
import type { ReplyChannel } from "@platform/prompt";
import {
	CLEAR_STAGE,
	OPEN_DOCUMENT,
	PRESENT_CONTENT,
	SHOW_CHART,
	SHOW_LIBRARY,
	SHOW_RECORD,
	SHOW_RECORDS,
	STAGE_TOOLS,
	SUGGEST_NEXT,
} from "./stage-tools";
import { KNOWLEDGE_SEARCH } from "./tools/knowledge-search";
import { LIST_RECORDS } from "./tools/list-records";
import { LOOKUP_RECORD } from "./tools/lookup-record";
import { METRICS } from "./tools/metrics";

/**
 * Part two's second half: how the agent drives the workspace. One block,
 * said as true of this turn — the interface's controls are a fixed list
 * the browser registers, the server's tools are whatever the operator left
 * on — because a line about a tool the turn does not carry sends the model
 * calling a control nobody registered and reporting a move that never
 * happened. The spoken variant changes the register and nothing else; the
 * rule for the moment after a tool on a voice call is the voice package's,
 * composed beside this block when the session opens.
 */

/**
 * The server-side tools the block may mention, each said only when the turn
 * registers it, by the name the model calls it by. Web search has none: the
 * service runs it inside a typed turn's response when the model grounds an
 * answer, so it is named for what it is; a live session's is the backend's
 * function, which answers with the pages' words and names and keeps them in
 * the session, so the spoken line says how to use that instead.
 */
const SERVER_TOOLS: readonly {
	key: string;
	line: string;
	name?: string;
	spokenLine?: string;
}[] = [
	{
		key: KNOWLEDGE_SEARCH,
		line: "the knowledge base: passages with citation ids, document ids and media URLs",
	},
	{
		key: WEB_SEARCH,
		name: "web search",
		line: "the web, for what the knowledge base does not hold. Its results last only for the step that searched, so write your answer in that step, citing the pages, and only then call a control",
		spokenLine:
			"the web, for what the knowledge base does not hold. It answers with what the pages said and which pages they were: say where the answer comes from by the site's name",
	},
	{
		key: LOOKUP_RECORD,
		line: "one person, project, customer or asset by id or name",
	},
	{ key: LIST_RECORDS, line: "the records of a kind, filtered by a query" },
	{
		key: METRICS,
		line: `a record's figures per quarter or year, shaped for \`${SHOW_CHART}\``,
	},
];

const tick = (name: string) => `\`${name}\``;

function searchRule(enabled: readonly string[], verb: string): string {
	const knowledge = enabled.includes(KNOWLEDGE_SEARCH);
	const web = enabled.includes(WEB_SEARCH);
	if (!knowledge && !web)
		return `You have no search on this turn, so you cannot look anything up: ${verb} plainly that you cannot check right now rather than answer from memory, and never invent media.`;
	const first = knowledge ? tick(KNOWLEDGE_SEARCH) : "a web search";
	const fallback =
		knowledge && web
			? " When the knowledge base comes back empty, search the web in the same turn."
			: "";
	return `Search first, then put it up. "Show me", "what does X look like", "find the document about Y": your first act is ${first}, then ${tick(SHOW_LIBRARY)}, ${tick(OPEN_DOCUMENT)} or ${tick(PRESENT_CONTENT)} with what came back. You do not know what the library holds until you look, and you never answer a request to see something with a question. "What documents do we have", "what is in the library": that is ${tick(SHOW_LIBRARY)} with no query, the whole catalogue, and no search first.${fallback}`;
}

/** Said only on a turn that can look a record up, because the rule is "look it up first". */
function recordRule(enabled: readonly string[]): string | null {
	const lookups = [LOOKUP_RECORD, LIST_RECORDS].filter((key) =>
		enabled.includes(key),
	);
	if (!lookups.length) return null;
	return `- ${tick(SHOW_RECORD)} takes a kind and an id as ${lookups.map(tick).join(" or ")} returned them; look a record up before you show it. "What records are there", "which projects do we have": that is ${tick(SHOW_RECORDS)}, which lists them itself.`;
}

export function surfaceBlock(
	turn: Pick<ProductTurn, "enabledTools">,
	channel: ReplyChannel,
): string {
	const spoken = channel === "spoken";
	const verb = spoken ? "say" : "write";
	const controls = STAGE_TOOLS.map(
		(tool) => `- ${tick(tool.name)} — ${tool.description}`,
	);
	const server = SERVER_TOOLS.filter((t) =>
		turn.enabledTools.includes(t.key),
	).map(
		(t) => `- ${t.name ?? tick(t.key)} — ${(spoken && t.spokenLine) || t.line}`,
	);
	return [
		`THE STAGE. Beside this conversation is a stage you drive: a library of document cards, a reader for one document, a media section for one picture, a chart, a record card, a list of records, and a row of suggestion chips under the composer. Nothing reaches it unless you put it there, and the person sees the stage and hears ${spoken ? "your voice" : "your words"} together.`,
		`CONTROLS ON THIS TURN. The interface registered these; each one answers you with a status line:\n${controls.join("\n")}`,
		server.length
			? `On the server, this turn also has:\n${server.join("\n")}`
			: "No server-side tool is on this turn.",
		"HOW YOU DRIVE IT.",
		`- Act, don't offer. "Shall I show you?" wastes a turn: when a document, a picture, a figure or a record would help, put it up, then ${verb} your line.`,
		`- Show without being asked. A document you draw on goes in the reader; a record you talk about goes on the record card; a figure over time goes on the chart. Read the live context first: what is already on the stage stays there and is not put up again.`,
		`- ${searchRule(turn.enabledTools, verb)}`,
		`- Never invent media. ${tick(PRESENT_CONTENT)} takes only a URL a search returned on this turn, exactly as returned. No URL is ever ${spoken ? "spoken" : "written in your reply"}: the stage shows it.`,
		`- Every figure with its unit, ${spoken ? "said out loud" : "in the words"} and on the chart.`,
		`- Every reply ends with ${tick(SUGGEST_NEXT)} carrying three short things the person might ask next. ${tick(CLEAR_STAGE)} is the one call that takes no line after it.`,
		recordRule(turn.enabledTools),
	]
		.filter(Boolean)
		.join("\n\n");
}
