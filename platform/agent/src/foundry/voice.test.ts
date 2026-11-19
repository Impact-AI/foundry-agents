import { afterAll, beforeAll, expect, spyOn, test } from "bun:test";
import { cosmosDatabase } from "@platform/cosmos";
import {
	meterCall,
	resetMeteringKeyPrefix,
	setMeteringKeyPrefix,
	usageSubject,
} from "@platform/metering";
import { problemChannel } from "@platform/observability";
import { REDIS_AVAILABLE } from "@platform/redis/testing";
import { scopedEnv } from "@platform/test-support";
import type {
	AgentProduct,
	ProductLanguages,
	ProductTools,
} from "../contract/product";
import { WEB_SEARCH } from "../contract/product";
import { createFoundryAgentHost, type FoundryAgentHost } from "./host";
import type { FakeFoundry } from "./testing/fake-foundry";
import { foundryParityFactory } from "./testing/parity-factory";
import type { ThreadDocument } from "./threads";

/**
 * The voice agent's versions on the stand-in service: one
 * per definition across hosts, made in the job's step beside the typed
 * surfaces' versions of the agent — the voice surface has none of those —
 * holding the spoken prompt and the voice surface's tools itself, and the
 * preview opt-in on every call that touches the voice agent, which the
 * stand-in refuses without.
 */

const VOICE_AGENT = "sample-voice";
const languages: ProductLanguages = {
	codes: ["en", "it"],
	isLocale: (value) => value === "en" || value === "it",
	languageName: (code) => (code === "it" ? "Italian" : "English"),
	accent: (code) => (code === "it" ? "it-IT" : "en-US"),
};
let persona = "# CORE IDENTITY\nYou are the sample assistant.";
/** The voice document's OpenAI voice per tier, for the tests that give one. */
let openaiVoices = { base: "", premium: "" };
const product: AgentProduct = {
	agentId: "sample",
	serviceName: "sample-agent",
	toolKeys: [WEB_SEARCH],
	persona: async () => persona,
	guardrails: (channel) =>
		channel === "spoken" ? "Decline, in one sentence." : "Decline.",
	behaviour: ({ surface }) => `On the ${surface} surface, answer in one line.`,
	tools: (): ProductTools => ({}),
	clientTools: [
		{
			name: "showShelf",
			description: "Light up a shelf on the person's screen.",
			parameters: { type: "object", properties: { shelf: { type: "string" } } },
		},
	],
	skills: async () => [
		{
			name: "map-reading",
			description: "Use when somebody asks how to read an old map.",
			instructions:
				"Start at the legend, then the scale, then the north arrow.",
		},
	],
	voice: {
		agentId: VOICE_AGENT,
		surface: "live",
		languages,
		audio: async () => ({
			voices: { base: "base-voice", premium: "hd-voice" },
			openaiVoices,
			language: "stated",
		}),
	},
};

const factory = foundryParityFactory();
const t = test.skipIf(!REDIS_AVAILABLE);
let host: FoundryAgentHost;
let fake: FakeFoundry;

const voiceVersions = () => fake.state.agents.get(VOICE_AGENT) ?? [];
beforeAll(async () => {
	if (!REDIS_AVAILABLE) return;
	host = (await factory.create(product)) as FoundryAgentHost;
	fake = factory.fake();
});

afterAll(async () => {
	if (!REDIS_AVAILABLE) return;
	await host.stop();
	await factory.teardown();
});

t(
	"the start check reaches a voice agent that is not there yet, and the opt-in is sent",
	async () => {
		await host.start();
		expect(fake.requests).toContain(`GET /agents/${VOICE_AGENT}`);
	},
);

