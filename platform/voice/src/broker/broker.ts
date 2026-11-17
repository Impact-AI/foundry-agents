import type {
	AgentHost,
	CallerIdentity,
	LiveVoiceBinding,
	LiveVoiceRefusal,
	LiveVoiceRequest,
	VoiceTuning,
} from "@platform/agent";
import {
	chargeSeconds,
	endSession,
	getLimits,
	type HangupResult,
	isSubjectLive,
	liveCapacity,
	meterCall,
	rateLimitedResponse,
	recordSession,
	refundSeconds,
	sessionBounds,
	startSweeper,
	UNAVAILABLE_RETRY_SECONDS,
} from "@platform/metering";
import {
	claimHolder,
	claimOnce,
	isRedisConfigured,
	type KeyNamespace,
	publish,
	redisAnswers,
} from "@platform/redis";
import type { VoiceCaller } from "../caller";
import { voiceProblems } from "../problems";
import {
	faultResponse,
	type LiveRefusal,
	liveRefusedResponse,
} from "../refusal";
import { type VoiceSettings, voiceSettings } from "../settings";
import {
	type SessionTarget,
	VoiceAgentConnectError,
} from "../voicelive/client";
import {
	type OpenedSession,
	openSession,
	SessionSettingsRefused,
} from "../voicelive/exchange";
import { type VoiceKeys, voiceKeys } from "./keys";
import {
	AUDIO_SAMPLE_RATE,
	type BrowserMessage,
	type InboxMessage,
	MAX_AUDIO_FRAME_BYTES,
	readBrowserMessage,
	type ServerMessage,
	screenOf,
} from "./messages";
import { type BrowserLink, SessionOwner, settleWithRetry } from "./owner";
import { type SessionRecord, type SessionStore, sessionStore } from "./store";

/**
 * Live voice, relayed: one WebSocket from the
 * browser to this backend — through the frontend's own origin, under the
 * caller its server verified — and one from this backend to the voice
 * agent, opened with the process's managed identity. Both sockets of a
 * session are held by the replica the browser's socket reached, so the
 * audio crosses one process and no other replica is involved: nothing about
 * a session is sticky, because a session is one connection. The browser
 * holds no credential and never reaches the service; only this backend
 * talks to Foundry, which is why a hardened project, closed to the
 * internet, serves voice as it serves typed turns.
 *
 * The browser's first message is `start` — the thread and the screen —
 * and the session is admitted in the ledger's order: every refusal that
 * spends nothing before the seconds are charged, the charge before the
 * service, the thread bound by the host before the socket, the record after
 * it; a refusal is answered on the socket in the shape an HTTP route
 * would have answered it, and the socket closed. A session that cannot be
 * recorded or owned is closed and refunded rather than run.
 *
 * Redis is required: the ledger, the owner's claim, the sweeper's end and
 * the transcript a dead owner leaves behind all live there. Without it the
 * start is refused `unavailable`, and typed chat is untouched. The seconds
 * ledger is the spend bound, as it always was: charged before the service
 * is touched, renewed by the owner on evidence a person is there, settled
 * when the session ends, and cut off by the ledger's sweeper — whose hangup
 * here is an `end` left for the owner and published to it, or, when the
 * owner's claim has lapsed, the session settled by whichever replica
 * noticed, from the transcript the owner kept.
 */

/** Who is opening a session, as the app verified them. */
export interface LiveCaller {
	voice: VoiceCaller;
	/** The account: the memory scope and the thread's owner. */
	resourceId: string;
	/** Who is asking, for the tools' readers. */
	identity: CallerIdentity;
	/** A voice tester's tuning, checked by the app against the account's row as the socket was accepted; absent for anybody else. */
	tuning?: VoiceTuning | null;
	/**
	 * Whether the caller is still the one the socket was accepted for, asked
	 * as the session is bound to its thread (`LiveVoiceRequest.stillAdmitted`):
	 * the socket is accepted, then its `start` read, and an erase may land in
	 * between.
	 */
	stillAdmitted?: LiveVoiceRequest["stillAdmitted"];
}

