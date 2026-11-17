import { afterEach, beforeEach, expect, test } from "bun:test";
import { scopedEnv } from "@platform/test-support";
import { resetSearchClients } from "../index/client";
import { stagedAccessSettings } from "../testing/fake-config";
import {
	chunk,
	type FakeIndex,
	fakeSearchClient,
} from "../testing/fake-search";
import { compileFilter } from "../testing/odata";
import { knowledgeBaseRetrieveUrl } from "./definition";
import {
	knowledgeBaseSearch,
	referencedChunks,
	resetKnowledgeBaseRetriever,
	retrieveRequest,
	setKnowledgeBaseRetriever,
} from "./search";

let restoreEnv = () => {};
let restoreSettings = () => {};
beforeEach(() => {
	restoreEnv = scopedEnv({
		AZURE_SEARCH_ENDPOINT: "https://svc.search.windows.net",
		AZURE_SEARCH_INDEX: undefined,
		APP_CONFIG_ENDPOINT: undefined,
	});
});
afterEach(() => {
	restoreSettings();
	resetSearchClients();
	resetKnowledgeBaseRetriever();
	restoreEnv();
});

test("the base's retrieve route is on the version the base is written on", () => {
	expect(knowledgeBaseRetrieveUrl()).toBe(
		"https://svc.search.windows.net/knowledgebases/chunks-kb/retrieve?api-version=2026-08-01-preview",
	);
});

test("every effort is a call's on the one base; minimal sends the question as an intent, and above it as a message, extractive, the effort on the call", () => {
	expect(retrieveRequest("what is it?", "minimal")).toEqual({
		intents: [{ type: "semantic", search: "what is it?" }],
		retrievalReasoningEffort: { kind: "minimal" },
	});
	for (const effort of ["low", "medium"] as const)
		expect(retrieveRequest("what is it?", effort)).toEqual({
			messages: [
				{ role: "user", content: [{ type: "text", text: "what is it?" }] },
			],
			outputMode: "extractiveData",
			retrievalReasoningEffort: { kind: effort },
		});
});

test("a readers clause goes on the call as the source's filterAddOn, at every effort; none, no params", () => {
	const clause = "(oids/any(t: t eq 'o'))";
	for (const effort of ["minimal", "low", "medium"] as const) {
		expect(retrieveRequest("q", effort, clause).knowledgeSourceParams).toEqual([
			{
				knowledgeSourceName: "chunks-source",
				kind: "searchIndex",
				filterAddOn: clause,
			},
		]);
		expect(retrieveRequest("q", effort)).not.toHaveProperty(
			"knowledgeSourceParams",
		);
		expect(retrieveRequest("q", effort, null)).not.toHaveProperty(
			"knowledgeSourceParams",
		);
	}
});

/**
 * The base stood in for as the service runs it: it chooses among the
 * index's chunks those its `filterAddOn` admits, in the index's order, and
 * records the filter each call carried.
 */
function filteringBase(index: FakeIndex): (string | null | undefined)[] {
	const filters: (string | null | undefined)[] = [];
	setKnowledgeBaseRetriever({
		async retrieve(_query, _effort, _signal, filter) {
			filters.push(filter);
			const admits = compileFilter(filter ?? undefined);
			return [...index.documents.values()]
				.filter((doc) => admits(doc as unknown as Record<string, unknown>))
				.map((doc) => ({ key: doc.chunkId, rerankerScore: 2 }));
		},
	});
	return filters;
}

test("under enforcement the base is asked with the caller's readers clause, so it never chooses another's chunk, and a reader still gets theirs", async () => {
	restoreSettings = stagedAccessSettings({ enforceAccessControl: true });
	const index = fakeSearchClient();
	index.documents.set(
		"c_board_pages_0",
		chunk({
			chunkId: "c_board_pages_0",
			documentId: "b".repeat(32),
			groups: ["board"],
		}),
	);
	index.documents.set(
		"c_crew_pages_0",
		chunk({
			chunkId: "c_crew_pages_0",
			documentId: "a".repeat(32),
			groups: ["crew"],
		}),
	);
	const filters = filteringBase(index);
	const info = console.info;
	const said: unknown[] = [];
	console.info = (...args: unknown[]) => said.push(...args);
	try {
		const crew = await knowledgeBaseSearch({
			query: "q",
			access: { oid: "o", groups: ["crew"] },
		});
		expect(crew.map((h) => h.chunkId)).toEqual(["c_crew_pages_0"]);
		const board = await knowledgeBaseSearch({
			query: "q",
			access: { oid: "p", groups: ["board"] },
		});
		expect(board.map((h) => h.chunkId)).toEqual(["c_board_pages_0"]);
		// The base chose nothing the caller may not read, so the read-back dropped nothing.
		expect(said.join("\n")).not.toContain("cited_unserved");
	} finally {
		console.info = info;
	}
	expect(filters).toHaveLength(2);
	expect(filters[0]).toStartWith(
		"injection eq false and documentId ne null and (",
	);
	expect(filters[0]).toContain("'o'");
	expect(filters[0]).toContain("'crew");
	expect(filters[0]).not.toContain("board");
	expect(filters[1]).toContain("'p'");
});

