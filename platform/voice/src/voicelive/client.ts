import { type ClientEvent, readServerEvent, type ServerEvent } from "./events";

/**
 * A Foundry voice agent's session socket, on Bun's `WebSocket`. The backend opens it with its managed
 * identity: the project's voice endpoint for one agent, the version pinned,
 * storage off, the WebSocket transport, a session id of the backend's, and the
 * person's part in a header — never in the URL, which "can appear in server
 * or proxy logs". Everything of the session crosses it: the person's
 * audio in, the voice's audio out, the transcripts, the tool calls. Nothing
 * of `@azure/ai-projects`' realtime client is used: it owns the socket's
 * lifetime and its tracing, and the broker needs both.
 *
 * Six things make it a client rather than a socket:
 *
 *   - a bounded connect: it resolves once the service has announced the
 *     session (`session.created`), and refuses with a reason — the
 *     handshake refused, an `error` before the session, a close, the
 *     deadline, the caller's abort — never by hanging. A reader can hear
 *     everything from the first event (`observe`);
 *   - typed events, read once at the boundary (`events.ts`);
 *   - a send queue for the session's events: written in order, held while
 *     the socket's own buffer is full, and a queue that outgrows its bound
 *     closes the session rather than the heap;
 *   - audio that is never queued: a frame the socket cannot take now is
 *     dropped and counted ({@link VoiceAgentConnection.append}), because a
 *     person's words late are worse than a gap, and a stalled service must
 *     not grow the heap by the second;
 *   - close reasons: who ended the session and why, as one value every
 *     waiter and the caller read;
 *   - a bounded close: a peer that never answers ours is not waited for —
 *     the socket is torn down and the session reported closed by us.
 */

/** The opt-in every voice agents call carries, the socket included. */
const VOICE_AGENTS_PREVIEW = "VoiceAgents=V1Preview";

export interface VoiceAgentTarget {
	/** The project's endpoint: `https://<account>.services.ai.azure.com/api/projects/<project>`. */
	endpoint: string;
	agent: string;
	/** The version the session runs on, pinned so a new one never reaches an open session. */
	version: string;
	/** The backend's, the ledger's: the service's `agent_session_id`. */
	sessionId: string;
	/** The version's declared structured inputs, rendered for this person. */
	structuredInputs: Readonly<Record<string, string>>;
}

export interface ConnectOptions {
	/** A bearer for `https://ai.azure.com`, asked for at each connect. */
	token(): Promise<string>;
	/** How long the socket has to open and announce its session. */
	timeoutMs: number;
	signal?: AbortSignal;
	/** Events held unwritten past which the session is closed: a service that stopped reading must not grow the heap. */
	maxQueued?: number;
	/** Bytes the socket may hold unsent before the queue waits, and before audio is dropped. */
	highWaterBytes?: number;
	/** Hears every event from the first, the ones before the session is announced included. */
	observe?: (event: ServerEvent) => void;
	/** How long the peer has to answer our close before the socket is torn down without it. */
	closeTimeoutMs?: number;
}

/** What the service said about the session it opened. */
export interface VoiceAgentSession {
	id: string;
	conversationId: string | null;
	/** Milliseconds since the epoch; null when the service set none. */
	expiresAt: number | null;
	/** The instructions as the session holds them: the template rendered, or not. */
	instructions: string | null;
}

/**
 * How a session ended. `client`: we closed it. `expired`: the service closed
 * it at its `expires_at`. `server`: the service closed it otherwise, with
 * the code and reason it gave. `dropped`: the connection went with no close
 * at all. `overflow`: the send queue outgrew its bound and we closed it.
 */
export interface VoiceAgentClose {
	kind: "client" | "expired" | "server" | "dropped" | "overflow";
	code: number;
	reason: string;
}

type ConnectFailure = "refused" | "error" | "closed" | "timeout" | "aborted";