export interface VoiceBrokerDeps {
	host: Pick<AgentHost, "liveVoiceBinding" | "settleLiveVoice">;
	/** The app's namespace: every key and channel of a session sits under it. */
	namespace: KeyNamespace;
	/** The project's endpoint, read per session; throws when none is configured. */
	endpoint(): string;
	/** A bearer for `https://ai.azure.com`, as the process's identity. */
	token(): Promise<string>;
	/** Whether the product has a live voice at all. */
	enabled: boolean;
	/** The surface a session's usage lines carry. */
	surface: string;
	/** This replica's name in the owner claims; a fresh one per process otherwise. */
	replica?: string;
	/** How long an owner's claim lives without a heartbeat: how soon a dead owner is noticed. */
	ownerTtlMs?: number;
}

/** What the server keeps on each browser socket. */
export interface BrowserSocket {
	who: LiveCaller;
	/** Set once the socket opens. */
	session?: BrowserSession;
}

type Socket = Bun.ServerWebSocket<BrowserSocket>;

const DEFAULT_OWNER_TTL_MS = 15_000;
/** How long a session's keys outlive its hard limit: room for the settle. */
const KEY_GRACE_MS = 10 * 60_000;
/** How long a browser has after its socket opens to say which thread it speaks into. */
const START_TIMEOUT_MS = 10_000;
/**
 * The voice's audio a browser may fall behind by before frames are dropped:
 * about five seconds at 24 kHz. Text frames are never dropped; past
 * {@link BACKPRESSURE_LIMIT_BYTES} the server closes the socket.
 */
const AUDIO_BEHIND_BYTES = 5 * AUDIO_SAMPLE_RATE * 2;
const BACKPRESSURE_LIMIT_BYTES = 4 * 1024 * 1024;

/** Close codes the browser reads: the session's end, a refusal (4000 + the HTTP status it stands for), or a fault of its own. */
const CLOSE = {
	normal: 1000,
	invalid: 4400,
	noStart: 4408,
	refusedBase: 4000,
} as const;

/** The agent's refusal, in the agent's own shape, as a typed turn's would be. */
function bindingRefused(refusal: LiveVoiceRefusal): Response {
	// The app's own refusal is answered in its own code.
	const code = "reason" in refusal ? refusal.reason : refusal.code;
	return Response.json({ code }, { status: refusal.status });
}

type Refused = Extract<LiveRefusal, { code: "refused" }>;

function refused(
	refusal:
		| Extract<LiveRefusal, { code: "rate_limited" }>
		| Omit<Refused, "code" | "surface">,
): Response {
	return liveRefusedResponse(
		"code" in refusal
			? refusal
			: { code: "refused", surface: "realtime", ...refusal },
	);
}

const unavailable = () =>
	refused({
		reason: "unavailable",
		retryAfterSeconds: UNAVAILABLE_RETRY_SECONDS,
	});

/**
 * One browser socket, from its opening to its close: waiting for `start`,
 * opening the session, open (its owner relaying), and closed. Whichever end
 * goes first, the other follows.
 */
class BrowserSession implements BrowserLink {
	phase: "waiting" | "opening" | "open" | "closed" = "waiting";
	owner: SessionOwner | null = null;
	private readonly timer: ReturnType<typeof setTimeout>;

	constructor(private readonly ws: Socket) {
		this.timer = setTimeout(() => {
			if (this.phase === "waiting") this.close(CLOSE.noStart, "no start");
		}, START_TIMEOUT_MS);
	}

	get closed(): boolean {
		return this.phase === "closed";
	}

	send(message: ServerMessage): void {
		if (this.phase !== "closed") this.ws.send(JSON.stringify(message));
	}

	audio(pcm: Uint8Array): boolean {
		if (this.phase !== "open") return false;
		// Behind by more than a few seconds: a frame now would only arrive later still.
		if (this.ws.getBufferedAmount() > AUDIO_BEHIND_BYTES) return false;
		return this.ws.send(pcm) !== 0;
	}

