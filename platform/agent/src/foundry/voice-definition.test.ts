import { expect, test } from "bun:test";
import type { ProductLanguages, VoiceAudio } from "../contract/product";
import { DEFAULT_AGENT_SETTINGS, type VoiceEngine } from "../settings";
import { managedVoiceModel } from "../voice-models";
import {
	INTERIM_INSTRUCTIONS,
	sessionReasoning,
	voiceAgentDefinition,
	voiceSessionUpdate,
	withoutSchemaUri,
} from "./voice-definition";

/**
 * The voice agent's version and one session's update, as pure functions:
 * one version for every language, holding the voice surface's tools itself,
 * and the person's language stated per session — or, in the fallback, left
 * to the service — in one place.
 */

const ACCENTS: Record<string, string | null> = {
	en: "en-US",
	it: "it-IT",
	de: null,
};
const languages: ProductLanguages = {
	codes: Object.keys(ACCENTS),
	isLocale: (value) => typeof value === "string" && value in ACCENTS,
	languageName: (code) => code,
	accent: (code) => ACCENTS[code] ?? null,
};
const audio: VoiceAudio = {
	voices: { base: "base-multilingual", premium: "premium-hd" },
	language: "stated",
};

const definition = (
	settings = DEFAULT_AGENT_SETTINGS.voice,
	engine: VoiceEngine = "cascade",
	model = "chat",
) =>
	voiceAgentDefinition({
		fixed: "<guardrails>\nDecline.\n</guardrails>",
		tools: [
			{
				type: "function",
				name: "knowledgeSearch",
				description: "Search the knowledge base.",
				parameters: {
					$schema: "http://json-schema.org/draft-07/schema#",
					type: "object",
					properties: { query: { type: "string", minLength: 1 } },
					required: ["query"],
					additionalProperties: false,
				},
				strict: false,
			},
		],
		languages,
		engine,
		model,
		settings,
		voiceName: "base-multilingual",
		raiPolicy: "/subscriptions/s/raiPolicies/default-indirect",
	});

test("one version speaks every language: no locale anywhere in it, the turn taking every product language, storage off", () => {
	const version = definition();
	// The language is an input the session fills; the audio states none.
	const sound = JSON.stringify(version.audio);
	for (const field of ["voice_locale", "prefer_locales", '"language"'])
		expect(sound).not.toContain(field);
	expect(version.audio.input.turn_detection).toEqual({
		type: "azure_semantic_vad_multilingual",
		languages: ["en", "it", "de"],
		auto_truncate: false,
	});
	expect(version.audio.input.transcription).toEqual({
		model: "mai-transcribe",
	});
	// The chat's deployment, run as a cascade: transcribed, answered by the chat's model, spoken.
	expect(version.model_type).toBe("self_deployed");
	expect(version.model).toBe("chat");
	expect(version.audio.output.voice).toBe("base-multilingual");
	expect(version.structured_inputs.language?.schema.enum).toEqual([
		"en",
		"it",
		"de",
	]);
	expect(version.instructions).toEndWith("\n\n{{personalization}}");
	expect(version).not.toHaveProperty("subagent_config");
	// A filler the service's model writes while a tool runs, never a fixed phrase, and nothing on the model's own latency.
	expect(version.interim_response).toEqual({
		type: "llm_interim_response",
		triggers: ["tool"],
		instructions: INTERIM_INSTRUCTIONS,
	});
	expect(version.interim_response).not.toHaveProperty("texts");
	expect(version.interim_response).not.toHaveProperty("latency_threshold_ms");
	expect(version.store).toBe(false);
	expect(version.rai_config?.rai_policy_name).toContain("default-indirect");
});

test("on either engine a barge-in leaves the answer whole, and no word timestamps are asked for", () => {
	for (const version of [
		definition(),
		definition(DEFAULT_AGENT_SETTINGS.voice, "speechToSpeech", "realtime"),
	]) {
		expect(version.audio.input.turn_detection.auto_truncate).toBe(false);
		expect(version.audio.output).toEqual({
			voice_type: "azure-standard",
			voice: "base-multilingual",
		});
	}
});

test("the voice agent holds the voice surface's tools itself, each without the `$schema` keyword the service does not apply a version with", () => {
	expect(definition().tools).toEqual([
		{
			type: "function",
			name: "knowledgeSearch",
			description: "Search the knowledge base.",
			parameters: {
				type: "object",
				properties: { query: { type: "string", minLength: 1 } },
				required: ["query"],
				additionalProperties: false,
			},
		},
	]);
	expect(
		withoutSchemaUri({
			$schema: "x",
			anyOf: [{ $schema: "y", type: "string" }],
		}),
	).toEqual({ anyOf: [{ type: "string" }] });
});

