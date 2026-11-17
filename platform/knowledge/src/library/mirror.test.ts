import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resetBlobService } from "@platform/storage";
import { type FakeBlob, fakeBlob, storeEnv } from "@platform/storage/testing";
import { mirrorDirectory } from "./mirror";

let dir: string;
let store: FakeBlob;
let restore = () => {};

beforeEach(async () => {
	restore = storeEnv({ account: "store" });
	store = fakeBlob();
	dir = await mkdtemp(join(tmpdir(), "mirror-"));
	await mkdir(join(dir, "pictures"));
	await mkdir(join(dir, ".git"));
	await writeFile(join(dir, "guide.md"), "# Guide\n");
	await writeFile(join(dir, "pictures", "a.png"), "png");
	await writeFile(join(dir, "access.json"), '{"*":{"groups":["all"]}}');
	await writeFile(join(dir, ".DS_Store"), "x");
	await writeFile(join(dir, ".git", "HEAD"), "x");
});

afterEach(async () => {
	restore();
	resetBlobService();
	await rm(dir, { recursive: true, force: true });
});

test("a directory becomes the library's blobs, each typed by its format, hidden files left behind", async () => {
	expect(await mirrorDirectory(dir, "@sample")).toEqual({
		uploaded: 3,
		unchanged: 0,
		deleted: 0,
	});
	expect([...store.objects.keys()].sort()).toEqual([
		"@sample/access.json",
		"@sample/guide.md",
		"@sample/pictures/a.png",
	]);
	expect(store.objects.get("@sample/guide.md")?.contentType).toBe(
		"text/markdown; charset=utf-8",
	);
	expect(store.objects.get("@sample/pictures/a.png")?.contentType).toBe(
		"image/png",
	);
	expect(store.objects.get("@sample/access.json")?.contentType).toBe(
		"application/json",
	);
});

test("an unchanged file keeps its blob, so its metadata and the indexer's reading of it stand; a changed one is uploaded; a gone one deleted", async () => {
	await mirrorDirectory(dir, "@sample");
	// The job's description of it, which a re-upload would wipe.
	const guide = store.objects.get("@sample/guide.md");
	if (guide) guide.metadata = { title: "R3VpZGU=" };
	await writeFile(join(dir, "pictures", "a.png"), "a new png");
	await rm(join(dir, "access.json"));
	expect(await mirrorDirectory(dir, "@sample")).toEqual({
		uploaded: 1,
		unchanged: 1,
		deleted: 1,
	});
	expect(store.objects.get("@sample/guide.md")?.metadata).toEqual({
		title: "R3VpZGU=",
	});
	expect(store.deleted).toEqual(["@sample/access.json"]);
});

test("another library's blobs are not this one's to touch", async () => {
	store.put("handbook/guide.md", "theirs");
	await mirrorDirectory(dir, "@sample");
	expect(store.objects.has("handbook/guide.md")).toBe(true);
});
