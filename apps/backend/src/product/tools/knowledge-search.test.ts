import { afterEach, beforeEach, expect, test } from "bun:test";
import { runInTurnScope, UNSCOPED_TURN } from "@platform/agent/testing";
import {
	resetKnowledgeBaseRetriever,
	resetSearchClients,
	setKnowledgeBaseRetriever,
} from "@platform/knowledge";
import {
	chunk,
	fakeSearchClient,
	stagedKnowledgeSettings,
} from "@platform/knowledge/testing";
import { scopedEnv } from "@platform/test-support";
import { SURFACES } from "../surfaces";
import { knowledgeSearch } from "./knowledge-search";

/**
 * The one decision both channels take: `retrieval.engine` names the engine,
 * and this function asks it for a typed turn and a live session alike, at
 * the effort the channel's setting names, a live session's search bound by
 * `retrieval.voiceDeadlineMs`.
 */

let restoreEnv = () => {};
let restoreSettings = () => {};
let asked: string[] = [];
let efforts: string[] = [];

beforeEach(() => {
	restoreEnv = scopedEnv({
		AZURE_SEARCH_ENDPOINT: "https://search.test",
		AZURE_SEARCH_INDEX: undefined,
		APP_CONFIG_ENDPOINT: undefined,
		AZURE_OPENAI_RESOURCE_NAME: "acct",
		AZURE_OPENAI_KNOWLEDGE_BASE_DEPLOYMENT: "knowledge",
		AZURE_OPENAI_KNOWLEDGE_BASE_MODEL: "gpt-5-mini",
	});
	const index = fakeSearchClient();
	index.documents.set(
		"c_depot_pages_0",
		chunk({
			chunkId: "c_depot_pages_0",
			documentId: "a".repeat(32),
			title: "Depot checklist",
			chunk: "The shift lead arrives thirty minutes before the first driver.",
		}),
	);
	asked = [];
	efforts = [];
	setKnowledgeBaseRetriever({
		async retrieve(query, effort) {
			asked.push(query);
			efforts.push(effort);
			return [{ key: "c_depot_pages_0", rerankerScore: 3.9 }];
		},
	});
});

afterEach(() => {
	restoreSettings();
	resetSearchClients();
	resetKnowledgeBaseRetriever();
	restoreEnv();
});

type Result = { passages: { documentId: string }[] };

test("on retrieval.engine knowledgeBase the function asks the knowledge base, and its document is the source", async () => {
	restoreSettings = stagedKnowledgeSettings({
		retrieval: { engine: "knowledgeBase" },
	});
	const result = (await knowledgeSearch.execute({
		query: "When does the shift lead arrive?",
	})) as Result;
	expect(asked).toEqual(["When does the shift lead arrive?"]);
	expect(result.passages.map((p) => p.documentId)).toEqual(["a".repeat(32)]);
	expect(knowledgeSearch.sources?.(result)).toEqual([
		{ id: "a".repeat(32), title: "Depot checklist" },
	]);
});

test("on the hybrid engine the function never asks the knowledge base", async () => {
	restoreSettings = stagedKnowledgeSettings({
		retrieval: { engine: "hybrid" },
	});
	await knowledgeSearch.execute({ query: "arrival" });
	expect(asked).toEqual([]);
});

const live = <T>(fn: () => T): T =>
	runInTurnScope({ ...UNSCOPED_TURN, surface: SURFACES.live }, fn);
const typed = <T>(fn: () => T): T =>
	runInTurnScope({ ...UNSCOPED_TURN, surface: SURFACES.web }, fn);

test("each channel asks at its own effort: a typed turn at reasoningEffort, a live session at voiceReasoningEffort, or the typed one when it names none", async () => {
	restoreSettings = stagedKnowledgeSettings({
		retrieval: {
			engine: "knowledgeBase",
			reasoningEffort: "low",
			voiceReasoningEffort: "medium",
		},
	});
	await typed(() => knowledgeSearch.execute({ query: "arrival" }));
	await live(() => knowledgeSearch.execute({ query: "arrival" }));
	expect(efforts).toEqual(["low", "medium"]);
	restoreSettings();
	restoreSettings = stagedKnowledgeSettings({
		retrieval: { engine: "knowledgeBase", reasoningEffort: "low" },
	});
	await live(() => knowledgeSearch.execute({ query: "arrival" }));
	expect(efforts.at(-1)).toBe("low");
});

test("a live session's search is bounded by voiceDeadlineMs, and a typed turn's is not", async () => {
	restoreSettings = stagedKnowledgeSettings({
		retrieval: { engine: "knowledgeBase", voiceDeadlineMs: 1000 },
	});
	setKnowledgeBaseRetriever({
		retrieve: (_query, _effort, signal) =>
			new Promise((resolve, reject) => {
				const done = setTimeout(
					() => resolve([{ key: "c_depot_pages_0", rerankerScore: 3 }]),
					1300,
				);
				signal.addEventListener("abort", () => {
					clearTimeout(done);
					reject(new Error("aborted"));
				});
			}),
	});
	await expect(
		live(() => knowledgeSearch.execute({ query: "arrival" })),
	).rejects.toThrow("knowledge base did not answer within 1000ms");
	const result = (await typed(() =>
		knowledgeSearch.execute({ query: "arrival" }),
	)) as Result;
	expect(result.passages.map((p) => p.documentId)).toEqual(["a".repeat(32)]);
});
