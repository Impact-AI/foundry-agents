import type { MemoryItem, PersonMemory } from "../contract/host";
import type { AgentKeys } from "../keys";
import type { PersonCache } from "../person/caches";
import type { MemoryStoreKind } from "../settings";
import type { StoredItem } from "../turn/items";

/**
 * What the host asks of whichever store remembers a person: the Foundry
 * memory store (`foundry/memory.ts`, preview) or this deployment's own
 * `memory` container (`memory/store.ts`). The operator's `memory.store`
 * setting chooses one (`memory/select.ts`); both answer the same calls,
 * the person's Settings page and the erase path see no difference, and a
 * turn hands both the same thing — its thread, and the words said in it —
 * of which each reads the half it extracts from.
 */

/** A message as a turn said it: what was said, by whom. Never a picture. */
export interface MemoryMessage {
	role: "user" | "assistant";
	content: string;
}

export interface MemoryStore {
	/** Which implementation this is, as `memory.store` names it. */
	readonly kind: MemoryStoreKind;
	/** Everything remembered, newest first. Throws when the store cannot answer. */
	read(resourceId: string): Promise<PersonMemory>;
	/** The statements a turn carries, through the cache; null when they cannot be read. */
	statements(resourceId: string): Promise<string[] | null>;
	update(
		resourceId: string,
		itemId: string,
		content: string,
	): Promise<MemoryItem | null>;
	/**
	 * One fact gone for good. On the own store nothing said before the
	 * removal is learned from again, so what was said before it and had not
	 * been extracted yet is not learned either: the store cannot tell which
	 * earlier words taught the fact.
	 */
	remove(resourceId: string, itemId: string): Promise<boolean>;
	/**
	 * Everything remembered, gone for good: nothing still pending writes
	 * after it, and nothing said before it is learned from again, words not
	 * yet extracted included. Throws when
	 * it cannot promise that. `erasing` is the account going with it: the
	 * store then keeps no record that there was a forget either.
	 */
	forget(resourceId: string, options?: { erasing?: boolean }): Promise<boolean>;
	/**
	 * A finished turn: its thread, and the words said in it. The own store
	 * queues the thread and reads it back after the delay; the Foundry store
	 * hands the words over at once and the service extracts after its own.
	 * Never throws: memory is a favour, not the turn.
	 */
	handOver(
		resourceId: string,
		threadId: string,
		said: readonly MemoryMessage[],
	): Promise<void>;
	/** Every extraction waiting or in flight, run to the end: a test's. */
	flush(): Promise<void>;
	start(): void;
	/** The background work ended; what only this process held is finished first, within a bound. */
	stop(): void | Promise<void>;
}

export interface MemoryDeps {
	cache: PersonCache<string[]>;
	keys: AgentKeys;
	/** What the product says is worth keeping. */
	details: string;
	/**
	 * A thread's newest items, newest first, from whichever store holds its
	 * messages (`history/select.ts`): what the own store extracts from. The
	 * messages of a turn the content filter blocked are left out. None when
	 * there is no such thread. With `after`, an ISO instant, only what was
	 * said later than it: what the person removed or forgot is not read back
	 * out of the words that taught it.
	 */
	history(
		resourceId: string,
		threadId: string,
		limit: number,
		after?: string,
	): Promise<StoredItem[]>;
}
