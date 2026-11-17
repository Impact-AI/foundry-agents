import { afterAll, beforeAll, describe, expect, spyOn, test } from "bun:test";
import { scopedEnv } from "@platform/test-support";
import { agentId } from "@/src/backend/agent";
import type { Caller } from "@/src/backend/client";
import { backendFacts } from "@/src/backend/facts";
import { callerAssertion } from "@/src/identity";
import { handleAs } from "@/src/route";
import { download } from "./account/export/route";
import { rename } from "./conversations/[id]/route";
import { list as listConversations } from "./conversations/route";
import { heldRuns } from "./copilotkit/caller-runner";
import { run } from "./copilotkit/route";
import { read as readDocument } from "./library/[id]/route";
import { list as listLibrary } from "./library/route";
import { correct, remove } from "./me/memory/[id]/route";
import { forget, read as readMemory } from "./me/memory/route";
import { edit as editPerson } from "./me/route";
import { media } from "./media/[...key]/route";
import { read as readMetrics } from "./records/[kind]/[id]/metrics/[measure]/route";
import { read as readRecord } from "./records/[kind]/[id]/route";
import { list as listRecords } from "./records/route";
import { POST as postVitals } from "./vitals/route";
import { GET as relayCaller } from "./voice/relay-caller/route";

/**
 * The route handlers, each against a faked caller and a local server
 * standing in for the backend: session → client → response, with the
 * backend's refusals crossing as the same code and status.
 */
let restoreEnv: () => void;
let restoreBackend: () => void;

const caller: Caller = {
	claims: {
		sub: "owner-1",
		email: null,
		roles: [],
		groups: [],
		tier: "base",
	},
	locale: "en",
};

/** What the stand-in saw: the path, whose assertion it carried, any header that tried to name a scope, the language asked for, the body. */
const seen: {
	path: string;
	sub: string;
	scoping: string[];
	language: string | null;
	body: string;
}[] = [];
const ITEM = {
	id: "mem 1",
	content: "Prefers maps.",
	updatedAt: "2026-10-20T10:00:00Z",
};
let remembered = [ITEM];
let server: ReturnType<typeof Bun.serve>;
const KEY = `${"a".repeat(64)}/images/desk%20one.png`;
const SVG_KEY = `${"a".repeat(64)}/images/drawing.svg`;
/** The validator the stand-in backend gives the picture. */
const PNG_TAG = '"cG5nLW1kNQ=="';

/** One event as the backend's stream carries it. */
const frame = (event: unknown) => `data: ${JSON.stringify(event)}\n\n`;

/**
 * A run answered a word every few milliseconds, for two seconds or until its
 * reader goes: a run to be found in flight.
 */
function slowAnswer(threadId: string, runId: string): Response {
	const encoder = new TextEncoder();
	let timer: ReturnType<typeof setInterval> | undefined;
	const body = new ReadableStream<Uint8Array>({
		start(controller) {
			controller.enqueue(
				encoder.encode(
					frame({ type: "RUN_STARTED", threadId, runId }) +
						frame({
							type: "TEXT_MESSAGE_START",
							messageId: "m1",
							role: "assistant",
						}),
				),
			);
			let said = 0;
			timer = setInterval(() => {
				said++;
				if (said <= 200) {
					controller.enqueue(
						encoder.encode(
							frame({
								type: "TEXT_MESSAGE_CONTENT",
								messageId: "m1",
								delta: `word${said} `,
							}),
						),
					);
					return;
				}
				clearInterval(timer);
				controller.enqueue(
					encoder.encode(
						frame({ type: "TEXT_MESSAGE_END", messageId: "m1" }) +
							frame({ type: "RUN_FINISHED", threadId, runId }),
					),
				);
				controller.close();
			}, 10);
		},
		cancel() {
			clearInterval(timer);
		},
	});
	return new Response(body, {
		headers: { "Content-Type": "text/event-stream" },
	});
}

