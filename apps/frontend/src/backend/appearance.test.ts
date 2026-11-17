import { afterAll, beforeAll, expect, test } from "bun:test";
import { appearanceDefaults } from "@platform/appearance";
import { scopedEnv } from "@platform/test-support";
// The fetch a route handler runs under: Next wraps the global one in this.
import { createDedupeFetch } from "next/dist/server/lib/dedupe-fetch";
import { locales } from "../i18n/locales";
import { appearanceReader, logoSrc, relayLogo } from "./appearance";

/**
 * The appearance reader and the logo relay against a local server standing
 * in for the backend. The relay runs through the fetch Next hands a route
 * handler — which tees every GET body and keeps one branch, so a refusal
 * whose body the relay cancels would hang the route for as long as anybody
 * waited. Every relay call here is raced against a deadline: a hang is a
 * failure, not a stuck run.
 */

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const ETAG = '"abc123"';
const LOGO = `appearance/logo/${"c".repeat(64)}.webp`;

let answer: "none" | "png" | "svg" | "silent" | "large" | "unbounded" = "none";
/** What the stand-in was asked: path and query, and the credentials it was handed. */
const asked: { url: string; cookie: string | null; auth: string | null }[] = [];
const OVER = 512 * 1024 + 1;
let document: unknown = {};
let server: ReturnType<typeof Bun.serve>;
let restoreEnv: () => void = () => {};
const realFetch = globalThis.fetch;

beforeAll(() => {
	server = Bun.serve({
		port: 0,
		fetch(req) {
			const url = new URL(req.url);
			const path = url.pathname;
			asked.push({
				url: `${path}${url.search}`,
				cookie: req.headers.get("cookie"),
				auth: req.headers.get("authorization"),
			});
			if (path === "/appearance")
				return document === "broken"
					? new Response("{not json", { status: 200 })
					: Response.json(document);
			if (path !== "/appearance/logo")
				return Response.json({ code: "unauthenticated" }, { status: 401 });
			if (answer === "silent") return new Promise<Response>(() => {});
			if (answer === "none")
				return Response.json(
					{ code: "not_found" },
					{ status: 404, headers: { "Cache-Control": "no-store" } },
				);
			if (answer === "large")
				return new Response(new Uint8Array(OVER), {
					headers: { "Content-Type": "image/png" },
				});
			if (answer === "unbounded")
				return new Response(
					new ReadableStream({
						start(controller) {
							for (let sent = 0; sent < OVER; sent += 64 * 1024)
								controller.enqueue(new Uint8Array(64 * 1024));
							controller.close();
						},
					}),
					{ headers: { "Content-Type": "image/png" } },
				);
			if (req.headers.get("if-none-match") === ETAG)
				return new Response(null, { status: 304, headers: { ETag: ETAG } });
			return new Response(answer === "png" ? PNG : "<svg/>", {
				headers: {
					"Content-Type": answer === "png" ? "image/png" : "image/svg+xml",
					ETag: ETAG,
					"Cache-Control": "public, max-age=300",
				},
			});
		},
	});
	restoreEnv = scopedEnv({ BACKEND_URL: `http://localhost:${server.port}` });
	globalThis.fetch = createDedupeFetch(realFetch) as typeof fetch;
});

afterAll(() => {
	globalThis.fetch = realFetch;
	restoreEnv();
	server.stop(true);
});

const DEFAULTS = appearanceDefaults(locales.codes);

test("the backend's document is parsed again here: a bad field keeps its default, an unknown one is dropped", async () => {
	document = {
		shape: { radius: 6 },
		type: { size: 99 },
		layout: { key: "stage-wide" },
		brand: { name: { en: "Harbor Desk" }, logo: LOGO },
	};
	const read = appearanceReader();
	const value = await read();
	expect(value.shape.radius).toBe(6);
	expect(value.type.size).toBe(16);
	expect(value).not.toHaveProperty("layout");
	expect(value.brand.name.en).toBe("Harbor Desk");
	expect(logoSrc(value)).toBe(`/api/appearance/logo?v=${"c".repeat(16)}`);
	// Served from memory until the pace is up: an edit meanwhile is not read.
	document = {};
	expect((await read()).shape.radius).toBe(6);
});

