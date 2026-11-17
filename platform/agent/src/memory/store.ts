import {
	type ContainerDefinition,
	type CosmosDocument,
	cosmosDatabase,
	hasStatus,
	type Stored,
} from "@platform/cosmos";
import { getRedis, isRedisConfigured } from "@platform/redis";
import type { MemoryItem } from "../contract/host";
import { dueQueue } from "../coordination/due-queue";
import { problems } from "../keys";
import { agentSettings } from "../settings";
import { saidLines } from "../turn/items";
import { extractFacts, MESSAGES_READ } from "./extract";
import type { MemoryDeps, MemoryStore } from "./interface";
import { cachedStatements, correction } from "./shared";

/**
 * What the agent remembers about a person, in this deployment's own
 * database (`memory.store: "own"`; the Foundry memory store is the other
 * answer, `foundry/memory.ts`): one `memory` document per fact, in the
 * person's partition. The
 * facts are read into the third part of the prompt on every turn through a
 * fleet-shared cache, and the person sees, corrects and removes them from
 * Settings.
 *
 * They are written off the request path: a finished turn hands its thread
 * over, and after the operator's delay — a new hand-over for the thread
 * restarts the wait — one model call reads the thread's latest messages
 * with what is kept and answers the list to keep from now on. The wait is
 * a Redis sorted set a sweeper on one replica works through; without Redis
 * it is this process's timer.
 *
 * Forgetting is final, and so is removing one fact: either leaves a floor,
 * a document in the person's partition holding when it happened, and an
 * extraction reads only what was said after it, as the replicas' clocks
 * tell it. An extraction in flight reads the floor when it begins and again
 * after it has written: a forget in between deletes everything, a removal
 * in between deletes what that run added. A removal's floor names the fact
 * removed, which is how an extraction tells the person's hand from another
 * extraction's own delete of a fact it reworded. The floor is a document, not a
 * key with a lifetime, so it holds on every replica, with Redis or without,
 * for as long as the words before it can still be read.
 */

const MEMORY: ContainerDefinition = {
	name: "memory",
	partitionKey: "/resourceId",
};

/** The container the facts live in, for an app's start to verify and the template to create. */
export const memoryContainer = MEMORY;

interface FactDocument extends CosmosDocument {
	resourceId: string;
	text: string;
	createdAt: string;
	updatedAt: string;
}

/** The one document in a person's partition that is not a fact. */
const FLOOR_ID = "floor";

interface FloorDocument extends CosmosDocument {
	resourceId: string;
	/** When the person last removed a fact or forgot them all: nothing said before it is read again. */
	at: string;
	/** When they last forgot them all, if ever. */
	forgotAt?: string;
	/**
	 * The facts they removed, the latest last and no more than
	 * `REMOVED_KEPT`: what tells their removal from an extraction's own
	 * delete. Several, because two removals can overlap, and an extraction
	 * that read both facts must know either as taken back. A forget empties
	 * it: everything went, and the floor says so by its own time.
	 */
	removed?: string[] | string;
}

/** How many removals a floor names: far more than can overlap one extraction. */
const REMOVED_KEPT = 32;

/** A move of the floor that another move overtook is made again on what is there. */
const FLOOR_TRIES = 5;

const removedOf = (floor: FloorDocument | null): string[] =>
	Array.isArray(floor?.removed)
		? floor.removed
		: typeof floor?.removed === "string"
			? [floor.removed]
			: [];

export type { MemoryDeps, MemoryStore } from "./interface";

/** How long an erased account is refused a write: past an extraction that was mid-call when it went. */
const ERASED_SECONDS = 300;
/** How often due extractions are looked for. */
const SWEEP_MS = 10_000;

const facts = () => cosmosDatabase().container(MEMORY.name);

function itemOf(doc: Stored<FactDocument>): MemoryItem {
	return { id: doc.id, content: doc.text, updatedAt: doc.updatedAt };
}

function newestFirst(docs: Stored<FactDocument>[]): Stored<FactDocument>[] {
	return [...docs].sort(
		(a, b) =>
			b.updatedAt.localeCompare(a.updatedAt) || b.id.localeCompare(a.id),
	);
}

