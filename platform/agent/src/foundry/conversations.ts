import { reportFailure } from "@platform/config";
import type {
	HistoryStore,
	HistoryThread,
	HistoryWrite,
	PreparedTurn,
	TurnShape,
} from "../history/interface";
import { problems } from "../keys";
import { deleted, hasStatus, openaiClient } from "./client";
import {
	LIST_MAX,
	markBlocked,
	readThreadDocument,
	recordConversation,
	renewConversation,
} from "./threads";
import {
	datedItems,
	type InputItem,
	type ItemTime,
	isPictureItem,
	isShown,
	notAnswered,
	OPEN_CALL_WINDOW,
	openCalls,
	type StoredItem,
	threadMessages,
} from "./turn/input";

/**
 * A thread's messages where the service keeps them, for a thread made
 * while `history.store` is `foundry`: one conversation per thread, each
 * response stored in it (`store: true`) and given only what is new, the
 * context truncated by the service. The narrow calls the host makes on it
 * are below, each in the service's own terms, then the store that answers
 * the host's history interface with them.
 *
 * What the service does not keep, the thread document does
 * (`ConversationRecord`): when each shown message was written, since an
 * item carries no time; every response stored, for a delete to reach; and
 * every conversation the thread had before one expired.
 *
 * What it cannot do, a general note in `docs/limitations.md`: an API delete
 * removes an item from the conversation, not from the run state the
 * service keeps it in, and a conversation expires sixty days after it was
 * made, whatever its activity — a turn after that renews it, and the
 * earlier messages are gone.
 */

/** The service takes at most this many items per call. */
const APPEND_MAX = 20;
/** The service lists at most this many items per page. */
const PAGE_MAX = 100;

type ItemsParam = Parameters<
	ReturnType<typeof openaiClient>["conversations"]["items"]["create"]
>[1]["items"];

async function createConversation(threadId: string): Promise<string> {
	const conversation = await openaiClient().conversations.create({
		metadata: { thread: threadId },
	});
	return conversation.id;
}

/** Items added at the end of the conversation, in order, in twenties: the items the service made of them. */
async function appendItems(
	conversationId: string,
	items: readonly InputItem[],
): Promise<StoredItem[]> {
	const made: StoredItem[] = [];
	for (let at = 0; at < items.length; at += APPEND_MAX) {
		const page = await openaiClient().conversations.items.create(
			conversationId,
			{ items: items.slice(at, at + APPEND_MAX) as unknown as ItemsParam },
		);
		made.push(...(page.data as unknown as StoredItem[]));
	}
	return made;
}

/**
 * The conversation's items newest first, from the one just older than
 * `after` when it is given, a page of `pageSize` fetched as the reader
 * reaches it: `after` is the only cursor the service takes, and in this
 * order it walks back in time.
 */
function itemsNewestFirst(
	conversationId: string,
	options: { after?: string; pageSize: number },
): AsyncIterable<StoredItem> {
	return openaiClient().conversations.items.list(conversationId, {
		order: "desc",
		limit: Math.min(options.pageSize, PAGE_MAX),
		...(options.after ? { after: options.after } : {}),
	}) as unknown as AsyncIterable<StoredItem>;
}

/** The conversation's newest `limit` items, newest first. */
async function newestItems(
	conversationId: string,
	limit: number,
): Promise<StoredItem[]> {
	const items: StoredItem[] = [];
	if (limit < 1) return items;
	for await (const item of itemsNewestFirst(conversationId, {
		pageSize: limit,
	})) {
		items.push(item);
		if (items.length >= limit) break;
	}
	return items;
}

/**
 * The messages a thread shows that were written since the newest one
 * `stamped` holds, oldest first, each stamped `at`: what a turn's responses
 * added, and whatever a write that failed before its own stamp left. Read
 * newest first back to the first message already stamped. Never throws: a
 * read that fails stamps nothing, so the turn's responses are still
 * recorded for a delete, and the next stamp reaches back over what this
 * one missed.
 */
async function stampWritten(
	conversationId: string,
	stamped: readonly ItemTime[],
	at: string,
): Promise<ItemTime[]> {
	const known = new Set(stamped.map((t) => t.id));
	const written: ItemTime[] = [];
	try {
		for await (const item of itemsNewestFirst(conversationId, {
			pageSize: OPEN_CALL_WINDOW,
		})) {
			if (!isShown(item)) continue;
			if (known.has(item.id) || written.length >= LIST_MAX) break;
			written.push({ id: item.id, at });
		}
	} catch (err) {
		console.error(
			"[agent] the messages just written went unstamped:",
			(err as Error).message,
		);
		return [];
	}
	return written.reverse();
}

/**
 * The pictures the person's latest message carried: the picture items just
 * before it. Read newest first past whatever the turn's responses wrote
 * after it, and no further than the pictures.
 */
async function latestPictures(conversationId: string): Promise<StoredItem[]> {
	const pictures: StoredItem[] = [];
	let reached = false;
	for await (const item of itemsNewestFirst(conversationId, {
		pageSize: PAGE_MAX,
	})) {
		if (!reached) {
			reached =
				item.type === "message" && item.role === "user" && !isPictureItem(item);
			continue;
		}
		if (!isPictureItem(item)) break;
		pictures.push(item);
	}
	return pictures;
}

