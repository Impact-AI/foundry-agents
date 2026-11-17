import { afterEach, beforeEach, describe, expect, jest, test } from "bun:test";
import type { LiveEvent } from "@/src/voice/events";
import { INITIAL, reduce, type VoiceEvent } from "@/src/voice/machine";
import {
	CAPTURE_DEADLINE_MS,
	CAPTURE_WORKLET,
	EARLY_AUDIO_BYTES,
	type LiveLink,
	MIC_BACKLOG_BYTES,
	openLiveLink,
	PLAYBACK_WORKLET,
	SETTLE_LISTEN_MS,
	screenLines,
} from "./live-link";
import { type FakeBrowser, install, settle } from "./testing/fake-browser";

/**
 * The live link against a faked browser: what it opens and sends — the
 * microphone through a capture worklet, a playback worklet, one socket to
 * this app's origin with `start`, the thread and the screen first — the
 * audio both ways and the barge-in, and that whichever side ends it — the
 * pane, the server, the network — nothing it opened is left live, the pane
 * is told the truth about why, and the chat is told once the session's
 * words are in the thread, even after the pane has gone.
 */
let browser: FakeBrowser;
let events: VoiceEvent[];
let heard: LiveEvent[];
let settledWith: number[];
let analysers: (AnalyserNode | null)[];
let holds: boolean[];
let playings: boolean[];

beforeEach(() => {
	browser = install();
	events = [];
	heard = [];
	settledWith = [];
	analysers = [];
	holds = [];
	playings = [];
});
afterEach(() => {
	jest.useRealTimers();
	browser.restore();
});

function open(): LiveLink {
	return openLiveLink({
		threadId: "thread-1",
		dispatch: (e) => events.push(e),
		analyser: (node) => analysers.push(node),
		micOpen: () => true,
		screen: () => [{ label: "stage.empty", value: "nothing is up" }],
		event: (live) => heard.push(live),
		settled: (written) => settledWith.push(written),
		held: (held) => holds.push(held),
		playing: (now) => playings.push(now),
	});
}

const READY = {
	type: "ready",
	language: "en",
	audio: { sampleRate: 24_000 },
	session: { id: "s1", maxSessionSeconds: 600, idleSeconds: 60 },
};

const phase = () => events.reduce(reduce, INITIAL).phase;
const socket = () => {
	const s = browser.sockets[0];
	if (!s) throw new Error("no socket opened");
	return s;
};
const worklet = (name: string) => browser.worklets.find((w) => w.name === name);

/** A link whose session is ready. */
async function ready(): Promise<LiveLink> {
	const link = open();
	await settle();
	socket().accept();
	socket().say(READY);
	return link;
}

