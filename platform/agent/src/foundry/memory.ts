import { envString } from "@platform/config";
import { getRedis, isRedisConfigured } from "@platform/redis";
import type { MemoryItem, PersonMemory } from "../contract/host";
import { type AgentProduct, memoryDetailsOf } from "../contract/product";
import { problems } from "../keys";
import type { MemoryDeps, MemoryStore } from "../memory/interface";
import { cachedStatements, correction } from "../memory/shared";
import { agentSettings } from "../settings";
import { deleted, hasStatus, projectClient } from "./client";
import { type Purger, purger } from "./purge";

/**
 * What the agent remembers about a person, on Foundry's memory store
 * (preview): `memory.store: "foundry"`, the default; this deployment's own
 * container is the other answer (`memory/store.ts`). The store extracts
 * the statements itself from the messages it is handed after a turn,
 * debounced — a new hand-over restarts its wait — and keeps them under a
 * scope. The scope is the backend's verified account id,
 * never the service's `{{$userId}}`: the backend is the store's only
 * caller, so the caller's identity would put everybody in one scope.
 *
 * The statements are read into the third part of the prompt on every turn
 * through a fleet-shared cache, and the person sees, corrects and removes
 * them from Settings. A statement is addressed by id across every scope,
 * so each one is read and its scope compared before anybody may change it.
 *
 * Forgetting is final, which `deleteScope` alone is not: an update still
 * waiting out its delay when the scope goes extracts afterwards and writes
 * its statements back into the scope that was just emptied. So every
 * hand-over's update id is kept in Redis until it must have settled, and a
 * forget looks each one up. When all have settled the scope's delete is the
 * last word; when one has not, the scope is deleted now, the person's reads
 * answer empty, and the purge sweeper deletes the scope again once every
 * update queued before the forget has settled — whatever those updates
 * wrote, and anything said in between, goes with it.
 *
 * The hand-over is submitted, never awaited, so the store's extraction
 * cannot fail a turn — and cannot be seen to fail at all from here. So
 * every tracked update is also watched: once past its delay and the
 * extraction grace the sweeper looks it up, and one not completed by then
 * — still running, or failed — is reported under
 * `agent.memory.extraction_stalled`, once. On a private deployment every
 * update stalls, because the store's extraction calls the account's model
 * from outside the network; `memoryStoreFor` keeps that store from being
 * chosen there, and this is what says so if it was.
 */

const DEFAULT_MEMORY_STORE = "person-memory";

function memoryStoreName(): string {
	return envString("FOUNDRY_MEMORY_STORE") ?? DEFAULT_MEMORY_STORE;
}

/** The most statements one read takes: far past what `memory.maxChars` lets a turn carry. */
const READ_MAX = 100;

interface StoredItem {
	memory_id: string;
	scope: string;
	content: string;
	kind: string;
	updated_at: Date | string;
}

function itemOf(stored: StoredItem): MemoryItem {
	return {
		id: stored.memory_id,
		content: stored.content,
		updatedAt: new Date(stored.updated_at).toISOString(),
	};
}

/** The Foundry store, with what its tests reach past the interface. */
export interface FoundryMemoryStore extends MemoryStore {
	/** The sweeper's half of a forget: true once nothing pending can write the scope back. */
	settle(resourceId: string): Promise<boolean>;
	/** The sweeper's look at the watched updates due by `now`: how many it reported stalled. */
	stalled(now?: number): Promise<number>;
	/** The sweeper that finishes a forget the request could not. */
	readonly purger: Purger;
}

/**
 * The store's list refuses a scope holding anything but letters, digits, `-`
 * and `_`; an account id is escaped into those, one to one, by writing every
 * other byte, `_` included, as `_XX`. An Entra object id is its own scope.
 */
const UNSAFE_IN_SCOPE = /[^A-Za-z0-9-]/g;

function scopeOf(resourceId: string): string {
	return resourceId.replace(UNSAFE_IN_SCOPE, (ch) =>
		Array.from(
			new TextEncoder().encode(ch),
			(byte) => `_${byte.toString(16).toUpperCase().padStart(2, "0")}`,
		).join(""),
	);
}

