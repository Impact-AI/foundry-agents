import { afterAll, afterEach, beforeAll, expect, spyOn, test } from "bun:test";
import { join } from "node:path";
import { fakeConfigStore } from "@platform/config/testing";
import {
	isSubjectLive,
	meteringKeys,
	resetMeteringKeyPrefix,
	sweepDueSessions,
	type UsageSubject,
} from "@platform/metering";
import {
	REDIS_AVAILABLE,
	sweepMeteringKeys,
	useDefaultLimits,
	useLimits,
	useThrowawayPrefix,
} from "@platform/metering/testing";
import {
	claimHolder,
	claimOnce,
	closeRedis,
	closeSubscriber,
	getRedis,
} from "@platform/redis";
import { sweepNamespace, throwawayNamespace } from "@platform/redis/testing";
import { scopedEnv } from "@platform/test-support";
import { voiceProblems } from "../problems";
import { resetVoiceSettings } from "../settings";
import { subject } from "../testing";
import {
	type FakeVoiceAgentOptions,
	fakeVoiceAgent,
} from "../voicelive/testing/fake-voice-agent";
import { type BrowserSocket, type LiveCaller, VoiceBroker } from "./broker";
import { voiceKeys } from "./keys";
import type { ServerMessage } from "./messages";
import { UNANSWERED_NOTE } from "./response-failure";
import { sessionStore } from "./store";
import { type BrowserSocketClient, openBrowserSocket } from "./testing/browser";
import {
	SERVER_TOOL,
	STAGE_TOOL,
	stubHost,
	VOICE_AGENT,
} from "./testing/stub-host";

/**
 * The relay on real Redis: a browser's
 * socket to a backend, the backend's socket to the voice agent stood in for
 * at its protocol, the host at its two methods. What is proved is the
 * session's whole life on the replica the browser reached — the start
 * admitted in the ledger's order, the person's update and its echo, the
 * audio both ways, a barge-in, the tools answered where they run and the
 * voice let go on, either end closing the other — and what still needs the
 * fleet: the sweeper's end reaching the owner from another replica, and a
 * killed owner's session settled from what it kept.
 *
 * Every test runs on both bindings: the voice agent's (`agent`) and Voice
 * Live's on a model it hosts (`voiceLive`), whose stand-in refuses anything
 * of a voice agent at the upgrade. The broker is the same code either way;
 * these prove it.
 */

const RUNTIMES = ["agent", "voiceLive"] as const;
type Runtime = (typeof RUNTIMES)[number];
const VOICE_LIVE_MODEL = "gpt-realtime-2.1";
/** The binding the running test is on. */
let runtime: Runtime = "agent";

/** One test per binding, each named for it: a timeout, or the bindings a test is about, may follow. */
function t(
	name: string,
	fn: () => Promise<void>,
	extra?: number | readonly Runtime[],
): void {
	const runtimes = Array.isArray(extra) ? extra : RUNTIMES;
	const timeout = typeof extra === "number" ? extra : undefined;
	for (const each of runtimes)
		test.skipIf(!REDIS_AVAILABLE)(
			`${name} [${each}]`,
			async () => {
				runtime = each;
				await fn();
			},
			timeout,
		);
}

/** The host, bound to the running test's binding. */
function hostFor(options: Parameters<typeof stubHost>[0] = {}) {
	return stubHost(
		runtime === "voiceLive"
			? { ...options, voiceLive: { model: VOICE_LIVE_MODEL } }
			: options,
	);
}
const LIMITS = {
	realtime: {
		burst: 1000,
		refillPerMinute: 1000,
		maxSessionSeconds: 30,
		idleSeconds: 10,
		secondsPerDay: 10_000,
		concurrentSessions: 1000,
	},
	global: { realtimeSecondsPerDay: 1_000_000 },
};
const VOICE = {
	live: {
		stageCallTimeoutMs: 400,
		drainGraceMs: 100,
		settleWaitMs: 300,
		connectTimeoutMs: 2_000,
		updateTimeoutMs: 2_000,
		responseRetry: { attempts: 2, backoffMs: 20, jitterMs: 0 },
	},
};
/** 50 ms of the person's audio at 24 kHz. */
const FRAME = new Uint8Array(2_400);

const namespace = throwawayNamespace();
const keys = voiceKeys(namespace);
const quiet: ReturnType<typeof spyOn>[] = [];
let log: ReturnType<typeof spyOn>;
let restoreConfig = () => {};
const cleanup: (() => unknown)[] = [];

beforeAll(() => {
	useThrowawayPrefix();
	useLimits(LIMITS);
	restoreConfig = fakeConfigStore({ voice: VOICE });
	resetVoiceSettings();
	for (const level of ["warn", "error"] as const)
		quiet.push(spyOn(console, level).mockImplementation(() => {}));
	log = spyOn(console, "log").mockImplementation(() => {});
});

afterEach(async () => {
	for (const step of cleanup.splice(0).reverse()) await step();
});

afterAll(async () => {
	for (const spy of quiet) spy.mockRestore();
	log.mockRestore();
	restoreConfig();
	resetVoiceSettings();
	useDefaultLimits();
	await sweepNamespace(namespace);
	await sweepMeteringKeys();
	resetMeteringKeyPrefix();
	closeSubscriber();
	await closeRedis();
});

function agent(overrides: Partial<FakeVoiceAgentOptions> = {}) {
	const fake = fakeVoiceAgent({
		agent: VOICE_AGENT,
		versions: ["1"],
		inputs: {
			personalization: { required: true },
			language: { required: true },
		},
		...overrides,
		...(runtime === "voiceLive"
			? { voiceLive: { model: VOICE_LIVE_MODEL } }
			: {}),
	});
	// Not awaited, as the backend's own server: a stop resolves only once every socket has finished closing.
	cleanup.push(() => void fake.stop());
	return fake;
}

/** A replica of the backend: a broker behind a server that upgrades every request as `who`. */
function backend(
	fake: { endpoint: string },
	options: { host?: ReturnType<typeof stubHost>; replica?: string } = {},
) {
	const host = options.host ?? hostFor();
	const broker = new VoiceBroker({
		host: host.host,
		namespace,
		endpoint: () => fake.endpoint,
		token: async () => "test-token",
		enabled: true,
		surface: "test",
		replica: options.replica ?? "replica-a",
		ownerTtlMs: 1_000,
	});
	let who: LiveCaller | null = null;
	const server = Bun.serve<BrowserSocket>({
		port: 0,
		fetch: (request, srv) =>
			who
				? broker.upgrade(request, srv, who)
				: new Response(null, { status: 401 }),
		websocket: broker.websocket,
	});
	cleanup.push(
		() => broker.drain(),
		// Not awaited: the stop resolves when every socket has finished closing, which a test need not wait for.
		() => void server.stop(true),
	);
	return {
		broker,
		host,
		/** A browser's socket, signed in as `as`. */
		async browser(as: LiveCaller): Promise<BrowserSocketClient> {
			who = as;
			const socket = await openBrowserSocket(`ws://127.0.0.1:${server.port}/`);
			cleanup.push(() => socket.close());
			return socket;
		},
	};
}

