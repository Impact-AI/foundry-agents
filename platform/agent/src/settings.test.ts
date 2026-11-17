import { expect, spyOn, test } from "bun:test";
import { problemChannel } from "@platform/observability";
import { scopedEnv } from "@platform/test-support";
import {
	DEFAULT_AGENT_SETTINGS,
	defaultAgentSettings,
	memoryStoreFor,
	parseAgentSettings,
	transcriberFor,
	voiceEngineForTier,
	voiceEnginesNamed,
} from "./settings";

test("a stored document is merged field by field and a bad field keeps its default", () => {
	const parsed = parseAgentSettings(
		{
			reasoningEffort: "high",
			reasoningSummary: "detailed",
			turns: { burst: 3, refillPerMinute: "lots" },
			memory: {
				store: "elsewhere",
				updateDelaySeconds: 0,
				maxChars: -1,
				foundry: { chatSummary: true, ttlSeconds: -5 },
			},
		},
		DEFAULT_AGENT_SETTINGS,
	);
	expect(parsed.reasoningEffort).toBe("high");
	expect(parsed.reasoningSummary).toBe("detailed");
	expect(parsed.turns).toEqual({ burst: 3, refillPerMinute: 30 });
	expect(parsed.memory.updateDelaySeconds).toBe(0);
	expect(parsed.memory.maxChars).toBe(DEFAULT_AGENT_SETTINGS.memory.maxChars);
	// A store that is neither is the default: a typo cannot leave a deployment without memory.
	expect(parsed.memory.store).toBe("foundry");
	expect(parsed.memory.foundry).toEqual({
		chatSummary: true,
		procedural: false,
		ttlSeconds: 0,
	});
	expect(parsed.titles).toEqual(DEFAULT_AGENT_SETTINGS.titles);
	expect(parsed.foundry).toEqual(DEFAULT_AGENT_SETTINGS.foundry);
});

test("the own store is the other answer, and the default is the Foundry store", () => {
	expect(DEFAULT_AGENT_SETTINGS.memory.store).toBe("foundry");
	expect(
		parseAgentSettings({ memory: { store: "own" } }, DEFAULT_AGENT_SETTINGS)
			.memory.store,
	).toBe("own");
	expect(
		parseAgentSettings({ memory: { store: 1 } }, DEFAULT_AGENT_SETTINGS).memory
			.store,
	).toBe("foundry");
});

test("an extraction may wait no time at all, a statement may live for ever, and a turn may not take no steps", () => {
	const parsed = parseAgentSettings(
		{
			memory: { updateDelaySeconds: 0, foundry: { ttlSeconds: 0 } },
			foundry: { maxSteps: 0, keepVersions: 2.5, maxItemsRead: 50 },
		},
		{
			...DEFAULT_AGENT_SETTINGS,
			memory: {
				...DEFAULT_AGENT_SETTINGS.memory,
				foundry: { ...DEFAULT_AGENT_SETTINGS.memory.foundry, ttlSeconds: 3600 },
			},
		},
	);
	expect(parsed.memory.updateDelaySeconds).toBe(0);
	expect(parsed.memory.foundry.ttlSeconds).toBe(0);
	expect(parsed.foundry).toEqual({
		maxSteps: DEFAULT_AGENT_SETTINGS.foundry.maxSteps,
		keepVersions: DEFAULT_AGENT_SETTINGS.foundry.keepVersions,
		maxItemsRead: 50,
	});
});

test("nothing in a document can remove a bound: zero and negatives fall back, an unknown effort or summary falls back", () => {
	const parsed = parseAgentSettings(
		{
			reasoningEffort: "unlimited",
			reasoningSummary: "everything",
			turns: { burst: 0, refillPerMinute: -5 },
			memory: { itemMaxChars: 0, maxChars: 0 },
		},
		DEFAULT_AGENT_SETTINGS,
	);
	expect(parsed).toEqual(DEFAULT_AGENT_SETTINGS);
	expect(parseAgentSettings("not a document", DEFAULT_AGENT_SETTINGS)).toEqual(
		DEFAULT_AGENT_SETTINGS,
	);
	expect(parseAgentSettings([1, 2], DEFAULT_AGENT_SETTINGS)).toEqual(
		DEFAULT_AGENT_SETTINGS,
	);
});

