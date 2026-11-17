import {
	type LiveVoiceSettlement,
	MAX_VOICE_TURN_CHARS,
	type SpokenItem,
} from "../contract/host";

/**
 * A live session's record, as the thread keeps it. The broker hands the host every item it read off the socket; the
 * host writes the said lines, and three rules are what make the record
 * right:
 *
 *   1. The items' order, not arrival. Input transcription runs beside the
 *      response, so a person's final can arrive after the answer's: the
 *      record follows the chain the session announced (`previousItemId`),
 *      walked from its first item, and an item the chain does not place
 *      follows in the order it arrived. A failed or missing transcription
 *      is skipped and counted, never guessed.
 *   2. Finals only: the broker hands nothing else as `said`.
 *   3. Barge-in: a line the person spoke over is written whole — the reply
 *      the model generated, not what the person heard — and marked as
 *      broken off.
 *
 * Each item is written once, whatever the broker repeated, and each line is
 * bounded like any spoken turn, since the next turn reads it back. The
 * person's lines that led to an answer the content filter stopped are
 * marked blocked, as a typed turn the filter ended is: the thread shows
 * them, and memory never reads them.
 */

/** The mark of a line the person spoke over: a dash, not a word, so it reads the same in every language. */
const BROKEN_OFF = " —";

export interface SpokenLine {
	role: "user" | "assistant";
	text: string;
	/** When the session announced it, never earlier than the line before it. */
	at: string;
	/** The person's line, and the content filter stopped the answer it led to. */
	blocked?: true;
}

export interface SpokenRecord {
	lines: SpokenLine[];
	settlement: Omit<LiveVoiceSettlement, "repeated">;
}

/** The items in the chain's order: each after the item it follows, the unplaced in arrival order. */
function chainOrder(items: readonly SpokenItem[]): SpokenItem[] {
	const byId = new Map<string, SpokenItem>();
	for (const item of items)
		if (!byId.has(item.itemId)) byId.set(item.itemId, item);
	const after = new Map<string | null, SpokenItem[]>();
	for (const item of byId.values()) {
		const previous =
			item.previousItemId !== null && byId.has(item.previousItemId)
				? item.previousItemId
				: null;
		const siblings = after.get(previous);
		if (siblings) siblings.push(item);
		else after.set(previous, [item]);
	}
	const ordered: SpokenItem[] = [];
	const seen = new Set<string>();
	// Depth first, by hand rather than by recursion: a long session is a long chain.
	const walk = (first: readonly SpokenItem[]) => {
		const stack = [...first].reverse();
		for (let item = stack.pop(); item; item = stack.pop()) {
			if (seen.has(item.itemId)) continue;
			seen.add(item.itemId);
			ordered.push(item);
			stack.push(...[...(after.get(item.itemId) ?? [])].reverse());
		}
	};
	walk(after.get(null) ?? []);
	// A chain that loops on itself has no first item: what it held follows, as it arrived.
	for (const item of byId.values()) if (!seen.has(item.itemId)) walk([item]);
	return ordered;
}

/** `now` bounds every time: a broker's clock is trusted for the order of a session, never past the settle. */
export function spokenRecord(
	items: readonly SpokenItem[],
	now: string,
): SpokenRecord {
	const settlement: SpokenRecord["settlement"] = {
		written: 0,
		interrupted: 0,
		skipped: { failed: 0, unsettled: 0, filtered: 0 },
	};
	const lines: SpokenLine[] = [];
	let latest = "";
	// The person's lines since the voice last spoke: what its next answer answers.
	let asked: SpokenLine[] = [];
	let answered = true;
	for (const item of chainOrder(items)) {
		if (item.kind === "other") continue;
		if (item.role === "user" && answered) {
			asked = [];
			answered = false;
		}
		if (item.role === "assistant") answered = true;
		if (item.kind === "unheard") {
			settlement.skipped[item.reason]++;
			if (item.reason === "filtered")
				for (const line of asked) line.blocked = true;
			continue;
		}
		const said = item.text.trim();
		if (!said) continue;
		const text = item.interrupted
			? `${said.slice(0, MAX_VOICE_TURN_CHARS - BROKEN_OFF.length)}${BROKEN_OFF}`
			: said.slice(0, MAX_VOICE_TURN_CHARS);
		const at =
			Number.isNaN(Date.parse(item.at)) || item.at > now ? now : item.at;
		latest = at > latest ? at : latest;
		const line: SpokenLine = { role: item.role, text, at: latest };
		lines.push(line);
		if (item.role === "user") asked.push(line);
		settlement.written++;
		if (item.interrupted) settlement.interrupted++;
	}
	return { lines, settlement };
}
