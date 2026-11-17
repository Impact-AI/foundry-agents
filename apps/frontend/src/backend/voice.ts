import { BackendError, backendJson, type Caller } from "./client";

/**
 * Live voice, as this app's server reaches it: whether this environment has
 * it. The session itself is one WebSocket the server hosting this app
 * relays to the backend (`server/relay.ts`), under the caller's assertion;
 * the browser reaches the backend through nothing else.
 */

/** Whether this environment has live voice; read on the server and handed down. */
export interface VoiceCapability {
	live: boolean;
}

export async function voiceCapability(
	caller: Caller,
): Promise<VoiceCapability> {
	try {
		const { live } = await backendJson<VoiceCapability>(
			caller,
			"/voice/capability",
		);
		return { live: live === true };
	} catch {
		// A backend that cannot say has no voice to offer; the honest gate is a microphone never shown.
		return { live: false };
	}
}

/** A voice tester's tuning of their own sessions, as the backend holds it: each field absent is the deployment's. */
export type VoiceTuning = Partial<{
	engine: string;
	modelSource: string;
	managedModel: string;
	realtimeModel: string;
	voice: string;
	turnDetection: string;
	silenceMs: number;
	threshold: number;
	prefixPaddingMs: number;
	noiseReduction: string;
	transcription: string;
	reasoningEffort: string;
	interimResponses: boolean;
}>;

/** Every control's value as a session runs it; null where the session is not sent one. */
export interface VoiceResolved {
	engine: string;
	/** `deployment`: this deployment's own model; `managed`: one the service runs. */
	modelSource: string;
	managedModel: string | null;
	realtimeModel: string | null;
	voice: string;
	turnDetection: string;
	silenceMs: number | null;
	threshold: number | null;
	prefixPaddingMs: number | null;
	noiseReduction: string;
	transcription: string;
	reasoningEffort: string | null;
	interimResponses: boolean;
}

export interface TuningBound {
	min: number;
	max: number;
	step: number;
	integer: boolean;
}

/** What Settings → Voice tuning draws (`/voice/tuning` on the backend). */
export interface VoiceTuningView {
	tuning: VoiceTuning;
	choices: {
		engines: string[];
		/** Empty: the engine has one source, and the control is not drawn. */
		modelSources: string[];
		/** The engine's managed models, each with where the service processes it. */
		managedModels: {
			name: string;
			scope: "global" | "dataZone" | "byRegion";
		}[];
		realtimeModels: string[];
		voices: string[];
		/** The OpenAI voices among them: speech-to-speech's alone, so none on the cascade. */
		openaiVoices: string[];
		turnDetections: string[];
		noiseReductions: string[];
		transcriptions: string[];
		reasoningEfforts: string[];
		/** False: the voice is an OpenAI one, which speaks with no fillers, so the control is fixed off. */
		interimResponses: boolean;
		bounds: Record<"silenceMs" | "threshold" | "prefixPaddingMs", TuningBound>;
	};
	effective: VoiceResolved;
	baseline: VoiceResolved;
}

/** The panel's view for a voice tester; null for anybody else, whom the backend refuses. */
export async function readVoiceTuning(
	caller: Caller,
): Promise<VoiceTuningView | null> {
	try {
		return await backendJson<VoiceTuningView>(caller, "/voice/tuning");
	} catch (err) {
		if (err instanceof BackendError && err.status === 403) return null;
		throw err;
	}
}

export function saveVoiceTuning(
	caller: Caller,
	tuning: VoiceTuning,
): Promise<VoiceTuningView> {
	return backendJson<VoiceTuningView>(caller, "/voice/tuning", {
		method: "PUT",
		json: tuning,
	});
}
