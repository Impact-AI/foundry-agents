import type { Tier } from "@platform/identity/claims";
import { REASONING_EFFORTS } from "@platform/llm";
import {
	MODEL_SOURCES,
	type ModelSource,
	TURN_DETECTIONS,
	type TurnDetectionType,
	VERSION_TURN_DETECTION,
	type VoiceTuning,
} from "../contract/voice-tuning";
import {
	type AgentSettings,
	isOpenAIVoice,
	NOISE_REDUCTIONS,
	type NoiseReduction,
	OPENAI_VOICES,
	REALTIME_REASONING_EFFORTS,
	TRANSCRIBERS,
	type Transcriber,
	transcriberTakenBy,
	VOICE_ENGINES,
	type VoiceEngine,
} from "../settings";
import {
	type ManagedVoiceModel,
	managedModelsFor,
	managedVoiceModel,
	type ProcessingScope,
} from "../voice-models";
import type { RealtimeDeployment } from "./definition";
import {
	REALTIME_ONLY_TURN_DETECTION,
	reasonsAtRealtime,
	type SessionTuning,
	sessionReasoning,
	type VersionHearing,
	versionTranscriber,
} from "./voice-definition";
import { sessionVoiceEngine } from "./voice-engine";

/**
 * A voice tester's tuning of their own live sessions: a bounded override
 * of what the `agent` and `voice` documents decide, held on their account
 * and never written to either document. Every value is checked here against
 * the lists those documents are checked against (`settings.ts`), and against
 * what this deployment has — a realtime model only with its deployment, a
 * transcriber only for an engine that takes it, an effort only for a model
 * that reasons — so nothing a tester can store reaches the service as a
 * value it does not take. That matters most for the noise suppression: a
 * type the service does not take is not refused, the session runs without
 * the version's instructions, guardrails and tools; and beside a realtime
 * model's own `semantic_vad` the headset and personal types are refused and
 * the session never answers, so they are neither offered nor accepted there,
 * and the documents' type gives way to the plain deep one.
 *
 * The engine, the model source — this deployment's own model, or a managed
 * one the service runs (`voice-models.ts`), which has its own processing
 * scope and its own capabilities — and the model are the version's (a
 * version fixes its model), and so are the fillers and an OpenAI voice;
 * everything else is the session's update. A managed model bounds the
 * efforts, the transcribers and the OpenAI voices by its row of the table.
 * An OpenAI voice is offered on speech-to-speech alone, which is the only
 * engine that speaks with one, and it turns the fillers
 * off, since the service refuses them beside it: so no tuning can ask for
 * a combination the service refuses.
 * {@link effectiveVoice} is what a session runs with, and what the
 * settings panel shows: one function for both, so the panel never says
 * "default" where the session runs with a value.
 */

/**
 * The noise suppressions that need the service's own speech front end. A
 * realtime model's `semantic_vad` owns the turn detection itself and leaves
 * the session none, so beside it the service refuses these
 * (`speech_frontend_not_available`, "upstream_vad_owned") and the session
 * never answers; the plain deep model it takes. Known from how the service
 * behaves, not documented.
 */
const NEEDS_SPEECH_FRONTEND: ReadonlySet<NoiseReduction> = new Set([
	"azure_deep_noise_suppression_headset",
	"azure_personal_noise_suppression",
]);

/** What a `semantic_vad` session cleans the microphone with in place of one of those. */
const SEMANTIC_VAD_NOISE_REDUCTION: NoiseReduction =
	"azure_deep_noise_suppression";

/** Whether the service runs `noise` beside `turnDetection`. */
function runsBeside(
	turnDetection: TurnDetectionType,
	noise: NoiseReduction,
): boolean {
	return (
		turnDetection !== REALTIME_ONLY_TURN_DETECTION ||
		!NEEDS_SPEECH_FRONTEND.has(noise)
	);
}

export type { VoiceTuning };

/** The bounds of the turn detection's timers, as the panel draws them and this module enforces them. */
const TUNING_BOUNDS = {
	silenceMs: { min: 100, max: 3000, step: 50, integer: true },
	threshold: { min: 0, max: 1, step: 0.05, integer: false },
	prefixPaddingMs: { min: 0, max: 2000, step: 50, integer: true },
} as const;
type Timer = keyof typeof TUNING_BOUNDS;
const TIMERS = Object.keys(TUNING_BOUNDS) as Timer[];

