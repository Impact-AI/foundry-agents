import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { resetBlobService } from "@platform/storage";
import { scopedEnv } from "@platform/test-support";
import { resetSearchClients } from "../index/client";
import { FIELD } from "../index/definition";
import type { ChunkDocument } from "../index/documents";
import { ensurePipeline } from "../pipeline/ensure";
import { listDocuments } from "../query/documents";
import { searchChunks } from "../query/search";
import { resetShield } from "../shield/client";
import { stagedAccessSettings, stagedSettings } from "../testing/fake-config";
import { PLANTED_ATTACK } from "../testing/fake-shield";
import { PIPELINE_ENV, standInKnowledge } from "../testing/index";
import {
	type LibraryLoad,
	loadLibrary,
	refillIndex,
	removeLibrary,
	UNENFORCED_READERS,
} from "./load";
import { MAX_READERS } from "./metadata";

/**
 * A library loaded as the job loads it, through Azure's pipeline as the
 * stand-ins run it: the files described in their blobs' metadata, the
 * indexer mapping that metadata onto every chunk through the definitions
 * the job made, the removed files pruned, Prompt Shields asked. What is
 * asserted is what reaches the index, because that is what a search serves.
 */

let restoreEnv = () => {};
let restoreSettings = () => {};
let k: ReturnType<typeof standInKnowledge>;

beforeEach(async () => {
	restoreEnv = scopedEnv({
		...PIPELINE_ENV,
		AZURE_SEARCH_ENDPOINT: "https://search.test",
		AZURE_SEARCH_INDEX: undefined,
		AZURE_STORAGE_CONTAINER: undefined,
		APP_CONFIG_ENDPOINT: undefined,
	});
	restoreSettings = stagedSettings({});
	k = standInKnowledge();
	await ensurePipeline();
});

afterEach(() => {
	restoreSettings();
	restoreEnv();
	resetSearchClients();
	resetBlobService();
	resetShield();
});

const HANDBOOK = [
	"---",
	"title: Onboarding handbook",
	"summary: The first week, day by day.",
	"tags: [onboarding, people]",
	"---",
	"",
	"## Day one",
	"",
	"Collect your badge at reception.",
	"",
	"![The reception desk](pictures/desk.png)",
].join("\n");

/** The files of a library, put under `<name>/` as the ingest script would. */
function upload(name: string, files: Record<string, string>) {
	for (const [path, text] of Object.entries(files))
		k.store.put(`${name}/${path}`, text, {
			contentType: "application/octet-stream",
		});
}

const chunksOf = (path: string): ChunkDocument[] =>
	[...k.index.documents.values()].filter((d) => d.path === path);

const load = (name: string) => loadLibrary(name, { pollMs: 0 });

test("each file is described in its blob, and the indexer copies that onto every chunk through its own mappings", async () => {
	upload("handbook", {
		"onboarding.md": HANDBOOK,
		"pay review.md":
			"---\ntitle: Pay review — Ölçüm\n---\n\nOffers this quarter.",
		"reports/q3.pdf": "Revenue rose in the third quarter.",
		"pictures/desk.png": "png bytes",
		"access.json": JSON.stringify({
			"pay review.md": { groups: ["people-team"] },
			"*": { groups: ["all"] },
		}),
		"catalog.json": JSON.stringify({
			"reports/q3.pdf": { title: "Third-quarter report", tags: ["finance"] },
		}),
		"notes.rtf": "not a format",
	});
	const loaded = await load("handbook");
	expect(loaded).toMatchObject({
		described: 4,
		unchanged: 0,
		skipped: 1,
		failed: 0,
		pruned: 0,
	});
	expect(loaded.results.find((r) => r.status === "skipped")?.path).toBe(
		"handbook/notes.rtf",
	);

	const [handbook] = chunksOf("handbook/onboarding.md");
	expect(handbook).toMatchObject({
		library: "handbook",
		kind: "document",
		title: "Onboarding handbook",
		summary: "The first week, day by day.",
		tags: ["onboarding", "people"],
		oids: [],
		groups: ["all"],
		injection: false,
	});
	expect(handbook?.chunk).toContain("Collect your badge at reception.");
	expect(handbook?.documentId).toMatch(/^[0-9a-f]{32}$/);
	expect(chunksOf("handbook/pay review.md")[0]).toMatchObject({
		title: "Pay review — Ölçüm",
		groups: ["people-team"],
	});
	expect(chunksOf("handbook/reports/q3.pdf")[0]).toMatchObject({
		title: "Third-quarter report",
		tags: ["finance"],
		groups: ["all"],
	});
	// A picture with no text in it has no chunk; it is described all the same.
	expect(chunksOf("handbook/pictures/desk.png")).toEqual([]);
	expect(k.store.objects.get("handbook/pictures/desk.png")).toMatchObject({
		contentType: "image/png",
		metadata: { kind: "picture", groups: '["all"]' },
	});
	// The manifests describe the library and are never part of it.
	expect(k.store.objects.get("handbook/access.json")?.metadata).toEqual({});
	expect(chunksOf("handbook/access.json")).toEqual([]);
	// Every chunk was read by Prompt Shields before anything could serve it.
	expect(loaded.shield.scanned).toBe(k.index.documents.size);
	for (const doc of k.index.documents.values())
		expect(doc.shieldedHash).toMatch(/^[0-9a-f]{64}$/);
});

