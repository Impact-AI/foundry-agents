import {
	type ConfigKey,
	defineConfigKey,
	envChoice,
	envFlag,
	integerBetween,
	type MergeOptions,
	mergeOverDefault,
	nonNegativeInteger,
	oneOf,
	processSingleton,
	resetSingleton,
} from "@platform/config";
import type { Tier } from "@platform/identity/claims";
import { REASONING_EFFORTS, type ReasoningEffort } from "@platform/llm";
import { problems } from "./keys";
import { managedModelsFor } from "./voice-models";

/**
 * What an operator tunes about the agent, as one document under the `agent`
 * key: the model's reasoning, the per-resource turn bucket, the title
 * buckets, how a turn runs on the Agent Service, where a thread's messages
 * are kept, where what is remembered is kept and how it is written and read, and the voice agent that fronts a live session. Merged field by field over the defaults and refusing
 * anything of the wrong shape, so a portal edit can retune a bound and never
 * remove one. The knobs that shape the process rather than its behaviour —
 * cache TTLs, deadlines — are environment variables beside the code that
 * reads them.
 */

export const AGENT_SETTINGS_KEY = "agent";

export type { ReasoningEffort };

/** How much of its reasoning the model summarises into the stream. */
const REASONING_SUMMARIES = ["auto", "concise", "detailed"] as const;
export type ReasoningSummary = (typeof REASONING_SUMMARIES)[number];

/**
 * The input transcribers a voice agent takes, as `@azure/ai-projects` 2.10.0
 * lists them, less `azure-speech-streaming` (below). Which of them an engine takes is the service's to enforce, and
 * it does so when a session opens, not when the version is made: a cascade
 * refuses one it does not take, and one that runs on a deployment of its own
 * (`gpt-4o-transcribe` and its siblings) fails each transcription until the
 * account has a deployment named after it. The list only keeps a typo out.
 */
export const TRANSCRIBERS = [
	"whisper-1",
	"gpt-realtime-whisper",
	"gpt-4o-transcribe",
	"gpt-4o-mini-transcribe",
	"gpt-4o-transcribe-diarize",
	"gpt-transcribe",
	"gpt-live-transcribe",
	"mai-transcribe",
	"azure-speech",
] as const;
export type Transcriber = (typeof TRANSCRIBERS)[number];

/**
 * The transcribers documented only beside a cascade: Azure Speech, in its
 * two forms. The SDK documents `azure-speech-streaming` as "for cascaded
 * text-model conversations only (not realtime speech-to-speech models)", and
 * the Voice Live how-to lists `azure-speech` for non-multimodal models and
 * agents only. The service takes `azure-speech` in a realtime version and
 * transcribes with it all the same, which no page documents, so a
 * speech-to-speech version keeps to what is documented. The streaming form
 * is not among the transcribers this setting takes, so it cannot be chosen;
 * it is named so the rule holds the day it is.
 */
const CASCADE_ONLY_TRANSCRIBERS: ReadonlySet<string> = new Set([
	"azure-speech",
	"azure-speech-streaming",
]);

/**
 * What a speech-to-speech voice agent transcribes with in place of a
 * transcriber documented only beside a cascade: `mai-transcribe`, which the Voice Live how-to
 * documents for gpt-realtime, gpt-realtime-mini and the cascades alike.
 */
export const SPEECH_TO_SPEECH_TRANSCRIBER: Transcriber = "mai-transcribe";

/**
 * How a live session is answered: `cascade`, the person transcribed, the
 * chat's model answering in text, the text spoken; or `speechToSpeech`, an
 * Azure OpenAI realtime model hearing the person's audio itself and
 * answering, its answer spoken by the version's Azure voice, or in the
 * model's own voice when the session's is an OpenAI one ({@link OPENAI_VOICES}),
 * which takes no fillers. The service derives which from the model a voice
 * agent's version names.
 */
export const VOICE_ENGINES = ["cascade", "speechToSpeech"] as const;
export type VoiceEngine = (typeof VOICE_ENGINES)[number];

/**
 * What a live session's socket is opened on: `agent`, a Foundry voice agent
 * (preview) whose version holds the prompt and tools; `voiceLive`, the
 * Voice Live API (generally available) on a model it hosts, told the same
 * prompt, tools and audio in the session's own update.
 */
const VOICE_RUNTIMES = ["agent", "voiceLive"] as const;
export type VoiceRuntime = (typeof VOICE_RUNTIMES)[number];

