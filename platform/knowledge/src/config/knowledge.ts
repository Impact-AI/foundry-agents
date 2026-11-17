import {
	type ConfigKey,
	defineConfigKey,
	envChoice,
	integerBetween,
	type MergeOptions,
	mergeOverDefault,
	nonNegativeInteger,
	numberBetween,
	oneOf,
	positiveInteger,
	processSingleton,
	resetSingleton,
	stringList,
} from "@platform/config";

/**
 * What an operator tunes about retrieval, planning, the indexer and the
 * injection scan, as one document under the `knowledge` key: every knob
 * that shapes what a search returns or what the indexer cuts, rather than
 * how this replica runs. Merged leaf by leaf over the defaults and refusing
 * anything of the wrong shape, so a portal edit can retune a bound and
 * never remove one. The in-flight caps stay environment variables beside
 * the code that reads them: those shape one replica's process, and a
 * process shape is not a document. The search deadlines are here
 * (`retrieval.deadlineMs`, `retrieval.voiceDeadlineMs`): each is a timeout
 * an operator reaches for and weighs against the reasoning effort, live
 * from the next read of the memo.
 */

export const KNOWLEDGE_SETTINGS_KEY = "knowledge";

/**
 * What answers a search, on both channels: `hybrid`, the backend's own
 * query over the index, or `knowledgeBase`, the service's knowledge base over
 * the same index, which the backend asks (`knowledge-base/`).
 */
export const RETRIEVAL_ENGINES = ["hybrid", "knowledgeBase"] as const;
export type RetrievalEngine = (typeof RETRIEVAL_ENGINES)[number];

/**
 * How hard the knowledge base works on one question. `minimal` sends the
 * question as it is, with no model of the base's own; `low` has the base's
 * planning model rewrite it into sub-queries searched in parallel, in one
 * pass; `medium` adds a semantic classifier over what came back and one
 * follow-up pass when it judges the first insufficient. The service's own
 * kinds (Learn, "Set the retrieval reasoning effort"), less `auto`, which
 * chooses for itself between these.
 */
export const KNOWLEDGE_BASE_EFFORTS = ["minimal", "low", "medium"] as const;
export type KnowledgeBaseEffort = (typeof KNOWLEDGE_BASE_EFFORTS)[number];

export interface KnowledgeSettings {
	retrieval: {
		/** Which engine a search runs on, typed or spoken. */
		engine: RetrievalEngine;
		/** The knowledge base's reasoning effort for a typed turn's search, and a live session's unless `voiceReasoningEffort` names one, while `engine` is `knowledgeBase`; above `minimal` it needs the base's planning model. */
		reasoningEffort: KnowledgeBaseEffort;
		/** A live session's effort, in place of `reasoningEffort`; null is `reasoningEffort`. */
		voiceReasoningEffort: KnowledgeBaseEffort | null;
		/** The bound on one search request of a typed turn's, on either engine, and on the tag vocabulary's facet query. */
		deadlineMs: number;
		/** The bound on one search a live session's `knowledgeSearch` runs, on either engine: what a person waits in silence for. */
		voiceDeadlineMs: number;
		/** Candidates pulled before flooring and diversifying, as a multiple of the results asked for; the service reranks at most fifty. */
		candidateMultiplier: number;
		/** The relevance floor on the reranker's 0–4 score, around the service's own "moderately relevant" boundary. */
		rerankerFloor: number;
		/** Results one document may hold, so a long document cannot take every slot. */
		maxPerDocument: number;
		/** The vector arm's weight against the text arm's fixed 1; only the ratio is expressible. */
		vectorWeight: number;
		/** Whether the service's reranker runs; off, the search is vector + BM25 with no score to floor on. */
		semanticRanker: boolean;
		/** Tags the planner is told exist, commonest first; the facet truncates by count. */
		tagVocabularyMax: number;
	};
	planner: {
		/** Off, every question is the fallback plan: byte for byte the search that preceded the planner. */
		enabled: boolean;
		/** Off, every question is planned; on, only one holding something a filter could act on. */
		gate: boolean;
		/** Tags shown to the model, commonest first. */
		tagsShown: number;
		/** How common a tag may be, as a fraction of the commonest tag's count, and still count as signal. */
		tagSelectivity: number;
		/** Tags that name the corpus itself and so carry no intent, beside the product's own. */
		subjectTags: string[];
	};
	indexer: {
		/** The text split skill's page, in characters; about 2000 is roughly 500 tokens. Read when the job makes the skillset. */
		chunkChars: number;
		/** Characters each page repeats from the end of the one before, so a passage cut mid-thought keeps its lead-in. */
		overlapChars: number;
		/** Whether pictures, and the pictures inside documents, are read by OCR: billed per image through the attached account. */
		ocr: boolean;
		/** How long the job waits for one indexer run before it fails the step. */
		waitMinutes: number;
	};
	shield: {
		/** Characters of chunk text in one Prompt Shields request. */
		batchChars: number;
		/** Chunks in one Prompt Shields request. */
		batchDocuments: number;
	};
}

