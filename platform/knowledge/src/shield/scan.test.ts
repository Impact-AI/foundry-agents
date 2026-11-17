import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { resetSearchClients } from "../index/client";
import { mergeChunks } from "../index/writes";
import {
	stagedKnowledgeSettings,
	stagedSettings,
} from "../testing/fake-config";
import {
	chunk,
	type FakeIndex,
	fakeSearchClient,
} from "../testing/fake-search";
import { PLANTED_ATTACK, plantedShield } from "../testing/fake-shield";
import { resetShield } from "./client";
import { shieldChunks, textHash } from "./scan";

/**
 * The scan against the index stand-in: what is read, how it is packed into
 * Prompt Shields' requests, and what is written back.
 */

let restoreSettings = () => {};
let index: FakeIndex;
beforeEach(() => {
	restoreSettings = stagedSettings({});
	index = fakeSearchClient();
});
afterEach(() => {
	restoreSettings();
	resetSearchClients();
	resetShield();
});

function hold(...docs: Parameters<typeof chunk>[0][]) {
	for (const doc of docs) {
		const held = chunk(doc);
		index.documents.set(held.chunkId, held);
	}
}

test("a chunk never read, or read in another version, is read; one whose verdict matches its text is not", async () => {
	const shield = plantedShield();
	hold(
		{ chunkId: "new", chunk: "Fresh text.", injection: null },
		{
			chunkId: "edited",
			chunk: "Edited text.",
			injection: false,
			shieldedHash: textHash("Old text."),
		},
		{
			chunkId: "read",
			chunk: "Read text.",
			injection: false,
			shieldedHash: textHash("Read text."),
		},
		{ chunkId: "bad", chunk: `Text. ${PLANTED_ATTACK}`, injection: null },
	);
	const report = await shieldChunks(null);
	expect(report.scanned).toBe(3);
	expect(report.flagged).toEqual([{ path: "lib/doc.md", chunkId: "bad" }]);
	expect(shield.requests.flat().sort()).toEqual(
		["Edited text.", "Fresh text.", `Text. ${PLANTED_ATTACK}`].sort(),
	);
	expect(index.documents.get("bad")).toMatchObject({
		injection: true,
		shieldedHash: textHash(`Text. ${PLANTED_ATTACK}`),
	});
	expect(index.documents.get("edited")).toMatchObject({
		injection: false,
		shieldedHash: textHash("Edited text."),
	});
	expect(await shieldChunks(null)).toEqual({
		scanned: 0,
		flagged: [],
		withheld: 0,
	});
});

test("requests are packed to the document's limits, and a chunk longer than one is read in pieces, attacked if any piece is", async () => {
	restoreSettings = stagedKnowledgeSettings({
		shield: { batchChars: 1000, batchDocuments: 2 },
	});
	const shield = plantedShield();
	hold(
		{ chunkId: "a", chunk: "a".repeat(400), injection: null },
		{ chunkId: "b", chunk: "b".repeat(400), injection: null },
		{ chunkId: "c", chunk: "c".repeat(400), injection: null },
		{
			chunkId: "long",
			chunk: `${"x".repeat(1500)}${PLANTED_ATTACK}`,
			injection: null,
		},
	);
	const report = await shieldChunks(null);
	for (const request of shield.requests) {
		expect(request.length).toBeLessThanOrEqual(2);
		expect(request.join("").length).toBeLessThanOrEqual(1000);
	}
	expect(report.flagged.map((f) => f.chunkId)).toEqual(["long"]);
	expect(index.documents.get("c")?.injection).toBe(false);
});

test("only the filter's chunks are read", async () => {
	plantedShield();
	hold(
		{ chunkId: "mine", path: "mine/a.md", injection: null },
		{ chunkId: "theirs", path: "theirs/a.md", injection: null },
	);
	expect((await shieldChunks("library eq 'mine'")).scanned).toBe(1);
	expect(index.documents.get("theirs")?.injection).toBeNull();
});