test("an unreadable answer, or no backend at all, is the shipped look and never an error", async () => {
	document = "broken";
	expect(await appearanceReader()()).toEqual(DEFAULTS);
	const restore = scopedEnv({ BACKEND_URL: "http://127.0.0.1:9" });
	try {
		expect(await appearanceReader()()).toEqual(DEFAULTS);
	} finally {
		restore();
	}
	expect(logoSrc(DEFAULTS)).toBe("");
});

async function ask(
	headers: Record<string, string> = {},
	deadlineMs?: number,
	url = "http://frontend/api/appearance/logo?v=x",
): Promise<Response> {
	const req = new Request(url, { headers });
	return Promise.race([
		relayLogo(req, deadlineMs),
		Bun.sleep(3_000).then(() => {
			throw new Error("the relay did not answer");
		}),
	]);
}

test("no logo stored is a fast 404, not a hang", async () => {
	answer = "none";
	const res = await ask();
	expect(res.status).toBe(404);
	expect(res.headers.get("set-cookie")).toBeNull();
	expect(res.headers.get("content-security-policy")).toBe(
		"default-src 'none'; sandbox",
	);
});

test("a stored raster is relayed, inert, cached against its hash", async () => {
	answer = "png";
	const res = await ask();
	expect(res.status).toBe(200);
	expect(res.headers.get("content-type")).toBe("image/png");
	expect(res.headers.get("etag")).toBe(ETAG);
	expect(res.headers.get("cache-control")).toBe("public, max-age=300");
	// Kept by shared caches, so it carries no cookie: the proxy's matcher
	// keeps Auth.js, which would write its own, off this path.
	expect(res.headers.get("set-cookie")).toBeNull();
	expect(res.headers.get("content-security-policy")).toBe(
		"default-src 'none'; sandbox",
	);
	expect(new Uint8Array(await res.arrayBuffer())).toEqual(PNG);
});

test("a revalidation is answered 304", async () => {
	answer = "png";
	const res = await ask({ "If-None-Match": ETAG });
	expect(res.status).toBe(304);
	expect(res.headers.get("etag")).toBe(ETAG);
});

test("anything but a raster is a 404", async () => {
	answer = "svg";
	expect((await ask()).status).toBe(404);
});

test("a backend that never answers is a 502 at the deadline", async () => {
	answer = "silent";
	const started = Date.now();
	const res = await ask({}, 100);
	expect(res.status).toBe(502);
	expect(Date.now() - started).toBeLessThan(2_000);
});

test("the relay asks the backend for the logo and nothing else, whatever the request names, and hands it no credential", async () => {
	answer = "png";
	asked.length = 0;
	for (const url of [
		"http://frontend/api/appearance/logo?v=x&url=http://169.254.169.254/",
		"http://frontend/api/appearance/logo?key=appearance/logo/../../library/a.png",
		"http://frontend/api/appearance/logo/../../media/a.png",
	])
		expect(
			(
				await ask(
					{ Cookie: "authjs.session-token=s", Authorization: "Bearer t" },
					undefined,
					url,
				)
			).status,
		).toBe(200);
	expect(asked).toEqual(
		Array(3).fill({ url: "/appearance/logo", cookie: null, auth: null }),
	);
});

test("a logo larger than the backend serves is never relayed, declared or not", async () => {
	answer = "large";
	expect((await ask()).status).toBe(404);
	answer = "unbounded";
	const res = await ask();
	expect(res.status).toBe(200);
	await expect(res.arrayBuffer()).rejects.toThrow("larger than");
});
