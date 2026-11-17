import type { Transcriber, VoiceEngine } from "./settings";

/**
 * The managed models a voice agent's version may name (`model_type:
 * "managed"`): models the service runs itself, so no deployment of this
 * account's is needed and none of its quota is spent. A version names one in
 * place of a deployment, and the service derives the architecture from it —
 * speech-to-speech for a realtime model, a cascade for a text model — so a
 * managed model belongs to one engine. Choosing one is opt-in: the `agent`
 * document's default, and every version a deployment makes unasked, is
 * `self_deployed`, on this deployment's own models.
 *
 * The names are the ones Microsoft documents, and only those the service was
 * seen to take at version create and session open: the portal's list in
 * [Configure a voice agent](https://learn.microsoft.com/azure/foundry/agents/how-to/configure-voice-agent)
 * ("Native speech-to-speech models", "Native text models") and the
 * data-zone variants the
 * [Voice Live overview](https://learn.microsoft.com/azure/ai-services/speech-service/voice-live#supported-models-and-regions)
 * lists. `azure-realtime` is left out: it speaks only its own
 * `azure-realtime-native` voices, a family no `voice` document setting names.
 *
 * Each row is everything the rest of the code asks of a model: which engine
 * it is, where the service processes it, the efforts a session may send it,
 * whether it speaks the realtime models' own voices, and the transcribers it
 * is documented with. Validation, the tuning panel and the definition builder
 * read this table and nothing else, because a value the service does not take
 * can make a session run without the version's instructions, guardrails and
 * tools.
 */

/**
 * Where the service processes a managed model's prompts and answers, as
 * [Voice Live region support](https://learn.microsoft.com/azure/ai-services/speech-service/regions?tabs=voice-live#regions)
 * lists it: `global`, in any region Microsoft runs it; `dataZone`, within the
 * data zone of this deployment's region; `byRegion`, the one or the other
 * depending on this deployment's region — the table there says which. Never
 * this deployment's own model deployments, whatever the scope.
 */
export const PROCESSING_SCOPES = ["global", "dataZone", "byRegion"] as const;
export type ProcessingScope = (typeof PROCESSING_SCOPES)[number];

export interface ManagedVoiceModel {
	name: string;
	/** The engine the service runs it as. */
	engine: VoiceEngine;
	scope: ProcessingScope;
	/** The efforts a session may send it; empty: it is sent none. */
	efforts: readonly string[];
	/** Whether it speaks the realtime models' own voices (`OPENAI_VOICES`). */
	openaiVoices: boolean;
	/** The transcribers documented beside it, the one a version takes in place of another first. */
	transcribers: readonly Transcriber[];
}

/** The realtime models' efforts, as the speech-to-speech sessions on a deployment are given them. */
const REALTIME_EFFORTS = ["minimal", "low", "medium", "high", "xhigh"];

/**
 * The transcribers the Voice Live how-to documents beside the realtime
 * models (`mai-transcribe`, and OpenAI's own), and beside a text model
 * (`mai-transcribe`, `azure-speech`): a cascade refuses any other when the
 * session opens.
 */
const REALTIME_TRANSCRIBERS: readonly Transcriber[] = [
	"mai-transcribe",
	"whisper-1",
	"gpt-4o-transcribe",
	"gpt-4o-mini-transcribe",
	"gpt-4o-transcribe-diarize",
];
const CASCADE_TRANSCRIBERS: readonly Transcriber[] = [
	"mai-transcribe",
	"azure-speech",
];

const realtime = (
	name: string,
	scope: ProcessingScope,
	reasons: boolean,
): ManagedVoiceModel => ({
	name,
	engine: "speechToSpeech",
	scope,
	efforts: reasons ? REALTIME_EFFORTS : [],
	openaiVoices: true,
	transcribers: REALTIME_TRANSCRIBERS,
});

const text = (
	name: string,
	efforts: ManagedVoiceModel["efforts"],
): ManagedVoiceModel => ({
	name,
	engine: "cascade",
	// The text models' scope differs from one resource region to the next.
	scope: "byRegion",
	efforts,
	openaiVoices: false,
	transcribers: CASCADE_TRANSCRIBERS,
});

/**
 * The table. The plain realtime names run at global scope in every region
 * that offers them, the `-datazone` ones at data-zone scope. Efforts: the
 * gpt-realtime-2.1 family reasons (minimal to xhigh); gpt-realtime-1.5 and
 * gpt-realtime-mini do not, and refuse one. The text models take their own
 * scale, the chat's efforts a cascade is sent.
 */
export const MANAGED_VOICE_MODELS: readonly ManagedVoiceModel[] = [
	realtime("gpt-realtime-2.1", "global", true),
	realtime("gpt-realtime-2.1-datazone", "dataZone", true),
	realtime("gpt-realtime-2.1-mini", "global", true),
	realtime("gpt-realtime-1.5", "global", false),
	realtime("gpt-realtime-1.5-datazone", "dataZone", false),
	realtime("gpt-realtime-mini", "global", false),
	text("gpt-5.4", ["none", "low", "medium", "high"]),
	text("gpt-5-mini", ["minimal", "low", "medium", "high"]),
	text("gpt-5-nano", ["minimal", "low", "medium", "high"]),
];

/** The managed model of that name, or none. */
export function managedVoiceModel(
	name: string | null | undefined,
): ManagedVoiceModel | null {
	return MANAGED_VOICE_MODELS.find((model) => model.name === name) ?? null;
}

/** The managed models one engine may run, in the table's order. */
export function managedModelsFor(engine: VoiceEngine): ManagedVoiceModel[] {
	return MANAGED_VOICE_MODELS.filter((model) => model.engine === engine);
}

/** The transcriber a managed model's version takes: the one asked for if it is documented beside the model, its first otherwise. */
export function managedTranscriber(
	model: ManagedVoiceModel,
	asked: Transcriber,
): Transcriber {
	return model.transcribers.includes(asked)
		? asked
		: (model.transcribers[0] as Transcriber);
}
