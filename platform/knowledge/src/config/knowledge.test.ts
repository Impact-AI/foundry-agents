import { afterEach, expect, spyOn, test } from "bun:test";
import { unreadableConfigStore } from "@platform/config/testing";
import { searchDeadlineMs } from "../query/search";
import { stagedKnowledgeSettings } from "../testing/fake-config";
import {
	DEFAULT_KNOWLEDGE_SETTINGS,
	knowledgeSettings,
	parseKnowledgeSettings,
	resetKnowledgeSettings,
} from "./knowledge";

let restore = () => {};

afterEach(() => {
	restore();
	restore = () => {};
	resetKnowledgeSettings();
});

test("a stored document is merged leaf by leaf: a fraction, a list and a zero where each is allowed, the default elsewhere", () => {
	const settings = parseKnowledgeSettings(
		{
			retrieval: {
				rerankerFloor: 2.5,
				vectorWeight: 0.5,
				semanticRanker: false,
				candidateMultiplier: 4,
			},
			planner: {
				gate: false,
				tagSelectivity: 0.25,
				subjectTags: ["agency", "dispatch"],
				tagsShown: 40,
			},
			indexer: { chunkChars: 1200, overlapChars: 0, ocr: false },
			shield: { batchDocuments: 2 },
		},
		DEFAULT_KNOWLEDGE_SETTINGS,
	);
	expect(settings).toEqual({
		retrieval: {
			engine: "hybrid",
			reasoningEffort: "minimal",
			voiceReasoningEffort: null,
			deadlineMs: 8000,
			voiceDeadlineMs: 8000,
			candidateMultiplier: 4,
			rerankerFloor: 2.5,
			maxPerDocument: 3,
			vectorWeight: 0.5,
			semanticRanker: false,
			tagVocabularyMax: 300,
		},
		planner: {
			enabled: true,
			gate: false,
			tagsShown: 40,
			tagSelectivity: 0.25,
			subjectTags: ["agency", "dispatch"],
		},
		indexer: { chunkChars: 1200, overlapChars: 0, ocr: false, waitMinutes: 25 },
		shield: { batchChars: 10_000, batchDocuments: 2 },
	});
});

test("a leaf of the wrong shape or outside its window keeps the default, so a portal edit can remove no bound", () => {
	const settings = parseKnowledgeSettings(
		{
			retrieval: {
				engine: "foundry",
				// `auto` is the service's, not offered; anything unknown keeps minimal.
				reasoningEffort: "auto",
				voiceReasoningEffort: "high",
				// Zero, unbounded or past a minute: the default bound stands.
				deadlineMs: Infinity,
				voiceDeadlineMs: 0,
				rerankerFloor: 5,
				vectorWeight: 0,
				maxPerDocument: 2.5,
				semanticRanker: "no",
				candidateMultiplier: 0,
			},
			planner: {
				tagSelectivity: 1.5,
				subjectTags: ["ok", 3],
				tagsShown: "many",
				enabled: 0,
			},
			indexer: {
				chunkChars: 50,
				overlapChars: 1.5,
				ocr: 1,
				waitMinutes: 600,
			},
			// Over what one Prompt Shields request may carry.
			shield: { batchChars: 50_000, batchDocuments: 6 },
		},
		DEFAULT_KNOWLEDGE_SETTINGS,
	);
	expect(settings).toEqual(DEFAULT_KNOWLEDGE_SETTINGS);
	expect(
		parseKnowledgeSettings("not a document", DEFAULT_KNOWLEDGE_SETTINGS),
	).toEqual(DEFAULT_KNOWLEDGE_SETTINGS);
	expect(parseKnowledgeSettings(null, DEFAULT_KNOWLEDGE_SETTINGS)).toEqual(
		DEFAULT_KNOWLEDGE_SETTINGS,
	);
});

test("the knowledge base's effort is minimal unless the document names low or medium", () => {
	expect(DEFAULT_KNOWLEDGE_SETTINGS.retrieval.reasoningEffort).toBe("minimal");
	for (const effort of ["low", "medium", "minimal"] as const)
		expect(
			parseKnowledgeSettings(
				{ retrieval: { reasoningEffort: effort } },
				DEFAULT_KNOWLEDGE_SETTINGS,
			).retrieval.reasoningEffort,
		).toBe(effort);
	for (const effort of ["high", "Low", "auto", "", 1, null])
		expect(
			parseKnowledgeSettings(
				{ retrieval: { reasoningEffort: effort } },
				DEFAULT_KNOWLEDGE_SETTINGS,
			).retrieval.reasoningEffort,
		).toBe("minimal");
});