describe("the live link opens one socket to this app and relays the audio both ways", () => {
	test("the worklets are this origin's, the socket is this origin's, and `start` goes first with the thread and the screen", async () => {
		const link = await ready();
		const [context] = browser.contexts;
		expect(context?.modules).toEqual([CAPTURE_WORKLET, PLAYBACK_WORKLET]);
		expect(worklet("pcm-capture")?.options).toMatchObject({
			processorOptions: { targetRate: 24_000 },
		});
		expect(socket().url).toBe("wss://app.test/api/voice/live");
		expect(socket().binaryType).toBe("arraybuffer");
		expect(socket().texts[0]).toEqual({
			type: "start",
			threadId: "thread-1",
			screen: [{ label: "stage.empty", value: "nothing is up" }],
		});
		expect(events.at(-1)).toMatchObject({
			type: "connected",
			session: { id: "s1", idleMs: 60_000, maxMs: 600_000 },
		});
		expect(phase()).toBe("listening");
		link.close();
	});

	test("the microphone's frames go out once the session is ready, and are dropped while the socket is behind", async () => {
		const link = open();
		await settle();
		socket().accept();
		const capture = worklet("pcm-capture");
		socket().say(READY);
		capture?.port.emit(new ArrayBuffer(2_400));
		socket().bufferedAmount = MIC_BACKLOG_BYTES + 1;
		capture?.port.emit(new ArrayBuffer(2_400));
		const frames = socket().sent.filter((m) => m instanceof ArrayBuffer);
		expect(frames).toHaveLength(1);
		link.close();
	});

	test("what the person says before `ready` is held and goes out after it, in order, ahead of the live frames", async () => {
		const link = open();
		await settle();
		socket().accept();
		const capture = worklet("pcm-capture");
		const frame = (n: number) => new Uint8Array(2_400).fill(n).buffer;
		capture?.port.emit(frame(1));
		capture?.port.emit(frame(2));
		// Nothing goes before the session is ready.
		expect(socket().sent.filter((m) => m instanceof ArrayBuffer)).toHaveLength(
			0,
		);
		socket().say(READY);
		capture?.port.emit(frame(3));
		const sent = socket()
			.sent.filter((m) => m instanceof ArrayBuffer)
			.map((m) => new Uint8Array(m as ArrayBuffer)[0]);
		expect(sent).toEqual([1, 2, 3]);
		link.close();
	});

	test("the audio held before `ready` is capped at the newest few seconds", async () => {
		const link = open();
		await settle();
		socket().accept();
		const capture = worklet("pcm-capture");
		const frames = EARLY_AUDIO_BYTES / 2_400 + 10;
		for (let i = 0; i < frames; i++)
			capture?.port.emit(new Uint8Array(2_400).fill(i % 256).buffer);
		socket().say(READY);
		const sent = socket().sent.filter(
			(m) => m instanceof ArrayBuffer,
		) as ArrayBuffer[];
		expect(sent.reduce((n, m) => n + m.byteLength, 0)).toBe(EARLY_AUDIO_BYTES);
		// The oldest went: the first held is the eleventh made.
		expect(new Uint8Array(sent[0] as ArrayBuffer)[0]).toBe(10);
		link.close();
	});

	test("a session that closes before `ready` sends none of what it held", async () => {
		const link = open();
		await settle();
		socket().accept();
		worklet("pcm-capture")?.port.emit(new ArrayBuffer(2_400));
		link.close();
		socket().say(READY);
		expect(socket().sent.filter((m) => m instanceof ArrayBuffer)).toHaveLength(
			0,
		);
	});

	test("a microphone that makes no frame after `ready` is the pane's error, not a silent Listening; one that does keeps the session", async () => {
		jest.useFakeTimers();
		const link = await ready();
		worklet("pcm-capture")?.port.emit(new ArrayBuffer(2_400));
		jest.advanceTimersByTime(CAPTURE_DEADLINE_MS);
		expect(events.some((e) => e.type === "failed")).toBe(false);
		link.close();

		browser.restore();
		browser = install();
		events = [];
		await ready();
		jest.advanceTimersByTime(CAPTURE_DEADLINE_MS);
		expect(events.at(-1)).toEqual({ type: "failed", code: "capture" });
		expect(phase()).toBe("error");
		expect(browser.streams[0]?.live).toBe(false);
		expect(socket().texts.at(-1)).toEqual({ type: "end" });
	});

	test("the voice's audio goes to the playback worklet, and the person speaking over it clears what was not played", async () => {
		const link = await ready();
		const playback = worklet("pcm-playback");
		socket().audio(4_800);
		socket().audio(4_800);
		expect(
			playback?.port.posted.filter((m) => m instanceof ArrayBuffer),
		).toHaveLength(2);
		socket().say({ type: "response", state: "started" });
		socket().say({ type: "speech", state: "started" });
		expect(playback?.port.posted.at(-1)).toBe("clear");
		expect(heard.map((e) => e.type)).toEqual(["response", "speech"]);
		link.close();
	});

	test("the pane is told while the voice's audio plays, and that it stopped once the audio is released", async () => {
		const link = await ready();
		const playback = worklet("pcm-playback");
		playback?.port.emit({ playing: true });
		playback?.port.emit({ playing: false });
		playback?.port.emit({ playing: true });
		link.close();
		expect(playings).toEqual([true, false, true, false]);
		expect(playback?.port.onmessage).toBeNull();
	});

	test("a stage call's answer and the screen go on the socket; a refusal of the start is the pane's error and lets everything go", async () => {
		const link = await ready();
		expect(link.answer("call-1", "Shown.")).toBe(true);
		link.screen([{ label: "Open", value: "x".repeat(400) }]);
		expect(socket().texts.slice(1)).toEqual([
			{ type: "tool-output", callId: "call-1", output: "Shown." },
			{
				type: "screen",
				lines: screenLines([{ label: "Open", value: "x".repeat(400) }]),
			},
		]);
		link.close();

		browser.restore();
		browser = install();
		events = [];
		open();
		await settle();
		socket().accept();
		socket().say({
			type: "refused",
			status: 409,
			body: { code: "refused", surface: "realtime", reason: "busy" },
		});
		expect(events.at(-1)).toEqual({ type: "failed", code: "refused_busy" });
		expect(browser.streams[0]?.live).toBe(false);
		expect(browser.contexts[0]?.closed).toBe(true);
		expect(socket().closedWith).toBe(1000);
	});
});

