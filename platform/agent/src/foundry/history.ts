import { reportFailure } from "@platform/config";
import {
	BATCH_MAX_BYTES,
	BATCH_MAX_OPERATIONS,
	type ContainerDefinition,
	type CosmosDocument,
	cosmosDatabase,
	hasStatus,
} from "@platform/cosmos";
import type {
	HistoryStore,
	HistoryThread,
	HistoryWrite,
	PreparedTurn,
	TurnShape,
} from "../history/interface";
import type { AgentSettings } from "../settings";
import { markBlocked, touchThread } from "./threads";
import {
	asInput,
	isShown,
	keptItems,
	notAnswered,
	OPEN_CALL_WINDOW,
	openCalls,
	type StoredItem,
	threadMessages,
} from "./turn/input";

/**
 * A thread's history, in this deployment's own database: every message, tool
 * call and output of a conversation, typed or spoken, one document each in
 * the owner's partition, in the order they were written. The model is given
 * it on every turn, which runs with `store: false`, so the Agent Service
 * keeps nothing of a conversation.
 *
 * Why here and not in the service's conversations: the service writes a
 * conversation's items to the deployment's Cosmos DB account
 * (`enterprise_memory/<workspace>-run-state-v1`) and its deletes do not
 * erase them — the items, a picture's base64 among them, outlive the delete
 * of each item and of the conversation.
 * Kept here, a thread's delete and an account's erasure reach every word.
 *
 * A picture is never written: the person's message keeps the marker in its
 * place, and the picture itself is input to that one turn only.
 */

const MESSAGES: ContainerDefinition = {
	name: "messages",
	partitionKey: "/resourceId",
};

/** The container the history lives in, for an app's start to verify and the template to create. */
export const historyContainer = MESSAGES;

export interface HistoryDocument extends CosmosDocument {
	resourceId: string;
	threadId: string;
	/** Its place in the thread: when it was written, in microseconds, and its index within the write. */
	seq: number;
	/** When it was said: a spoken line keeps its own time. */
	at: string;
	item: StoredItem;
}

const messages = () => cosmosDatabase().container(MESSAGES.name);

/** What one operation adds to a batch's payload around its document, generously. */
const OPERATION_BYTES = 512;
/** A part's bytes, kept under the service's bound with room for the batch's own envelope. */
const BATCH_BYTES = BATCH_MAX_BYTES - 64 * 1024;

/**
 * One item of a turn that the store cannot hold at any size of batch: the
 * service's bound on a document. No retry can keep it, so it is named.
 */
export class HistoryItemTooLarge extends Error {
	constructor(
		readonly kind: string,
		readonly bytes: number,
	) {
		super(
			`a ${kind} of ${bytes} bytes is larger than the history can hold (${BATCH_BYTES} bytes)`,
		);
		this.name = "HistoryItemTooLarge";
	}
}

/**
 * Write items at the end of a thread's history, in order. One document
 * each, ids made from the write's time, so a page of them reads back in
 * the order they were said. All of them or none: one transactional batch
 * in the person's partition, so a write that fails part way leaves no
 * exchange cut short — and no reasoning item without what it led to. Past
 * the service's bounds on a batch, its operations and its bytes, the writes
 * go in several, and one that fails takes itself and the earlier ones out
 * again. An item no batch can hold is `HistoryItemTooLarge`. A write whose
 * ids another write on the thread took in the same millisecond is asked
 * again under later ones, and leaves that write's documents alone.
 */
export async function appendHistory(
	resourceId: string,
	threadId: string,
	writes: readonly HistoryWrite[],
): Promise<StoredItem[]> {
	const now = new Date();
	let base = now.getTime() * 1000;
	for (let attempt = 0; ; attempt++) {
		const documents = writes.map((write, index): HistoryDocument => {
			const seq = base + index;
			const id = `${threadId}.${seq}`;
			const { id: serviceId, ...rest } = write.item;
			return {
				id,
				resourceId,
				threadId,
				seq,
				at: write.at ?? now.toISOString(),
				item: { ...rest, ...(serviceId ? { service_id: serviceId } : {}), id },
			};
		});
		const taken = await writeWhole(resourceId, documents);
		if (!taken) return documents.map((document) => document.item);
		if (attempt === ID_TRIES - 1) throw taken;
		// Asked again under a later time, past every id the first asking named.
		base = Math.max(Date.now() * 1000, base + SEQ_STEP);
	}
}

/** How often a write whose ids were taken is asked again under later ones. */
const ID_TRIES = 3;
/** One millisecond of the sequence: room for a write's own items. */
const SEQ_STEP = 1000;