function deleteItem(conversationId: string, itemId: string): Promise<boolean> {
	return deleted(() =>
		openaiClient().conversations.items.delete(itemId, {
			conversation_id: conversationId,
		}),
	);
}

/**
 * A conversation and every item in it, each deleted through the API: the
 * conversation's delete alone leaves its items. One already gone is done,
 * so a delete that failed part way is finished by the next.
 */
async function discardConversation(conversationId: string): Promise<void> {
	const items: StoredItem[] = [];
	try {
		// Every id first: a delete inside the walk would move the page the cursor stands on.
		for await (const item of itemsNewestFirst(conversationId, {
			pageSize: PAGE_MAX,
		}))
			items.push(item);
	} catch (err) {
		if (!hasStatus(err, 404)) throw err;
	}
	for (const item of items) await deleteItem(conversationId, item.id);
	await deleted(() => openaiClient().conversations.delete(conversationId));
}

function deleteResponse(responseId: string): Promise<boolean> {
	return deleted(() => openaiClient().responses.delete(responseId));
}

/** Writes as the items the service takes. */
function itemsOf(writes: readonly HistoryWrite[]): InputItem[] {
	return writes.map((write) => write.item as unknown as InputItem);
}

/** Every response of a turn in the thread's conversation: kept there, and given only what is new. */
function conversationShape(conversationId: string): TurnShape {
	return {
		fields: { store: true, conversation: conversationId },
		// The conversation holds the history and what the turn wrote: each step is given only the last one's outputs.
		next: (_first, _written, outputs) => [...outputs],
		// Outputs a run ends with go into the conversation before `finish`: the browser continues the moment the run ends.
		async hold(outputs) {
			if (outputs.length) await appendItems(conversationId, outputs);
		},
	};
}

/** The conversation the thread's document names: one it does not is a fault, not a thread on the own store. */
function conversationOf(thread: HistoryThread) {
	if (!thread.conversation)
		throw new Error(`the thread ${thread.id} names no conversation`);
	return thread.conversation;
}

/**
 * The thread on a new conversation, its old one gone past its time to
 * live: reported, and the old one kept among the former for a delete to
 * reach. Answers the conversation the thread is on now.
 */
async function renew(thread: HistoryThread, expired: string): Promise<string> {
	problems.report("agent.history.conversation_expired", {});
	console.warn(
		"[agent] a thread's conversation has expired; the thread goes on in a new one, without its earlier messages",
	);
	const fresh = await createConversation(thread.id);
	const now = await renewConversation(
		thread.resourceId,
		thread.id,
		expired,
		fresh,
	);
	if (now !== fresh)
		await discardConversation(fresh).catch((err: Error) =>
			console.error(
				"[agent] a conversation made to renew a thread is left behind:",
				err.message,
			),
		);
	if (!now) throw new Error(`the thread ${thread.id} is gone`);
	return now;
}

/**
 * The picture items of the turn's message and the response they were
 * input to, deleted from the conversation: best effort, since what the
 * service kept of them cannot be taken back here, and a failure is
 * reported rather than failing a turn that has already answered.
 */
async function purgePictures(conversationId: string, responseId?: string) {
	try {
		for (const item of await latestPictures(conversationId))
			await deleteItem(conversationId, item.id);
		if (responseId) await deleteResponse(responseId);
	} catch (err) {
		problems.report("agent.history.picture_kept", {});
		console.error(
			"[agent] a picture of a turn could not be deleted from its conversation:",
			(err as Error).message,
		);
	}
}

/** One page of a thread from its items read newest first, oldest first, and the item the next page is read from. */
async function threadPage(
	newestFirst: AsyncIterable<StoredItem>,
	bound: { messages: number; items: number },
): Promise<{ items: StoredItem[]; earlier: string | null }> {
	const taken: StoredItem[] = [];
	let shown = 0;
	let more = false;
	for await (const item of newestFirst) {
		if (shown >= bound.messages || taken.length >= bound.items) {
			more = true;
			break;
		}
		taken.push(item);
		if (isShown(item)) shown++;
	}
	// A picture left off the end is read again with the next page: a cursor never names an item a purge may delete.
	while (more && taken.length > 1 && isPictureItem(taken.at(-1) as StoredItem))
		taken.pop();
	const earlier = more ? (taken.at(-1)?.id ?? null) : null;
	return { items: taken.reverse(), earlier };
}