test("a second load of an unchanged library describes nothing, the indexer reads nothing, and Prompt Shields is not asked again", async () => {
	upload("handbook", { "onboarding.md": HANDBOOK });
	await load("handbook");
	const asked = k.shield.requests.length;
	const again = await load("handbook");
	expect(again).toMatchObject({ described: 0, unchanged: 1, indexed: 0 });
	expect(again.shield.scanned).toBe(0);
	expect(k.shield.requests).toHaveLength(asked);
});

test("an edited access.json reaches every chunk at the next load, and nothing else is read again", async () => {
	upload("handbook", {
		"onboarding.md": HANDBOOK,
		"access.json": JSON.stringify({ "*": { groups: ["all"] } }),
	});
	await load("handbook");
	upload("handbook", {
		"access.json": JSON.stringify({ "*": { groups: ["staff"] } }),
	});
	const asked = k.shield.requests.length;
	const again = await load("handbook");
	expect(again.described).toBe(1);
	expect(chunksOf("handbook/onboarding.md")[0]?.groups).toEqual(["staff"]);
	// The text did not change, so its verdict stands.
	expect(k.shield.requests).toHaveLength(asked);
});

test("readers that nothing enforces are said: a load counts the files that leave somebody out while access control is off, and none once it is on", async () => {
	const files = {
		"onboarding.md": HANDBOOK,
		"pay.md": "---\ntitle: Pay bands\n---\n\nThe bands.",
		"access.json": JSON.stringify({
			"pay.md": { groups: ["people-team"] },
			"*": { groups: ["all"] },
		}),
	};
	upload("handbook", files);
	const warned = spyOn(console, "warn").mockImplementation(() => {});
	try {
		// Off, as a new deployment has it: the readers are recorded and held by nothing.
		const open = await load("handbook");
		expect(open.unenforced).toBe(1);
		// A restricted file the indexer fails is counted: its blob carries the
		// readers and its earlier chunks stay, since nothing is pruned past a
		// failure. One whose own description failed carries none, and is not.
		upload("handbook", {
			...files,
			"pay.md": "---\ntitle: Pay bands\n---\n\nThe bands, revised.",
			"typo.md": "---\ntitel: Typo\n---\n\nNot for all.",
			"access.json": JSON.stringify({
				"pay.md": { groups: ["people-team"] },
				"typo.md": { groups: ["people-team"] },
				"*": { groups: ["all"] },
			}),
		});
		k.indexer.failing.set("handbook/pay.md", "Could not crack it");
		const failing = await load("handbook");
		expect(
			failing.results
				.filter((r) => r.status === "failed")
				.map((r) => r.path)
				.sort(),
		).toEqual(["handbook/pay.md", "handbook/typo.md"]);
		expect(failing.unenforced).toBe(1);
		k.indexer.failing.delete("handbook/pay.md");
		upload("handbook", files);
		k.store.objects.delete("handbook/typo.md");
		expect(chunksOf("handbook/pay.md")[0]?.groups).toEqual(["people-team"]);
		expect(warned.mock.calls.flat().join(" ")).toContain(
			"access.enforceAccessControl",
		);
		// In capitals, at the start of the line, where an operator reading the job's log sees it.
		expect(warned.mock.calls.flat().join(" ")).toContain(
			`[library] ${UNENFORCED_READERS}: 1 file(s) under handbook/`,
		);

		warned.mockClear();
		restoreSettings();
		restoreSettings = stagedAccessSettings({ enforceAccessControl: true });
		const held = await load("handbook");
		expect(held.unenforced).toBe(0);
		expect(warned.mock.calls.flat().join(" ")).not.toContain(
			"access.enforceAccessControl",
		);
	} finally {
		warned.mockRestore();
	}
});