/**
 * The OpenAI realtime models' own voices, as the Voice Live API reference
 * (`2026-07-15`, `RealtimeOpenAIVoice`) lists them for a voice of type
 * `openai`: https://learn.microsoft.com/azure/ai-services/speech-service/voice-live-api-reference-2026-07-15
 * Only a realtime model speaks with one, so only speech-to-speech takes it:
 * the cascade refuses it. The service refuses fillers beside one
 * (`interim_response_requires_azure_voice`), and an OpenAI voice gives no
 * word timestamps; `voice_locale` and `prefer_locales` are Azure voices'
 * alone, so the language is the instructions' language directive's to set.
 * Any other name is an Azure voice (`azure-standard`): Azure voice names
 * carry a locale and so a hyphen, which none of these has.
 */
export const OPENAI_VOICES = [
	"alloy",
	"ash",
	"ballad",
	"coral",
	"echo",
	"sage",
	"shimmer",
	"verse",
	"marin",
	"cedar",
] as const;

/** Whether a voice is one of the realtime models' own, which speech-to-speech alone takes. */
export function isOpenAIVoice(voice: string | undefined): boolean {
	return (OPENAI_VOICES as readonly string[]).includes(voice ?? "");
}

/**
 * A reasoning realtime model's efforts, as `@azure/ai-projects` lists
 * `RealtimeReasoningEffort`, and `none`, which sends no effort at all.
 */
export const REALTIME_REASONING_EFFORTS = [
	"none",
	"minimal",
	"low",
	"medium",
	"high",
	"xhigh",
] as const;
export type RealtimeReasoningEffort =
	(typeof REALTIME_REASONING_EFFORTS)[number];

/** How much of the context window a web search may fill: the service's three sizes. */
const SEARCH_CONTEXT_SIZES = ["low", "medium", "high"] as const;
export type SearchContextSize = (typeof SEARCH_CONTEXT_SIZES)[number];

/**
 * The input noise suppression a voice agent's version names, as the Voice
 * Live how-to lists them: the general one, the headset one that keeps the
 * close speaker over background speech, and the personal one that keeps one
 * target speaker. The last two are documented for Voice Live rather than on
 * the voice-agent page. The service makes a version with any type and
 * checks it when a session opens, refusing one outside its own list.
 */
export const NOISE_REDUCTIONS = [
	"azure_deep_noise_suppression",
	"azure_deep_noise_suppression_headset",
	"azure_personal_noise_suppression",
] as const;
export type NoiseReduction = (typeof NOISE_REDUCTIONS)[number];

/** Where what is remembered about a person is kept: the service's store, or this deployment's database. */
export const MEMORY_STORES = ["foundry", "own"] as const;
export type MemoryStoreKind = (typeof MEMORY_STORES)[number];

/** Where a new thread's messages are kept: this deployment's database, or the Agent Service's conversations. */
export const HISTORY_STORES = ["own", "foundry"] as const;
export type HistoryStoreKind = (typeof HISTORY_STORES)[number];