	close(code: number, reason: string): void {
		clearTimeout(this.timer);
		if (this.phase === "closed") return;
		this.phase = "closed";
		this.ws.close(code, reason);
	}

	/** The socket closed, from either end. */
	gone(): void {
		clearTimeout(this.timer);
		this.phase = "closed";
	}

	/** A refusal as an HTTP route would have answered it, on the socket, and the socket closed. */
	async refuse(response: Response): Promise<void> {
		const body = await response.json().catch(() => null);
		this.send({ type: "refused", status: response.status, body });
		this.close(CLOSE.refusedBase + response.status, "refused");
	}
}

export class VoiceBroker {
	readonly replica: string;
	private readonly keys: VoiceKeys;
	private readonly ownerTtlMs: number;
	/** The sessions whose sockets this replica holds: the only state in process, keyed by session. */
	private readonly owners = new Map<string, SessionOwner>();
	/** The cutoffs this replica comes back to: sessions whose owner neither heard the end nor was known to be gone. */
	private readonly returns = new Map<string, ReturnType<typeof setTimeout>>();
	private stopping = false;

	constructor(private readonly deps: VoiceBrokerDeps) {
		this.replica = deps.replica ?? `replica-${crypto.randomUUID()}`;
		this.keys = voiceKeys(deps.namespace);
		this.ownerTtlMs = deps.ownerTtlMs ?? DEFAULT_OWNER_TTL_MS;
	}

	/** Whether this deployment can open a live session: a voice agent, a project, and Redis. */
	available(): boolean {
		return this.configured() && isRedisConfigured();
	}

	/**
	 * What a client may offer, read on the server and handed down so the
	 * honest gate is a microphone never shown: live voice or none.
	 */
	capability(): { live: boolean } {
		return { live: this.available() };
	}

	/** A voice agent and a project to find it in. */
	private configured(): boolean {
		if (!this.deps.enabled) return false;
		try {
			this.deps.endpoint();
			return true;
		} catch {
			return false;
		}
	}

	/** Whether the replica is going away: no new sessions here. */
	get draining(): boolean {
		return this.stopping;
	}

	private store(id: string, maxSessionSeconds = 3600): SessionStore {
		return sessionStore(this.keys, id, maxSessionSeconds * 1000 + KEY_GRACE_MS);
	}

	/**
	 * `GET /voice/live`, a WebSocket upgrade under a caller the app verified:
	 * the socket accepted, with nothing opened yet — everything is decided
	 * once the browser says which thread (`start`), so a refusal reaches the
	 * pane as a message it can read. A request that is not an upgrade, or a
	 * server that cannot take one, is answered 426.
	 */
	upgrade(
		request: Request,
		server: Bun.Server<BrowserSocket> | undefined,
		who: LiveCaller,
	): Response {
		if (server?.upgrade(request, { data: { who } })) return new Response(null);
		return Response.json(
			{ code: "upgrade_required" },
			{ status: 426, headers: { "Cache-Control": "no-store" } },
		);
	}

	/** The server's handlers and bounds for the browser sockets. */
	readonly websocket: Bun.WebSocketHandler<BrowserSocket> = {
		maxPayloadLength: MAX_AUDIO_FRAME_BYTES,
		backpressureLimit: BACKPRESSURE_LIMIT_BYTES,
		closeOnBackpressureLimit: true,
		// The browser sends audio all the time it is open; a socket silent this long has gone.
		idleTimeout: 60,
		open: (ws) => {
			ws.data.session = new BrowserSession(ws);
		},
		message: (ws, message) => {
			const session = ws.data.session;
			if (!session || session.closed) return;
			if (typeof message !== "string") {
				session.owner?.audio(message);
				return;
			}
			const read = readBrowserMessage(message);
			if (!read) {
				session.close(CLOSE.invalid, "not a message of this socket");
				return;
			}
			if (read.type === "start") {
				if (session.phase !== "waiting") return;
				session.phase = "opening";
				void this.admit(session, ws.data.who, read).catch((err: Error) => {
					console.error("[voice] the session did not open:", err.message);
					session.close(CLOSE.refusedBase + 502, "failed");
				});
				return;
			}
			session.owner?.fromBrowser(read);
		},
		close: (ws) => {
			const session = ws.data.session;
			if (!session) return;
			session.gone();
			void session.owner?.end("client");
		},
	};