test("with global access off, a file no entry names is readable by nobody, never by everybody", async () => {
	restoreSettings();
	restoreSettings = stagedAccessSettings({ globalDocumentAccess: false });
	upload("handbook", { "onboarding.md": HANDBOOK });
	await load("handbook");
	expect(chunksOf("handbook/onboarding.md")[0]).toMatchObject({
		oids: [],
		groups: [],
	});
});

test("a file gone from the library is pruned by the job itself after a clean run", async () => {
	k.indexer.detectDeletions = false;
	upload("handbook", { "onboarding.md": HANDBOOK, "old.md": "Old text." });
	await load("handbook");
	expect(chunksOf("handbook/old.md")).toHaveLength(1);
	k.store.objects.delete("handbook/old.md");
	const again = await load("handbook");
	expect(again.pruned).toBe(1);
	expect(chunksOf("handbook/old.md")).toEqual([]);
	expect(chunksOf("handbook/onboarding.md")).toHaveLength(1);
});

test("an index whose count would not settle — another load or removal writing beside this one — is a warning: the load stands, prunes and scans", async () => {
	k.indexer.detectDeletions = false;
	upload("handbook", { "onboarding.md": HANDBOOK, "old.md": "Old text." });
	await load("handbook");
	k.store.objects.delete("handbook/old.md");
	upload("handbook", { "onboarding.md": `${HANDBOOK}\n\nDay two.` });
	k.index.countFailure = new Error(
		"the index's count of chunks was still changing after 25 minutes",
	);
	const again = await load("handbook");
	expect(again).toMatchObject({ failed: 0, pruned: 1 });
	expect(chunksOf("handbook/old.md")).toEqual([]);
	expect(again.shield.scanned).toBeGreaterThan(0);
	expect(chunksOf("handbook/onboarding.md")[0]?.injection).toBe(false);
});

test("a load in which a file failed reports it by name, loads the rest and deletes nothing", async () => {
	k.indexer.detectDeletions = false;
	upload("handbook", { "onboarding.md": HANDBOOK, "old.md": "Old text." });
	await load("handbook");
	k.store.objects.delete("handbook/old.md");
	upload("handbook", {
		"broken.md": "---\nauthor: me\n---\nBody.",
		"scan.pdf": "%PDF",
	});
	k.indexer.failing.set(
		"handbook/scan.pdf",
		"The document could not be cracked",
	);
	const loaded: LibraryLoad = await load("handbook");
	expect(loaded.failed).toBe(2);
	expect(
		loaded.results
			.filter((r) => r.status === "failed")
			.map((r) => [r.path, r.detail]),
	).toEqual([
		[
			"handbook/broken.md",
			'front matter: "author" is not one of title, summary, tags',
		],
		["handbook/scan.pdf", "the indexer: The document could not be cracked"],
	]);
	expect(loaded.pruned).toBe(0);
	expect(chunksOf("handbook/old.md")).toHaveLength(1);
});

