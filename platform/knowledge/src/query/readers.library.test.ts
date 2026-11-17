import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { resetBlobService } from "@platform/storage";
import { scopedEnv } from "@platform/test-support";
import { resetSearchClients } from "../index/client";
import { loadLibrary } from "../library/load";
import { documentIdOf } from "../library/metadata";
import { ensurePipeline } from "../pipeline/ensure";
import { resetShield } from "../shield/client";
import { stagedSettings } from "../testing/fake-config";
import { PIPELINE_ENV, standInKnowledge } from "../testing/index";
import { readablePicture, readDocument } from "./documents";
import { retrieve } from "./retrieve";

/**
 * Who reads what, end to end: a library whose `access.json` restricts one
 * document to a group, loaded through the pipeline as the job loads it, then
 * searched through the real query code against an index stand-in that
 * applies the filter as the service does. Nothing here builds a filter by
 * hand or stages a hit: the readers reach the chunks through the indexer's
 * mappings, and the clause reaches the index from the caller.
 */

let restoreEnv = () => {};
let restoreSettings = () => {};
let k: ReturnType<typeof standInKnowledge>;

const ANN = {
	oid: "11111111-aaaa-4000-8000-000000000001",
	groups: ["g-people"],
};
const BOB = {
	oid: "22222222-bbbb-4000-8000-000000000002",
	groups: ["g-field"],
};
/** A local sign-in: no Microsoft identity, so no groups and a subject nobody can name. */
const LOCAL = { oid: "local:7d1c", groups: [] };

beforeEach(async () => {
	restoreEnv = scopedEnv({
		...PIPELINE_ENV,
		AZURE_SEARCH_ENDPOINT: "https://search.test",
		AZURE_SEARCH_INDEX: undefined,
		AZURE_STORAGE_CONTAINER: undefined,
		APP_CONFIG_ENDPOINT: undefined,
	});
	restoreSettings = stagedSettings({
		access: { enforceAccessControl: true },
		// The planner's model is not the subject; the filter it rides beside is.
		knowledge: { planner: { enabled: false } },
	});
	k = standInKnowledge();
	await ensurePipeline();
	const files: Record<string, string> = {
		"pay-review.md":
			"---\ntitle: Onboarding pay review\n---\n\n## Offers\n\nThe onboarding offers this quarter.\n\n![The pay bands](pictures/bands.png)",
		"rollout.md":
			"---\ntitle: Field rollout\n---\n\nThe onboarding of drivers to the tablets.",
		"handbook.md":
			"---\ntitle: Onboarding handbook\n---\n\n## Day one\n\nOnboarding starts at reception.\n\n![The desk](pictures/desk.png)",
		"pictures/bands.png": "png",
		"pictures/desk.png": "png",
		"access.json": JSON.stringify({
			"pay-review.md": { groups: ["g-people"] },
			"pictures/bands.png": { groups: ["g-people"] },
			"rollout.md": { groups: ["g-field"] },
			"*": { groups: ["all"] },
		}),
	};
	for (const [path, text] of Object.entries(files))
		k.store.put(`people/${path}`, text);
	const loaded = await loadLibrary("people", { pollMs: 0 });
	expect(loaded.failed).toBe(0);
});

afterEach(() => {
	restoreSettings();
	restoreEnv();
	resetSearchClients();
	resetBlobService();
	resetShield();
});

const titles = async (access: typeof ANN | null) =>
	(await retrieve("onboarding", { access, topK: 10 })).hits
		.map((h) => h.title)
		.sort();

describe("two people in different groups each see only their own group's document", () => {
	test("Ann, in g-people, finds the pay review and not the rollout; Bob, in g-field, the reverse; both find the handbook", async () => {
		expect(await titles(ANN)).toEqual([
			"Onboarding handbook",
			"Onboarding pay review",
		]);
		expect(await titles(BOB)).toEqual(["Field rollout", "Onboarding handbook"]);
	});

	test("the reader opens a document for the person it admits and is the same null for the other, so an id cannot be probed", async () => {
		const [hit] = (await retrieve("pay review", { access: ANN })).hits.filter(
			(h) => h.title === "Onboarding pay review",
		);
		const id = hit?.documentId as string;
		expect((await readDocument(id, ANN))?.sections).toEqual([
			{ heading: "Offers", text: "The onboarding offers this quarter." },
		]);
		expect(await readDocument(id, BOB)).toBeNull();
		expect(await readDocument("0".repeat(32), ANN)).toBeNull();
		expect(await readDocument("not-an-id", ANN)).toBeNull();
	});

	test("a picture is served by its own blob's readers, the same rule decided in hand", async () => {
		expect(await readablePicture("people/pictures/bands.png", ANN)).toBe(true);
		expect(await readablePicture("people/pictures/bands.png", BOB)).toBe(false);
		expect(await readablePicture("people/pictures/desk.png", BOB)).toBe(true);
		// Not a picture, or nothing the job described: never served.
		expect(await readablePicture("people/handbook.md", ANN)).toBe(false);
		expect(await readablePicture("people/access.json", ANN)).toBe(false);
		k.store.put("people/pictures/stray.png", "png");
		expect(await readablePicture("people/pictures/stray.png", ANN)).toBe(false);
	});
});

