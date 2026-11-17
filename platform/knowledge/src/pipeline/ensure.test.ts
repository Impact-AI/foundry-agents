import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { resetBlobService } from "@platform/storage";
import { scopedEnv } from "@platform/test-support";
import { resetSearchClients, searchIndexerClient } from "../index/client";
import { FIELD } from "../index/definition";
import { ensureKnowledgeBase } from "../knowledge-base/ensure";
import { stagedSettings } from "../testing/fake-config";
import { chunk } from "../testing/fake-search";
import { PIPELINE_ENV, standInKnowledge } from "../testing/index";
import { ensurePipeline } from "./ensure";

let restoreEnv = () => {};
let restoreSettings = () => {};
beforeEach(() => {
	restoreEnv = scopedEnv({
		...PIPELINE_ENV,
		AZURE_SEARCH_ENDPOINT: "https://svc.search.windows.net",
		AZURE_SEARCH_INDEX: undefined,
		AZURE_STORAGE_CONTAINER: undefined,
		APP_CONFIG_ENDPOINT: undefined,
	});
	restoreSettings = stagedSettings({});
});
afterEach(() => {
	restoreSettings();
	restoreEnv();
	resetSearchClients();
	resetBlobService();
});

test("the index, the data source, the skillset and the indexer are made, each naming the last, and made again unchanged", async () => {
	const k = standInKnowledge();
	expect(await ensurePipeline()).toMatchObject({ rebuilt: false });
	expect(k.indexer.index?.name).toBe("chunks");
	expect(k.indexer.dataSource?.name).toBe("chunks-library");
	expect(k.indexer.skillset?.name).toBe("chunks-skillset");
	expect(k.indexer.indexer).toMatchObject({
		name: "chunks-indexer",
		dataSourceName: "chunks-library",
		skillsetName: "chunks-skillset",
		targetIndexName: "chunks",
	});
	expect(await ensurePipeline()).toMatchObject({ rebuilt: false });
	expect(k.indexer.deleted).toEqual([]);
	expect(k.indexer.resets).toBe(0);
});

test("an index keyed on another field is deleted and made again, and the indexer reset to read every blob", async () => {
	const k = standInKnowledge();
	await ensurePipeline();
	// The previous step's index, keyed on `id`.
	k.indexer.index = {
		name: "chunks",
		fields: [{ name: "id", type: "Edm.String", key: true }],
	};
	k.index.documents.set("old", chunk({ chunkId: "old" }));
	const warn = spyOn(console, "warn").mockImplementation(() => {});
	try {
		expect(await ensurePipeline()).toMatchObject({ rebuilt: true });
	} finally {
		warn.mockRestore();
	}
	expect(k.indexer.deleted).toEqual(["chunks"]);
	expect(k.indexer.resets).toBe(1);
	expect(k.index.documents.size).toBe(0);
	expect(k.indexer.index?.fields.find((f) => "key" in f && f.key)?.name).toBe(
		FIELD.key,
	);
});

test("an index that does not store its vectors is deleted and made again, since every merge would erase them", async () => {
	const k = standInKnowledge();
	await ensurePipeline();
	const index = k.indexer.index as NonNullable<typeof k.indexer.index>;
	k.indexer.index = {
		...index,
		fields: index.fields.map((f) =>
			f.name === FIELD.vector ? { ...f, stored: false } : f,
		),
	};
	const warn = spyOn(console, "warn").mockImplementation(() => {});
	try {
		expect(await ensurePipeline()).toMatchObject({ rebuilt: true });
	} finally {
		warn.mockRestore();
	}
	expect(k.indexer.deleted).toEqual(["chunks"]);
	expect(k.indexer.resets).toBe(1);
	expect(
		k.indexer.index?.fields.find((f) => f.name === FIELD.vector),
	).toMatchObject({ stored: true });
	expect(await ensurePipeline()).toMatchObject({ rebuilt: false });
});

test("a 409 on the data source write is the write already applied; a 500 is still a failure", async () => {
	standInKnowledge();
	const refuse = (statusCode: number) =>
		Promise.reject(
			Object.assign(new Error(`HTTP ${statusCode}`), { statusCode }),
		);
	const write = spyOn(
		searchIndexerClient(),
		"createOrUpdateDataSourceConnection",
	);
	try {
		write.mockReturnValueOnce(refuse(409));
		expect(await ensurePipeline()).toMatchObject({ rebuilt: false });
		write.mockReturnValueOnce(refuse(500));
		await expect(ensurePipeline()).rejects.toMatchObject({ statusCode: 500 });
	} finally {
		write.mockRestore();
	}
});

test("an index the knowledge base's source names is released before it is made again — the service refuses to delete it otherwise — and the next step makes them again", async () => {
	const k = standInKnowledge();
	restoreSettings();
	restoreSettings = stagedSettings({
		knowledge: { retrieval: { engine: "knowledgeBase" } },
	});
	await ensurePipeline();
	await ensureKnowledgeBase();
	expect(k.indexer.knowledgeBase?.name).toBe("chunks-kb");
	const index = k.indexer.index as NonNullable<typeof k.indexer.index>;
	k.indexer.index = {
		...index,
		fields: index.fields.map((f) =>
			f.name === FIELD.vector ? { ...f, stored: false } : f,
		),
	};
	const warn = spyOn(console, "warn").mockImplementation(() => {});
	try {
		expect(await ensurePipeline()).toMatchObject({ rebuilt: true });
	} finally {
		warn.mockRestore();
	}
	expect(k.indexer.deleted).toEqual(["chunks"]);
	expect(k.indexer.knowledgeBase).toBeNull();
	expect(k.indexer.knowledgeSource).toBeNull();
	expect(await ensureKnowledgeBase()).toMatchObject({ made: "chunks-kb" });
	expect(k.indexer.knowledgeSource?.name).toBe("chunks-source");
	expect(k.indexer.knowledgeBase?.name).toBe("chunks-kb");
});