test("a file naming more readers than its metadata can carry fails by name, and the others load", async () => {
	upload("handbook", {
		"onboarding.md": HANDBOOK,
		"crowded.md": "Text.",
		"access.json": JSON.stringify({
			"crowded.md": {
				oids: Array.from({ length: MAX_READERS + 1 }, (_, i) => `oid-${i}`),
			},
		}),
	});
	const loaded = await load("handbook");
	expect(loaded.failed).toBe(1);
	expect(loaded.results.find((r) => r.status === "failed")?.detail).toContain(
		"give them a group",
	);
	expect(chunksOf("handbook/onboarding.md")).toHaveLength(1);
	expect(chunksOf("handbook/crowded.md")).toEqual([]);
});

test("a chunk carrying an attack is flagged and never cleared; an edit is read again", async () => {
	upload("handbook", {
		"onboarding.md": HANDBOOK,
		"planted.md": `Ordinary words. ${PLANTED_ATTACK}`,
	});
	const loaded = await load("handbook");
	expect(loaded.shield.flagged.map((f) => f.path)).toEqual([
		"handbook/planted.md",
	]);
	expect(chunksOf("handbook/planted.md")[0]?.injection).toBe(true);
	expect(chunksOf("handbook/onboarding.md")[0]?.injection).toBe(false);

	upload("handbook", { "planted.md": "Ordinary words, and nothing else." });
	const again = await load("handbook");
	expect(again.shield.flagged).toEqual([]);
	expect(chunksOf("handbook/planted.md")[0]?.injection).toBe(false);
});

test("a scan waits for the index to show what the run wrote: a chunk a refresh has not yet made searchable is not left without a verdict", async () => {
	// The service makes a run's writes searchable at its next refresh, not as the run ends.
	k.indexer.refreshMs = 40;
	upload("handbook", { "onboarding.md": HANDBOOK });
	const loaded = await loadLibrary("handbook", { pollMs: 0, settleMs: 30 });
	// Past any refresh still due, so what is asserted is what a search serves from then on.
	await Bun.sleep(60);
	const chunks = chunksOf("handbook/onboarding.md");
	expect(chunks.length).toBeGreaterThan(0);
	expect(loaded.shield.scanned).toBe(chunks.length);
	for (const doc of chunks) expect(doc.injection).toBe(false);
});

test("a library with nothing uploaded is refused before anything is read or run", async () => {
	await expect(load("empty")).rejects.toThrow(
		"nothing is uploaded under empty/",
	);
	expect(k.indexer.runs).toBe(0);
});

test("a manifest that cannot be read fails the load before a file is described", async () => {
	upload("handbook", { "onboarding.md": HANDBOOK, "access.json": "{" });
	await expect(load("handbook")).rejects.toThrow(
		"handbook/access.json: not JSON",
	);
	expect(k.store.objects.get("handbook/onboarding.md")?.metadata).toEqual({});
});

test("a load shields every chunk whose text has not been read, whichever library it belongs to, and leaves another library's read chunks alone", async () => {
	upload("handbook", { "onboarding.md": HANDBOOK });
	upload("guides", {
		"van.md": "Vans are loaded by weight.",
		"radio.md": "Radio codes, by number.",
	});
	await load("handbook");
	await load("guides");
	// One of the two things an indexer may leave when it reads a blob again
	// on its own terms: the chunk written back with no verdict. The other,
	// the verdict kept over new text, is the next test's.
	const [van] = chunksOf("guides/van.md");
	if (!van) throw new Error("the guide was not indexed");
	k.index.documents.set(van.chunkId, {
		...van,
		injection: null,
		shieldedHash: null,
	});
	const asked = k.shield.requests.length;
	const again = await load("handbook");
	expect(again).toMatchObject({ described: 0, unchanged: 1, indexed: 0 });
	expect(again.shield.scanned).toBe(1);
	expect(k.shield.requests.slice(asked).flat()).toEqual([
		"Vans are loaded by weight.",
	]);
	expect(chunksOf("guides/van.md")[0]).toMatchObject({ injection: false });
	expect(chunksOf("guides/radio.md")[0]).toMatchObject({ injection: false });
});

