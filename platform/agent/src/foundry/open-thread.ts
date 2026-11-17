import { hasStatus } from "@platform/cosmos";
import type { HistoryStore, ThreadHistory } from "../history/interface";
import {
	claimThread,
	createThreadDocument,
	readThreadDocument,
	releaseClaim,
	type ThreadDocument,
} from "./threads";

/**
 * A thread's first write, typed or spoken: the claim on its client-minted
 * id, then where its messages will be — in the store `history` names, which
 * the document records — then its index entry. Claimed first, so two
 * people minting one id never both get it. Nothing it makes is left where
 * an erase cannot find it — only the index entry is listed:
 *
 *   - two first writes of one person racing (a spoken turn's words and the
 *     answer, posted at once) both pass the claim; the one whose entry
 *     loses gives up what its store made and writes into the winner's;
 *   - a failure after the claim gives up what the store made and the
 *     claim, so neither names the person for ever beside no thread.
 *
 * Null when the id is somebody else's.
 */
export async function openThread(input: {
	resourceId: string;
	threadId: string;
	title: string;
	history: HistoryStore;
}): Promise<{ thread: ThreadDocument; created: boolean } | null> {
	const { resourceId, threadId } = input;
	if (!(await claimThread(threadId, resourceId))) return null;
	let made: ThreadHistory | null = null;
	try {
		made = await input.history.begin(threadId);
		const thread = await createThreadDocument({
			resourceId,
			threadId,
			title: input.title,
			history: made,
		});
		return { thread, created: true };
	} catch (err) {
		if (made) await discard(input.history, made);
		const winner = hasStatus(err, 409)
			? await readThreadDocument(resourceId, threadId)
			: null;
		if (winner) return { thread: winner, created: false };
		if (!(await readThreadDocument(resourceId, threadId)))
			await releaseClaim(threadId, resourceId);
		throw err;
	}
}

/** What a thread that was not opened made, given up; a failure is logged, never thrown over the one that matters. */
async function discard(history: HistoryStore, made: ThreadHistory) {
	try {
		await history.discard(made);
	} catch (err) {
		console.error(
			`[agent] what the ${history.kind} history made for a thread that was not opened is left behind:`,
			(err as Error).message,
		);
	}
}
