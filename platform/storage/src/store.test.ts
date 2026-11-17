import { afterEach, expect, test } from "bun:test";
import { blobStore, requireBlobStore } from "./store";
import { storeEnv } from "./testing";

let restore = () => {};
afterEach(() => {
	restore();
	restore = () => {};
});

test("the store is described by the account, or by an endpoint that overrides it", () => {
	restore = storeEnv({ account: "acct" });
	expect(blobStore()).toEqual({
		base: "https://acct.blob.core.windows.net",
		container: "library",
	});
	restore();
	restore = storeEnv({
		account: "acct",
		endpoint: "http://127.0.0.1:10000/devstoreaccount1/",
		container: "documents",
	});
	expect(blobStore()).toEqual({
		base: "http://127.0.0.1:10000/devstoreaccount1",
		container: "documents",
	});
});

test("with neither, there is no store", () => {
	restore = storeEnv({});
	expect(blobStore()).toBeUndefined();
	expect(() => requireBlobStore()).toThrow(/AZURE_STORAGE_ACCOUNT/);
});

test("an endpoint that is not a URL is a mistake said as one, never an empty store", () => {
	restore = storeEnv({ endpoint: "not a url" });
	expect(() => blobStore()).toThrow(/is not a URL: not a url/);
});
