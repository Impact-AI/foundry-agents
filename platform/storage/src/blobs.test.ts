import { afterEach, beforeEach, expect, test } from "bun:test";
import {
	blobProperties,
	deleteBlob,
	describeBlob,
	listBlobs,
	putBlob,
	readBlob,
} from "./blobs";
import { resetBlobService } from "./service";
import { fakeBlob, storeEnv } from "./testing";

let restore = () => {};
beforeEach(() => {
	restore = storeEnv({ account: "acct" });
});
afterEach(() => {
	restore();
	resetBlobService();
});

const listed = async (prefix: string) => {
	const out = [];
	for await (const blob of listBlobs(prefix)) out.push(blob);
	return out;
};

test("a blob is read from the store's own container, or from the one named", async () => {
	const fake = fakeBlob();
	fake.put("appearance/logo/a.png", new Uint8Array([1]), {
		contentType: "image/png",
	});
	await readBlob("appearance/logo/a.png");
	await readBlob("appearance/logo/a.png", "appearance");
	expect(fake.containers).toEqual(["library", "appearance"]);
});

test("a blob written whole comes back streamed, typed, and listed with its metadata", async () => {
	fakeBlob();
	await putBlob("lib/a.png", new Uint8Array([1, 2, 3]), {
		contentType: "image/png",
		metadata: { kind: "picture" },
	});
	const read = await readBlob("lib/a.png");
	expect(read?.contentType).toBe("image/png");
	expect(read?.contentLength).toBe(3);
	expect(new Uint8Array(await new Response(read?.body).arrayBuffer())).toEqual(
		new Uint8Array([1, 2, 3]),
	);
	const [entry] = await listed("lib/");
	expect(entry).toMatchObject({
		name: "lib/a.png",
		contentType: "image/png",
		metadata: { kind: "picture" },
	});
	expect(entry?.contentMD5?.byteLength).toBe(16);
	expect(await listed("other/")).toEqual([]);
});

test("re-describing a blob replaces its metadata and keeps its MD5 when the type is rewritten", async () => {
	const store = fakeBlob();
	store.put("lib/a.md", "# A", { contentType: "application/octet-stream" });
	const before = await blobProperties("lib/a.md");
	await describeBlob(before as NonNullable<typeof before>, {
		contentType: "text/markdown",
		metadata: { title: "QQ==" },
	});
	const after = await blobProperties("lib/a.md");
	expect(after?.contentType).toBe("text/markdown");
	expect(after?.contentMD5).toEqual(before?.contentMD5 as Uint8Array);
	expect(after?.metadata).toEqual({ title: "QQ==" });
});

test("an absent blob, or no store at all, is null rather than a failure; a delete of one is quiet", async () => {
	fakeBlob();
	expect(await readBlob("lib/none.png")).toBeNull();
	expect(await blobProperties("lib/none.png")).toBeNull();
	await deleteBlob("lib/none.png");
	restore();
	restore = storeEnv({});
	expect(await readBlob("lib/a.png")).toBeNull();
	expect(await listed("lib/")).toEqual([]);
});
