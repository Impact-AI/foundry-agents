import { errorCodeOf } from "@/src/errors";
import type { ContextLine } from "@/src/stage/live-context";
import {
	type LiveEvent,
	readServerMessage,
	type SessionAnswer,
} from "@/src/voice/events";
import {
	closeReason,
	type LiveSession,
	type SessionEnding,
	type VoiceEvent,
} from "@/src/voice/machine";
import { openMicrophone, stopStream } from "@/src/voice/mic";

/**
 * One live session's transport, and everything it holds: the microphone,
 * one audio context with two worklets — the microphone's PCM out, the
 * voice's PCM in — the meter, and one WebSocket to this app's own origin
 * (`/api/voice/live`), which the server relays to the backend under the
 * caller's assertion.
 * Everything of the session crosses that socket: `start` with the thread and
 * the screen, the person's audio as binary frames, the voice's audio back,
 * the pane's events, the stage's answers. The browser holds no credential
 * and reaches no service but this app.
 *
 * The person speaking over the voice (`speech` started) clears what has not
 * been played yet: the barge-in is the playback's to honour, at once, and
 * the service's to cut. Whichever side ends the session — this one on
 * `close()`, the server, the network — the microphone and the audio are
 * released at once, so nothing stays live behind a pane that says the
 * channel ended; the socket stays open after a `close()` until the server
 * says the session's words are in the thread (`ended`), so the chat can
 * read them, even after the pane has closed.
 */

export interface LiveLinkHandlers {
	/** The conversation the session speaks into. */
	threadId: string;
	dispatch: (event: VoiceEvent) => void;
	analyser: (node: AnalyserNode | null) => void;
	/** Whether the person's microphone is open, read when the microphone opens. */
	micOpen: () => boolean;
	/** What the screen shows as the session opens. */
	screen: () => ContextLine[];
	/** Every event the session sends, in order, while the pane is there to draw it. */
	event: (live: LiveEvent) => void;
	/** The session's words are in the thread: called once, even after `close()`, so the chat can read it again. */
	settled: (written: number) => void;
	/**
	 * Whether the session holds the thread: true once it is open, false
	 * once the server said its words are written or stopped answering — after
	 * `settled`, and even after `close()`. A typed turn sent in between is
	 * refused, so what waits for the channel waits for this.
	 */
	held?: (held: boolean) => void;
	/**
	 * Whether the voice's audio is playing on this device: it can go on
	 * after the response is done, since the audio arrives faster than it
	 * plays. False once the audio is released.
	 */
	playing?: (playing: boolean) => void;
}

export interface LiveLink {
	/**
	 * The microphone open or muted. Muted, the track is disabled, so the
	 * frames still go out and carry silence: the session stays open and the
	 * socket is kept from the server's idle close, and the service hears
	 * nobody speaking.
	 */
	setMic: (open: boolean) => void;
	/** Words typed into the open session; whether they went. */
	say: (text: string) => boolean;
	/** A stage call's answer, sent to the session; whether it went. */
	answer: (callId: string, output: string) => boolean;
	/** What the screen shows now, for the session to know. */
	screen: (lines: readonly ContextLine[]) => void;
	/** This side ends it: everything released, the session ended at the server. */
	close: () => void;
}

/** Where the session's socket is: this app's own origin. */
const LIVE_SOCKET_PATH = "/api/voice/live";
/** The worklets, served from this origin as the page's own scripts are. */
export const CAPTURE_WORKLET = "/voice/capture-worklet.js";
export const PLAYBACK_WORKLET = "/voice/playback-worklet.js";
/** The rate the session's audio is at, both ways, until the server says otherwise. */
const SESSION_RATE = 24_000;
/** How long the socket is kept after a `close()`, for the server to say the thread is written. */
export const SETTLE_LISTEN_MS = 20_000;
/**
 * The person's audio the socket may hold unsent before a frame is dropped:
 * about two seconds. A network that cannot keep up hears a gap rather than
 * a delay that grows.
 */
export const MIC_BACKLOG_BYTES = 2 * SESSION_RATE * 2;
/**
 * The person's audio held while the session opens, before `ready`: about
 * five seconds, the newest kept. A session can take a second or more to
 * open, and a person who starts speaking at once would otherwise lose
 * their first words; once it is ready, what was held goes first, in order.
 */
export const EARLY_AUDIO_BYTES = 5 * SESSION_RATE * 2;
/**
 * How long after `ready` the microphone has to produce its first frame. It
 * makes one every 50 ms, so a capture that has made none by then never will,
 * and the pane says so rather than listening to nothing.
 */
export const CAPTURE_DEADLINE_MS = 3_000;
/** The screen as the backend takes it: a few short lines. */
const SCREEN_LINES = 12;
const SCREEN_LINE_CHARS = 300;