function person(name: string): LiveCaller & { subject: UsageSubject } {
	const who = subject(`${name}-${crypto.randomUUID().slice(0, 8)}`);
	return {
		subject: who,
		voice: {
			subject: who,
			tier: "base",
			language: { code: "it", name: "Italian" },
		},
		resourceId: who,
		identity: { oid: who, groups: [], tier: "base" },
	};
}

const is =
	<T extends ServerMessage["type"]>(
		type: T,
		match: Partial<Extract<ServerMessage, { type: T }>> = {},
	) =>
	(message: ServerMessage): message is Extract<ServerMessage, { type: T }> =>
		message.type === type &&
		Object.entries(match).every(
			([k, v]) => (message as Record<string, unknown>)[k] === v,
		);

/** A browser that started a session on `threadId` and was told it is ready. */
async function started(
	replica: ReturnType<typeof backend>,
	who: LiveCaller,
	threadId: string,
) {
	const browser = await replica.browser(who);
	browser.send({
		type: "start",
		threadId,
		screen: [{ label: "Open", value: "atlas" }],
	});
	const ready = await browser.next(is("ready"));
	return { browser, ready };
}

async function until(
	check: () => boolean | Promise<boolean>,
	timeoutMs = 3_000,
) {
	const deadline = Date.now() + timeoutMs;
	while (!(await check())) {
		if (Date.now() > deadline) throw new Error("timed out");
		await Bun.sleep(10);
	}
}

t(
	"a relayed round trip: the start admitted and ready, the person's update echoed after the service's own, the thread so far given, the audio both ways, the words in the pane, and the end settled once with only what was said",
	async () => {
		const fake = agent({
			answerAudioBytes: 9_600,
			autoplay: [
				{ heard: "Dov'è l'atlante?", answer: "Sul secondo scaffale." },
			],
		});
		const replica = backend(fake, {
			host: hostFor({
				history: [
					{ id: "hist_0", role: "user", text: "Ho scritto dell'atlante." },
					{ id: "hist_1", role: "assistant", text: "È in biblioteca." },
				],
			}),
		});
		const who = person("trip");
		const { browser, ready } = await started(replica, who, "thread-trip");
		expect(ready).toMatchObject({
			language: "it",
			audio: { sampleRate: 24_000 },
			session: { maxSessionSeconds: 30, idleSeconds: 10 },
		});
		expect(replica.host.bound[0]).toMatchObject({
			sessionId: ready.session.id,
			locale: "it",
			screen: [{ label: "Open", value: "atlas" }],
			caller: { oid: who.subject },
		});
		expect(await claimHolder(keys.owner(ready.session.id))).toEqual({
			outcome: "held",
			owner: "replica-a",
		});
		// The echo logged is the person's update, not the version's own that came first.
		expect(
			log.mock.calls.some((call: unknown[]) =>
				String(call[0]).includes(
					`session ${ready.session.id} updated: {"transcription":{"language":"it"}`,
				),
			),
		).toBe(true);
		// Voice Live echoes the flat shape; its voice is read off it, not logged as null.
		if (runtime === "voiceLive")
			expect(
				log.mock.calls.some((call: unknown[]) =>
					String(call[0]).includes(`"voice":{"name":"a-voice"`),
				),
			).toBe(true);

		// The thread's lines reached the session before the person spoke.
		expect(
			fake.received
				.filter((e) => e.type === "conversation.item.create")
				.map((e) => (e.item as { id: string }).id),
		).toEqual(["hist_0", "hist_1"]);
		expect(
			log.mock.calls.some(
				(call: unknown[]) =>
					String(call[0]) ===
					`[voice] session ${ready.session.id} was given 2 lines of its thread`,
			),
		).toBe(true);

		for (let i = 0; i < 4; i++) browser.sendAudio(FRAME);
		await browser.next(
			is("line", { role: "assistant", text: "Sul secondo scaffale." }),
		);
		await browser.next(is("response", { state: "done" }));
		expect(fake.appended()).toBe(4 * FRAME.byteLength);
		await until(() => browser.audioBytes() === 9_600);
		expect(
			browser.messages
				.map((m) => m.type)
				.filter(
					(type) => type === "speech" || type === "response" || type === "line",
				),
		).toEqual(["speech", "speech", "line", "response", "line", "response"]);

		browser.send({ type: "end" });
		expect(await browser.next(is("ended"))).toMatchObject({
			reason: "client",
			written: 2,
		});
		expect((await browser.closed).code).toBe(1000);
		// What the person sent and the service heard, on one line: silent frames, one speech.
		expect(
			log.mock.calls.some(
				(call: unknown[]) =>
					String(call[0]) ===
					`[voice] session ${ready.session.id} ending (client): the browser sent 4 audio frame(s), 9600 byte(s), peak 0.000 of full scale; speech heard 1 time(s)`,
			),
		).toBe(true);
		await until(() => fake.openSessions() === 0);
		expect(replica.host.settled.map((s) => s.sessionId)).toEqual([
			ready.session.id,
		]);
		// The given lines are the thread's already: the record holds what was said, and nothing else.
		expect(
			replica.host.settled[0]?.spoken
				.map((item) => item.itemId)
				.filter((id) => id.startsWith("hist_")),
		).toEqual([]);
		expect(await isSubjectLive(who.subject)).toBe(false);
	},
);

t(
	"words typed while the channel is open are one item of the person's, shown in the pane, answered by the voice, and written into the thread as said",
	async () => {
		const fake = agent();
		const replica = backend(fake);
		const who = person("typed");
		const { browser } = await started(replica, who, "thread-typed");
		browser.send({ type: "text", text: "  Show me the shelf.  " });
		expect(
			await browser.next(
				is("line", { role: "user", text: "Show me the shelf." }),
			),
		).toBeTruthy();
		await until(() => fake.received.some((e) => e.type === "response.create"));
		const sent = fake.received.map((e) => e.type);
		const item = fake.received.find(
			(e) =>
				e.type === "conversation.item.create" &&
				(e.item as { id?: string }).id === "typed_1",
		);
		expect(item?.item).toEqual({
			id: "typed_1",
			type: "message",
			role: "user",
			content: [{ type: "input_text", text: "Show me the shelf." }],
		});
		expect(sent.indexOf("response.create")).toBeGreaterThan(
			sent.indexOf("conversation.item.create"),
		);
		browser.send({ type: "end" });
		await browser.next(is("ended"));
		expect(
			replica.host.settled[0]?.spoken.flatMap((item) =>
				item.kind === "said" ? [`${item.role}: ${item.text}`] : [],
			),
		).toEqual(["user: Show me the shelf."]);
	},
);

/** The person's typed items the service was sent. */
const typedTo = (fake: ReturnType<typeof agent>) =>
	fake.received.filter(
		(e) =>
			e.type === "conversation.item.create" &&
			String((e.item as { id?: string }).id).startsWith("typed_"),
	);

/** What a settle was handed as said, in order. */
const saidIn = (replica: ReturnType<typeof backend>) =>
	replica.host.settled[0]?.spoken.flatMap((item) =>
		item.kind === "said" ? [item.text] : [],
	);