test("a chunk of another library whose text changed under a kept verdict is read again, never served on the old one", async () => {
	upload("handbook", { "onboarding.md": HANDBOOK });
	upload("guides", { "van.md": "Vans are loaded by weight." });
	await load("handbook");
	await load("guides");
	expect(chunksOf("guides/van.md")[0]).toMatchObject({ injection: false });
	// Edited in place, same metadata: the stand-in's indexer merges the new
	// text over the chunk and keeps the verdict given about the old.
	const described = k.store.objects.get("guides/van.md");
	k.store.put("guides/van.md", `Vans. ${PLANTED_ATTACK}`, {
		contentType: described?.contentType,
		metadata: described?.metadata,
	});
	const again = await load("handbook");
	expect(again.shield.flagged.map((f) => f.path)).toEqual(["guides/van.md"]);
	expect(chunksOf("guides/van.md")[0]).toMatchObject({ injection: true });
});

test("a blob nobody described is indexed by the one indexer and never served", async () => {
	upload("handbook", { "onboarding.md": HANDBOOK });
	k.store.put("stray/notes.md", "Badges are collected at reception.");
	await load("handbook");
	const stray = [...k.index.documents.values()].filter((d) =>
		d.chunk?.includes("Badges are collected"),
	);
	expect(stray).toHaveLength(1);
	// The stand-in's reading of the service: a mapping with no source leaves
	// the field unset. The served filter rests on that, and on nothing else
	// for a blob with no metadata at all.
	expect(stray[0]?.documentId).toBeUndefined();
	const hits = await searchChunks({ query: "badge reception" });
	expect(hits.length).toBeGreaterThan(0);
	expect(hits.every((h) => h.path === "handbook/onboarding.md")).toBe(true);
	expect((await listDocuments(null)).documents.map((c) => c.path)).toEqual([
		"handbook/onboarding.md",
	]);
});

test("an access.json entry naming a path no file has fails the load before a file is described; a pattern may match nothing", async () => {
	upload("handbook", {
		"Reports/Q3.md": "Quarterly figures.",
		"access.json": JSON.stringify({
			"reports/q3.md": { oids: ["boss"] },
			"drafts/**": { groups: ["editors"] },
		}),
	});
	await expect(load("handbook")).rejects.toThrow(
		'handbook/access.json: "reports/q3.md" names no file in the library',
	);
	expect(k.store.objects.get("handbook/Reports/Q3.md")?.metadata).toEqual({});
	expect(k.indexer.runs).toBe(0);
});

test("a run the service did not call a success fails the load whichever files it names; a run that succeeded and failed another library's file does not", async () => {
	upload("handbook", { "onboarding.md": HANDBOOK });
	upload("guides", { "van.md": "Vans are loaded by weight." });
	await load("handbook");
	await load("guides");
	upload("guides", { "van.md": "Vans are loaded by weight, then by size." });
	k.indexer.failing.set("guides/van.md", "Could not crack the document");
	// A file that fails does not end a run: this one succeeded, and the
	// failure is the other library's to hear about.
	expect((await load("handbook")).failed).toBe(0);
	// The same failure in a run that stopped short: what it never reached is
	// unknown, and may be this library's files.
	k.indexer.endsAs = "transientFailure";
	await expect(load("handbook")).rejects.toThrow(
		"the indexer's run did not succeed",
	);
});

test("a run that fails the load is scanned all the same: text it rewrote is not served on the verdict of what it replaced", async () => {
	upload("handbook", {
		"onboarding.md": HANDBOOK,
		"notes.md": "Notes are kept for a year.",
	});
	await load("handbook");
	expect(chunksOf("handbook/notes.md")[0]).toMatchObject({ injection: false });
	// One file edited to carry an attack, its metadata kept, so the
	// stand-in's indexer writes the new text under the old verdict; the
	// other fails, in a run the service does not call a success.
	const described = k.store.objects.get("handbook/notes.md");
	k.store.put("handbook/notes.md", `Notes. ${PLANTED_ATTACK}`, {
		contentType: described?.contentType,
		metadata: described?.metadata,
	});
	upload("handbook", { "onboarding.md": `${HANDBOOK}\n\nDay two.` });
	k.indexer.endsAs = "transientFailure";
	k.indexer.failing.set("handbook/onboarding.md", "Could not crack it");
	await expect(load("handbook")).rejects.toThrow(
		"the indexer's run did not succeed",
	);
	expect(chunksOf("handbook/notes.md")[0]).toMatchObject({ injection: true });
	expect(
		(await searchChunks({ query: "notes" })).map((hit) => hit.path),
	).not.toContain("handbook/notes.md");
});

