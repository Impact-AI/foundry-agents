import {
	type AgentHost,
	type DocumentSource,
	type LiveVoiceBinding,
	type LiveVoiceRequest,
	NOT_AVAILABLE_OUTPUT,
	namedSources,
	uniqueSources,
} from "@platform/agent";
import type { Tier } from "@platform/identity/claims";
import { endSession, renewSession } from "@platform/metering";
import { emitUsage, runInUsageScope } from "@platform/observability";
import { renderLiveContextBlock } from "@platform/prompt";
import {
	claimOnce,
	extendClaim,
	releaseClaim,
	type Subscription,
	subscribe,
} from "@platform/redis";
import { voiceProblems } from "../problems";
import type { VoiceSettings } from "../settings";
import type {
	VoiceAgentClose,
	VoiceAgentConnection,
} from "../voicelive/client";
import {
	ASSISTANT_AUDIO,
	type ClientEvent,
	type ServerEvent,
	USER_FINAL,
} from "../voicelive/events";
import { isFatalError, isRollbackEcho } from "../voicelive/refusals";
import { SessionTranscript } from "../voicelive/transcript";
import { Hearing } from "./hearing";
import { Bucket, INPUT_BUDGET, refusedAudioAllowance } from "./input-budget";
import type { VoiceKeys } from "./keys";
import {
	type BrowserMessage,
	type EndReason,
	type LiveEvent,
	readInbox,
	type ServerMessage,
} from "./messages";
import {
	type ResponseFailure,
	responseFailureOf,
	retryDecision,
	UNANSWERED_NOTE,
} from "./response-failure";
import type { SessionRecord, SessionStore } from "./store";
import { TurnClock } from "./turn-timing";

/**
 * One live session, on the replica that holds both its sockets: the browser's and the voice agent's. It
 * relays the audio both ways — the person's frames appended to the
 * session, the voice's deltas sent to the browser as they come — and reads
 * every event the voice agent sends from the first, turning them into four
 * things:
 *
 *   - the record: a {@link SessionTranscript}, kept in Redis as it grows,
 *     which the host writes into the thread when the session ends;
 *   - the pane's events, sent to the browser in order, the documents an
 *     answer drew on among them, decided as a typed turn's are
 *     (`namedSources`): what the session's calls retrieved since the
 *     person last spoke, by the backend's tools, under the first answer
 *     that called nothing;
 *   - the answers to the session's calls: a tool of the backend's run here
 *     as the person, a control sent to the browser and its answer carried
 *     back — or `not_answered` once the browser has had its time — and,
 *     once every call of a response is answered, the `response.create` that
 *     lets the voice go on: at once, or once the response open then is done,
 *     since a session has one response at a time;
 *   - a response that failed with nothing said asked again, within the
 *     `voice` document's `live.responseRetry` and the turn's `maxSteps`, and
 *     the voice told once to say so when the asks are spent;
 *   - an `error` the service sends sorted once: a refusal of one event is
 *     logged and the session carries on; one that refuses the session's own
 *     settings (`voicelive/refusals.ts`) ends it as `refused`;
 *   - the ledger's renewal, on evidence a person is there: their speech
 *     starting, or the voice answering them.
 *
 * Neither direction is buffered without bound: a frame of the person's the
 * session cannot take now is dropped (`client.ts`), and a frame of the
 * voice's the browser cannot take is dropped too (`broker.ts`), each
 * counted; a browser that falls further behind than the socket's limit is
 * closed by the server. It owns the session while its claim lives, renewed
 * by a heartbeat, so a replica that died is known by its claim lapsing; the
 * same heartbeat reads the end the sweeper leaves in Redis, so a cutoff the
 * channel did not deliver still ends the session. However the session ends
 * — the person, the ledger's cutoff, the service, either socket, a drain —
 * it ends once: the ledger settled, the pane told, the person's last words
 * waited for while the socket can still carry them, the voice agent's
 * socket closed, the thread written, the pane told the thread is ready, and
 * the browser's socket closed. A thread that could not be written keeps its
 * transcript in Redis until the session's keys expire.
 */

/** The browser's side of a session, as the broker holds its socket. */
export interface BrowserLink {
	/** A text frame; nothing once the socket has gone. */
	send(message: ServerMessage): void;
	/** A frame of the voice's audio; false when it was dropped because the browser is behind. */
	audio(pcm: Uint8Array): boolean;
	close(code: number, reason: string): void;
}