	/**
	 * The session, in the ledger's order — every refusal that spends nothing
	 * before the first charge, the charge before the service, the thread
	 * bound before the socket, the record after it — and a session that
	 * cannot be recorded or owned is closed and refunded rather than run. A
	 * browser that went meanwhile is given back what it held.
	 */
	private async admit(
		browser: BrowserSession,
		who: LiveCaller,
		start: Extract<BrowserMessage, { type: "start" }>,
	): Promise<void> {
		const settings = await voiceSettings();
		if (!this.configured()) {
			voiceProblems.report("voice.live.unconfigured", { status: 503 });
			return browser.refuse(refused({ reason: "unconfigured" }));
		}
		// Redis is required: the owner, the channel and the ledger all live there.
		if (this.stopping || !(await redisAnswers())) {
			voiceProblems.report("voice.live.unavailable", { status: 503 });
			return browser.refuse(unavailable());
		}
		const { subject, tier, language } = who.voice;

		const burst = await meterCall(subject, "realtime", tier);
		if (!burst.ok) return browser.refuse(rateLimitedResponse(burst.refusal));
		const bounds = sessionBounds(await getLimits(), tier);
		if (await isSubjectLive(subject)) {
			voiceProblems.report("voice.live.busy", {
				status: 409,
				retryAfterSeconds: bounds.maxSessionSeconds,
			});
			return browser.refuse(
				refused({
					reason: "busy",
					retryAfterSeconds: bounds.maxSessionSeconds,
				}),
			);
		}
		const room = await liveCapacity();
		if (room.full) {
			voiceProblems.report("voice.live.capacity", {
				status: 503,
				measured: room.live,
				limit: room.capacity,
				retryAfterSeconds: room.retryAfterSeconds,
			});
			return browser.refuse(
				refused({
					reason: "capacity",
					retryAfterSeconds: room.retryAfterSeconds,
				}),
			);
		}
		if (browser.closed) return;
		const seconds = await chargeSeconds(subject, bounds.idleSeconds, tier);
		if (!seconds.ok) {
			if (seconds.reason === "unavailable") {
				voiceProblems.report("voice.live.unavailable", {
					status: 503,
					retryAfterSeconds: seconds.retryAfterSeconds,
				});
				return browser.refuse(
					refused({
						reason: "unavailable",
						retryAfterSeconds: seconds.retryAfterSeconds,
					}),
				);
			}
			voiceProblems.report("voice.live.no_seconds", {
				status: 429,
				bucket: seconds.reason,
				tier,
				retryAfterSeconds: seconds.refusal.retryAfterSeconds,
			});
			return browser.refuse(
				refused({ ...seconds.refusal, reason: seconds.reason }),
			);
		}
		const refund = () =>
			refundSeconds(subject, bounds.idleSeconds, seconds.ownDay);

		const id = crypto.randomUUID();
		const record: SessionRecord = {
			subject,
			resourceId: who.resourceId,
			threadId: start.threadId,
			replica: this.replica,
		};
		let binding: LiveVoiceBinding;
		try {
			const bound = await this.deps.host.liveVoiceBinding(
				who.resourceId,
				start.threadId,
				{
					sessionId: id,
					maxSessionSeconds: bounds.maxSessionSeconds,
					tier,
					locale: language.code,
					screen: screenOf(start.screen),
					caller: who.identity,
					tuning: who.tuning ?? null,
					stillAdmitted: who.stillAdmitted,
				},
			);
			if (bound.kind === "refused") {
				await refund();
				return browser.refuse(bindingRefused(bound.refusal));
			}
			binding = bound.binding;
		} catch (err) {
			await refund();
			console.error(
				"[voice] the thread could not be bound:",
				(err as Error).message,
			);
			voiceProblems.report("voice.live.handshake_failed", { status: 502 });
			return browser.refuse(faultResponse("handshake_failed"));
		}

		const store = this.store(id, bounds.maxSessionSeconds);
		const owner = new SessionOwner(
			{
				id,
				record,
				binding,
				store,
				tier,
				idleSeconds: bounds.idleSeconds,
				surface: this.deps.surface,
				stillAdmitted: who.stillAdmitted,
			},
			browser,
			{
				host: this.deps.host,
				keys: this.keys,
				replica: this.replica,
				settings: settings.live,
				ownerTtlMs: this.ownerTtlMs,
			},
		);
		/** The thread given back, the seconds refunded, nothing left in Redis: a session that never ran. */
		const abandon = async () => {
			await refund();
			await this.deps.host
				.settleLiveVoice(who.resourceId, start.threadId, {
					sessionId: id,
					spoken: [],
				})
				.catch((err: Error) =>
					console.error("[voice] the thread was not given back:", err.message),
				);
			await store.forget();
		};
		if (browser.closed) return abandon();
		if (!(await store.write(record))) {
			await abandon();
			return browser.refuse(unavailable());
		}

		let opened: OpenedSession;
		try {
			opened = await this.connect(id, binding, owner, settings.live);
		} catch (err) {
			await abandon();
			return browser.refuse(this.connectFailed(err));
		}
		this.logUpdate(id, opened);
		// The service refused the session's settings after the update's echo: it would answer nothing.
		const refusedCode = owner.refusedBeforeReady;
		if (refusedCode) {
			await opened.connection.close("the session's settings were refused");
			await abandon();
			return browser.refuse(
				this.connectFailed(new SessionSettingsRefused(refusedCode)),
			);
		}
		if (browser.closed) {
			await opened.connection.close("the browser went");
			return abandon();
		}

		const recorded = await recordSession({
			id,
			subject,
			callId: id,
			startedAt: Date.now(),
			debitedSeconds: bounds.idleSeconds,
			hardSeconds: bounds.maxSessionSeconds,
			ownDay: seconds.ownDay,
		});
		if (!recorded.ok) {
			await opened.connection.close("not recorded");
			await abandon();
			voiceProblems.report("voice.live.not_recorded", {
				reason: recorded.reason,
				status: recorded.reason === "live" ? 409 : 503,
			});
			return browser.refuse(
				recorded.reason === "live"
					? refused({
							reason: "busy",
							retryAfterSeconds: bounds.maxSessionSeconds,
						})
					: unavailable(),
			);
		}

		// From here the session is the ledger's and the owner's: whatever ends it, the owner's end settles both and closes the socket it holds.
		owner.hold(opened.connection);
		this.owners.set(id, owner);
		void owner.done.then(() => this.owners.delete(id));
		browser.owner = owner;
		// The browser went while the session was being recorded: its close found no owner to end, so it is ended here.
		if (browser.closed) {
			await owner.end("client");
			return;
		}
		browser.phase = "open";
		const claimed = await claimOnce(
			this.keys.owner(id),
			this.replica,
			this.ownerTtlMs,
		);
		const started =
			claimed.outcome === "claimed" &&
			(await owner.start({
				type: "ready",
				language: language.code,
				audio: { sampleRate: AUDIO_SAMPLE_RATE },
				session: {
					id,
					maxSessionSeconds: bounds.maxSessionSeconds,
					idleSeconds: bounds.idleSeconds,
				},
			}));
		if (!started) {
			// Not owned, or not reachable by the sweeper: never ready. Ended first, so the refusal's close is not read as the person leaving.
			const ended = owner.end("failed");
			voiceProblems.report("voice.live.unavailable", { status: 503 });
			await browser.refuse(unavailable());
			await ended;
			return;
		}
		// The browser went while the session was being handed over: it is over.
		if (browser.closed) await owner.end("client");
	}