/**
 * The documents written whole, or none of them: null when they were, the
 * conflict when an id was already taken, and anything else thrown.
 *
 * An id is the thread's and the write's time, so two writes on one thread
 * in the same millisecond name the same ids, and the later is refused with
 * a conflict. The documents under those ids are the earlier write's: the
 * part that was refused is never taken out, only the parts of this write
 * that went in before it.
 */
async function writeWhole(
	resourceId: string,
	documents: readonly HistoryDocument[],
): Promise<Error | null> {
	// Each part within both of the service's bounds on a batch: its count and its bytes.
	const parts: HistoryDocument[][] = [];
	let size = 0;
	for (const document of documents) {
		const bytes = Buffer.byteLength(JSON.stringify(document)) + OPERATION_BYTES;
		if (bytes > BATCH_BYTES)
			throw new HistoryItemTooLarge(document.item.type ?? "item", bytes);
		const last = parts.at(-1);
		if (
			!last ||
			last.length === BATCH_MAX_OPERATIONS ||
			size + bytes > BATCH_BYTES
		) {
			parts.push([document]);
			size = bytes;
		} else {
			last.push(document);
			size += bytes;
		}
	}
	const written: HistoryDocument[] = [];
	for (const part of parts) {
		try {
			await messages().batch(
				resourceId,
				part.map((document) => ({ type: "create" as const, document })),
			);
			written.push(...part);
		} catch (err) {
			const conflict = hasStatus(err, 409);
			// A batch the service took and the client lost the answer of is taken
			// out too; one refused for an id already there wrote nothing, and what
			// is under its ids is another write's.
			for (const document of conflict ? written : [...written, ...part])
				await messages()
					.delete(document.id, resourceId)
					.catch((left: Error) =>
						console.error(
							"[agent] a message of a write that failed is left behind:",
							left.message,
						),
					);
			if (conflict) return err as Error;
			throw err;
		}
	}
	return null;
}

/** A thread's documents, newest first, older than `beforeSeq` when it is given. */
export function historyNewestFirst(
	resourceId: string,
	threadId: string,
	options: { beforeSeq?: number; limit: number },
): Promise<HistoryDocument[]> {
	const before = options.beforeSeq !== undefined;
	return messages().query<HistoryDocument>(
		{
			query: `SELECT * FROM c WHERE c.threadId = @threadId ${before ? "AND c.seq < @before" : ""} ORDER BY c.seq DESC OFFSET 0 LIMIT @limit`,
			parameters: [
				{ name: "@threadId", value: threadId },
				{ name: "@limit", value: options.limit },
				...(before ? [{ name: "@before", value: options.beforeSeq ?? 0 }] : []),
			],
		},
		resourceId,
	);
}

/**
 * What a turn is given of the thread, oldest first, from its items newest
 * first: the newest within the `agent` document's bound — at most `maxItems`, at most `maxChars` of
 * them as JSON — starting at a message of the person's, so no output is
 * given without its call. The latest exchange's reasoning is kept, for a
 * turn that continues it (the browser's answers to its calls); an older
 * one's is not, as the model does not need it. Never empty when the thread
 * holds a message of the person's: the latest one is given whatever its
 * size.
 */
export function boundHistory(
	newest: readonly StoredItem[],
	bound: Pick<AgentSettings["history"], "maxItems" | "maxChars">,
): StoredItem[] {
	const kept: StoredItem[] = [];
	let chars = 0;
	let reachedPerson = false;
	let lastPerson = -1;
	for (const item of newest.slice(0, bound.maxItems)) {
		const isPerson = item.type === "message" && item.role === "user";
		// An older exchange's reasoning is not needed; one with no id of the service's cannot be given back.
		if (item.type === "reasoning" && (reachedPerson || !item.service_id))
			continue;
		const size = JSON.stringify(item).length;
		if (chars + size > bound.maxChars && lastPerson >= 0) break;
		chars += size;
		kept.push(item);
		if (isPerson) {
			reachedPerson = true;
			lastPerson = kept.length - 1;
		}
	}
	if (lastPerson < 0) return [];
	// Back to the oldest message of the person's kept: nothing older starts mid-exchange.
	let start = kept.length - 1;
	while (start > 0) {
		const item = kept[start] as StoredItem;
		if (item.type === "message" && item.role === "user") break;
		start--;
	}
	return kept.slice(0, start + 1).reverse();
}

/** Every document of a thread, deleted; one already gone is done. */
async function deleteHistory(
	resourceId: string,
	threadId: string,
): Promise<number> {
	const documents = await messages().query<HistoryDocument>(
		{
			query: "SELECT * FROM c WHERE c.threadId = @threadId",
			parameters: [{ name: "@threadId", value: threadId }],
		},
		resourceId,
	);
	let deleted = 0;
	for (const document of documents)
		if (await messages().delete(document.id, resourceId)) deleted++;
	return deleted;
}