/** What a session is opened as, once the binding and the ledger have both said yes. */
export interface OwnedSession {
	id: string;
	record: SessionRecord;
	binding: LiveVoiceBinding;
	store: SessionStore;
	tier: Tier;
	/** The ledger's idle window: how often a renewal is due while somebody is there. */
	idleSeconds: number;
	/** The surface usage lines carry. */
	surface: string;
	/** The caller's own check that its account is still the one admitted, handed to the settle (`LiveVoiceRequest.stillAdmitted`). */
	stillAdmitted?: LiveVoiceRequest["stillAdmitted"];
}

export interface OwnerDeps {
	host: Pick<AgentHost, "settleLiveVoice">;
	keys: VoiceKeys;
	replica: string;
	settings: VoiceSettings["live"];
	/** How long the owner's claim lives without a heartbeat. */
	ownerTtlMs: number;
}

/** How the session ended, and what its thread holds of it. */
export interface OwnerEnd {
	reason: EndReason;
	written: number;
}

const NOT_ANSWERED = JSON.stringify({ error: "not_answered" });
/** The transcript is kept at most this often while it grows. */
const KEEP_EVERY_MS = 1_000;
/** A normal close: the session is over. */
const NORMAL = 1000;
/** The waits between the tries at writing the thread: a store that failed once often answers the next time. */
const SETTLE_RETRY_MS = [250, 1_000] as const;

/**
 * Write a session's words into its thread, tried again after a failure. The
 * host's settle is once-only per session, so a try whose answer was lost
 * writes nothing twice.
 */
export async function settleWithRetry<T>(settle: () => Promise<T>): Promise<T> {
	for (const wait of SETTLE_RETRY_MS) {
		try {
			return await settle();
		} catch {
			await Bun.sleep(wait);
		}
	}
	return settle();
}

/** Why the socket's close ended the session, when we did not close it. */
function reasonOf(close: VoiceAgentClose): EndReason {
	switch (close.kind) {
		case "expired":
			return "expired";
		case "server":
			return "service";
		case "client":
			return "client";
		default:
			return "failed";
	}
}

function parseArgs(raw: string): Record<string, unknown> {
	try {
		const parsed: unknown = JSON.parse(raw || "{}");
		return parsed && typeof parsed === "object" && !Array.isArray(parsed)
			? (parsed as Record<string, unknown>)
			: {};
	} catch {
		return {};
	}
}

/**
 * Whether the voice's words are an answer rather than a filler spoken while
 * a tool runs: the cascade places its filler in the conversation under an
 * item the service names `interim_…`, and speech-to-speech puts its filler
 * out without placing it. Known from how the service behaves; neither is
 * documented.
 */
function isAnswer(itemId: string, placed: ReadonlySet<string>): boolean {
	return placed.has(itemId) && !itemId.startsWith("interim_");
}

type Call = Extract<
	ServerEvent,
	{ type: "response.function_call_arguments.done" }
>;

/** A response's calls this side answers, and whether the response has ended. */
interface Answering {
	calls: Set<string>;
	done: boolean;
}

const AUDIO = new Set<string>(ASSISTANT_AUDIO);

/** One line of what the screen shows, as the browser reports it. */
type ScreenLine = Extract<BrowserMessage, { type: "screen" }>["lines"][number];

