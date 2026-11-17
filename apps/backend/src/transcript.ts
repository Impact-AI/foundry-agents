import type { ThreadMessage } from "@platform/agent";

/** A stored message as the frontend and the export read it: text, and a slot for each picture that was sent and never kept. */
export interface TranscriptMessage {
	id: string;
	role: "user" | "assistant";
	parts: ({ type: "text"; text: string } | { type: "image-slot" })[];
	createdAt: string;
}

export function transcriptMessageOf(message: ThreadMessage): TranscriptMessage {
	return {
		id: message.id,
		role: message.role,
		parts: [
			...(message.text ? [{ type: "text" as const, text: message.text }] : []),
			...Array.from({ length: message.imageSlots }, () => ({
				type: "image-slot" as const,
			})),
		],
		createdAt: message.createdAt,
	};
}
