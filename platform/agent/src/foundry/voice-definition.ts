import type { Tier } from "@platform/identity/claims";
import type { ReasoningEffort } from "@platform/llm";
import type { ProductLanguages, VoiceAudio } from "../contract/product";
import {
	type TurnDetectionType,
	VERSION_TURN_DETECTION,
} from "../contract/voice-tuning";
import {
	type AgentSettings,
	isOpenAIVoice,
	type NoiseReduction,
	type RealtimeReasoningEffort,
	type Transcriber,
	transcriberFor,
	type VoiceEngine,
} from "../settings";
import { type ManagedVoiceModel, managedTranscriber } from "../voice-models";
import {
	type FunctionToolDefinition,
	PERSONALIZATION_INPUT,
} from "./definition";

/**
 * The voice agent (preview) as one version, and the update that fits a
 * session of it to one person. The voice agent is the agent a live session talks to: it listens, reasons,
 * calls the product's tools and speaks. It names a deployment on this
 * account (`model_type: "self_deployed"`), or, where a setting or a voice
 * tester chose one, a model the service runs itself (`model_type:
 * "managed"`, `voice-models.ts`), and the service derives from the
 * model how it runs: on the chat's deployment, the `cascade` engine — the
 * person transcribed, the chat's model answering in text, the text spoken —
 * so a spoken turn is answered by the model a typed one is; on a realtime
 * deployment, `speechToSpeech` — the realtime model hearing the person's
 * audio itself and answering, the Azure voice speaking its answer, or the
 * model's own voice when the voice is an OpenAI one (which takes no fillers,
 * so a version with one has none), the transcriber writing only the readable
 * transcript. A version fixes its model, so each engine is a version of its
 * own.
 * Its version is everything that is the same for every person and every
 * language — parts one and two of the spoken prompt with the person's part
 * as a placeholder, every function tool the voice surface has, the audio
 * defaults — and nothing that is a person's. Nothing in it names a locale either: the voice is multilingual,
 * turn detection is multilingual over the product's languages, and the
 * transcription has no language, so one version speaks every language.
 *
 * It consults no other agent. A voice agent fronting a sub-agent does not
 * work for this shape: the sub-agent does not receive the person's
 * structured inputs, and its tool calls do not reach the socket. Held by the voice agent itself, both
 * work: the inputs are rendered into its own instructions, and every call
 * it makes is a `response.function_call_arguments.done` on the session the
 * backend holds.
 *
 * The person's language reaches a session three ways: the language
 * directive closes the third part (a structured input), and it is what the
 * answer is spoken in; and a `session.update`, sent once the session is
 * announced, states the transcription's language and the voice's accent,
 * with the tier's voice. The fillers need no language stated: the
 * version's are written by the service's model from the conversation, in
 * the language it is in. The accent takes;
 * the transcription's language does not: the service echoes none
 * (`azure-speech`, `mai-transcribe`) and transcribes the language it hears.
 * {@link voiceSessionUpdate} builds it, and is the one place that decides
 * how: `stated` states both, `detected` leaves both to the service over the
 * product's languages. Switching is the `voice` document's `live.language`,
 * not code.
 */

/** The second structured input: the person's language, as a code the version lists. */
export const LANGUAGE_INPUT = "language";

/** Azure's standard voices, multilingual and HD ones among them, or a realtime model's own. */
type VoiceType = "azure-standard" | "openai";

/** The type the service is told a voice is: an OpenAI voice by its name, every other an Azure one. */
function voiceTypeOf(voice: string): VoiceType {
	return isOpenAIVoice(voice) ? "openai" : "azure-standard";
}

/** The transcribers that take a list of languages to detect among. */
const TAKES_LANGUAGES: ReadonlySet<Transcriber> = new Set([
	"gpt-transcribe",
	"gpt-live-transcribe",
]);

interface StructuredInput {
	description: string;
	schema: { type: "string"; enum?: string[] };
	required: true;
}