	/** The socket, opened once and, when the service refused the handshake, once more on the version made again. */
	private async connect(
		id: string,
		binding: LiveVoiceBinding,
		owner: SessionOwner,
		live: VoiceSettings["live"],
	): Promise<OpenedSession> {
		// The thread's lines are already the thread's: the record leaves them out.
		owner.transcript.exclude(binding.history.map((line) => line.id));
		const attempt = (version: string) => {
			// Voice Live is told everything in the session's update; a voice agent's version holds the rest.
			const target: SessionTarget = binding.runtime
				? {
						kind: "voiceLive",
						endpoint: this.deps.endpoint(),
						model: binding.runtime.model,
					}
				: {
						endpoint: this.deps.endpoint(),
						agent: binding.agentName,
						version,
						sessionId: id,
						structuredInputs: binding.structuredInputs,
					};
			return openSession({
				target,
				connect: {
					token: this.deps.token,
					timeoutMs: live.connectTimeoutMs,
					observe: owner.observe,
				},
				session: binding.session,
				history: binding.history,
				timeouts: { updateMs: live.updateTimeoutMs },
			});
		};
		try {
			return await attempt(binding.version);
		} catch (err) {
			// Voice Live has no version to make again: its refusal is the session's.
			if (
				!(err instanceof VoiceAgentConnectError) ||
				err.failure !== "refused" ||
				binding.runtime
			)
				throw err;
			// A version pruned under this replica looks like any refused handshake: make it again, once.
			console.warn(
				`[voice] session ${id}: the handshake was refused${err.code ? ` (${err.code})` : ""}; making the version again`,
			);
			// The binding names the version the session runs on, for its usage lines.
			binding.version = await binding.reensure();
			return attempt(binding.version);
		}
	}