t(
	"two hosts priming at once make one voice version per definition, and no version of the agent for the voice surface: the voice agent holds the spoken prompt and the tools itself, web search and the skills among them as the backend's functions, never the service's tool",
	async () => {
		const second = createFoundryAgentHost(product);
		const [one, two] = await Promise.all([
			host.prime(["web", "live"]),
			second.prime(["web", "live"]),
		]);
		expect(one).toEqual(two);
		expect(one.voice).toEqual({ cascade: "1" });
		expect(one.versions).toHaveLength(1);
		expect(voiceVersions().map((v) => v.version)).toEqual(["1"]);
		const definition = voiceVersions()[0]?.definition;
		expect(definition).toMatchObject({
			kind: "voice",
			store: false,
			audio: { output: { voice: "base-voice" } },
		});
		const tools = (definition?.tools ?? []) as {
			name: string;
			description: string;
			parameters: unknown;
		}[];
		expect(tools.map((tool) => tool.name)).toEqual([
			"showShelf",
			"readSkill",
			WEB_SEARCH,
		]);
		const reader = tools.find((tool) => tool.name === "readSkill");
		// The skills that fit, listed as a typed turn's reader lists them; the words are read on demand.
		expect(reader?.description).toContain(
			"- map-reading: Use when somebody asks how to read an old map.",
		);
		expect(reader?.description).not.toContain("Start at the legend");
		expect(JSON.stringify(reader?.parameters)).toContain(
			'"enum":["map-reading"]',
		);
		expect(definition).not.toHaveProperty("subagent_config");
		expect(definition?.instructions).toContain("You are the sample assistant.");
		expect(definition?.instructions).toContain("Decline, in one sentence.");
		expect(definition?.instructions).toContain("On the live surface");
		expect(JSON.stringify(definition?.tools)).not.toContain("web_search");
		expect(voiceVersions()[0]?.metadata.hash).toMatch(/^[0-9a-f]{32}$/);
	},
);

t(
	"a new persona is a new voice version; the same words again are none",
	async () => {
		persona = "# CORE IDENTITY\nYou are the sample assistant, renamed.";
		const changed = await host.prime(["live"]);
		expect(changed.voice).toEqual({ cascade: "2" });
		expect(changed.versions).toEqual([]);
		expect((await host.prime(["live"])).voice).toEqual({ cascade: "2" });
		expect(voiceVersions()).toHaveLength(2);
	},
);

t(
	"the prune keeps the newest of each agent, the voice agent's through the opt-in",
	async () => {
		const undo = factory.editAgent({ foundry: { keepVersions: 2 } });
		try {
			persona = "# CORE IDENTITY\nYou are the sample assistant, once more.";
			const { pruned } = await host.prime(["live"]);
			expect(voiceVersions().map((v) => v.version)).toEqual(["2", "3"]);
			expect(pruned).toBeGreaterThanOrEqual(1);
		} finally {
			undo();
		}
	},
);

t(
	"a project that refuses the voice agent fails the start and the deploy: it is the only live engine",
	async () => {
		fake.failWhen((_method, path) => path.startsWith(`/agents/${VOICE_AGENT}`));
		try {
			await expect(host.start()).rejects.toThrow("outage");
			persona = "# CORE IDENTITY\nYou are the sample assistant, again.";
			await expect(host.prime(["web", "live"])).rejects.toThrow("400");
		} finally {
			fake.failWhen(null);
		}
	},
);

