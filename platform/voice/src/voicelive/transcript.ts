import type { SpokenItem } from "@platform/agent";
import { type ServerEvent, USER_FAILED, USER_FINAL } from "./events";

/**
 * A live session's transcript, read off the voice agent's socket as the
 * events arrive: what the broker hands the
 * host's `settleLiveVoice`, which writes the record. Neither value of
 * `store` writes the thread, so this is the only record there is. It reads
 * the protocol and leaves the record's order to the host:
 *
 *   - every item with the item the session placed it after
 *     (`previous_item_id`), and when it was announced — the chain the host
 *     orders by, never the order the finals arrived in;
 *   - the conversation's items only: an item a response put out that the
 *     session never placed in its conversation is not the record's. The
 *     fillers spoken while a tool runs are placed on the cascade, where they
 *     take their place in the chain, and only put out on a realtime model,
 *     where, followed by nothing, they would be written after the answer
 *     they came before;
 *   - finals only: the person's from `…input_audio_transcription.completed`
 *     (or `.failed`), the voice's from `response.output_audio_transcript.done`
 *     or its GA name `response.audio_transcript.done`; deltas are ignored;
 *   - a barge-in: the person speaking over the voice makes the service
 *     cancel the response, and the answer's item is kept whole — the words
 *     the model generated, not the words the person heard — and marked; an
 *     answer the content filter stopped is never words. It is handed over
 *     as unheard, placed after the line that led to it, which the host marks
 *     blocked: the cascade's stopped answer has an item of its own, while
 *     speech-to-speech's ends with no output at all, so a stopped response
 *     that named no item is handed over under its own id, after the item
 *     the conversation ended with when it began.
 *
 * The session is settled only once every committed item of the person's
 * has a final or a failure: {@link SessionTranscript.settled} waits for it,
 * bounded, and what never came is handed over as such.
 *
 * The thread's earlier lines, which the backend gives the session as items
 * before the person speaks, are already in the thread: their ids are
 * {@link SessionTranscript.exclude}d, so they are never read as said here,
 * nor waited for as a person's turn with no final.
 */

interface Item {
	previous: string | null;
	at: string;
	role: "user" | "assistant" | null;
	text: string | null;
	failed: boolean;
	response: string | null;
	/** Whether the session placed it in its conversation (`conversation.item.*`). */
	placed: boolean;
	/** Whether a response named it as its output (`response.output_item.added`). */
	output: boolean;
}

interface Response {
	cancelled: boolean;
	filtered: boolean;
	/** The conversation's newest item when the response began: what its answer follows. */
	after: string | null;
}

const MESSAGE_ROLES = new Set(["user", "assistant"]);
/** A response that ended so was spoken over. */
const INTERRUPTED = new Set(["cancelled", "incomplete"]);

export class SessionTranscript {
	private readonly items = new Map<string, Item>();
	private readonly responses = new Map<string, Response>();
	private readonly waiters = new Set<() => void>();
	private readonly excluded = new Set<string>();
	/** The item the session placed most recently. */
	private newest: string | null = null;

	constructor(private readonly clock: () => Date = () => new Date()) {}

	/** Items this session did not say: the thread's lines it was given. Every event about one is ignored. */
	exclude(ids: Iterable<string>): void {
		for (const id of ids) this.excluded.add(id);
	}

	/** Read one event; anything this does not read is ignored. */
	observe(event: ServerEvent): void {
		if (this.excluded.size && this.excluded.has(eventItemId(event) ?? ""))
			return;
		switch (event.type) {
			case "input_audio_buffer.committed":
				this.announce(event.item_id, event.previous_item_id ?? null, "user");
				break;
			case "conversation.item.added":
			case "conversation.item.created":
			case "conversation.item.done": {
				const role =
					event.item.type === "message" &&
					MESSAGE_ROLES.has(event.item.role ?? "")
						? (event.item.role as "user" | "assistant")
						: null;
				this.announce(event.item.id, event.previous_item_id ?? null, role);
				break;
			}
			case USER_FINAL:
				this.final(event.item_id, "user", event.transcript);
				break;
			case USER_FAILED:
				this.item(event.item_id, "user").failed = true;
				this.wake();
				break;
			case "response.output_audio_transcript.done":
			case "response.audio_transcript.done":
				this.final(event.item_id, "assistant", event.transcript).response ??=
					event.response_id;
				break;
			case "response.output_item.added":
				if (event.item.type === "message" && event.item.role === "assistant") {
					const output = this.item(event.item.id, "assistant");
					output.output = true;
					output.response ??= event.response_id;
				}
				break;
			case "response.created":
				this.responses.set(event.response.id, {
					cancelled: false,
					filtered: false,
					after: this.newest,
				});
				break;
			case "response.done": {
				const response = this.responses.get(event.response.id);
				if (!response) break;
				response.filtered = /content_filter/.test(
					JSON.stringify(event.response.status_details ?? ""),
				);
				response.cancelled =
					!response.filtered && INTERRUPTED.has(event.response.status ?? "");
				if (response.filtered) this.stoppedWithout(event.response.id, response);
				break;
			}
		}
	}