export class SessionOwner {
	readonly transcript = new SessionTranscript();
	/** What the person sent and the service heard, logged once at the end. */
	private readonly hearing = new Hearing();
	private connection: VoiceAgentConnection | null = null;
	private inbox: Subscription | null = null;
	private heartbeat?: ReturnType<typeof setInterval>;
	private keeping?: ReturnType<typeof setTimeout>;
	/** Whether the browser has been told the session is ready: nothing reaches it before. */
	private live = false;
	/** Stage calls open in the browser, each with its deadline. */
	private readonly calls = new Map<string, ReturnType<typeof setTimeout>>();
	/** Calls that came before the socket was handed over, answered once it is. */
	private early: Call[] = [];
	/** The calls of each response this side answers: the voice goes on once all are. */
	private readonly answering = new Map<string, Answering>();
	private readonly started = new Map<string, number>();
	/** When each open response's audio began, for its usage line; and the response audio with no id of its own is taken to be. */
	private readonly spoke = new Map<string, number>();
	private lastResponse = "";
	/** The voice's items heard so far this turn: an item's first audio is when the person hears it. */
	private readonly voiced = new Set<string>();
	/** What each turn made the person wait, written once a turn (`turn-timing.ts`). */
	private readonly clock: TurnClock;
	private renewedAt = Date.now();
	private renewing = false;
	/** Audio frames the browser could not take. */
	private droppedOut = 0;
	/** What the session's calls retrieved since the person last spoke, for the sources under the answer. */
	private retrieved: DocumentSource[] = [];
	/** Responses that called a tool that retrieves, whose words come before what it found, never the answer the sources go under. */
	private readonly retrieving = new Set<string>();
	/** The voice's items the session placed in its conversation: a filler spoken on speech-to-speech is put out and never placed. */
	private readonly placed = new Set<string>();
	/** Each response's answer words, fillers left out, for the sources decided when it is done. */
	private readonly answers = new Map<string, string>();
	/** Responses let go on with the backend's answers since the person last spoke: bounded by the binding's `maxSteps`, as a typed turn's steps are. */
	private rounds = 0;
	/** Typed messages so far: each is an item under an id of the client's. */
	private typedCount = 0;
	/** What the browser may send beyond a frame's size (`input-budget.ts`): its audio, */
	private readonly audioBudget = new Bucket(
		INPUT_BUDGET.audioBytesPerSecond,
		INPUT_BUDGET.audioBurstBytes,
	);
	/** Bytes of audio refused as faster than a microphone makes it, in all, for the session's summary; */
	private audioRefused = 0;
	/** and what may still be refused before the session ends, refilled as refusals are forgiven. */
	private readonly audioRefusedAllowance = refusedAudioAllowance();
	/** its typed messages, */
	private readonly typedBudget = new Bucket(
		INPUT_BUDGET.typedPerSecond,
		INPUT_BUDGET.typedBurst,
	);
	/** Bytes of typed words taken so far, and messages refused. */
	private typedBytes = 0;
	private typedRefused = 0;
	/** and its screen: the latest lines not yet sent on, and when the last were. */
	private screenOwed: readonly ScreenLine[] | null = null;
	private screenAt = 0;
	private screening?: ReturnType<typeof setTimeout>;
	/** A `response.create` owed while a response was open: asked for once it is done. */
	private askOwed = false;
	/** Asks made again this turn after a response failed with nothing said. */
	private failures = 0;
	/** Whether the voice has been told this turn that its answer could not be had: once a turn. */
	private admitted = false;
	/** The pending ask after a failure, withdrawn by speech, another response, or the end. */
	private retrying?: ReturnType<typeof setTimeout>;
	/** An error refusing the session's settings that came before the session was handed over: the broker reads it. */
	private refusedEarly: string | null = null;
	private ending: Promise<OwnerEnd> | null = null;
	private readonly over = Promise.withResolvers<OwnerEnd>();
	/** Resolves once, when the session has ended and its thread is settled. */
	readonly done = this.over.promise;

	constructor(
		readonly session: OwnedSession,
		private readonly browser: BrowserLink,
		private readonly deps: OwnerDeps,
	) {
		this.clock = new TurnClock({
			id: session.id,
			surface: session.surface,
			model: `${session.binding.agentName}:${session.binding.version}`,
		});
	}

	get id(): string {
		return this.session.id;
	}

	/** Every event from the first: the audio, the record, the pane, the calls. */
	readonly observe = (event: ServerEvent): void => {
		if (AUDIO.has(event.type)) {
			const { delta, response_id, item_id } = event as {
				delta?: unknown;
				response_id?: string;
				item_id?: string;
			};
			const response = response_id ?? this.lastResponse;
			// Only for a response still open: its `response.done` takes the entry out, and nothing would take out one set after it.
			if (this.started.has(response) && !this.spoke.has(response))
				this.spoke.set(response, performance.now());
			const item = item_id ?? response;
			if (!this.voiced.has(item)) {
				this.voiced.add(item);
				this.clock.audio(isAnswer(item, this.placed));
			}
			if (this.live && !this.ending && typeof delta === "string")
				this.voice(delta);
			return;
		}
		this.transcript.observe(event);
		switch (event.type) {
			case "input_audio_buffer.speech_started":
				if (this.started.size) this.clock.spokenOver();
				this.withdrawRetry();
				this.hearing.speechStarted();
				this.renewSoon();
				this.emit({ type: "speech", state: "started" });
				break;
			case "input_audio_buffer.speech_stopped":
				this.clock.heard();
				this.emit({ type: "speech", state: "stopped" });
				break;
			case "input_audio_buffer.committed":
				// The person spoke again: a new turn, and what was retrieved before answered the one before.
				this.newTurn("spoken");
				break;
			case "conversation.item.added":
			case "conversation.item.created":
				if (event.item.type === "message" && event.item.role === "assistant")
					this.placed.add(event.item.id);
				break;
			case "response.created":
				this.withdrawRetry();
				this.renewSoon();
				this.started.set(event.response.id, performance.now());
				this.lastResponse = event.response.id;
				this.clock.response();
				this.emit({ type: "response", state: "started" });
				break;
			case "response.done":
				this.responded(event.response);
				this.keepSoon();
				break;
			case USER_FINAL:
				if (event.transcript.trim())
					this.emit({ type: "line", role: "user", text: event.transcript });
				this.keepSoon();
				break;
			case "response.output_audio_transcript.done":
			case "response.audio_transcript.done":
				if (event.transcript.trim()) {
					this.emit({
						type: "line",
						role: "assistant",
						text: event.transcript,
					});
					if (isAnswer(event.item_id, this.placed))
						this.answers.set(
							event.response_id,
							`${this.answers.get(event.response_id) ?? ""} ${event.transcript}`,
						);
				}
				this.keepSoon();
				break;
			case "response.function_call_arguments.done":
				if (
					event.response_id &&
					this.session.binding.tools.onServer(event.name)
				)
					this.retrieving.add(event.response_id);
				// A session that is ending answers no call: nothing runs as the person, and the stage is sent nothing, once its end is told.
				if (this.ending) break;
				this.expect(event);
				if (this.live) this.run(event);
				else this.early.push(event);
				break;
			case "error":
				this.refusal(event.error);
				break;
			case "malformed":
				console.warn(
					`[voice] session ${this.id}: ${event.name || "an event"} was malformed (${event.problem})`,
				);
				break;
		}
	};

