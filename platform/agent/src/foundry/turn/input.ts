import type { LiveHistoryLine } from "../../contract/host";
import type { ThreadMessage, TurnPart } from "../../contract/messages";
import type {
	OpenCall,
	SaidMessage,
	ToolResultMessage,
} from "../../turn/input";
import {
	type DatedItem,
	type FunctionCallOutputItem,
	type InputItem,
	type ItemTime,
	itemText,
	type MessageItem,
	type StoredItem,
} from "../../turn/items";

export type {
	DatedItem,
	FunctionCallOutputItem,
	InputItem,
	ItemTime,
	MessageItem,
	StoredItem,
} from "../../turn/items";
export { saidLines } from "../../turn/items";

/**
 * A turn's input as items, and items read back as a thread's messages. A
 * picture travels as an item of its own ahead of the words that mark where
 * it was, in that turn's input only: the own history keeps the marker and
 * never the picture (`../history.ts`), and a conversation of the service's
 * has the picture's item deleted once the turn settles
 * (`../conversations.ts`).
 */

/** What a message says in place of each picture it carried. */
const PICTURE_MARKER = "[picture: shown once, not kept]";

function partsOf(content: string | TurnPart[]): TurnPart[] {
	return typeof content === "string"
		? [{ type: "text", text: content }]
		: content;
}

/** The person's words, each picture its own item before them, and its marker after them. */
export function saidItems(messages: readonly SaidMessage[]): MessageItem[] {
	return messages.flatMap((message) => {
		const parts = partsOf(message.content);
		const pictures = parts.filter((p) => p.type === "image");
		const words = parts
			.flatMap((p) => (p.type === "text" ? [p.text] : []))
			.join("\n");
		const marked = [words, ...pictures.map(() => PICTURE_MARKER)]
			.filter((line) => line.trim())
			.join("\n");
		return [
			...pictures.map(
				(picture): MessageItem => ({
					type: "message",
					role: "user",
					content: [
						{ type: "input_image", image_url: picture.data, detail: "auto" },
					],
				}),
			),
			{ type: "message", role: message.role, content: marked },
		];
	});
}

export function answeredItems(
	results: readonly ToolResultMessage[],
): FunctionCallOutputItem[] {
	return results.map((r) => ({
		type: "function_call_output",
		call_id: r.toolCallId,
		output: r.content,
	}));
}

/** The items the history keeps: the person's words with their markers, never a picture. */
export function keptItems(said: readonly MessageItem[]): MessageItem[] {
	return said.filter((item) => !isPictureItem(item));
}

/** An item as the model is given it again: the host's id dropped, a reasoning item's own given back. */
export function asInput(item: StoredItem): InputItem {
	const { id: _id, service_id, ...input } = item;
	return (service_id
		? { ...input, id: service_id }
		: input) as unknown as InputItem;
}

/**
 * The calls the agent made in the latest exchange that nobody has answered,
 * from the conversation's newest items, newest first: an output is seen
 * before its call, and the person's last message ends the search. Only the
 * named controls when `controls` is given; every call otherwise.
 */
export function openCalls(
	newestFirst: readonly StoredItem[],
	controls?: ReadonlySet<string>,
): OpenCall[] {
	const answered = new Set<string>();
	const open: OpenCall[] = [];
	for (const item of newestFirst) {
		if (item.type === "message" && item.role === "user") break;
		if (!item.call_id) continue;
		if (item.type === "function_call_output") answered.add(item.call_id);
		else if (
			item.type === "function_call" &&
			item.name &&
			(!controls || controls.has(item.name)) &&
			!answered.has(item.call_id)
		)
			open.push({ id: item.call_id, name: item.name });
	}
	return open;
}

/** The newest items read to find the calls the latest exchange left open. */
export const OPEN_CALL_WINDOW = 40;

const NOT_ANSWERED = JSON.stringify({ error: "not_answered" });

/**
 * An output for each call, saying nobody answered it: what the person's
 * next words go in behind, since the model takes no history with a call
 * that has no output.
 */
export function notAnswered(
	calls: readonly OpenCall[],
): FunctionCallOutputItem[] {
	return calls.map((call) => ({
		type: "function_call_output",
		call_id: call.id,
		output: NOT_ANSWERED,
	}));
}

/** Whether a message item is a picture the person sent: input to its turn, never kept. */
export function isPictureItem(
	item: Pick<StoredItem, "type" | "content">,
): boolean {
	return (
		item.type === "message" &&
		Array.isArray(item.content) &&
		item.content.some((part: { type?: string }) => part?.type === "input_image")
	);
}

/**
 * The message a thread shows for an item: the person's words or the
 * agent's answer, the markers counted. Null for every tool call, picture
 * and empty message, which a thread leaves out.
 */
function shownAs(item: StoredItem): Omit<ThreadMessage, "createdAt"> | null {
	if (item.type !== "message" || isPictureItem(item)) return null;
	if (item.role !== "user" && item.role !== "assistant") return null;
	const raw = itemText(item);
	const imageSlots = raw.split(PICTURE_MARKER).length - 1;
	const text = raw.replaceAll(PICTURE_MARKER, "").trim();
	if (!text && imageSlots === 0) return null;
	return { id: item.id, role: item.role, text, imageSlots };
}

/**
 * The thread as a live session is given it: the shown messages' words,
 * oldest first, each with an id of the session's own. A picture's marker
 * is dropped with the picture; a message left with no words is not given.
 */
export function liveHistoryLines(
	items: readonly StoredItem[],
): LiveHistoryLine[] {
	const lines: LiveHistoryLine[] = [];
	for (const item of items) {
		const shown = shownAs(item);
		if (!shown?.text) continue;
		lines.push({
			id: `hist_${lines.length}`,
			role: shown.role,
			text: shown.text,
		});
	}
	return lines;
}

export function isShown(item: StoredItem): boolean {
	return shownAs(item) !== null;
}

/**
 * Items dated by the record of their times, oldest first. Each takes its
 * own item's time; one the record no longer reaches takes the time of the
 * one before it, or `fallback`: never a later time than its own.
 */
export function datedItems(
	oldestFirst: readonly StoredItem[],
	times: readonly ItemTime[],
	fallback: string,
): DatedItem[] {
	const timeOf = new Map(times.map((t) => [t.id, t.at]));
	let last = fallback;
	return oldestFirst.map((item) => {
		last = timeOf.get(item.id) ?? last;
		return { item, at: last };
	});
}

/** A thread's messages from its history, oldest first: every tool call, output and reasoning left out. */
export function threadMessages(
	oldestFirst: readonly DatedItem[],
): ThreadMessage[] {
	return oldestFirst.flatMap(({ item, at }) => {
		const shown = shownAs(item);
		return shown ? [{ ...shown, createdAt: at }] : [];
	});
}
