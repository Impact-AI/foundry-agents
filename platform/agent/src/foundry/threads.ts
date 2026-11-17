import {
	type ContainerDefinition,
	type CosmosDocument,
	cosmosDatabase,
	hasStatus,
	type Stored,
} from "@platform/cosmos";
import {
	THREAD_PAGE_MAX,
	type ThreadPageRequest,
	type ThreadSummary,
} from "../contract/host";
import type { ConversationRecord, ThreadHistory } from "../history/interface";
import type { ConversationStamp } from "../person/caches";
import type { ItemTime } from "./turn/input";

/**
 * The thread index, on Cosmos DB: who a conversation belongs to, what it is
 * called, when it moved, and where its messages are — the history beside
 * it in the same database (`history.ts`), or, for a thread made while
 * `history.store` named it, a conversation of the service's
 * (`conversations.ts`).
 *
 *   threads    one document per thread in its owner's partition, listed
 *              newest first by the host's own keyset over (updatedAt, id)
 *   threadIds  the global claim on a client-minted id: a partition-local
 *              uniqueness rule cannot stop two people minting the same one
 */

const THREADS: ContainerDefinition = {
	name: "threads",
	partitionKey: "/resourceId",
	compositeIndexes: [
		[
			{ path: "/updatedAt", order: "descending" },
			{ path: "/id", order: "descending" },
		],
	],
};

const THREAD_IDS: ContainerDefinition = {
	name: "threadIds",
	partitionKey: "/id",
};

/** The thread index's own containers; `containers.ts` lists them with the history's. */
export const indexContainers: readonly ContainerDefinition[] = [
	THREADS,
	THREAD_IDS,
];

/** The most entries either list of a conversation's record keeps; the oldest go first. */
export const LIST_MAX = 1_000;

export interface ThreadDocument extends CosmosDocument, ThreadHistory {
	resourceId: string;
	title: string;
	createdAt: string;
	updatedAt: string;
}

const threads = () => cosmosDatabase().container(THREADS.name);
const claims = () => cosmosDatabase().container(THREAD_IDS.name);

/** Whose thread an id names, from its claim: one point read. */
export async function threadOwner(threadId: string): Promise<string | null> {
	const claim = await claims().read<CosmosDocument & { resourceId: string }>(
		threadId,
		threadId,
	);
	return claim?.resourceId ?? null;
}

/**
 * Claim an id for `resourceId`: true when it is theirs now, whether this
 * call or an earlier one made the claim; false when somebody else holds it.
 */
export async function claimThread(
	threadId: string,
	resourceId: string,
): Promise<boolean> {
	try {
		await claims().create({ id: threadId, resourceId });
		return true;
	} catch (err) {
		if (!hasStatus(err, 409)) throw err;
		return (await threadOwner(threadId)) === resourceId;
	}
}

/** Give up `resourceId`'s claim on an id: nothing when the claim is somebody else's, or gone. */
export async function releaseClaim(
	threadId: string,
	resourceId: string,
): Promise<void> {
	if ((await threadOwner(threadId)) === resourceId)
		await claims().delete(threadId, threadId);
}

export function readThreadDocument(
	resourceId: string,
	threadId: string,
): Promise<Stored<ThreadDocument> | null> {
	return threads().read<ThreadDocument>(threadId, resourceId);
}

export async function createThreadDocument(input: {
	resourceId: string;
	threadId: string;
	title: string;
	history: ThreadHistory;
}): Promise<ThreadDocument> {
	const now = new Date().toISOString();
	const document: ThreadDocument = {
		id: input.threadId,
		resourceId: input.resourceId,
		title: input.title,
		createdAt: now,
		updatedAt: now,
		...input.history,
	};
	await threads().create(document);
	return document;
}

/** False when there is no such thread under the resource. */
export async function setThreadTitle(
	resourceId: string,
	threadId: string,
	title: string,
): Promise<boolean> {
	const patched = await threads().patch(threadId, resourceId, [
		{ op: "set", path: "/title", value: title },
	]);
	return patched !== null;
}

/**
 * The thread named, while it has no name: read and written on the
 * document's etag, so a name another writer gave it in between — the
 * person's rename, another replica's title — stands. False when it had one
 * by then, or is gone.
 */