	private connectFailed(err: unknown): Response {
		if (err instanceof SessionSettingsRefused) {
			voiceProblems.report("voice.live.session_refused", {
				status: 502,
				reason: err.code,
			});
			console.error(`[voice] the session did not open: ${err.message}`);
			return faultResponse("settings_refused");
		}
		const code = err instanceof VoiceAgentConnectError ? (err.code ?? "") : "";
		// Codes only: what the service says of a refused session can quote the person's part of it.
		console.error(
			`[voice] the session did not open: ${
				err instanceof VoiceAgentConnectError
					? `${err.failure}${code ? ` (${code})` : ""}`
					: err instanceof Error
						? err.name
						: "unknown"
			}`,
		);
		if (/limit|capacity|concurren|throttl/i.test(code)) {
			voiceProblems.report("voice.live.provider_capacity", { status: 503 });
			return refused({ reason: "capacity", retryAfterSeconds: 30 });
		}
		voiceProblems.report("voice.live.handshake_failed", { status: 502 });
		return faultResponse("handshake_failed");
	}

	/** What the person's update did, as the service echoed it: the language, the voice and its accent, the reasoning; and whether the thread so far took. */
	private logUpdate(id: string, opened: OpenedSession): void {
		const { update, history } = opened;
		if (history.kind === "given") {
			if (history.lines)
				console.log(
					`[voice] session ${id} was given ${history.lines} lines of its thread`,
				);
		} else if (history.kind === "unacknowledged") {
			console.log(
				`[voice] session ${id} was sent ${history.lines} lines of its thread; the service acknowledged none in time`,
			);
		} else {
			voiceProblems.report("voice.live.history_refused", {
				reason: history.code ?? "unanswered",
			});
			// Codes only: a refusal's words can quote the line it refused.
			console.warn(
				`[voice] session ${id}: the thread so far did not all take (${history.code ?? "no answer"}${history.param ? `, ${history.param}` : ""}); its ${history.rolledBack} lines were taken out again and the session runs without them`,
			);
		}
		if (update.kind === "updated") {
			// A voice agent echoes the nested shape (`audio.input.*`, `audio.output.*`); Voice Live the flat one.
			const session = update.session;
			const audio = session.audio as
				| {
						input?: {
							transcription?: unknown;
							noise_reduction?: unknown;
							turn_detection?: unknown;
						};
						output?: { voice?: unknown; voice_locale?: unknown };
				  }
				| undefined;
			const flatVoice = session.voice as { locale?: unknown } | undefined;
			console.log(
				`[voice] session ${id} updated: ${JSON.stringify({
					transcription:
						audio?.input?.transcription ??
						session.input_audio_transcription ??
						null,
					noise_reduction:
						audio?.input?.noise_reduction ??
						session.input_audio_noise_reduction ??
						null,
					turn_detection:
						audio?.input?.turn_detection ?? session.turn_detection ?? null,
					voice: audio?.output?.voice ?? session.voice ?? null,
					voice_locale:
						audio?.output?.voice_locale ?? flatVoice?.locale ?? null,
					reasoning: update.session.reasoning ?? null,
				})}`,
			);
			return;
		}
		const code = update.kind === "refused" ? update.code : null;
		voiceProblems.report("voice.live.update_refused", {
			reason: code ?? "unanswered",
		});
		const param = update.kind === "refused" ? update.param : null;
		// Codes only: a refusal's words can quote the settings it refused.
		console.warn(
			`[voice] session ${id}: the update did not take (${code ?? "no answer"}${param ? `, ${param}` : ""})`,
		);
	}