/** The screen's lines, cut to what the backend takes. */
export function screenLines(lines: readonly ContextLine[]) {
	const cut = (s: string) => s.slice(0, SCREEN_LINE_CHARS);
	return lines
		.slice(0, SCREEN_LINES)
		.map((l) => ({ label: cut(l.label), value: cut(l.value) }));
}

function socketUrl(): string {
	const scheme = window.location.protocol === "https:" ? "wss:" : "ws:";
	return `${scheme}//${window.location.host}${LIVE_SOCKET_PATH}`;
}

export function openLiveLink(on: LiveLinkHandlers): LiveLink {
	/** Set by either side's ending: nothing is opened after it, and the audio is gone. */
	let over = false;
	/** Set by `close()`: the pane has moved on, so nothing but the settle is reported. */
	let dropped = false;
	/** Set once `ended` arrived: the socket has nothing more to say. */
	let settled = false;
	let socket: WebSocket | null = null;
	let mic: MediaStream | null = null;
	let context: AudioContext | null = null;
	let capture: AudioWorkletNode | null = null;
	let playback: AudioWorkletNode | null = null;
	let session: LiveSession | null = null;
	let activityAt = 0;
	/** The ending the server announced, when it announced one before going. */
	let announced: SessionEnding | null = null;
	let holding = false;
	const hold = (held: boolean) => {
		if (holding === held) return;
		holding = held;
		on.held?.(held);
	};
	let listening: ReturnType<typeof setTimeout> | undefined;
	let capturing: ReturnType<typeof setTimeout> | undefined;
	/** The microphone's frames made before `ready`, oldest first, within `EARLY_AUDIO_BYTES`. */
	let early: ArrayBuffer[] = [];
	let earlyBytes = 0;
	/** Whether the microphone has made a frame yet. */
	let framed = false;
	/** The microphone's frames: held until the session is ready, then sent unless the socket is behind. */
	const captured = (frame: ArrayBuffer) => {
		framed = true;
		clearTimeout(capturing);
		if (over) return;
		if (!session) {
			early.push(frame);
			earlyBytes += frame.byteLength;
			while (earlyBytes > EARLY_AUDIO_BYTES) {
				const oldest = early.shift();
				earlyBytes -= oldest?.byteLength ?? earlyBytes;
			}
			return;
		}
		if (
			socket?.readyState === WebSocket.OPEN &&
			socket.bufferedAmount <= MIC_BACKLOG_BYTES
		)
			socket.send(frame);
	};

	const releaseAudio = () => {
		clearTimeout(capturing);
		early = [];
		earlyBytes = 0;
		if (capture) capture.port.onmessage = null;
		if (playback) {
			playback.port.onmessage = null;
			on.playing?.(false);
		}
		capture?.disconnect();
		playback?.disconnect();
		capture = playback = null;
		stopStream(mic);
		mic = null;
		void context?.close().catch(() => {});
		context = null;
		on.analyser(null);
	};

	const stopListening = () => {
		clearTimeout(listening);
		const open = socket;
		// Forgotten first: a close this side asked for is not the server hanging up.
		socket = null;
		if (open && open.readyState <= WebSocket.OPEN) open.close(1000);
	};

	/** The socket stays a while for the server's last word; past it, the pane is told what is known. */
	const listenForTheEnd = (fallback: SessionEnding) => {
		clearTimeout(listening);
		listening = setTimeout(() => {
			stopListening();
			hold(false);
			if (!dropped && !settled)
				on.dispatch({ type: "ended", reason: fallback });
		}, SETTLE_LISTEN_MS);
	};

	const send = (message: unknown): boolean => {
		if (!socket || socket.readyState !== WebSocket.OPEN) return false;
		socket.send(JSON.stringify(message));
		return true;
	};

	const close = () => {
		if (dropped) return;
		dropped = true;
		over = true;
		releaseAudio();
		if (!session) {
			hold(false);
			return stopListening();
		}
		session = null;
		if (!send({ type: "end" })) {
			hold(false);
			return stopListening();
		}
		listenForTheEnd("client");
	};

	/** The socket went without the server's last word: the ledger, the network, or the server. */
	const hungUp = () => {
		// Before the session opened there is no ending to name: the channel never opened.
		const opened = session !== null || announced !== null;
		const fallback = announced ?? closeReason(session, activityAt, Date.now());
		over = true;
		session = null;
		releaseAudio();
		socket = null;
		clearTimeout(listening);
		hold(false);
		if (dropped || settled) return;
		if (opened) on.dispatch({ type: "ended", reason: fallback });
		else on.dispatch({ type: "failed", code: "setup" });
	};

	/** The microphone went while the session was open: unplugged, or taken by the system. */
	const micLost = () => {
		if (dropped || over) return;
		on.dispatch({ type: "failed", code: "micLost" });
		close();
	};

	const answered = (answer: SessionAnswer) => {
		if (answer.type === "refused") {
			if (!dropped)
				on.dispatch({
					type: "failed",
					code: errorCodeOf(answer.body, answer.status),
				});
			over = true;
			releaseAudio();
			stopListening();
			return;
		}
		const now = Date.now();
		session = {
			id: answer.session.id,
			idleMs: Math.max(0, answer.session.idleSeconds) * 1000,
			maxMs: Math.max(0, answer.session.maxSessionSeconds) * 1000,
			openedAt: now,
		};
		activityAt = now;
		hold(true);
		// What the person said while the session opened goes first, whole and in order: it is bounded.
		const held = early;
		early = [];
		earlyBytes = 0;
		if (socket?.readyState === WebSocket.OPEN)
			for (const frame of held) socket.send(frame);
		if (!dropped) on.dispatch({ type: "connected", session });
		// A microphone that makes no frames is a fault the pane names, not a silence it listens to.
		if (framed) return;
		capturing = setTimeout(() => {
			if (dropped) return;
			on.dispatch({ type: "failed", code: "capture" });
			close();
		}, CAPTURE_DEADLINE_MS);
	};

	const heard = (live: LiveEvent) => {
		if (
			(live.type === "speech" && live.state === "started") ||
			(live.type === "response" && live.state === "started")
		)
			activityAt = Date.now();
		// The person is speaking over the voice: what it had not said yet goes.
		if (live.type === "speech" && live.state === "started")
			playback?.port.postMessage("clear");
		if (live.type === "ending") {
			over = true;
			announced = live.reason;
			releaseAudio();
			// The server's last word follows; if it never does, the ending it announced stands.
			listenForTheEnd(live.reason);
		}
		if (live.type === "ended") {
			settled = true;
			over = true;
			releaseAudio();
			stopListening();
			on.settled(live.written);
			hold(false);
		}
		if (!dropped) on.event(live);
	};

	const connect = async () => {
		on.dispatch({ type: "open" });
		const opened = await openMicrophone();
		if ("error" in opened) {
			if (!dropped) on.dispatch({ type: "failed", code: opened.error });
			return;
		}
		if (dropped) {
			// Allowed after the pane closed: there is nobody left to hear.
			stopStream(opened.stream);
			return;
		}
		mic = opened.stream;
		try {
			const ctx = new AudioContext({ latencyHint: "interactive" });
			context = ctx;
			await Promise.all([
				ctx.audioWorklet.addModule(CAPTURE_WORKLET),
				ctx.audioWorklet.addModule(PLAYBACK_WORKLET),
			]);
			if (dropped) return;
			await ctx.resume().catch(() => {});
			const source = ctx.createMediaStreamSource(opened.stream);
			const meter = ctx.createAnalyser();
			meter.fftSize = 2048;
			source.connect(meter);
			on.analyser(meter);
			capture = new AudioWorkletNode(ctx, "pcm-capture", {
				numberOfOutputs: 0,
				processorOptions: { targetRate: SESSION_RATE },
			});
			// Wired at once: what the person says before `ready` is held, not lost.
			capture.port.onmessage = (frame: MessageEvent<ArrayBuffer>) =>
				captured(frame.data);
			source.connect(capture);
			playback = new AudioWorkletNode(ctx, "pcm-playback", {
				numberOfInputs: 0,
				outputChannelCount: [1],
				processorOptions: { sourceRate: SESSION_RATE },
			});
			playback.connect(ctx.destination);
			playback.port.onmessage = (
				event: MessageEvent<{ playing?: unknown }>,
			) => {
				if (typeof event.data?.playing === "boolean")
					on.playing?.(event.data.playing);
			};
			for (const track of opened.stream.getAudioTracks()) {
				track.enabled = on.micOpen();
				track.onended = micLost;
			}

			const ws = new WebSocket(socketUrl());
			ws.binaryType = "arraybuffer";
			socket = ws;
			ws.onopen = () => {
				ws.send(
					JSON.stringify({
						type: "start",
						threadId: on.threadId,
						screen: screenLines(on.screen()),
					}),
				);
			};
			ws.onmessage = (message: MessageEvent<string | ArrayBuffer>) => {
				if (typeof message.data !== "string") {
					if (!over) playback?.port.postMessage(message.data, [message.data]);
					return;
				}
				const read = readServerMessage(message.data);
				if (!read) return;
				if (read.type === "ready" || read.type === "refused") answered(read);
				else heard(read);
			};
			ws.onclose = () => {
				if (socket !== ws) return;
				if (!settled) hungUp();
			};
		} catch (err) {
			if (dropped) return;
			console.error("[voice] live session failed:", err);
			on.dispatch({ type: "failed", code: "setup" });
			close();
		}
	};

	void connect();
	return {
		setMic: (open) => {
			for (const track of mic?.getAudioTracks() ?? []) track.enabled = open;
		},
		say: (text) => !over && session !== null && send({ type: "text", text }),
		answer: (callId, output) =>
			!over && send({ type: "tool-output", callId, output }),
		screen: (lines) => {
			if (!over && session) send({ type: "screen", lines: screenLines(lines) });
		},
		close,
	};
}
