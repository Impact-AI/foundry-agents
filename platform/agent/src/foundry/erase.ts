import { isRedisConfigured, redisAnswers } from "@platform/redis";
import type { EraseReport } from "../contract/host";
import { problems } from "../keys";
import type { SelectedMemoryStore } from "../memory/select";
import type { PersonCaches } from "../person/caches";
import { listThreadDocuments } from "./threads";

/**
 * Forgetting a person: everything held under the resource, in one call.
 * Every thread goes as `deleteThread` takes one — its messages, from the
 * store the thread was made in, then its claim and index entry — then what
 * is remembered, then every cached copy, verified gone, because the TTL is
 * not the guarantee an erase makes. A thread whose messages could not all
 * be deleted keeps its index entry and fails the erase
 * (`history_delete_failed`), so the retry finds it. The own store's
 * messages are then swept by their partition, which is the person: a
 * message whose thread has no index entry — written by a turn another
 * replica was still running when the thread went — is found by nothing
 * else. Idempotent, so a failure is retried until it reports clean.
 */
class EraseIncomplete extends Error {
	constructor(what: string) {
		super(`erase incomplete: ${what}`);
		this.name = "EraseIncomplete";
	}
}

/** Past any real history; reaching it means the index hands back threads it is not deleting. */
const MAX_ROUNDS = 100;

export interface EraseDeps {
	/** Every turn of the person's, on any thread and any replica, ended and waited for. */
	endTurns(resourceId: string): Promise<void>;
	deleteThread(resourceId: string, threadId: string): Promise<boolean>;
	/** Every message the own store holds under the resource, whatever thread it names. */
	sweepHistory(resourceId: string): Promise<number>;
	/** What is remembered, in whichever store holds any of it. */
	memory: Pick<SelectedMemoryStore, "erase">;
	caches: PersonCaches;
	/** Asked before each step: false stops the erase where it is. */
	stillHeld?: () => Promise<boolean>;
}

export async function eraseResource(
	deps: EraseDeps,
	resourceId: string,
): Promise<EraseReport> {
	// The erase is the caller's for as long as it says so: one that lapsed may by now be sweeping an account a sign-in made since.
	const held = async () => {
		if (deps.stillHeld && !(await deps.stillHeld())) {
			problems.report("agent.erase.incomplete", { reason: "not_held" });
			throw new EraseIncomplete("the erase is no longer the caller's");
		}
	};
	let threads = 0;
	for (let round = 0; ; round++) {
		if (round >= MAX_ROUNDS) {
			problems.report("agent.erase.incomplete", { reason: "threads_remain" });
			throw new EraseIncomplete("threads remain after the maximum rounds");
		}
		await held();
		// Before each look: a turn still being put together has no thread to be found by yet.
		await deps.endTurns(resourceId);
		const { documents } = await listThreadDocuments(resourceId);
		if (!documents.length) break;
		for (const document of documents) {
			await held();
			if (await deps.deleteThread(resourceId, document.id)) threads++;
		}
	}
	await held();
	await deps.sweepHistory(resourceId);
	await held();
	// The account goes whole, from the store in use and the one that is not: neither keeps a record that there was a forget.
	const memories = await deps.memory.erase(resourceId);
	await held();
	await dropCaches(deps.caches, resourceId);
	return { threads, memories };
}

/**
 * Every cached copy dropped, and read back to see it went. A copy that
 * could not be dropped — a configured Redis that does not answer, or a
 * copy that survived — is reported and does not fail the erase: a cache
 * holds a copy for its own lifetime at most (`MEMORY_CACHE_TTL_SECONDS`,
 * `PERSON_CACHE_TTL_SECONDS`, `LAST_CONVERSATION_CACHE_TTL_SECONDS`), and
 * failing the erase on it would shut the person's id until Redis answered
 * again, which may be far longer. Never throws.
 */
async function dropCaches(caches: PersonCaches, resourceId: string) {
	try {
		if (isRedisConfigured() && !(await redisAnswers())) {
			problems.report("agent.erase.incomplete", {
				reason: "cache_unreachable",
			});
			console.warn(
				"[agent] an erase could not reach the cache: its copies expire on their own",
			);
			return;
		}
		for (const cache of [caches.memory, caches.person, caches.stamps]) {
			await cache.drop(resourceId);
			if ((await cache.read(resourceId)) !== null) {
				problems.report("agent.erase.incomplete", { reason: "cache_kept" });
				console.warn(
					"[agent] an erase left a cached copy: it expires on its own",
				);
			}
		}
	} catch (err) {
		problems.report("agent.erase.incomplete", { reason: "cache_unreachable" });
		console.warn(
			"[agent] an erase could not drop a cached copy:",
			(err as Error).message,
		);
	}
}