export async function nameUntitledThread(
	resourceId: string,
	threadId: string,
	title: string,
): Promise<boolean> {
	for (let attempt = 0; ; attempt++) {
		const current = await readThreadDocument(resourceId, threadId);
		if (!current || current.title) return false;
		try {
			const patched = await threads().patch(
				threadId,
				resourceId,
				[{ op: "set", path: "/title", value: title }],
				{ ifMatch: current._etag },
			);
			return patched !== null;
		} catch (err) {
			if (!hasStatus(err, 412) || attempt >= 4) throw err;
		}
	}
}

/** The most blocked messages a thread's document names; the oldest go first, long past what memory reads. */
const BLOCKED_MAX = 100;

/** Messages of a turn the content filter blocked, named on the thread's document: memory leaves them out. */
export async function markBlocked(
	resourceId: string,
	threadId: string,
	itemIds: readonly string[],
): Promise<void> {
	if (!itemIds.length) return;
	// On the document's etag, so two writers never lose each other's entries.
	for (let attempt = 0; ; attempt++) {
		const current = await readThreadDocument(resourceId, threadId);
		if (!current) return;
		const blocked = [...(current.blocked ?? []), ...itemIds].slice(
			-BLOCKED_MAX,
		);
		try {
			await threads().patch(
				threadId,
				resourceId,
				[{ op: "set", path: "/blocked", value: blocked }],
				{ ifMatch: current._etag },
			);
			return;
		} catch (err) {
			if (!hasStatus(err, 412) || attempt >= 4) throw err;
		}
	}
}

/** The thread moved: it is the newest now. */
export async function touchThread(
	resourceId: string,
	threadId: string,
): Promise<void> {
	await threads().patch(threadId, resourceId, [
		{ op: "set", path: "/updatedAt", value: new Date().toISOString() },
	]);
}

/**
 * A change to the record of a thread's conversation, read and written on
 * the document's etag, so two writers never lose each other's entries.
 * `change` is given the record as it stands and answers it as it should
 * be; it may be called more than once. Null when there is no such thread
 * or it is on no conversation.
 */
async function changeConversation(
	resourceId: string,
	threadId: string,
	change: (current: ConversationRecord) => ConversationRecord,
	touch = false,
): Promise<{ before: ConversationRecord; after: ConversationRecord } | null> {
	for (let attempt = 0; ; attempt++) {
		const current = await readThreadDocument(resourceId, threadId);
		if (!current?.conversation) return null;
		const after = change(current.conversation);
		try {
			await threads().patch(
				threadId,
				resourceId,
				[
					{ op: "set", path: "/conversation", value: after },
					...(touch
						? [
								{
									op: "set" as const,
									path: "/updatedAt",
									value: new Date().toISOString(),
								},
							]
						: []),
				],
				{ ifMatch: current._etag },
			);
			return { before: current.conversation, after };
		} catch (err) {
			if (!hasStatus(err, 412) || attempt >= 4) throw err;
		}
	}
}

/**
 * The times of the messages just written and the responses that wrote
 * them, added to the record of the thread's conversation, and the thread
 * moved when `touch` says so. A message stamped twice keeps its first time.
 * Answers the response ids the list had no more room for, oldest first: no
 * delete of the thread will reach them now, so the caller deletes them.
 */
export async function recordConversation(
	resourceId: string,
	threadId: string,
	written: { times?: readonly ItemTime[]; responseIds?: readonly string[] },
	touch = false,
): Promise<string[]> {
	let overflow: string[] = [];
	await changeConversation(
		resourceId,
		threadId,
		(current) => {
			const stamped = new Set(current.itemTimes.map((t) => t.id));
			const times = [
				...current.itemTimes,
				...(written.times ?? []).filter((t) => !stamped.has(t.id)),
			];
			const responses = [
				...current.responseIds,
				...(written.responseIds ?? []),
			];
			overflow = responses.slice(0, -LIST_MAX);
			return {
				...current,
				itemTimes: times.slice(-LIST_MAX),
				responseIds: responses.slice(-LIST_MAX),
			};
		},
		touch,
	);
	return overflow;
}

