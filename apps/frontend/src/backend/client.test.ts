import { afterAll, beforeAll, expect, test } from "bun:test";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { keepStreamAlive } from "@platform/http/streaming";
import { scopedEnv } from "@platform/test-support";
import { type Language, languageOf } from "../../../backend/src/language";
import { locales } from "../i18n/locales";
import { callerAssertion } from "../identity";
import {
	BackendError,
	backendFetch,
	backendJson,
	type Caller,
	isAbort,
	relayResponse,
} from "./client";

/**
 * The one client, against a local server standing in for the backend: the
 * assertion it minted is verified with the same secret and is the only
 * thing that says whose call it is, a refusal comes back as its code, and a
 * stream is forwarded with the keep-alive frame when it falls silent.
 */
let restoreEnv: () => void;
let restoreBackend: () => void;

const caller: Caller = {
	claims: {
		sub: "account-1",
		email: "person@example.com",
		roles: ["premium"],
		groups: [],
		tier: "premium",
	},
	locale: "en",
};

let server: ReturnType<typeof Bun.serve>;

beforeAll(() => {
	restoreEnv = scopedEnv({
		AUTH_SECRET: "test-secret-for-the-frontend-client",
	});
	server = Bun.serve({
		port: 0,
		async fetch(req) {
			const url = new URL(req.url);
			const token = req.headers.get("authorization")?.replace(/^Bearer /, "");
			const claims = await callerAssertion.verify(token);
			// A backend whose secret differs from the frontend's sees no valid assertion.
			if (!claims || url.pathname === "/refuse")
				return Response.json({ code: "unauthenticated" }, { status: 401 });
			if (url.pathname === "/identity/me") {
				return Response.json({
					accountId: claims.sub,
					tier: claims.tier,
					roles: claims.roles,
				});
			}
			if (url.pathname === "/conversations") {
				const scoping = [...req.headers.keys()].filter(
					(name) => name.startsWith("x-") && name !== "x-forwarded-for",
				);
				return Response.json({ sub: claims.sub, scoping });
			}
			if (url.pathname === "/silent") return new Promise<Response>(() => {});
			// Headers at once, then a body that never ends.
			if (url.pathname === "/stalled")
				return new Response(
					new ReadableStream({
						start(controller) {
							controller.enqueue(new TextEncoder().encode('{"half":'));
						},
					}),
					{ headers: { "Content-Type": "application/json" } },
				);
			if (url.pathname === "/language")
				return Response.json(languageOf(locales, req.headers));
			if (url.pathname === "/limited") {
				return Response.json(
					{
						code: "rate_limited",
						surface: "chat",
						retryAfterSeconds: 42,
						pool: true,
					},
					{ status: 429, headers: { "Retry-After": "42" } },
				);
			}
			if (url.pathname === "/stream") {
				const encoder = new TextEncoder();
				const body = new ReadableStream<Uint8Array>({
					start(controller) {
						controller.enqueue(encoder.encode("data: first\n\n"));
						// Then silence, long enough for the heartbeat to fire.
						setTimeout(() => controller.close(), 120);
					},
				});
				return new Response(body, {
					headers: { "Content-Type": "text/event-stream" },
				});
			}
			return new Response(null, { status: 404 });
		},
	});
	restoreBackend = scopedEnv({
		BACKEND_URL: `http://127.0.0.1:${server.port}`,
	});
});

afterAll(() => {
	restoreBackend();
	restoreEnv();
	server.stop(true);
});

test("the assertion carries the session's claims and the backend verifies it", async () => {
	const me = await backendJson<{
		accountId: string;
		tier: string;
		roles: string[];
	}>(caller, "/identity/me");
	expect(me).toEqual({
		accountId: "account-1",
		tier: "premium",
		roles: ["premium"],
	});
});

test("a scoped call is scoped by the assertion alone: no header names whose it is", async () => {
	expect(
		await backendJson<{ sub: string; scoping: string[] }>(
			caller,
			"/conversations",
		),
	).toEqual({ sub: "account-1", scoping: [] });
});