/** A function the session's client runs: the voice agents' shape, which takes no `strict`. */
export interface VoiceFunctionTool {
	type: "function";
	name: string;
	description: string;
	parameters: Record<string, unknown>;
}

export interface VoiceAgentDefinition {
	kind: "voice";
	/** `self_deployed`: a deployment on this account, the chat's, run as a cascade, or a realtime model's, run speech-to-speech. `managed`: a model the service runs, named in `MANAGED_VOICE_MODELS`. */
	model_type: "self_deployed" | "managed";
	model: string;
	instructions: string;
	structured_inputs: Record<string, StructuredInput>;
	audio: {
		input: {
			noise_reduction: { type: NoiseReduction };
			echo_cancellation: { type: "server_echo_cancellation" };
			/** The version's own detection over the product's languages, or a voice tester's, whole. */
			turn_detection: TurnDetectionUpdate;
			transcription: { model: Transcriber };
		};
		output: {
			voice_type: VoiceType;
			voice: string;
		};
	};
	output_modalities: ["audio"];
	/** What the voice says while a tool call runs, written by the service's model in the conversation's language. Absent: nothing is, and never beside an OpenAI voice. */
	interim_response?: InterimResponse;
	/** Every control and every server tool the voice surface has, each call reaching the backend's socket. */
	tools: VoiceFunctionTool[];
	rai_config?: { rai_policy_name: string };
	/** Never true: Foundry keeps no transcript and no audio of a session (Q3). */
	store: false;
}

/**
 * What the model writing a filler is told: the service's model writes one
 * short line while a tool call runs, from the conversation so far, so it is
 * in the person's language and says what is being looked up rather than the
 * same phrase each time.
 */
export const INTERIM_INSTRUCTIONS =
	"Write one short spoken sentence, under ten words, telling the person you are looking into what they just asked. Use the language of the conversation. Vary the wording from earlier ones. Never state, guess or promise the answer, and never say the lookup succeeded.";

/** Only a tool call, written by the service's model, at the service's own threshold: a slow model is the model's to cover. */
interface InterimResponse {
	type: "llm_interim_response";
	triggers: ["tool"];
	instructions: string;
}

const INTERIM_RESPONSE: InterimResponse = {
	type: "llm_interim_response",
	triggers: ["tool"],
	instructions: INTERIM_INSTRUCTIONS,
};

export interface VoiceDefinitionInput {
	/** Parts one and two of the spoken prompt, composed and escaped: the spoken guardrails, the persona and the voice surface. */
	fixed: string;
	/** The voice surface's function tools, as the prompt agent's definition writes them. */
	tools: readonly FunctionToolDefinition[];
	languages: Pick<ProductLanguages, "codes">;
	/** The engine this version is: what decides the transcriber it may take. */
	engine: VoiceEngine;
	/** The engine's deployment: the chat's, as the prompt agent's version names it, or the realtime one. Ignored beside `managed`. */
	model: string;
	/** A managed model of this engine the version names in place of the deployment; absent or null: the deployment. */
	managed?: ManagedVoiceModel | null;
	settings: AgentSettings["voice"];
	/** The base tier's voice, or the OpenAI voice a speech-to-speech session speaks with: what a session speaks with until its update says otherwise. */
	voiceName: string;
	raiPolicy?: string;
	/** Whether the voice fills a tool call's wait; false for a voice tester who turned it off. Absent is true. An OpenAI voice never does. */
	interim?: boolean;
	/**
	 * How a voice tester's sessions hear the person, in place of the
	 * version's: a session cannot change either. The service refuses a
	 * session update that changes the turn detection's type
	 * (`turn_detection_type_change_not_allowed`) or the noise suppression's
	 * speech front end (`change_in_speech_frontend_not_allowed`), and the
	 * rest of that update with it. Known from how the service behaves.
	 */
	heard?: VersionHearing;
}