/**
 * Azure voices a tester may hear beside the deployment's own two: multilingual
 * standard and HD voices Microsoft documents, since an unknown voice fails
 * at synthesis rather than when the session opens.
 */
const TUNING_VOICES = [
	"en-US-AvaMultilingualNeural",
	"en-US-AndrewMultilingualNeural",
	"en-US-EmmaMultilingualNeural",
	"en-US-BrianMultilingualNeural",
	"en-US-Ava:DragonHDLatestNeural",
	"en-US-Andrew:DragonHDLatestNeural",
] as const;

/** What the deployment has, which bounds a tuning beyond the documents' lists. */
export interface TuningContext {
	/** The realtime deployments, the one sessions run on first (`realtimeDeployments()`). */
	realtime: readonly RealtimeDeployment[];
	/** The `voice` document's voice per tier. */
	voices: Record<Tier, string>;
	/** The `voice` document's OpenAI voice per tier, spoken on speech-to-speech alone; empty: none. */
	openaiVoices?: Record<Tier, string>;
}

/** The settings a session's voice is decided from. */
export type TuningSettings = Pick<AgentSettings, "reasoningEffort" | "voice">;

/** A managed model as the panel draws it: its name and where the service processes it. */
export interface ManagedChoice {
	name: string;
	scope: ProcessingScope;
}

/** What a session runs with, every control resolved: the tuning over the documents. */
export interface EffectiveVoice {
	engine: VoiceEngine;
	modelSource: ModelSource;
	/** The managed model the version names; null with the deployment source. */
	managed: ManagedVoiceModel | null;
	/** The deployment speech-to-speech names; null on the cascade and with a managed model. */
	realtime: RealtimeDeployment | null;
	voice: string;
	turnDetection: TurnDetectionType;
	/** Null: the service's own value, which the session is not sent. */
	silenceMs: number | null;
	threshold: number | null;
	prefixPaddingMs: number | null;
	noiseReduction: NoiseReduction;
	transcription: Transcriber;
	/** Null: this engine and model take no effort. */
	reasoningEffort: string | null;
	interimResponses: boolean;
}

/** The values each control offers, for the engine a session runs. */
export interface TuningChoices {
	engines: VoiceEngine[];
	/** Empty: the engine has one source only, and the control is not drawn. */
	modelSources: ModelSource[];
	/** The managed models of the engine, each with its processing scope. */
	managedModels: ManagedChoice[];
	realtimeModels: string[];
	voices: string[];
	/** The OpenAI voices among {@link voices}: speech-to-speech's alone, so none on the cascade. */
	openaiVoices: string[];
	turnDetections: TurnDetectionType[];
	noiseReductions: NoiseReduction[];
	transcriptions: Transcriber[];
	/** Empty: the engine and model take no effort, and the control is not drawn. */
	reasoningEfforts: string[];
	/** False: the voice is an OpenAI one, which speaks with no fillers, so the control is fixed off. */
	interimResponses: boolean;
	bounds: typeof TUNING_BOUNDS;
}

/** The engine a tuning runs: the tester's, which the check has held to one with a model, or the documents'. */
function engineOf(
	tuning: VoiceTuning,
	settings: TuningSettings,
	ctx: TuningContext,
	tier: Tier,
): VoiceEngine {
	if (tuning.engine) return tuning.engine;
	return sessionVoiceEngine(settings.voice, tier, ctx.realtime[0]?.deployment);
}

/** The sources an engine may run on: speech-to-speech on a deployment only where there is one. */
function sourcesFor(engine: VoiceEngine, ctx: TuningContext): ModelSource[] {
	const deployment = engine === "cascade" || ctx.realtime.length > 0;
	return MODEL_SOURCES.filter(
		(source) => source === "managed" || deployment,
	).filter(
		(source) => source === "deployment" || managedModelsFor(engine).length > 0,
	);
}

/** The source a tuning runs on: the tester's, else the document's managed model for the engine, else the deployment where there is one. */
function sourceOf(
	engine: VoiceEngine,
	tuning: VoiceTuning,
	settings: TuningSettings,
	ctx: TuningContext,
): ModelSource {
	const sources = sourcesFor(engine, ctx);
	if (tuning.modelSource) return tuning.modelSource;
	if (tuning.managedModel && sources.includes("managed")) return "managed";
	if (settings.voice.managedModel[engine] && sources.includes("managed"))
		return "managed";
	return sources[0] ?? "deployment";
}