export const DEFAULT_KNOWLEDGE_SETTINGS: KnowledgeSettings = {
	retrieval: {
		engine: "hybrid",
		reasoningEffort: "minimal",
		voiceReasoningEffort: null,
		deadlineMs: 8000,
		voiceDeadlineMs: 8000,
		candidateMultiplier: 10,
		rerankerFloor: 1.9,
		maxPerDocument: 3,
		vectorWeight: 1,
		semanticRanker: true,
		tagVocabularyMax: 300,
	},
	planner: {
		enabled: true,
		gate: true,
		tagsShown: 120,
		tagSelectivity: 0.5,
		subjectTags: [],
	},
	indexer: { chunkChars: 2000, overlapChars: 200, ocr: true, waitMinutes: 25 },
	shield: { batchChars: 10_000, batchDocuments: 5 },
};

/**
 * The defaults for this deployment: the shipped ones, with the retrieval
 * engine the deploy chose (`RETRIEVAL_ENGINE`) when it chose one. What the
 * job seeds and what the memo falls back to.
 */
export function defaultKnowledgeSettings(): KnowledgeSettings {
	const engine = envChoice("RETRIEVAL_ENGINE", RETRIEVAL_ENGINES);
	if (!engine) return DEFAULT_KNOWLEDGE_SETTINGS;
	return {
		...DEFAULT_KNOWLEDGE_SETTINGS,
		retrieval: { ...DEFAULT_KNOWLEDGE_SETTINGS.retrieval, engine },
	};
}

/**
 * A whole number for every count; the two scores are fractions on their own
 * scales; a page has a floor and a ceiling, and a Prompt Shields request the
 * service's own limits.
 */
const ACCEPT: MergeOptions["accept"] = {
	"retrieval.engine": oneOf(RETRIEVAL_ENGINES),
	"retrieval.reasoningEffort": oneOf(KNOWLEDGE_BASE_EFFORTS),
	"retrieval.voiceReasoningEffort": oneOf(KNOWLEDGE_BASE_EFFORTS),
	// A second at least, a minute at most: never unbounded, never zero.
	"retrieval.deadlineMs": integerBetween(1000, 60_000),
	"retrieval.voiceDeadlineMs": integerBetween(1000, 60_000),
	"retrieval.rerankerFloor": numberBetween(0, 4),
	"retrieval.vectorWeight": (value) =>
		typeof value === "number" && Number.isFinite(value) && value > 0,
	"planner.tagSelectivity": (value) =>
		typeof value === "number" && value > 0 && value <= 1,
	"planner.subjectTags": stringList,
	"indexer.chunkChars": integerBetween(300, 8000),
	"indexer.overlapChars": nonNegativeInteger,
	"indexer.waitMinutes": integerBetween(1, 120),
	"shield.batchChars": integerBetween(1000, 10_000),
	"shield.batchDocuments": integerBetween(1, 5),
};

/**
 * The stored document merged over `defaults`; a leaf of the wrong shape
 * keeps the default. One rule spans two leaves: a page's overlap is shorter
 * than the page, since a split that repeats a whole page never advances,
 * so a pair that breaks it is refused together and the default pair stands.
 */
export function parseKnowledgeSettings(
	stored: unknown,
	defaults: KnowledgeSettings,
): KnowledgeSettings {
	const merged = mergeOverDefault(stored, defaults, {
		accept: ACCEPT,
		numbers: positiveInteger,
	});
	if (merged.indexer.overlapChars < merged.indexer.chunkChars) return merged;
	return {
		...merged,
		indexer: {
			...merged.indexer,
			chunkChars: defaults.indexer.chunkChars,
			overlapChars: defaults.indexer.overlapChars,
		},
	};
}

const SINGLETON = "knowledge:settings";

function settingsKey(): ConfigKey<KnowledgeSettings> {
	return processSingleton(SINGLETON, () =>
		defineConfigKey<KnowledgeSettings>({
			key: KNOWLEDGE_SETTINGS_KEY,
			defaultValue: defaultKnowledgeSettings(),
			parse: parseKnowledgeSettings,
		}),
	);
}

/** The current settings, through the memo. Never throws. */
export function knowledgeSettings(): Promise<KnowledgeSettings> {
	return settingsKey().read();
}

/** Forget the memo and its definition, so the next read sees the store afresh. */
export function resetKnowledgeSettings(): void {
	resetSingleton(SINGLETON);
}
