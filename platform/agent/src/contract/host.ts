import type { ConfigKey } from "@platform/config";
import type { Tier } from "@platform/identity/claims";
import type { ReplyChannel } from "@platform/prompt";
import type { ToolGatingConfig } from "../tool-gating";
import type { CallerIdentity } from "../turn/scope";
import type {
	DocumentSource,
	LiveContextLine,
	ThreadMessage,
	TurnEvent,
	TurnMessage,
} from "./messages";
import type { VoiceTuning } from "./voice-tuning";

/**
 * The agent, as the one object a backend talks to. Every method takes the
 * resource id the backend resolved from a verified caller — never one read
 * off a request — and every answer is a value: a refusal is data a route
 * turns into a status, not an exception to catch by message.
 *
 * A second implementation on another runtime is written against this and
 * nothing else; nothing here names the framework the first one is built on.
 */

export interface TurnInput {
	/** The memory scope this turn reads and writes: the account id. */
	resourceId: string;
	/** The conversation, minted by the client. A new id opens a thread under `resourceId`. */
	threadId: string;
	/** The turn's input: the person's message, or the results of the controls the client ran. */
	messages: TurnMessage[];
	/**
	 * The controls this client registered and will run, by name: each one of
	 * the product's `clientTools`, offered to the model in the product's words.
	 * Absent is none.
	 */
	clientTools?: readonly string[];
	/**
	 * What makes a retry of this turn the same turn. Defaults to the last
	 * message's id within the thread, which a retry resends unchanged and a
	 * continuation (a tool result posted back) grows past.
	 */
	turnKey?: string;
	/** Which interface the turn came from. Gates the product's skills and surface block. */
	surface: string;
	/** The English name of the language the person chose, from `@platform/i18n`. */
	languageName: string;
	liveContext?: readonly LiveContextLine[];
	/** Who is asking, from the backend's verified claims, for a tool that decides who may read what. Absent is nobody. */
	caller?: CallerIdentity | null;
	abortSignal?: AbortSignal;
	/**
	 * Whether the caller is still the one the request was admitted as, asked
	 * once the turn is counted as running and before anything is written —
	 * a thread made, a message kept. The caller's own refusal ends the turn
	 * there (`caller.refused`). A request is admitted, then its body read;
	 * whatever happened to the caller in between — an erase of the account,
	 * say — is what this sees. Absent asks nothing.
	 */
	stillAdmitted?: () => Promise<CallerRefusal | null>;
}

/** The caller's answer to `stillAdmitted`: a status and a code of its own, handed on as they are. */
export interface CallerRefusal {
	status: 401 | 403 | 503;
	code: string;
}

export type TurnRefusal =
	/**
	 * The input is not a turn this thread can take: a control the product does
	 * not define, a result for a call the agent did not leave open for the
	 * client, or a message of no role a turn carries.
	 */
	| { code: "turn.invalid"; status: 400 }
	/** The thread belongs to another resource. */
	| { code: "thread.forbidden"; status: 403 }
	/** The same turn is being answered, here or on another replica, or was within the claim's lifetime. */
	| { code: "turn.duplicate"; status: 409 }
	/** A live voice session holds the thread: one channel at a time. */
	| { code: "thread.busy"; status: 409 }
	| { code: "turn.rate_limited"; status: 429; retryAfterSeconds: number }
	/** Ownership could not be verified; the caller may retry. */
	| { code: "thread.unavailable"; status: 503 }
	/** The caller's `stillAdmitted` refused: its status, and its own code as `reason`. */
	| { code: "caller.refused"; status: 401 | 403 | 503; reason: string };

export type TurnOutcome =
	| { kind: "started"; runId: string; events: ReadableStream<TurnEvent> }
	| { kind: "refused"; refusal: TurnRefusal };

export interface ThreadSummary {
	id: string;
	title: string;
	createdAt: string;
	updatedAt: string;
}

/** One page of a thread: its newest messages, or the ones before a `before`, oldest first. */
export interface ThreadView extends ThreadSummary {
	messages: ThreadMessage[];
	/** The `before` that reads the page of older messages; null when this page reaches the thread's first. */
	earlier: string | null;
}