test("a bound has a ceiling: a number past it is a typo and falls back", () => {
	const parsed = parseAgentSettings(
		{
			turns: { burst: 1e9, refillPerMinute: 1_000_000 },
			foundry: { maxSteps: 51, maxItemsRead: 1e12 },
			history: { maxItems: 1e12, maxChars: 1_000_000 },
			memory: { updateDelaySeconds: 86_401 },
		},
		DEFAULT_AGENT_SETTINGS,
	);
	expect(parsed.turns).toEqual({
		burst: DEFAULT_AGENT_SETTINGS.turns.burst,
		refillPerMinute: 1_000_000,
	});
	expect(parsed.foundry).toEqual(DEFAULT_AGENT_SETTINGS.foundry);
	expect(parsed.history.maxItems).toBe(DEFAULT_AGENT_SETTINGS.history.maxItems);
	expect(parsed.history.maxChars).toBe(1_000_000);
	expect(parsed.memory.updateDelaySeconds).toBe(
		DEFAULT_AGENT_SETTINGS.memory.updateDelaySeconds,
	);
	expect(
		parseAgentSettings(
			{ foundry: { maxSteps: 50 }, memory: { updateDelaySeconds: 86_400 } },
			DEFAULT_AGENT_SETTINGS,
		),
	).toMatchObject({
		foundry: { maxSteps: 50 },
		memory: { updateDelaySeconds: 86_400 },
	});
});

test("the voice agent's transcriber is one the service lists, and a stored model is ignored: the engine decides the deployment", () => {
	const parsed = parseAgentSettings(
		{ voice: { model: "gpt-realtime", transcription: "gpt-4o-transcribe" } },
		DEFAULT_AGENT_SETTINGS,
	);
	expect(parsed.voice).toEqual({
		...DEFAULT_AGENT_SETTINGS.voice,
		transcription: "gpt-4o-transcribe",
	});
	expect(
		parseAgentSettings(
			{ voice: { transcription: "a-guess" } },
			DEFAULT_AGENT_SETTINGS,
		).voice,
	).toEqual(DEFAULT_AGENT_SETTINGS.voice);
});

test("the voice agent's noise suppression is one of the three types, the headset one by default", () => {
	expect(DEFAULT_AGENT_SETTINGS.voice.noiseReduction).toBe(
		"azure_deep_noise_suppression_headset",
	);
	for (const type of [
		"azure_deep_noise_suppression",
		"azure_personal_noise_suppression",
	] as const)
		expect(
			parseAgentSettings(
				{ voice: { noiseReduction: type } },
				DEFAULT_AGENT_SETTINGS,
			).voice.noiseReduction,
		).toBe(type);
	expect(
		parseAgentSettings(
			{ voice: { noiseReduction: "near_field" } },
			DEFAULT_AGENT_SETTINGS,
		).voice.noiseReduction,
	).toBe("azure_deep_noise_suppression_headset");
});

test("web search takes one of the tool's three context sizes, a reasoning effort of its own and a bounded answer", () => {
	expect(DEFAULT_AGENT_SETTINGS.webSearch).toEqual({
		contextSize: "medium",
		maxOutputTokens: 300,
		reasoningEffort: "low",
	});
	expect(
		parseAgentSettings(
			{
				webSearch: {
					contextSize: "low",
					maxOutputTokens: 120,
					reasoningEffort: "minimal",
				},
			},
			DEFAULT_AGENT_SETTINGS,
		).webSearch,
	).toEqual({
		contextSize: "low",
		maxOutputTokens: 120,
		reasoningEffort: "minimal",
	});
	expect(
		parseAgentSettings(
			{
				webSearch: {
					contextSize: "huge",
					maxOutputTokens: 0,
					reasoningEffort: "all",
				},
			},
			DEFAULT_AGENT_SETTINGS,
		).webSearch,
	).toEqual(DEFAULT_AGENT_SETTINGS.webSearch);
});

