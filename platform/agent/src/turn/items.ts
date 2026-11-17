import { withoutCitationMarkers } from "./citation-markers";

/**
 * A thread's items, as every host and every store of a thread's messages
 * or a person's memory reads them: the shapes the model takes as input and
 * the same shapes with the id a history keeps them under. Nothing here
 * names where they are kept.
 */

export interface MessageItem {
	type: "message";
	role: "user" | "assistant";
	content:
		| string
		| { type: "input_image"; image_url: string; detail: "auto" }[];
}

export interface FunctionCallOutputItem {
	type: "function_call_output";
	call_id: string;
	output: string;
}

export interface FunctionCallItem {
	type: "function_call";
	call_id: string;
	name: string;
	arguments: string;
}

/**
 * The model's reasoning, opaque: given back so a turn the browser's answers
 * continue reads on from it. The service takes it back only with the id it
 * gave it (`rs_…`), even with `store: false`: the id names the item, the
 * encrypted content carries it. Without the id the service answers 400 "The
 * provided data does not match the expected schema".
 */
export interface ReasoningItem {
	type: "reasoning";
	id: string;
	encrypted_content: string;
	summary: { type: "summary_text"; text: string }[];
}

export type InputItem =
	| MessageItem
	| FunctionCallOutputItem
	| FunctionCallItem
	| ReasoningItem;

/** An item as a history holds it: an input item with its id. */
export interface StoredItem {
	id: string;
	type: string;
	role?: string;
	content?: unknown;
	call_id?: string;
	name?: string;
	arguments?: string;
	output?: string;
	encrypted_content?: string;
	summary?: unknown;
	/** The id the service gave a reasoning item, which it must be given back under. */
	service_id?: string;
}

/** When a message the thread shows was written, by its item: the service gives an item no time. */
export interface ItemTime {
	id: string;
	at: string;
}

/** A history document as a thread shows it: the item and when it was said. */
export interface DatedItem {
	item: StoredItem;
	at: string;
}

/** The words of a message item, whichever part type the service stored them as. */
export function itemText(item: StoredItem): string {
	if (typeof item.content === "string") return item.content;
	if (!Array.isArray(item.content)) return "";
	return withoutCitationMarkers(
		item.content
			.map((part: { type?: string; text?: unknown }) =>
				typeof part?.text === "string" ? part.text : "",
			)
			.join(""),
	);
}

/** The words of the messages among a thread's items, given newest first and answered oldest first: no call, no output, no empty line. */
export function saidLines(
	newestFirst: readonly StoredItem[],
): { role: "user" | "assistant"; content: string }[] {
	return [...newestFirst].reverse().flatMap((item) => {
		if (item.type !== "message") return [];
		const content = itemText(item).trim();
		return content
			? [{ role: item.role === "user" ? "user" : "assistant", content }]
			: [];
	});
}