/** Why a session never opened. `code` is the service's own, when it gave one. */
export class VoiceAgentConnectError extends Error {
	constructor(
		readonly failure: ConnectFailure,
		message: string,
		readonly code: string | null = null,
	) {
		super(message);
		this.name = "VoiceAgentConnectError";
	}
}

/** A send, or a wait, on a session that has ended. */
export class VoiceAgentClosed extends Error {
	constructor(readonly close: VoiceAgentClose) {
		super(`the voice session is closed (${close.kind} ${close.code})`);
		this.name = "VoiceAgentClosed";
	}
}

/** A wait for an answer the service did not give in time. */
export class VoiceAgentTimeout extends Error {
	constructor(what: string, timeoutMs: number) {
		super(`no ${what} within ${timeoutMs} ms`);
		this.name = "VoiceAgentTimeout";
	}
}

export interface VoiceAgentConnection {
	readonly session: VoiceAgentSession;
	/** Resolves once, with how it ended, whoever ended it. */
	readonly closed: Promise<VoiceAgentClose>;
	readonly isOpen: boolean;
	/** Queue one event; throws {@link VoiceAgentClosed} once the session has ended. */
	send(event: ClientEvent): void;
	/**
	 * The person's audio, PCM16 in base64, written now or not at all: false
	 * when the session has ended, or the socket is still holding what went
	 * before (the frame is dropped and counted in {@link dropped}).
	 */
	append(audio: string): boolean;
	/** Audio frames dropped because the socket could not take them. */
	readonly dropped: number;
	/** Every event from now on, in order; returns the unsubscribe. */
	subscribe(listener: (event: ServerEvent) => void): () => void;
	/**
	 * The first event from now on that `pick` answers for. Rejects with
	 * {@link VoiceAgentTimeout} after `timeoutMs`, and with
	 * {@link VoiceAgentClosed} when the session ends first.
	 */
	next<T>(
		pick: (event: ServerEvent) => T | undefined,
		options: { timeoutMs: number; what: string },
	): Promise<T>;
	/** Close it from our side: resolved by the peer's answer, or without it once it has had its time. */
	close(reason?: string): Promise<VoiceAgentClose>;
}

const DEFAULT_MAX_QUEUED = 256;
/** About four seconds of the person's audio as the socket carries it (base64 PCM16 at 24 kHz). */
const DEFAULT_HIGH_WATER_BYTES = 256 * 1024;
const DRAIN_RETRY_MS = 10;
/** How long our close waits for the peer's before the socket is torn down. */
const DEFAULT_CLOSE_TIMEOUT_MS = 2_000;
/** A service closing within this of its own `expires_at` closed for that. */
const EXPIRY_SLACK_MS = 2_000;
/** A normal close from the client's side, the only code a client may send below 3000. */
const NORMAL = 1000;
/** No close frame: the connection went. */
const ABNORMAL = 1006;

/** Plain `ws:` only to this machine, as a test's stand-in is: the socket carries a bearer. */
function socketScheme(endpoint: URL): "wss:" | "ws:" {
	if (endpoint.protocol === "https:") return "wss:";
	if (["localhost", "127.0.0.1", "[::1]"].includes(endpoint.hostname))
		return "ws:";
	throw new Error(
		"the project endpoint must be https: the socket carries a bearer token",
	);
}

export function voiceAgentUrl(target: VoiceAgentTarget): string {
	const endpoint = new URL(target.endpoint.replace(/\/+$/, ""));
	const query = new URLSearchParams({
		"api-version": "v1",
		"x-agent-version-override": target.version,
		// Never true: nothing of a session is kept at Foundry (Q3).
		store: "false",
		// Everything crosses this socket, the audio included.
		transport: "websocket",
		agent_session_id: target.sessionId,
	});
	const agent = encodeURIComponent(target.agent);
	return `${socketScheme(endpoint)}//${endpoint.host}${endpoint.pathname}/agents/${agent}/endpoint/protocols/voice?${query}`;
}

