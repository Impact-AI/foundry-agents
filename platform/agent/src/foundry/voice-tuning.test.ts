import { expect, test } from "bun:test";
import { DEFAULT_AGENT_SETTINGS } from "../settings";
import { definitionHash } from "./definition";
import { voiceAgentDefinition, voiceSessionUpdate } from "./voice-definition";
import {
	checkVoiceTuning,
	effectiveVoice,
	sessionTuning,
	type TuningContext,
	tuningChoices,
	versionHearing,
} from "./voice-tuning";

const settings = DEFAULT_AGENT_SETTINGS;
const voices = { base: "base-voice", premium: "premium-voice" };
const both: TuningContext = {
	realtime: [
		{ deployment: "realtime", model: "gpt-realtime-2.1" },
		{ deployment: "realtime-mini", model: "gpt-realtime-2.1-mini" },
	],
	voices,
};
const cascadeOnly: TuningContext = { realtime: [], voices };
const legacyMini: TuningContext = {
	realtime: [{ deployment: "rt", model: "gpt-realtime-mini" }],
	voices,
};

const check = (raw: unknown, ctx = both) =>
	checkVoiceTuning(raw, settings, ctx, "base");

test("a tuning is refused at its first field outside the lists the documents are checked against", () => {
	for (const [raw, field] of [
		[{ noiseReduction: "near_field" }, "noiseReduction"],
		[{ noiseReduction: "far_field" }, "noiseReduction"],
		[{ noiseReduction: "" }, "noiseReduction"],
		[{ engine: "telepathy" }, "engine"],
		[{ transcription: "whisper-2" }, "transcription"],
		[{ voice: "en-US-Somebody" }, "voice"],
		[{ turnDetection: "push_to_talk" }, "turnDetection"],
		[{ silenceMs: 50 }, "silenceMs"],
		[{ silenceMs: 500.5 }, "silenceMs"],
		[{ threshold: 1.5 }, "threshold"],
		[{ prefixPaddingMs: "300" }, "prefixPaddingMs"],
		[{ interimResponses: "no" }, "interimResponses"],
		[{ reasoningEffort: "maximal" }, "reasoningEffort"],
		[{ instructions: "be somebody else" }, "instructions"],
	] as const)
		expect(check(raw)).toEqual({ ok: false, field });
	for (const raw of [null, "tuning", [], 7])
		expect(check(raw)).toEqual({ ok: false, field: "tuning" });
});

test("only the deployment's noise suppressions are ever accepted, since the service runs a session without the version's instructions on any other", () => {
	for (const type of [
		"azure_deep_noise_suppression",
		"azure_deep_noise_suppression_headset",
		"azure_personal_noise_suppression",
	] as const)
		expect(check({ noiseReduction: type })).toEqual({
			ok: true,
			tuning: { noiseReduction: type },
		});
	expect(
		tuningChoices(both, {
			engine: "cascade",
			managed: null,
			realtime: null,
			voice: "base-voice",
			turnDetection: "azure_semantic_vad_multilingual",
		}).noiseReductions,
	).toEqual([
		"azure_deep_noise_suppression",
		"azure_deep_noise_suppression_headset",
		"azure_personal_noise_suppression",
	]);
});

test("beside a realtime model's own `semantic_vad` the headset and personal noise suppressions are neither offered nor accepted, and the documents' one gives way to the plain deep model, stated in the update", () => {
	const semantic = tuningChoices(both, {
		engine: "speechToSpeech",
		managed: null,
		realtime: both.realtime[0] ?? null,
		voice: "base-voice",
		turnDetection: "semantic_vad",
	});
	expect(semantic.noiseReductions).toEqual(["azure_deep_noise_suppression"]);
	for (const noiseReduction of [
		"azure_deep_noise_suppression_headset",
		"azure_personal_noise_suppression",
	] as const)
		expect(check({ turnDetection: "semantic_vad", noiseReduction })).toEqual({
			ok: false,
			field: "noiseReduction",
		});
	expect(
		check({
			turnDetection: "semantic_vad",
			noiseReduction: "azure_deep_noise_suppression",
		}).ok,
	).toBe(true);
	// The documents' default is the headset model: on semantic_vad the session runs the plain deep one, and says so.
	expect(settings.voice.noiseReduction).toBe(
		"azure_deep_noise_suppression_headset",
	);
	const tuning = { turnDetection: "semantic_vad" } as const;
	const effective = effectiveVoice(settings, both, "base", tuning);
	expect(effective.noiseReduction).toBe("azure_deep_noise_suppression");
	expect(versionHearing(tuning, effective, ["en"]).noiseReduction).toBe(
		"azure_deep_noise_suppression",
	);
	// The version's own detection runs every noise suppression.
	expect(effectiveVoice(settings, both, "base", null).noiseReduction).toBe(
		"azure_deep_noise_suppression_headset",
	);
	expect(
		versionHearing({}, effectiveVoice(settings, both, "base", {}), ["en"]),
	).toEqual({});
});

