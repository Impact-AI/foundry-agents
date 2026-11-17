import { createHash } from "node:crypto";
import type {
	FieldMapping,
	KnowledgeSource,
	SearchIndex,
	SearchIndexClient,
	SearchIndexer,
	SearchIndexerClient,
	SearchIndexerDataSourceConnection,
	SearchIndexerSkillset,
	SplitSkill,
} from "@azure/search-documents";
import type { FakeBlob } from "@platform/storage/testing";
import {
	setSearchIndexClient,
	setSearchIndexerClient,
	setSearchRestWriter,
} from "../index/client";
import { FIELD } from "../index/definition";
import type { ChunkDocument } from "../index/documents";
import type { KnowledgeBaseBody } from "../knowledge-base/definition";
import type { FakeIndex } from "./fake-search";

/**
 * The indexer stood in for, over the blob store's and the index's own
 * stand-ins: it keeps the definitions the job made, and a run does what the
 * service's would with them — every blob the data source sees that changed
 * since the last run, of an extension the indexer takes, has its metadata
 * mapped through the indexer's own field mappings (`base64Decode` and
 * `jsonArrayToStringCollection` as the service reads them), its text split
 * by the skillset's own split skill settings, and one chunk document
 * projected per page through the skillset's own projection mappings. A blob
 * gone since the last run has its chunks deleted, as deletion detection
 * does. So what a library's `access.json` says reaches `oids` and `groups`
 * on every chunk through the same definitions a deployment runs.
 *
 * Not imitated: cracking (a file's bytes are its text, a picture has none
 * unless `ocr` says what it reads) and embedding (no vector is written).
 */

export interface FakeIndexer {
	index: SearchIndex | null;
	dataSource: SearchIndexerDataSourceConnection | null;
	skillset: SearchIndexerSkillset | null;
	indexer: SearchIndexer | null;
	/** The optional engine's two objects, as the job's `index` step made them; null while the hybrid search answers. */
	knowledgeSource: KnowledgeSource | null;
	knowledgeBase: KnowledgeBaseBody | null;
	/** The URL the base was PUT to, with its version. */
	knowledgeBaseUrl: string | null;
	/** Other bases on the service, by name — what a read finds; a name not here answers 404. */
	otherKnowledgeBases: Set<string>;
	/** Runs started, in order. */
	runs: number;
	resets: number;
	/** Blobs whose next run fails, with the message the service would give. */
	failing: Map<string, string>;
	/** How the next runs end when not a success, as the service names it. */
	endsAs: string | null;
	/** What OCR reads in a picture, by blob name. */
	ocr: Map<string, string>;
	/** The index's definition was deleted: what the job's rebuild does. */
	deleted: string[];
	/**
	 * Whether a blob gone since the last run has its chunks deleted. That
	 * the policy reaches a projection's chunks is the real service's to
	 * show, not this stand-in's; off, a test sees the job's own prune do it alone.
	 */
	detectDeletions: boolean;
	/**
	 * How long after a run ends a search sees what it wrote, as the
	 * service's refresh makes it: 0 writes at once.
	 */
	refreshMs: number;
}

const fromBase64 = (value: string) =>
	Buffer.from(value, "base64").toString("utf8");

/** A mapping function as the service applies it. */
function mapped(mapping: FieldMapping, raw: string | undefined): unknown {
	const fn = mapping.mappingFunction;
	if (raw === undefined) return undefined;
	if (!fn) return raw;
	switch (fn.name) {
		case "base64Decode":
			if (fn.parameters?.useHttpServerUtilityUrlTokenDecode !== false)
				throw new Error("the stand-in decodes only standard base64");
			return fromBase64(raw);
		case "jsonArrayToStringCollection":
			return JSON.parse(raw);
		default:
			throw new Error(`the stand-in has no ${fn.name}`);
	}
}

/** A projected page's key, as the service writes one: `<hash>_<parent key>_pages_<n>`. */
function keyOf(parent: string, n: number): string {
	return `${createHash("sha1").update(parent).digest("hex").slice(0, 12)}_${parent}_pages_${n}`;
}