t(
	"typed messages beyond what a session takes at once are not taken: the pane is told, and none of them is sent on or written",
	async () => {
		const fake = agent();
		const replica = backend(fake);
		const { browser } = await started(replica, person("flood"), "thread-flood");
		for (let i = 1; i <= 9; i++)
			browser.send({ type: "text", text: `Message ${i}.` });
		const refused = () =>
			browser.messages.filter(is("error", { code: "text.too_fast" })).length;
		await until(() => refused() === 3);
		await until(() => typedTo(fake).length === 6);
		browser.send({ type: "end" });
		await browser.next(is("ended"));
		expect(typedTo(fake)).toHaveLength(6);
		expect(saidIn(replica)).toEqual(
			[1, 2, 3, 4, 5, 6].map((i) => `Message ${i}.`),
		);
	},
);

t(
	"typed words beyond what one session takes in all are not taken, however slowly they come",
	async () => {
		const fake = agent();
		const replica = backend(fake);
		const { browser } = await started(replica, person("full"), "thread-full");
		// Three bytes a character: five of these fit a session, six do not.
		const long = "界".repeat(4_000);
		for (let i = 0; i < 6; i++) browser.send({ type: "text", text: long });
		await browser.next(is("error", { code: "text.session_full" }));
		await until(() => typedTo(fake).length === 5);
		browser.send({ type: "end" });
		await browser.next(is("ended"));
		expect(saidIn(replica)).toHaveLength(5);
		expect(browser.messages.filter(is("error"))).toHaveLength(1);
	},
);

t(
	"audio faster than a microphone makes it is dropped before it is sent on, and a minute of it ends the session",
	async () => {
		const fake = agent();
		const replica = backend(fake);
		const { browser } = await started(replica, person("fast"), "thread-fast");
		const reported: string[] = [];
		const report = spyOn(voiceProblems, "report").mockImplementation(
			(code: string) => {
				reported.push(code);
			},
		);
		try {
			// Seventy seconds of audio, at once.
			const halfSecond = new Uint8Array(24_000);
			for (let i = 0; i < 140; i++) browser.sendAudio(halfSecond);
			expect(await browser.next(is("ended"))).toMatchObject({
				reason: "failed",
			});
			expect(reported).toContain("voice.live.input_refused");
			// What was taken is the burst and what filled meanwhile: seconds, never the minute sent.
			expect(fake.appended()).toBeLessThan(10 * 48_000);
		} finally {
			report.mockRestore();
		}
	},
);

t(
	"the screen's lines reach the service once a second at most, and the latest of them",
	async () => {
		const fake = agent();
		const replica = backend(fake);
		const { browser } = await started(
			replica,
			person("screen"),
			"thread-screen",
		);
		for (let i = 1; i <= 20; i++)
			browser.send({
				type: "screen",
				lines: [{ label: "Open", value: `page ${i}` }],
			});
		const shown = () =>
			fake.received.flatMap((e) => {
				const item = JSON.stringify(e.item ?? null);
				return e.type === "conversation.item.create" &&
					item.includes("Open: page")
					? [item]
					: [];
			});
		await until(() => shown().length === 2);
		await Bun.sleep(300);
		expect(shown()).toHaveLength(2);
		expect(shown()[0]).toMatch(/Open: page 1(?!\d)/);
		expect(shown()[1]).toMatch(/Open: page 20/);
	},
);

/** The structured lines of one kind the session wrote to stdout. */
const written = (evt: string, sessionId: string): Record<string, unknown>[] =>
	log.mock.calls.flatMap((call: unknown[]) => {
		try {
			const line = JSON.parse(String(call[0])) as Record<string, unknown>;
			return line.evt === evt && line.turnId === sessionId ? [line] : [];
		} catch {
			return [];
		}
	});

t(
	"each turn writes what it made the person wait — to the voice's first audio, to the answer's, and its tools' time — and each response's usage line says when its audio began",
	async () => {
		const fake = agent({ answerAudioBytes: 9_600 });
		const replica = backend(fake);
		const { browser, ready } = await started(
			replica,
			person("timed"),
			"thread-timed",
		);
		await fake.play({
			heard: "Trova l'atlante.",
			calls: [{ name: SERVER_TOOL, arguments: { title: "Atlas" } }],
			answer: "È nel secondo scaffale.",
		});
		await browser.next(is("line", { text: "È nel secondo scaffale." }));
		await browser.next(is("response", { state: "done" }));
		// The person speaks over the next answer; the turn before is written as this one begins.
		await fake.play({
			heard: "E il dizionario?",
			answer: "Sul terzo scaffale, accanto alla finestra.",
			bargeIn: true,
		});
		browser.send({ type: "end" });
		await browser.next(is("ended"));

		const turns = written("voice_turn", ready.session.id);
		expect(turns).toMatchObject([
			{
				surface: "test",
				model: `${VOICE_AGENT}:1`,
				how: "spoken",
				responses: 2,
				bargedIn: false,
				outcome: "answered",
			},
			{ how: "spoken", responses: 1, bargedIn: true, outcome: "answered" },
		]);
		const [first] = turns as { [key: string]: number }[];
		expect(first?.firstAudioMs).toBeGreaterThanOrEqual(0);
		expect(first?.answerAudioMs).toBeGreaterThanOrEqual(
			first?.firstAudioMs ?? 0,
		);
		expect(Object.keys(first?.toolMs ?? {})).toEqual([SERVER_TOOL]);
		// One usage line a response: the ones that spoke say how long their audio took to begin.
		const spoke = written("llm_usage", ready.session.id).filter(
			(line) => line.kind === "voice" && typeof line.ttftMs === "number",
		);
		expect(spoke.length).toBeGreaterThanOrEqual(2);
		// The provider names the runtime the session ran on.
		for (const line of spoke)
			expect(line.provider).toBe(
				runtime === "voiceLive" ? "voice-live" : "foundry-voice-agent",
			);
		for (const line of spoke)
			expect(line.ttftMs as number).toBeLessThanOrEqual(
				line.durationMs as number,
			);
	},
);

t(
	"a barge-in: the person's speech starting mid-answer reaches the pane after the voice's audio, so it stops playing, and the whole answer is written, marked",
	async () => {
		const fake = agent({ answerAudioBytes: 14_400 });
		const replica = backend(fake);
		const who = person("barge");
		const { browser } = await started(replica, who, "thread-barge");
		await fake.play({
			heard: "Parlami dell'atlante.",
			answer: "L'atlante è sul secondo scaffale vicino alla finestra.",
			bargeIn: true,
		});
		await browser.next(is("line", { role: "assistant" }));
		await until(() => browser.audioBytes() === 14_400);
		const speech = browser.messages.flatMap((m, i) =>
			m.type === "speech" && m.state === "started" ? [i] : [],
		);
		// Once as the person's turn began, once over the answer.
		expect(speech).toHaveLength(2);
		const answerStarted = browser.messages.findIndex(
			is("response", { state: "started" }),
		);
		expect(speech[1]).toBeGreaterThan(answerStarted);
		browser.send({ type: "end" });
		await browser.next(is("ended"));
		const said = replica.host.settled[0]?.spoken.flatMap((item) =>
			item.kind === "said"
				? [`${item.text}${item.interrupted ? " —" : ""}`]
				: [],
		);
		expect(said).toEqual([
			"Parlami dell'atlante.",
			"L'atlante è sul secondo scaffale vicino alla finestra. —",
		]);
	},
);

