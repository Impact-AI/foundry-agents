import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { appearanceDefaults } from "@platform/appearance";
import { appearanceSettings } from "@platform/appearance/settings";
import { fakeConfigStore } from "@platform/config/testing";
import { resetBlobService } from "@platform/storage";
import { type FakeBlob, fakeBlob, storeEnv } from "@platform/storage/testing";
import { scopedEnv } from "@platform/test-support";
import { product } from "../product";
import { appearanceRoutes } from "./appearance";

const { locales } = product;

/**
 * The deployment's look, public: the document as its reader makes of the
 * store, and the one logo it names, read from the appearance container with
 * the backend's own identity and served only as the raster its key says.
 */

const LOGO = `appearance/logo/${"b".repeat(64)}.png`;
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

let stored: Record<string, unknown> = {};
let blob: FakeBlob;
let restoreStore = () => {};
let restoreEnv = () => {};
let restoreConfig = () => {};
/** Fresh per test: the routes hold the last logo they served. */
let routes = appearanceRoutes(locales);

function store(document: unknown): void {
	stored.appearance = document;
	appearanceSettings(locales.codes).invalidate();
}

beforeAll(() => {
	restoreEnv = scopedEnv({ AZURE_STORAGE_APPEARANCE_CONTAINER: undefined });
	restoreStore = storeEnv({ account: "acct" });
	restoreConfig = fakeConfigStore(stored);
	blob = fakeBlob();
});

afterEach(() => {
	stored = {};
	restoreConfig();
	restoreConfig = fakeConfigStore(stored);
	appearanceSettings(locales.codes).invalidate();
	blob.objects.clear();
	blob.containers.length = 0;
	routes = appearanceRoutes(locales);
});

afterAll(() => {
	restoreConfig();
	restoreStore();
	restoreEnv();
	resetBlobService();
	appearanceSettings(locales.codes).invalidate();
});

test("nothing stored is the shipped look, in every language the product speaks", async () => {
	const res = await routes.request("/appearance");
	expect(res.status).toBe(200);
	expect(res.headers.get("cache-control")).toBe("no-store");
	expect(await res.json()).toEqual(appearanceDefaults(locales.codes));
});

test("a stored document is answered as its reader makes it: a bad field at its default", async () => {
	store({ shape: { radius: 4 }, type: { font: "Comic Sans" } });
	const body = (await (await routes.request("/appearance")).json()) as {
		shape: { radius: number };
		type: { font: string };
	};
	expect(body.shape.radius).toBe(4);
	expect(body.type.font).toBe("system");
});

test("no logo named is a 404, and no store is asked", async () => {
	const res = await routes.request("/appearance/logo");
	expect(res.status).toBe(404);
	expect(blob.containers).toEqual([]);
});

test("the named logo is read from the appearance container, inert, cached against its hash", async () => {
	store({ brand: { logo: LOGO } });
	blob.put(LOGO, PNG, { contentType: "image/png" });
	const res = await routes.request("/appearance/logo");
	expect(res.status).toBe(200);
	expect(blob.containers).toEqual(["appearance"]);
	expect(res.headers.get("content-type")).toBe("image/png");
	expect(res.headers.get("etag")).toBe(`"${"b".repeat(16)}"`);
	expect(res.headers.get("cache-control")).toBe("public, max-age=300");
	expect(res.headers.get("content-security-policy")).toBe(
		"default-src 'none'; sandbox",
	);
	expect(res.headers.get("x-content-type-options")).toBe("nosniff");
	expect(new Uint8Array(await res.arrayBuffer())).toEqual(PNG);
});

test("a revalidation of the same logo is a 304 that reads nothing", async () => {
	store({ brand: { logo: LOGO } });
	const res = await routes.request("/appearance/logo", {
		headers: { "If-None-Match": `"${"b".repeat(16)}"` },
	});
	expect(res.status).toBe(304);
	expect(blob.containers).toEqual([]);
});

test("the container is the one the environment names", async () => {
	const restore = scopedEnv({ AZURE_STORAGE_APPEARANCE_CONTAINER: "brand" });
	try {
		store({ brand: { logo: LOGO } });
		blob.put(LOGO, PNG, { contentType: "image/png" });
		expect((await routes.request("/appearance/logo")).status).toBe(200);
		expect(blob.containers).toEqual(["brand"]);
	} finally {
		restore();
	}
});