test("every call carries the request's language, and the backend reads it out of the same list", async () => {
	expect(
		await backendJson<Language>({ ...caller, locale: "it" }, "/language"),
	).toEqual({
		code: "it",
		name: "Italian",
	});
	expect(await backendJson<Language>(caller, "/language")).toEqual({
		code: "en",
		name: "English",
	});
});

test("a 401 from the backend surfaces as the unauthenticated code", async () => {
	await expect(backendJson(caller, "/refuse")).rejects.toMatchObject({
		status: 401,
		code: "unauthenticated",
	});
});

test("a metered refusal keeps its status, its folded code and its wait", async () => {
	const err = await backendJson(caller, "/limited").catch((e) => e);
	expect(err).toBeInstanceOf(BackendError);
	expect(err).toMatchObject({
		status: 429,
		code: "pool_exhausted",
		retryAfterSeconds: 42,
	});
});

test("a stream is forwarded as it arrives, with the keep-alive frame in the silence", async () => {
	const upstream = await backendFetch(caller, "/stream");
	const relayed = keepStreamAlive(relayResponse(upstream), 20);
	expect(relayed.headers.get("x-accel-buffering")).toBe("no");
	const text = await relayed.text();
	expect(text.startsWith("data: first\n\n")).toBe(true);
	expect(text).toContain(": keepalive\n\n");
});

test("an unreachable backend is a code, not a stack trace", async () => {
	const url = process.env.BACKEND_URL;
	process.env.BACKEND_URL = "http://127.0.0.1:1";
	try {
		await expect(backendJson(caller, "/identity/me")).rejects.toMatchObject({
			status: 503,
			code: "backend_unreachable",
		});
	} finally {
		process.env.BACKEND_URL = url;
	}
});

test("a backend that takes the call and never answers fails it at the deadline, as unreachable", async () => {
	await expect(
		backendJson(caller, "/silent", { deadlineMs: 50 }),
	).rejects.toMatchObject({ status: 503, code: "backend_unreachable" });
});

test("a body that stops arriving is the same unreachable backend, not a failure of this app", async () => {
	await expect(
		backendJson(caller, "/stalled", { deadlineMs: 50 }),
	).rejects.toMatchObject({ status: 503, code: "backend_unreachable" });
});

test("the request going away is the caller leaving, whatever the signal was aborted with", async () => {
	const gone = new AbortController();
	const reason = new Error("gone");
	reason.name = "ResponseAborted";
	const call = backendFetch(caller, "/silent", { signal: gone.signal });
	gone.abort(reason);
	const err = await call.catch((e) => e);
	expect(err).not.toBeInstanceOf(BackendError);
	expect(isAbort(err, gone.signal)).toBe(true);
	expect(isAbort(reason)).toBe(true);
	expect(isAbort(new Error("something else"))).toBe(false);
});

test("a compressed event stream is handed on decoded, named as it is, and kept alive", async () => {
	// The headers at once and the body after a silence, as a turn's first token is.
	const upstream = createServer((_request, response) => {
		response.writeHead(200, {
			"content-type": "text/event-stream",
			"content-encoding": "gzip",
		});
		response.flushHeaders();
		setTimeout(() => response.end(Bun.gzipSync("data: first\n\n")), 200);
	});
	await new Promise<void>((resolve) =>
		upstream.listen(0, "127.0.0.1", resolve),
	);
	const { port } = upstream.address() as AddressInfo;
	const restore = scopedEnv({ SSE_HEARTBEAT_MS: "30" });
	try {
		const relayed = relayResponse(await fetch(`http://127.0.0.1:${port}/`));
		expect(relayed.headers.get("content-encoding")).toBeNull();
		const text = await relayed.text();
		expect(text.startsWith(": keepalive\n\n")).toBe(true);
		expect(text.endsWith("data: first\n\n")).toBe(true);
	} finally {
		restore();
		upstream.close();
	}
});
