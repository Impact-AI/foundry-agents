/**
 * A message sent while the assistant is still answering waits here and goes
 * once the answer is over, rather than landing in the middle of a run.
 *
 * "Over" is more than the runtime's `isRunning` going false. When the
 * assistant calls one of the page's controls, the run ends, the page answers
 * the call, and a follow-up run starts — and between the two `isRunning` is
 * false for a moment. A message sent into that gap would arrive while the
 * call is still open, so the server would close it unanswered. The thread
 * says whether that is happening: its last message is the control's answer
 * (the follow-up is about to start), or an assistant turn whose calls the
 * page has not answered yet.
 */

/** The parts of a thread message this reads. */
export interface QueueMessage {
	role: string;
	toolCalls?: readonly { id: string }[];
	toolCallId?: string;
}

/** How long the thread must stay at rest before a queued message goes. */
export const REST_MS = 300;

/**
 * How long a stalled call may hold the queue. A control that never answers
 * would otherwise keep the message waiting for ever; past this the message
 * goes, and the server closes the open call as unanswered — as it does for
 * any message sent over one.
 */
export const STALL_MS = 3_000;

/** Whether the thread is at rest: no run, and no call waiting on the page or on a follow-up. */
export function atRest(
	messages: readonly QueueMessage[],
	isRunning: boolean,
): boolean {
	if (isRunning) return false;
	const last = messages.at(-1);
	if (!last) return true;
	if (last.role === "tool") return false;
	if (last.role === "assistant" && last.toolCalls?.length) {
		const answered = new Set(
			messages.filter((m) => m.role === "tool").map((m) => m.toolCallId),
		);
		return last.toolCalls.every((call) => answered.has(call.id));
	}
	return true;
}

/**
 * How long to wait before a queued message goes, or `null` while it must
 * keep waiting: a short settle once at rest, a longer one when only a stalled
 * call is in the way, and never while a run is in flight or a picture is
 * still being prepared.
 */
export function sendAfter(
	messages: readonly QueueMessage[],
	isRunning: boolean,
	uploading: boolean,
): number | null {
	if (isRunning || uploading) return null;
	return atRest(messages, isRunning) ? REST_MS : STALL_MS;
}

/** A second message sent while one is queued joins it, as its own paragraph. */
export function joinQueued(queued: string | null, text: string): string {
	return queued ? `${queued}\n\n${text}` : text;
}

/**
 * What waits to go. `typed` is whether any of it came from the composer:
 * typed words go as the composer sends them, with the pictures waiting in
 * it, and words from a chip or an opener go alone.
 */
export interface Queued {
	text: string;
	typed: boolean;
}

/** More words join what waits; once any of it was typed, all of it goes as typed. */
export function queueMore(
	queued: Queued | null,
	text: string,
	typed: boolean,
): Queued {
	return {
		text: joinQueued(queued?.text ?? null, text),
		typed: typed || Boolean(queued?.typed),
	};
}

/** Whether `text` is already the last of what waits: the same chip pressed again adds nothing. */
export function alreadyWaiting(queued: Queued | null, text: string): boolean {
	if (!queued) return false;
	return queued.text === text || queued.text.endsWith(`\n\n${text}`);
}

/**
 * Whether a turn may be posted to the thread now: it is at rest, and no
 * live voice session holds it. Every way of posting one asks this — the
 * composer, a chip, an opener on the desk, a picture from the camera — so
 * none lands on an open call or on a thread the backend would refuse.
 */
export function mayPost(
	messages: readonly QueueMessage[],
	isRunning: boolean,
	voiceHolds: boolean,
): boolean {
	return !voiceHolds && atRest(messages, isRunning);
}

/**
 * Where words that are not typed go: straight to the thread, as a turn of
 * their own that touches neither the composer's draft nor the pictures
 * waiting in it — unless whoever took the outbox keeps them. The composer's
 * column takes it while it is on the page, and keeps words that must wait
 * (a run in flight, a live session holding the thread) in its queue.
 *
 * Words the outbox has just sent on are a turn the page has not drawn yet:
 * until that send is over the outbox is `busy`, and says so to the taker,
 * which the page's own state would tell otherwise. A second chip pressed in
 * the same instant is therefore kept behind the first, or with nobody to
 * keep it is not sent, and never becomes a second run beside it. The same
 * words pressed again while they are still on their way are one press made
 * twice, and are dropped: a double click is one turn.
 */
export interface Outbox {
	post: (text: string) => void;
	/** The column takes the outbox while it is on the page, and hands it back with null. */
	take: (taker: Taker | null) => void;
}

/**
 * Whether the taker kept the words to send later; false leaves them to go
 * now. `busy` is whether words sent a moment ago are still on their way.
 */
export type Taker = (text: string, busy: boolean) => boolean;

/** `direct` answers with the send's own end, or with nothing when it sent nothing. */
export function createOutbox(
	direct: (text: string) => Promise<unknown> | undefined,
): Outbox {
	let taker: Taker | null = null;
	let busy = false;
	/** The words on their way while `busy`. */
	let going: string | null = null;
	return {
		post: (text) => {
			const said = text.trim();
			if (!said) return;
			if (busy && said === going) return;
			if (taker?.(said, busy)) return;
			if (busy) return;
			const sent = direct(said);
			if (!sent) return;
			busy = true;
			going = said;
			const over = () => {
				busy = false;
				going = null;
			};
			sent.then(over, over);
		},
		take: (next) => {
			taker = next;
		},
	};
}