export function foundryHistoryStore(): HistoryStore {
	const newestOrNone = async (
		thread: HistoryThread,
		limit: number,
		after?: string,
	) => {
		try {
			const record = conversationOf(thread);
			const items = await newestItems(record.id, limit);
			if (!after) return items;
			// The service gives an item no time: the thread's record has each message's, and one it lacks is as old as the thread.
			const times = new Map(record.itemTimes.map((time) => [time.id, time.at]));
			return items.filter(
				(item) => (times.get(item.id) ?? thread.createdAt) > after,
			);
		} catch (err) {
			// Expired: nothing to read; the next write renews it.
			if (hasStatus(err, 404)) return [];
			throw err;
		}
	};

	return {
		kind: "foundry",

		async begin(threadId) {
			return {
				store: "foundry",
				conversation: {
					id: await createConversation(threadId),
					itemTimes: [],
					responseIds: [],
					former: [],
				},
			};
		},

		async discard(history) {
			if (history.conversation)
				await discardConversation(history.conversation.id);
		},

		newestFirst: newestOrNone,

		async prepare(thread, turn): Promise<PreparedTurn> {
			let conversationId = conversationOf(thread).id;
			if ("answers" in turn)
				return {
					input: [...turn.answers],
					keep: [],
					shape: conversationShape(conversationId),
					pictures: false,
				};
			let newest: StoredItem[];
			try {
				newest = await newestItems(conversationId, OPEN_CALL_WINDOW);
			} catch (err) {
				if (!hasStatus(err, 404)) throw err;
				conversationId = await renew(thread, conversationId);
				newest = [];
			}
			return {
				// The service takes nothing more while a call is open: the person's words go in behind an output for each.
				input: [...notAnswered(openCalls(newest)), ...turn.said],
				keep: [],
				shape: conversationShape(conversationId),
				pictures: turn.said.some(isPictureItem),
			};
		},

		/**
		 * The messages the turn's responses wrote stamped with now, its
		 * responses recorded for a delete to reach (one the record has no
		 * more room for deleted at once), the thread moved, and the turn's
		 * pictures deleted from the conversation. When the content filter
		 * ended the run, whatever messages the conversation took of the turn
		 * are marked blocked for memory to leave out.
		 */
		async settle(thread, prepared, run) {
			const current = await readThreadDocument(thread.resourceId, thread.id);
			const record = current?.conversation;
			if (!record) return;
			// The conversation holds the exchange already: all of this is the
			// record of it, and a failure here is said, never thrown, or the
			// person's retry would put the exchange in the conversation twice.
			try {
				const at = new Date().toISOString();
				const times = await stampWritten(record.id, record.itemTimes, at);
				const unlisted = await recordConversation(
					thread.resourceId,
					thread.id,
					{ times, responseIds: run.responseIds },
					true,
				);
				if (run.blocked)
					await markBlocked(
						thread.resourceId,
						thread.id,
						times.map((time) => time.id),
					);
				for (const responseId of unlisted)
					await deleteResponse(responseId).catch((err: Error) =>
						console.error(
							"[agent] a response past the record's bound is left behind:",
							err.message,
						),
					);
			} catch (err) {
				reportFailure(
					"agent",
					"a kept turn's conversation was not recorded",
					err,
				);
			}
			// Whatever became of the record: a picture is deleted or said to be
			// kept under its own name, never left under the record's failure.
			if (prepared.pictures) await purgePictures(record.id, run.responseIds[0]);
		},

		async append(thread, writes) {
			if (!writes.length) return;
			const conversationId = conversationOf(thread).id;
			let given = writes;
			let made: StoredItem[];
			try {
				made = await appendItems(conversationId, itemsOf(given));
			} catch (err) {
				if (!hasStatus(err, 404)) throw err;
				const renewed = await renew(thread, conversationId);
				// A new conversation holds no call for an output to answer.
				given = given.filter(
					(write) => write.item.type !== "function_call_output",
				);
				made = await appendItems(renewed, itemsOf(given));
			}
			const now = new Date().toISOString();
			await recordConversation(thread.resourceId, thread.id, {
				// Each keeps when it was said: the items come back in the order they were given.
				times: made.flatMap((item, i) =>
					isShown(item) ? [{ id: item.id, at: given[i]?.at ?? now }] : [],
				),
			});
			await markBlocked(
				thread.resourceId,
				thread.id,
				made.flatMap((item, i) => (given[i]?.blocked ? [item.id] : [])),
			);
		},

		async page(thread, request) {
			const record = conversationOf(thread);
			try {
				const page = await threadPage(
					itemsNewestFirst(record.id, {
						after: request.before,
						pageSize: Math.min(request.maxItems, PAGE_MAX),
					}),
					{ messages: request.messages, items: request.maxItems },
				);
				return {
					messages: threadMessages(
						datedItems(page.items, record.itemTimes, thread.createdAt),
					),
					earlier: page.earlier,
				};
			} catch (err) {
				if (hasStatus(err, 404)) return { messages: [], earlier: null };
				throw err;
			}
		},

		/**
		 * Every response the thread's record holds, then its conversation and
		 * every one it had before, each item deleted through the API; one
		 * already gone is done. Anything else fails the delete, reported, so
		 * the index entry an erase finds the thread by stays for the retry.
		 */
		async remove(thread) {
			const record = conversationOf(thread);
			try {
				for (const responseId of record.responseIds)
					await deleteResponse(responseId);
				for (const conversationId of [record.id, ...record.former])
					await discardConversation(conversationId);
			} catch (err) {
				problems.report("agent.erase.incomplete", {
					reason: "history_delete_failed",
				});
				throw err;
			}
		},
	};
}