export interface AgentSettings {
	reasoningEffort: ReasoningEffort;
	reasoningSummary: ReasoningSummary;
	/**
	 * The service's web search, in the typed agent's version and in the
	 * backend's own search call for a voice session (`foundry/web-search.ts`).
	 * `contextSize` reaches both; the other two shape only the backend's call,
	 * which answers one spoken question and nothing more.
	 */
	webSearch: {
		contextSize: SearchContextSize;
		/** The longest answer the backend's search call may write. */
		maxOutputTokens: number;
		/** The reasoning effort of that call alone: it searches, it does not deliberate. */
		reasoningEffort: ReasoningEffort;
	};
	/** Turns one resource may start: a burst, refilled per minute. */
	turns: { burst: number; refillPerMinute: number };
	/** Conversation titles the fleet may write per minute. */
	titles: { burst: number; refillPerMinute: number };
	/** Of those, the titles one resource may have written. */
	titlesPerResource: { burst: number; refillPerMinute: number };
	foundry: {
		/** Responses one turn may ask for: each server tool round trip is one. */
		maxSteps: number;
		/** Agent versions the job keeps; older ones are deleted. */
		keepVersions: number;
		/** Items a thread is read back with, at most. */
		maxItemsRead: number;
	};
	/**
	 * Where a thread's messages are kept, and how much of them a turn is
	 * given. `store` decides only where a new thread is made: each thread
	 * records its own (`history/select.ts`), so a change never strands one.
	 * On `own` a turn is given the newest items, at most `maxItems` of them
	 * and `maxChars` of them as JSON, starting at a message of the person's
	 * (`foundry/history.ts`); on `foundry` the service's conversation holds
	 * them and truncates on its own, and the bound shapes only what a live
	 * session is seeded with.
	 */
	history: {
		/** `own`: this deployment's `messages` container; `foundry`: the Agent Service's conversations (`foundry/conversations.ts`). */
		store: HistoryStoreKind;
		maxItems: number;
		maxChars: number;
	};
	/**
	 * What is remembered about a person: which store keeps it, and how it is
	 * written after a turn and read into the next. `store` is read once, at
	 * the host's first use of memory, and holds for the process: a change
	 * takes effect at the next restart, never on a running replica.
	 */
	memory: {
		/** `foundry`: the Agent Service's memory store (preview, `foundry/memory.ts`); `own`: this deployment's `memory` container (`memory/store.ts`). */
		store: MemoryStoreKind;
		/** How long the store waits for more of a conversation before it extracts; a new turn restarts the wait. Both stores. */
		updateDelaySeconds: number;
		/** The remembered statements a turn carries, in characters, newest first. Both stores. */
		maxChars: number;
		/** The longest one statement, written by the extractor or by the person in a correction. Both stores. */
		itemMaxChars: number;
		/** The Foundry store's own options, read only when the job's `agent` step makes it; the own store reads none of them. */
		foundry: {
			/** Whether the store also keeps a summary of each conversation, and turns read it. */
			chatSummary: boolean;
			/** Whether the store keeps how the person wants things done as procedures. */
			procedural: boolean;
			/** How long a statement lives, in seconds; 0 keeps it until it is forgotten. */
			ttlSeconds: number;
		};
	};
	/**
	 * The voice agent (preview) a live session talks to: which engine answers
	 * it, and what its versions are made of beside the product's prompt and
	 * tools. Each engine is a version of its own, because a version fixes
	 * its model: the cascade's names the chat's deployment, so voice reasons
	 * on what a typed turn reasons on; speech-to-speech's names the realtime
	 * deployment (`AZURE_OPENAI_REALTIME_DEPLOYMENT`) — or, where
	 * `managedModel` names one for the engine, a model the service runs
	 * itself. Part of the version, so a change is a new one, made by the next
	 * deploy or the next session.
	 */
	voice: {
		/**
		 * What answers on the socket: a voice agent's version (`agent`), or
		 * Voice Live on a model it hosts (`voiceLive`), which needs no
		 * preview service. With `voiceLive` the model is `managedModel`'s for
		 * the engine, or the first `MANAGED_VOICE_MODELS` lists for it.
		 */
		runtime: VoiceRuntime;
		/** The engine every session runs, unless `engineByTier` names one for the person's tier. */
		engine: VoiceEngine;
		/** Per tier, an engine in place of `engine`; null is `engine`. */
		engineByTier: Record<Tier, VoiceEngine | null>;
		/**
		 * Per engine, a managed model (`MANAGED_VOICE_MODELS` in
		 * `voice-models.ts`) the version names with `model_type: "managed"`
		 * in place of this deployment's own; empty, the default: this
		 * deployment's. The service then processes the person's speech where
		 * the model runs, which may be outside this deployment's region.
		 * Speech-to-speech with a managed model runs without a realtime
		 * deployment.
		 */
		managedModel: Record<VoiceEngine, string>;
		/**
		 * Transcribes the person: before the chat's model reads what they said,
		 * on the cascade; beside the realtime model's own hearing, for the
		 * readable transcript, on speech-to-speech, where one documented only
		 * beside a cascade is replaced by {@link SPEECH_TO_SPEECH_TRANSCRIBER}.
		 */
		transcription: Transcriber;
		/** What the service takes out of the person's audio before it listens. */
		noiseReduction: NoiseReduction;
		/**
		 * The effort a reasoning realtime model (`gpt-realtime-2`,
		 * `gpt-realtime-2.1`) is given on speech-to-speech; `none` sends none.
		 * The cascade reasons with `reasoningEffort`, as a typed turn does.
		 */
		realtimeReasoningEffort: RealtimeReasoningEffort;
	};
}