describe("the live link lets go of everything it opened", () => {
	test("the pane closing ends the session at the server, releases the audio at once, and still hears the thread is written", async () => {
		const link = await ready();
		link.close();
		expect(browser.streams[0]?.live).toBe(false);
		expect(browser.contexts[0]?.closed).toBe(true);
		expect(worklet("pcm-capture")?.disconnected).toBe(true);
		expect(socket().texts.at(-1)).toEqual({ type: "end" });
		// The socket stays for the server's last word, which the pane no longer draws.
		socket().say({ type: "ended", reason: "client", written: 3 });
		expect(settledWith).toEqual([3]);
		expect(socket().closedWith).toBe(1000);
		expect(heard).toEqual([]);
	});

	test("a socket that never says the thread is written is let go after a while", async () => {
		jest.useFakeTimers();
		const link = await ready();
		link.close();
		jest.advanceTimersByTime(SETTLE_LISTEN_MS);
		expect(socket().closedWith).toBe(1000);
		expect(settledWith).toEqual([]);
	});

	test("the server ending the session is the pane's ending, with its reason, and the audio goes", async () => {
		await ready();
		socket().say({ type: "ending", reason: "restart" });
		expect(browser.streams[0]?.live).toBe(false);
		socket().say({ type: "ended", reason: "restart", written: 2 });
		// The pane's machine reads them from the events (`useLiveVoice`); the link adds no ending of its own.
		expect(heard.map((e) => e.type)).toEqual(["ending", "ended"]);
		expect(events.some((e) => e.type === "ended")).toBe(false);
		expect(settledWith).toEqual([2]);
		expect(socket().closedWith).toBe(1000);
	});

	test("the socket dropping with no word is told as what the clocks say: a failure mid-session", async () => {
		await ready();
		socket().drop();
		expect(events.at(-1)).toEqual({ type: "ended", reason: "failed" });
		expect(browser.contexts[0]?.closed).toBe(true);
		expect(browser.streams[0]?.live).toBe(false);
	});

	test("a pane closed while the microphone was still at its prompt opens nothing after it", async () => {
		browser.holdMic = true;
		const link = open();
		await settle();
		link.close();
		browser.allowMic();
		await settle();
		expect(browser.streams[0]?.live).toBe(false);
		expect(browser.contexts).toHaveLength(0);
		expect(browser.sockets).toHaveLength(0);
	});

	test("a pane closed before the session was ready closes the socket, and the server gives back what it held", async () => {
		const link = open();
		await settle();
		socket().accept();
		link.close();
		expect(socket().closedWith).toBe(1000);
		expect(socket().texts.map((m) => m.type)).toEqual(["start"]);
	});
});

describe("the microphone's mute, and words typed into the session", () => {
	test("muted, the track is disabled so the frames still go out and carry silence; unmuted, it is live again", async () => {
		const link = await ready();
		const capture = worklet("pcm-capture");
		const [stream] = browser.streams;
		expect(stream?.tracks.every((t) => t.enabled)).toBe(true);
		link.setMic(false);
		expect(stream?.tracks.every((t) => !t.enabled)).toBe(true);
		capture?.port.emit(new ArrayBuffer(2_400));
		// The socket keeps hearing frames: the server closes a socket silent for a minute.
		expect(socket().sent.filter((m) => m instanceof ArrayBuffer)).toHaveLength(
			1,
		);
		link.setMic(true);
		expect(stream?.tracks.every((t) => t.enabled)).toBe(true);
		link.close();
	});

	test("typed words go as `text` once the session is ready, and not before or after it", async () => {
		const link = open();
		await settle();
		socket().accept();
		expect(link.say("too early")).toBe(false);
		socket().say(READY);
		expect(link.say("Show me the shelf.")).toBe(true);
		expect(socket().texts.at(-1)).toEqual({
			type: "text",
			text: "Show me the shelf.",
		});
		link.close();
		expect(link.say("too late")).toBe(false);
		expect(socket().texts.filter((m) => m.type === "text")).toHaveLength(1);
	});
});

describe("the live link says what ended, and when the thread is free again", () => {
	test("a socket that goes before the session opened is a channel that never opened: an error the pane can reopen from, not a quiet idle", async () => {
		for (const accepted of [false, true]) {
			events = [];
			browser.sockets.length = 0;
			open();
			await settle();
			if (accepted) socket().accept();
			socket().drop();
			expect(events.at(-1)).toEqual({ type: "failed", code: "setup" });
			expect(phase()).toBe("error");
			expect(browser.streams.at(-1)?.live).toBe(false);
		}
		expect(holds).toEqual([]);
	});

	test("an ending the server announced stands when the socket goes before its last word", async () => {
		await ready();
		socket().say({ type: "ending", reason: "idle" });
		socket().drop();
		expect(events.at(-1)).toEqual({ type: "ended", reason: "idle" });
	});

	test("an announced ending whose last word never comes is let go after a while, as the ending it announced", async () => {
		jest.useFakeTimers();
		await ready();
		socket().say({ type: "ending", reason: "length" });
		jest.advanceTimersByTime(SETTLE_LISTEN_MS);
		expect(socket().closedWith).toBe(1000);
		expect(events.at(-1)).toEqual({ type: "ended", reason: "length" });
		expect(holds).toEqual([true, false]);
	});

	test("the thread is held from the session opening until its words are written, and that is said after the pane closed", async () => {
		const link = await ready();
		expect(holds).toEqual([true]);
		link.close();
		expect(holds).toEqual([true]);
		socket().say({ type: "ended", reason: "client", written: 1 });
		expect(settledWith).toEqual([1]);
		expect(holds).toEqual([true, false]);
	});

	test("a session that drops lets the thread go at once", async () => {
		await ready();
		socket().drop();
		expect(holds).toEqual([true, false]);
	});

	test("the microphone going mid-session is the pane's error, and the session is ended", async () => {
		const link = await ready();
		browser.streams[0]?.tracks[0]?.end();
		expect(events.at(-1)).toEqual({ type: "failed", code: "micLost" });
		expect(socket().texts.at(-1)).toEqual({ type: "end" });
		expect(browser.contexts[0]?.closed).toBe(true);
		link.close();
	});
});