t(
	"a session's web search runs a response on the chat's deployment with the typed turns' web search tool, required, short and lightly reasoned, answers with what the pages said and which, and is withheld from a session nobody verified; its skill reader is a typed turn's",
	async () => {
		const { resourceId } = await factory.person();
		const caller = { oid: resourceId, groups: [], tier: "base" as const };
		const request = {
			sessionId: "voice-tools",
			maxSessionSeconds: 60,
			tier: "base" as const,
			locale: "en",
			caller,
		};
		const outcome = await host.liveVoiceBinding(
			resourceId,
			"thread-voice-tools",
			request,
		);
		if (outcome.kind !== "bound") throw new Error("not bound");
		const { tools } = outcome.binding;
		expect(tools.onServer(WEB_SEARCH)).toBe(true);
		expect(tools.onServer("readSkill")).toBe(true);

		fake.script({
			text: "It is 11 °C in Stockholm today.【3:0†source】",
			web: [
				{ url: "https://weather.example/sthlm", title: "Stockholm weather" },
			],
		});
		const searched = JSON.parse(
			(
				await tools.run(
					WEB_SEARCH,
					'{"query":"What is the weather in Stockholm?"}',
				)
			).output,
		);
		expect(searched).toEqual({
			answer: "It is 11 °C in Stockholm today.",
			sources: [
				{ url: "https://weather.example/sthlm", title: "Stockholm weather" },
			],
		});
		const seen = fake.turns().at(-1);
		expect(seen?.agent.name).toBe("model:chat");
		expect(seen?.body).toMatchObject({
			store: false,
			tools: [{ type: "web_search", search_context_size: "medium" }],
			tool_choice: "required",
			max_output_tokens: 300,
			reasoning: { effort: "low" },
			input: [{ role: "user", content: "What is the weather in Stockholm?" }],
		});

		expect(
			JSON.parse(
				(await tools.run("readSkill", '{"name":"map-reading"}')).output,
			),
		).toEqual({
			name: "map-reading",
			instructions:
				"Start at the legend, then the scale, then the north arrow.",
		});
		expect(
			JSON.parse((await tools.run("readSkill", '{"name":"elsewhere"}')).output),
		).toMatchObject({ error: "invalid_arguments" });
		await host.settleLiveVoice(resourceId, "thread-voice-tools", {
			sessionId: request.sessionId,
			spoken: [],
		});

		// Nobody verified: no account to charge, so no web search, in the words or the tools.
		const anonymous = await host.liveVoiceBinding(
			resourceId,
			"thread-voice-anonymous",
			{ ...request, sessionId: "voice-anonymous", caller: undefined },
		);
		if (anonymous.kind !== "bound") throw new Error("not bound");
		expect(anonymous.binding.tools.onServer(WEB_SEARCH)).toBe(false);
		await host.settleLiveVoice(resourceId, "thread-voice-anonymous", {
			sessionId: "voice-anonymous",
			spoken: [],
		});
	},
);

t(
	"on the service's conversations a live session is seeded from the thread's conversation and its lines are added to it, each with when it was said, while the voice agent keeps nothing",
	async () => {
		const { resourceId } = await factory.person();
		const threadId = "thread-voice-conversation";
		const undo = factory.editAgent({ history: { store: "foundry" } });
		try {
			fake.answer("Heron it is.");
			const started = await host.startTurn({
				resourceId,
				threadId,
				messages: [
					{ id: "m1", role: "user", content: "The codename is Heron." },
				],
				surface: "web",
				languageName: "English",
			});
			if (started.kind !== "started") throw new Error("refused");
			for (const reader = started.events.getReader(); ; )
				if ((await reader.read()).done) break;
		} finally {
			undo();
		}
		const outcome = await host.liveVoiceBinding(resourceId, threadId, {
			sessionId: "voice-conversation",
			maxSessionSeconds: 60,
			tier: "base",
			locale: "en",
		});
		if (outcome.kind !== "bound") throw new Error("not bound");
		expect(outcome.binding.history).toEqual([
			{ id: "hist_0", role: "user", text: "The codename is Heron." },
			{ id: "hist_1", role: "assistant", text: "Heron it is." },
		]);
		expect(voiceVersions().at(-1)?.definition).toMatchObject({ store: false });
		const at = (n: number) =>
			new Date(Date.UTC(2026, 0, 2, 9, 0, n)).toISOString();
		const settled = await host.settleLiveVoice(resourceId, threadId, {
			sessionId: "voice-conversation",
			spoken: [
				{
					kind: "said",
					itemId: "s1",
					previousItemId: null,
					at: at(1),
					role: "user",
					text: "And the second one?",
					interrupted: false,
				},
				{
					kind: "said",
					itemId: "s2",
					previousItemId: "s1",
					at: at(2),
					role: "assistant",
					text: "Egret.",
					interrupted: false,
				},
			],
		});
		expect(settled).toMatchObject({ written: 2, repeated: false });
		const read = await host.readThread(resourceId, threadId);
		expect(read?.messages.slice(-2)).toEqual([
			expect.objectContaining({
				text: "And the second one?",
				createdAt: at(1),
			}),
			expect.objectContaining({ text: "Egret.", createdAt: at(2) }),
		]);
		// Written into the conversation itself, as the service's items.
		const thread = await cosmosDatabase()
			.container("threads")
			.read<ThreadDocument>(threadId, resourceId);
		const items = fake.state.items.get(thread?.conversation?.id ?? "") ?? [];
		expect(JSON.stringify(items.slice(-2))).toContain("Egret.");
		expect(
			fake.requests.filter((r) =>
				r.startsWith(
					`POST /openai/v1/conversations/${thread?.conversation?.id}/items`,
				),
			),
		).toHaveLength(1);
		await host.eraseResource(resourceId);
	},
);