export const DEFAULT_AGENT_SETTINGS: AgentSettings = {
	reasoningEffort: "low",
	reasoningSummary: "auto",
	// The size the tool documents as its default; the call for a voice session is kept short and quick.
	webSearch: {
		contextSize: "medium",
		maxOutputTokens: 300,
		reasoningEffort: "low",
	},
	turns: { burst: 10, refillPerMinute: 30 },
	titles: { burst: 8, refillPerMinute: 30 },
	titlesPerResource: { burst: 3, refillPerMinute: 6 },
	foundry: { maxSteps: 6, keepVersions: 10, maxItemsRead: 1000 },
	history: { store: "own", maxItems: 200, maxChars: 200_000 },
	memory: {
		store: "foundry",
		updateDelaySeconds: 60,
		maxChars: 4000,
		itemMaxChars: 500,
		foundry: { chatSummary: false, procedural: false, ttlSeconds: 0 },
	},
	voice: {
		// A Foundry voice agent's version, as before the setting existed.
		runtime: "agent",
		// The realtime model hears the person itself, which answers sooner than transcribing first;
		// with no realtime deployment configured, the cascade runs (`foundry/voice-engine.ts`).
		engine: "speechToSpeech",
		engineByTier: { base: null, premium: null },
		// This deployment's own models: a managed one is opt-in.
		managedModel: { cascade: "", speechToSpeech: "" },
		// The one transcriber documented beside both engines, so the fallback to the cascade keeps it.
		transcription: "mai-transcribe",
		// The type Microsoft's own voice-agent sample sends: the close speaker kept over background speech.
		noiseReduction: "azure_deep_noise_suppression_headset",
		realtimeReasoningEffort: "low",
	},
};

/**
 * Whether this deployment keeps its services behind private endpoints with
 * their public listeners off: `PRIVATE_NETWORKING`, which the template sets
 * from the same switch that closes the Foundry account's public access.
 */
function privateNetworking(): boolean {
	return envFlag("PRIVATE_NETWORKING");
}

/**
 * The defaults for this deployment: the shipped ones, except that a private
 * deployment keeps memory in its own store. The Foundry memory store's
 * extraction runs outside the network and calls the account's model over
 * its public endpoint, which a private account refuses; Learn's memory page
 * lists it as a limitation ("Virtual network (VNet) integration isn't
 * supported for memory stores"). The job seeds these, and the memo falls
 * back to them, so a private deployment never names a store that cannot
 * work unless an operator writes it.
 */
export function defaultAgentSettings(): AgentSettings {
	const shipped = DEFAULT_AGENT_SETTINGS;
	// The components the deploy chose (docs/deployment.md, "Choose components at deploy time"); unset is the shipped default.
	const memory =
		envChoice("MEMORY_STORE", MEMORY_STORES) ??
		(privateNetworking() ? "own" : shipped.memory.store);
	const history = envChoice("HISTORY_STORE", HISTORY_STORES);
	const engine = envChoice("VOICE_ENGINE", VOICE_ENGINES);
	if (memory === shipped.memory.store && !history && !engine) return shipped;
	return {
		...shipped,
		memory: { ...shipped.memory, store: memory },
		history: { ...shipped.history, store: history ?? shipped.history.store },
		voice: { ...shipped.voice, engine: engine ?? shipped.voice.engine },
	};
}

/**
 * The store a process runs for the one the document names. The Foundry
 * store on a private deployment is refused — reported under a code and
 * logged, once per caller — and the own store runs instead, so a document
 * written before the deployment went private, or a later portal edit,
 * cannot leave memory silently never working. Open, so the job's step
 * and the host's selection apply one rule.
 */
export function memoryStoreFor(
	memory: Pick<AgentSettings["memory"], "store">,
): MemoryStoreKind {
	if (memory.store !== "foundry" || !privateNetworking()) return memory.store;
	problems.report("agent.memory.store_unreachable_private", {});
	console.error(
		"[memory] the document names the Foundry memory store on a private deployment, whose extraction cannot reach the model; running the own store",
	);
	return "own";
}

/**
 * Whether new threads are made on the service's conversations, reported
 * under a code and logged when they are: a warning, never a refusal, that
 * what an API delete removes stays in the service's own storage until its
 * time to live (`docs/limitations.md`). Open, so the job's `agent` step
 * and the host's start apply one rule.
 */
export function historyKeptByService(
	history: Pick<AgentSettings["history"], "store">,
): boolean {
	if (history.store !== "foundry") return false;
	problems.report("agent.history.service_retention", {});
	console.warn(
		"[agent] history.store is foundry: new threads are kept in the Agent Service's conversations, and what a delete removes stays in the service's run state until its time to live",
	);
	return true;
}

/** The engine the document names for a person of `tier`. */
export function voiceEngineForTier(
	voice: Pick<AgentSettings["voice"], "engine" | "engineByTier">,
	tier: Tier,
): VoiceEngine {
	return voice.engineByTier[tier] ?? voice.engine;
}