beforeAll(() => {
	restoreEnv = scopedEnv({
		AUTH_SECRET: "test-secret-for-the-frontend-routes",
	});
	server = Bun.serve({
		port: 0,
		async fetch(req) {
			const url = new URL(req.url);
			const claims = await callerAssertion.verify(
				req.headers.get("authorization")?.slice(7),
			);
			if (!claims) {
				return Response.json({ code: "unauthenticated" }, { status: 401 });
			}
			seen.push({
				path: `${req.method} ${url.pathname}${url.search}`,
				sub: claims.sub,
				scoping: [...req.headers.keys()].filter((h) => h.startsWith("x-")),
				language: req.headers.get("accept-language"),
				body: await req.text(),
			});
			switch (`${req.method} ${url.pathname}`) {
				case "GET /identity/me":
					return Response.json({
						accountId: "owner-1",
						access: { tier: "base" },
						groups: [],
						standing: "ok",
						agentId: "sample-agent",
						stageTools: [
							{
								name: "showLibrary",
								description: "Fill the library.",
								parameters: { type: "object", properties: {} },
							},
							{ name: "notOurs", description: "Dropped." },
						],
						limits: { maxRequestBodyBytes: 65_536 },
					});
				case "GET /library":
					return Response.json({
						documents: [
							{
								id: "d1",
								title: "Onboarding handbook",
								summary: "s",
								tags: ["people"],
							},
						],
					});
				case "GET /library/d1":
					return Response.json({
						id: "d1",
						title: "Onboarding handbook",
						summary: "s",
						tags: [],
						sections: [{ heading: "Welcome", text: "…" }],
						media: [],
					});
				case "GET /records":
					return Response.json({
						records: [
							{ kind: "person", id: "p1", name: "Ada Quill", summary: "s" },
						],
					});
				case "GET /records/person/p1":
					return Response.json({
						kind: "person",
						id: "p1",
						name: "Ada Quill",
						fields: [],
						links: [],
						measures: [{ key: "billableHours", unit: "hours" }],
					});
				case "GET /records/person/p1/metrics/billableHours":
					return Response.json({
						found: true,
						chart: {
							title: "Ada Quill — billableHours",
							unit: "hours",
							series: [{ name: "Ada Quill", points: [{ x: "2024", y: 1 }] }],
						},
					});
				case "GET /records/person/p1/metrics/uptime":
					return Response.json(
						{ code: "no_such_measure", measures: [] },
						{ status: 404 },
					);
				case "GET /voice/capability":
					return Response.json({ live: true });
				case "PATCH /identity/me":
					return Response.json({
						name: "Ada",
						about: "I collect maps.",
						preferences: null,
					});
				case "GET /identity/me/memory":
					return Response.json({ items: remembered });
				case "PATCH /identity/me/memory/mem%201":
					remembered = [
						{
							...ITEM,
							content: (
								JSON.parse(seen.at(-1)?.body ?? "{}") as { content: string }
							).content,
						},
					];
					return Response.json(remembered[0]);
				case "DELETE /identity/me/memory/mem%201":
				case "DELETE /identity/me/memory":
					remembered = [];
					return new Response(null, { status: 204 });
				case "GET /conversations":
					return Response.json({
						conversations: [
							{ id: "c1", title: "One", updatedAt: "2026-01-01T00:00:00Z" },
						],
					});
				case `GET /media/${KEY}`:
				case `GET /media/${SVG_KEY}`:
					return url.pathname.endsWith(".svg")
						? new Response("<svg><script>alert(1)</script></svg>", {
								headers: { "Content-Type": "image/svg+xml" },
							})
						: req.headers.get("if-none-match") === PNG_TAG
							? new Response(null, {
									status: 304,
									headers: { ETag: PNG_TAG },
								})
							: new Response("PNGBYTES", {
									headers: {
										"Content-Type": "image/png",
										"Cache-Control": "private, no-cache",
										ETag: PNG_TAG,
									},
								});
				case "POST /agent/run": {
					const { threadId, runId } = JSON.parse(seen.at(-1)?.body ?? "{}");
					if (String(threadId).startsWith("slow")) {
						return slowAnswer(threadId, runId);
					}
					const events = [
						{ type: "RUN_STARTED", threadId, runId },
						{ type: "TEXT_MESSAGE_START", messageId: "m1", role: "assistant" },
						{ type: "TEXT_MESSAGE_CONTENT", messageId: "m1", delta: "Hi." },
						{ type: "TEXT_MESSAGE_END", messageId: "m1" },
						{ type: "RUN_FINISHED", threadId, runId },
					];
					return new Response(
						events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join(""),
						{ headers: { "Content-Type": "text/event-stream" } },
					);
				}
				case "GET /account/export":
					return new Response('{"account":{}}', {
						headers: { "Content-Type": "application/json" },
					});
				default:
					return Response.json({ code: "not_found" }, { status: 404 });
			}
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

/** A body sent in chunks, as a browser streams one: no Content-Length to read. */
const chunked = (contentType: string, ...parts: string[]) =>
	new Request("http://frontend.test/api/x", {
		method: "POST",
		headers: { "Content-Type": contentType },
		body: new ReadableStream({
			start(controller) {
				for (const part of parts)
					controller.enqueue(new TextEncoder().encode(part));
				controller.close();
			},
		}),
		duplex: "half",
	} as RequestInit);

const req = (
	method: string,
	body?: unknown,
	headers: Record<string, string> = {},
) =>
	new Request("http://frontend.test/api/x", {
		method,
		headers: { "Content-Type": "application/json", ...headers },
		body:
			body === undefined
				? null
				: typeof body === "string"
					? body
					: JSON.stringify(body),
	});

test("no caller is 401 with the code, before anything is called", async () => {
	const before = seen.length;
	const res = await handleAs(null, listConversations, req("GET"), {});
	expect(res.status).toBe(401);
	expect(await res.json()).toEqual({ code: "unauthenticated" });
	expect(seen.length).toBe(before);
});

test("the conversation list is the caller's, by the assertion alone", async () => {
	const res = await handleAs(caller, listConversations, req("GET"), {});
	expect(res.status).toBe(200);
	expect((await res.json()).conversations[0].id).toBe("c1");
	expect(seen.at(-1)).toMatchObject({
		path: "GET /conversations",
		sub: "owner-1",
		scoping: [],
	});
});

test("the person's edit is validated here, forwarded with only its own fields, and refused when it carries none", async () => {
	const res = await handleAs(
		caller,
		editPerson,
		req("PATCH", {
			name: " Ada ",
			about: "I collect maps.",
			preferences: "",
			locale: "fr",
			extra: 1,
		}),
		{},
	);
	expect(res.status).toBe(200);
	expect(JSON.parse(seen.at(-1)?.body ?? "{}")).toEqual({
		name: "Ada",
		about: "I collect maps.",
		preferences: null,
	});
	const before = seen.length;
	for (const body of [{}, { locale: "fr" }, { name: "" }, { about: 7 }, "x"]) {
		const refused = await handleAs(caller, editPerson, req("PATCH", body), {});
		expect(refused.status).toBe(400);
		expect(await refused.json()).toEqual({ code: "bad_request" });
	}
	expect(seen.length).toBe(before);
});

test("what is remembered is read, corrected, removed and forgotten through the backend, a statement by its id", async () => {
	const read = await handleAs(caller, readMemory, req("GET"), {});
	expect(await read.json()).toEqual({ items: [ITEM] });
	const corrected = await handleAs(
		caller,
		correct,
		req("PATCH", { content: "Prefers charts." }),
		{ id: "mem 1" },
	);
	expect(await corrected.json()).toMatchObject({
		id: "mem 1",
		content: "Prefers charts.",
	});
	const before = seen.length;
	for (const body of [{ content: 7 }, { content: "x".repeat(501) }]) {
		const bad = await handleAs(caller, correct, req("PATCH", body), {
			id: "mem 1",
		});
		expect(bad.status).toBe(400);
	}
	expect(seen.length).toBe(before);
	expect(
		(await handleAs(caller, remove, req("DELETE"), { id: "mem 1" })).status,
	).toBe(204);
	remembered = [ITEM];
	const forgotten = await handleAs(caller, forget, req("DELETE"), {});
	expect(forgotten.status).toBe(204);
	expect(
		await (await handleAs(caller, readMemory, req("GET"), {})).json(),
	).toEqual({ items: [] });
});

test("the live socket's caller answers only the server hosting this app: without its key the route does not exist", async () => {
	const restore = process.env.VOICE_RELAY_KEY;
	process.env.VOICE_RELAY_KEY = "the-server's-own";
	try {
		for (const key of [null, "a-guess", "the-server's-own!"]) {
			const res = await relayCaller(
				new Request("http://frontend.test/api/voice/relay-caller", {
					headers: key ? { "x-voice-relay-key": key } : {},
				}),
			);
			expect(res.status).toBe(404);
			expect(await res.json()).toEqual({ code: "not_found" });
		}
	} finally {
		process.env.VOICE_RELAY_KEY = restore;
	}
});

test("the agent's id, the stage tools and every byte bound are the backend's answers, read once and held", async () => {
	const before = seen.length;
	expect(await backendFacts(caller)).toEqual({
		agentId: "sample-agent",
		stageTools: [
			{
				name: "showLibrary",
				description: "Fill the library.",
				parameters: { type: "object", properties: {} },
			},
		],
		limits: { maxRequestBodyBytes: 65_536 },
	});
	expect(await agentId(caller)).toBe("sample-agent");
	const fetched = seen.slice(before).map((s) => s.path);
	expect(fetched.filter((p) => p === "GET /identity/me")).toHaveLength(1);
});

test("media streams through with its type, the caller's", async () => {
	const res = await handleAs(
		caller,
		media,
		new Request(`http://frontend.test/api/media/${KEY}`),
		{},
	);
	expect(res.status).toBe(200);
	expect(res.headers.get("content-type")).toBe("image/png");
	expect(await res.text()).toBe("PNGBYTES");
	expect(seen.at(-1)).toMatchObject({
		path: `GET /media/${KEY}`,
		sub: "owner-1",
	});
	// Opened directly, the bytes are a picture on this origin and nothing more.
	expect(res.headers.get("content-security-policy")).toBe(
		"default-src 'none'; img-src 'self' data:; style-src 'unsafe-inline'; sandbox",
	);
	expect(res.headers.get("x-content-type-options")).toBe("nosniff");
});

test("media the backend relays as anything but a raster image is refused here", async () => {
	const res = await handleAs(
		caller,
		media,
		new Request(`http://frontend.test/api/media/${SVG_KEY}`),
		{},
	);
	expect(res.status).toBe(415);
	expect(res.headers.get("content-type")).toStartWith("application/json");
	expect(await res.json()).toEqual({ code: "unsupported_type" });
	expect(res.headers.get("content-security-policy")).toContain("sandbox");
});

test("a media path that climbs or does not decode never reaches the backend", async () => {
	const before = seen.length;
	for (const path of [
		"/api/media/a/images/%2e%2e%2Faccount",
		"/api/media/a/images/%E0%A4%A",
		"/api/media/a//b.png",
	]) {
		const res = await handleAs(
			caller,
			media,
			new Request(`http://frontend.test${path}`),
			{},
		);
		expect(res.status, path).toBe(400);
	}
	expect(seen.length).toBe(before);
});

test("the library is searched with the query and the tags, as the caller", async () => {
	const res = await handleAs(
		caller,
		listLibrary,
		new Request(
			"http://frontend.test/api/library?query=onboarding&tags=people,hr&tags=new",
		),
		{},
	);
	expect(res.status).toBe(200);
	expect((await res.json()).documents[0].id).toBe("d1");
	expect(seen.at(-1)).toMatchObject({
		path: "GET /library?query=onboarding&tags=people&tags=hr&tags=new",
		sub: "owner-1",
	});
});

test("a document is read for the reader, and a missing one is 404 not_found", async () => {
	const found = await handleAs(caller, readDocument, req("GET"), { id: "d1" });
	expect(found.status).toBe(200);
	expect((await found.json()).sections).toHaveLength(1);
	const missing = await handleAs(caller, readDocument, req("GET"), {
		id: "d9",
	});
	expect(missing.status).toBe(404);
	expect(await missing.json()).toEqual({ code: "not_found" });
});

test("a record is read by kind and id; a kind the contract does not name is refused here", async () => {
	const found = await handleAs(caller, readRecord, req("GET"), {
		kind: "person",
		id: "p1",
	});
	expect(found.status).toBe(200);
	expect((await found.json()).name).toBe("Ada Quill");
	const before = seen.length;
	const bad = await handleAs(caller, readRecord, req("GET"), {
		kind: "robot",
		id: "p1",
	});
	expect(bad.status).toBe(400);
	expect(seen.length).toBe(before);
});

test("the records are listed as the caller, by kind and query; a kind the contract does not name is refused here", async () => {
	const res = await handleAs(
		caller,
		listRecords,
		new Request("http://frontend.test/api/records?kind=person&query=ada"),
		{},
	);
	expect(res.status).toBe(200);
	expect(res.headers.get("cache-control")).toBe("no-store");
	expect((await res.json()).records[0].id).toBe("p1");
	expect(seen.at(-1)).toMatchObject({
		path: "GET /records?kind=person&query=ada",
		sub: "owner-1",
	});
	const before = seen.length;
	const bad = await handleAs(
		caller,
		listRecords,
		new Request("http://frontend.test/api/records?kind=robot"),
		{},
	);
	expect(bad.status).toBe(400);
	expect(seen.length).toBe(before);
});

test("a record's measure is read for the chart, per quarter unless a period says otherwise; a measure the record lacks is 404 not_found", async () => {
	const found = await handleAs(caller, readMetrics, req("GET"), {
		kind: "person",
		id: "p1",
		measure: "billableHours",
	});
	expect(found.status).toBe(200);
	expect((await found.json()).chart.unit).toBe("hours");
	expect(seen.at(-1)?.path).toBe(
		"GET /records/person/p1/metrics/billableHours?period=quarter",
	);
	const yearly = await handleAs(
		caller,
		readMetrics,
		new Request("http://frontend.test/api/x?period=year"),
		{ kind: "person", id: "p1", measure: "billableHours" },
	);
	expect(yearly.status).toBe(200);
	expect(seen.at(-1)?.path).toBe(
		"GET /records/person/p1/metrics/billableHours?period=year",
	);
	const lacking = await handleAs(caller, readMetrics, req("GET"), {
		kind: "person",
		id: "p1",
		measure: "uptime",
	});
	expect(lacking.status).toBe(404);
	expect(await lacking.json()).toEqual({ code: "not_found" });
	const before = seen.length;
	for (const [params, url] of [
		[
			{ kind: "robot", id: "p1", measure: "uptime" },
			"http://frontend.test/api/x",
		],
		[
			{ kind: "person", id: "p1", measure: "uptime" },
			"http://frontend.test/api/x?period=decade",
		],
	] as const) {
		const bad = await handleAs(caller, readMetrics, new Request(url), {
			...params,
		});
		expect(bad.status).toBe(400);
	}
	expect(seen.length).toBe(before);
});

test("the export is a download, never cached", async () => {
	const res = await handleAs(caller, download, req("GET"), {});
	expect(res.status).toBe(200);
	expect(res.headers.get("content-disposition")).toContain("attachment");
	expect(res.headers.get("cache-control")).toBe("no-store");
	expect(await res.json()).toEqual({ account: {} });
});

test("the vitals beacon is bounded, validated and never stored", async () => {
	expect((await postVitals(req("POST", "x".repeat(5000)))).status).toBe(413);
	expect(
		(await postVitals(req("POST", { path: "/chat", nonsense: true }))).status,
	).toBe(400);
	const taken = await postVitals(
		req("POST", { path: "/chat", ttfb: 120, fcp: 300 }),
	);
	expect(taken.status).toBe(204);
	expect(taken.headers.get("cache-control")).toBe("no-store");
});

test("the vitals beacon is taken only from a page of this app: another site's writes no log line", async () => {
	const logged: unknown[] = [];
	const log = spyOn(console, "log").mockImplementation((line) => {
		logged.push(line);
	});
	try {
		const elsewhere: Record<string, string>[] = [
			{ origin: "https://elsewhere.test", host: "frontend.test" },
			{ "sec-fetch-site": "cross-site", origin: "http://frontend.test" },
		];
		for (const headers of elsewhere) {
			const res = await postVitals(req("POST", { path: "/chat" }, headers));
			expect(res.status).toBe(403);
			expect(res.headers.get("cache-control")).toBe("no-store");
		}
		expect(logged).toEqual([]);
		expect(
			(
				await postVitals(
					req(
						"POST",
						{ path: "/chat" },
						{ origin: "http://frontend.test", host: "frontend.test" },
					),
				)
			).status,
		).toBe(204);
		expect(logged).toHaveLength(1);
	} finally {
		log.mockRestore();
	}
});

describe("a body is bounded by its bytes, not by what it declares", () => {
	test("the chat turn: a chunked body past the edge's bound is refused before the agent is asked", async () => {
		const before = seen.length;
		const res = await handleAs(
			caller,
			run,
			chunked("application/json", "{", "x".repeat(40_000), "x".repeat(40_000)),
			{},
		);
		expect(res.status).toBe(413);
		expect(await res.json()).toEqual({ code: "body_too_large" });
		expect(seen.slice(before).map((s) => s.path)).not.toContain(
			"POST /agent/run",
		);
	});

	test("the vitals beacon: a chunked body past its bound is refused", async () => {
		const res = await postVitals(
			chunked("application/json", "x".repeat(3000), "x".repeat(3000)),
		);
		expect(res.status).toBe(413);
	});
});

test("a chat turn crosses as an AG-UI run to the backend's run route: the caller's assertion and language, none of the browser's headers, and the answer streamed back", async () => {
	const before = seen.length;
	const res = await handleAs(
		{ ...caller, locale: "it" },
		run,
		new Request("http://frontend.test/api/copilotkit", {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				Accept: "text/event-stream",
				Authorization: "Bearer from-the-browser",
				"X-Scope": "somebody-else",
			},
			body: JSON.stringify({
				method: "agent/run",
				params: { agentId: "sample-agent" },
				body: {
					threadId: "t1",
					runId: "r1",
					state: {},
					messages: [{ id: "u1", role: "user", content: "Hello" }],
					tools: [],
					context: [],
					forwardedProps: {},
				},
			}),
		}),
		{},
	);
	expect(res.status).toBe(200);
	expect(await res.text()).toContain('"delta":"Hi."');
	const sent = seen.slice(before).find((s) => s.path === "POST /agent/run");
	expect(sent).toMatchObject({ sub: "owner-1", scoping: [], language: "it" });
	expect(JSON.parse(sent?.body ?? "{}")).toMatchObject({
		threadId: "t1",
		messages: [{ id: "u1", role: "user", content: "Hello" }],
	});
});

test("the chat client's own mark on a run stays here, and whatever else a browser forwards crosses for the backend to refuse", async () => {
	const crossed = async (forwardedProps: Record<string, unknown>) => {
		const before = seen.length;
		const res = await handleAs(
			caller,
			run,
			new Request("http://frontend.test/api/copilotkit", {
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					Accept: "text/event-stream",
				},
				body: JSON.stringify({
					method: "agent/run",
					params: { agentId: "sample-agent" },
					body: {
						threadId: "t-forwarded",
						runId: "r-forwarded",
						state: {},
						messages: [{ id: "u1", role: "user", content: "Hello" }],
						tools: [],
						context: [],
						forwardedProps,
					},
				}),
			}),
			{},
		);
		await res.text();
		const sent = seen.slice(before).find((s) => s.path === "POST /agent/run");
		return JSON.parse(sent?.body ?? "{}").forwardedProps;
	};
	expect(await crossed({ __copilotkitRequestId: "request-1" })).toEqual({});
	expect(
		await crossed({ __copilotkitRequestId: "request-2", model: "another" }),
	).toEqual({ model: "another" });
});

describe("the chat runtime holds a run only while it streams, and only for the account that started it", () => {
	const other: Caller = {
		...caller,
		claims: { ...caller.claims, sub: "other-1" },
	};
	const call = (who: Caller, body: unknown) =>
		handleAs(
			who,
			run,
			new Request("http://frontend.test/api/copilotkit", {
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					Accept: "text/event-stream",
				},
				body: JSON.stringify(body),
			}),
			{},
		);
	const turn = (threadId: string, words: string) => ({
		method: "agent/run",
		params: { agentId: "sample-agent" },
		body: {
			threadId,
			runId: `run-${threadId}`,
			state: {},
			messages: [{ id: "u1", role: "user", content: words }],
			tools: [],
			context: [],
			forwardedProps: {},
		},
	});
	const attach = (threadId: string) => ({
		method: "agent/connect",
		params: { agentId: "sample-agent" },
		body: {
			threadId,
			runId: `attach-${threadId}`,
			state: {},
			messages: [],
			tools: [],
			context: [],
			forwardedProps: {},
		},
	});
	const stop = (threadId: string) => ({
		method: "agent/stop",
		params: { agentId: "sample-agent", threadId },
	});
	const words = (stream: string) => (stream.match(/word\d+/g) ?? []).length;

	test("a finished run leaves nothing behind: nobody who names the thread afterwards is told what was said, its owner included", async () => {
		const answered = await call(
			caller,
			turn("kept-nowhere", "When is my salary review?"),
		);
		expect(await answered.text()).toContain('"delta":"Hi."');
		expect(heldRuns()).toBe(0);

		for (const who of [other, caller]) {
			const before = seen.length;
			const replay = await call(who, attach("kept-nowhere"));
			expect(replay.status).toBe(200);
			const said = await replay.text();
			expect(said).not.toContain("salary review");
			expect(said).not.toContain("Hi.");
			// And the backend, which decides whose a thread is, was not asked to run anything.
			expect(seen.slice(before).map((s) => s.path)).not.toContain(
				"POST /agent/run",
			);
		}
	});

	test("a run in flight answers its own account and nobody else: another account can neither attach to it nor stop it", async () => {
		const streaming = await call(
			caller,
			turn("slow-theirs", "A long question"),
		);
		const reading = streaming.text();
		await Bun.sleep(150);
		expect(heldRuns()).toBe(1);

		const attached = await call(other, attach("slow-theirs"));
		expect(await attached.text()).not.toMatch(/word\d+|A long question/);
		const refused = await call(other, stop("slow-theirs"));
		expect(await refused.json()).toMatchObject({ stopped: false });

		// The owner's own stop ends it, and what it held goes with it.
		const stopped = await call(caller, stop("slow-theirs"));
		expect(await stopped.json()).toMatchObject({ stopped: true });
		expect(words(await reading)).toBeLessThan(200);
		expect(heldRuns()).toBe(0);
	});

	test("the account that started a run can attach to it while it streams", async () => {
		const streaming = await call(caller, turn("slow-mine", "Another question"));
		const reading = streaming.text();
		await Bun.sleep(150);
		const attached = await call(caller, attach("slow-mine"));
		const joining = attached.text();
		await Bun.sleep(100);
		await (await call(caller, stop("slow-mine"))).json();
		expect(words(await joining)).toBeGreaterThan(0);
		await reading;
		expect(heldRuns()).toBe(0);
	});

	test("a call the chat client never makes is refused before the runtime is asked, and no answer names an origin", async () => {
		for (const method of ["agent/suggest", "transcribe", "threads/list"]) {
			const res = await call(caller, {
				method,
				params: { agentId: "sample-agent" },
			});
			expect(res.status).toBe(404);
			expect(await res.json()).toEqual({ code: "not_found" });
		}
		const notACall = await call(caller, ["agent/run"]);
		expect(notACall.status).toBe(404);

		// Under the byte bound and still more than the runtime's validator is handed: counted, and refused as too large.
		const flood = await call(caller, {
			method: "agent/run",
			params: { agentId: "sample-agent" },
			body: {
				threadId: "flood",
				runId: "run-flood",
				messages: new Array(50_001).fill(0),
			},
		});
		expect(flood.status).toBe(413);
		expect(await flood.json()).toEqual({ code: "body_too_large" });
		// As many keys on one object, which no array holds.
		const keyed = await call(caller, {
			method: "agent/run",
			params: { agentId: "sample-agent" },
			body: {
				threadId: "flood",
				runId: "run-flood",
				state: Object.fromEntries(
					Array.from({ length: 50_001 }, (_, i) => [`k${i}`, 0]),
				),
			},
		});
		expect(keyed.status).toBe(413);
		expect(heldRuns()).toBe(0);

		const info = await call(caller, { method: "info" });
		expect(info.status).toBe(200);
		expect(info.headers.get("access-control-allow-origin")).toBeNull();
		const answered = await call(caller, turn("no-origin", "Hello"));
		expect(answered.headers.get("access-control-allow-origin")).toBeNull();
		await answered.text();
	});
});

test("a request that changes something is taken only from a page of this app; a read, and a caller that is no browser, are not asked", async () => {
	const before = seen.length;
	const cases: Record<string, string>[] = [
		{ origin: "https://elsewhere.test", host: "frontend.test" },
		{ origin: "https://shop.frontend.test", host: "frontend.test" },
		{ "sec-fetch-site": "same-site", host: "frontend.test" },
		{ "sec-fetch-site": "cross-site", origin: "http://frontend.test" },
		{ origin: "null", host: "frontend.test" },
		// The same host under another scheme, or on another port, is another origin.
		{ origin: "https://frontend.test", host: "frontend.test" },
		{ origin: "http://frontend.test:8080", host: "frontend.test" },
		{
			origin: "http://app.example",
			"x-forwarded-host": "app.example",
			"x-forwarded-proto": "https",
		},
		{ origin: "http://app.example", "x-forwarded-host": "app.example" },
	];
	for (const headers of cases) {
		const res = await handleAs(
			caller,
			editPerson,
			req("PATCH", { name: "Ada" }, headers),
			{},
		);
		expect(res.status).toBe(403);
		expect(await res.json()).toEqual({ code: "forbidden" });
		expect(res.headers.get("cache-control")).toBe("no-store");
	}
	expect(seen.length).toBe(before);
	const own: Record<string, string>[] = [
		{ origin: "http://frontend.test", host: "frontend.test" },
		{
			origin: "https://app.example",
			host: "10.0.0.4:3000",
			"x-forwarded-host": "app.example",
			"x-forwarded-proto": "https",
			"sec-fetch-site": "same-origin",
		},
		// A proxy that ends TLS and names the host alone: the page was served over https.
		{
			origin: "https://app.example",
			host: "10.0.0.4:3000",
			"x-forwarded-host": "app.example",
		},
		{},
	];
	for (const headers of own)
		expect(
			(
				await handleAs(
					caller,
					editPerson,
					req("PATCH", { name: "Ada" }, headers),
					{},
				)
			).status,
		).toBe(200);
	const read = await handleAs(
		caller,
		listConversations,
		req("GET", undefined, { origin: "https://elsewhere.test" }),
		{},
	);
	expect(read.status).toBe(200);
});

test("with AUTH_URL set, the page's origin is that one, whatever the request says its host is", async () => {
	const restore = scopedEnv({ AUTH_URL: "https://app.example/" });
	try {
		const forged = await handleAs(
			caller,
			editPerson,
			req(
				"PATCH",
				{ name: "Ada" },
				{ origin: "https://evil.test", "x-forwarded-host": "evil.test" },
			),
			{},
		);
		expect(forged.status).toBe(403);
		const own = await handleAs(
			caller,
			editPerson,
			req("PATCH", { name: "Ada" }, { origin: "https://app.example" }),
			{},
		);
		expect(own.status).toBe(200);
		const downgraded = await handleAs(
			caller,
			editPerson,
			req("PATCH", { name: "Ada" }, { origin: "http://app.example" }),
			{},
		);
		expect(downgraded.status).toBe(403);
	} finally {
		restore();
	}
});

test("a body past the bound is 413 before the handler parses it, declared or streamed", async () => {
	const before = seen.length;
	const big = JSON.stringify({ name: "Ada", about: "x".repeat(70_000) });
	for (const request of [
		req("PATCH", big),
		chunked("application/json", big.slice(0, 40_000), big.slice(40_000)),
	]) {
		const res = await handleAs(caller, editPerson, request, {});
		expect(res.status).toBe(413);
		expect(await res.json()).toEqual({ code: "body_too_large" });
	}
	expect(seen.length).toBe(before);
});

test("an answer that names no caching is never stored", async () => {
	const res = await handleAs(caller, listConversations, req("GET"), {});
	expect(res.headers.get("cache-control")).toBe("no-store");
});

test("a rename is refused without a title, or with one longer than a title is", async () => {
	const before = seen.length;
	for (const title of ["", "   ", 7, "x".repeat(73)]) {
		const res = await handleAs(caller, rename, req("PATCH", { title }), {
			id: "c1",
		});
		expect(res.status).toBe(400);
	}
	expect(seen.length).toBe(before);
});

test("a picture is asked for again on every draw: the browser keeps no copy past the session", async () => {
	const res = await handleAs(
		caller,
		media,
		new Request(`http://frontend.test/api/media/${KEY}`),
		{},
	);
	expect(res.status).toBe(200);
	expect(res.headers.get("cache-control")).toBe("private, no-cache");
	await res.body?.cancel();
});

test("the copy a browser holds is asked about, not sent again: the tag goes to the backend and its 304 comes back", async () => {
	const first = await handleAs(
		caller,
		media,
		new Request(`http://frontend.test/api/media/${KEY}`),
		{},
	);
	expect(first.headers.get("etag")).toBe(PNG_TAG);
	await first.body?.cancel();
	const again = await handleAs(
		caller,
		media,
		new Request(`http://frontend.test/api/media/${KEY}`, {
			headers: { "If-None-Match": PNG_TAG },
		}),
		{},
	);
	expect(again.status).toBe(304);
	expect(again.headers.get("etag")).toBe(PNG_TAG);
	expect(again.headers.get("cache-control")).toBe("private, no-cache");
	expect(again.headers.get("content-security-policy")).toContain("sandbox");
	expect(await again.text()).toBe("");
	// Another copy is answered whole.
	const other = await handleAs(
		caller,
		media,
		new Request(`http://frontend.test/api/media/${KEY}`, {
			headers: { "If-None-Match": '"other"' },
		}),
		{},
	);
	expect(other.status).toBe(200);
	expect(await other.text()).toBe("PNGBYTES");
});

test("a browser that left is a 499, not a backend that cannot be reached", async () => {
	const gone = new AbortController();
	// What Next aborts a request's signal with when its response is abandoned.
	const reason = new Error("gone");
	reason.name = "ResponseAborted";
	gone.abort(reason);
	const res = await handleAs(
		caller,
		media,
		new Request(`http://frontend.test/api/media/${KEY}`, {
			signal: gone.signal,
		}),
		{},
	);
	expect(res.status).toBe(499);
});

test("a path under /api that no route answers is data like every other answer there, never a page", async () => {
	const { GET, POST } = await import("./[...missing]/route");
	for (const answer of [GET(), POST()]) {
		expect(answer.status).toBe(404);
		expect(answer.headers.get("content-type")).toContain("application/json");
		expect(answer.headers.get("cache-control")).toBe("no-store");
		expect(await answer.json()).toEqual({ code: "not_found" });
	}
});

test("every handler under app/api reads the session itself, since the proxy's door does not stand before every path", async () => {
	// The routes that are public by design, or answer only this app's own server.
	const open = new Set([
		"[...missing]/route.ts",
		"appearance/logo/route.ts",
		"auth/[...nextauth]/route.ts",
		"vitals/route.ts",
		"voice/relay-caller/route.ts",
	]);
	const routes: string[] = [];
	for await (const file of new Bun.Glob("**/route.ts").scan(import.meta.dir)) {
		if (open.has(file)) continue;
		routes.push(file);
		const source = await Bun.file(`${import.meta.dir}/${file}`).text();
		const methods = [
			...source.matchAll(
				/export (?:const|async function|function) (GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)\b([^\n]*)/g,
			),
		];
		expect(methods.length).toBeGreaterThan(0);
		for (const [, method, rest] of methods)
			expect(`${file} ${method}${rest}`).toMatch(/ = withCaller\(/);
	}
	expect(routes.length).toBeGreaterThan(12);
});