	/**
	 * Words the person typed into the session, under the id the backend gave
	 * the item: they are their own final, so the service's announcement of
	 * the item only places it.
	 */
	typed(id: string, text: string): void {
		this.final(id, "user", text);
	}

	/** Committed turns of the person's with neither a final nor a failure yet. */
	get pending(): number {
		let pending = 0;
		for (const item of this.items.values())
			if (item.role === "user" && item.text === null && !item.failed) pending++;
		return pending;
	}

	/** Once every committed turn of the person's has a final or a failure, or after `timeoutMs`: whether it got there. */
	async settled(timeoutMs: number): Promise<boolean> {
		if (this.pending === 0) return true;
		const done = Promise.withResolvers<boolean>();
		const check = () => {
			if (this.pending === 0) done.resolve(true);
		};
		this.waiters.add(check);
		const timer = setTimeout(() => done.resolve(false), timeoutMs);
		try {
			return await done.promise;
		} finally {
			clearTimeout(timer);
			this.waiters.delete(check);
		}
	}

	/** Every item, as the session announced them, for the host to order and write. */
	spoken(): SpokenItem[] {
		return [...this.items].map(([itemId, item]) => ({
			itemId,
			previousItemId: item.previous,
			at: item.at,
			...this.classify(item),
		}));
	}

	private classify(
		item: Item,
	): DistributiveOmit<SpokenItem, "itemId" | "previousItemId" | "at"> {
		if (item.role === null) return { kind: "other" };
		if (item.role === "user")
			return item.text !== null
				? { kind: "said", role: "user", text: item.text, interrupted: false }
				: {
						kind: "unheard",
						role: "user",
						reason: item.failed ? "failed" : "unsettled",
					};
		// Put out, never placed in the conversation: a filler on speech-to-speech.
		if (item.output && !item.placed) return { kind: "other" };
		const response = item.response
			? this.responses.get(item.response)
			: undefined;
		if (response?.filtered)
			return { kind: "unheard", role: "assistant", reason: "filtered" };
		if (item.text === null)
			return { kind: "unheard", role: "assistant", reason: "unsettled" };
		// Spoken over: the whole reply, marked; the host leaves out one with no words.
		return {
			kind: "said",
			role: "assistant",
			text: item.text,
			interrupted: !!response?.cancelled,
		};
	}

	/** A stopped response that named no item of its own: one under the response's id, after what it followed. */
	private stoppedWithout(id: string, response: Response): void {
		for (const item of this.items.values()) if (item.response === id) return;
		const item = this.item(id, "assistant");
		item.previous = response.after;
		item.response = id;
		item.placed = true;
	}

	/** The item, made where an event names one the session never announced: it follows nothing. */
	private item(id: string, role: "user" | "assistant"): Item {
		let item = this.items.get(id);
		if (!item) {
			item = {
				previous: null,
				at: this.clock().toISOString(),
				role,
				text: null,
				failed: false,
				response: null,
				placed: false,
				output: false,
			};
			this.items.set(id, item);
		}
		return item;
	}

	/** The first announcement places an item; a later one only fills what the first did not say. */
	private announce(
		id: string,
		previous: string | null,
		role: Item["role"],
	): void {
		const known = this.items.has(id);
		const item = this.item(id, role ?? "user");
		// Its first placement: a later announcement of an older item does not move the end.
		if (!item.placed) this.newest = id;
		item.placed = true;
		if (known) {
			item.previous ??= previous;
			return;
		}
		item.previous = previous;
		item.role = role;
	}

	/** The first final of an item stands: a repeat is the same words. */
	private final(
		id: string,
		role: "user" | "assistant",
		transcript: string,
	): Item {
		const item = this.item(id, role);
		item.text ??= transcript;
		item.role ??= role;
		this.wake();
		return item;
	}

	private wake(): void {
		for (const waiter of [...this.waiters]) waiter();
	}
}

/** The item an event is about, whichever field names it. */
function eventItemId(event: ServerEvent): string | null {
	const { item, item_id } = event as {
		item?: { id?: unknown };
		item_id?: unknown;
	};
	if (typeof item_id === "string") return item_id;
	return typeof item?.id === "string" ? item.id : null;
}

/** `Omit` over each member of a union, so the members stay apart. */
type DistributiveOmit<T, K extends PropertyKey> = T extends unknown
	? Omit<T, K>
	: never;