/** What a voice tester's version hears the person with: none set is the version's own. */
export interface VersionHearing {
	turnDetection?: TurnDetectionUpdate;
	noiseReduction?: NoiseReduction;
}

/**
 * A JSON schema without its `$schema` keyword. The voice agent takes a
 * version whose tool parameters name one and then never applies it: the
 * session is announced on the service's defaults and no `session.updated`
 * ever follows. Not documented; the service behaves this way.
 * Every other keyword is kept.
 */
export function withoutSchemaUri(schema: unknown): unknown {
	if (Array.isArray(schema)) return schema.map(withoutSchemaUri);
	if (!schema || typeof schema !== "object") return schema;
	return Object.fromEntries(
		Object.entries(schema)
			.filter(([key]) => key !== "$schema")
			.map(([key, value]) => [key, withoutSchemaUri(value)]),
	);
}

/**
 * The transcriber an engine's version takes for the one asked for: a
 * managed model's own list decides for it (`managedTranscriber`), the
 * engine's rule for a deployment (`transcriberFor`).
 */
export function versionTranscriber(
	engine: VoiceEngine,
	managed: ManagedVoiceModel | null,
	asked: Transcriber,
): Transcriber {
	return managed
		? managedTranscriber(managed, asked)
		: transcriberFor(engine, asked);
}

export function voiceAgentDefinition(
	input: VoiceDefinitionInput,
): VoiceAgentDefinition {
	const languages = [...input.languages.codes];
	const { settings, managed } = input;
	if (managed && managed.engine !== input.engine)
		throw new Error(`${managed.name} is not a ${input.engine} model`);
	return {
		kind: "voice",
		model_type: managed ? "managed" : "self_deployed",
		model: managed ? managed.name : input.model,
		instructions: `${input.fixed}\n\n{{${PERSONALIZATION_INPUT}}}`,
		structured_inputs: {
			[PERSONALIZATION_INPUT]: {
				description:
					"Who the person is, what is remembered about them, what is on their screen, and their language.",
				schema: { type: "string" },
				required: true,
			},
			[LANGUAGE_INPUT]: {
				description: "The language the person chose, as a code.",
				schema: { type: "string", enum: languages },
				required: true,
			},
		},
		audio: {
			input: {
				noise_reduction: {
					type: input.heard?.noiseReduction ?? settings.noiseReduction,
				},
				echo_cancellation: { type: "server_echo_cancellation" },
				// When a turn ends, in any of the product's languages; never what was said.
				// A person speaking over the voice cancels the answer, and nothing cuts
				// its item to what was played: the record keeps the whole reply. Stated,
				// though the API reference documents off as the default.
				turn_detection: input.heard?.turnDetection ?? {
					type: VERSION_TURN_DETECTION,
					languages,
					auto_truncate: false,
				},
				// No language: each session states its own.
				transcription: {
					model: versionTranscriber(
						input.engine,
						managed ?? null,
						settings.transcription,
					),
				},
			},
			// No `voice_locale`: each session states its own accent.
			output: {
				voice_type: voiceTypeOf(input.voiceName),
				voice: input.voiceName,
			},
		},
		output_modalities: ["audio"],
		// The service refuses fillers beside an OpenAI voice.
		...(input.interim === false || isOpenAIVoice(input.voiceName)
			? {}
			: { interim_response: { ...INTERIM_RESPONSE } }),
		tools: [
			...input.tools.map(
				(tool): VoiceFunctionTool => ({
					type: "function",
					name: tool.name,
					description: tool.description,
					parameters: withoutSchemaUri(tool.parameters) as Record<
						string,
						unknown
					>,
				}),
			),
		],
		...(input.raiPolicy
			? { rai_config: { rai_policy_name: input.raiPolicy } }
			: {}),
		store: false,
	};
}