	/**
	 * Take the voice agent's socket, as soon as it is open: whatever then
	 * ends the session — a refusal before it was ever ready included — closes
	 * it.
	 */
	hold(connection: VoiceAgentConnection): void {
		this.connection = connection;
	}

	/**
	 * Run the session, its socket held and its claim already this replica's:
	 * hear the sweeper's end, keep the claim alive, end when the socket does,
	 * and tell the browser it may speak. False when the subscription could
	 * not be made: Redis is required.
	 */
	async start(
		ready: Extract<ServerMessage, { type: "ready" }>,
	): Promise<boolean> {
		const connection = this.connection;
		if (!connection) return false;
		const { keys, ownerTtlMs } = this.deps;
		this.inbox = await subscribe(keys.inbox(this.id), (raw) => {
			const message = readInbox(raw);
			if (message) void this.end(message.reason);
		});
		if (!this.inbox) return false;
		this.heartbeat = setInterval(
			() => void this.beat().catch(() => {}),
			Math.max(Math.floor(ownerTtlMs / 3), 250),
		);
		this.heartbeat.unref?.();
		void connection.closed.then((close) => {
			if (!this.ending) void this.end(reasonOf(close));
		});
		this.live = true;
		this.renewedAt = Date.now();
		this.browser.send(ready);
		for (const call of this.early.splice(0)) this.run(call);
		return true;
	}

	/**
	 * The heartbeat: the claim kept — through the end too, until the thread
	 * is written, so no other replica settles a session this one is still
	 * settling — taken again when an outage outlasted it, since the sockets
	 * are still here, and the end the sweeper left read, which is how a
	 * cutoff reaches an owner the channel did not.
	 */
	private async beat(): Promise<void> {
		const { keys, replica, ownerTtlMs } = this.deps;
		const claim = keys.owner(this.id);
		const kept = await extendClaim(claim, replica, ownerTtlMs);
		// An ending session keeps the claim it has until its thread is written, and takes none again: its end releases it.
		if (this.ending) return;
		if (kept === "not-held") await claimOnce(claim, replica, ownerTtlMs);
		const asked = await this.session.store.endAsked();
		if (asked) void this.end(asked);
	}

	/** A call answered in the background: a tool that throws answers the voice with an error and leaves the session standing. */
	private run(event: Call): void {
		void this.call(event).catch((err: Error) => {
			console.error(
				`[voice] session ${this.id}: ${event.name} failed:`,
				err.name,
			);
			this.output(event.call_id, NOT_AVAILABLE_OUTPUT);
		});
	}

	/** A text frame from the browser, already read. */
	// Called on `session.owner` in broker.ts, a reach fallow 3.35 does not follow.
	// fallow-ignore-next-line unused-class-member
	fromBrowser(message: Exclude<BrowserMessage, { type: "start" }>): void {
		if (!this.live || this.ending) return;
		switch (message.type) {
			case "tool-output":
				this.answered(message.callId, message.output);
				return;
			case "screen":
				this.screen(message.lines);
				return;
			case "text":
				this.typed(message.text);
				return;
			case "end":
				void this.end("client");
		}
	}