test("what the deployment has bounds a tuning: speech-to-speech on a deployment needs one, and a realtime model needs its own", () => {
	// Without a realtime deployment, speech-to-speech runs on a managed model or not at all.
	expect(
		check({ engine: "speechToSpeech", modelSource: "deployment" }, cascadeOnly),
	).toEqual({ ok: false, field: "modelSource" });
	expect(check({ engine: "speechToSpeech" }, cascadeOnly)).toEqual({
		ok: true,
		tuning: { engine: "speechToSpeech" },
	});
	expect(
		effectiveVoice(settings, cascadeOnly, "base", { engine: "speechToSpeech" }),
	).toMatchObject({
		engine: "speechToSpeech",
		modelSource: "managed",
		managed: { name: "gpt-realtime-2.1" },
		realtime: null,
	});
	expect(check({ realtimeModel: "gpt-realtime-2.1-mini" })).toEqual({
		ok: true,
		tuning: { realtimeModel: "gpt-realtime-2.1-mini" },
	});
	expect(check({ realtimeModel: "gpt-realtime-2.1-mini" }, legacyMini)).toEqual(
		{ ok: false, field: "realtimeModel" },
	);
	// A realtime model on the cascade is a version nobody asks for.
	expect(
		check({ engine: "cascade", realtimeModel: "gpt-realtime-2.1" }),
	).toEqual({ ok: false, field: "realtimeModel" });
	expect(
		tuningChoices(cascadeOnly, {
			engine: "cascade",
			managed: null,
			realtime: null,
			voice: "base-voice",
			turnDetection: "azure_semantic_vad_multilingual",
		}).engines,
	).toEqual(["cascade", "speechToSpeech"]);
});

test("a transcriber, a turn detection and an effort are checked for the engine the tuning itself runs", () => {
	// azure-speech is documented beside a cascade only.
	expect(check({ engine: "cascade", transcription: "azure-speech" }).ok).toBe(
		true,
	);
	expect(check({ transcription: "azure-speech" })).toEqual({
		ok: false,
		field: "transcription",
	});
	expect(check({ engine: "cascade", turnDetection: "semantic_vad" })).toEqual({
		ok: false,
		field: "turnDetection",
	});
	expect(check({ turnDetection: "semantic_vad" }).ok).toBe(true);
	// semantic_vad takes none of the timers.
	expect(check({ turnDetection: "semantic_vad", silenceMs: 500 })).toEqual({
		ok: false,
		field: "silenceMs",
	});
	expect(
		check({ turnDetection: "server_vad", silenceMs: 500, threshold: 0.6 }).ok,
	).toBe(true);
	// The cascade reasons on the chat's scale, a reasoning realtime model on its own, gpt-realtime-mini on none.
	expect(check({ engine: "cascade", reasoningEffort: "xhigh" })).toEqual({
		ok: false,
		field: "reasoningEffort",
	});
	expect(check({ reasoningEffort: "xhigh" }).ok).toBe(true);
	expect(check({ reasoningEffort: "low" }, legacyMini)).toEqual({
		ok: false,
		field: "reasoningEffort",
	});
	expect(
		tuningChoices(legacyMini, {
			engine: "speechToSpeech",
			managed: null,
			realtime: legacyMini.realtime[0] ?? null,
			voice: "base-voice",
			turnDetection: "azure_semantic_vad_multilingual",
		}).reasoningEfforts,
	).toEqual([]);
});

test("a field set to null is not set, and nothing at all is the deployment's own", () => {
	expect(check({ engine: null, voice: undefined })).toEqual({
		ok: true,
		tuning: {},
	});
	expect(check({})).toEqual({ ok: true, tuning: {} });
});