/** The voice document's engines, the realtime deployment in the environment or not, for one test. */
function engines(
	voice: Record<string, unknown>,
	realtime: { deployment?: string; model?: string },
): () => void {
	const undoAgent = factory.editAgent({ voice });
	const undoEnv = scopedEnv({
		AZURE_OPENAI_REALTIME_DEPLOYMENT: realtime.deployment,
		AZURE_OPENAI_REALTIME_MODEL: realtime.model,
	});
	return () => {
		undoEnv();
		undoAgent();
	};
}

/** The problem codes reported while `run` runs, the console quiet. */
async function reported(run: () => Promise<void>): Promise<unknown[]> {
	const codes: unknown[] = [];
	problemChannel.setSink((line) => codes.push(line.attributes["problem.code"]));
	const error = spyOn(console, "error").mockImplementation(() => {});
	const warn = spyOn(console, "warn").mockImplementation(() => {});
	try {
		await run();
	} finally {
		problemChannel.setSink(null);
		error.mockRestore();
		warn.mockRestore();
	}
	return codes;
}

const versionFor = (version: string) =>
	voiceVersions().find((v) => v.version === version)?.definition as
		| { model: string; audio: { input: { transcription: unknown } } }
		| undefined;

t(
	"one engine per tier makes two versions of the one voice agent, each session asks for its tier's, and the prune keeps both",
	async () => {
		const undo = engines(
			{
				engine: "cascade",
				engineByTier: { premium: "speechToSpeech" },
				// Documented beside a cascade only: speech-to-speech's version replaces it.
				transcription: "azure-speech",
			},
			{ deployment: "realtime", model: "gpt-realtime-2.1" },
		);
		const undoKeep = factory.editAgent({ foundry: { keepVersions: 1 } });
		try {
			persona = "# CORE IDENTITY\nYou are the sample assistant, in two voices.";
			const primed = await host.prime(["live"]);
			expect(Object.keys(primed.voice)).toEqual(["cascade", "speechToSpeech"]);
			const cascade = versionFor(primed.voice.cascade ?? "");
			const realtime = versionFor(primed.voice.speechToSpeech ?? "");
			expect(cascade?.model).toBe("chat");
			expect(cascade?.audio.input.transcription).toEqual({
				model: "azure-speech",
			});
			expect(realtime?.model).toBe("realtime");
			expect(realtime?.audio.input.transcription).toEqual({
				model: "mai-transcribe",
			});
			// keepVersions 1 would keep only the newest: the other engine's current one is kept as well,
			// and so is every version a session earlier in this file was marked as running on.
			const kept = voiceVersions().map((v) => v.version);
			expect(kept).toContain(primed.voice.cascade as string);
			expect(kept).toContain(primed.voice.speechToSpeech as string);
			expect(primed.pruned).toBeGreaterThan(0);

			const { resourceId } = await factory.person();
			for (const [tier, engine] of [
				["base", "cascade"],
				["premium", "speechToSpeech"],
			] as const) {
				const sessionId = `voice-tier-${tier}`;
				const outcome = await host.liveVoiceBinding(
					resourceId,
					`thread-${sessionId}`,
					{ sessionId, maxSessionSeconds: 60, tier, locale: "en" },
				);
				if (outcome.kind !== "bound") throw new Error("not bound");
				const { binding } = outcome;
				expect(binding.agentName).toBe(VOICE_AGENT);
				// This session has no searches in hand, so its version is not the job's; its engine's model is.
				expect(versionFor(binding.version)?.model).toBe(
					engine === "cascade" ? "chat" : "realtime",
				);
				const session = binding.session as unknown as {
					reasoning?: unknown;
					audio: { input: { transcription: { model: string } } };
				};
				if (engine === "cascade") {
					expect(session.reasoning).toEqual({ effort: "low" });
					expect(session.audio.input.transcription.model).toBe("azure-speech");
				} else {
					expect(session.reasoning).toEqual({ effort: "low" });
					expect(session.audio.input.transcription.model).toBe(
						"mai-transcribe",
					);
				}
				// A version gone from the service is made again for this engine alone.
				fake.state.agents.set(
					VOICE_AGENT,
					voiceVersions().filter((v) => v.version !== binding.version),
				);
				const again = await binding.reensure();
				expect(versionFor(again)?.model).toBe(
					engine === "cascade" ? "chat" : "realtime",
				);
				await host.settleLiveVoice(resourceId, `thread-${sessionId}`, {
					sessionId,
					spoken: [],
				});
			}
		} finally {
			undoKeep();
			undo();
		}
	},
);

