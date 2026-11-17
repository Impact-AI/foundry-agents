import type {
	TuningBound,
	VoiceResolved,
	VoiceTuning,
	VoiceTuningView,
} from "@/src/backend/voice";
import type { ErrorCode } from "@/src/errors";
import { callRoute, jsonInit, type Send } from "@/src/route-call";

/**
 * Settings → Voice tuning's arithmetic, apart from its drawing: the tuning
 * a change makes, and the call that saves it. A value chosen back to the
 * deployment's own clears the field, so a tuning holds only what differs.
 * Changing the engine clears what depends on it — the model source and the
 * model, an OpenAI voice (speech-to-speech's alone), the transcriber, the
 * turn detection and its timers, the effort — changing the turn detection
 * clears its timers and the noise suppression, changing the model source
 * clears the model, the transcriber and the effort, since a managed model
 * takes its own, and changing a model clears the effort, so a change never
 * saves a value the new model refuses.
 */

export type TuningKey = keyof VoiceTuning;

const DEPENDS_ON: Partial<Record<TuningKey, TuningKey[]>> = {
	engine: [
		"modelSource",
		"managedModel",
		"realtimeModel",
		"transcription",
		"turnDetection",
		"silenceMs",
		"threshold",
		"prefixPaddingMs",
		"reasoningEffort",
	],
	modelSource: [
		"managedModel",
		"realtimeModel",
		"transcription",
		"reasoningEffort",
	],
	managedModel: ["transcription", "reasoningEffort"],
	realtimeModel: ["reasoningEffort"],
	// The noise suppression too: beside `semantic_vad` the headset and personal ones are refused, and the session falls back to one it runs.
	turnDetection: [
		"silenceMs",
		"threshold",
		"prefixPaddingMs",
		"noiseReduction",
	],
};

export function nextTuning(
	tuning: VoiceTuning,
	key: TuningKey,
	value: string | number | boolean | null,
	baseline: VoiceResolved,
	openaiVoices: readonly string[] = [],
): VoiceTuning {
	const next: Record<string, unknown> = { ...tuning };
	for (const dependent of DEPENDS_ON[key] ?? []) delete next[dependent];
	if (
		(key === "engine" || key === "modelSource" || key === "managedModel") &&
		openaiVoices.includes(String(next.voice))
	)
		delete next.voice;
	if (value === null || value === baseline[key]) delete next[key];
	else next[key] = value;
	return next as VoiceTuning;
}

/** A number typed into a timer, held to its bound; null for a blank field. */
export function boundedNumber(raw: string, bound: TuningBound): number | null {
	if (raw.trim() === "") return null;
	const parsed = Number(raw);
	if (!Number.isFinite(parsed)) return null;
	const clamped = Math.min(bound.max, Math.max(bound.min, parsed));
	return bound.integer
		? Math.round(clamped)
		: Number((Math.round(clamped / bound.step) * bound.step).toFixed(2));
}

const ROUTE = "/api/voice/tuning";

export async function saveTuning(
	tuning: VoiceTuning,
	send: Send = fetch,
): Promise<{ view?: VoiceTuningView; code?: ErrorCode }> {
	const answer = await callRoute<VoiceTuningView>(
		send,
		ROUTE,
		jsonInit("PUT", tuning),
	);
	return answer.ok ? { view: answer.body } : { code: answer.code };
}