/**
 * The thread moved onto `fresh`, a conversation made because `expired` is
 * gone: the expired one kept among the former, for a delete to reach, and
 * its responses kept for the same reason. Answers the conversation the
 * thread is on now — another writer's, when one renewed it first.
 */
export async function renewConversation(
	resourceId: string,
	threadId: string,
	expired: string,
	fresh: string,
): Promise<string | null> {
	const changed = await changeConversation(resourceId, threadId, (current) =>
		current.id !== expired
			? current
			: {
					id: fresh,
					itemTimes: [],
					responseIds: current.responseIds,
					former: [...current.former, expired],
				},
	);
	return changed?.after.id ?? null;
}

/**
 * The thread's claim, then its document; either already gone is done. In
 * that order because only the document is listed: a claim left behind by a
 * failure would name the person where no erase looks, while a document left
 * behind is found and finished by the next delete.
 */
export async function removeThreadDocuments(
	resourceId: string,
	threadId: string,
): Promise<void> {
	await releaseClaim(threadId, resourceId);
	await threads().delete(threadId, resourceId);
}

export function summaryOf(document: ThreadDocument): ThreadSummary {
	return {
		id: document.id,
		title: document.title,
		createdAt: document.createdAt,
		updatedAt: document.updatedAt,
	};
}

interface Cursor {
	updatedAt: string;
	id: string;
	limit: number;
}

/** The cursor is the host's own, not the service's continuation token: where the page ends, and its size. */
function encodeCursor(cursor: Cursor): string {
	return Buffer.from(JSON.stringify(cursor)).toString("base64url");
}

function decodeCursor(text: string): Cursor {
	let parsed: unknown;
	try {
		parsed = JSON.parse(Buffer.from(text, "base64url").toString("utf8"));
	} catch {
		parsed = null;
	}
	const { updatedAt, id, limit } = (parsed ?? {}) as Partial<Cursor>;
	if (
		typeof updatedAt !== "string" ||
		typeof id !== "string" ||
		!Number.isSafeInteger(limit) ||
		(limit as number) < 1 ||
		(limit as number) > THREAD_PAGE_MAX
	)
		throw new RangeError("not a thread cursor");
	return { updatedAt, id, limit: limit as number };
}

function limitOf(limit: number | undefined): number {
	const n = Math.trunc(limit ?? THREAD_PAGE_MAX);
	return Number.isFinite(n)
		? Math.min(Math.max(n, 1), THREAD_PAGE_MAX)
		: THREAD_PAGE_MAX;
}

const NEWEST_FIRST = "ORDER BY c.updatedAt DESC, c.id DESC";

/** One page of the resource's threads, newest first: one single-partition query. */
export async function listThreadDocuments(
	resourceId: string,
	request: ThreadPageRequest = {},
): Promise<{ documents: ThreadDocument[]; next: string | null }> {
	const after =
		request.cursor === undefined ? null : decodeCursor(request.cursor);
	const limit = after?.limit ?? limitOf(request.limit);
	const keyset = after
		? "AND (c.updatedAt < @updatedAt OR (c.updatedAt = @updatedAt AND c.id < @id))"
		: "";
	const rows = await threads().query<ThreadDocument>(
		{
			query: `SELECT * FROM c WHERE c.resourceId = @resourceId ${keyset} ${NEWEST_FIRST} OFFSET 0 LIMIT @limit`,
			parameters: [
				{ name: "@resourceId", value: resourceId },
				{ name: "@limit", value: limit + 1 },
				...(after
					? [
							{ name: "@updatedAt", value: after.updatedAt },
							{ name: "@id", value: after.id },
						]
					: []),
			],
		},
		resourceId,
	);
	const documents = rows.slice(0, limit);
	const last = documents.at(-1);
	return {
		documents,
		next:
			rows.length > limit && last
				? encodeCursor({ updatedAt: last.updatedAt, id: last.id, limit })
				: null,
	};
}

/** The resource's newest `count` threads, as the stamps the last-conversation read caches. */
export async function recentStamps(
	resourceId: string,
	count: number,
): Promise<ConversationStamp[]> {
	const { documents } = await listThreadDocuments(resourceId, { limit: count });
	return documents.map((d) => ({ id: d.id, at: d.updatedAt }));
}