	/**
	 * What the screen shows now: sent on at once when the last was a while
	 * ago, and otherwise kept — the latest only — until the interval is over,
	 * so a screen that changes with every keystroke is one item a second.
	 */
	private screen(lines: readonly ScreenLine[]): void {
		this.screenOwed = lines;
		if (this.screening) return;
		const wait = this.screenAt + INPUT_BUDGET.screenIntervalMs - Date.now();
		if (wait <= 0) {
			this.showScreen();
			return;
		}
		this.screening = setTimeout(() => {
			this.screening = undefined;
			if (!this.ending) this.showScreen();
		}, wait);
		this.screening.unref?.();
	}

	private showScreen(): void {
		const lines = this.screenOwed;
		this.screenOwed = null;
		if (!lines) return;
		this.screenAt = Date.now();
		const note = renderLiveContextBlock(
			lines.map((line) => `${line.label}: ${line.value}`),
		);
		if (note)
			this.send({
				type: "conversation.item.create",
				item: {
					type: "message",
					role: "system",
					content: [{ type: "input_text", text: note }],
				},
			});
	}

	/**
	 * Words the person typed while the channel is open: one item of theirs,
	 * written down as said, shown in the pane, and answered by the voice —
	 * now, or once the answer in flight is done, since a session has one
	 * response at a time. A message beyond what a session takes
	 * (`input-budget.ts`) is none of that: the pane is told it was not taken.
	 */
	private typed(text: string): void {
		const bytes = Buffer.byteLength(text);
		const refused =
			this.typedBytes + bytes > INPUT_BUDGET.typedBytesPerSession
				? "text.session_full"
				: this.typedBudget.take(1)
					? null
					: "text.too_fast";
		if (refused) {
			this.typedRefused++;
			this.emit({ type: "error", code: refused });
			return;
		}
		this.typedBytes += bytes;
		const id = `typed_${++this.typedCount}`;
		this.newTurn("typed");
		this.transcript.typed(id, text);
		if (
			!this.send({
				type: "conversation.item.create",
				item: {
					id,
					type: "message",
					role: "user",
					content: [{ type: "input_text", text }],
				},
			})
		)
			return;
		this.emit({ type: "line", role: "user", text });
		this.keepSoon();
		this.renewSoon();
		this.ask();
	}

	/**
	 * The code of an error that refused the session's own settings before it
	 * was handed over, or null: the broker refuses the open on it rather than
	 * telling the browser the session is ready.
	 */
	get refusedBeforeReady(): string | null {
		return this.refusedEarly;
	}

	/**
	 * A frame of the person's audio: appended now, or dropped. Audio that
	 * comes faster than a microphone makes it (`input-budget.ts`) is dropped
	 * before it is counted or sent on, and a minute of it, refused faster
	 * than it is forgiven, ends the session.
	 */
	// Called on `session.owner` in broker.ts, a reach fallow 3.35 does not follow.
	// fallow-ignore-next-line unused-class-member
	audio(pcm: Uint8Array): void {
		if (!this.live || this.ending || !pcm.byteLength) return;
		if (!this.audioBudget.take(pcm.byteLength)) {
			this.audioRefused += pcm.byteLength;
			if (!this.audioRefusedAllowance.take(pcm.byteLength)) {
				voiceProblems.report("voice.live.input_refused", {
					bound: "audio",
					measured: this.audioRefused,
					limit: INPUT_BUDGET.audioRefusedBytesEnd,
				});
				void this.end("failed");
			}
			return;
		}
		this.hearing.frame(pcm);
		this.connection?.append(Buffer.from(pcm).toString("base64"));
	}

	/** End the session, once; every caller gets the same end. `graceMs`: say so, then wait before closing (a drain). */
	end(requested: EndReason, graceMs = 0): Promise<OwnerEnd> {
		this.ending ??= this.finish(requested, graceMs)
			.then((end) => {
				this.over.resolve(end);
				return end;
			})
			// The claim is kept while the end runs, and no longer than it.
			.finally(() => clearInterval(this.heartbeat));
		return this.ending;
	}