/**
 * Past an update's delay, how long its extraction may still take. A forget
 * looks up the updates handed over within this of now; one older has
 * settled. The live store took about a minute and a half past its delay.
 */
const EXTRACTION_GRACE_S = 15 * 60;
/** How long the sweeper waits for an update to settle before deleting the scope regardless. */
const SETTLE_DEADLINE_S = 60 * 60;
/** Updates a forget looks up itself; past these the sweeper does. */
const CHECKS_IN_REQUEST = 10;
/** A superseded update points at the one that carries its messages on; past this, it is treated as pending. */
const SUPERSEDE_HOPS = 10;
/** Watched updates one sweep looks up, at most: a minute's hand-overs on a busy fleet, never the whole backlog. */
const WATCH_BATCH = 50;

/** A forget the sweeper finishes: the updates it waits for, and when the scope went. */
interface Erasing {
	updateIds: string[];
	erasedAt: number;
}

/** The update id a hand-over's first answer names: in its body, else at the end of its status location. */
function updateIdOf(raw: {
	parsedBody?: unknown;
	headers?: { get(name: string): string | undefined };
}): string | undefined {
	const body = raw.parsedBody as { update_id?: unknown } | undefined;
	if (typeof body?.update_id === "string" && body.update_id)
		return body.update_id;
	const location = raw.headers?.get("operation-location");
	if (!location) return undefined;
	const id = new URL(location, "https://store.invalid").pathname
		.split("/")
		.pop();
	return id ? decodeURIComponent(id) : undefined;
}

/**
 * Everything the Foundry store holds under an account, gone, for an account
 * that is going while another store is the one in use: a deployment that
 * ran the Foundry store before its operator changed `memory.store` keeps
 * what it remembered there, where nothing else reaches it. A project that
 * never had the store, or holds nothing under the account, answers 404,
 * which is nothing to forget. Any other failure throws, a 400 or a 403
 * included: a deployment that ran the Foundry store and has since lost the
 * role or gone private answers 403 while it still holds the person's
 * statements, and an erase reported done over them would be a lie. The
 * account's erase is left unfinished instead — reported, refused with 503
 * and swept again at the next ask or sign-in — until an operator restores
 * the access or empties the store.
 */
export async function eraseFromFoundryStore(
	deps: MemoryDeps,
	resourceId: string,
): Promise<boolean> {
	try {
		return await foundryMemoryStore(deps).forget(resourceId, {
			erasing: true,
		});
	} catch (err) {
		if (hasStatus(err, 404)) return false;
		throw err;
	}
}

