import { envInt } from "@platform/config";
import type { Dossier } from "@platform/prompt";
import type { SharedMemo } from "@platform/redis";

/**
 * The three per-person reads a turn makes, cached across the fleet: each is
 * a round trip to Cosmos DB, for a value that moves rarely. Every entry
 * carries a TTL and the memo's size budget; only an origin answer is
 * written; and the erase path drops all three, because "within the TTL" is
 * not the guarantee an erase makes.
 */
export interface PersonCache<T> {
	/** Null for a miss of any kind, including no Redis. */
	read(resourceId: string): Promise<T | null>;
	write(resourceId: string, value: T): Promise<void>;
	drop(resourceId: string): Promise<void>;
}

export interface PersonContext {
	identity: { name: string | null };
	dossier: Dossier;
}

/** One conversation, reduced to what dating a gap needs. */
export interface ConversationStamp {
	id: string;
	/** ISO, UTC. */
	at: string;
}

export interface PersonCaches {
	/** What is remembered, as statements newest first. Every writer drops it, the extraction included. */
	memory: PersonCache<string[]>;
	/** Who they are and what they wrote. Dropped by `personChanged` when they edit it. */
	person: PersonCache<PersonContext>;
	/** When they last talked, as stamps: the newest two threads whoever asks. */
	stamps: PersonCache<ConversationStamp[]>;
}

function cache<T>(
	memo: SharedMemo,
	name: string,
	ttlSeconds: () => number,
): PersonCache<T> {
	const key = (resourceId: string) => `${name}:${resourceId}`;
	return {
		read: async (resourceId) =>
			(await memo.read<T>(key(resourceId)))?.value ?? null,
		write: (resourceId, value) =>
			memo.write(key(resourceId), value, ttlSeconds()),
		drop: (resourceId) => memo.drop(key(resourceId)),
	};
}

export function personCaches(memo: SharedMemo): PersonCaches {
	return {
		memory: cache(memo, "memory", () =>
			envInt("MEMORY_CACHE_TTL_SECONDS", 60, { min: 1 }),
		),
		person: cache(memo, "person", () =>
			envInt("PERSON_CACHE_TTL_SECONDS", 60, { min: 1 }),
		),
		stamps: cache(memo, "stamps", () =>
			envInt("LAST_CONVERSATION_CACHE_TTL_SECONDS", 300, { min: 1 }),
		),
	};
}