/**
 * The payload of one session's `session.update`: the voice agents'
 * `VoiceAgentSessionUpdateConfig`, the audio and the reasoning. A voice
 * agent's version has no reasoning field (`VoiceAgentDefinition` in `@azure/ai-projects` 2.10.0); the session update
 * does (`reasoning`), and the chat's model behind a cascade takes it
 * (`session.updated` echoes the effort back). A realtime model takes it only
 * when it reasons (`gpt-realtime-2`, `gpt-realtime-2.1` and
 * `gpt-realtime-2.1-mini`), so on speech-to-speech it is sent for those alone.
 * No `temperature` either way: the SDK applies it to cascades only, and
 * this update never sets it. Nor does it set the fillers: the version's
 * are written by a model from the conversation, in its language already.
 */
export type VoiceSessionUpdate = {
	type: "realtime";
	/** The cascade's: the chat's effort, as a typed turn's; a reasoning realtime model's: the voice document's. Absent: none sent. */
	reasoning?: SessionReasoning;
	audio: {
		input: {
			transcription: {
				model: Transcriber;
				language?: string;
				languages?: string[];
			};
		};
		output: {
			voice_type: VoiceType;
			voice: string;
			/** An Azure voice's alone, as is `prefer_locales`. */
			voice_locale?: string;
			prefer_locales?: string[];
		};
	};
};

/** A turn detection a version states, whole: the type, and the timers a tester set. */
export interface TurnDetectionUpdate {
	type: TurnDetectionType;
	languages?: string[];
	threshold?: number;
	silence_duration_ms?: number;
	prefix_padding_ms?: number;
	auto_truncate?: false;
}

/** The detection only a realtime model runs, and which takes none of the timers. */
export const REALTIME_ONLY_TURN_DETECTION: TurnDetectionType = "semantic_vad";

/** The effort a session's update states: the chat's on a cascade, a realtime model's own scale on speech-to-speech. */
export interface SessionReasoning {
	effort: ReasoningEffort | Exclude<RealtimeReasoningEffort, "none">;
}

/**
 * The realtime models that reason, and so take an effort: the SDK's
 * `RealtimeReasoning` names `gpt-realtime-2` and `gpt-realtime-2.1`, and
 * `gpt-realtime-2.1-mini` takes one too (the session echoes it back). The
 * mini models before it refuse one (`invalid_value`, "Unsupported option for
 * this model") and go on without it.
 */
const REASONING_REALTIME_MODELS: ReadonlySet<string> = new Set([
	"gpt-realtime-2",
	"gpt-realtime-2.1",
	"gpt-realtime-2.1-mini",
]);

/** Whether a realtime model takes a reasoning effort. */
export function reasonsAtRealtime(model: string | undefined): boolean {
	return REASONING_REALTIME_MODELS.has(model ?? "");
}

/**
 * What a session of `engine` is told about reasoning. The cascade carries
 * the typed turns' effort, as it always has. Speech-to-speech carries the
 * voice document's `realtimeReasoningEffort` only for a model that reasons —
 * an unknown model is sent none, which no model refuses — and `none` sends
 * none. A managed model is sent an effort only from its own list
 * (`voice-models.ts`), on either engine, and none otherwise.
 */
export function sessionReasoning(
	engine: VoiceEngine,
	settings: Pick<AgentSettings, "reasoningEffort"> & {
		voice: Pick<AgentSettings["voice"], "realtimeReasoningEffort">;
	},
	realtimeModel: string | undefined,
	managed: ManagedVoiceModel | null = null,
): SessionReasoning | null {
	const effort =
		engine === "cascade"
			? settings.reasoningEffort
			: settings.voice.realtimeReasoningEffort;
	if (managed) return managed.efforts.includes(effort) ? { effort } : null;
	if (engine === "cascade") return { effort: settings.reasoningEffort };
	if (effort === "none" || !reasonsAtRealtime(realtimeModel)) return null;
	return { effort: effort as SessionReasoning["effort"] };
}