test("every control resolves to the value a session runs with, the tuning over the documents", () => {
	const untuned = effectiveVoice(settings, both, "premium", null);
	expect(untuned).toEqual({
		engine: "speechToSpeech",
		modelSource: "deployment",
		managed: null,
		realtime: { deployment: "realtime", model: "gpt-realtime-2.1" },
		voice: "premium-voice",
		turnDetection: "azure_semantic_vad_multilingual",
		silenceMs: null,
		threshold: null,
		prefixPaddingMs: null,
		noiseReduction: "azure_deep_noise_suppression_headset",
		transcription: "mai-transcribe",
		reasoningEffort: "low",
		interimResponses: true,
	});
	expect(effectiveVoice(settings, cascadeOnly, "base", null)).toMatchObject({
		engine: "cascade",
		realtime: null,
		reasoningEffort: settings.reasoningEffort,
	});
	expect(
		effectiveVoice(settings, both, "base", {
			realtimeModel: "gpt-realtime-2.1-mini",
			reasoningEffort: "none",
			interimResponses: false,
		}),
	).toMatchObject({
		realtime: { deployment: "realtime-mini" },
		reasoningEffort: "none",
		interimResponses: false,
	});
	expect(
		effectiveVoice(settings, legacyMini, "base", null).reasoningEffort,
	).toBeNull();
});

test("each engine and realtime model is a version of its own, and so are fillers off, a turn detection and a noise suppression, which a session cannot change; nothing else a tester sets changes the version", () => {
	const version = (
		ctx: TuningContext,
		tuning: Parameters<typeof effectiveVoice>[3],
	) => {
		const effective = effectiveVoice(settings, ctx, "base", tuning);
		return definitionHash(
			voiceAgentDefinition({
				fixed: "fixed",
				tools: [],
				languages: { codes: ["en", "it"] },
				engine: effective.engine,
				model: effective.realtime?.deployment ?? "chat",
				settings: settings.voice,
				voiceName: voices.base,
				interim: effective.interimResponses,
				heard: versionHearing(tuning ?? {}, effective, ["en", "it"]),
			}),
		);
	};
	const shipped = version(both, null);
	const distinct = new Set([
		shipped,
		version(both, { engine: "cascade" }),
		version(both, { realtimeModel: "gpt-realtime-2.1-mini" }),
		version(both, { interimResponses: false }),
		version(both, { noiseReduction: "azure_deep_noise_suppression" }),
		version(both, { turnDetection: "server_vad" }),
		version(both, { silenceMs: 700 }),
	]);
	expect(distinct.size).toBe(7);
	expect(
		version(both, {
			voice: "en-US-AndrewMultilingualNeural",
			transcription: "gpt-4o-transcribe",
			reasoningEffort: "high",
		}),
	).toBe(shipped);
});

test("the session's update carries only the voice a tester set, never fillers; the version carries how it hears, the turn detection whole", () => {
	const languages = { codes: ["en", "it"], accent: () => null };
	const audio = { voices, language: "stated" as const };
	const update = (tuning: Parameters<typeof effectiveVoice>[3]) =>
		voiceSessionUpdate({
			transcription: "mai-transcribe",
			reasoning: null,
			audio,
			tier: "base",
			locale: "en",
			languages: languages as never,
			...(tuning
				? {
						tuned: sessionTuning(
							tuning,
							effectiveVoice(settings, both, "base", tuning),
						),
					}
				: {}),
		});
	const plain = update(null);
	expect(plain.audio.input).not.toHaveProperty("noise_reduction");
	expect(plain.audio.input).not.toHaveProperty("turn_detection");
	expect(plain.audio.output.voice).toBe("base-voice");
	expect(plain).not.toHaveProperty("interim_response");

	const tuning = {
		voice: "en-US-AndrewMultilingualNeural",
		noiseReduction: "azure_deep_noise_suppression",
		silenceMs: 700,
		interimResponses: false,
	} as const;
	const tuned = update(tuning);
	expect(tuned.audio.output.voice).toBe("en-US-AndrewMultilingualNeural");
	expect(tuned.audio.input).not.toHaveProperty("noise_reduction");
	expect(tuned.audio.input).not.toHaveProperty("turn_detection");
	expect(tuned).not.toHaveProperty("interim_response");
	const hearing = (t: Parameters<typeof effectiveVoice>[3] & object) =>
		versionHearing(
			t,
			effectiveVoice(settings, both, "base", t),
			languages.codes,
		);
	const definition = voiceAgentDefinition({
		fixed: "fixed",
		tools: [],
		languages: { codes: ["en", "it"] },
		engine: "speechToSpeech",
		model: "realtime",
		settings: settings.voice,
		voiceName: voices.base,
		heard: hearing(tuning),
	});
	expect(definition.audio.input.noise_reduction).toEqual({
		type: "azure_deep_noise_suppression",
	});
	expect(definition.audio.input.turn_detection).toEqual({
		type: "azure_semantic_vad_multilingual",
		languages: ["en", "it"],
		silence_duration_ms: 700,
		auto_truncate: false,
	});
	expect(hearing({ turnDetection: "semantic_vad" }).turnDetection).toEqual({
		type: "semantic_vad",
	});
});