describe("the reader serves a file's text only to those the file itself admits, whatever the index still says", () => {
	const HANDBOOK = "people/handbook.md";
	const ID = documentIdOf(HANDBOOK);
	const sectionsFor = async (who: typeof ANN) =>
		JSON.stringify((await readDocument(ID, who))?.sections ?? null);
	const replaced =
		"---\ntitle: Onboarding handbook\n---\n\n# Pay\n\nThe salary bands, for the people team alone.";
	const narrowed = (manifest: string) => {
		const access = JSON.parse(manifest) as Record<string, unknown>;
		return JSON.stringify({
			...access,
			"handbook.md": { groups: ["g-people"] },
		});
	};
	const manifest = () =>
		new TextDecoder().decode(k.store.objects.get("people/access.json")?.bytes);

	test("a file replaced and restricted, uploaded and not yet loaded: the old audience is shown what the index holds, never the new text", async () => {
		const before = await sectionsFor(BOB);
		expect(before).not.toBe("null");
		// What the mirror does before the job starts: the upload, which leaves the blob undescribed.
		k.store.put(HANDBOOK, replaced);
		k.store.put("people/access.json", narrowed(manifest()));
		const during = await sectionsFor(BOB);
		expect(during).not.toContain("salary bands");
		expect(during).not.toBe("null");
		// Ann is admitted by the file as it will be described, and is not shown text nobody has described either.
		expect(await sectionsFor(ANN)).not.toContain("salary bands");
	});

	test("a load that fails before it describes anything leaves it so: a manifest that does not parse opens nothing", async () => {
		k.store.put(HANDBOOK, replaced);
		k.store.put("people/access.json", `${narrowed(manifest()).slice(0, -1)},}`);
		await expect(loadLibrary("people", { pollMs: 0 })).rejects.toThrow();
		expect(await sectionsFor(BOB)).not.toContain("salary bands");
	});

	test("described as restricted while the indexer fails the file: the blob's readers decide, and the old audience the index still carries reads nothing", async () => {
		k.store.put(HANDBOOK, replaced);
		k.store.put("people/access.json", narrowed(manifest()));
		k.indexer.failing.set(HANDBOOK, "the document could not be read");
		await expect(loadLibrary("people", { pollMs: 0 })).resolves.toMatchObject({
			failed: 1,
		});
		// The same null as a document Bob cannot read, not the index's copy of the old text.
		expect(await readDocument(ID, BOB)).toBeNull();
		// The person the file now admits reads it as it is.
		expect(await sectionsFor(ANN)).toContain("salary bands");
	});

	test("a clean load closes the window: the new text for those it admits, nothing for the rest", async () => {
		k.store.put(HANDBOOK, replaced);
		k.store.put("people/access.json", narrowed(manifest()));
		expect((await loadLibrary("people", { pollMs: 0 })).failed).toBe(0);
		expect(await sectionsFor(ANN)).toContain("salary bands");
		expect(await readDocument(ID, BOB)).toBeNull();
	});
});

test("a local account sees exactly the documents open to everyone", async () => {
	expect(await titles(LOCAL)).toEqual(["Onboarding handbook"]);
	expect(await readablePicture("people/pictures/desk.png", LOCAL)).toBe(true);
	expect(await readablePicture("people/pictures/bands.png", LOCAL)).toBe(false);
});

test("nobody verified is refused rather than shown the open library", async () => {
	const said = spyOn(console, "error").mockImplementation(() => {});
	try {
		const out = await retrieve("onboarding", { access: null });
		expect(out).toMatchObject({ hits: [], refused: "unidentified_caller" });
		expect(said).toHaveBeenCalledTimes(1);
	} finally {
		said.mockRestore();
	}
});

describe("a hardened deployment with nothing stored enforces the readers", () => {
	test("with no access document, HARDENED holds Bob to the readers: the pay review is not found, not read and its picture not served, while the open handbook still is", async () => {
		restoreSettings();
		const hardened = scopedEnv({ HARDENED: "true" });
		restoreSettings = stagedSettings({
			knowledge: { planner: { enabled: false } },
		});
		try {
			expect(await titles(BOB)).toEqual([
				"Field rollout",
				"Onboarding handbook",
			]);
			expect(await titles(ANN)).toEqual([
				"Onboarding handbook",
				"Onboarding pay review",
			]);
			expect(
				await readDocument(documentIdOf("people/pay-review.md"), BOB),
			).toBeNull();
			expect(await readablePicture("people/pictures/bands.png", BOB)).toBe(
				false,
			);
			expect(await readablePicture("people/pictures/desk.png", BOB)).toBe(true);
		} finally {
			hardened();
		}
	});
});

describe("under enforcement, a document that declares no readers follows globalDocumentAccess", () => {
	const loadPlain = async () => {
		// No access.json at all: every file takes the readers the settings give an undeclared one.
		k.store.put(
			"plain/memo.md",
			"---\ntitle: Onboarding memo\n---\n\nThe onboarding memo.",
		);
		expect((await loadLibrary("plain", { pollMs: 0 })).failed).toBe(0);
	};
	const memo = async (who: typeof ANN) =>
		(await titles(who)).includes("Onboarding memo");

	test("global access on: everybody signed in finds and reads it; switched off, it is hidden at once, without a reload", async () => {
		await loadPlain();
		expect(await memo(BOB)).toBe(true);
		expect(await memo(LOCAL)).toBe(true);
		expect(
			await readDocument(documentIdOf("plain/memo.md"), BOB),
		).not.toBeNull();
		restoreSettings();
		restoreSettings = stagedSettings({
			access: { enforceAccessControl: true, globalDocumentAccess: false },
			knowledge: { planner: { enabled: false } },
		});
		expect(await memo(BOB)).toBe(false);
		expect(await memo(ANN)).toBe(false);
		expect(await readDocument(documentIdOf("plain/memo.md"), BOB)).toBeNull();
	});

	test("loaded while global access is off, it admits nobody", async () => {
		restoreSettings();
		restoreSettings = stagedSettings({
			access: { enforceAccessControl: true, globalDocumentAccess: false },
			knowledge: { planner: { enabled: false } },
		});
		await loadPlain();
		expect(await memo(ANN)).toBe(false);
		expect(await memo(BOB)).toBe(false);
	});
});
