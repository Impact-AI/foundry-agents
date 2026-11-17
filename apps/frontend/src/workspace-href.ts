/**
 * Where the workspace is, as a link: the conversation a URL carries, or the
 * workspace's own choice — the newest — when it carries none. The rooms off
 * the workspace carry the conversation they were opened from, so the way
 * back returns to it.
 */
const CONVERSATION_ID = /^[\w-]{1,80}$/;

/** The conversation id a query string carried, if it is one. */
export function conversationParam(value: unknown): string | null {
	return typeof value === "string" && CONVERSATION_ID.test(value)
		? value
		: null;
}

function withConversation(path: string, conversation: string | null): string {
	return conversation ? `${path}?c=${encodeURIComponent(conversation)}` : path;
}

export function workspaceHref(conversation: string | null): string {
	return withConversation("/chat", conversation);
}

export function settingsHref(conversation: string | null): string {
	return withConversation("/settings", conversation);
}

export function privacyHref(conversation: string | null): string {
	return withConversation("/privacy", conversation);
}