test("an object that is not the raster its key says, or is too large, or is absent, is a 404", async () => {
	store({ brand: { logo: LOGO } });
	expect((await routes.request("/appearance/logo")).status).toBe(404);
	blob.put(LOGO, "<svg onload=alert(1)>", { contentType: "image/svg+xml" });
	expect((await routes.request("/appearance/logo")).status).toBe(404);
	blob.put(LOGO, new Uint8Array(512 * 1024 + 1), { contentType: "image/png" });
	expect((await routes.request("/appearance/logo")).status).toBe(404);
});

test("a key the document's reader refuses never reaches the store", async () => {
	store({ brand: { logo: "appearance/logo/../../library/secret.png" } });
	expect((await routes.request("/appearance/logo")).status).toBe(404);
	expect(blob.containers).toEqual([]);
});

test("the request names no key: a query or a longer path opens nothing but the document's logo", async () => {
	store({ brand: { logo: LOGO } });
	blob.put(LOGO, PNG, { contentType: "image/png" });
	blob.put("library/secret.png", PNG, { contentType: "image/png" });
	const res = await routes.request(
		"/appearance/logo?key=library/secret.png&container=library",
	);
	expect(res.status).toBe(200);
	expect(blob.containers).toEqual(["appearance"]);
	for (const path of [
		"/appearance/logo/library/secret.png",
		"/appearance/logo/..%2F..%2Flibrary%2Fsecret.png",
	])
		expect((await routes.request(path)).status).toBe(404);
	expect(blob.containers).toEqual(["appearance"]);
});

test("the document is answered with the appearance fields alone: nothing else stored beside them, and no other setting", async () => {
	stored.agent = { instructions: "not for the door" };
	store({
		shape: { radius: 4 },
		layout: { key: "stage-wide" },
		preview: { token: "x" },
		connection: "Endpoint=https://example;Secret=s",
	});
	const body = await (await routes.request("/appearance")).json();
	expect(Object.keys(body as object).sort()).toEqual(
		["brand", "palette", "scheme", "shape", "space", "type"].sort(),
	);
	expect(JSON.stringify(body)).not.toMatch(
		/stage-wide|Secret|not for the door/,
	);
});

test("a logo is read from the store once and served from memory after, until the document names another", async () => {
	store({ brand: { logo: LOGO } });
	blob.put(LOGO, PNG, { contentType: "image/png" });
	for (let i = 0; i < 3; i++) {
		const res = await routes.request("/appearance/logo");
		expect(res.status).toBe(200);
		expect(res.headers.get("x-content-type-options")).toBe("nosniff");
		expect(new Uint8Array(await res.arrayBuffer())).toEqual(PNG);
	}
	expect(blob.containers).toEqual(["appearance"]);

	const next = `appearance/logo/${"d".repeat(64)}.gif`;
	const GIF = new TextEncoder().encode("GIF89a");
	blob.put(next, GIF, { contentType: "image/gif" });
	store({ brand: { logo: next } });
	for (let i = 0; i < 2; i++) {
		const res = await routes.request("/appearance/logo");
		expect(res.headers.get("content-type")).toBe("image/gif");
		expect(res.headers.get("etag")).toBe(`"${"d".repeat(16)}"`);
		expect(new Uint8Array(await res.arrayBuffer())).toEqual(GIF);
	}
	expect(blob.containers).toEqual(["appearance", "appearance"]);
});

test("a refusal is never held: the store is asked again, and a logo put right is served", async () => {
	store({ brand: { logo: LOGO } });
	expect((await routes.request("/appearance/logo")).status).toBe(404);
	blob.put(LOGO, "<svg/>", { contentType: "image/svg+xml" });
	expect((await routes.request("/appearance/logo")).status).toBe(404);
	blob.put(LOGO, PNG, { contentType: "image/png" });
	expect((await routes.request("/appearance/logo")).status).toBe(200);
	expect(blob.containers).toEqual(["appearance", "appearance", "appearance"]);
});
