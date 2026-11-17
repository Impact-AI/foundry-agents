import type { SearchClient } from "@azure/search-documents";
import { setSearchClient } from "../index/client";
import { SEARCH_FIELDS } from "../index/definition";
import type { ChunkDocument } from "../index/documents";
import { compileFilter } from "./odata";

/**
 * The index stood in for at the SDK boundary: it holds chunk documents,
 * records every request's shape, and answers a search the way the service
 * would in everything a test here can observe — the filter applied as the
 * service applies it (`./odata`, which refuses what it cannot read), `select`
 * and `top` honoured, `*` in key order, a text query ranked by how many of
 * its words each document's searchable fields hold (every document, as a
 * hybrid search returns its k best whether or not they match), the tag facet
 * counted. A test whose subject is the request's shape stages its own
 * answer instead.
 */

export interface RecordedSearch {
	text: string | undefined;
	options: Record<string, unknown>;
}

export interface FakeHit {
	document: Partial<ChunkDocument>;
	score?: number;
	rerankerScore?: number;
}

export interface FakeIndex {
	documents: Map<string, ChunkDocument>;
	searches: RecordedSearch[];
	/** Every merge, as sent: what Prompt Shields' verdicts wrote, for one. */
	merges: Partial<ChunkDocument>[][];
	/** Decides the hits for a search; the default is the held documents, as described above. */
	answer: (search: RecordedSearch) => FakeHit[];
	/** What the service answers a count with instead of one: a 404 for a missing index, a 403 for a missing role. */
	countFailure: unknown;
	client: SearchClient<ChunkDocument>;
}

function words(text: string): string[] {
	return text
		.toLowerCase()
		.split(/[^\p{L}\p{N}]+/u)
		.filter(Boolean);
}

function rank(text: string, docs: ChunkDocument[]): FakeHit[] {
	const asked = new Set(words(text));
	const scored = docs.map((document) => {
		const held = SEARCH_FIELDS.flatMap((field) => {
			const value = document[field];
			return words(
				Array.isArray(value) ? value.join(" ") : String(value ?? ""),
			);
		});
		return {
			document,
			score: held.filter((w) => asked.has(w)).length,
		};
	});
	return scored
		.sort(
			(a, b) =>
				b.score - a.score ||
				// A blob nobody described is indexed with no path at all.
				(a.document.path ?? "").localeCompare(b.document.path ?? "") ||
				a.document.chunkId.localeCompare(b.document.chunkId),
		)
		.map(({ document, score }) => ({ document, score }));
}

function project(
	doc: Partial<ChunkDocument>,
	select: unknown,
): Partial<ChunkDocument> {
	if (!Array.isArray(select)) return doc;
	return Object.fromEntries(
		(select as (keyof ChunkDocument)[])
			.filter((field) => field in doc)
			.map((field) => [field, doc[field]]),
	);
}

/** The held documents, as a search over them answers. */
export function heldAnswer(index: FakeIndex): FakeIndex["answer"] {
	return ({ text, options }) => {
		const admits = compileFilter(options.filter as string | undefined);
		const docs = [...index.documents.values()].filter((d) =>
			admits(d as unknown as Record<string, unknown>),
		);
		if (text === "*" || text === undefined)
			return docs
				.sort((a, b) =>
					a.chunkId < b.chunkId ? -1 : a.chunkId > b.chunkId ? 1 : 0,
				)
				.map((document) => ({ document }));
		return rank(text, docs);
	};
}

export function fakeSearchClient(answer?: FakeIndex["answer"]): FakeIndex {
	const fake: FakeIndex = {
		documents: new Map(),
		searches: [],
		merges: [],
		answer: () => [],
		countFailure: null,
		client: undefined as unknown as SearchClient<ChunkDocument>,
	};
	fake.answer = answer ?? heldAnswer(fake);
	fake.client = {
		async search(
			text: string | undefined,
			options: Record<string, unknown> = {},
		) {
			const recorded = { text, options };
			fake.searches.push(recorded);
			const all = fake.answer(recorded);
			const top = typeof options.top === "number" ? options.top : 50;
			const hits = all.slice(0, top);
			const facets: Record<string, { value: unknown; count: number }[]> = {};
			for (const spec of (options.facets as string[] | undefined) ?? []) {
				const [field = "", ...params] = spec.split(",");
				const max = Number(
					params.find((p) => p.startsWith("count:"))?.slice(6) ?? 10,
				);
				const counts = new Map<string, number>();
				for (const { document } of all)
					for (const value of (document[
						field as keyof ChunkDocument
					] as string[]) ?? [])
						counts.set(value, (counts.get(value) ?? 0) + 1);
				facets[field] = [...counts.entries()]
					.sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
					.slice(0, max)
					.map(([value, count]) => ({ value, count }));
			}
			return {
				facets,
				results: (async function* () {
					for (const hit of hits)
						yield {
							document: project(hit.document, options.select) as ChunkDocument,
							score: hit.score ?? 1,
							rerankerScore: hit.rerankerScore,
						};
				})(),
			};
		},
		async getDocumentsCount() {
			if (fake.countFailure) throw fake.countFailure;
			return fake.documents.size;
		},
		async mergeOrUploadDocuments(docs: ChunkDocument[]) {
			for (const doc of docs)
				fake.documents.set(doc.chunkId, {
					...fake.documents.get(doc.chunkId),
					...doc,
				});
			return { results: [] };
		},
		async mergeDocuments(
			docs: (Partial<ChunkDocument> & { chunkId: string })[],
		) {
			fake.merges.push(docs);
			// A merge into a key the index does not hold is that document's
			// refusal, a 404 beside the others' results, as the service answers.
			return {
				results: docs.map((doc) => {
					const held = fake.documents.get(doc.chunkId);
					if (!held)
						return { key: doc.chunkId, succeeded: false, statusCode: 404 };
					fake.documents.set(doc.chunkId, { ...held, ...doc });
					return { key: doc.chunkId, succeeded: true, statusCode: 200 };
				}),
			};
		},
		async deleteDocuments(_key: string, keys: string[]) {
			for (const key of keys) fake.documents.delete(key);
			return { results: [] };
		},
	} as unknown as SearchClient<ChunkDocument>;
	setSearchClient(fake.client);
	return fake;
}

/** A chunk document with every field filled, for a test that holds or stages one. */
export function chunk(overrides: Partial<ChunkDocument>): ChunkDocument {
	const path = overrides.path ?? "lib/doc.md";
	return {
		chunkId: `c_${path}_pages_0`,
		parentId: `p_${path}`,
		documentId: "d".repeat(32),
		path,
		library: path.split("/")[0] ?? "lib",
		kind: "document",
		title: "A document",
		summary: "",
		tags: [],
		chunk: "body",
		oids: [],
		groups: ["all"],
		injection: false,
		shieldedHash: null,
		...overrides,
	};
}