t(
	"the voice's tool calls reach this socket: the server's run here as the person, the stage's carried to the browser and back, one left unanswered closed for it, and the voice let go on once each response's calls are answered",
	async () => {
		const fake = agent();
		const replica = backend(fake);
		const who = person("tools");
		const { browser } = await started(replica, who, "thread-tools");
		const played = fake.play({
			heard: "Trova l'atlante e mostralo.",
			calls: [
				{ name: SERVER_TOOL, arguments: { title: "Atlas" } },
				{ name: STAGE_TOOL, arguments: { shelf: "second" } },
			],
			answer: "Eccolo.",
		});
		const call = await browser.next(is("stage-call", { name: STAGE_TOOL }));
		expect(call.args).toEqual({ shelf: "second" });
		expect(replica.host.toolRuns).toEqual([
			{ name: SERVER_TOOL, args: JSON.stringify({ title: "Atlas" }) },
		]);
		// The server's output is in, the stage's is not: the voice waits.
		await Bun.sleep(50);
		expect(fake.received.some((e) => e.type === "response.create")).toBe(false);
		browser.send({ type: "tool-output", callId: call.callId, output: "shown" });
		await played;
		await browser.next(is("line", { text: "Eccolo." }));
		const outputs = fake.received.flatMap((e) =>
			e.type === "conversation.item.create"
				? [(e.item as { call_id: string; output: string }).output]
				: [],
		);
		expect(outputs).toEqual([JSON.stringify({ shelf: "the second" }), "shown"]);
		expect(
			fake.received.filter((e) => e.type === "response.create"),
		).toHaveLength(1);

		// A stage call the browser never answers is answered for it, and the voice still goes on.
		const unanswered = fake.play({
			heard: "Mostralo ancora.",
			calls: [{ name: STAGE_TOOL, arguments: { shelf: "third" } }],
			answer: "Non ci sono riuscita.",
		});
		const closed = await browser.next(is("stage-call-closed"), 2_000);
		await unanswered;
		expect(fake.received.at(-2)).toMatchObject({
			item: {
				call_id: closed.callId,
				output: JSON.stringify({ error: "not_answered" }),
			},
		});
		// A late answer to a closed call goes nowhere.
		browser.send({
			type: "tool-output",
			callId: closed.callId,
			output: "late",
		});
		await browser.next(is("line", { text: "Non ci sono riuscita." }));
		expect(
			fake.received.some(
				(e) => (e.item as { output?: string } | undefined)?.output === "late",
			),
		).toBe(false);
		browser.send({ type: "end" });
		await browser.next(is("ended"));
	},
);

t(
	"an answer's sources reach the pane under it, decided as a typed turn's: what a backend tool retrieved since the person last spoke, and nothing when nothing was",
	async () => {
		const fake = agent();
		const replica = backend(fake);
		const who = person("sources");
		const { browser } = await started(replica, who, "thread-sources");
		const sources = () =>
			browser.messages.flatMap((message) =>
				message.type === "sources" ? [message.sources] : [],
			);
		const settled = async (text: string, count: number) => {
			await browser.next(is("line", { text }));
			await until(() => sources().length >= count);
			// Anything late would land now.
			await Bun.sleep(50);
		};

		// A backend tool's documents, under the answer that called nothing.
		await fake.play({
			heard: "Trova l'atlante.",
			calls: [{ name: SERVER_TOOL, arguments: { title: "Atlas" } }],
			answer: "È nel secondo scaffale, dice The Atlas.",
		});
		await settled("È nel secondo scaffale, dice The Atlas.", 1);
		expect(sources()).toEqual([[{ id: "atlas", title: "The Atlas" }]]);

		// Nothing retrieved since the person last spoke: no sources.
		await fake.play({ heard: "Grazie.", answer: "Prego." });
		await settled("Prego.", 1);
		expect(sources()).toHaveLength(1);

		browser.send({ type: "end" });
		await browser.next(is("ended"));
	},
);

t(
	"a turn's calls are bounded by the step limit a typed turn's are: the last calls answered, no further response asked for, and a call of a tool the session does not have told not to be called again",
	async () => {
		const fake = agent();
		const replica = backend(fake, { host: hostFor({ maxSteps: 1 }) });
		const who = person("steps");
		const { browser } = await started(replica, who, "thread-steps");
		// The service waits for a `response.create` that never comes; the session is ended before it gives up.
		void fake
			.play({
				heard: "Cerca l'atlante e poi cancella tutto.",
				calls: [
					{ name: SERVER_TOOL, arguments: { title: "Atlas" } },
					{ name: "eraseAll", arguments: {} },
				],
				answer: "Mai detto.",
			})
			.catch(() => {});
		const outputs = () =>
			fake.received.flatMap((e) =>
				e.type === "conversation.item.create" &&
				(e.item as { type?: string }).type === "function_call_output"
					? [(e.item as { output: string }).output]
					: [],
			);
		await until(() => outputs().length === 2);
		expect(JSON.parse(outputs()[1] as string)).toEqual({
			error: "not_available",
			message:
				"This control is not on this client. Do not call it again; give the reply in words.",
		});
		await Bun.sleep(200);
		expect(fake.received.some((e) => e.type === "response.create")).toBe(false);
		browser.send({ type: "end" });
		await browser.next(is("ended"));
	},
);

t(
	"either end closes the other: the browser going ends the voice agent's socket and settles; the service closing ends the browser's, with a filtered answer said to be blocked",
	async () => {
		const fake = agent();
		const replica = backend(fake);
		const first = await started(replica, person("leaves"), "thread-leaves");
		first.browser.close();
		await until(() => fake.openSessions() === 0);
		await until(() => replica.host.settled.length === 1);

		const who = person("service");
		const { browser } = await started(replica, who, "thread-service");
		await fake.play({ heard: "Qualcosa.", answer: "No.", filtered: true });
		await browser.next(is("error", { code: "turn.blocked" }));
		fake.hangUp(4002, "maintenance");
		expect(await browser.next(is("ended"))).toMatchObject({
			reason: "service",
		});
		expect((await browser.closed).code).toBe(1000);
		expect(replica.host.settled).toHaveLength(2);
		expect(await isSubjectLive(who.subject)).toBe(false);
	},
);

t(
	"a start is refused on the socket as a route would refuse it — a second session busy, a thread the host refuses with the seconds given back — and a message that is not one closes it",
	async () => {
		const fake = agent();
		const host = hostFor();
		const replica = backend(fake, { host });
		const who = person("refused");
		const { browser } = await started(replica, who, "thread-one");
		const second = await replica.browser(who);
		second.send({ type: "start", threadId: "thread-two" });
		expect(await second.next(is("refused"))).toMatchObject({
			status: 409,
			body: { code: "refused", reason: "busy" },
		});
		expect((await second.closed).code).toBe(4409);
		browser.send({ type: "end" });
		await browser.next(is("ended"));

		host.refuse("thread-theirs", {
			kind: "refused",
			refusal: { code: "thread.forbidden", status: 403 },
		});
		const theirs = await replica.browser(who);
		theirs.send({ type: "start", threadId: "thread-theirs" });
		expect(await theirs.next(is("refused"))).toEqual({
			type: "refused",
			status: 403,
			body: { code: "thread.forbidden" },
		});
		expect(await isSubjectLive(who.subject)).toBe(false);

		const garbled = await replica.browser(who);
		garbled.send({ type: "start", threadId: "a thread with spaces" });
		expect((await garbled.closed).code).toBe(4400);
		expect(fake.upgrades).toHaveLength(1);
	},
);