function managedOf(
	engine: VoiceEngine,
	source: ModelSource,
	tuning: VoiceTuning,
	settings: TuningSettings,
): ManagedVoiceModel | null {
	if (source !== "managed") return null;
	const own = (name: string | undefined) => {
		const model = managedVoiceModel(name);
		return model?.engine === engine ? model : null;
	};
	return (
		own(tuning.managedModel) ??
		own(settings.voice.managedModel[engine]) ??
		managedModelsFor(engine)[0] ??
		null
	);
}

function realtimeOf(
	engine: VoiceEngine,
	managed: ManagedVoiceModel | null,
	tuning: VoiceTuning,
	ctx: TuningContext,
): RealtimeDeployment | null {
	if (engine !== "speechToSpeech" || managed) return null;
	return (
		ctx.realtime.find((r) => r.model === tuning.realtimeModel) ??
		ctx.realtime[0] ??
		null
	);
}

/** The model a session runs on, every part of it resolved from the tuning and the documents. */
function modelOf(
	tuning: VoiceTuning,
	settings: TuningSettings,
	ctx: TuningContext,
	tier: Tier,
) {
	const engine = engineOf(tuning, settings, ctx, tier);
	const modelSource = sourceOf(engine, tuning, settings, ctx);
	const managed = managedOf(engine, modelSource, tuning, settings);
	return {
		engine,
		modelSource,
		managed,
		realtime: realtimeOf(engine, managed, tuning, ctx),
	};
}

/** The efforts a session may be given; a managed model's own, with `none`, which sends none. */
function effortsFor(
	engine: VoiceEngine,
	realtime: RealtimeDeployment | null,
	managed: ManagedVoiceModel | null,
): readonly string[] {
	if (managed)
		return managed.efforts.length
			? [...new Set(["none", ...managed.efforts])]
			: [];
	if (engine === "cascade") return REASONING_EFFORTS;
	return reasonsAtRealtime(realtime?.model) ? REALTIME_REASONING_EFFORTS : [];
}

/** Whether a session may speak an OpenAI voice: speech-to-speech, on a model that speaks them. */
function speaksOpenAI(
	engine: VoiceEngine,
	managed: ManagedVoiceModel | null,
): boolean {
	return engine === "speechToSpeech" && (managed?.openaiVoices ?? true);
}

/** The voice the documents give a session of `tier` on `engine`: the OpenAI one only where the model speaks it. */
function documentVoice(
	engine: VoiceEngine,
	managed: ManagedVoiceModel | null,
	ctx: TuningContext,
	tier: Tier,
): string {
	const openai = ctx.openaiVoices?.[tier];
	return speaksOpenAI(engine, managed) && openai ? openai : ctx.voices[tier];
}

export function tuningChoices(
	ctx: TuningContext,
	effective: Pick<
		EffectiveVoice,
		"engine" | "managed" | "realtime" | "voice" | "turnDetection"
	>,
): TuningChoices {
	const { engine, managed } = effective;
	const openai: string[] = speaksOpenAI(engine, managed)
		? [...OPENAI_VOICES]
		: [];
	const sources = sourcesFor(engine, ctx);
	return {
		engines: VOICE_ENGINES.filter(
			(candidate) => sourcesFor(candidate, ctx).length > 0,
		),
		modelSources: sources.length > 1 ? sources : [],
		managedModels: sources.includes("managed")
			? managedModelsFor(engine).map(({ name, scope }) => ({ name, scope }))
			: [],
		openaiVoices: openai,
		realtimeModels: managed
			? []
			: ctx.realtime.flatMap((r) => (r.model ? [r.model] : [])),
		voices: [
			...new Set([
				ctx.voices.base,
				ctx.voices.premium,
				...TUNING_VOICES,
				...openai,
			]),
		],
		turnDetections: TURN_DETECTIONS.filter(
			(type) =>
				engine === "speechToSpeech" || type !== REALTIME_ONLY_TURN_DETECTION,
		),
		noiseReductions: NOISE_REDUCTIONS.filter((noise) =>
			runsBeside(effective.turnDetection, noise),
		),
		transcriptions: managed
			? [...managed.transcribers]
			: TRANSCRIBERS.filter((t) => transcriberTakenBy(engine, t)),
		reasoningEfforts: [...effortsFor(engine, effective.realtime, managed)],
		interimResponses: !isOpenAIVoice(effective.voice),
		bounds: TUNING_BOUNDS,
	};
}