export function foundryMemoryStore({
	cache,
	keys,
}: MemoryDeps): FoundryMemoryStore {
	const store = () => projectClient().beta.memoryStores;
	const name = memoryStoreName();
	// A forget the request cannot finish is the sweeper's, which calls back `settle`; the same pass looks at the watched updates.
	const sweeper = purger(
		keys,
		(resourceId) => settle(resourceId, Number.POSITIVE_INFINITY),
		() => stalled(),
	);
	const followUp = (resourceId: string) =>
		sweeper.defer({ kind: "memory", resourceId });
	const pendingKey = (scope: string) =>
		keys.namespace.key("memory-pending", scope);
	const erasingKey = (scope: string) =>
		keys.namespace.key("memory-erasing", scope);
	// Every hand-over of the fleet, scored by when it must have settled; one key, so a sweep reads what is due in one call.
	const watchKey = keys.namespace.key("memory-watch");

	/** Redis, when there is one to ask; a configured one that does not answer throws. */
	async function redis() {
		if (!isRedisConfigured()) return null;
		const client = await getRedis();
		if (!client) throw new Error("Redis is configured and does not answer");
		return client;
	}

	/** A hand-over's update, kept until it must have settled. */
	async function track(scope: string, updateId: string, delayS: number) {
		const client = await redis();
		if (!client) return;
		const key = pendingKey(scope);
		const now = Date.now();
		const window = delayS + EXTRACTION_GRACE_S;
		await client.send("ZADD", [key, String(now + window * 1000), updateId]);
		await client.send("ZREMRANGEBYSCORE", [key, "-inf", String(now)]);
		await client.send("EXPIRE", [key, String(window)]);
		await client.send("ZADD", [
			watchKey,
			String(now + window * 1000),
			`${scope} ${updateId}`,
		]);
		// Outlives the window by the settle deadline, so a sweep that could not
		// look one up still can; then the backlog goes. Only ever extended: the
		// key holds every scope's updates, and a shorter window tracked after a
		// longer one must not let the longer one's entry go before it is due.
		const keep = window + SETTLE_DEADLINE_S;
		const ttl = Number(await client.send("TTL", [watchKey]));
		if (ttl < keep) await client.send("EXPIRE", [watchKey, String(keep)]);
	}

	/**
	 * The watched updates due by `now`, looked up and dropped: one the
	 * service has finished, superseded or forgotten passes; one still
	 * running or failed is reported, once, and dropped too — nothing here
	 * can finish it. One the service did not answer for stays for the next
	 * sweep. Bounded to `WATCH_BATCH` lookups a pass.
	 */
	async function stalled(now = Date.now()): Promise<number> {
		const client = await redis();
		if (!client) return 0;
		const due = (await client.send("ZRANGEBYSCORE", [
			watchKey,
			"-inf",
			String(now),
			"LIMIT",
			"0",
			String(WATCH_BATCH),
		])) as string[];
		let reported = 0;
		for (const entry of due) {
			const updateId = entry.slice(entry.indexOf(" ") + 1);
			let status: string;
			try {
				status = (await store().getUpdateResult(name, updateId)).status;
			} catch (err) {
				if (!hasStatus(err, 404)) continue;
				status = "completed";
			}
			if (status !== "completed" && status !== "superseded") {
				problems.report("agent.memory.extraction_stalled", {
					reason: status || "unknown",
				});
				console.error(
					`[memory] a hand-over's update is still ${status} past its delay and the extraction grace: nothing it carried is remembered`,
				);
				reported++;
			}
			await client.send("ZREM", [watchKey, entry]);
		}
		return reported;
	}

	/** The updates handed over for the scope that may not have settled yet. */
	async function pendingIds(scope: string): Promise<string[]> {
		const client = await redis();
		if (!client) return [];
		return (await client.send("ZRANGEBYSCORE", [
			pendingKey(scope),
			String(Date.now()),
			"+inf",
		])) as string[];
	}

	/**
	 * The updates, followed through what superseded them, that have not
	 * settled: queued, extracting, or not known to be either. The first
	 * `limit` are looked up; the rest are assumed pending.
	 */
	async function unsettled(ids: readonly string[], limit: number) {
		const open = new Set<string>();
		for (const [i, first] of ids.entries()) {
			if (i >= limit) {
				open.add(first);
				continue;
			}
			let id = first;
			for (let hop = 0; ; hop++) {
				if (hop >= SUPERSEDE_HOPS) {
					open.add(id);
					break;
				}
				let status: string;
				let next: string | undefined;
				try {
					const result = await store().getUpdateResult(name, id);
					status = result.status;
					next = result.superseded_by;
				} catch (err) {
					// An update the service no longer knows is long settled.
					if (hasStatus(err, 404)) break;
					open.add(id);
					break;
				}
				if (status === "superseded" && next) {
					id = next;
					continue;
				}
				if (status !== "completed" && status !== "failed") open.add(id);
				break;
			}
		}
		return [...open];
	}

	/** Whether a forget is still being finished: then nothing remembered is shown. */
	async function erasing(resourceId: string): Promise<boolean> {
		const client = await redis();
		if (!client) return false;
		return (
			((await client.send("EXISTS", [
				erasingKey(scopeOf(resourceId)),
			])) as number) > 0
		);
	}

	/**
	 * A forget finished when it can be: once every update it waits for has
	 * settled (or the deadline passed), the scope is deleted again and its
	 * reads shown. True when nothing is left waiting; `limit` bounds the
	 * lookups a read makes on its own path.
	 */
	async function settle(resourceId: string, limit: number): Promise<boolean> {
		const scope = scopeOf(resourceId);
		const client = await redis();
		if (!client) return true;
		const key = erasingKey(scope);
		const raw = (await client.send("GET", [key])) as string | null;
		if (!raw) return true;
		const waiting = JSON.parse(raw) as Erasing;
		const { memory } = await agentSettings();
		const deadline =
			waiting.erasedAt +
			(memory.updateDelaySeconds + EXTRACTION_GRACE_S + SETTLE_DEADLINE_S) *
				1000 -
			60_000;
		const overdue = Date.now() >= deadline;
		const open = overdue ? [] : await unsettled(waiting.updateIds, limit);
		if (open.length) {
			if (open.join() !== waiting.updateIds.join())
				await client.send("SET", [
					key,
					JSON.stringify({ ...waiting, updateIds: open }),
					"KEEPTTL",
				]);
			return false;
		}
		if (overdue) problems.report("agent.memory.erase_overdue", {});
		await store().deleteScope(name, scope);
		await cache.drop(resourceId);
		await client.send("ZREM", [pendingKey(scope), ...waiting.updateIds]);
		await client.send("DEL", [key]);
		return true;
	}

	/** A forget's updates still to settle, recorded for its reads and handed to the sweeper. */
	async function waitFor(resourceId: string, ids: readonly string[]) {
		const client = await redis();
		if (!client)
			throw new Error("a pending update cannot be waited for without Redis");
		const key = erasingKey(scopeOf(resourceId));
		const before = (await client.send("GET", [key])) as string | null;
		const waiting: Erasing = {
			updateIds: [
				...new Set([
					...(before ? (JSON.parse(before) as Erasing).updateIds : []),
					...ids,
				]),
			],
			erasedAt: Date.now(),
		};
		const { memory } = await agentSettings();
		const ttl =
			memory.updateDelaySeconds + EXTRACTION_GRACE_S + SETTLE_DEADLINE_S;
		await client.send("SET", [key, JSON.stringify(waiting), "EX", String(ttl)]);
		await followUp(resourceId);
	}

	/** While a forget is being finished nothing remembered is shown, unless it can be finished now. */
	async function hidden(resourceId: string): Promise<boolean> {
		return (
			(await erasing(resourceId)) &&
			!(await settle(resourceId, CHECKS_IN_REQUEST))
		);
	}

	async function kinds(): Promise<("user_profile" | "chat_summary")[]> {
		const { memory } = await agentSettings();
		return memory.foundry.chatSummary
			? ["user_profile", "chat_summary"]
			: ["user_profile"];
	}

	async function read(resourceId: string): Promise<PersonMemory> {
		if (await hidden(resourceId)) return { items: [] };
		const items: MemoryItem[] = [];
		for (const kind of await kinds()) {
			for await (const stored of store().listMemories(
				name,
				scopeOf(resourceId),
				{
					kind,
					order: "desc",
				},
			)) {
				items.push(itemOf(stored as StoredItem));
				if (items.length >= READ_MAX) break;
			}
			if (items.length >= READ_MAX) break;
		}
		items.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
		return { items };
	}

	/** The statement, when it is the resource's; null when it is someone else's or gone. */
	async function owned(resourceId: string, itemId: string) {
		try {
			const stored = (await store().getMemory(name, itemId)) as StoredItem;
			return stored.scope === scopeOf(resourceId) ? stored : null;
		} catch (err) {
			if (hasStatus(err, 404)) return null;
			throw err;
		}
	}

	return {
		kind: "foundry",
		purger: sweeper,
		read,

		statements: (resourceId) =>
			cachedStatements(cache, resourceId, async () =>
				(await hidden(resourceId))
					? []
					: (await read(resourceId)).items.map((i) => i.content),
			),

		async update(resourceId, itemId, content) {
			const text = await correction(this, resourceId, itemId, content, () =>
				owned(resourceId, itemId),
			);
			if (!text) return null;
			const updated = (await store().updateMemory(
				name,
				itemId,
				text,
			)) as StoredItem;
			await cache.drop(resourceId);
			return itemOf(updated);
		},

		async remove(resourceId, itemId) {
			if (!(await owned(resourceId, itemId))) return false;
			const gone = await deleted(() => store().deleteMemory(name, itemId));
			await cache.drop(resourceId);
			return gone;
		},

		async forget(resourceId) {
			const scope = scopeOf(resourceId);
			// While an earlier forget is being finished, nothing was there to the person.
			let had = false;
			if (!(await hidden(resourceId)))
				for await (const _ of store().listMemories(name, scope, {
					limit: 1,
				})) {
					had = true;
					break;
				}
			const pending = await pendingIds(scope);
			const open = await unsettled(pending, CHECKS_IN_REQUEST);
			// Recorded before the delete: a forget that fails after it is retried, never half-done.
			if (open.length) await waitFor(resourceId, open);
			await store().deleteScope(name, scope);
			await cache.drop(resourceId);
			// A turn that ended as the forget began hands over beside it: its words are older than the forget.
			const late = (await pendingIds(scope)).filter(
				(id) => !pending.includes(id),
			);
			if (late.length) await waitFor(resourceId, late);
			const settled = pending.filter((id) => !open.includes(id));
			if (settled.length)
				await (await redis())?.send("ZREM", [pendingKey(scope), ...settled]);
			return had;
		},

		settle: (resourceId) => settle(resourceId, Number.POSITIVE_INFINITY),
		stalled,

		// The thread is not needed: the words said are handed over as they are.
		async handOver(resourceId, _threadId, messages) {
			if (!messages.length) return;
			try {
				const { memory } = await agentSettings();
				let updateId: string | undefined;
				const update = store().updateMemories(name, scopeOf(resourceId), {
					items: messages.map((m) => ({
						type: "message",
						role: m.role,
						content: m.content,
					})),
					updateDelayInSecs: memory.updateDelaySeconds,
					onResponse: (raw) => {
						updateId ??= updateIdOf(raw);
					},
				});
				// Handed over, not waited for: the store extracts after its own delay.
				await update.submitted();
				try {
					if (!updateId) throw new Error("the store named no update id");
					await track(scopeOf(resourceId), updateId, memory.updateDelaySeconds);
				} catch (err) {
					// A forget in the next minutes cannot wait for this update: said, for an operator to see.
					problems.report("agent.memory.update_untracked", {});
					console.error(
						"[memory] a hand-over's update could not be kept for a forget to wait for:",
						(err as Error).message,
					);
				}
			} catch (err) {
				problems.report("agent.memory.handover_failed", {});
				console.error(
					"[memory] a turn was not handed to the memory store:",
					(err as Error).message,
				);
			}
		},

		// The extraction is the service's: nothing of it waits in this process.
		async flush() {},
		start: () => sweeper.start(),
		stop: () => sweeper.stop(),
	};
}

/**
 * The store, made where it is missing, by the job's `agent` step: what it
 * extracts is the product's, how long it keeps it the operator's. An
 * existing store is left as it is — the service fixes a store's models and
 * options when it is made — and the line says so.
 */
export async function ensureMemoryStore(
	product: AgentProduct,
	deployments: { chat: string; embedding: string },
): Promise<"created" | "exists"> {
	const stores = projectClient().beta.memoryStores;
	const name = memoryStoreName();
	try {
		await stores.get(name);
		return "exists";
	} catch (err) {
		if (!hasStatus(err, 404)) throw err;
	}
	const { memory } = await agentSettings();
	await stores.create(name, {
		kind: "default",
		chat_model: deployments.chat,
		embedding_model: deployments.embedding,
		options: {
			user_profile_enabled: true,
			user_profile_details: memoryDetailsOf(product),
			chat_summary_enabled: memory.foundry.chatSummary,
			procedural_memory_enabled: memory.foundry.procedural,
			...(memory.foundry.ttlSeconds > 0
				? { default_ttl_seconds: memory.foundry.ttlSeconds }
				: {}),
		},
	});
	return "created";
}