/** Every engine the document names for some tier, the cascade first. */
export function voiceEnginesNamed(
	voice: Pick<AgentSettings["voice"], "engine" | "engineByTier">,
): VoiceEngine[] {
	const named = new Set(
		(["base", "premium"] as const).map((tier) =>
			voiceEngineForTier(voice, tier),
		),
	);
	return VOICE_ENGINES.filter((engine) => named.has(engine));
}

/**
 * The transcriber an engine's version takes: the document's, except that
 * speech-to-speech is given {@link SPEECH_TO_SPEECH_TRANSCRIBER} in place of
 * one documented only beside a cascade. Pure: who reports the swap
 * is the caller's choice (`foundry/voice-engine.ts`).
 */
export function transcriberFor(
	engine: VoiceEngine,
	transcription: Transcriber,
): Transcriber {
	return transcriberTakenBy(engine, transcription)
		? transcription
		: SPEECH_TO_SPEECH_TRANSCRIBER;
}

/** Whether an engine's version may take a transcriber: speech-to-speech keeps to the documented ones. */
export function transcriberTakenBy(
	engine: VoiceEngine,
	transcription: Transcriber,
): boolean {
	return engine === "cascade" || !CASCADE_ONLY_TRANSCRIBERS.has(transcription);
}

/** Empty, or a managed model of that engine: never a name the service would run another way. */
const managedOf =
	(engine: VoiceEngine) =>
	(value: unknown): boolean =>
		value === "" || managedModelsFor(engine).some((m) => m.name === value);

/** The most any bound may be raised to: past it a stored number is a typo, and a bound that large is none. */
const BOUND_MAX = 1_000_000;
/** Responses one turn may take at most, however the setting is raised: each is a model call the person waits on. */
const MAX_STEPS_MAX = 50;
/** The longest a thread waits for its extraction: a day. */
const UPDATE_DELAY_MAX_SECONDS = 86_400;

/** A whole number for every bound, held under a ceiling; no delay and no expiry are settings, no bound is not. */
const ACCEPT: MergeOptions["accept"] = {
	reasoningEffort: oneOf(REASONING_EFFORTS),
	reasoningSummary: oneOf(REASONING_SUMMARIES),
	"webSearch.contextSize": oneOf(SEARCH_CONTEXT_SIZES),
	"webSearch.reasoningEffort": oneOf(REASONING_EFFORTS),
	"history.store": oneOf(HISTORY_STORES),
	"memory.store": oneOf(MEMORY_STORES),
	"memory.updateDelaySeconds": integerBetween(0, UPDATE_DELAY_MAX_SECONDS),
	"foundry.maxSteps": integerBetween(1, MAX_STEPS_MAX),
	"memory.foundry.ttlSeconds": nonNegativeInteger,
	"voice.runtime": oneOf(VOICE_RUNTIMES),
	"voice.engine": oneOf(VOICE_ENGINES),
	"voice.engineByTier.base": oneOf(VOICE_ENGINES),
	"voice.engineByTier.premium": oneOf(VOICE_ENGINES),
	"voice.managedModel.cascade": managedOf("cascade"),
	"voice.managedModel.speechToSpeech": managedOf("speechToSpeech"),
	"voice.transcription": oneOf(TRANSCRIBERS),
	"voice.noiseReduction": oneOf(NOISE_REDUCTIONS),
	"voice.realtimeReasoningEffort": oneOf(REALTIME_REASONING_EFFORTS),
};

export function parseAgentSettings(
	stored: unknown,
	defaults: AgentSettings,
): AgentSettings {
	return mergeOverDefault(stored, defaults, {
		accept: ACCEPT,
		numbers: integerBetween(1, BOUND_MAX),
	});
}

const SINGLETON = "agent:settings";

function settingsKey(): ConfigKey<AgentSettings> {
	return processSingleton(SINGLETON, () =>
		defineConfigKey<AgentSettings>({
			key: AGENT_SETTINGS_KEY,
			defaultValue: defaultAgentSettings(),
			parse: parseAgentSettings,
		}),
	);
}

export function agentSettings(): Promise<AgentSettings> {
	return settingsKey().read();
}

/** What the memo holds now, for a caller that cannot await. */
export function cachedAgentSettings(): AgentSettings {
	return settingsKey().cached();
}

/** Forget the memo, so the next read sees the environment and the store afresh. */
export function resetAgentSettings(): void {
	resetSingleton(SINGLETON);
}
