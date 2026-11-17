import type { Transcript } from "@/src/backend/conversations";
import { callRoute, type Send } from "@/src/route-call";
import { type ReplayedMessage, replayMessages } from "./sent-images";

/** The part of the thread's agent a reload touches. */
export interface ReloadableThread {
	threadId: string;
	isRunning: boolean;
	setMessages: (messages: ReplayedMessage[]) => void;
}

/**
 * The thread read again from the conversation, as a page load would show it:
 * for turns kept without passing through the thread, which are the live
 * voice session's. Nothing changes when the read fails, when the thread has
 * moved to another conversation meanwhile, or while a run is writing to it.
 */
export async function reloadThread(
	thread: ReloadableThread,
	threadId: string,
	send: Send = fetch,
): Promise<boolean> {
	const answer = await callRoute<Transcript>(
		send,
		`/api/conversations/${encodeURIComponent(threadId)}`,
	);
	if (!answer.ok || thread.threadId !== threadId || thread.isRunning)
		return false;
	thread.setMessages(replayMessages(answer.body.messages));
	return true;
}