/** The own store: `memory.store: "own"`. */
export function memoryStore({
	cache,
	keys,
	details,
	history,
}: MemoryDeps): MemoryStore {
	const erasedKey = (resourceId: string) =>
		keys.namespace.key("memory-erased", resourceId);
	/** Accounts this process saw erased, and until when: the keeper without Redis. */
	const erasedLocally = new Map<string, number>();

	/** Redis, when there is one to ask; a configured one that does not answer throws. */
	async function redis() {
		if (!isRedisConfigured()) return null;
		const client = await getRedis();
		if (!client) throw new Error("Redis is configured and does not answer");
		return client;
	}

	/**
	 * An erased account leaves no floor behind, so what stops an extraction
	 * that was mid-call when it went is this: a mark that outlives the call
	 * and then expires, in Redis for the fleet, in this process without it.
	 */
	async function markErased(resourceId: string) {
		const client = await redis();
		if (client)
			await client.send("SET", [
				erasedKey(resourceId),
				"1",
				"EX",
				String(ERASED_SECONDS),
			]);
		const now = Date.now();
		for (const [id, until] of erasedLocally)
			if (until <= now) erasedLocally.delete(id);
		erasedLocally.set(resourceId, now + ERASED_SECONDS * 1000);
	}

	/** Said, not silent: an account made again under the id inside the mark's time learns nothing until it lapses. */
	function dropped() {
		problems.report("agent.memory.extraction_failed", { reason: "erased" });
		console.warn(
			`[memory] an extraction was dropped: the account was erased within the last ${ERASED_SECONDS} s`,
		);
	}

	async function erased(resourceId: string): Promise<boolean> {
		if ((erasedLocally.get(resourceId) ?? 0) > Date.now()) return true;
		const client = await redis();
		return !!client && !!(await client.send("GET", [erasedKey(resourceId)]));
	}

	async function all(resourceId: string): Promise<Stored<FactDocument>[]> {
		const docs = await facts().query<FactDocument>(
			{ query: "SELECT * FROM c" },
			resourceId,
		);
		return newestFirst(docs.filter((doc) => doc.id !== FLOOR_ID));
	}

	async function deleteAll(resourceId: string): Promise<number> {
		let deleted = 0;
		for (const doc of await all(resourceId))
			if (await facts().delete(doc.id, resourceId)) deleted++;
		return deleted;
	}

	const floor = (resourceId: string) =>
		facts().read<FloorDocument>(FLOOR_ID, resourceId);

	/**
	 * Move the floor to now: a removal's, adding the fact removed to those it
	 * names, or with `forgot` a forget's. Each move names the floor it read
	 * (its etag), so two removals at once both leave their fact named.
	 */
	async function raiseFloor(
		resourceId: string,
		forgot: boolean,
		removed?: string,
	) {
		for (let attempt = 0; attempt < FLOOR_TRIES; attempt++) {
			const at = new Date().toISOString();
			const current = await floor(resourceId);
			const named = forgot
				? []
				: [...removedOf(current), ...(removed ? [removed] : [])].slice(
						-REMOVED_KEPT,
					);
			try {
				if (!current) {
					await facts().create<FloorDocument>({
						id: FLOOR_ID,
						resourceId,
						at,
						...(forgot ? { forgotAt: at } : {}),
						removed: named,
					});
					return;
				}
				const moved = await facts().patch(
					FLOOR_ID,
					resourceId,
					[
						{ op: "set" as const, path: "/at", value: at },
						...(forgot
							? [{ op: "set" as const, path: "/forgotAt", value: at }]
							: []),
						{ op: "set" as const, path: "/removed", value: named },
					],
					{ ifMatch: current._etag },
				);
				if (moved) return;
			} catch (err) {
				// Made or moved by another in between: this move is made on theirs.
				if (!hasStatus(err, 409) && !hasStatus(err, 412)) throw err;
			}
		}
		throw new Error("the memory's floor kept moving under a removal");
	}

	async function extract(resourceId: string, threadId: string) {
		const began = await floor(resourceId);
		const { memory } = await agentSettings();
		const messages = saidLines(
			await history(resourceId, threadId, MESSAGES_READ, began?.at),
		);
		if (!messages.length) return;
		const kept = await all(resourceId);
		const next = await extractFacts({
			kept: kept.map((doc) => doc.text),
			messages,
			details,
			itemMaxChars: memory.itemMaxChars,
		});
		if (!next) return;
		if (kept.length && !next.length) {
			// One answer never empties a memory: the person does that, in Settings.
			console.warn(
				"[memory] an extraction answered no facts at all; what is kept stays",
			);
			return;
		}
		// Moved since this began: the list was answered from what the person has
		// since taken back. The floor's version tells it, since two moves can
		// share a millisecond.
		const before = await floor(resourceId);
		if (before?._etag !== began?._etag) return;
		if (await erased(resourceId)) return dropped();
		// A fact the answer was made from that is no longer there. The person's
		// removal names it on the floor, and the answer may hold it reworded, so
		// nothing of the answer is written. Any other is another extraction's
		// own delete, for this person on another thread or replica: it kept
		// what it meant to, and this answer stands beside it.
		const present: Stored<FactDocument>[] = [];
		for (const doc of kept) {
			const current = await facts().read<FactDocument>(doc.id, resourceId);
			if (current) present.push(current);
			else if (removedOf(before).includes(doc.id)) return;
		}
		const now = new Date().toISOString();
		const added: string[] = [];
		for (const text of next) {
			if (kept.some((doc) => doc.text === text)) continue;
			const id = `fact_${crypto.randomUUID()}`;
			await facts().create<FactDocument>({
				id,
				resourceId,
				text,
				createdAt: now,
				updatedAt: now,
			});
			added.push(id);
		}
		// What landed during the write: a forget takes everything, a removal
		// what this run added. Only a run whose additions stand deletes what
		// its answer left out, so a fact is never lost with its rewording.
		const ended = await floor(resourceId);
		if (ended?.forgotAt !== began?.forgotAt || (await erased(resourceId)))
			await deleteAll(resourceId);
		else if (ended?._etag !== began?._etag)
			for (const id of added) await facts().delete(id, resourceId);
		else
			for (const current of present) {
				if (next.includes(current.text)) continue;
				// Corrected since it was read: the person's hand is the later word.
				const read = kept.find((doc) => doc.id === current.id);
				if (current._etag === read?._etag)
					await facts().delete(current.id, resourceId);
			}
		await cache.drop(resourceId);
	}

	const queue = dueQueue({
		name: "memory",
		namespace: keys.namespace,
		sweepMs: SWEEP_MS,
		work: extract,
		failed(err) {
			problems.report("agent.memory.extraction_failed", {});
			console.error(
				"[memory] a thread's facts were not extracted:",
				err.message,
			);
		},
	});

	/** The fact, when it is the person's; null when it is gone. The partition is the ownership check. */
	const owned = async (resourceId: string, itemId: string) =>
		itemId === FLOOR_ID ? null : facts().read<FactDocument>(itemId, resourceId);

	return {
		kind: "own",

		async read(resourceId) {
			return { items: (await all(resourceId)).map(itemOf) };
		},

		statements: (resourceId) =>
			cachedStatements(cache, resourceId, async () =>
				(await all(resourceId)).map((doc) => doc.text),
			),

		async update(resourceId, itemId, content) {
			const text = await correction(this, resourceId, itemId, content, () =>
				owned(resourceId, itemId),
			);
			if (!text) return null;
			const updated = await facts().patch<FactDocument>(itemId, resourceId, [
				{ op: "set", path: "/text", value: text },
				{ op: "set", path: "/updatedAt", value: new Date().toISOString() },
			]);
			await cache.drop(resourceId);
			return updated ? itemOf(updated) : null;
		},

		async remove(resourceId, itemId) {
			// A fact that is not there moves nothing.
			if (!(await owned(resourceId, itemId))) return false;
			// Raised before the delete, naming the fact: the words that taught it
			// are not read again, and an extraction that read it knows whose
			// delete took it. And again after it: an extraction that began in
			// between finds the floor moved before it keeps a rewording.
			await raiseFloor(resourceId, false, itemId);
			const gone = await facts().delete(itemId, resourceId);
			await raiseFloor(resourceId, false);
			if (gone) await cache.drop(resourceId);
			return gone;
		},

		async forget(resourceId, options) {
			// Raised before the delete: an extraction in flight anywhere in the fleet keeps nothing after this.
			await raiseFloor(resourceId, true);
			if (options?.erasing) await markErased(resourceId);
			await queue.unschedule(resourceId);
			const had = (await deleteAll(resourceId)) > 0;
			// The account is going: its threads go with it, and the floor has nothing left to guard.
			if (options?.erasing) await facts().delete(FLOOR_ID, resourceId);
			// Again after the delete, for an extraction that began in between.
			else await raiseFloor(resourceId, true);
			await cache.drop(resourceId);
			return had;
		},

		// The words said are not needed: the thread is read back after the delay.
		async handOver(resourceId, threadId) {
			try {
				const { memory } = await agentSettings();
				await queue.schedule(
					resourceId,
					threadId,
					memory.updateDelaySeconds * 1000,
				);
			} catch (err) {
				problems.report("agent.memory.handover_failed", {});
				console.error(
					"[memory] a turn's thread was not queued for extraction:",
					(err as Error).message,
				);
			}
		},

		flush: () => queue.flush(),
		start: () => queue.start(),
		stop: () => queue.stop(),
	};
}
