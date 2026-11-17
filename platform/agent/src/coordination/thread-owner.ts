import { envInt } from "@platform/config";
import type { SharedMemo } from "@platform/redis";

/**
 * Whose thread a client-minted thread id names. The resource id is only
 * half of tenancy: the service loads whatever conversation it is handed, so
 * a caller with a valid scope of their own could read or write another
 * person's conversation by naming its id. Every path that takes a
 * thread id asks here first. A thread that does not exist yet is nobody's,
 * and is created under the caller's own scope.
 *
 * A thread's owner never changes, so the answer is cacheable, and it
 * matters: without a cache every turn pays a round trip to the database the
 * agent's other reads share. Three layers — this replica's map, the
 * fleet's memo, the store's claim — and only hits are cached: a miss is "no such
 * thread yet", the state about to change. The failure direction is the one
 * that matters: a sick cache is a fall-through, never a pass, and a store
 * that cannot answer is a typed failure, never an ownership pass.
 */
export interface ThreadLookup {
	getOwner(threadId: string): Promise<string | null>;
	/** Drop what every layer holds for a deleted thread, so a reused id is not answered with the dead one's owner. */
	forget(threadId: string): Promise<void>;
}

export class ThreadLookupError extends Error {
	constructor(cause: unknown) {
		super("thread lookup failed", { cause });
		this.name = "ThreadLookupError";
	}
}

export type Ownership = "mine" | "nobodys" | "theirs";

/** Where the claim on a thread id lives: its owner, or null when nobody has claimed it. */
export type OwnerOf = (threadId: string) => Promise<string | null>;

const MAX_LOCAL_ENTRIES = 2_000;

export function layeredThreadLookup(
	ownerOf: OwnerOf,
	memo: SharedMemo,
): ThreadLookup {
	const local = new Map<string, string>();
	const key = (threadId: string) => `thread-owner:${threadId}`;
	const ttl = () => envInt("THREAD_OWNER_CACHE_TTL_SECONDS", 3_600, { min: 1 });
	return {
		async getOwner(threadId) {
			const held = local.get(threadId);
			if (held) return held;
			const shared = await memo.read<string>(key(threadId));
			if (typeof shared?.value === "string" && shared.value) {
				remember(threadId, shared.value);
				return shared.value;
			}
			let owner: string | null;
			try {
				owner = await ownerOf(threadId);
			} catch (err) {
				throw new ThreadLookupError(err);
			}
			if (!owner) return null;
			remember(threadId, owner);
			await memo.write(key(threadId), owner, ttl());
			return owner;
		},
		async forget(threadId) {
			local.delete(threadId);
			await memo.drop(key(threadId));
		},
	};

	/** FIFO: the working set is the threads active here, so dropping the oldest insertion behaves like an LRU without the bookkeeping. */
	function remember(threadId: string, owner: string): void {
		if (local.size >= MAX_LOCAL_ENTRIES) {
			const oldest = local.keys().next().value;
			if (oldest !== undefined) local.delete(oldest);
		}
		local.set(threadId, owner);
	}
}

/** Throws `ThreadLookupError` when the store cannot answer. */
export async function ownershipOf(
	lookup: ThreadLookup,
	threadId: string,
	resourceId: string,
): Promise<Ownership> {
	const owner = await lookup.getOwner(threadId);
	if (!owner) return "nobodys";
	return owner === resourceId ? "mine" : "theirs";
}
