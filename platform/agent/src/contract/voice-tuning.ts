import type { NoiseReduction, Transcriber, VoiceEngine } from "../settings";

/**
 * What a voice tester may set for their own live sessions, as any host is
 * handed it: the names of the choices and nothing of how a host applies
 * them. A host checks a tuning against what it can serve before a session
 * opens with it.
 */

/** How a session detects the end of a turn unless a tuning says otherwise: in any of the product's languages. */
export const VERSION_TURN_DETECTION = "azure_semantic_vad_multilingual";

/** The detections a voice tester may choose: the default, the other Azure ones, and the realtime models' own. */
export const TURN_DETECTIONS = [
	VERSION_TURN_DETECTION,
	"azure_semantic_vad",
	"server_vad",
	"semantic_vad",
] as const;
export type TurnDetectionType = (typeof TURN_DETECTIONS)[number];

/** Where a session's model comes from: this deployment's own, or the service's managed ones. */
export const MODEL_SOURCES = ["deployment", "managed"] as const;
export type ModelSource = (typeof MODEL_SOURCES)[number];

/** The fields a tuning may hold; any other refuses it. */
export interface VoiceTuning {
	engine?: VoiceEngine;
	modelSource?: ModelSource;
	/** A managed model of the engine, with the managed source. */
	managedModel?: string;
	/** A realtime model this deployment has a deployment of, for speech-to-speech. */
	realtimeModel?: string;
	voice?: string;
	turnDetection?: TurnDetectionType;
	silenceMs?: number;
	threshold?: number;
	prefixPaddingMs?: number;
	noiseReduction?: NoiseReduction;
	transcription?: Transcriber;
	/** The cascade's chat effort, or a reasoning realtime model's. */
	reasoningEffort?: string;
	interimResponses?: boolean;
}