test("the default store is the deployment's: the Foundry store on a public one, the own store behind private endpoints", () => {
	const unset = scopedEnv({ PRIVATE_NETWORKING: undefined });
	try {
		expect(defaultAgentSettings()).toBe(DEFAULT_AGENT_SETTINGS);
		expect(defaultAgentSettings().memory.store).toBe("foundry");
	} finally {
		unset();
	}
	const off = scopedEnv({ PRIVATE_NETWORKING: "False" });
	try {
		expect(defaultAgentSettings().memory.store).toBe("foundry");
	} finally {
		off();
	}
	const on = scopedEnv({ PRIVATE_NETWORKING: "True" });
	try {
		const defaults = defaultAgentSettings();
		expect(defaults.memory.store).toBe("own");
		// Only the store differs: the rest of the document is the shipped one.
		expect({
			...defaults,
			memory: { ...defaults.memory, store: "foundry" },
		}).toEqual(DEFAULT_AGENT_SETTINGS);
		// And a stored document that names nothing reads the same way through the parser.
		expect(parseAgentSettings({}, defaults).memory.store).toBe("own");
	} finally {
		on();
	}
});

test("the Foundry store named on a private deployment is refused under a code, and the own store runs; a public one runs what is named", () => {
	const codes: unknown[] = [];
	problemChannel.setSink((line) => codes.push(line.attributes["problem.code"]));
	const quiet = spyOn(console, "error").mockImplementation(() => {});
	const on = scopedEnv({ PRIVATE_NETWORKING: "true" });
	try {
		expect(memoryStoreFor({ store: "own" })).toBe("own");
		expect(codes).toEqual([]);
		expect(memoryStoreFor({ store: "foundry" })).toBe("own");
		expect(codes).toEqual(["agent.memory.store_unreachable_private"]);
		// Counted by what it says: a line another suite's work left running writes in the same process is not this one.
		expect(
			quiet.mock.calls.filter((args) =>
				String(args[0]).startsWith("[memory] the document names the Foundry"),
			),
		).toHaveLength(1);
	} finally {
		on();
		problemChannel.setSink(null);
		quiet.mockRestore();
	}
	const off = scopedEnv({ PRIVATE_NETWORKING: undefined });
	try {
		expect(memoryStoreFor({ store: "foundry" })).toBe("foundry");
		expect(memoryStoreFor({ store: "own" })).toBe("own");
	} finally {
		off();
	}
});

test("a new thread's messages are kept in the deployment's own database unless the document names the service's conversations", () => {
	expect(DEFAULT_AGENT_SETTINGS.history.store).toBe("own");
	expect(defaultAgentSettings().history.store).toBe("own");
	expect(
		parseAgentSettings(
			{ history: { store: "foundry" } },
			DEFAULT_AGENT_SETTINGS,
		).history,
	).toEqual({ store: "foundry", maxItems: 200, maxChars: 200_000 });
	for (const store of ["elsewhere", 1, null])
		expect(
			parseAgentSettings({ history: { store } }, DEFAULT_AGENT_SETTINGS).history
				.store,
		).toBe("own");
	const restore = scopedEnv({ PRIVATE_NETWORKING: "true" });
	try {
		// Unlike memory, the store is the same in both modes: the service's run state is bound to the deployment's own account.
		expect(defaultAgentSettings().history.store).toBe("own");
	} finally {
		restore();
	}
});

test("the voice engine is speech-to-speech by default, for every tier, with a transcriber documented beside both engines", () => {
	const { voice } = DEFAULT_AGENT_SETTINGS;
	expect(voice.engine).toBe("speechToSpeech");
	expect(voice.engineByTier).toEqual({ base: null, premium: null });
	expect(voiceEngineForTier(voice, "base")).toBe("speechToSpeech");
	expect(voiceEngineForTier(voice, "premium")).toBe("speechToSpeech");
	expect(voiceEnginesNamed(voice)).toEqual(["speechToSpeech"]);
	// Nothing to replace on speech-to-speech, and the same on the cascade it falls back to.
	expect(voice.transcription).toBe("mai-transcribe");
	expect(transcriberFor("speechToSpeech", voice.transcription)).toBe(
		voice.transcription,
	);
	expect(transcriberFor("cascade", voice.transcription)).toBe(
		voice.transcription,
	);
});