	private async finish(
		requested: EndReason,
		graceMs: number,
	): Promise<OwnerEnd> {
		const { record, store } = this.session;
		// The ledger first: a cutoff already settled it, and its note says why.
		const settled = await endSession(this.id, record.subject).catch(() => null);
		const reason: EndReason =
			settled && settled.ended !== "client" ? settled.ended : requested;
		this.emit({ type: "ending", reason });
		console.log(
			`[voice] session ${this.id} ending (${reason}): ${this.hearing.summary()}`,
		);
		if (graceMs > 0) await Bun.sleep(graceMs);
		this.clock.close();
		this.withdrawRetry();
		clearTimeout(this.keeping);
		clearTimeout(this.screening);
		for (const timer of this.calls.values()) clearTimeout(timer);
		this.calls.clear();
		await this.inbox?.close();
		const dropped = this.connection?.dropped ?? 0;
		if (dropped || this.droppedOut)
			console.warn(
				`[voice] session ${this.id}: ${dropped} frame(s) of the person's and ${this.droppedOut} of the voice's dropped as the sockets fell behind`,
			);
		if (this.audioRefused || this.typedRefused)
			console.warn(
				`[voice] session ${this.id}: ${this.audioRefused} byte(s) of audio and ${this.typedRefused} typed message(s) were beyond what a session takes from its browser, and not taken`,
			);
		// The person's last words are finals the service still owes: only an open socket can carry them.
		if (this.connection?.isOpen)
			await this.transcript.settled(this.deps.settings.settleWaitMs);
		await this.connection?.close(reason);
		let written = 0;
		let kept = false;
		try {
			const spoken = this.transcript.spoken();
			let tries = 0;
			const settlement = await settleWithRetry(() => {
				tries++;
				return this.deps.host.settleLiveVoice(
					record.resourceId,
					record.threadId,
					{
						sessionId: this.id,
						spoken,
						stillAdmitted: this.session.stillAdmitted,
					},
				);
			});
			// A try that failed after it wrote makes the next one a repeat that counts nothing: the lines are in the thread, at most as many as were said, and the browser reads the thread again on any count above none.
			written =
				settlement?.repeated && tries > 1
					? spoken.filter((item) => item.kind === "said").length
					: (settlement?.written ?? 0);
		} catch (err) {
			// The words are in no thread: the copy in Redis is the only one, and it stays.
			kept = true;
			await store.keepSpoken(this.transcript.spoken());
			voiceProblems.report("voice.live.unsettled", { status: 200 });
			console.error(
				`[voice] session ${this.id}: the thread was not written; its transcript is kept in Redis until the session's keys expire:`,
				(err as Error).message,
			);
		}
		this.emit({ type: "ended", reason, written });
		this.browser.close(NORMAL, reason);
		if (!kept) await store.forget();
		await releaseClaim(this.deps.keys.owner(this.id), this.deps.replica);
		return { reason, written };
	}

	/** A delta of the voice's audio, to the browser. */
	private voice(delta: string): void {
		if (!this.browser.audio(Buffer.from(delta, "base64"))) this.droppedOut++;
	}

	/** A call this side will answer, counted against its response as it arrives. */
	private expect(event: Call): void {
		const response = event.response_id ?? "";
		const answering = this.answering.get(response) ?? {
			calls: new Set<string>(),
			done: false,
		};
		answering.calls.add(event.call_id);
		this.answering.set(response, answering);
		this.clock.called(event.call_id, event.name);
	}

	/** A call the session made: a tool run here, or a control the browser runs. */
	private async call(event: Call): Promise<void> {
		const { tools } = this.session.binding;
		if (this.ending) return;
		if (tools.onServer(event.name)) {
			const { output, sources } = await tools.run(event.name, event.arguments);
			this.retrieved = uniqueSources(this.retrieved, sources);
			this.output(event.call_id, output);
			return;
		}
		if (!tools.inBrowser(event.name)) {
			console.warn(
				`[voice] session ${this.id}: ${event.name} is no tool of this session's; answered not_available`,
			);
			this.output(event.call_id, NOT_AVAILABLE_OUTPUT);
			return;
		}
		// The end clears every open call's timer; one set after it would outlive the session.
		if (this.ending) return;
		const callId = event.call_id;
		this.calls.set(
			callId,
			setTimeout(() => {
				voiceProblems.report("voice.live.stage_timeout", {
					reason: event.name,
				});
				this.emit({ type: "stage-call-closed", callId });
				this.answered(callId, NOT_ANSWERED);
			}, this.deps.settings.stageCallTimeoutMs),
		);
		this.emit({
			type: "stage-call",
			callId,
			name: event.name,
			args: parseArgs(event.arguments),
		});
	}

	/** A stage call's answer, once, while it is open; any other is ignored. */
	private answered(callId: string, output: string): void {
		const timer = this.calls.get(callId);
		if (!timer) return;
		clearTimeout(timer);
		this.calls.delete(callId);
		this.output(callId, output);
	}

	/** A call's output, and the voice let go on once its response's calls are all answered. */
	private output(callId: string, output: string): void {
		this.clock.returned(callId);
		// A tool that returns after the end is told answers nobody: the voice is asked for nothing more.
		if (this.ending) return;
		if (
			!this.send({
				type: "conversation.item.create",
				item: { type: "function_call_output", call_id: callId, output },
			})
		)
			return;
		for (const [response, answering] of this.answering)
			if (answering.calls.delete(callId)) this.goOn(response, answering);
	}