test("a byte-order mark at the head of a manifest or a Markdown file is not part of its text", async () => {
	const BOM = "\ufeff";
	upload("handbook", {
		"onboarding.md": `${BOM}${HANDBOOK}`,
		"plain.txt": "Plain text.",
		"access.json": `${BOM}${JSON.stringify({ "plain.txt": { oids: ["ada"] } })}`,
		"catalog.json": `${BOM}${JSON.stringify({
			"plain.txt": { title: "The plain one" },
		})}`,
	});
	expect((await load("handbook")).failed).toBe(0);
	expect(chunksOf("handbook/onboarding.md")[0]).toMatchObject({
		title: "Onboarding handbook",
		tags: ["onboarding", "people"],
	});
	expect(chunksOf("handbook/plain.txt")[0]).toMatchObject({
		title: "The plain one",
		oids: ["ada"],
	});
});

test("Prompt Shields failing on another library's chunks withholds them and the load stands; failing on this library's fails it", async () => {
	upload("handbook", { "onboarding.md": HANDBOOK });
	upload("guides", { "van.md": "Vans are loaded by weight." });
	await load("handbook");
	await load("guides");
	const [van] = chunksOf("guides/van.md");
	if (!van) throw new Error("the guide was not indexed");
	// The guide's text changed under its verdict, and Prompt Shields is down.
	k.index.documents.set(van.chunkId, { ...van, chunk: "Vans, rewritten." });
	const scan = k.shield.scan;
	k.shield.scan = async () => {
		throw new Error("Prompt Shields is unavailable");
	};
	const again = await load("handbook");
	expect(again.failed).toBe(0);
	expect(again.shield.withheld).toBe(1);
	expect(chunksOf("guides/van.md")[0]).toMatchObject({
		injection: null,
		shieldedHash: null,
	});
	expect(
		(await searchChunks({ query: "vans" })).map((hit) => hit.path),
	).not.toContain("guides/van.md");
	// The same outage over this library's own text is the load's failure.
	const [page] = chunksOf("handbook/onboarding.md");
	if (!page) throw new Error("the handbook was not indexed");
	k.index.documents.set(page.chunkId, { ...page, chunk: "Day one, again." });
	await expect(load("handbook")).rejects.toThrow(
		"Prompt Shields is unavailable",
	);
	k.shield.scan = scan;
});

test("removing a library deletes its blobs and every chunk it had, and leaves the others alone", async () => {
	upload("handbook", { "onboarding.md": HANDBOOK });
	upload("policies", { "expenses.md": "Expenses." });
	await load("handbook");
	await load("policies");
	expect(await removeLibrary("handbook")).toEqual({ blobs: 1, chunks: 1 });
	expect([...k.store.objects.keys()]).toEqual(["policies/expenses.md"]);
	expect([...k.index.documents.values()].map((d) => d[FIELD.library])).toEqual([
		"policies",
	]);
	expect(await removeLibrary("handbook")).toEqual({ blobs: 0, chunks: 0 });
});

test("an index made again on an upgrade is refilled by the index step itself: every library loaded before is back, scanned, with no load run", async () => {
	upload("handbook", { "onboarding.md": HANDBOOK });
	upload("guides", { "van.md": "Vans are loaded by weight." });
	await load("handbook");
	await load("guides");
	const before = k.index.documents.size;
	// The index as an earlier template made it: its vector field not stored.
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
		expect(k.index.documents.size).toBe(0);
		const refill = await refillIndex({ pollMs: 0 });
		expect(refill.failures).toEqual([]);
		expect(refill.indexed).toBe(2);
		expect(refill.shield.scanned).toBe(before);
	} finally {
		warn.mockRestore();
	}
	expect(k.index.documents.size).toBe(before);
	expect(chunksOf("handbook/onboarding.md")[0]).toMatchObject({
		library: "handbook",
		injection: false,
	});
	expect(chunksOf("guides/van.md")[0]).toMatchObject({ injection: false });
});
