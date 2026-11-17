import { envFlag } from "@platform/config";
import type { Tier } from "@platform/identity/claims";
import { problems } from "../keys";
import {
	type AgentSettings,
	SPEECH_TO_SPEECH_TRANSCRIBER,
	transcriberFor,
	type VoiceEngine,
	voiceEngineForTier,
	voiceEnginesNamed,
} from "../settings";
import { type ManagedVoiceModel, managedVoiceModel } from "../voice-models";
import { realtimeDeployment } from "./definition";

/** What a Voice Live session's usage lines name in place of a voice agent. */
export const VOICE_LIVE_RUNTIME = "voice-live";

/**
 * The hosted model each engine runs on through Voice Live when the `agent`
 * document names none, by processing scope. Voice Live region support
 * (`regions?tabs=voice-live`) gives `gpt-realtime-2.1` Global scope and
 * `gpt-realtime-2.1-datazone` Data zone scope wherever each is offered. Of
 * the text models, `gpt-5.4` is Global in Sweden Central and France Central
 * while `gpt-5-mini` is Data zone there, so a hardened deployment's cascade
 * runs on `gpt-5-mini`.
 */
export const VOICE_LIVE_DEFAULT_MODELS = {
	global: { speechToSpeech: "gpt-realtime-2.1", cascade: "gpt-5.4" },
	dataZone: {
		speechToSpeech: "gpt-realtime-2.1-datazone",
		cascade: "gpt-5-mini",
	},
} as const satisfies Record<string, Record<VoiceEngine, string>>;

/**
 * The model a Voice Live session runs on: one Voice Live hosts, since a
 * deployment of this account's own would be bring-your-own-model, which is
 * preview. The `agent` document's managed model for the engine, or else the
 * default for the deployment's mode: data-zone processing where `HARDENED`
 * is on, global otherwise.
 */
export function voiceLiveModel(
	engine: VoiceEngine,
	managed: ManagedVoiceModel | null,
	hardened: boolean = envFlag("HARDENED"),
): ManagedVoiceModel {
	if (managed) return managed;
	const name =
		VOICE_LIVE_DEFAULT_MODELS[hardened ? "dataZone" : "global"][engine];
	const model = managedVoiceModel(name);
	if (!model) throw new Error(`no managed ${engine} model ${name} is listed`);
	return model;
}

/**
 * Which engine answers a live session, failing closed to the cascade. The
 * `agent` document names an engine, per tier if it likes
 * (`settings.ts`); speech-to-speech needs a realtime deployment the template
 * makes only when `models.realtime` is set, or a managed realtime model the
 * document's `voice.managedModel.speechToSpeech` names. Chosen with neither, the cascade
 * runs — never a version naming no model — and the job's `agent` step and
 * the backend's start say so under `agent.voice.speech_to_speech_unconfigured`.
 * Each engine is a version of its own: the service fixes a version's model,
 * so the session's engine is the version its client asks for with
 * `x-agent-version-override`.
 */

type VoiceChoice = Pick<AgentSettings["voice"], "engine" | "engineByTier"> &
	Partial<Pick<AgentSettings["voice"], "managedModel" | "runtime">>;

/**
 * Whether speech-to-speech has a model: on Voice Live always, since it
 * hosts the realtime model; on a voice agent a realtime deployment, or a
 * managed realtime model the document names.
 */
function speechToSpeechHasModel(
	voice: VoiceChoice,
	realtime: string | undefined,
): boolean {
	return Boolean(
		voice.runtime === "voiceLive" ||
			realtime ||
			voice.managedModel?.speechToSpeech,
	);
}

/** The engine that runs for the one chosen: speech-to-speech only with a model to run on. */
function runningVoiceEngine(
	chosen: VoiceEngine,
	voice: VoiceChoice,
	realtime: string | undefined,
): VoiceEngine {
	return chosen === "speechToSpeech" && !speechToSpeechHasModel(voice, realtime)
		? "cascade"
		: chosen;
}

/** The engine a person of `tier` is answered by. */
export function sessionVoiceEngine(
	voice: VoiceChoice,
	tier: Tier,
	realtime: string | undefined = realtimeDeployment(),
): VoiceEngine {
	return runningVoiceEngine(voiceEngineForTier(voice, tier), voice, realtime);
}

/** Every engine some tier is answered by, the cascade first: the versions the job makes. */
export function voiceEnginesRunning(
	voice: VoiceChoice,
	realtime: string | undefined = realtimeDeployment(),
): VoiceEngine[] {
	return [
		...new Set(
			voiceEnginesNamed(voice).map((engine) =>
				runningVoiceEngine(engine, voice, realtime),
			),
		),
	];
}

/**
 * The engines that run, with what the document asked for and did not get
 * reported and logged: speech-to-speech with no model to run on, and a
 * transcriber documented only beside a cascade, which speech-to-speech replaces. Warnings, never
 * refusals: a session is answered either way. The job's `agent` step and
 * the backend's start call it, so it is said once per deploy and per
 * replica rather than per session.
 */
export function reportVoiceEngines(
	voice: AgentSettings["voice"],
	realtime: string | undefined = realtimeDeployment(),
): { running: VoiceEngine[]; notes: string[] } {
	const notes: string[] = [];
	if (
		voiceEnginesNamed(voice).includes("speechToSpeech") &&
		!speechToSpeechHasModel(voice, realtime)
	) {
		problems.report("agent.voice.speech_to_speech_unconfigured", {});
		const note =
			"voice.engine names speechToSpeech but no realtime deployment is configured (AZURE_OPENAI_REALTIME_DEPLOYMENT) and voice.managedModel.speechToSpeech names none: the cascade runs";
		console.error(`[voice] ${note}`);
		notes.push(note);
	}
	const running = voiceEnginesRunning(voice, realtime);
	if (
		running.includes("speechToSpeech") &&
		transcriberFor("speechToSpeech", voice.transcription) !==
			voice.transcription
	) {
		problems.report("agent.voice.transcriber_replaced", {});
		const note = `voice.transcription ${voice.transcription} is documented only beside a cascade: speech-to-speech transcribes with ${SPEECH_TO_SPEECH_TRANSCRIBER}`;
		console.warn(`[voice] ${note}`);
		notes.push(note);
	}
	return { running, notes };
}