export function effectiveVoice(
	settings: TuningSettings,
	ctx: TuningContext,
	tier: Tier,
	tuning: VoiceTuning | null,
): EffectiveVoice {
	const t = tuning ?? {};
	const model = modelOf(t, settings, ctx, tier);
	const { engine, managed, realtime } = model;
	const reasoning = sessionReasoning(
		engine,
		{
			reasoningEffort: (engine === "cascade" && t.reasoningEffort
				? t.reasoningEffort
				: settings.reasoningEffort) as AgentSettings["reasoningEffort"],
			voice: {
				realtimeReasoningEffort: (engine === "speechToSpeech" &&
				t.reasoningEffort
					? t.reasoningEffort
					: settings.voice
							.realtimeReasoningEffort) as AgentSettings["voice"]["realtimeReasoningEffort"],
			},
		},
		realtime?.model,
		managed,
	);
	const turnDetection = t.turnDetection ?? VERSION_TURN_DETECTION;
	const timed = turnDetection !== REALTIME_ONLY_TURN_DETECTION;
	const voice = t.voice ?? documentVoice(engine, managed, ctx, tier);
	// The documents' noise suppression, where the tester chose a detection it cannot run beside, gives way to one that can.
	const noise = t.noiseReduction ?? settings.voice.noiseReduction;
	return {
		...model,
		voice,
		turnDetection,
		silenceMs: timed ? (t.silenceMs ?? null) : null,
		threshold: timed ? (t.threshold ?? null) : null,
		prefixPaddingMs: timed ? (t.prefixPaddingMs ?? null) : null,
		noiseReduction: runsBeside(turnDetection, noise)
			? noise
			: SEMANTIC_VAD_NOISE_REDUCTION,
		transcription:
			t.transcription ??
			versionTranscriber(engine, managed, settings.voice.transcription),
		reasoningEffort: reasoning
			? reasoning.effort
			: effortsFor(engine, realtime, managed).length
				? "none"
				: null,
		// The service refuses fillers beside an OpenAI voice: it speaks without them.
		interimResponses: isOpenAIVoice(voice)
			? false
			: (t.interimResponses ?? true),
	};
}

export type TuningCheck =
	| { ok: true; tuning: VoiceTuning }
	/** The first field that refused it, for the panel to point at. */
	| { ok: false; field: string };

const KEYS: ReadonlySet<string> = new Set<keyof VoiceTuning>([
	"engine",
	"modelSource",
	"managedModel",
	"realtimeModel",
	"voice",
	"turnDetection",
	"silenceMs",
	"threshold",
	"prefixPaddingMs",
	"noiseReduction",
	"transcription",
	"reasoningEffort",
	"interimResponses",
]);

function within(value: unknown, timer: Timer): value is number {
	const bound = TUNING_BOUNDS[timer];
	return (
		typeof value === "number" &&
		Number.isFinite(value) &&
		value >= bound.min &&
		value <= bound.max &&
		(!bound.integer || Number.isInteger(value))
	);
}

/**
 * A tuning as stored or as sent, checked whole: every field against its
 * list and against what the deployment has, for the engine the tuning
 * itself runs. Refused at the first field that does not hold — never
 * trimmed to what does, so what a tester saved is what runs or nothing is.
 * A field set to null is not set.
 */
