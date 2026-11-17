import {
	afterEach,
	beforeEach,
	expect,
	setSystemTime,
	spyOn,
	test,
} from "bun:test";
import { scopedEnv } from "@platform/test-support";
import { resetSearchClients } from "../index/client";
import {
	stagedAccessSettings,
	stagedKnowledgeSettings,
	stagedSettings,
} from "../testing/fake-config";
import {
	chunk,
	type FakeIndex,
	fakeSearchClient,
} from "../testing/fake-search";
import {
	getTagVocabulary,
	invalidateTagVocabulary,
	keepKnownTags,
} from "./vocabulary";

let restoreEnv = () => {};
let restoreSettings = () => {};

/** Chunks held in the index stand-in, each carrying `tags`, so the facet counts them. */
function hold(fake: FakeIndex, ...docs: Parameters<typeof chunk>[0][]) {
	docs.forEach((overrides, i) => {
		const doc = chunk({ chunkId: `c${i}`, ...overrides });
		fake.documents.set(doc.chunkId, doc);
	});
}

beforeEach(() => {
	restoreEnv = scopedEnv({
		AZURE_SEARCH_ENDPOINT: "https://example.search.windows.net",
	});
	restoreSettings = stagedSettings({});
	invalidateTagVocabulary();
});

afterEach(() => {
	setSystemTime();
	restoreSettings();
	restoreEnv();
	resetSearchClients();
	invalidateTagVocabulary();
});

test("the vocabulary is one facet query over served chunks, capped by the document, memoised across calls", async () => {
	restoreSettings = stagedKnowledgeSettings({
		retrieval: { tagVocabularyMax: 50 },
	});
	const fake = fakeSearchClient();
	hold(
		fake,
		{ tags: ["harbour", "tides"] },
		{ tags: ["harbour", " "] },
		{ tags: ["harbour"] },
		// Not served: the tags of a chunk no model may be handed are no vocabulary.
		{ tags: ["secret"], injection: null },
	);
	expect(await getTagVocabulary()).toEqual([
		{ tag: "harbour", count: 3 },
		{ tag: "tides", count: 1 },
	]);
	await getTagVocabulary();
	expect(fake.searches).toHaveLength(1);
	expect(fake.searches[0]?.options).toMatchObject({
		top: 0,
		filter: "injection eq false and documentId ne null",
		facets: ["tags,count:50"],
	});
});

test("a failed facet keeps the last vocabulary, and no endpoint at all is an empty one", async () => {
	const warn = spyOn(console, "warn").mockImplementation(() => {});
	try {
		const fake = fakeSearchClient();
		hold(fake, { tags: ["a"] });
		expect(await getTagVocabulary()).toEqual([{ tag: "a", count: 1 }]);
		// Past the memo's ten minutes, so the next read is a refresh rather than a hit.
		setSystemTime(new Date(Date.now() + 11 * 60_000));
		fake.answer = () => {
			throw new Error("facet unavailable");
		};
		expect(await getTagVocabulary()).toEqual([{ tag: "a", count: 1 }]);
		expect(warn).toHaveBeenCalledTimes(1);
		delete process.env.AZURE_SEARCH_ENDPOINT;
		expect(await getTagVocabulary()).toEqual([]);
	} finally {
		warn.mockRestore();
	}
});

test("under enforcement the facet carries the caller's readers clause, each clause has its own memo, and nobody is told nothing", async () => {
	restoreSettings = stagedAccessSettings({
		enforceAccessControl: true,
		globalDocumentAccess: false,
	});
	const error = spyOn(console, "error").mockImplementation(() => {});
	try {
		const fake = fakeSearchClient();
		hold(
			fake,
			{ tags: ["harbour"], groups: ["g-staff"] },
			{ tags: ["harbour"], groups: [], oids: ["p-ann"] },
			{ tags: ["payroll"], groups: ["g-people"] },
		);
		const ann = { oid: "p-ann", groups: ["g-staff"] };
		const bob = { oid: "p-bob", groups: [] };
		expect(await getTagVocabulary(ann)).toEqual([{ tag: "harbour", count: 2 }]);
		await getTagVocabulary(ann);
		expect(await getTagVocabulary(bob)).toEqual([]);
		expect(fake.searches.map((s) => s.options.filter)).toEqual([
			"injection eq false and documentId ne null and (oids/any(t: t eq 'p-ann') or groups/any(t: search.in(t, 'g-staff', '|')))",
			"injection eq false and documentId ne null and (oids/any(t: t eq 'p-bob'))",
		]);
		expect(await getTagVocabulary(null)).toEqual([]);
		expect(fake.searches).toHaveLength(2);
	} finally {
		error.mockRestore();
	}
});

test("keepKnownTags case-folds to the index's spelling, de-duplicates, and names the rejects", () => {
	const vocabulary = [
		{ tag: "Harbour", count: 2 },
		{ tag: "tides", count: 1 },
	];
	expect(
		keepKnownTags(
			["harbour", "HARBOUR", " tides ", "moorings", ""],
			vocabulary,
		),
	).toEqual({
		kept: ["Harbour", "tides"],
		dropped: ["moorings"],
	});
});