	/**
	 * The ledger's cutoff for one session. The end is left in Redis for the
	 * owner and sent on its channel: the channel is at once and at most once,
	 * the note is what the owner's heartbeat finds when the channel carried
	 * nothing. Whether there is an owner is read off its claim, never off
	 * who heard the channel — a subscriber's connection can be down while
	 * both of the session's sockets are up. 200: the owner heard it. 202: its
	 * claim is held and the note is written. 410: its claim has lapsed, and
	 * the session is settled here. 503: Redis did not say who holds it, or
	 * did not take the note, and a session is not settled under an owner that
	 * may be running it.
	 *
	 * The ledger asks once, so a 202 or a 503 is not the last word: a held
	 * claim says only that its owner lived within the claim's lifetime. This
	 * replica comes back once that lifetime has passed (`comeBack`).
	 */
	async hangup(callId: string): Promise<HangupResult> {
		const id = sessionIdOf(callId);
		const store = id ? this.store(id) : null;
		const record = await store?.read();
		if (!id || !store || !record) return { status: 404 };
		const status = await this.askToEnd(id, record);
		if (status === 202 || status === 503) this.comeBack(id, 1);
		return { status };
	}

	/** One ask of a session's owner to end it, and the session settled here when its claim has lapsed. */
	private async askToEnd(
		id: string,
		record: SessionRecord,
	): Promise<200 | 202 | 410 | 503> {
		const noted = await this.store(id).askEnd("idle");
		const delivered = await publish(
			this.keys.inbox(id),
			JSON.stringify({ type: "end", reason: "idle" } satisfies InboxMessage),
		);
		if (delivered) return 200;
		const owner = await claimHolder(this.keys.owner(id));
		if (owner.outcome === "unavailable") return 503;
		if (owner.outcome === "held") return noted ? 202 : 503;
		await this.reap(id, record);
		return 410;
	}

	/**
	 * Look at a session again once its owner's claim has had its lifetime:
	 * an owner killed just before the cutoff still held its claim when the
	 * ledger asked, and nothing else would ever settle what it left. A
	 * session whose record is gone was ended by its owner; one whose claim
	 * has lapsed is settled here; one still held is asked again. The timers
	 * are this process's: a replica that stops with one pending leaves the
	 * session's keys to expire, as a failed settle does.
	 */
	private comeBack(id: string, attempt: number): void {
		// A replica that is stopping looks at nothing again: its host is going.
		if (this.stopping || this.returns.has(id)) return;
		const timer = setTimeout(() => {
			this.returns.delete(id);
			void this.lookAgain(id, attempt).catch((err: Error) =>
				console.error(
					`[voice] session ${id}: its cutoff could not be looked at again:`,
					err.name,
				),
			);
		}, this.ownerTtlMs + RETURN_MARGIN_MS);
		timer.unref?.();
		this.returns.set(id, timer);
	}

