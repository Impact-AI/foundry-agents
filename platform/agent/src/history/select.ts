import { foundryHistoryStore } from "../foundry/conversations";
import { ownHistoryStore } from "../foundry/history";
import { agentSettings, type HistoryStoreKind } from "../settings";
import type { HistoryStore, ThreadHistory } from "./interface";

/**
 * The store a thread's messages are in: the one its document records, for
 * everything done to an existing thread, and the one the operator's
 * `history.store` names, read through the settings memo, for a thread
 * about to be made. A change to the setting therefore needs no restart and
 * strands nothing: threads made before it stay where they are, and two
 * replicas that read it a moment apart each make their threads in a store
 * that every replica reads them back from.
 *
 * Both stores are the Foundry host's, so this module imports from
 * `foundry/`: it and `memory/select.ts` are the two places outside it that
 * do (`contract/neutral.test.ts`).
 */
export interface HistoryStores {
	/** The store a thread is in; a document that names none is the own store's. */
	for(thread: ThreadHistory): HistoryStore;
	/** The store a new thread is made in. */
	forNew(): Promise<HistoryStore>;
}

export function historyStores(): HistoryStores {
	const own = ownHistoryStore();
	const byKind: Record<HistoryStoreKind, HistoryStore> = {
		own,
		foundry: foundryHistoryStore(),
	};
	return {
		for: (thread) => byKind[thread.store ?? "own"] ?? own,
		forNew: async () => byKind[(await agentSettings()).history.store],
	};
}