test("voice.engine overrides the default for everybody, and anything else keeps it", () => {
	const { voice } = parseAgentSettings(
		{ voice: { engine: "cascade", realtimeReasoningEffort: "xhigh" } },
		DEFAULT_AGENT_SETTINGS,
	);
	expect(voiceEngineForTier(voice, "base")).toBe("cascade");
	expect(voiceEngineForTier(voice, "premium")).toBe("cascade");
	expect(voiceEnginesNamed(voice)).toEqual(["cascade"]);
	expect(voice.realtimeReasoningEffort).toBe("xhigh");
	const refused = parseAgentSettings(
		{
			voice: {
				engine: "realtime",
				engineByTier: { base: "fast", premium: 1 },
				realtimeReasoningEffort: "max",
			},
		},
		DEFAULT_AGENT_SETTINGS,
	).voice;
	expect(refused).toEqual(DEFAULT_AGENT_SETTINGS.voice);
});

test("voice.engineByTier names an engine per tier over voice.engine, and null leaves the tier to it", () => {
	const { voice } = parseAgentSettings(
		{
			voice: {
				engine: "cascade",
				engineByTier: { premium: "speechToSpeech", base: null },
			},
		},
		DEFAULT_AGENT_SETTINGS,
	);
	expect(voiceEngineForTier(voice, "base")).toBe("cascade");
	expect(voiceEngineForTier(voice, "premium")).toBe("speechToSpeech");
	expect(voiceEnginesNamed(voice)).toEqual(["cascade", "speechToSpeech"]);
	const inverted = parseAgentSettings(
		{
			voice: {
				engine: "speechToSpeech",
				engineByTier: { base: "cascade" },
			},
		},
		DEFAULT_AGENT_SETTINGS,
	).voice;
	expect(voiceEngineForTier(inverted, "base")).toBe("cascade");
	expect(voiceEngineForTier(inverted, "premium")).toBe("speechToSpeech");
});

test("a cascade-only transcriber is replaced on speech-to-speech, and only there", () => {
	expect(transcriberFor("cascade", "azure-speech")).toBe("azure-speech");
	expect(transcriberFor("speechToSpeech", "azure-speech")).toBe(
		"mai-transcribe",
	);
	expect(transcriberFor("speechToSpeech", "gpt-4o-transcribe")).toBe(
		"gpt-4o-transcribe",
	);
	expect(transcriberFor("speechToSpeech", "mai-transcribe")).toBe(
		"mai-transcribe",
	);
});

test("each engine runs this deployment's own model unless the document names a managed model of that engine, and nothing else is taken", () => {
	expect(DEFAULT_AGENT_SETTINGS.voice.managedModel).toEqual({
		cascade: "",
		speechToSpeech: "",
	});
	const { voice } = parseAgentSettings(
		{
			voice: {
				managedModel: {
					cascade: "gpt-5-mini",
					speechToSpeech: "gpt-realtime-2.1-datazone",
				},
			},
		},
		DEFAULT_AGENT_SETTINGS,
	);
	expect(voice.managedModel).toEqual({
		cascade: "gpt-5-mini",
		speechToSpeech: "gpt-realtime-2.1-datazone",
	});
	// A name on no list, a model of the other engine, and the wrong type all keep the default.
	for (const managedModel of [
		{ cascade: "gpt-realtime-2.1", speechToSpeech: "gpt-5-mini" },
		{ cascade: "gpt-9", speechToSpeech: "azure-realtime" },
		{ cascade: 5, speechToSpeech: null },
	])
		expect(
			parseAgentSettings({ voice: { managedModel } }, DEFAULT_AGENT_SETTINGS)
				.voice.managedModel,
		).toEqual({ cascade: "", speechToSpeech: "" });
});

test("the deploy's component variables are the defaults; unset or unknown is the shipped default", () => {
	const on = scopedEnv({
		PRIVATE_NETWORKING: undefined,
		MEMORY_STORE: "own",
		HISTORY_STORE: "foundry",
		VOICE_ENGINE: "cascade",
	});
	try {
		expect(defaultAgentSettings()).toMatchObject({
			memory: { store: "own" },
			history: { store: "foundry" },
			voice: { engine: "cascade" },
		});
	} finally {
		on();
	}
	const odd = scopedEnv({
		PRIVATE_NETWORKING: undefined,
		MEMORY_STORE: "elsewhere",
		HISTORY_STORE: undefined,
		VOICE_ENGINE: undefined,
	});
	try {
		expect(defaultAgentSettings()).toBe(DEFAULT_AGENT_SETTINGS);
	} finally {
		odd();
	}
});