	/**
	 * Once a response has ended and every call of it is answered, the voice
	 * answers with what they returned — until the turn has asked for
	 * `maxSteps` responses so, when it ends as a typed turn at its step
	 * limit does: the last calls answered, nothing more asked for.
	 */
	private goOn(response: string, answering: Answering): void {
		if (!answering.done || answering.calls.size) return;
		this.answering.delete(response);
		if (++this.rounds >= this.session.binding.maxSteps) {
			voiceProblems.report("voice.live.max_steps", {
				measured: this.rounds,
			});
			console.warn(
				`[voice] session ${this.id}: the turn reached its ${this.rounds} steps; no further response is asked for`,
			);
			return;
		}
		this.ask();
	}

	/**
	 * Let the voice answer: now, or — while a response is open, which the
	 * service would refuse an ask beside (`conversation_already_has_active_response`)
	 * and not remember — once that response is done.
	 */
	private ask(): void {
		if (this.started.size > 0) {
			this.askOwed = true;
			return;
		}
		this.askOwed = false;
		this.send({ type: "response.create" });
	}

	/** The person spoke or typed: a new turn, its steps, its asks and what it retrieved begun afresh. */
	private newTurn(how: "spoken" | "typed"): void {
		this.clock.begin(how);
		this.voiced.clear();
		this.retrieved = [];
		this.rounds = 0;
		this.failures = 0;
		this.admitted = false;
	}

	private withdrawRetry(): void {
		clearTimeout(this.retrying);
		this.retrying = undefined;
	}

	/**
	 * A response that failed with nothing said: asked again after a backoff
	 * when asking again could answer, each ask a step of the turn's
	 * `maxSteps`; once the asks are spent, the voice told once to say it
	 * could not answer, and the pane told the same in the person's language.
	 * Logged every time, with the failure's type and code and never its
	 * message.
	 */
	private failed(failure: ResponseFailure): void {
		const { binding } = this.session;
		let decision = this.admitted
			? ({ action: "log" } as const)
			: retryDecision(failure, this.failures, this.deps.settings.responseRetry);
		if (decision.action === "retry" && ++this.rounds >= binding.maxSteps)
			decision = { action: "give_up" };
		const outcome =
			decision.action === "retry"
				? "retrying"
				: decision.action === "give_up"
					? "gave_up"
					: "not_retried";
		voiceProblems.report("voice.live.response_failed", {
			reason: failure.errorType ?? failure.reason ?? failure.status,
			bucket: failure.errorCode ?? "none",
			bound: outcome,
			measured: this.failures,
		});
		console.warn(
			`[voice] session ${this.id}: a response ended ${failure.status} with nothing said (type ${failure.errorType ?? "none"}, code ${failure.errorCode ?? "none"}); ${outcome}`,
		);
		if (decision.action === "retry") {
			this.failures = decision.attempt;
			this.withdrawRetry();
			this.retrying = setTimeout(() => {
				this.retrying = undefined;
				// Another response, or a call whose answer asks for itself, already stands in for this ask.
				if (this.ending || this.started.size || this.answering.size) return;
				this.send({ type: "response.create" });
			}, decision.delayMs);
			this.retrying.unref?.();
		} else if (decision.action === "give_up") this.admit();
	}

	/**
	 * The voice told, once, to say it could not get the answer, then asked to
	 * speak. A system item, never the response's own `instructions`:
	 * `response.instructions` replaces the session's instructions — the
	 * guardrails among them — for the response it is sent with.
	 */
	private admit(): void {
		this.admitted = true;
		this.clock.ended("unanswered");
		this.emit({ type: "error", code: "turn.unanswered" });
		if (
			this.send({
				type: "conversation.item.create",
				item: {
					type: "message",
					role: "system",
					content: [{ type: "input_text", text: UNANSWERED_NOTE }],
				},
			})
		)
			this.ask();
	}

	/**
	 * An `error` the service sent: one that refuses the session's own
	 * settings ends it as `refused` (before the session is handed over, the
	 * broker refuses the open on it); any other refused one event and the
	 * session carries on.
	 */
	private refusal(
		error: Extract<ServerEvent, { type: "error" }>["error"],
	): void {
		const code = error.code ?? error.type ?? "error";
		if (isRollbackEcho(error)) return;
		if (!isFatalError(error)) {
			// Codes only: a refusal's words can quote what it refused.
			console.warn(
				`[voice] session ${this.id}: the service refused one event (${code}${error.param ? `, ${error.param}` : ""})`,
			);
			return;
		}
		console.warn(
			`[voice] session ${this.id}: the service refused the session's settings (${code}${error.param ? `, ${error.param}` : ""})`,
		);
		if (!this.live) {
			this.refusedEarly ??= code;
			return;
		}
		voiceProblems.report("voice.live.session_refused", { reason: code });
		void this.end("refused");
	}