export function checkVoiceTuning(
	raw: unknown,
	settings: TuningSettings,
	ctx: TuningContext,
	tier: Tier,
): TuningCheck {
	if (!raw || typeof raw !== "object" || Array.isArray(raw))
		return { ok: false, field: "tuning" };
	const given = Object.fromEntries(
		Object.entries(raw).filter(([, value]) => value != null),
	) as Record<string, unknown>;
	for (const key of Object.keys(given))
		if (!KEYS.has(key)) return { ok: false, field: key };
	const t = given as VoiceTuning;
	const oneOf = (list: readonly unknown[], value: unknown) =>
		value === undefined || list.includes(value);

	if (!oneOf(VOICE_ENGINES, t.engine)) return { ok: false, field: "engine" };
	if (t.engine && !sourcesFor(t.engine, ctx).length)
		return { ok: false, field: "engine" };
	const engine = engineOf(t, settings, ctx, tier);
	if (
		t.modelSource !== undefined &&
		!sourcesFor(engine, ctx).includes(t.modelSource)
	)
		return { ok: false, field: "modelSource" };
	const { modelSource, managed, realtime } = modelOf(t, settings, ctx, tier);
	if (
		t.managedModel !== undefined &&
		(modelSource !== "managed" || managed?.name !== t.managedModel)
	)
		return { ok: false, field: "managedModel" };
	const choices = tuningChoices(ctx, {
		engine,
		managed,
		realtime,
		voice: t.voice ?? documentVoice(engine, managed, ctx, tier),
		turnDetection: oneOf(TURN_DETECTIONS, t.turnDetection)
			? (t.turnDetection ?? VERSION_TURN_DETECTION)
			: VERSION_TURN_DETECTION,
	});
	if (
		t.realtimeModel !== undefined &&
		(engine !== "speechToSpeech" ||
			managed ||
			!choices.realtimeModels.includes(t.realtimeModel))
	)
		return { ok: false, field: "realtimeModel" };
	if (!oneOf(choices.voices, t.voice)) return { ok: false, field: "voice" };
	if (!oneOf(choices.turnDetections, t.turnDetection))
		return { ok: false, field: "turnDetection" };
	const timed =
		(t.turnDetection ?? VERSION_TURN_DETECTION) !==
		REALTIME_ONLY_TURN_DETECTION;
	for (const timer of TIMERS)
		if (given[timer] !== undefined && (!timed || !within(given[timer], timer)))
			return { ok: false, field: timer };
	if (!oneOf(choices.noiseReductions, t.noiseReduction))
		return { ok: false, field: "noiseReduction" };
	if (!oneOf(choices.transcriptions, t.transcription))
		return { ok: false, field: "transcription" };
	if (!oneOf(choices.reasoningEfforts, t.reasoningEffort))
		return { ok: false, field: "reasoningEffort" };
	if (
		t.interimResponses !== undefined &&
		typeof t.interimResponses !== "boolean"
	)
		return { ok: false, field: "interimResponses" };
	return { ok: true, tuning: t };
}

/** The parts of a session's update a tuning decides: only what the tester set, so the version's stands for the rest. */
export function sessionTuning(
	tuning: VoiceTuning,
	effective: EffectiveVoice,
): SessionTuning {
	return {
		...(tuning.voice ? { voice: effective.voice } : {}),
	};
}

/**
 * How a tuning hears the person: the turn detection, whole, and the noise
 * suppression — the version's to hold, since a session cannot change
 * either (`VersionHearing`). Only what the tester set, so a tuning that
 * sets neither runs on the shipped version.
 */
export function versionHearing(
	tuning: VoiceTuning,
	effective: EffectiveVoice,
	languages: readonly string[],
): VersionHearing {
	const timers = {
		...(effective.threshold != null ? { threshold: effective.threshold } : {}),
		...(effective.silenceMs != null
			? { silence_duration_ms: effective.silenceMs }
			: {}),
		...(effective.prefixPaddingMs != null
			? { prefix_padding_ms: effective.prefixPaddingMs }
			: {}),
	};
	const detects =
		tuning.turnDetection !== undefined || Object.keys(timers).length > 0;
	const type = effective.turnDetection;
	return {
		// On `semantic_vad` the documents' own may be one the service refuses beside it: always stated.
		...(tuning.noiseReduction || type === REALTIME_ONLY_TURN_DETECTION
			? { noiseReduction: effective.noiseReduction }
			: {}),
		...(detects
			? {
					turnDetection: {
						type,
						// The Azure detections listen for the product's languages, as the version's does.
						...(type.startsWith("azure_semantic_vad")
							? { languages: [...languages] }
							: {}),
						...timers,
						...(type === REALTIME_ONLY_TURN_DETECTION
							? {}
							: { auto_truncate: false as const }),
					},
				}
			: {}),
	};
}