test("a stated session pins the transcription's language, the accent of the person's language, and its tier's voice", () => {
	expect(
		voiceSessionUpdate({
			transcription: "gpt-4o-transcribe",
			reasoning: { effort: "low" },
			audio,
			tier: "premium",
			locale: "it",
			languages,
		}),
	).toEqual({
		type: "realtime",
		reasoning: { effort: "low" },
		audio: {
			input: {
				transcription: { model: "gpt-4o-transcribe", language: "it" },
			},
			output: {
				voice_type: "azure-standard",
				voice: "premium-hd",
				voice_locale: "it-IT",
			},
		},
	});
	const base = voiceSessionUpdate({
		transcription: "gpt-4o-transcribe",
		reasoning: { effort: "low" },
		audio,
		tier: "base",
		locale: "de",
		languages,
	});
	expect(base.audio.output.voice).toBe("base-multilingual");
	// A language with no accent named leaves the accent to the voice, and still states the language.
	expect(base.audio.output.voice_locale).toBeUndefined();
	expect(base.audio.input.transcription.language).toBe("de");
});

test("a session's update carries no fillers: the version's are written in the conversation's language", () => {
	for (const language of ["stated", "detected"] as const)
		expect(
			voiceSessionUpdate({
				transcription: "gpt-4o-transcribe",
				reasoning: { effort: "low" },
				audio: { ...audio, language },
				tier: "base",
				locale: "it",
				languages,
			}),
		).not.toHaveProperty("interim_response");
});

test("the detection fallback is the same update with nothing stated: the product's languages offered where the transcriber takes a list, the accents preferred", () => {
	const detected = { ...audio, language: "detected" as const };
	const listed = voiceSessionUpdate({
		transcription: "gpt-transcribe",
		reasoning: { effort: "low" },
		audio: detected,
		tier: "base",
		locale: "it",
		languages,
	});
	expect(listed.audio.input.transcription).toEqual({
		model: "gpt-transcribe",
		languages: ["en", "it", "de"],
	});
	expect(listed.audio.output.prefer_locales).toEqual(["en-US", "it-IT"]);
	expect(listed.audio.output.voice_locale).toBeUndefined();
	const unlisted = voiceSessionUpdate({
		transcription: "gpt-4o-transcribe",
		reasoning: { effort: "low" },
		audio: detected,
		tier: "base",
		locale: "it",
		languages,
	});
	expect(unlisted.audio.input.transcription).toEqual({
		model: "gpt-4o-transcribe",
	});
});

test("the noise suppression is the setting's type and nothing else", () => {
	expect(definition().audio.input.noise_reduction).toEqual({
		type: "azure_deep_noise_suppression_headset",
	});
	expect(
		definition({
			...DEFAULT_AGENT_SETTINGS.voice,
			noiseReduction: "azure_personal_noise_suppression",
		}).audio.input.noise_reduction,
	).toEqual({ type: "azure_personal_noise_suppression" });
	// A different type is a different version: the hash is taken over the whole definition.
	expect(JSON.stringify(definition())).not.toEqual(
		JSON.stringify(
			definition({
				...DEFAULT_AGENT_SETTINGS.voice,
				noiseReduction: "azure_deep_noise_suppression",
			}),
		),
	);
});

test("a speech-to-speech version names the realtime deployment, still self-deployed with Azure voices, and is a different version from the cascade's", () => {
	const cascade = definition();
	const realtime = definition(
		{ ...DEFAULT_AGENT_SETTINGS.voice, transcription: "gpt-4o-transcribe" },
		"speechToSpeech",
		"realtime",
	);
	expect(realtime.model_type).toBe("self_deployed");
	expect(realtime.model).toBe("realtime");
	expect(realtime.audio.output.voice_type).toBe("azure-standard");
	expect(realtime.audio.input.transcription).toEqual({
		model: "gpt-4o-transcribe",
	});
	expect(realtime).not.toHaveProperty("temperature");
	expect(realtime).not.toHaveProperty("reasoning");
	expect(JSON.stringify(realtime)).not.toEqual(JSON.stringify(cascade));
});

test("speech-to-speech cannot take Azure Speech: its version transcribes with mai-transcribe, the cascade's keeps the setting", () => {
	const azureSpeech = {
		...DEFAULT_AGENT_SETTINGS.voice,
		transcription: "azure-speech" as const,
	};
	expect(definition(azureSpeech).audio.input.transcription).toEqual({
		model: "azure-speech",
	});
	expect(
		definition(azureSpeech, "speechToSpeech", "realtime").audio.input
			.transcription,
	).toEqual({ model: "mai-transcribe" });
});