	private async lookAgain(id: string, attempt: number): Promise<void> {
		if (this.stopping) return;
		const holder = await claimHolder(this.keys.owner(id));
		// A record that reads as absent while Redis answers is a session its owner settled.
		const record =
			holder.outcome === "unavailable" ? null : await this.store(id).read();
		if (holder.outcome !== "unavailable" && !record) return;
		const status = record ? await this.askToEnd(id, record) : 503;
		if (status === 200 || status === 410) return;
		if (attempt >= MAX_RETURNS) {
			voiceProblems.report("voice.live.unsettled", { status });
			console.error(
				`[voice] session ${id}: its cutoff was asked ${attempt + 1} times and neither taken by an owner nor settled here; its keys are left to expire`,
			);
			return;
		}
		this.comeBack(id, attempt + 1);
	}

	/** The ledger's sweeper, with this broker's hangup. Once per process; returns the stop. */
	startSweeper(options: { intervalMs?: number } = {}): () => void {
		return startSweeper({
			hangup: (callId) => this.hangup(callId),
			...options,
		});
	}

	/**
	 * The replica is going away: no new sessions here, and every session it
	 * holds told `restart`, given the grace to hear it, then ended and
	 * settled. The browser reopens on another replica, on the same thread.
	 */
	async drain(): Promise<void> {
		this.stopping = true;
		// A second look still owed is given up, by name: it would settle a
		// thread on a host that has stopped, and nothing else looks again.
		for (const [id, timer] of this.returns) {
			clearTimeout(timer);
			voiceProblems.report("voice.live.unsettled", { status: 503 });
			console.error(
				`[voice] session ${id}: its cutoff was to be looked at again by a replica that is stopping; its keys are left to expire`,
			);
		}
		this.returns.clear();
		const { live } = await voiceSettings();
		await Promise.all(
			[...this.owners.values()].map((owner) =>
				owner.end("restart", live.drainGraceMs),
			),
		);
	}

	/**
	 * A session whose owner is gone, settled by this replica: the ledger
	 * ended and the thread written from the transcript the owner kept. Each
	 * step is once-only on its own, so two replicas that notice together
	 * write nothing twice. Its browser went with the owner's replica. A
	 * thread that cannot be written leaves the transcript where it is.
	 */
	private async reap(id: string, record: SessionRecord): Promise<void> {
		const store = this.store(id);
		await endSession(id, record.subject).catch(() => null);
		let written = 0;
		try {
			const spoken = await store.spoken();
			let tries = 0;
			const settled = await settleWithRetry(() => {
				tries++;
				return this.deps.host.settleLiveVoice(
					record.resourceId,
					record.threadId,
					{ sessionId: id, spoken },
				);
			});
			// Settled already by somebody else, who forgets it; a repeat of this replica's own earlier try is its own to finish.
			if (settled?.repeated && tries === 1) return;
			written = settled?.repeated
				? spoken.filter((item) => item.kind === "said").length
				: (settled?.written ?? 0);
		} catch (err) {
			// The transcript in Redis is the only copy of what was said: it stays until its keys expire.
			voiceProblems.report("voice.live.unsettled", { status: 200 });
			console.error(
				`[voice] session ${id}: its owner (${record.replica}) is gone and the thread was not written; its transcript is kept in Redis until the session's keys expire:`,
				(err as Error).message,
			);
			return;
		}
		voiceProblems.report("voice.live.orphaned", { status: 200 });
		console.warn(
			`[voice] session ${id}: its owner (${record.replica}) is gone; settled here (${written} lines)`,
		);
		await store.forget();
		// A claim can lapse in a Redis outage its owner outlived: the end stays for that owner to find, and expires with the session's keys.
		await store.askEnd("idle");
	}
}

/** How long past an owner claim's lifetime a cutoff is looked at again: the claim's own expiry, with room. */
const RETURN_MARGIN_MS = 500;
/** How often a cutoff is looked at again before the session's keys are left to expire. */
const MAX_RETURNS = 5;

const SESSION_ID =
	/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The broker's session id, or null: never the service's handle. */
function sessionIdOf(value: string | undefined): string | null {
	return value && SESSION_ID.test(value) ? value : null;
}
