import type { DocumentSource, LiveContextLine } from "@platform/agent";
import { z } from "zod";

/**
 * What crosses the browser's socket, in both directions, as closed lists
 * read once at the boundary. Text frames
 * carry JSON; binary frames carry audio, PCM16 little-endian, mono, at
 * {@link AUDIO_SAMPLE_RATE}: the person's microphone in, the voice out.
 *
 * In: `start` once, first — the thread and what the screen shows — then
 * a stage call's answer, the screen when it changes, the person's typed
 * words (`text`), and `end`. Out: `ready` or `refused`, then the pane's
 * events, which say what the pane draws and nothing of the protocol
 * beneath. Nothing the browser sends reaches the service but its audio,
 * its typed words, a stage call's answer, the screen's lines and an end;
 * nothing it is sent carries a credential.
 */

/** The rate both directions' audio is at: the voice agent's default for PCM16. */
export const AUDIO_SAMPLE_RATE = 24_000;
/** The longest audio frame the browser may send: half a second. */
export const MAX_AUDIO_FRAME_BYTES = AUDIO_SAMPLE_RATE;
/** The longest text frame the browser may send: a stage call's answer, never a document. */
const MAX_TEXT_FRAME_CHARS = 16 * 1024;

/**
 * Why a session ended. `client`: the person ended it. `idle`, `length`,
 * `allowance`: the ledger's cutoff (nobody spoke, the hard limit, the
 * allowance refused a renewal). `expired`: the service's own limit.
 * `restart`: this replica is going away; reopening continues the thread.
 * `service`: the service closed it. `refused`: the service refused the
 * session's own settings and would answer nothing. `failed`: the socket
 * went, or the browser sent audio no microphone makes. `lost`: the replica
 * holding it died.
 */
const END_REASONS = [
	"client",
	"idle",
	"length",
	"allowance",
	"expired",
	"restart",
	"service",
	"refused",
	"failed",
	"lost",
] as const;
export type EndReason = (typeof END_REASONS)[number];

/** The pane's events: what it draws, in the order they happened. */
export type LiveEvent =
	/** The person began or stopped speaking. `started` is also the barge-in: the browser stops the voice's audio. */
	| { type: "speech"; state: "started" | "stopped" }
	| { type: "response"; state: "started" | "done" }
	/** A final transcript, either side's: what was heard, as it was heard. */
	| { type: "line"; role: "user" | "assistant"; text: string }
	/** The documents the answer just spoken drew on, as a typed turn's `sources`: under the last assistant line. */
	| { type: "sources"; sources: DocumentSource[] }
	/** A control the browser runs; it answers with `tool-output`. */
	| {
			type: "stage-call";
			callId: string;
			name: string;
			args: Record<string, unknown>;
	  }
	/** A stage call answered for the browser (`not_answered`) because it did not answer in time. */
	| { type: "stage-call-closed"; callId: string }
	/**
	 * `turn.blocked`: the content filter stopped an answer; the category is in
	 * the logs only. `turn.unanswered`: a response failed with nothing said
	 * and asking again did not answer either; the voice is told to say so.
	 * `text.too_fast`, `text.session_full`: a typed message was not taken,
	 * as one of more than a session takes at once or in all (`input-budget.ts`).
	 */
	| {
			type: "error";
			code:
				| "turn.blocked"
				| "turn.unanswered"
				| "text.too_fast"
				| "text.session_full";
	  }
	/** The session is ending; the thread is being settled. */
	| { type: "ending"; reason: EndReason }
	/** The session is over and its words are in the thread: the chat may read it again. */
	| { type: "ended"; reason: EndReason; written: number };

/** What the backend sends the browser as text: the session's answer, then its events. */
export type ServerMessage =
	| {
			type: "ready";
			session: { id: string; maxSessionSeconds: number; idleSeconds: number };
			language: string;
			audio: { sampleRate: number };
	  }
	/** The open refused, as an HTTP route would have answered it: the status and the body, which the pane reads as it reads any refusal. */
	| { type: "refused"; status: number; body: unknown }
	| LiveEvent;

/** A thread id is the client's to mint, and travels in a key and a log line: short, printable, none of the broker's separators. */
const THREAD_ID = /^[A-Za-z0-9_.-]{1,128}$/;
/** The longest stage-call answer the browser may send: a status line, never a document. */
const MAX_TOOL_OUTPUT_CHARS = 4_000;
/** The longest typed message the browser may send into a session: a message, never a document. */
const MAX_TYPED_CHARS = 4_000;
/** The screen as the browser reports it: a few short lines, as a typed turn's live context is. */
const MAX_SCREEN_LINES = 12;
const MAX_SCREEN_LINE_CHARS = 300;

const screenLines = z
	.array(
		z
			.object({
				label: z.string().min(1).max(MAX_SCREEN_LINE_CHARS),
				value: z.string().max(MAX_SCREEN_LINE_CHARS),
			})
			.strict(),
	)
	.max(MAX_SCREEN_LINES);

const browserMessage = z.discriminatedUnion("type", [
	z
		.object({
			type: z.literal("start"),
			threadId: z.string().regex(THREAD_ID),
			screen: screenLines.optional(),
		})
		.strict(),
	z
		.object({
			type: z.literal("tool-output"),
			callId: z.string().min(1).max(128),
			output: z.string().max(MAX_TOOL_OUTPUT_CHARS),
		})
		.strict(),
	z.object({ type: z.literal("screen"), lines: screenLines }).strict(),
	z
		.object({
			type: z.literal("text"),
			text: z.string().trim().min(1).max(MAX_TYPED_CHARS),
		})
		.strict(),
	z.object({ type: z.literal("end") }).strict(),
]);

/** What the browser sends, as text. */
export type BrowserMessage = z.infer<typeof browserMessage>;

/** One text frame from the browser, read; null for anything that is not one of its messages. */
export function readBrowserMessage(raw: string): BrowserMessage | null {
	if (raw.length > MAX_TEXT_FRAME_CHARS) return null;
	try {
		const parsed = browserMessage.safeParse(JSON.parse(raw));
		return parsed.success ? parsed.data : null;
	} catch {
		return null;
	}
}

/** The screen's lines as a turn's live context takes them. */
export function screenOf(
	lines: readonly { label: string; value: string }[] | undefined,
): LiveContextLine[] {
	return (lines ?? []).map(({ label, value }) => ({ label, value }));
}

const inboxMessage = z.object({
	type: z.literal("end"),
	reason: z.enum(END_REASONS),
});

/**
 * What reaches a session's owner on its `in` channel: an end, from the
 * ledger's sweeper on whichever replica cut the session off. Everything the
 * browser sends reaches the owner on its own socket.
 */
export type InboxMessage = z.infer<typeof inboxMessage>;

export function readInbox(raw: string): InboxMessage | null {
	try {
		const parsed = inboxMessage.safeParse(JSON.parse(raw));
		return parsed.success ? parsed.data : null;
	} catch {
		return null;
	}
}
