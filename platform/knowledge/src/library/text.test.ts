import { afterEach, expect, test } from "bun:test";
import { resetBlobService } from "@platform/storage";
import { fakeBlob, storeEnv } from "@platform/storage/testing";
import { readText } from "./text";

let restore = () => {};

afterEach(() => {
	restore();
	restore = () => {};
	resetBlobService();
});

test("a text file is read whole, an absent one is absent, and one past the bound is too large whether or not the store said how long it is", async () => {
	restore = storeEnv({ account: "acct" });
	const store = fakeBlob();
	store.put("lib/a.md", "Résumé of the week.", {
		metadata: { library: "lib" },
	});
	store.put("lib/big.txt", new Uint8Array(2 * 1024 * 1024 + 1));
	// The text comes with what the blob says of itself, from the one read.
	expect(await readText("lib/a.md")).toEqual({
		kind: "text",
		text: "Résumé of the week.",
		metadata: { library: "lib" },
	});
	expect(await readText("lib/none.md")).toEqual({ kind: "absent" });
	expect(await readText("lib/big.txt")).toMatchObject({ kind: "too-large" });
	store.declaresLength = false;
	expect(await readText("lib/a.md")).toMatchObject({
		kind: "text",
		text: "Résumé of the week.",
	});
	expect(await readText("lib/big.txt")).toMatchObject({ kind: "too-large" });
});