t(
	"a realtime model that does not reason is sent no effort, and neither is one set to none",
	async () => {
		const { resourceId } = await factory.person();
		for (const [model, effort] of [
			["gpt-realtime-mini", "high"],
			["gpt-realtime-2.1", "none"],
		] as const) {
			const undo = engines(
				{ engine: "speechToSpeech", realtimeReasoningEffort: effort },
				{ deployment: "realtime", model },
			);
			try {
				const sessionId = `voice-reasoning-${model}-${effort}`;
				const outcome = await host.liveVoiceBinding(
					resourceId,
					`thread-${sessionId}`,
					{ sessionId, maxSessionSeconds: 60, tier: "base", locale: "en" },
				);
				if (outcome.kind !== "bound") throw new Error("not bound");
				expect(outcome.binding.session).not.toHaveProperty("reasoning");
				expect(versionFor(outcome.binding.version)?.model).toBe("realtime");
				await host.settleLiveVoice(resourceId, `thread-${sessionId}`, {
					sessionId,
					spoken: [],
				});
			} finally {
				undo();
			}
		}
	},
);

t(
	"speech-to-speech with no realtime deployment runs the cascade, and the start says so under a code",
	async () => {
		const undo = engines({ engine: "speechToSpeech" }, {});
		try {
			const codes = await reported(async () => {
				await host.start();
			});
			expect(codes).toContain("agent.voice.speech_to_speech_unconfigured");
			const primed = await host.prime(["live"]);
			expect(Object.keys(primed.voice)).toEqual(["cascade"]);
			expect(versionFor(primed.voice.cascade ?? "")?.model).toBe("chat");
			const { resourceId } = await factory.person();
			const outcome = await host.liveVoiceBinding(
				resourceId,
				"thread-voice-unconfigured",
				{
					sessionId: "voice-unconfigured",
					maxSessionSeconds: 60,
					tier: "premium",
					locale: "en",
				},
			);
			if (outcome.kind !== "bound") throw new Error("not bound");
			expect(versionFor(outcome.binding.version)?.model).toBe("chat");
			await host.settleLiveVoice(resourceId, "thread-voice-unconfigured", {
				sessionId: "voice-unconfigured",
				spoken: [],
			});
		} finally {
			undo();
		}
	},
);

t(
	"a refused speech-to-speech version fails the deploy, as a refused cascade one does",
	async () => {
		const undo = engines(
			{ engine: "cascade", engineByTier: { premium: "speechToSpeech" } },
			{ deployment: "realtime-refused", model: "gpt-realtime-2.1" },
		);
		// The cascade's version for these words is already held: only the new engine's is asked for.
		fake.failWhen(
			(method, path) =>
				method === "POST" && path.startsWith(`/agents/${VOICE_AGENT}`),
		);
		try {
			await expect(host.prime(["live"])).rejects.toThrow("outage");
		} finally {
			fake.failWhen(null);
			undo();
		}
	},
);