test("an OpenAI voice is offered and accepted on speech-to-speech alone, since the cascade refuses one", () => {
	expect(check({ voice: "marin" })).toEqual({
		ok: true,
		tuning: { voice: "marin" },
	});
	expect(check({ engine: "cascade", voice: "marin" })).toEqual({
		ok: false,
		field: "voice",
	});
	expect(check({ voice: "marin" }, cascadeOnly)).toEqual({
		ok: false,
		field: "voice",
	});
	// Only the names the Voice Live reference lists.
	expect(check({ voice: "nova" })).toEqual({ ok: false, field: "voice" });
	const spoken = tuningChoices(both, {
		engine: "speechToSpeech",
		managed: null,
		realtime: both.realtime[0] ?? null,
		voice: "base-voice",
		turnDetection: "azure_semantic_vad_multilingual",
	}).voices;
	expect(spoken).toContain("marin");
	expect(spoken).toContain("cedar");
	expect(
		tuningChoices(both, {
			engine: "cascade",
			managed: null,
			realtime: null,
			voice: "base-voice",
			turnDetection: "azure_semantic_vad_multilingual",
		}).voices,
	).not.toContain("marin");
});

test("an OpenAI voice turns the fillers off, whatever the tuning says, and the panel is told the control is fixed", () => {
	for (const interimResponses of [undefined, true, false]) {
		const tuning = { voice: "marin", interimResponses };
		const checked = check(tuning);
		expect(checked.ok).toBe(true);
		const effective = effectiveVoice(settings, both, "base", tuning);
		expect(effective.interimResponses).toBe(false);
		expect(tuningChoices(both, effective).interimResponses).toBe(false);
	}
	const azure = effectiveVoice(settings, both, "base", {});
	expect(azure.interimResponses).toBe(true);
	expect(tuningChoices(both, azure).interimResponses).toBe(true);
});

test("the voice document's OpenAI voice is a tier's on speech-to-speech, and its Azure voice stands on the cascade", () => {
	const ctx: TuningContext = {
		...both,
		openaiVoices: { base: "", premium: "cedar" },
	};
	const premium = effectiveVoice(settings, ctx, "premium", null);
	expect(premium.engine).toBe("speechToSpeech");
	expect(premium.voice).toBe("cedar");
	expect(premium.interimResponses).toBe(false);
	expect(effectiveVoice(settings, ctx, "base", null).voice).toBe("base-voice");
	const cascade = effectiveVoice(settings, ctx, "premium", {
		engine: "cascade",
	});
	expect(cascade.voice).toBe("premium-voice");
	expect(cascade.interimResponses).toBe(true);
	expect(
		effectiveVoice(
			settings,
			{ ...cascadeOnly, openaiVoices: ctx.openaiVoices },
			"premium",
			null,
		).voice,
	).toBe("premium-voice");
});

const managedOnly: TuningContext = { realtime: [], voices };

test("a managed model is chosen by source then name, held to its engine, and offered with where the service processes it", () => {
	expect(
		check({
			modelSource: "managed",
			managedModel: "gpt-realtime-2.1-datazone",
		}),
	).toEqual({
		ok: true,
		tuning: {
			modelSource: "managed",
			managedModel: "gpt-realtime-2.1-datazone",
		},
	});
	// A name alone implies the managed source.
	expect(check({ managedModel: "gpt-realtime-mini" }).ok).toBe(true);
	for (const [raw, field] of [
		// Not a managed model, and not one on Learn.
		[{ managedModel: "gpt-realtime-9" }, "managedModel"],
		// A text model is the cascade's, never speech-to-speech's.
		[{ managedModel: "gpt-5-mini" }, "managedModel"],
		[{ engine: "cascade", managedModel: "gpt-realtime-2.1" }, "managedModel"],
		// The deployment source names no managed model.
		[
			{ modelSource: "deployment", managedModel: "gpt-realtime-2.1" },
			"managedModel",
		],
		[{ modelSource: "somewhere" }, "modelSource"],
		// A realtime deployment's model is the deployment source's alone.
		[
			{ modelSource: "managed", realtimeModel: "gpt-realtime-2.1" },
			"realtimeModel",
		],
	] as const)
		expect(check(raw)).toEqual({ ok: false, field });

	const spoken = effectiveVoice(settings, both, "base", {
		modelSource: "managed",
		managedModel: "gpt-realtime-2.1-datazone",
	});
	expect(spoken).toMatchObject({
		engine: "speechToSpeech",
		modelSource: "managed",
		managed: { name: "gpt-realtime-2.1-datazone", scope: "dataZone" },
		realtime: null,
		reasoningEffort: "low",
	});
	const choices = tuningChoices(both, spoken);
	expect(choices.modelSources).toEqual(["deployment", "managed"]);
	expect(choices.managedModels).toEqual([
		{ name: "gpt-realtime-2.1", scope: "global" },
		{ name: "gpt-realtime-2.1-datazone", scope: "dataZone" },
		{ name: "gpt-realtime-2.1-mini", scope: "global" },
		{ name: "gpt-realtime-1.5", scope: "global" },
		{ name: "gpt-realtime-1.5-datazone", scope: "dataZone" },
		{ name: "gpt-realtime-mini", scope: "global" },
	]);
	expect(choices.realtimeModels).toEqual([]);
	// Speech-to-speech with no deployment has the managed source alone, so no source control.
	expect(
		tuningChoices(
			managedOnly,
			effectiveVoice(settings, managedOnly, "base", {
				engine: "speechToSpeech",
			}),
		).modelSources,
	).toEqual([]);
});

