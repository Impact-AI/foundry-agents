import type { TranscriptMessage } from "../backend/conversations";

/**
 * A picture leaves the browser once, for the turn it belongs to, and is kept
 * nowhere but here. The transcript the backend hands back carries an
 * `image-slot` where the picture was; in the replayed thread that slot is a
 * marker text part, and the renderer draws it as an image slot filled from
 * the browser's own store when this is the device that sent it.
 */
export const IMAGE_SLOT_MARKER = "⟦image⟧";

export interface SentImage {
	messageId: string;
	index: number;
	value: string;
	mimeType: string;
}

export type ThreadLike = { id?: unknown; role?: unknown; content?: unknown };

export type ImageDataPart = {
	type: "image";
	source: { type: "data"; value: string; mimeType?: string };
};

export function isImageDataPart(part: unknown): part is ImageDataPart {
	if (!part || typeof part !== "object") return false;
	const { type, source } = part as { type?: unknown; source?: unknown };
	if (type !== "image" || !source || typeof source !== "object") return false;
	const { type: kind, value } = source as { type?: unknown; value?: unknown };
	return kind === "data" && typeof value === "string";
}

export function isSlotPart(part: unknown): boolean {
	if (!part || typeof part !== "object") return false;
	const { type, text } = part as { type?: unknown; text?: unknown };
	return type === "text" && text === IMAGE_SLOT_MARKER;
}

export function imageKey(messageId: string, index: number): string {
	return `${messageId}#${index}`;
}

/**
 * Every picture in a thread's user messages, indexed among that message's
 * image-shaped parts — data parts and slots alike — so a key still names the
 * same picture once the data has become a slot. Messages named in `except`
 * are passed over: they were sent in another thread.
 */
export function sentImagesIn(
	messages: readonly ThreadLike[],
	except: ReadonlySet<string> = new Set(),
): SentImage[] {
	const out: SentImage[] = [];
	for (const message of messages) {
		if (message?.role !== "user") continue;
		const id = message.id;
		if (typeof id !== "string" || !Array.isArray(message.content)) continue;
		if (except.has(id)) continue;
		let index = 0;
		for (const part of message.content) {
			if (isImageDataPart(part)) {
				out.push({
					messageId: id,
					index,
					value: part.source.value,
					mimeType:
						typeof part.source.mimeType === "string"
							? part.source.mimeType
							: "image/jpeg",
				});
				index += 1;
			} else if (isSlotPart(part)) {
				index += 1;
			}
		}
	}
	return out;
}

/** A thread message as CopilotKit holds it: the contract's parts, slots as markers. */
export interface ReplayedMessage {
	id: string;
	role: "user" | "assistant";
	content: string | { type: "text"; text: string }[];
}

export function replayMessages(
	transcript: readonly TranscriptMessage[],
): ReplayedMessage[] {
	return transcript.map((message) => {
		const parts = message.parts.map((part) =>
			part.type === "text"
				? { type: "text" as const, text: part.text }
				: { type: "text" as const, text: IMAGE_SLOT_MARKER },
		);
		if (message.role === "assistant") {
			return {
				id: message.id,
				role: "assistant",
				content: parts.map((p) => p.text).join(""),
			};
		}
		return { id: message.id, role: "user", content: parts };
	});
}

/**
 * The slots of a thread, in order, so a slot whose key the store does not
 * know can still be matched to the n-th picture this device kept for the
 * thread — the fallback for a transcript whose ids were reassigned.
 */
export function slotKeysIn(messages: readonly ThreadLike[]): string[] {
	const keys: string[] = [];
	for (const message of messages) {
		if (
			message?.role !== "user" ||
			typeof message.id !== "string" ||
			!Array.isArray(message.content)
		)
			continue;
		let index = 0;
		for (const part of message.content) {
			if (isSlotPart(part)) keys.push(imageKey(message.id, index));
			if (isSlotPart(part) || isImageDataPart(part)) index += 1;
		}
	}
	return keys;
}

/** The picture a slot shows: by key first, by position second, else nothing. */
export function pictureForSlot(
	held: ReadonlyMap<string, SentImage>,
	heldInOrder: readonly SentImage[],
	slotKeys: readonly string[],
	key: string,
): SentImage | null {
	const direct = held.get(key);
	if (direct) return direct;
	const position = slotKeys.indexOf(key);
	if (position === -1) return null;
	return heldInOrder[position] ?? null;
}