/** The split skill's pages: fixed windows, each repeating the end of the one before. */
function pages(text: string, max: number, overlap: number): string[] {
	if (!text) return [];
	const out: string[] = [];
	for (let at = 0; at < text.length; at += max - overlap) {
		out.push(text.slice(at, at + max));
		if (at + max >= text.length) break;
	}
	return out;
}

export function fakeIndexer(store: FakeBlob, index: FakeIndex): FakeIndexer {
	const fake: FakeIndexer = {
		index: null,
		dataSource: null,
		skillset: null,
		indexer: null,
		knowledgeSource: null,
		knowledgeBase: null,
		knowledgeBaseUrl: null,
		otherKnowledgeBases: new Set(),
		runs: 0,
		resets: 0,
		failing: new Map(),
		endsAs: null,
		ocr: new Map(),
		deleted: [],
		detectDeletions: true,
		refreshMs: 0,
	};
	/** What each blob looked like when last read, and the parent key its chunks carry. */
	let seen = new Map<string, { fingerprint: string; parent: string }>();
	let lastResult: Record<string, unknown> | undefined;
	let started = 0;

	const fingerprint = (name: string) => {
		const blob = store.objects.get(name);
		return createHash("sha256")
			.update(JSON.stringify([blob?.contentType, blob?.metadata]))
			.update(blob?.bytes ?? new Uint8Array())
			.digest("hex");
	};

	const dropParent = (parent: string) => {
		for (const [key, doc] of index.documents)
			if (doc.parentId === parent) index.documents.delete(key);
	};

	function run() {
		// What the run writes, applied at once or at the next refresh.
		const writes: (() => void)[] = [];
		const write = (change: () => void) => writes.push(change);
		const indexer = fake.indexer;
		const skillset = fake.skillset;
		if (!indexer || !skillset || !fake.dataSource)
			throw new Error("the indexer has not been made");
		const container = fake.dataSource.container.name;
		const extensions = String(
			indexer.parameters?.configuration?.indexedFileNameExtensions ?? "",
		).split(",");
		const split = skillset.skills.find(
			(s) => s.odatatype === "#Microsoft.Skills.Text.SplitSkill",
		) as SplitSkill;
		const [selector] = skillset.indexProjection?.selectors ?? [];
		if (!selector) throw new Error("the skillset projects nothing");

		const errors: { key: string; errorMessage: string; statusCode: number }[] =
			[];
		let itemCount = 0;
		const present = new Set(store.objects.keys());
		for (const [name, read] of seen)
			if (!present.has(name)) {
				if (fake.detectDeletions) write(() => dropParent(read.parent));
				seen.delete(name);
			}
		for (const [name, blob] of store.objects) {
			if (!extensions.some((ext) => name.toLowerCase().endsWith(ext))) continue;
			const now = fingerprint(name);
			if (seen.get(name)?.fingerprint === now) continue;
			itemCount++;
			const url = `https://store.blob.core.windows.net/${container}/${name.split("/").map(encodeURIComponent).join("/")}`;
			const failure = fake.failing.get(name);
			if (failure) {
				errors.push({ key: url, errorMessage: failure, statusCode: 400 });
				continue;
			}
			const parent = Buffer.from(url).toString("base64url");
			const document: Record<string, unknown> = {};
			for (const mapping of indexer.fieldMappings ?? [])
				document[mapping.targetFieldName ?? mapping.sourceFieldName] = mapped(
					mapping,
					blob.metadata[mapping.sourceFieldName],
				);
			const text = blob.contentType?.startsWith("image/")
				? (fake.ocr.get(name) ?? "")
				: new TextDecoder().decode(blob.bytes);
			const cut = pages(
				text,
				split.maxPageLength ?? 10_000,
				split.pageOverlapLength ?? 0,
			);
			// A page the file no longer has goes; one it still has is merged.
			const keep = new Set(cut.map((_, n) => keyOf(parent, n)));
			write(() => {
				for (const [key, doc] of index.documents)
					if (doc.parentId === parent && !keep.has(key))
						index.documents.delete(key);
			});
			cut.forEach((page, n) => {
				const projected: Record<string, unknown> = {
					[FIELD.key]: keyOf(parent, n),
					[selector.parentKeyFieldName]: parent,
				};
				for (const mapping of selector.mappings) {
					const source = mapping.source ?? "";
					if (source === selector.sourceContext) projected[mapping.name] = page;
					else if (source.startsWith(`${selector.sourceContext}/`)) continue;
					else
						projected[mapping.name] =
							document[source.replace("/document/", "")];
				}
				const doc = projected as unknown as ChunkDocument;
				// Merged, not replaced, so a chunk keeps the verdict the job wrote
				// on it over text that may have changed. Whether the service
				// keeps it is not assumed by the code under test; this is the
				// case of the two in which a stale verdict could be served.
				write(() =>
					index.documents.set(doc.chunkId, {
						...index.documents.get(doc.chunkId),
						...doc,
					}),
				);
			});
			seen.set(name, { fingerprint: now, parent });
		}
		const refresh = () => {
			for (const change of writes) change();
		};
		if (fake.refreshMs > 0) setTimeout(refresh, fake.refreshMs);
		else refresh();
		started += 1;
		lastResult = {
			status: fake.endsAs ?? "success",
			startTime: new Date(started * 1000),
			endTime: new Date(started * 1000 + 1),
			errors,
			warnings: [],
			itemCount,
			failedItemCount: errors.length,
		};
	}

	setSearchIndexClient({
		async getIndex(name: string) {
			if (!fake.index || fake.index.name !== name)
				throw Object.assign(new Error("not found"), { statusCode: 404 });
			return fake.index;
		},
		async createOrUpdateIndex(definition: SearchIndex) {
			fake.index = definition;
			return definition;
		},
		async deleteIndex(name: string) {
			// The service refuses to delete an index a knowledge source names.
			const source = fake.knowledgeSource;
			if (
				source &&
				"searchIndexParameters" in source &&
				source.searchIndexParameters.searchIndexName === name
			)
				throw Object.assign(
					new Error(
						`Cannot delete index '${name}' because knowledge source(s) '${source.name}' are still referencing it.`,
					),
					{ statusCode: 400 },
				);
			fake.deleted.push(name);
			fake.index = null;
			index.documents.clear();
		},
		async createOrUpdateKnowledgeSource(definition: KnowledgeSource) {
			fake.knowledgeSource = definition;
			return definition;
		},
		async getKnowledgeBase(name: string) {
			if (fake.knowledgeBase?.name === name) return fake.knowledgeBase;
			if (fake.otherKnowledgeBases.has(name)) return { name };
			throw Object.assign(new Error("not found"), { statusCode: 404 });
		},
		// The SDK's deletes answer a name the service does not hold (404) as
		// done, without throwing.
		async deleteKnowledgeBase(name: string) {
			if (fake.knowledgeBase?.name === name) {
				fake.knowledgeBase = null;
				fake.knowledgeBaseUrl = null;
				return;
			}
			fake.otherKnowledgeBases.delete(name);
		},
		async deleteKnowledgeSource(name: string) {
			if (fake.knowledgeSource?.name !== name) return;
			// The service refuses to delete a source a knowledge base names.
			if (fake.knowledgeBase?.knowledgeSources.some((s) => s.name === name))
				throw Object.assign(
					new Error(
						`Cannot delete Knowledge Source '${name}' because Knowledge Base(s) '${fake.knowledgeBase.name}' is still referencing it.`,
					),
					{ statusCode: 400 },
				);
			fake.knowledgeSource = null;
		},
	} as unknown as SearchIndexClient);
	setSearchRestWriter({
		async put(url, body) {
			fake.knowledgeBaseUrl = url;
			fake.knowledgeBase = body as KnowledgeBaseBody;
		},
	});
	setSearchIndexerClient({
		async createOrUpdateDataSourceConnection(
			definition: SearchIndexerDataSourceConnection,
		) {
			fake.dataSource = definition;
			return definition;
		},
		async createOrUpdateSkillset(definition: SearchIndexerSkillset) {
			fake.skillset = definition;
			return definition;
		},
		async createOrUpdateIndexer(definition: SearchIndexer) {
			fake.indexer = definition;
			return definition;
		},
		async resetIndexer() {
			fake.resets++;
			seen = new Map();
		},
		async runIndexer() {
			fake.runs++;
			run();
		},
		async getIndexerStatus(name: string) {
			return { name, status: "running", lastResult, executionHistory: [] };
		},
	} as unknown as SearchIndexerClient);
	return fake;
}