test("with enforcement off the base is asked with the served filter alone", async () => {
	restoreSettings = stagedAccessSettings({ enforceAccessControl: false });
	const index = fakeSearchClient();
	index.documents.set(
		"c_board_pages_0",
		chunk({ chunkId: "c_board_pages_0", groups: ["board"] }),
	);
	const filters = filteringBase(index);
	const hits = await knowledgeBaseSearch({
		query: "q",
		access: { oid: "o", groups: ["crew"] },
	});
	expect(hits.map((h) => h.chunkId)).toEqual(["c_board_pages_0"]);
	expect(filters).toEqual(["injection eq false and documentId ne null"]);
});

test("a retrieve answer's references name chunks by key, in order; anything else names nothing", () => {
	// The shape the service answers with: `docKey` is the chunk's key.
	expect(
		referencedChunks({
			response: [{ content: [{ type: "text", text: "[]" }] }],
			references: [
				{
					type: "searchIndex",
					id: "0",
					docKey: "k_pages_1",
					rerankerScore: 3.9,
				},
				{ type: "web", id: "1", url: "https://example.com" },
				{ type: "searchIndex", id: "2", docKey: "" },
				{ type: "searchIndex", id: "3", docKey: "k_pages_0" },
			],
		}),
	).toEqual([
		{ key: "k_pages_1", rerankerScore: 3.9 },
		{ key: "k_pages_0", rerankerScore: null },
	]);
	expect(referencedChunks(null)).toEqual([]);
	expect(referencedChunks({ references: "no" })).toEqual([]);
});

test("under access control the base's choice is read under the readers clause, and a caller nobody verified is refused before the base is asked", async () => {
	restoreSettings = stagedAccessSettings({ enforceAccessControl: true });
	const index = fakeSearchClient();
	index.documents.set(
		"c_mine_pages_0",
		chunk({
			chunkId: "c_mine_pages_0",
			documentId: "a".repeat(32),
			groups: ["crew"],
		}),
	);
	index.documents.set(
		"c_theirs_pages_0",
		chunk({
			chunkId: "c_theirs_pages_0",
			documentId: "b".repeat(32),
			groups: ["board"],
		}),
	);
	const asked: string[] = [];
	setKnowledgeBaseRetriever({
		async retrieve(query, effort) {
			asked.push(`${effort}:${query}`);
			return [
				{ key: "c_theirs_pages_0", rerankerScore: 3 },
				{ key: "c_mine_pages_0", rerankerScore: 2 },
			];
		},
	});
	const original = console.info;
	console.info = () => {};
	try {
		const hits = await knowledgeBaseSearch(
			{ query: "q", access: { oid: "o", groups: ["crew"] } },
			"medium",
		);
		expect(hits.map((h) => h.chunkId)).toEqual(["c_mine_pages_0"]);
		expect(hits[0]?.rerankerScore).toBe(2);

		expect(await knowledgeBaseSearch({ query: "q", access: null })).toEqual([]);
		expect(asked).toEqual(["medium:q"]);
	} finally {
		console.info = original;
	}
});

test("a base that does not answer within the search deadline fails the search, as a slow index does", async () => {
	restoreEnv();
	restoreEnv = scopedEnv({
		AZURE_SEARCH_ENDPOINT: "https://svc.search.windows.net",
		APP_CONFIG_ENDPOINT: undefined,
	});
	fakeSearchClient();
	setKnowledgeBaseRetriever({
		retrieve: (_query, _effort, signal) =>
			new Promise((_resolve, reject) =>
				signal.addEventListener("abort", () => reject(new Error("aborted"))),
			),
	});
	await expect(
		knowledgeBaseSearch({ query: "q", deadlineMs: 20 }),
	).rejects.toThrow("knowledge base did not answer within 20ms");
});

test("a chunk the shield flagged, has not read, or no load described is never chosen by a base that honors the filter", async () => {
	restoreSettings = stagedAccessSettings({ enforceAccessControl: false });
	const index = fakeSearchClient();
	index.documents.set(
		"c_flagged_pages_0",
		chunk({ chunkId: "c_flagged_pages_0", injection: true }),
	);
	index.documents.set(
		"c_unread_pages_0",
		chunk({ chunkId: "c_unread_pages_0", injection: null }),
	);
	index.documents.set(
		"c_stray_pages_0",
		chunk({
			chunkId: "c_stray_pages_0",
			documentId: null as unknown as string,
		}),
	);
	index.documents.set("c_clean_pages_0", chunk({ chunkId: "c_clean_pages_0" }));
	filteringBase(index);
	const info = console.info;
	const said: unknown[] = [];
	console.info = (...args: unknown[]) => said.push(...args);
	try {
		const hits = await knowledgeBaseSearch({ query: "q" });
		expect(hits.map((h) => h.chunkId)).toEqual(["c_clean_pages_0"]);
		expect(said.join("\n")).not.toContain("cited_unserved");
	} finally {
		console.info = info;
	}
});