t(
	"without Redis a start is refused `unavailable` and nothing is dialled",
	async () => {
		const fake = agent();
		const replica = backend(fake);
		const who = person("noredis");
		const restore = scopedEnv({ REDIS_URL: undefined });
		try {
			await closeRedis();
			expect(replica.broker.available()).toBe(false);
			const browser = await replica.browser(who);
			browser.send({ type: "start", threadId: "thread-noredis" });
			expect(await browser.next(is("refused"))).toMatchObject({
				status: 503,
				body: { code: "refused", reason: "unavailable" },
			});
			expect(fake.upgrades).toHaveLength(0);
		} finally {
			restore();
			await closeRedis();
		}
	},
);

t("a handshake the service refuses is tried once more on the version made again", async () => {
	const fake = agent({ versions: ["2"] });
	const host = hostFor({ reensuredTo: "2" });
	const replica = backend(fake, { host });
	const { browser } = await started(
		replica,
		person("reensured"),
		"thread-again",
	);
	expect(host.reensured()).toBe(1);
	expect(fake.refusals).toEqual([{ status: 404, why: "no such version" }]);
	browser.send({ type: "end" });
	await browser.next(is("ended"));
}, ["agent"]);

t("on Voice Live a handshake the service refuses is the session's: no version is made again, and the browser is told handshake_failed", async () => {
	const fake = fakeVoiceAgent({
		agent: VOICE_AGENT,
		versions: [],
		inputs: {},
		voiceLive: { model: "another-model" },
	});
	cleanup.push(() => void fake.stop());
	const host = hostFor();
	const replica = backend(fake, { host });
	const browser = await replica.browser(person("vlrefused"));
	browser.send({ type: "start", threadId: "thread-vlrefused" });
	expect(await browser.next(is("refused"))).toMatchObject({
		status: 502,
		body: { code: "handshake_failed" },
	});
	expect(host.reensured()).toBe(0);
	expect(fake.refusals).toEqual([{ status: 400, why: "no such model" }]);
}, ["voiceLive"]);

t(
	"the sweeper's cutoff on another replica reaches the owner; a drain says `restart` and opens no new session",
	async () => {
		const fake = agent();
		const replica = backend(fake);
		const other = backend(fake, { replica: "replica-b" });
		const who = person("cutoff");
		const { browser, ready } = await started(replica, who, "thread-cutoff");
		expect(await other.broker.hangup(ready.session.id)).toEqual({
			status: 200,
		});
		expect(await browser.next(is("ended"))).toMatchObject({ reason: "idle" });

		const draining = await started(replica, person("drain"), "thread-drain");
		await replica.broker.drain();
		await draining.browser.next(is("ending", { reason: "restart" }));
		expect(await draining.browser.next(is("ended"))).toMatchObject({
			reason: "restart",
		});
		const refused = await replica.browser(person("late"));
		refused.send({ type: "start", threadId: "thread-late" });
		expect(await refused.next(is("refused"))).toMatchObject({ status: 503 });
	},
);

t(
	"a killed owner's session is settled by the sweeper on another replica, from the transcript the owner kept",
	async () => {
		const fake = agent();
		const host = hostFor();
		const other = backend(fake, { host, replica: "replica-b" });
		const who = person("killed");
		const child = Bun.spawn(
			["bun", join(import.meta.dir, "testing", "owner-process.ts")],
			{
				env: {
					...process.env,
					VOICE_TEST_ENDPOINT: fake.endpoint,
					...(runtime === "voiceLive"
						? { VOICE_TEST_MODEL: VOICE_LIVE_MODEL }
						: {}),
					VOICE_TEST_PREFIX: namespace.prefix,
					METERING_TEST_PREFIX: meteringKeys().prefix,
					VOICE_TEST_OPEN: JSON.stringify({
						subject: who.subject,
						limits: {
							...LIMITS,
							realtime: { ...LIMITS.realtime, idleSeconds: 1 },
						},
						voice: VOICE,
					}),
				},
				stdout: "pipe",
				stderr: "ignore",
			},
		);
		cleanup.push(() => child.kill(9));
		const { port } = await firstLine(child.stdout);
		const browser = await openBrowserSocket(`ws://127.0.0.1:${port}/`);
		browser.send({ type: "start", threadId: "thread-killed" });
		const ready = await browser.next(is("ready"));
		const id = ready.session.id;
		expect(await claimHolder(keys.owner(id))).toEqual({
			outcome: "held",
			owner: "replica-doomed",
		});
		await fake.play({ heard: "Ricorda l'atlante.", answer: "Lo farò." });
		await browser.next(is("line", { text: "Lo farò." }));
		// The owner keeps what was said at most once a second.
		await Bun.sleep(1_300);
		child.kill(9);
		await child.exited;
		await browser.closed;

		// Past the ledger's one-second window and the owner's claim, the sweeper runs here.
		await Bun.sleep(1_200);
		await sweepDueSessions((callId) => other.broker.hangup(callId));
		expect(host.settled).toHaveLength(1);
		expect(
			host.settled[0]?.spoken.flatMap((item) =>
				item.kind === "said" ? [item.text] : [],
			),
		).toEqual(["Ricorda l'atlante.", "Lo farò."]);
		expect(await isSubjectLive(who.subject)).toBe(false);
	},
	20_000,
);

async function firstLine(stdout: ReadableStream<Uint8Array>) {
	const reader = stdout.getReader();
	const decoder = new TextDecoder();
	let text = "";
	for (;;) {
		const { value, done } = await reader.read();
		if (done) throw new Error(`the owner said nothing: ${text}`);
		text += decoder.decode(value, { stream: true });
		const line = text.split("\n").find((l) => l.startsWith('{"port"'));
		if (line) {
			reader.releaseLock();
			return JSON.parse(line) as { port: number };
		}
	}
}

/** The `response.create`s the backend sent the service so far. */
const asks = (fake: { received: Record<string, unknown>[] }) =>
	fake.received.filter((e) => e.type === "response.create").length;

t(
	"a follow-up that fails with nothing said is asked again after a backoff, and once it answers the turn goes on as any other",
	async () => {
		const fake = agent();
		const replica = backend(fake);
		const { browser } = await started(replica, person("retry"), "thread-retry");
		await fake.play({
			heard: "Trova l'atlante.",
			calls: [{ name: SERVER_TOOL, arguments: { title: "Atlas" } }],
			failFollowUp: {
				times: 1,
				details: {
					type: "failed",
					error: { type: "server_error", code: "rate_limit_exceeded" },
				},
			},
			answer: "È nel secondo scaffale.",
		});
		await browser.next(is("line", { text: "È nel secondo scaffale." }));
		// One ask after the calls, one after the failure; no note.
		expect(asks(fake)).toBe(2);
		expect(
			fake.received.some(
				(e) => (e.item as { role?: string } | undefined)?.role === "system",
			),
		).toBe(false);
		expect(browser.messages.some(is("error"))).toBe(false);
		browser.send({ type: "end" });
		await browser.next(is("ended"));
	},
);

