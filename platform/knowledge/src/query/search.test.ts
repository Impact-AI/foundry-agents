import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { scopedEnv } from "@platform/test-support";
import { resetSearchClients } from "../index/client";
import {
	stagedAccessSettings,
	stagedKnowledgeSettings,
	stagedSettings,
} from "../testing/fake-config";
import { chunk, type FakeHit, fakeSearchClient } from "../testing/fake-search";
import { searchChunks } from "./search";

/**
 * The hybrid request's shape, and what is done to what comes back: the
 * floor, the per-document cap, the served filter and the readers clause.
 * The service is a stand-in that applies the filter as the service does;
 * everything else is real.
 */

let restoreEnv = () => {};
let restoreSettings = stagedSettings({});

beforeEach(() => {
	restoreEnv = scopedEnv({ AZURE_SEARCH_INDEX: undefined });
	restoreSettings = stagedSettings({});
});

afterEach(() => {
	restoreEnv();
	restoreSettings();
	resetSearchClients();
});

/** Answers the hybrid request with `hits`, whatever it asked. */
const staged = (hits: FakeHit[]) => fakeSearchClient(() => hits);

test("one request carries the question as the vector arm's text, the lexical text, the filter, the reranker and the question as semanticQuery", async () => {
	process.env.AZURE_SEARCH_INDEX = "corpus";
	restoreSettings = stagedKnowledgeSettings({
		retrieval: { vectorWeight: 1.5 },
	});
	const fake = staged([]);
	await searchChunks({
		query: "what did the camera see?",
		searchText: '"narrow camera"',
		tags: ["nfc"],
		topK: 4,
	});
	const [request] = fake.searches;
	expect(request?.text).toBe('"narrow camera"');
	expect(request?.options).toMatchObject({
		filter:
			"injection eq false and documentId ne null and tags/any(t: search.in(t, 'nfc', '|'))",
		searchFields: ["title", "summary", "chunk", "tags"],
		top: 40,
		queryType: "semantic",
		semanticSearchOptions: {
			configurationName: "corpus-semantic",
			errorMode: "partial",
			semanticQuery: "what did the camera see?",
		},
		vectorSearchOptions: {
			queries: [
				{
					kind: "text",
					text: "what did the camera see?",
					fields: ["vector"],
					kNearestNeighborsCount: 40,
					weight: 1.5,
				},
			],
		},
	});
	// The readers and the vector stay in the index.
	expect(request?.options.select).not.toContain("oids");
	expect(request?.options.select).not.toContain("vector");
	expect(request?.options.abortSignal).toBeInstanceOf(AbortSignal);
});

test("the same string is not sent twice, candidates stop at the reranker's fifty, and the reranker can be switched off", async () => {
	const fake = staged([]);
	await searchChunks({ query: "q", topK: 20 });
	expect(fake.searches[0]?.options.top).toBe(50);
	const semanticOptions = fake.searches[0]?.options.semanticSearchOptions as
		| Record<string, unknown>
		| undefined;
	expect(semanticOptions?.semanticQuery).toBeUndefined();
	restoreSettings = stagedKnowledgeSettings({
		retrieval: { semanticRanker: false },
	});
	await searchChunks({ query: "q" });
	expect(fake.searches[1]?.options.queryType).toBeUndefined();
	expect(fake.searches[1]?.options.semanticSearchOptions).toBeUndefined();
});

test("the floor cuts on the reranker's score, never on a row that has none; the cap holds one document to its share", async () => {
	restoreSettings = stagedKnowledgeSettings({
		retrieval: { rerankerFloor: 2, maxPerDocument: 1 },
	});
	const of = (documentId: string, n: number) =>
		chunk({ documentId, chunkId: `${documentId}_pages_${n}` });
	staged([
		{ document: of("a", 0), rerankerScore: 3 },
		{ document: of("a", 1), rerankerScore: 2.9 },
		{ document: of("b", 0), rerankerScore: 1.5 },
		{ document: of("c", 0) },
		{ document: of("d", 0), rerankerScore: 2.2 },
	]);
	const hits = await searchChunks({ query: "q", topK: 10 });
	expect(hits.map((h) => h.documentId)).toEqual(["a", "c", "d"]);
	expect(hits[0]).toMatchObject({ rerankerScore: 3, chunkId: "a_pages_0" });
	expect(hits[1]?.rerankerScore).toBeNull();
});

const CALLER = { oid: "p-1", groups: ["g-1"] };

test("a chunk Prompt Shields has not read, or found an attack in, is never returned, whoever asks", async () => {
	const fake = fakeSearchClient();
	for (const doc of [
		chunk({ chunkId: "clean", injection: false }),
		chunk({ chunkId: "unread", injection: null }),
		chunk({ chunkId: "attack", injection: true }),
	])
		fake.documents.set(doc.chunkId, doc);
	expect((await searchChunks({ query: "body" })).map((h) => h.chunkId)).toEqual(
		["clean"],
	);
});

test("with enforcement off the request carries no readers clause, whoever is asking", async () => {
	const fake = staged([]);
	await searchChunks({ query: "q", access: CALLER });
	await searchChunks({ query: "q" });
	for (const request of fake.searches)
		expect(request.options.filter).toBe(
			"injection eq false and documentId ne null",
		);
});

test("with enforcement on the request carries the caller's clause, and the service answers by it", async () => {
	restoreSettings = stagedAccessSettings({ enforceAccessControl: true });
	const fake = fakeSearchClient();
	for (const doc of [
		chunk({ path: "lib/mine.md", groups: ["g-1"], tags: ["nfc"] }),
		chunk({ path: "lib/theirs.md", groups: ["g-9"], tags: ["nfc"] }),
		chunk({ path: "lib/everyone.md", groups: ["all"], tags: ["nfc"] }),
		chunk({ path: "lib/named.md", oids: ["p-1"], groups: [], tags: ["nfc"] }),
		chunk({ path: "lib/untagged.md", groups: ["g-1"] }),
	])
		fake.documents.set(doc.chunkId, doc);
	const hits = await searchChunks({
		query: "q",
		tags: ["nfc"],
		access: CALLER,
	});
	expect(fake.searches[0]?.options.filter).toBe(
		"injection eq false and documentId ne null and (oids/any(t: t eq 'p-1') or groups/any(t: search.in(t, 'g-1|all', '|'))) and tags/any(t: search.in(t, 'nfc', '|'))",
	);
	expect(hits.map((h) => h.path).sort()).toEqual([
		"lib/everyone.md",
		"lib/mine.md",
		"lib/named.md",
	]);
});

test("with enforcement on and nobody asking, nothing is sent and nothing comes back", async () => {
	restoreSettings = stagedAccessSettings({ enforceAccessControl: true });
	const error = spyOn(console, "error").mockImplementation(() => {});
	try {
		const fake = staged([{ document: chunk({}) }]);
		expect(await searchChunks({ query: "q", access: null })).toEqual([]);
		expect(await searchChunks({ query: "q" })).toEqual([]);
		expect(fake.searches).toHaveLength(0);
		expect(error).toHaveBeenCalledTimes(2);
	} finally {
		error.mockRestore();
	}
});

test("the lexical arm never carries an operator, whatever the caller passed; text that was nothing else matches everything and the vector arm ranks", async () => {
	const fake = staged([]);
	await searchChunks({ query: "-refunds *policy* (2024)?" });
	await searchChunks({ query: "what is this", searchText: "+nfc | -headland" });
	await searchChunks({ query: "***" });
	expect(fake.searches.map((s) => s.text)).toEqual([
		"refunds policy 2024",
		"nfc headland",
		"*",
	]);
});
