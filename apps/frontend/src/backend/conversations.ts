import { backendJson, type Caller } from "./client";

/** The shapes the contract names; the backend owns them, this side reads them. */
export interface ConversationSummary {
	id: string;
	title: string;
	updatedAt: string;
}

export type TranscriptPart =
	| { type: "text"; text: string }
	| { type: "image-slot" };

export interface TranscriptMessage {
	id: string;
	role: "user" | "assistant";
	parts: TranscriptPart[];
	createdAt: string;
}

export interface Transcript {
	id: string;
	title: string;
	messages: TranscriptMessage[];
}

export async function listConversations(
	caller: Caller,
): Promise<ConversationSummary[]> {
	const { conversations } = await backendJson<{
		conversations: ConversationSummary[];
	}>(caller, "/conversations");
	return conversations;
}

export async function readConversation(
	caller: Caller,
	id: string,
): Promise<Transcript> {
	return backendJson<Transcript>(
		caller,
		`/conversations/${encodeURIComponent(id)}`,
	);
}

export async function renameConversation(
	caller: Caller,
	id: string,
	title: string,
): Promise<{ id: string; title: string }> {
	return backendJson(caller, `/conversations/${encodeURIComponent(id)}`, {
		method: "PATCH",
		json: { title },
	});
}

export async function deleteConversation(
	caller: Caller,
	id: string,
): Promise<void> {
	await backendJson<void>(caller, `/conversations/${encodeURIComponent(id)}`, {
		method: "DELETE",
	});
}
