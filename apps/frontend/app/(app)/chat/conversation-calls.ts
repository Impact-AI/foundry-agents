import type { ConversationSummary } from "@/src/backend/conversations";
import type { ErrorCode } from "@/src/errors";
import { callRoute, jsonInit, type Send } from "@/src/route-call";

/**
 * The picker's calls, through this app's own routes
 * (`app/api/conversations`): the list as it stands, and the two changes to
 * one conversation.
 * Each answers the route's code on a refusal, for the catalogue to render.
 */
export interface CallResult {
	code?: ErrorCode;
}

const LIST = "/api/conversations";
const routeOf = (id: string) => `${LIST}/${encodeURIComponent(id)}`;

/** The caller's conversations now: the list the page was drawn with is stale after the first turn of a new one. */
export async function listConversations(
	send: Send = fetch,
): Promise<CallResult & { conversations?: ConversationSummary[] }> {
	const answer = await callRoute<{ conversations?: unknown }>(send, LIST, {
		method: "GET",
	});
	if (!answer.ok) return { code: answer.code };
	const conversations = answer.body?.conversations;
	return Array.isArray(conversations)
		? { conversations: conversations as ConversationSummary[] }
		: { code: "generic" };
}

export async function renameConversation(
	id: string,
	title: string,
	send: Send = fetch,
): Promise<CallResult> {
	const answer = await callRoute(
		send,
		routeOf(id),
		jsonInit("PATCH", { title }),
	);
	return answer.ok ? {} : { code: answer.code };
}

export async function deleteConversation(
	id: string,
	send: Send = fetch,
): Promise<CallResult> {
	const answer = await callRoute(send, routeOf(id), { method: "DELETE" });
	return answer.ok ? {} : { code: answer.code };
}
