import { isOpenAIVoice } from "@platform/agent";
import {
	defineConfigKey,
	integerBetween,
	type MergeOptions,
	mergeOverDefault,
	numberBetween,
	oneOf,
	processSingleton,
	resetSingleton,
} from "@platform/config";
import type { ResponseRetryPolicy } from "./broker/response-failure";

/**
 * Every knob this package reads, as one document: compiled-in defaults and
 * the `voice` key in App Configuration merged over them, leaf by leaf,
 * refusing anything of the wrong shape, so a hand edit can retune a bound
 * and never remove one. Live voice needs no deployment of its own: the voice
 * agent is the project's, and the environment names only the project.
 */

const VOICE_SETTINGS_KEY = "voice";

/**
 * How a live session's language reaches the voice agent. `stated`: the person's own choice pins
 * the transcription's language and the voice's accent. `detected`: both are
 * left to the service, over the product's languages — the fallback if the
 * service ignores a session's update, adopted only with a written
 * exception to the rule that a language is stated, not detected.
 */
const LANGUAGE_MODES = ["stated", "detected"] as const;
export type LanguageMode = (typeof LANGUAGE_MODES)[number];

export interface VoiceSettings {
	live: {
		/**
		 * The voice agent's voice per tier: one multilingual Azure voice each,
		 * which speaks every language the product has, so no locale is part of
		 * the choice. Premium buys the HD one.
		 */
		voices: { base: string; premium: string };
		/**
		 * A realtime model's own voice per tier (`OPENAI_VOICES` in
		 * `@platform/agent`), spoken in place of the tier's Azure voice when
		 * that tier runs speech-to-speech, with no fillers, since the service
		 * refuses them beside one. Empty: the Azure voice. On the cascade, which
		 * refuses an OpenAI voice, the Azure voice stands whatever this says.
		 */
		openaiVoices: { base: string; premium: string };
		language: LanguageMode;
		/** How long the person's browser has to answer a stage call before the session is told `not_answered`. */
		stageCallTimeoutMs: number;
		/** How long a replica going away gives its sessions, after saying `restart`, before it closes them. */
		drainGraceMs: number;
		/** How long a session's end waits for the person's last transcripts before the thread is written. */
		settleWaitMs: number;
		/** How long the voice agent has to open its socket and announce the session. */
		connectTimeoutMs: number;
		/** How long the service has to echo the person's update. */
		updateTimeoutMs: number;
		/**
		 * How a response that failed with nothing said is asked again: a rate
		 * limit, a fault of the service's, or a failure with no details, never a
		 * refused request, a content filter or a response cut short. Each ask
		 * counts against the turn's `maxSteps`; once they are spent, the voice
		 * is told once to say it could not answer.
		 */
		responseRetry: ResponseRetryPolicy;
	};
}

export const DEFAULT_VOICE_SETTINGS: VoiceSettings = {
	live: {
		voices: {
			base: "en-US-AvaMultilingualNeural",
			premium: "en-US-Ava:DragonHDLatestNeural",
		},
		openaiVoices: { base: "", premium: "" },
		language: "stated",
		stageCallTimeoutMs: 8_000,
		drainGraceMs: 10_000,
		settleWaitMs: 5_000,
		connectTimeoutMs: 15_000,
		// The echo comes within a second; past this the session opens anyway, and a service that never echoes costs no more.
		updateTimeoutMs: 5_000,
		// The last ask about 3.5 s after the failure: inside the pause a person waits out after "let me check".
		responseRetry: { attempts: 2, backoffMs: 1_000, jitterMs: 500 },
	},
};

/** An Azure voice: never blank, and never an OpenAI one, which the cascade refuses. */
const azureVoice = (value: unknown) =>
	typeof value === "string" && value.trim() !== "" && !isOpenAIVoice(value);

/** Empty, or one of the realtime models' own voices the service lists: never a name it would refuse. */
const openaiVoice = (value: unknown) =>
	value === "" || (typeof value === "string" && isOpenAIVoice(value));

/** A voice is never blank, an OpenAI voice is one the service lists, the language is set one of two ways, and a failed response is asked again within bounds. */
const ACCEPT: MergeOptions["accept"] = {
	"live.voices.base": azureVoice,
	"live.voices.premium": azureVoice,
	"live.openaiVoices.base": openaiVoice,
	"live.openaiVoices.premium": openaiVoice,
	"live.language": oneOf(LANGUAGE_MODES),
	// Bounded, never clamped: an edit can neither loop against a deployment already refusing nor wait longer than anybody would.
	"live.responseRetry.attempts": integerBetween(1, 5),
	"live.responseRetry.backoffMs": numberBetween(1, 10_000),
	"live.responseRetry.jitterMs": numberBetween(0, 5_000),
};

/** The stored document merged over `defaults`; a leaf of the wrong shape keeps the default. */
export function parseVoiceSettings(
	stored: unknown,
	defaults: VoiceSettings = DEFAULT_VOICE_SETTINGS,
): VoiceSettings {
	return mergeOverDefault(stored, defaults, { accept: ACCEPT });
}

const SINGLETON = "voice:settings";

function settingsKey() {
	return processSingleton(SINGLETON, () =>
		defineConfigKey<VoiceSettings>({
			key: VOICE_SETTINGS_KEY,
			defaultValue: DEFAULT_VOICE_SETTINGS,
			parse: parseVoiceSettings,
		}),
	);
}

/** The current settings, through the memo. Never throws. */
export function voiceSettings(): Promise<VoiceSettings> {
	return settingsKey().read();
}

/** What a voice agent's session speaks with: the voices per tier and how its language is set. */
export async function liveVoiceAudio(): Promise<{
	voices: VoiceSettings["live"]["voices"];
	openaiVoices: VoiceSettings["live"]["openaiVoices"];
	language: LanguageMode;
}> {
	const { live } = await voiceSettings();
	return {
		voices: live.voices,
		openaiVoices: live.openaiVoices,
		language: live.language,
	};
}

/** Forget the memo, so the next read sees the store afresh. */
export function resetVoiceSettings(): void {
	resetSingleton(SINGLETON);
}