test("a verdict is written only over the text it was given about: a chunk rewritten while it was read has none, and one deleted is left gone", async () => {
	const shield = plantedShield();
	hold(
		{ chunkId: "steady", chunk: "Steady text.", injection: null },
		{
			chunkId: "moved",
			chunk: "First text.",
			injection: false,
			shieldedHash: textHash("Earlier text."),
		},
		{ chunkId: "gone", chunk: "Passing text.", injection: null },
	);
	// Another run of the job, while Prompt Shields is reading.
	const scan = shield.scan;
	shield.scan = async (documents) => {
		const moved = index.documents.get("moved");
		if (moved)
			index.documents.set("moved", { ...moved, chunk: PLANTED_ATTACK });
		index.documents.delete("gone");
		return scan(documents);
	};
	const report = await shieldChunks(null);
	expect(report).toMatchObject({ scanned: 1, withheld: 1 });
	expect(index.documents.get("steady")?.injection).toBe(false);
	// The verdict was about "First text.", which is no longer there.
	expect(index.documents.get("moved")).toMatchObject({
		chunk: PLANTED_ATTACK,
		injection: null,
		shieldedHash: null,
	});
	expect(index.documents.has("gone")).toBe(false);
});

test("with a library named, Prompt Shields failing on another's chunks withdraws their verdicts; with none named, any failure throws", async () => {
	const shield = plantedShield();
	hold({
		chunkId: "theirs",
		path: "theirs/a.md",
		chunk: "New text.",
		injection: false,
		shieldedHash: textHash("Old text."),
	});
	shield.scan = async () => {
		throw new Error("Prompt Shields is unavailable");
	};
	await expect(shieldChunks(null)).rejects.toThrow("unavailable");
	expect(index.documents.get("theirs")?.injection).toBe(false);
	expect(await shieldChunks(null, { library: "mine" })).toEqual({
		scanned: 0,
		flagged: [],
		withheld: 1,
	});
	expect(index.documents.get("theirs")).toMatchObject({
		injection: null,
		shieldedHash: null,
	});
});

test("another library's window that fails says which step failed, and counts none of it as read", async () => {
	const shield = plantedShield();
	const theirs = {
		chunkId: "theirs",
		path: "theirs/a.md",
		chunk: "New text.",
		injection: false,
		shieldedHash: textHash("Old text."),
	};
	const said: string[] = [];
	const warn = spyOn(console, "warn").mockImplementation((line) => {
		said.push(String(line));
	});
	try {
		hold(theirs);
		shield.scan = async () => {
			throw new Error("Prompt Shields is unavailable");
		};
		await shieldChunks(null, { library: "mine" });
		expect(said.at(-1)).toContain("asking Prompt Shields failed");

		// Prompt Shields answers, and the index refuses the verdicts' write once.
		hold(theirs);
		shield.scan = async (texts) => texts.map(() => false);
		const merge = index.client.mergeDocuments.bind(index.client);
		let refused = false;
		index.client.mergeDocuments = (async (
			...args: Parameters<typeof merge>
		) => {
			if (!refused) {
				refused = true;
				throw new Error("the index is throttled");
			}
			return merge(...args);
		}) as typeof merge;
		const report = await shieldChunks(null, { library: "mine" });
		expect(said.at(-1)).toContain("writing the verdicts to the index failed");
		expect(said.at(-1)).not.toContain("asking Prompt Shields");
		expect(report).toEqual({ scanned: 0, flagged: [], withheld: 1 });
	} finally {
		warn.mockRestore();
	}
});

test("a merge into a chunk the index no longer holds names it and is not a failure; any other refusal is", async () => {
	hold({ chunkId: "held", injection: null });
	expect(
		await mergeChunks([
			{ chunkId: "held", injection: false },
			{ chunkId: "deleted", injection: false },
		]),
	).toEqual(["deleted"]);
	expect(index.documents.get("held")?.injection).toBe(false);
	index.client.mergeDocuments = (async () => ({
		results: [
			{ key: "held", succeeded: false, statusCode: 503, errorMessage: "busy" },
		],
	})) as unknown as typeof index.client.mergeDocuments;
	await expect(
		mergeChunks([{ chunkId: "held", injection: true }]),
	).rejects.toThrow('refused a merge into "held" (503): busy');
});