export interface SessionAudioInput {
	/** The transcriber the session runs with: the documents', or a tester's tuning of it. */
	transcription: Transcriber;
	/** From {@link sessionReasoning}; null sends none. */
	reasoning: SessionReasoning | null;
	audio: VoiceAudio;
	tier: Tier;
	/** The person's language, already checked against the product's. */
	locale: string;
	languages: ProductLanguages;
	/** The voice the session speaks with, resolved (`effectiveVoice`); absent: the tier's. */
	voice?: string;
	/** What a voice tester set for this session; none for anybody else. */
	tuned?: SessionTuning;
}

/** The parts of a session's update a voice tester's tuning decides. */
export interface SessionTuning {
	/** The voice in place of the tier's. */
	voice?: string;
}

/**
 * The update that fits a session to its person. The transcription is
 * whole, model included, so an update that replaces the section cannot
 * drop what the version set.
 */
export function voiceSessionUpdate(
	input: SessionAudioInput,
): VoiceSessionUpdate {
	const { transcription, audio, languages, locale } = input;
	const tuned = input.tuned ?? {};
	const voice =
		tuned.voice ??
		input.voice ??
		audio.voices[input.tier === "premium" ? "premium" : "base"];
	// An OpenAI voice takes no accent and no preferred locales: the language
	// directive in the instructions is what sets its language.
	const azure = !isOpenAIVoice(voice);
	const common = input.reasoning ? { reasoning: input.reasoning } : {};
	const output: VoiceSessionUpdate["audio"]["output"] = {
		voice_type: voiceTypeOf(voice),
		voice,
	};
	if (audio.language === "detected") {
		// The service hears which language it is; a listed transcriber is told which it may be.
		const accents = languages.codes.flatMap(
			(code) => languages.accent(code) ?? [],
		);
		return {
			type: "realtime",
			...common,
			audio: {
				input: {
					transcription: {
						model: transcription,
						...(TAKES_LANGUAGES.has(transcription)
							? { languages: [...languages.codes] }
							: {}),
					},
				},
				output: {
					...output,
					...(accents.length && azure ? { prefer_locales: accents } : {}),
				},
			},
		};
	}
	const accent = languages.accent(locale);
	return {
		type: "realtime",
		...common,
		audio: {
			input: {
				transcription: { model: transcription, language: locale },
			},
			output: {
				...output,
				...(accent && azure ? { voice_locale: accent } : {}),
			},
		},
	};
}

/**
 * One Voice Live session's whole `session.update`, for the `voiceLive`
 * runtime: what a voice agent's version and the person's update hold
 * between them, in the fields the Voice Live API (generally available)
 * documents for a session on a model it hosts — the flat realtime shape
 * (`voice-live-how-to`, and the API reference of `VOICE_LIVE_API_VERSION`). There is no
 * version: the instructions are rendered here, the person's part in place of
 * its placeholder, and the tools are the session's own. What has no
 * documented field there is left out: the voice's accent, the reasoning
 * effort, a content-filter policy (Voice Live's own filter applies, and the
 * FAQ says it cannot be changed), and `store` (Voice Live keeps nothing).
 */
export function voiceLiveSession(
	definition: VoiceAgentDefinition,
	update: VoiceSessionUpdate,
	personalization: string,
): Record<string, unknown> {
	const { input } = definition.audio;
	const { output } = update.audio;
	return {
		instructions: definition.instructions.replace(
			`{{${PERSONALIZATION_INPUT}}}`,
			() => personalization,
		),
		modalities: ["text", "audio"],
		voice: { name: output.voice, type: output.voice_type },
		input_audio_sampling_rate: 24000,
		input_audio_noise_reduction: input.noise_reduction,
		input_audio_echo_cancellation: input.echo_cancellation,
		turn_detection: input.turn_detection,
		input_audio_transcription: update.audio.input.transcription,
		tools: definition.tools,
		tool_choice: "auto",
		...(definition.interim_response
			? { interim_response: definition.interim_response }
			: {}),
	};
}