/** Every document the container holds under a resource, deleted: an erase's sweep, for what no thread's index entry leads to. */
export async function removeHistoryOf(resourceId: string): Promise<number> {
	const documents = await messages().query<Pick<HistoryDocument, "id">>(
		{ query: "SELECT * FROM c" },
		resourceId,
	);
	let deleted = 0;
	for (const document of documents)
		if (await messages().delete(document.id, resourceId)) deleted++;
	return deleted;
}

/** Every response of a turn on the own store: nothing kept by the service, and the reasoning handed back to give again. */
const STATELESS: TurnShape = {
	fields: { store: false, include: ["reasoning.encrypted_content"] },
	// Each step is given everything: the history and this turn's input, then what the turn has written.
	next: (first, written) => [...first, ...written],
	// What the turn wrote is kept when it settles, the outputs among it.
	hold: async () => {},
};

/** The thread's newest items, newest first; with `after`, only those said later than it. */
async function newestItems(
	thread: HistoryThread,
	limit: number,
	after?: string,
): Promise<StoredItem[]> {
	return (await historyNewestFirst(thread.resourceId, thread.id, { limit }))
		.filter((document) => !after || document.at > after)
		.map((document) => document.item);
}

/**
 * The thread's history in this deployment's own `messages` container: what
 * a thread made while `history.store` is `own` (the default) keeps, and
 * every thread made before the setting existed.
 */
export function ownHistoryStore(): HistoryStore {
	return {
		kind: "own",
		begin: async () => ({ store: "own" }),
		discard: async () => {},
		newestFirst: newestItems,

		async prepare(thread, turn, bound): Promise<PreparedTurn> {
			const history = boundHistory(
				await newestItems(thread, bound.maxItems),
				bound,
			).map(asInput);
			if ("answers" in turn)
				return {
					input: [...history, ...turn.answers],
					keep: turn.answers.map((item) => ({ item })),
					shape: STATELESS,
					pictures: false,
				};
			// Read after the history: the closing outputs answer calls it holds.
			const closing = notAnswered(
				openCalls(await newestItems(thread, OPEN_CALL_WINDOW)),
			);
			const kept = keptItems(turn.said);
			return {
				input: [...history, ...closing, ...turn.said],
				keep: [...closing, ...kept].map((item) => ({ item })),
				shape: STATELESS,
				pictures: kept.length < turn.said.length,
			};
		},

		/**
		 * What the turn said and what it wrote kept, in order, and the thread
		 * moved. A run that wrote nothing — the first response failed — keeps
		 * nothing, as the service kept no input of a response that never
		 * completed: the person's words go again with their next send. A run
		 * the content filter ended after it wrote — the refusal streams before
		 * the filter's verdict — keeps the exchange, its messages marked
		 * blocked for memory to leave out.
		 */
		async settle(thread, prepared, run) {
			if (run.kind === "failed" && run.written.length === 0) return;
			const kept = await appendHistory(thread.resourceId, thread.id, [
				...prepared.keep,
				...run.written.map((item) => ({ item: { ...item } })),
			]);
			// The exchange is kept. What follows is bookkeeping: a failure of it
			// is said, never thrown, or the turn would be told it failed and the
			// person's retry would write the exchange a second time.
			try {
				if (run.blocked)
					await markBlocked(
						thread.resourceId,
						thread.id,
						kept
							.filter((item) => item.type === "message")
							.map((item) => item.id),
					);
				await touchThread(thread.resourceId, thread.id);
			} catch (err) {
				reportFailure(
					"agent",
					"a kept turn's thread was not brought up to date",
					err,
				);
			}
		},

		async append(thread, writes) {
			if (!writes.length) return;
			const kept = await appendHistory(thread.resourceId, thread.id, writes);
			await markBlocked(
				thread.resourceId,
				thread.id,
				kept.flatMap((item, i) => (writes[i]?.blocked ? [item.id] : [])),
			);
		},

		async page(thread, request) {
			// A cursor is a `seq` this store handed out: anything else is no cursor, and the newest page.
			const before = request.before ? Number(request.before) : Number.NaN;
			const documents = await historyNewestFirst(thread.resourceId, thread.id, {
				beforeSeq: Number.isSafeInteger(before) ? before : undefined,
				limit: request.maxItems,
			});
			// Newest first, up to the page's messages: what is left is the next page's.
			const taken: typeof documents = [];
			let shown = 0;
			for (const document of documents) {
				if (shown >= request.messages) break;
				taken.push(document);
				if (isShown(document.item)) shown++;
			}
			const more =
				taken.length < documents.length || documents.length >= request.maxItems;
			const oldest = taken.at(-1);
			return {
				messages: threadMessages(taken.reverse()),
				earlier: more && oldest ? String(oldest.seq) : null,
			};
		},

		async remove(thread) {
			await deleteHistory(thread.resourceId, thread.id);
		},
	};
}