t(
	"once the asks are spent the voice is told once, as a system item and never the response's instructions, to say it could not answer, and the pane says so too",
	async () => {
		const fake = agent();
		const replica = backend(fake);
		const { browser } = await started(
			replica,
			person("gaveup"),
			"thread-gaveup",
		);
		await fake.play({
			heard: "Trova l'atlante.",
			calls: [{ name: SERVER_TOOL, arguments: { title: "Atlas" } }],
			failFollowUp: { times: 3 },
			answer: "Non riesco a trovarlo adesso.",
		});
		await browser.next(is("error", { code: "turn.unanswered" }));
		await browser.next(is("line", { text: "Non riesco a trovarlo adesso." }));
		// The ask after the calls, two retries, and the one after the note.
		expect(asks(fake)).toBe(4);
		const note = fake.received.findIndex(
			(e) => (e.item as { role?: string } | undefined)?.role === "system",
		);
		expect(fake.received[note]?.item).toEqual({
			type: "message",
			role: "system",
			content: [{ type: "input_text", text: UNANSWERED_NOTE }],
		});
		expect(fake.received[note + 1]).toEqual({ type: "response.create" });
		expect(
			fake.received.some(
				(e) =>
					e.type === "response.create" &&
					"response" in (e as Record<string, unknown>),
			),
		).toBe(false);
		expect(
			quiet[0]?.mock.calls.some((call: unknown[]) =>
				String(call[0]).includes(
					"a response ended failed with nothing said (type none, code none); gave_up",
				),
			),
		).toBe(true);
		browser.send({ type: "end" });
		await browser.next(is("ended"));
	},
);

t(
	"a failure asking again would not fix is only logged, and a pending ask is withdrawn by the person speaking",
	async () => {
		const fake = agent();
		const replica = backend(fake);
		const { browser } = await started(
			replica,
			person("norety"),
			"thread-noretry",
		);
		fake.emit({
			type: "response.created",
			response: { id: "resp_refused", usage: null },
		});
		fake.emit({
			type: "response.done",
			response: {
				id: "resp_refused",
				status: "failed",
				status_details: { error: { type: "invalid_request_error" } },
			},
		});
		await browser.next(is("response", { state: "done" }));
		await Bun.sleep(80);
		expect(asks(fake)).toBe(0);

		fake.emit({
			type: "response.created",
			response: { id: "resp_failed", usage: null },
		});
		fake.emit({
			type: "response.done",
			response: { id: "resp_failed", status: "failed" },
		});
		fake.emit({ type: "input_audio_buffer.speech_started", item_id: "next" });
		await browser.next(is("speech", { state: "started" }));
		await Bun.sleep(80);
		expect(asks(fake)).toBe(0);
		browser.send({ type: "end" });
		await browser.next(is("ended"));
	},
);

t(
	"a call answered while another response is open asks once that response is done, never beside it",
	async () => {
		const fake = agent();
		const replica = backend(fake);
		const { browser } = await started(replica, person("owed"), "thread-owed");
		const played = fake.play({
			heard: "Mostralo.",
			calls: [{ name: STAGE_TOOL, arguments: { shelf: "second" } }],
			answer: "Eccolo.",
		});
		const call = await browser.next(is("stage-call"));
		// The service's own turn detection opened a response meanwhile.
		fake.emit({
			type: "response.created",
			response: { id: "resp_vad", usage: null },
		});
		await browser.next((m) => m.type === "response" && m.state === "started");
		browser.send({ type: "tool-output", callId: call.callId, output: "shown" });
		await until(() =>
			fake.received.some(
				(e) => (e.item as { output?: string } | undefined)?.output === "shown",
			),
		);
		await Bun.sleep(50);
		expect(asks(fake)).toBe(0);
		fake.emit({
			type: "response.done",
			response: { id: "resp_vad", status: "completed" },
		});
		await played;
		expect(asks(fake)).toBe(1);
		await browser.next(is("line", { text: "Eccolo." }));
		browser.send({ type: "end" });
		await browser.next(is("ended"));
	},
);

t(
	"settings the service refuses end the session by name: before the session is ready, the open is refused and nothing is charged; after, the session ends `refused`",
	async () => {
		const refusing = agent({
			refuseUpdate: {
				code: "speech_frontend_not_available",
				message:
					"Noise reduction 'azure_deep_noise_suppression_headset' is not available for this session: upstream_vad_owned.",
			},
		});
		const first = backend(refusing);
		const who = person("refusedsettings");
		const browser = await first.browser(who);
		browser.send({ type: "start", threadId: "thread-refusedsettings" });
		expect(await browser.next(is("refused"))).toMatchObject({
			status: 502,
			body: { code: "settings_refused" },
		});
		expect(browser.messages.some(is("ready"))).toBe(false);
		expect(await isSubjectLive(who.subject)).toBe(false);
		await until(() => refusing.openSessions() === 0);

		const fake = agent();
		const replica = backend(fake);
		const after = await started(
			replica,
			person("refusedlater"),
			"thread-later",
		);
		// One event refused: the session carries on.
		fake.emit({
			type: "error",
			error: {
				type: "invalid_request_error",
				code: "conversation_already_has_active_response",
				event_id: null,
			},
		});
		fake.emit({
			type: "error",
			error: {
				type: "invalid_request_error",
				code: "invalid_input_audio_transcription_model",
				event_id: null,
			},
		});
		expect(await after.browser.next(is("ended"))).toMatchObject({
			reason: "refused",
		});
	},
);

t(
	"a refusal the service sends as the session opens — its rendered instructions past the cap, a version's noise suppression beside semantic_vad — refuses the open as settings_refused, never a session that answers without its instructions",
	async () => {
		for (const refuseOnOpen of [
			{
				code: "invalid_value",
				param: "session.instructions",
				message:
					"Instructions cannot be longer than 16384 tokens, you have provided 16813 tokens.",
			},
			{
				code: "speech_frontend_not_available",
				param: "session.input_audio_noise_reduction",
				message:
					"Noise reduction 'azure_deep_noise_suppression_headset' is not available for this session: upstream_vad_owned.",
			},
		]) {
			const fake = agent({ refuseOnOpen });
			const replica = backend(fake);
			const who = person("refusedonopen");
			const browser = await replica.browser(who);
			browser.send({ type: "start", threadId: "thread-refusedonopen" });
			expect(await browser.next(is("refused"))).toMatchObject({
				status: 502,
				body: { code: "settings_refused" },
			});
			expect(browser.messages.some(is("ready"))).toBe(false);
			expect(await isSubjectLive(who.subject)).toBe(false);
		}
	},
);