	/**
	 * The documents an answer drew on, once its response is done: only words
	 * that are not a filler, in a response that retrieved nothing itself —
	 * one that only drove the stage is an answer, as a typed turn's is.
	 */
	private sourcesAfter(responseId: string): void {
		const text = this.answers.get(responseId);
		this.answers.delete(responseId);
		if (this.retrieving.delete(responseId) || !text) return;
		if (!this.retrieved.length) return;
		const sources = namedSources(text, this.retrieved);
		this.retrieved = [];
		this.emit({ type: "sources", sources });
	}

	private responded(
		response: Extract<ServerEvent, { type: "response.done" }>["response"],
	): void {
		// Closed first: an ask this response's end lets go is asked now, not owed to itself.
		const began = this.started.get(response.id);
		this.started.delete(response.id);
		const spoke = this.spoke.get(response.id);
		this.spoke.delete(response.id);
		const answering = this.answering.get(response.id);
		if (answering) {
			answering.done = true;
			this.goOn(response.id, answering);
		}
		const { binding, surface } = this.session;
		const usage = response.usage ?? {};
		const number = (value: unknown) =>
			typeof value === "number" ? value : null;
		runInUsageScope({ turnId: this.id, surface }, () =>
			emitUsage({
				kind: "voice",
				// The runtime the session was opened on: a voice agent's version, or the Voice Live API itself.
				provider: binding.runtime ? "voice-live" : "foundry-voice-agent",
				model: `${binding.agentName}:${binding.version}`,
				finishReason: response.status ?? null,
				inputTokens: number(usage.input_tokens),
				outputTokens: number(usage.output_tokens),
				totalTokens: number(usage.total_tokens),
				// To the response's first audio: what the service took to begin speaking it.
				ttftMs:
					began === undefined || spoke === undefined ? null : spoke - began,
				durationMs: began === undefined ? 0 : performance.now() - began,
			}),
		);
		const blocked = /content_filter/.test(
			JSON.stringify(response.status_details ?? ""),
		);
		if (blocked) {
			voiceProblems.report("voice.live.blocked", { status: 200 });
			this.clock.ended("blocked");
			this.emit({ type: "error", code: "turn.blocked" });
			this.answers.delete(response.id);
			this.retrieving.delete(response.id);
		} else this.sourcesAfter(response.id);
		this.emit({ type: "response", state: "done" });
		if (this.ending) return;
		const failure = responseFailureOf(response);
		// A response with calls is let go on once they are answered: that ask stands for a retry, and for an owed one.
		if (failure && !answering && !blocked) this.failed(failure);
		else if (response.status === "completed") this.failures = 0;
		if (this.askOwed && !this.started.size && !this.answering.size) this.ask();
	}

	/**
	 * The ledger's renewal, at most once a quarter of the idle window, on
	 * evidence somebody is there. A refused charge leaves the session the
	 * window it paid for, and the ledger's cutoff ends it as `allowance`.
	 */
	private renewSoon(): void {
		const { id, record, tier, idleSeconds } = this.session;
		const now = Date.now();
		if (
			this.renewing ||
			this.ending ||
			idleSeconds <= 0 ||
			now - this.renewedAt < (idleSeconds * 1000) / 4
		)
			return;
		this.renewing = true;
		this.renewedAt = now;
		void renewSession(id, record.subject, tier)
			.then((outcome) => {
				if (outcome.ok || outcome.reason === "gone") return;
				voiceProblems.report("voice.renew.no_seconds", {
					status: 200,
					tier,
					retryAfterSeconds: outcome.retryAfterSeconds,
				});
			})
			.catch(() => {})
			.finally(() => {
				this.renewing = false;
			});
	}

	/** Keep the transcript so far, at most once a second, for a settle by another replica. */
	private keepSoon(): void {
		if (this.keeping || this.ending) return;
		this.keeping = setTimeout(() => {
			this.keeping = undefined;
			void this.session.store.keepSpoken(this.transcript.spoken());
		}, KEEP_EVERY_MS);
		this.keeping.unref?.();
	}

	private emit(event: LiveEvent): void {
		if (this.live) this.browser.send(event);
	}

	private send(event: ClientEvent): boolean {
		try {
			this.connection?.send(event);
			return Boolean(this.connection);
		} catch {
			return false;
		}
	}
}