test("reasoning: the cascade carries the typed turns' effort, speech-to-speech its own and only for a reasoning realtime model", () => {
	const settings = {
		...DEFAULT_AGENT_SETTINGS,
		reasoningEffort: "medium" as const,
		voice: {
			...DEFAULT_AGENT_SETTINGS.voice,
			realtimeReasoningEffort: "xhigh" as const,
		},
	};
	expect(sessionReasoning("cascade", settings, "gpt-realtime-2.1")).toEqual({
		effort: "medium",
	});
	expect(
		sessionReasoning("speechToSpeech", settings, "gpt-realtime-2.1"),
	).toEqual({ effort: "xhigh" });
	expect(
		sessionReasoning("speechToSpeech", settings, "gpt-realtime-2"),
	).toEqual({ effort: "xhigh" });
	expect(
		sessionReasoning("speechToSpeech", settings, "gpt-realtime-2.1-mini"),
	).toEqual({ effort: "xhigh" });
	for (const model of ["gpt-realtime", "gpt-realtime-mini", undefined])
		expect(sessionReasoning("speechToSpeech", settings, model)).toBeNull();
	const none = {
		...settings,
		voice: { ...settings.voice, realtimeReasoningEffort: "none" as const },
	};
	expect(
		sessionReasoning("speechToSpeech", none, "gpt-realtime-2.1"),
	).toBeNull();
	const update = voiceSessionUpdate({
		transcription: "mai-transcribe",
		reasoning: null,
		audio,
		tier: "base",
		locale: "en",
		languages,
	});
	expect(update).not.toHaveProperty("reasoning");
	expect(update).not.toHaveProperty("temperature");
});

test("an OpenAI voice is named as one, with no fillers in its version, and no accent: the language directive sets its language", () => {
	const version = voiceAgentDefinition({
		fixed: "<guardrails>\nDecline.\n</guardrails>",
		tools: [],
		languages,
		engine: "speechToSpeech",
		model: "realtime",
		settings: DEFAULT_AGENT_SETTINGS.voice,
		voiceName: "marin",
	});
	expect(version.audio.output).toEqual({
		voice_type: "openai",
		voice: "marin",
	});
	expect(version).not.toHaveProperty("interim_response");
	for (const language of ["stated", "detected"] as const) {
		const update = voiceSessionUpdate({
			transcription: "mai-transcribe",
			reasoning: null,
			audio: { ...audio, language },
			tier: "base",
			locale: "it",
			languages,
			voice: "marin",
		});
		expect(update.audio.output).toEqual({
			voice_type: "openai",
			voice: "marin",
		});
	}
	// A tester's Azure voice over it is an Azure voice again, accent included.
	const azure = voiceSessionUpdate({
		transcription: "mai-transcribe",
		reasoning: null,
		audio,
		tier: "base",
		locale: "it",
		languages,
		voice: "marin",
		tuned: { voice: "en-US-AvaMultilingualNeural" },
	});
	expect(azure.audio.output).toEqual({
		voice_type: "azure-standard",
		voice: "en-US-AvaMultilingualNeural",
		voice_locale: "it-IT",
	});
});

test("a managed model is named with model_type managed in place of the deployment, with a transcriber of its own list, and never on the other engine", () => {
	const managed = managedVoiceModel("gpt-5-nano");
	if (!managed) throw new Error("gpt-5-nano is in the table");
	const version = voiceAgentDefinition({
		fixed: "fixed",
		tools: [],
		languages,
		engine: "cascade",
		model: "chat",
		managed,
		settings: { ...DEFAULT_AGENT_SETTINGS.voice, transcription: "whisper-1" },
		voiceName: "base-multilingual",
	});
	expect(version).toMatchObject({
		model_type: "managed",
		model: "gpt-5-nano",
		audio: { input: { transcription: { model: "mai-transcribe" } } },
	});
	expect(definition()).toMatchObject({
		model_type: "self_deployed",
		model: "chat",
	});
	expect(() =>
		voiceAgentDefinition({
			fixed: "fixed",
			tools: [],
			languages,
			engine: "speechToSpeech",
			model: "realtime",
			managed,
			settings: DEFAULT_AGENT_SETTINGS.voice,
			voiceName: "base-multilingual",
		}),
	).toThrow("not a speechToSpeech model");
});

test("a managed model is sent an effort only from its own list, on either engine", () => {
	const settings = {
		...DEFAULT_AGENT_SETTINGS,
		reasoningEffort: "none" as const,
		voice: {
			...DEFAULT_AGENT_SETTINGS.voice,
			realtimeReasoningEffort: "high" as const,
		},
	};
	const model = (name: string) => managedVoiceModel(name);
	expect(
		sessionReasoning(
			"speechToSpeech",
			settings,
			undefined,
			model("gpt-realtime-2.1-datazone"),
		),
	).toEqual({ effort: "high" });
	expect(
		sessionReasoning(
			"speechToSpeech",
			settings,
			undefined,
			model("gpt-realtime-mini"),
		),
	).toBeNull();
	// gpt-5.4 takes none; gpt-5-mini does not, so it is sent nothing.
	expect(
		sessionReasoning("cascade", settings, undefined, model("gpt-5.4")),
	).toEqual({ effort: "none" });
	expect(
		sessionReasoning("cascade", settings, undefined, model("gpt-5-mini")),
	).toBeNull();
});