t(
	"the thread so far is given all or nothing: a line refused part-way takes every line out again, the deletes' own refusals unlogged, and the session runs without it",
	async () => {
		const fake = agent({ refuseHistoryLine: 1 });
		const replica = backend(fake, {
			host: hostFor({
				history: [
					{ id: "hist_0", role: "user", text: "Ho scritto dell'atlante." },
					{ id: "hist_1", role: "assistant", text: "È in biblioteca." },
					{ id: "hist_2", role: "user", text: "Dove?" },
				],
			}),
		});
		const { browser, ready } = await started(
			replica,
			person("rollback"),
			"thread-rollback",
		);
		const deletes = () =>
			fake.received
				.filter((e) => e.type === "conversation.item.delete")
				.map((e) => e.item_id);
		await until(() => deletes().length === 3);
		expect(deletes()).toEqual(["hist_0", "hist_1", "hist_2"]);
		await until(() => fake.items().length === 0);
		expect(
			quiet[0]?.mock.calls.some(
				(call: unknown[]) =>
					String(call[0]) ===
					`[voice] session ${ready.session.id}: the thread so far did not all take (invalid_value, item.content.0.type); its 3 lines were taken out again and the session runs without them`,
			),
		).toBe(true);
		await Bun.sleep(50);
		expect(
			quiet[0]?.mock.calls.some((call: unknown[]) =>
				String(call[0]).includes("item_delete_invalid_item_id"),
			),
		).toBe(false);
		browser.send({ type: "end" });
		await browser.next(is("ended"));
	},
);

t(
	"a cutoff the channel did not carry is not a dead owner: the session is left to its owner, whose heartbeat finds the end",
	async () => {
		const fake = agent();
		const replica = backend(fake);
		const other = backend(fake, { replica: "replica-b" });
		const { browser, ready } = await started(
			replica,
			person("unheard"),
			"thread-unheard",
		);
		await fake.play({ heard: "Ci sei?", answer: "Sono qui." });
		await browser.next(is("line", { text: "Sono qui." }));
		// The subscriber's connection goes; both of the session's sockets stay up.
		closeSubscriber();
		expect(await other.broker.hangup(ready.session.id)).toEqual({
			status: 202,
		});
		expect(replica.host.settled).toHaveLength(0);
		expect(fake.openSessions()).toBe(1);
		expect(await browser.next(is("ended"))).toMatchObject({ reason: "idle" });
		expect(replica.host.settled).toHaveLength(1);
		// The stand-in counts a session out when its own end of the socket hears the close, which can follow the owner's.
		await until(() => fake.openSessions() === 0);
	},
);

t(
	"a session nobody could claim is refused on the socket, its voice agent socket closed and its ledger settled",
	async () => {
		const fake = agent();
		const stub = hostFor();
		const bind = stub.host.liveVoiceBinding.bind(stub.host);
		// The session's claim taken by somebody else before the broker asks for it.
		stub.host.liveVoiceBinding = async (resourceId, threadId, request) => {
			await claimOnce(keys.owner(request.sessionId), "somebody-else", 5_000);
			return bind(resourceId, threadId, request);
		};
		const replica = backend(fake, { host: stub });
		const who = person("unclaimed");
		const browser = await replica.browser(who);
		browser.send({ type: "start", threadId: "thread-unclaimed" });
		expect(await browser.next(is("refused"))).toMatchObject({ status: 503 });
		await until(() => fake.openSessions() === 0);
		await until(async () => !(await isSubjectLive(who.subject)));
		expect(stub.settled).toHaveLength(1);
		expect(browser.messages.some(is("ready"))).toBe(false);
	},
);

t(
	"a browser that leaves while the session is being recorded is not handed a session: it is ended and settled",
	async () => {
		const fake = agent();
		const host = hostFor();
		const broker = new VoiceBroker({
			host: host.host,
			namespace,
			endpoint: () => fake.endpoint,
			token: async () => "test-token",
			enabled: true,
			surface: "test",
			replica: "replica-a",
			ownerTtlMs: 1_000,
		});
		const who = person("left");
		let socket: Bun.ServerWebSocket<BrowserSocket> | undefined;
		const server = Bun.serve<BrowserSocket>({
			port: 0,
			fetch: (request, srv) => broker.upgrade(request, srv, who),
			websocket: {
				...broker.websocket,
				open(ws) {
					socket = ws;
					broker.websocket.open?.(ws);
				},
			},
		});
		cleanup.push(
			() => broker.drain(),
			() => void server.stop(true),
		);
		// The update's echo is logged just before the ledger's record is written: the close lands while that write is out.
		log.mockImplementation((line: unknown) => {
			if (typeof line !== "string" || !line.includes(" updated: ")) return;
			log.mockImplementation(() => {});
			queueMicrotask(() => {
				if (socket) broker.websocket.close?.(socket, 1001, "gone");
			});
		});
		const browser = await openBrowserSocket(`ws://127.0.0.1:${server.port}/`);
		cleanup.push(() => browser.close());
		browser.send({ type: "start", threadId: "thread-left" });
		await until(() => host.settled.length === 1);
		await until(() => fake.openSessions() === 0);
		expect(await isSubjectLive(who.subject)).toBe(false);
		expect(browser.messages.some(is("ready"))).toBe(false);
	},
);

t(
	"the person's last words, heard by the service as the session ends, are waited for on the open socket and written",
	async () => {
		const fake = agent();
		const replica = backend(fake);
		const { browser } = await started(replica, person("last"), "thread-last");
		fake.emit({ type: "input_audio_buffer.speech_started", item_id: "in_x" });
		fake.emit({ type: "input_audio_buffer.speech_stopped", item_id: "in_x" });
		fake.emit({
			type: "input_audio_buffer.committed",
			previous_item_id: null,
			item_id: "in_x",
		});
		fake.emit({
			type: "conversation.item.added",
			previous_item_id: null,
			item: { id: "in_x", type: "message", role: "user" },
		});
		await browser.next(is("speech", { state: "stopped" }));
		browser.send({ type: "end" });
		await browser.next(is("ending"));
		fake.emit({
			type: "conversation.item.input_audio_transcription.completed",
			item_id: "in_x",
			content_index: 0,
			transcript: "Un'ultima cosa.",
		});
		await browser.next(is("ended"));
		expect(
			replica.host.settled[0]?.spoken.flatMap((item) =>
				item.kind === "said" ? [item.text] : [],
			),
		).toEqual(["Un'ultima cosa."]);
	},
);

t(
	"a thread that cannot be written is tried again, and when it still cannot be, the transcript stays in Redis",
	async () => {
		const fake = agent();
		const stub = hostFor();
		const settle = stub.host.settleLiveVoice.bind(stub.host);
		let failing = 1;
		stub.host.settleLiveVoice = async (...args) => {
			if (failing-- > 0) throw new Error("the store did not answer");
			return settle(...args);
		};
		const replica = backend(fake, { host: stub });
		const first = await started(replica, person("retried"), "thread-retried");
		await fake.play({ heard: "Scrivilo.", answer: "Scritto." });
		await first.browser.next(is("line", { text: "Scritto." }));
		first.browser.send({ type: "end" });
		expect(await first.browser.next(is("ended"))).toMatchObject({ written: 2 });
		const redis = await getRedis();
		expect(await redis?.get(keys.spoken(first.ready.session.id))).toBeNull();

		failing = Number.POSITIVE_INFINITY;
		const second = await started(replica, person("kept"), "thread-kept");
		await fake.play({ heard: "E questo?", answer: "Anche." });
		await second.browser.next(is("line", { text: "Anche." }));
		second.browser.send({ type: "end" });
		expect(await second.browser.next(is("ended", {}), 5_000)).toMatchObject({
			written: 0,
		});
		const kept = await redis?.get(keys.spoken(second.ready.session.id));
		expect(kept).toContain("E questo?");
		expect(kept).toContain("Anche.");
	},
	15_000,
);

