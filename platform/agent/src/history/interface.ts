import type { ThreadMessage } from "../contract/messages";
import type { AgentSettings, HistoryStoreKind } from "../settings";
import type {
	FunctionCallOutputItem,
	InputItem,
	ItemTime,
	MessageItem,
	StoredItem,
} from "../turn/items";

/**
 * What the host asks of whichever store keeps a thread's messages: this
 * deployment's own `messages` container (`foundry/history.ts`) or the
 * Agent Service's conversations (`foundry/conversations.ts`). The thread
 * document records which one holds it (`history/select.ts`), so a thread
 * is read, continued, spoken in, deleted and erased where it was made,
 * whatever the operator's `history.store` names today.
 */

/** Where a thread's messages are, as its document records it. */
export interface ThreadHistory {
	/** The store the thread was made in; a document without one is the own store's. */
	store?: HistoryStoreKind;
	/** The service's conversation, for a thread on `foundry`. */
	conversation?: ConversationRecord;
	/**
	 * The messages of turns the content filter blocked, by their item ids,
	 * oldest first: the thread shows them, and memory never extracts from
	 * them. Absent when no turn of the thread was blocked.
	 */
	blocked?: string[];
}

/** A thread on `foundry`: its conversation and what the service keeps no record of. */
export interface ConversationRecord {
	id: string;
	/** When each message the thread shows was written, by its item, oldest first: the service gives an item no time. */
	itemTimes: ItemTime[];
	/** Every response stored in the conversation, for a delete to reach. */
	responseIds: string[];
	/** Conversations the thread had before this one, each expired and renewed: a delete reaches them too. */
	former: string[];
}

/** The fields of a thread document a store reads. */
export interface HistoryThread extends ThreadHistory {
	id: string;
	resourceId: string;
	createdAt: string;
}

/** One item to write, and when it was said when that is not now. A reasoning item's `id` is the service's, kept as `service_id`. */
export interface HistoryWrite {
	item: Omit<StoredItem, "id"> & { id?: string };
	at?: string;
	/** A line that led to an answer the content filter stopped: the item is marked `blocked` on the thread. */
	blocked?: boolean;
}

/**
 * How each response of a turn is asked for, and what the loop does between
 * them: the fields beside the input, the next step's input, and what is
 * written before a run ends with outputs in hand.
 */
export interface TurnShape {
	fields:
		| { store: false; include: readonly string[] }
		| { store: true; conversation: string };
	/** The next step's input, from the first step's, what the turn has written, and the last step's outputs. */
	next(
		first: readonly InputItem[],
		written: readonly InputItem[],
		outputs: readonly FunctionCallOutputItem[],
	): InputItem[];
	/** The outputs a run ends with, kept where the next turn reads them; throws when they could not be. */
	hold(outputs: readonly FunctionCallOutputItem[]): Promise<void>;
}

/** A turn's input on its thread, and what is kept of it when it settles. */
export interface PreparedTurn {
	/** What the first response is given. */
	input: InputItem[];
	/** This turn's input as the history keeps it, for a store that writes it itself: no picture, only its marker. */
	keep: HistoryWrite[];
	shape: TurnShape;
	/** Whether the turn carried a picture. */
	pictures: boolean;
}

/** What a run wrote, however it ended. */
export interface SettledRun {
	kind: "finished" | "failed";
	/** The content filter ended it: what it kept of the turn is marked `blocked` on the thread. */
	blocked?: boolean;
	written: readonly InputItem[];
	responseIds: readonly string[];
}

/** What this turn adds to the thread: the person's words, or the browser's answers to its calls. */
export type TurnAddition =
	| { said: MessageItem[] }
	| { answers: FunctionCallOutputItem[] };

export interface HistoryStore {
	readonly kind: HistoryStoreKind;
	/** What a new thread's document records, made before it is written. */
	begin(threadId: string): Promise<ThreadHistory>;
	/** What `begin` made, given up: the thread was never written. */
	discard(history: ThreadHistory): Promise<void>;
	/** The thread's newest items, newest first; with `after`, an ISO instant, only those said later than it. */
	newestFirst(
		thread: HistoryThread,
		limit: number,
		after?: string,
	): Promise<StoredItem[]>;
	prepare(
		thread: HistoryThread,
		turn: TurnAddition,
		bound: AgentSettings["history"],
	): Promise<PreparedTurn>;
	/**
	 * After the last response, however the run ended: what it wrote kept, and
	 * the thread moved. It throws only while nothing of the turn is kept: once
	 * the exchange is in the thread, a failure of what follows is reported by
	 * the store and the turn stands, since a turn told it failed is sent
	 * again and would be kept twice.
	 */
	settle(
		thread: HistoryThread,
		prepared: PreparedTurn,
		run: SettledRun,
	): Promise<void>;
	/** Items written at the end of the thread, in order: a live session's lines, closing outputs; those given as blocked marked so. */
	append(thread: HistoryThread, writes: readonly HistoryWrite[]): Promise<void>;
	/** One page of the thread's messages, oldest first, and the cursor of the page before it. */
	page(
		thread: HistoryThread,
		request: { before?: string; messages: number; maxItems: number },
	): Promise<{ messages: ThreadMessage[]; earlier: string | null }>;
	/** Every message of the thread, gone; throws when that cannot be promised. */
	remove(thread: HistoryThread): Promise<void>;
}