t(
	"a tier the voice document gives an OpenAI voice speaks it on speech-to-speech, on a version with no fillers that the job makes and keeps, while the cascade's tier keeps its Azure voice",
	async () => {
		const undo = engines(
			{ engine: "cascade", engineByTier: { premium: "speechToSpeech" } },
			{ deployment: "realtime", model: "gpt-realtime-2.1" },
		);
		const undoKeep = factory.editAgent({ foundry: { keepVersions: 1 } });
		openaiVoices = { base: "marin", premium: "cedar" };
		try {
			persona =
				"# CORE IDENTITY\nYou are the sample assistant, in its own voice.";
			const primed = await host.prime(["live"]);
			type Spoken = {
				model: string;
				interim_response?: unknown;
				audio: { output: { voice_type: string; voice: string } };
			};
			const spoken = (version: string) =>
				voiceVersions().find((v) => v.version === version)?.definition as
					| Spoken
					| undefined;
			const own = voiceVersions().filter(
				(v) => (v.definition as Spoken).audio.output.voice === "cedar",
			);
			// The base tier runs the cascade, so its OpenAI voice makes no version.
			expect(
				voiceVersions().some(
					(v) => (v.definition as Spoken).audio.output.voice === "marin",
				),
			).toBe(false);
			expect(own.at(-1)?.definition).toMatchObject({
				model: "realtime",
				audio: { output: { voice_type: "openai", voice: "cedar" } },
			});
			expect(own.at(-1)?.definition).not.toHaveProperty("interim_response");
			expect(
				spoken(primed.voice.speechToSpeech ?? "")?.interim_response,
			).toBeTruthy();

			const { resourceId } = await factory.person();
			for (const tier of ["base", "premium"] as const) {
				const sessionId = `voice-openai-${tier}`;
				const outcome = await host.liveVoiceBinding(
					resourceId,
					`thread-${sessionId}`,
					{ sessionId, maxSessionSeconds: 60, tier, locale: "it" },
				);
				if (outcome.kind !== "bound") throw new Error("not bound");
				const session = outcome.binding.session as unknown as {
					interim_response?: unknown;
					audio: { output: Record<string, unknown> };
				};
				const version = spoken(outcome.binding.version);
				if (tier === "premium") {
					expect(version?.audio.output).toEqual({
						voice_type: "openai",
						voice: "cedar",
					});
					expect(version).not.toHaveProperty("interim_response");
					expect(session.audio.output).toEqual({
						voice_type: "openai",
						voice: "cedar",
					});
					expect(session).not.toHaveProperty("interim_response");
				} else {
					expect(version?.audio.output.voice_type).toBe("azure-standard");
					expect(session.audio.output).toMatchObject({
						voice_type: "azure-standard",
						voice: "base-voice",
					});
				}
				await host.settleLiveVoice(resourceId, `thread-${sessionId}`, {
					sessionId,
					spoken: [],
				});
			}
		} finally {
			openaiVoices = { base: "", premium: "" };
			undoKeep();
			undo();
		}
	},
);

t(
	"a managed model the document names is the engine's version, model_type managed, made with no realtime deployment, and the prune keeps it and a tester's managed version a session runs on",
	async () => {
		const undo = engines(
			{
				engine: "speechToSpeech",
				managedModel: {
					cascade: "",
					speechToSpeech: "gpt-realtime-2.1-datazone",
				},
			},
			{},
		);
		const undoKeep = factory.editAgent({ foundry: { keepVersions: 1 } });
		try {
			persona =
				"# CORE IDENTITY\nYou are the sample assistant, on a managed model.";
			const codes = await reported(async () => {
				await host.start();
			});
			// A managed realtime model is a model to run on: nothing falls back to the cascade.
			expect(codes).not.toContain("agent.voice.speech_to_speech_unconfigured");
			const primed = await host.prime(["live"]);
			expect(Object.keys(primed.voice)).toEqual(["speechToSpeech"]);
			const made = voiceVersions().find(
				(v) => v.version === primed.voice.speechToSpeech,
			)?.definition as { model_type: string; model: string } | undefined;
			expect(made).toMatchObject({
				model_type: "managed",
				model: "gpt-realtime-2.1-datazone",
			});

			// A tester's session on another managed model: its version is marked in use and survives the next prune.
			const { resourceId } = await factory.person();
			const sessionId = "voice-managed-tester";
			const outcome = await host.liveVoiceBinding(
				resourceId,
				`thread-${sessionId}`,
				{
					sessionId,
					maxSessionSeconds: 60,
					tier: "base",
					locale: "en",
					tuning: { managedModel: "gpt-realtime-mini" },
				},
			);
			if (outcome.kind !== "bound") throw new Error("not bound");
			const tested = outcome.binding.version;
			expect(
				voiceVersions().find((v) => v.version === tested)?.definition,
			).toMatchObject({ model_type: "managed", model: "gpt-realtime-mini" });
			// gpt-realtime-mini takes no effort, so none is sent.
			expect(outcome.binding.session).not.toHaveProperty("reasoning");
			persona = "# CORE IDENTITY\nYou are the sample assistant, primed again.";
			const again = await host.prime(["live"]);
			const kept = voiceVersions().map((v) => v.version);
			expect(kept).toContain(tested);
			expect(kept).toContain(again.voice.speechToSpeech as string);
			await host.settleLiveVoice(resourceId, `thread-${sessionId}`, {
				sessionId,
				spoken: [],
			});
		} finally {
			undoKeep();
			undo();
		}
	},
);