export interface ThreadReadRequest {
	/** The `earlier` of the page after; absent for the newest messages. */
	before?: string;
	/**
	 * At most this many messages. The host bounds a page of its own as well,
	 * so a short page is not the thread's first: a null `earlier` is.
	 */
	limit?: number;
}

/** The most threads one page holds, whatever a caller asks for. */
export const THREAD_PAGE_MAX = 100;

export interface ThreadPageRequest {
	/** The `next` of the page before; absent for the first. */
	cursor?: string;
	/** At most this many, up to {@link THREAD_PAGE_MAX}; ignored with a cursor, which carries its own. */
	limit?: number;
}

export interface ThreadPage {
	threads: ThreadSummary[];
	/** Where the following page starts; null on the last. */
	next: string | null;
}

/** The person's blocks of the prompt's third part, rendered for one channel. */
export interface PersonBlocks {
	identity: string | null;
	dossier: string | null;
	memory: string | null;
	/** ISO UTC; null for "never" and for "could not read" alike. */
	lastConversationAt: string | null;
}

/**
 * The longest spoken line a host writes down: the text lands in a thread the
 * agent reads back on its next turn, so a settle is a door onto the prompt.
 */
export const MAX_VOICE_TURN_CHARS = 8_000;

/** What a live voice session opens a thread with. */
export interface LiveVoiceRequest {
	/** The session's id, minted by the caller: it names the session's hold on the thread and is the service's `agent_session_id`. */
	sessionId: string;
	/** The session's hard limit: the longest the hold outlives a session nobody settled. */
	maxSessionSeconds: number;
	/** The tier, resolved at the point of use: which voice the session speaks with. */
	tier: Tier;
	/** The language the person chose, as the client sent it; checked against the product's before anything is made. */
	locale: string;
	/** What is on their screen as the session opens. */
	screen?: readonly LiveContextLine[];
	/** Who is asking, for the tools' readers. Absent is nobody. */
	caller?: CallerIdentity | null;
	/** A voice tester's tuning, checked by the caller at the point of use against the account's role; absent for anybody else. */
	tuning?: VoiceTuning | null;
	/** As a turn's (`TurnInput.stillAdmitted`): asked once the session is counted as running on the thread, before the thread is made or written. */
	stillAdmitted?: () => Promise<CallerRefusal | null>;
}

/** Everything the session is opened with, once the thread is the session's. */
export interface LiveVoiceBinding {
	/** The voice agent, and the version the session pins. */
	agentName: string;
	version: string;
	/** The version's declared inputs for this person: their part of the prompt, the language directive last, and the language's code. */
	structuredInputs: { personalization: string; language: string };
	/**
	 * The `session.update` sent once the session is announced: on a voice
	 * agent, the transcription, the voice and its accent for this person; on
	 * Voice Live, the whole session — instructions, tools and audio.
	 */
	session: { [field: string]: unknown };
	/**
	 * Where the socket is opened. Absent: the voice agent `agentName` at
	 * `version`. `voiceLive`: the Voice Live API on the model it hosts,
	 * with no agent and no version (`agentName` and `version` then name the
	 * runtime and the model, for the usage lines).
	 */
	runtime?: { kind: "voiceLive"; model: string };
	/** How the session's calls are answered: the person's tools on the backend, their controls in their browser. */
	tools: LiveVoiceTools;
	/**
	 * The thread so far, oldest first, within the `agent` document's
	 * `history` bound: what a typed turn on this thread is given, as the
	 * words of each side. The broker adds them to the session before the
	 * person speaks, so a spoken turn continues the typed conversation.
	 */
	history: readonly LiveHistoryLine[];
	/** Responses one turn of the person's may ask for with the backend's answers: the `agent` document's `foundry.maxSteps`, as a typed turn's. */
	maxSteps: number;
	/**
	 * The version again, made afresh: for a session the service refused to
	 * open, whose pinned version may have been pruned under this replica (a
	 * typed turn does the same on its 404).
	 */
	reensure(): Promise<string>;
}

/**
 * One line of the thread a live session is given: the words of a message,
 * the person's or the agent's. The id is the session's own for the item
 * (`hist_<n>`), so the broker can tell these from what is said in it; a
 * tool call, its output and a picture are not words and are not given.
 */
export interface LiveHistoryLine {
	id: string;
	role: "user" | "assistant";
	text: string;
}

