import type { ConversationStamp, PersonCache } from "./caches";

/**
 * When the person last talked to the agent before the conversation they are
 * in. The thread this turn is in is being written to as the question is
 * asked, so the newest thread flat would answer "earlier today" from the
 * second turn on; the read takes the newest two and the caller drops its
 * own, which is at most one of them. The stamps are what is cached, because
 * they are the same whoever asks; the pick is arithmetic on the way out.
 * Where the threads live is the host's: `recent` reads the newest `count`.
 */
const RECENT_THREADS = 2;

export type RecentStamps = (
	resourceId: string,
	count: number,
) => Promise<ConversationStamp[]>;

/** The newest stamp that is not the conversation being had, or null. */
function pickLastConversation(
	stamps: readonly ConversationStamp[] | null,
	currentThreadId?: string | null,
): string | null {
	return stamps?.find((s) => s.id !== currentThreadId)?.at ?? null;
}

/** Null for no resource, no earlier conversation, and every kind of failure alike. */
export async function readLastConversation(
	recent: RecentStamps,
	cache: PersonCache<ConversationStamp[]>,
	resourceId: string | null,
	threadId: string | null,
): Promise<string | null> {
	if (!resourceId) return null;
	try {
		const cached = await cache.read(resourceId);
		if (cached) return pickLastConversation(cached, threadId);
		const stamps = await recent(resourceId, RECENT_THREADS);
		await cache.write(resourceId, stamps);
		return pickLastConversation(stamps, threadId);
	} catch (err) {
		console.error(
			"[last-conversation] read failed, continuing without it:",
			(err as Error).message,
		);
		return null;
	}
}