t(
	"what the service says in refusing an event or an update is never logged: its code is",
	async () => {
		const fake = agent({
			refuseUpdate: {
				code: "unknown_parameter",
				message: "the person said: MY SECRET WORDS",
				param: "session.audio.output.voice",
			},
		});
		const replica = backend(fake);
		const { browser } = await started(replica, person("quoted"), "thread-q");
		fake.emit({
			type: "error",
			error: {
				type: "invalid_request_error",
				code: "conversation_already_has_active_response",
				message: "refused: MY SECRET WORDS",
				event_id: null,
			},
		});
		browser.send({ type: "end" });
		await browser.next(is("ended"));
		const logged = [...quiet, log]
			.flatMap((spy) => spy.mock.calls)
			.map((call) => call.join(" "));
		expect(logged.some((line) => line.includes("unknown_parameter"))).toBe(
			true,
		);
		expect(
			logged.some((line) =>
				line.includes("conversation_already_has_active_response"),
			),
		).toBe(true);
		expect(logged.some((line) => line.includes("MY SECRET WORDS"))).toBe(false);
	},
);

t(
	"an owner killed while its claim still stood is not left unsettled: the cutoff is looked at again once the claim has had its lifetime",
	async () => {
		const fake = agent();
		const replica = backend(fake);
		const who = person("late-lapse");
		const id = crypto.randomUUID();
		const store = sessionStore(keys, id, 60_000);
		await store.write({
			subject: who.subject,
			resourceId: who.resourceId,
			threadId: "thread-late-lapse",
			replica: "replica-dead",
		});
		await store.keepSpoken([
			{
				itemId: "in_1",
				previousItemId: null,
				at: new Date().toISOString(),
				kind: "said",
				role: "user",
				text: "Resta scritto.",
				interrupted: false,
			},
		]);
		// The owner died a moment ago: its claim outlives the ledger's one ask.
		await claimOnce(keys.owner(id), "replica-dead", 600);
		expect(await replica.broker.hangup(id)).toEqual({ status: 202 });
		expect(replica.host.settled).toHaveLength(0);
		await until(() => replica.host.settled.length === 1, 5_000);
		expect(replica.host.settled[0]).toMatchObject({
			sessionId: id,
			threadId: "thread-late-lapse",
		});
		await until(async () => (await store.read()) === null);
	},
	15_000,
);

t(
	"a replica that drains gives up the second looks it owed, by name: nothing is settled on a host that has stopped",
	async () => {
		const fake = agent();
		const replica = backend(fake);
		const who = person("drained-look");
		const id = crypto.randomUUID();
		const store = sessionStore(keys, id, 60_000);
		await store.write({
			subject: who.subject,
			resourceId: who.resourceId,
			threadId: "thread-drained-look",
			replica: "replica-dead",
		});
		await claimOnce(keys.owner(id), "replica-dead", 600);
		expect(await replica.broker.hangup(id)).toEqual({ status: 202 });
		const reported: string[] = [];
		const unsettled = spyOn(voiceProblems, "report").mockImplementation(
			(code: string) => {
				reported.push(code);
			},
		);
		const quiet = spyOn(console, "error").mockImplementation(() => {});
		try {
			await replica.broker.drain();
			expect(reported).toContain("voice.live.unsettled");
			// Past the claim's lifetime and the look's margin: the look would have settled it by now.
			await Bun.sleep(1_800);
			expect(replica.host.settled).toHaveLength(0);
			expect(await store.read()).not.toBeNull();
		} finally {
			unsettled.mockRestore();
			quiet.mockRestore();
		}
	},
	15_000,
);

t(
	"a session that is ending answers no call: no tool runs as the person, the stage is sent nothing, and no timer outlives it",
	async () => {
		const fake = agent();
		const replica = backend(fake);
		const { browser } = await started(replica, person("after"), "thread-after");
		// Words the service still owes a transcript for hold the socket open through the end.
		fake.emit({ type: "input_audio_buffer.speech_started", item_id: "in_y" });
		fake.emit({ type: "input_audio_buffer.speech_stopped", item_id: "in_y" });
		fake.emit({
			type: "input_audio_buffer.committed",
			previous_item_id: null,
			item_id: "in_y",
		});
		fake.emit({
			type: "conversation.item.added",
			previous_item_id: null,
			item: { id: "in_y", type: "message", role: "user" },
		});
		await browser.next(is("speech", { state: "stopped" }));
		browser.send({ type: "end" });
		await browser.next(is("ending"));
		for (const [i, name] of [SERVER_TOOL, STAGE_TOOL].entries())
			fake.emit({
				type: "response.function_call_arguments.done",
				response_id: "resp_late",
				item_id: `fc_late_${i}`,
				output_index: i,
				call_id: `call_late_${i}`,
				name,
				arguments: "{}",
			});
		await browser.next(is("ended"));
		// Past the stage call's own timeout: one set after the end would report now.
		await Bun.sleep(VOICE.live.stageCallTimeoutMs + 100);
		expect(replica.host.toolRuns).toEqual([]);
		expect(browser.messages.some(is("stage-call"))).toBe(false);
		expect(browser.messages.some(is("stage-call-closed"))).toBe(false);
		expect(
			fake.received.some(
				(e) =>
					(e.item as { type?: string } | undefined)?.type ===
					"function_call_output",
			),
		).toBe(false);
	},
);

t(
	"the owner's claim is kept while its end is still writing the thread, so nobody else settles the session meanwhile",
	async () => {
		const fake = agent();
		const stub = hostFor();
		const settle = stub.host.settleLiveVoice.bind(stub.host);
		stub.host.settleLiveVoice = async (...args) => {
			// Longer than the claim lives without a heartbeat.
			await Bun.sleep(1_600);
			return settle(...args);
		};
		const replica = backend(fake, { host: stub });
		const { browser, ready } = await started(
			replica,
			person("slow-settle"),
			"thread-slow-settle",
		);
		await fake.play({ heard: "Con calma.", answer: "Con calma." });
		await browser.next(is("line", { text: "Con calma." }));
		browser.send({ type: "end" });
		await browser.next(is("ending"));
		await Bun.sleep(1_300);
		expect(await claimHolder(keys.owner(ready.session.id))).toEqual({
			outcome: "held",
			owner: "replica-a",
		});
		await browser.next(is("ended"), 5_000);
		await until(
			async () =>
				(await claimHolder(keys.owner(ready.session.id))).outcome === "free",
		);
	},
	15_000,
);

t(
	"a thread written by a try that then failed is not reported as nothing written",
	async () => {
		const fake = agent();
		const stub = hostFor();
		const settle = stub.host.settleLiveVoice.bind(stub.host);
		let failing = 1;
		stub.host.settleLiveVoice = async (...args) => {
			const settled = await settle(...args);
			if (failing-- > 0) throw new Error("the answer was lost");
			return settled;
		};
		const replica = backend(fake, { host: stub });
		const { browser } = await started(
			replica,
			person("half"),
			"thread-half-settled",
		);
		await fake.play({ heard: "Scrivilo.", answer: "Scritto." });
		await browser.next(is("line", { text: "Scritto." }));
		browser.send({ type: "end" });
		expect(await browser.next(is("ended"))).toMatchObject({ written: 2 });
		expect(stub.settled).toHaveLength(1);
	},
	15_000,
);