/**
 * A live session's calls, as the binding answers them. The voice agent calls the person's tools
 * itself, and the calls reach the socket the backend holds: a tool of the
 * backend's runs there, as the person, in the
 * same scope a typed turn's does — the readers filter, the caller, the
 * meters — and a control is the person's browser's to run.
 */
export interface LiveVoiceTools {
	/** A control the person's browser runs: the broker carries the call there and the answer back. */
	inBrowser(name: string): boolean;
	/** A tool of the backend's that this session's agent was given. */
	onServer(name: string): boolean;
	/** Run a tool of the backend's as the person: its output as the model reads it, and the library documents it handed the model. Never throws: a failure is an output. */
	run(
		name: string,
		args: string,
	): Promise<{ output: string; sources: DocumentSource[] }>;
}

/**
 * The output a call of a tool the turn does not have is answered with, on
 * either channel. Told what to do instead, the model answers in words;
 * told only "error", it tends to retry the same control until the step
 * limit.
 */
export const NOT_AVAILABLE_OUTPUT = JSON.stringify({
	error: "not_available",
	message:
		"This control is not on this client. Do not call it again; give the reply in words.",
});

export type LiveVoiceRefusal =
	/** A locale the product does not speak, or a product with no live voice. */
	| { code: "turn.invalid"; status: 400 }
	| { code: "thread.forbidden"; status: 403 }
	/** Another live session holds the thread. */
	| { code: "thread.busy"; status: 409 }
	| { code: "thread.unavailable"; status: 503 }
	/** The caller's `stillAdmitted` refused. */
	| { code: "caller.refused"; status: 401 | 403 | 503; reason: string };

export type LiveVoiceOutcome =
	| { kind: "bound"; binding: LiveVoiceBinding }
	| { kind: "refused"; refusal: LiveVoiceRefusal };

/**
 * One item of a live session, as the broker read it off the voice agent's
 * socket: its place in the session's chain
 * of items, when the session announced it, and what it was. The broker
 * reads the protocol — which transcripts are final, which answers were
 * spoken over —
 * and the host writes the record from it: in the chain's order, the said
 * lines alone, each once.
 */
export type SpokenItem = {
	itemId: string;
	/** The item the session placed it after; null for the first, or when the session never said. */
	previousItemId: string | null;
	/** When the session announced it: ISO UTC, as the broker's clock read it. */
	at: string;
} & (
	| {
			/** Words in a final transcript, the person's or the voice's. */
			kind: "said";
			role: "user" | "assistant";
			text: string;
			/** The person spoke over it. `text` is still the whole reply the model generated, not what was heard. */
			interrupted: boolean;
	  }
	| {
			/** Words nobody can write down. */
			kind: "unheard";
			role: "user" | "assistant";
			/** The transcription failed, or never came; the filter stopped the answer. */
			reason: "failed" | "unsettled" | "filtered";
	  }
	/** Not words: a call, its output. Placed in the chain, never written. */
	| { kind: "other" }
);

/** What a settle wrote, and what it left out and why. */
export interface LiveVoiceSettlement {
	/** Lines written into the thread, in the session's order. */
	written: number;
	/** Of those, lines the person spoke over. */
	interrupted: number;
	/** Items not written, by why. */
	skipped: {
		failed: number;
		unsettled: number;
		filtered: number;
	};
	/** The session was settled before: nothing was written again. */
	repeated: boolean;
}

export interface EraseReport {
	threads: number;
	/** Whether there was anything remembered to forget. */
	memories: boolean;
}

/** One thing the agent remembers about a person, as they see it in their settings. */
export interface MemoryItem {
	id: string;
	/** A short statement, as the extractor or the person last wrote it. */
	content: string;
	/** ISO, UTC: when either last wrote it. */
	updatedAt: string;
}

/** Everything the agent remembers about a person, newest first. */
export interface PersonMemory {
	items: MemoryItem[];
}