t(
	"a session asks the toolSearch bucket at each search, not once as it opens: an empty bucket refuses the call, and a bucket that refills mid-session searches again, as the next typed turn would",
	async () => {
		setMeteringKeyPrefix(`test-meter-${crypto.randomUUID()}`);
		try {
			const { resourceId } = await factory.person();
			const subject = usageSubject(resourceId);
			if (!subject) throw new Error("no subject");
			while ((await meterCall(subject, "toolSearch", "base")).ok);
			const sessionId = "voice-search-empty";
			const outcome = await host.liveVoiceBinding(
				resourceId,
				`thread-${sessionId}`,
				{
					sessionId,
					maxSessionSeconds: 60,
					tier: "base",
					locale: "en",
					caller: { oid: resourceId, groups: [], tier: "base" },
				},
			);
			if (outcome.kind !== "bound") throw new Error("not bound");
			const { tools, version } = outcome.binding;
			expect(tools.onServer(WEB_SEARCH)).toBe(true);
			const before = fake.turns().length;
			expect(
				JSON.parse(
					(await tools.run(WEB_SEARCH, '{"query":"Is it raining?"}')).output,
				),
			).toEqual({ error: "rate_limited" });
			expect(fake.turns()).toHaveLength(before);
			// The version does not depend on who is asking: the job made the same one.
			expect((await host.prime(["live"])).voice.cascade).toBe(version);
			await host.settleLiveVoice(resourceId, `thread-${sessionId}`, {
				sessionId,
				spoken: [],
			});
		} finally {
			resetMeteringKeyPrefix();
		}
	},
);

t(
	"on the voiceLive runtime a session makes no voice version: it is bound to Voice Live on a model it hosts, its update holding the whole session — the prompt with the person's part rendered, every tool, the voice, the transcriber, the hearing — and the tools still run on the backend",
	async () => {
		const undo = engines({ runtime: "voiceLive", engine: "cascade" }, {});
		try {
			const before = voiceVersions().length;
			const { resourceId } = await factory.person();
			const sessionId = "voice-live-runtime";
			const outcome = await host.liveVoiceBinding(
				resourceId,
				`thread-${sessionId}`,
				{
					sessionId,
					maxSessionSeconds: 60,
					tier: "premium",
					locale: "it",
					caller: { oid: resourceId, groups: [], tier: "premium" },
				},
			);
			if (outcome.kind !== "bound") throw new Error("not bound");
			const { binding } = outcome;
			expect(voiceVersions()).toHaveLength(before);
			// The first cascade model Voice Live hosts, with none named.
			expect(binding.runtime).toEqual({ kind: "voiceLive", model: "gpt-5.4" });
			expect(binding.version).toBe("gpt-5.4");
			const session = binding.session;
			expect(session).not.toHaveProperty("type");
			expect(session.instructions).toContain("You are the sample assistant");
			expect(session.instructions).not.toContain("{{");
			expect(session).toMatchObject({
				voice: { name: "hd-voice", type: "azure-standard" },
				input_audio_transcription: { model: "mai-transcribe", language: "it" },
				input_audio_noise_reduction: {
					type: "azure_deep_noise_suppression_headset",
				},
				turn_detection: { type: "azure_semantic_vad_multilingual" },
				tool_choice: "auto",
			});
			const names = (session.tools as { name: string }[]).map((t) => t.name);
			expect(names).toEqual(
				expect.arrayContaining(["showShelf", WEB_SEARCH, "readSkill"]),
			);
			expect(binding.tools.onServer(WEB_SEARCH)).toBe(true);
			expect(binding.tools.inBrowser("showShelf")).toBe(true);
			expect(await binding.reensure()).toBe("gpt-5.4");
			await host.settleLiveVoice(resourceId, `thread-${sessionId}`, {
				sessionId,
				spoken: [],
			});
		} finally {
			undo();
		}
	},
);