/**
 * JSON that is also a valid header value. A header carries bytes of
 * Latin-1, and a person's part is any language's words — an em dash, a
 * name in Polish, Italian accents — which the socket refuses to send as
 * they are. Every character past ASCII is escaped as JSON escapes it
 * (`\uXXXX`), so the service parses the same string back.
 */
function headerJson(value: unknown): string {
	return JSON.stringify(value).replace(
		/[\u007f-￿]/g,
		(c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`,
	);
}

function voiceAgentHeaders(
	token: string,
	structuredInputs: Readonly<Record<string, string>>,
): Record<string, string> {
	return {
		authorization: `Bearer ${token}`,
		"foundry-features": VOICE_AGENTS_PREVIEW,
		"x-ms-voice-structured-inputs": headerJson(structuredInputs),
	};
}

/** `expires_at` as the wire has it, seconds since the epoch, or an ISO date. */
function expiryOf(value: number | string | null | undefined): number | null {
	if (typeof value === "number") return value * 1000;
	if (typeof value === "string") {
		const at = Date.parse(value);
		return Number.isNaN(at) ? null : at;
	}
	return null;
}

/**
 * A session of the Voice Live API itself, on a model it hosts: no agent, no
 * version and no preview opt-in. The account's own host (the project
 * endpoint's), so the network path is the voice agent's. The API version is
 * a generally available one: its reference marks no `-preview`.
 */
export interface VoiceLiveTarget {
	kind: "voiceLive";
	/** The project's endpoint, as for a voice agent: only its host is used. */
	endpoint: string;
	/** A model Voice Live hosts (`voice-models.ts`). */
	model: string;
}

export const VOICE_LIVE_API_VERSION = "2026-07-15";

export function voiceLiveUrl(target: VoiceLiveTarget): string {
	const endpoint = new URL(target.endpoint);
	const query = new URLSearchParams({
		"api-version": VOICE_LIVE_API_VERSION,
		model: target.model,
	});
	return `${socketScheme(endpoint)}//${endpoint.host}/voice-live/realtime?${query}`;
}

export type SessionTarget = VoiceAgentTarget | VoiceLiveTarget;

function isVoiceLive(target: SessionTarget): target is VoiceLiveTarget {
	return "kind" in target && target.kind === "voiceLive";
}

/** The socket to a voice agent or to Voice Live: the same protocol and the same client either way. */
export async function connectVoiceAgent(
	target: SessionTarget,
	options: ConnectOptions,
): Promise<VoiceAgentConnection> {
	const url = isVoiceLive(target)
		? voiceLiveUrl(target)
		: voiceAgentUrl(target);
	if (options.signal?.aborted)
		throw new VoiceAgentConnectError("aborted", "the connect was abandoned");
	const token = await options.token();
	const ws = new WebSocket(url, {
		headers: isVoiceLive(target)
			? { authorization: `Bearer ${token}` }
			: voiceAgentHeaders(token, target.structuredInputs),
		protocols: ["realtime"],
	});
	return new Connection(ws, options).opened();
}

class Connection implements VoiceAgentConnection {
	private readonly listeners = new Set<(event: ServerEvent) => void>();
	/** Whoever waits on the session: each is told once, when it ends. */
	private readonly waiters = new Set<(close: VoiceAgentClose) => void>();
	private readonly queue: string[] = [];
	private readonly maxQueued: number;
	private readonly highWater: number;
	private drainTimer: ReturnType<typeof setTimeout> | null = null;
	private closeTimer: ReturnType<typeof setTimeout> | null = null;
	private readonly closeTimeoutMs: number;
	dropped = 0;
	/** Whether the upgrade was answered: a close before it is a refused handshake. */
	private upgraded = false;
	/** Why we are closing it, before the socket says it closed. */
	private ending: VoiceAgentClose["kind"] | null = null;
	/** Why we closed, reported as the reason: the peer's close echo need not repeat it. */
	private ownReason: string | null = null;
	private ended: VoiceAgentClose | null = null;
	private announced: VoiceAgentSession | null = null;
	private readonly done = Promise.withResolvers<VoiceAgentClose>();
	readonly closed = this.done.promise;

	constructor(
		private readonly ws: WebSocket,
		private readonly options: ConnectOptions,
	) {
		this.maxQueued = options.maxQueued ?? DEFAULT_MAX_QUEUED;
		this.highWater = options.highWaterBytes ?? DEFAULT_HIGH_WATER_BYTES;
		this.closeTimeoutMs = options.closeTimeoutMs ?? DEFAULT_CLOSE_TIMEOUT_MS;
		if (options.observe) this.listeners.add(options.observe);
		ws.addEventListener("open", () => {
			this.upgraded = true;
		});
		ws.addEventListener("message", (message) => {
			const event = readServerEvent(String(message.data));
			for (const listener of [...this.listeners])
				try {
					listener(event);
				} catch (err) {
					// One reader's fault is not the session's: the others still hear the event.
					console.error(
						`[voice] a listener failed on ${event.type}:`,
						(err as Error).message,
					);
				}
		});
		ws.addEventListener("close", (event) => this.finish(event));
	}

	get session(): VoiceAgentSession {
		if (!this.announced) throw new Error("the session has not been announced");
		return this.announced;
	}

	get isOpen(): boolean {
		return this.ended === null && this.ws.readyState === WebSocket.OPEN;
	}

	/** The session, once the service announces it; otherwise why not. */
	async opened(): Promise<this> {
		const { signal, timeoutMs } = this.options;
		const outcome = Promise.withResolvers<VoiceAgentSession>();
		let handshake = "the handshake was refused";
		const onError = (event: Event) => {
			handshake = (event as ErrorEvent).message || handshake;
		};
		const onAbort = () =>
			outcome.reject(
				new VoiceAgentConnectError("aborted", "the connect was abandoned"),
			);
		const onClose = (close: VoiceAgentClose) =>
			outcome.reject(
				this.upgraded
					? new VoiceAgentConnectError(
							"closed",
							`the service closed the socket before the session (${close.code} ${close.reason})`,
						)
					: new VoiceAgentConnectError("refused", handshake),
			);
		this.ws.addEventListener("error", onError);
		signal?.addEventListener("abort", onAbort, { once: true });
		this.waiters.add(onClose);
		const timer = setTimeout(
			() =>
				outcome.reject(
					new VoiceAgentConnectError(
						"timeout",
						`no session within ${timeoutMs} ms`,
					),
				),
			timeoutMs,
		);
		const unsubscribe = this.subscribe((event) => {
			if (event.type === "session.created")
				outcome.resolve({
					id: event.session.id,
					conversationId: event.conversation_id ?? null,
					expiresAt: expiryOf(event.session.expires_at),
					instructions: event.session.instructions ?? null,
				});
			else if (event.type === "error")
				outcome.reject(
					new VoiceAgentConnectError(
						"error",
						event.error.message ?? "the service refused the session",
						event.error.code ?? null,
					),
				);
		});
		try {
			this.announced = await outcome.promise;
			return this;
		} catch (err) {
			if (!this.ended && !this.ending)
				this.shut("client", "the session never opened");
			throw err;
		} finally {
			clearTimeout(timer);
			unsubscribe();
			this.waiters.delete(onClose);
			signal?.removeEventListener("abort", onAbort);
			this.ws.removeEventListener("error", onError);
		}
	}

	send(event: ClientEvent): void {
		if (this.ended) throw new VoiceAgentClosed(this.ended);
		if (this.ending) throw new VoiceAgentClosed(this.closing());
		this.queue.push(JSON.stringify(event));
		if (this.queue.length > this.maxQueued) {
			this.shut("overflow", "send queue overflow");
			throw new VoiceAgentClosed(this.closing());
		}
		this.drain();
	}

	append(audio: string): boolean {
		if (this.ended || this.ending || this.ws.readyState !== WebSocket.OPEN)
			return false;
		// Behind queued events, or behind a full buffer: a frame now would be late, or would grow the heap.
		if (this.queue.length || this.ws.bufferedAmount > this.highWater) {
			this.dropped++;
			return false;
		}
		this.ws.send(
			JSON.stringify({
				type: "input_audio_buffer.append",
				audio,
			} satisfies ClientEvent),
		);
		return true;
	}

	/** Write what the socket will take now, in order, and come back for the rest. */
	private drain(): void {
		// One pending retry at a time, however many sends come while the socket is full.
		if (this.drainTimer) clearTimeout(this.drainTimer);
		this.drainTimer = null;
		while (
			this.queue.length &&
			this.ws.readyState === WebSocket.OPEN &&
			this.ws.bufferedAmount <= this.highWater
		)
			this.ws.send(this.queue.shift() as string);
		if (this.queue.length && this.ws.readyState === WebSocket.OPEN)
			this.drainTimer ??= setTimeout(() => this.drain(), DRAIN_RETRY_MS);
	}

	subscribe(listener: (event: ServerEvent) => void): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	next<T>(
		pick: (event: ServerEvent) => T | undefined,
		options: { timeoutMs: number; what: string },
	): Promise<T> {
		if (this.ended) return Promise.reject(new VoiceAgentClosed(this.ended));
		const answer = Promise.withResolvers<T>();
		const onClose = (close: VoiceAgentClose) =>
			answer.reject(new VoiceAgentClosed(close));
		this.waiters.add(onClose);
		const unsubscribe = this.subscribe((event) => {
			const picked = pick(event);
			if (picked !== undefined) answer.resolve(picked);
		});
		const timer = setTimeout(
			() =>
				answer.reject(new VoiceAgentTimeout(options.what, options.timeoutMs)),
			options.timeoutMs,
		);
		return answer.promise.finally(() => {
			clearTimeout(timer);
			unsubscribe();
			this.waiters.delete(onClose);
		});
	}

	async close(reason = "done"): Promise<VoiceAgentClose> {
		if (!this.ended && !this.ending) this.shut("client", reason);
		return this.closed;
	}

	/** Close from the client's side, remembering why, so the close event is read as the client's. */
	private shut(kind: VoiceAgentClose["kind"], reason: string): void {
		this.ending = kind;
		this.ownReason = reason;
		this.queue.length = 0;
		if (
			this.ws.readyState === WebSocket.OPEN ||
			this.ws.readyState === WebSocket.CONNECTING
		) {
			this.ws.close(NORMAL, reason);
			// A peer that upgraded and went silent never answers the close.
			this.closeTimer = setTimeout(() => {
				this.closeTimer = null;
				if (this.ended) return;
				this.ws.terminate();
				this.finish({ code: ABNORMAL, reason });
			}, this.closeTimeoutMs);
			this.closeTimer.unref?.();
		} else this.finish({ code: NORMAL, reason });
	}

	/** The close as it will be reported, before the socket has said it closed. */
	private closing(): VoiceAgentClose {
		return { kind: this.ending ?? "client", code: NORMAL, reason: "closing" };
	}

	private finish(event: Pick<CloseEvent, "code" | "reason">): void {
		if (this.ended) return;
		if (this.drainTimer) clearTimeout(this.drainTimer);
		if (this.closeTimer) clearTimeout(this.closeTimer);
		this.queue.length = 0;
		const expiresAt = this.announced?.expiresAt;
		const kind: VoiceAgentClose["kind"] =
			this.ending ??
			(event.code === ABNORMAL
				? "dropped"
				: expiresAt && Date.now() >= expiresAt - EXPIRY_SLACK_MS
					? "expired"
					: "server");
		this.ended = {
			kind,
			code: event.code,
			reason: this.ownReason ?? event.reason,
		};
		for (const waiter of [...this.waiters]) waiter(this.ended);
		this.waiters.clear();
		this.done.resolve(this.ended);
	}
}