test("a live session's effort is the typed one unless the document names its own, and an invalid one is the typed one again", () => {
	expect(DEFAULT_KNOWLEDGE_SETTINGS.retrieval.voiceReasoningEffort).toBeNull();
	expect(
		parseKnowledgeSettings(
			{ retrieval: { voiceReasoningEffort: "medium" } },
			DEFAULT_KNOWLEDGE_SETTINGS,
		).retrieval.voiceReasoningEffort,
	).toBe("medium");
	for (const effort of ["auto", "Medium", "", 2])
		expect(
			parseKnowledgeSettings(
				{ retrieval: { voiceReasoningEffort: effort } },
				DEFAULT_KNOWLEDGE_SETTINGS,
			).retrieval.voiceReasoningEffort,
		).toBeNull();
});

test("a live session's search deadline is eight seconds unless the document names a whole number from one second to a minute", () => {
	expect(DEFAULT_KNOWLEDGE_SETTINGS.retrieval.voiceDeadlineMs).toBe(8000);
	const read = (value: unknown) =>
		parseKnowledgeSettings(
			{ retrieval: { voiceDeadlineMs: value } },
			DEFAULT_KNOWLEDGE_SETTINGS,
		).retrieval.voiceDeadlineMs;
	expect(read(15_000)).toBe(15_000);
	expect(read(1000)).toBe(1000);
	expect(read(60_000)).toBe(60_000);
	for (const value of [0, -1, 999, 60_001, 2500.5, Infinity, "9000", null])
		expect(read(value)).toBe(8000);
});

test("a typed search's deadline is eight seconds unless the document names a whole number from one second to a minute", () => {
	expect(DEFAULT_KNOWLEDGE_SETTINGS.retrieval.deadlineMs).toBe(8000);
	const read = (value: unknown) =>
		parseKnowledgeSettings(
			{ retrieval: { deadlineMs: value } },
			DEFAULT_KNOWLEDGE_SETTINGS,
		).retrieval.deadlineMs;
	expect(read(15_000)).toBe(15_000);
	expect(read(1000)).toBe(1000);
	expect(read(60_000)).toBe(60_000);
	for (const value of [0, -1, 999, 60_001, 2500.5, Infinity, "9000", null])
		expect(read(value)).toBe(8000);
});

test("the search deadline is the store's, and the compiled-in default when the store cannot be read or names none it accepts", async () => {
	restore = stagedKnowledgeSettings({ retrieval: { deadlineMs: 3000 } });
	expect(await searchDeadlineMs()).toBe(3000);
	restore();
	restore = stagedKnowledgeSettings({ retrieval: { deadlineMs: 0 } });
	expect(await searchDeadlineMs()).toBe(8000);
	restore();
	restore = () => {};
	resetKnowledgeSettings();
	const quiet = spyOn(console, "warn").mockImplementation(() => {});
	const unreadable = unreadableConfigStore();
	try {
		expect(await searchDeadlineMs()).toBe(8000);
	} finally {
		unreadable();
		resetKnowledgeSettings();
		quiet.mockRestore();
	}
});

test("the engine is one of the two named, hybrid unless the document says the other", () => {
	expect(DEFAULT_KNOWLEDGE_SETTINGS.retrieval.engine).toBe("hybrid");
	expect(
		parseKnowledgeSettings(
			{ retrieval: { engine: "knowledgeBase" } },
			DEFAULT_KNOWLEDGE_SETTINGS,
		).retrieval.engine,
	).toBe("knowledgeBase");
	for (const engine of ["KnowledgeBase", "", 1, null])
		expect(
			parseKnowledgeSettings(
				{ retrieval: { engine } },
				DEFAULT_KNOWLEDGE_SETTINGS,
			).retrieval.engine,
		).toBe("hybrid");
});

test("the memo serves the default before a store answers, and what the store says after", async () => {
	expect(await knowledgeSettings()).toEqual(DEFAULT_KNOWLEDGE_SETTINGS);
	restore = stagedKnowledgeSettings({ planner: { enabled: false } });
	const settings = await knowledgeSettings();
	expect(settings.planner.enabled).toBe(false);
	expect(settings.retrieval).toEqual(DEFAULT_KNOWLEDGE_SETTINGS.retrieval);
});

test("an overlap as long as the page is refused with the page it was stored beside, and the default pair stands", () => {
	const defaults = DEFAULT_KNOWLEDGE_SETTINGS;
	expect(
		parseKnowledgeSettings(
			{ indexer: { chunkChars: 400, overlapChars: 400, waitMinutes: 5 } },
			defaults,
		).indexer,
	).toEqual({ ...defaults.indexer, waitMinutes: 5 });
	expect(
		parseKnowledgeSettings(
			{ indexer: { chunkChars: 400, overlapChars: 399 } },
			defaults,
		).indexer,
	).toMatchObject({ chunkChars: 400, overlapChars: 399 });
});