export interface AgentHost {
	/** The operator's `tools` document as this host reads it per turn, for a route that briefs another channel from the same answer. */
	readonly toolGating: ConfigKey<ToolGatingConfig>;
	/** Run one turn. The stream is the backend's to forward; it ends with `finish` or `error`. */
	startTurn(input: TurnInput): Promise<TurnOutcome>;
	/** Newest first, a page at a time: read to a null `next` for all of them. */
	listThreads(
		resourceId: string,
		page?: ThreadPageRequest,
	): Promise<ThreadPage>;
	/**
	 * Newest first, a page at a time: read to a null `earlier` for the whole
	 * thread. Null for a thread that does not exist or is not this
	 * resource's: the two are not told apart.
	 */
	readThread(
		resourceId: string,
		threadId: string,
		page?: ThreadReadRequest,
	): Promise<ThreadView | null>;
	/** False when the thread is not this resource's. */
	renameThread(
		resourceId: string,
		threadId: string,
		title: string,
	): Promise<boolean>;
	/** The thread and everything it holds, wherever it is held. False when it is not this resource's. */
	deleteThread(resourceId: string, threadId: string): Promise<boolean>;
	/**
	 * Open a thread to a live voice session: the thread made when it is new,
	 * the calls a typed turn left open closed, the voice agent's version for
	 * this person's allowances, their part of the prompt and the session's
	 * update for their language and tier. From here until the session is
	 * settled the thread is the session's: a typed turn on it, or a second
	 * session, is `thread.busy`.
	 */
	liveVoiceBinding(
		resourceId: string,
		threadId: string,
		request: LiveVoiceRequest,
	): Promise<LiveVoiceOutcome>;
	/**
	 * Write a live session's words into its thread and give the thread back:
	 * the lines said, in the session's order, each once, handed to memory as
	 * a typed turn's are. A session that never opened is settled with no
	 * items. Null when the thread is not this resource's; a settle repeated
	 * for the same session writes nothing.
	 */
	settleLiveVoice(
		resourceId: string,
		threadId: string,
		settle: {
			sessionId: string;
			spoken: readonly SpokenItem[];
			/** As the binding's (`LiveVoiceRequest.stillAdmitted`), asked before each write the settle makes; a settle on another replica has none, and its thread being gone stands in for it. */
			stillAdmitted?: () => Promise<CallerRefusal | null>;
		},
	): Promise<LiveVoiceSettlement | null>;
	/** What the agent remembers about the person, newest first: none before anything was remembered. */
	readMemory(resourceId: string): Promise<PersonMemory>;
	/**
	 * The person's correction of one statement: it becomes their text, capped
	 * like an extraction, and is what later extractions start from. Null when
	 * the statement is not theirs or is gone; blank text removes it and
	 * answers null.
	 */
	updateMemoryItem(
		resourceId: string,
		itemId: string,
		content: string,
	): Promise<MemoryItem | null>;
	/** Forget one statement. False when it is not theirs or is already gone. */
	removeMemoryItem(resourceId: string, itemId: string): Promise<boolean>;
	/** Forget everything remembered about the person. True when there was something. */
	forgetMemory(resourceId: string): Promise<boolean>;
	/**
	 * The person edited what they wrote about themselves, elsewhere: the next
	 * turn reads it from where it lives rather than from a copy the host keeps.
	 */
	personChanged(resourceId: string): Promise<void>;
	/**
	 * Who the person is, what they wrote, what is remembered and when they
	 * last talked, rendered for `channel` — for a channel that composes its own
	 * prompt, through the same reads a turn's instructions make. Never throws:
	 * each block is null when it cannot be read.
	 */
	personalization(
		resourceId: string,
		channel: ReplyChannel,
	): Promise<PersonBlocks>;
	/**
	 * Everything held under the resource: threads and every message of
	 * them, what is remembered, and every cached copy.
	 * Idempotent, so a caller retries a failure until it reports clean.
	 * `stillHeld`, when given, is asked before each step; once it answers
	 * false the erase stops where it is and throws, so a caller whose right
	 * to erase has lapsed sweeps nothing more. A cached copy that cannot be
	 * dropped is reported, not thrown: it expires on its own.
	 */
	eraseResource(
		resourceId: string,
		options?: { stillHeld?: () => Promise<boolean> },
	): Promise<EraseReport>;
	/** Pay the first turn's cold costs ahead of it. Coalesced; never throws. */
	warmUp(): Promise<void>;
	/** Open the stores and start the background work. */
	start(): Promise<void>;
	/** Finish the work in flight and close the stores. */
	stop(): Promise<void>;
}
