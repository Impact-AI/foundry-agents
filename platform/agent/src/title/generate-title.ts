import { envInt, processSingleton } from "@platform/config";
import { reasoningOptions, smallChatModel } from "@platform/llm";
import { spendCredits } from "@platform/metering";
import type { KeyNamespace } from "@platform/redis";
import { generateText } from "ai";
import { agentSettings } from "../settings";
import { TITLE_MAX } from "./title-from";

/**
 * What a conversation is called, written from what was said in it, and
 * written again as it grows: a conversation arrives at its subject rather
 * than announcing it. Every failure is `null`, because a title is a label
 * on a row and never worth a failed request; the caller falls back to
 * `titleFrom`.
 *
 * Declined, never queued: this is the lowest-value model call the product
 * makes. Three bounds, because the budget being spent is the chat
 * deployment's. Two are credit buckets — the person's, so one account
 * cannot spend the fleet's, and the fleet's; the per-replica cap is what
 * holds without Redis, and what stops one replica hoarding the burst. The
 * cap's slot is taken before anything is awaited: a check that awaited
 * before taking it would let every caller in the gap through.
 */

export type TitleTurn = { role: "user" | "assistant"; content: string };

/** The opening exchange and enough of what followed to see where it went. */
const TURNS_READ = 12;
/** What a turn was about survives truncation. */
const TURN_CHARS = 400;

/** Generous, and measured: a reasoning model takes 4-7 s over a title and longer with several in flight. */
function deadlineMs(): number {
	return envInt("TITLE_DEADLINE_MS", 25_000, { min: 1 });
}

function maxInflight(): number {
	return envInt("TITLE_MAX_INFLIGHT", 4, { min: 1 });
}

const SYSTEM = [
	"You name conversations. You are given the opening turns of a conversation between a person and an assistant.",
	"Reply with a title for it and nothing else.",
	"Rules:",
	"- Name the subject or the moment the conversation is actually about.",
	"- Two to six words. No sentence, no trailing full stop, no surrounding quotes.",
	"- Write it in the language the person is using.",
	"- Never use a date, a time, or a word like 'conversation', 'chat', or 'session'.",
	"- Capitalise it as a heading in that language would be, not in caps.",
	"- If the conversation is too short or too vague to have a subject yet, name the question that was asked.",
].join("\n");

/** In flight on this replica. A capacity guard, not per-person state. */
function inflight(): { count: number } {
	return processSingleton("agent:title:inflight", () => ({ count: 0 }));
}

/** Whether the person's bucket and then the fleet's have a title in them; the person's first, so a refusal there spends nothing of the fleet's. */
async function mayTitle(
	keys: KeyNamespace,
	resourceId: string,
): Promise<boolean> {
	const { titles, titlesPerResource } = await agentSettings();
	const own = await spendCredits(keys.key("titles", resourceId), {
		capacity: titlesPerResource.burst,
		refillPerMinute: titlesPerResource.refillPerMinute,
	});
	if (!own.allowed) return false;
	const fleet = await spendCredits(keys.key("titles"), {
		capacity: titles.burst,
		refillPerMinute: titles.refillPerMinute,
	});
	return fleet.allowed;
}

export async function generateTitle(
	turns: TitleTurn[],
	keys: KeyNamespace,
	resourceId: string,
): Promise<string | null> {
	const said = turns
		.filter((turn) => turn.content.trim())
		.slice(0, TURNS_READ)
		.map(
			(turn) =>
				`${turn.role === "user" ? "Person" : "Assistant"}: ${turn.content
					.replace(/\s+/g, " ")
					.trim()
					.slice(0, TURN_CHARS)}`,
		);
	if (said.length === 0) return null;

	const slot = inflight();
	if (slot.count >= maxInflight()) return null;
	slot.count++;
	try {
		if (!(await mayTitle(keys, resourceId))) return null;
		const { text } = await generateText({
			model: await smallChatModel(),
			system: SYSTEM,
			prompt: said.join("\n"),
			// A label deserves no chain of thought; left to itself a reasoning
			// model spends hundreds of tokens on one and truncates at the ceiling.
			providerOptions: reasoningOptions("low"),
			maxOutputTokens: 600,
			abortSignal: AbortSignal.timeout(deadlineMs()),
		});
		return cleanTitle(text);
	} catch (err) {
		console.warn(
			"[title] falling back to the opening line:",
			err instanceof Error ? err.message : err,
		);
		return null;
	} finally {
		slot.count--;
	}
}

/**
 * What came back, as a title, or null if it is not one. A label, wrapping
 * quotes and a closing full stop are the right answer said wrong; prose over
 * the budget is the model having ignored the brief, and the opening-line
 * fallback is better than a truncated sentence.
 */
export function cleanTitle(raw: string): string | null {
	let line = raw.replace(/\r/g, "").trim();
	line = line.replace(/^\s*title\s*[:\-–—]\s*/i, "");
	line = line.replace(/^["'“”„‚‘’«»]+|["'“”„‚‘’«»]+$/g, "");
	line = line.replace(/\s+/g, " ").trim();
	line = line.replace(/[.。]$/, "").trim();
	if (!line || line.length > TITLE_MAX) return null;
	return line;
}