test("a managed model's own row bounds the efforts, the transcribers and the OpenAI voices", () => {
	const mini = {
		modelSource: "managed",
		managedModel: "gpt-realtime-mini",
	} as const;
	// gpt-realtime-mini takes no effort: none is offered, and none is sent.
	expect(check({ ...mini, reasoningEffort: "low" })).toEqual({
		ok: false,
		field: "reasoningEffort",
	});
	expect(
		effectiveVoice(settings, both, "base", mini).reasoningEffort,
	).toBeNull();
	// gpt-realtime-2.1-mini reasons, minimal to xhigh.
	expect(
		check({
			modelSource: "managed",
			managedModel: "gpt-realtime-2.1-mini",
			reasoningEffort: "xhigh",
		}).ok,
	).toBe(true);
	// A managed cascade takes the two transcribers a cascade is documented with, and no OpenAI voice.
	const text = {
		engine: "cascade",
		modelSource: "managed",
		managedModel: "gpt-5-mini",
	} as const;
	expect(check({ ...text, transcription: "whisper-1" })).toEqual({
		ok: false,
		field: "transcription",
	});
	expect(check({ ...text, transcription: "azure-speech" }).ok).toBe(true);
	expect(check({ ...text, voice: "marin" })).toEqual({
		ok: false,
		field: "voice",
	});
	// gpt-5-mini has no `none`: the document's low is sent; a tester's none sends nothing.
	expect(effectiveVoice(settings, both, "base", text).reasoningEffort).toBe(
		"low",
	);
	expect(
		effectiveVoice(settings, both, "base", { ...text, reasoningEffort: "none" })
			.reasoningEffort,
	).toBe("none");
	// The cascade's managed models are processed by region, which the panel says.
	expect(
		tuningChoices(
			both,
			effectiveVoice(settings, both, "base", text),
		).managedModels.map((m) => m.scope),
	).toEqual(["byRegion", "byRegion", "byRegion"]);
});

test("a managed model is a version of its own, named with model_type managed, and the document's managed model is the default source", () => {
	const definitionOf = (
		tuning: Parameters<typeof effectiveVoice>[3],
		s = settings,
	) => {
		const effective = effectiveVoice(s, both, "base", tuning);
		return voiceAgentDefinition({
			fixed: "fixed",
			tools: [],
			languages: { codes: ["en"] },
			engine: effective.engine,
			model: effective.realtime?.deployment ?? "chat",
			managed: effective.managed,
			settings: s.voice,
			voiceName: effective.voice,
		});
	};
	const own = definitionOf(null);
	const managed = definitionOf({ managedModel: "gpt-realtime-2.1" });
	expect(own).toMatchObject({ model_type: "self_deployed", model: "realtime" });
	expect(managed).toMatchObject({
		model_type: "managed",
		model: "gpt-realtime-2.1",
	});
	expect(definitionHash(own)).not.toBe(definitionHash(managed));
	const documented = {
		...settings,
		voice: {
			...settings.voice,
			managedModel: { cascade: "gpt-5-nano", speechToSpeech: "" },
		},
	};
	expect(definitionOf({ engine: "cascade" }, documented)).toMatchObject({
		model_type: "managed",
		model: "gpt-5-nano",
	});
	// A tester may still choose this deployment's own model over the document's managed one.
	expect(
		definitionOf({ engine: "cascade", modelSource: "deployment" }, documented),
	).toMatchObject({ model_type: "self_deployed", model: "chat" });
});
