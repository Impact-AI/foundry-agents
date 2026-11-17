import { afterAll, beforeAll, expect, test } from "bun:test";
import type { AgentHost } from "@platform/agent";
import { openTestCosmos, type TestCosmos } from "@platform/cosmos/testing";
import { DEFAULT_EDGE_LIMITS } from "@platform/http";
import {
	callerAssertion,
	identityContainers,
	scopeAssertion,
} from "@platform/identity";
import { scopedEnv } from "@platform/test-support";
import type { Hono } from "hono";
import { createApp } from "./app";
import type { AppEnv } from "./auth/context";
import { product } from "./product";
import { idleBroker } from "./testing/broker";
import { call, claimsFor } from "./testing/calls";

/**
 * The gate, with no server behind it: what is answered before the host is
 * asked. The host is a sentinel that fails the test if a route reaches it,
 * which is the assertion — these refusals cost nothing. The accounts are an
 * empty container, for the routes that ask standing first.
 */
const untouched = new Proxy({} as AgentHost, {
	get(_, key) {
		throw new Error(`the host must not be reached here (${String(key)})`);
	},
});

let app: Hono<AppEnv>;
let cosmos: TestCosmos;
let restore = () => {};

beforeAll(async () => {
	restore = scopedEnv({
		AUTH_SECRET: "test-secret",
		CONTAINER_APP_NAME: undefined,
		APP_CONFIG_ENDPOINT: undefined,
		AZURE_OPENAI_RESOURCE_NAME: undefined,
	});
	cosmos = await openTestCosmos(identityContainers);
	app = createApp({
		host: untouched,
		product,
		broker: idleBroker(untouched),
	});
});

afterAll(async () => {
	await cosmos.drop();
	restore();
});

test("the health route is public", async () => {
	const res = await call(app, "GET", "/health");
	expect(res.status).toBe(200);
	expect(await res.text()).toBe("ok");
});

test("until the host has started, the replica is live but not ready, and every other route is 503", async () => {
	let started = false;
	const starting = createApp({
		host: untouched,
		product,
		broker: idleBroker(untouched),
		ready: () => started,
	});
	expect((await call(starting, "GET", "/health")).status).toBe(200);
	const notYet = await call(starting, "GET", "/ready");
	expect(notYet.status).toBe(503);
	expect(await notYet.json()).toEqual({ code: "starting" });
	const turned = await call(starting, "GET", "/identity/me");
	expect(turned.status).toBe(503);
	expect(await turned.json()).toEqual({ code: "starting" });
	started = true;
	expect((await call(starting, "GET", "/ready")).status).toBe(200);
	expect((await call(starting, "GET", "/identity/me")).status).toBe(401);
});

test("every other route answers 401 without an assertion, unknown paths included", async () => {
	for (const path of [
		"/conversations",
		"/identity/me",
		"/identity/me/memory",
		"/nowhere",
		"/agent/run",
	]) {
		const res = await call(app, "GET", path);
		expect(res.status).toBe(401);
		expect(await res.json()).toEqual({ code: "unauthenticated" });
	}
});

test("an assertion for another purpose, or a malformed header, is no assertion", async () => {
	const { token } = await scopeAssertion.mint({ rid: "account-1" });
	const scoped = await call(app, "GET", "/identity/me", {
		headers: { authorization: `Bearer ${token}` },
	});
	expect(scoped.status).toBe(401);
	const basic = await call(app, "GET", "/identity/me", {
		headers: { authorization: "Basic abc" },
	});
	expect(basic.status).toBe(401);
});

test("a local account's assertion is refused once the mode is entra", async () => {
	const restoreMode = scopedEnv({ AUTH_MODE: "entra" });
	try {
		const res = await call(app, "GET", "/nowhere", { as: "local:ada" });
		expect(res.status).toBe(401);
	} finally {
		restoreMode();
	}
	const local = scopedEnv({ AUTH_MODE: "local" });
	try {
		const res = await call(app, "GET", "/nowhere", { as: "local:ada" });
		expect(res.status).toBe(404);
	} finally {
		local();
	}
});

test("an unknown path under a valid assertion is 404, with a code", async () => {
	const res = await call(app, "GET", "/nowhere", { as: "owner-a" });
	expect(res.status).toBe(404);
	expect(await res.json()).toEqual({ code: "not_found" });
});

test("the records are listed by hand as listRecords lists them: every kind, one kind, a query; a kind the sample lacks is refused", async () => {
	const all = await call(app, "GET", "/records", { as: "owner-a" });
	expect(all.status).toBe(200);
	expect(all.headers.get("cache-control")).toBe("no-store");
	const { records } = (await all.json()) as {
		records: { kind: string; id: string; summary: string }[];
	};
	expect(records).toHaveLength(12);
	expect(records[0]).toMatchObject({
		kind: "person",
		id: "mara-lindqvist",
		summary: "Role: Programme lead · Department: Operations",
	});

	const people = await call(app, "GET", "/records?kind=person", {
		as: "owner-a",
	});
	expect(
		((await people.json()) as { records: { kind: string }[] }).records.map(
			(r) => r.kind,
		),
	).toEqual(["person", "person", "person"]);

	const found = await call(
		app,
		"GET",
		"/records?kind=customer&query=enterprise",
		{ as: "owner-a" },
	);
	expect(
		((await found.json()) as { records: { id: string }[] }).records.map(
			(r) => r.id,
		),
	).toEqual(["halvard-logistics", "oakline-retail"]);

	const none = await call(app, "GET", "/records?query=zzz", {
		as: "owner-a",
	});
	expect(await none.json()).toEqual({ records: [] });

	const bad = await call(app, "GET", "/records?kind=robot", { as: "owner-a" });
	expect(bad.status).toBe(400);
	expect(await bad.json()).toEqual({ code: "invalid_query" });
	expect((await call(app, "GET", "/records")).status).toBe(401);
});

test("a record's card names the measures it keeps, and each is read by hand as metrics shapes it", async () => {
	const card = await call(app, "GET", "/records/project/ledger-migration", {
		as: "owner-a",
	});
	expect(((await card.json()) as { measures: unknown }).measures).toEqual([
		{ key: "spend", unit: "kEUR" },
		{ key: "openIssues", unit: "issues" },
	]);

	const quarters = await call(
		app,
		"GET",
		"/records/project/ledger-migration/metrics/spend",
		{ as: "owner-a" },
	);
	expect(quarters.status).toBe(200);
	expect(quarters.headers.get("cache-control")).toBe("no-store");
	const answer = (await quarters.json()) as {
		found: boolean;
		chart: { title: string; unit: string; series: { points: unknown[] }[] };
	};
	expect(answer.found).toBe(true);
	expect(answer.chart).toMatchObject({
		title: "Ledger Migration — spend",
		unit: "kEUR",
	});
	expect(answer.chart.series[0]?.points).toHaveLength(8);

	const years = await call(
		app,
		"GET",
		"/records/project/ledger-migration/metrics/spend?period=year",
		{ as: "owner-a" },
	);
	expect(
		((await years.json()) as { chart: { series: { points: unknown[] }[] } })
			.chart.series[0]?.points,
	).toEqual([
		{ x: "2024", y: 221 },
		{ x: "2025", y: 267 },
	]);

	const lacking = await call(
		app,
		"GET",
		"/records/project/ledger-migration/metrics/uptime",
		{ as: "owner-a" },
	);
	expect(lacking.status).toBe(404);
	expect(await lacking.json()).toEqual({
		code: "no_such_measure",
		measures: [
			{ key: "spend", unit: "kEUR" },
			{ key: "openIssues", unit: "issues" },
		],
	});

	for (const path of [
		"/records/project/nope/metrics/spend",
		"/records/robot/ledger-migration/metrics/spend",
	]) {
		const res = await call(app, "GET", path, { as: "owner-a" });
		expect(res.status).toBe(404);
		expect(await res.json()).toEqual({ code: "not_found" });
	}
	expect(
		(
			await call(
				app,
				"GET",
				"/records/project/ledger-migration/metrics/spend?period=decade",
				{ as: "owner-a" },
			)
		).status,
	).toBe(400);
	expect(
		(await call(app, "GET", "/records/project/ledger-migration/metrics/spend"))
			.status,
	).toBe(401);
});

test("an account id that cannot key a bucket is no caller, refused before any read", async () => {
	const res = await call(app, "GET", "/conversations", { as: "{tenant}" });
	expect(res.status).toBe(401);
	expect(await res.json()).toEqual({ code: "unauthenticated" });
});

test("a person edit and a memory correction that carry nothing usable are refused before any store is asked", async () => {
	for (const [method, path, body] of [
		["PATCH", "/identity/me", {}],
		["PATCH", "/identity/me", { name: "" }],
		["PATCH", "/identity/me", { about: 7 }],
		["PATCH", "/identity/me/memory/mem_1", { content: 7 }],
		["PATCH", "/identity/me/memory/mem_1", { content: "  " }],
		["PATCH", "/identity/me/memory/mem_1", "not json"],
		["PATCH", "/identity/me/memory/mem_1", { content: "x".repeat(10_001) }],
	] as const) {
		const res = await call(app, method, path, { as: "account-a", body });
		expect(res.status).toBe(400);
		expect(await res.json()).toEqual({ code: "invalid_body" });
	}
});

test("a body past the edge's bound is refused before a route reads it, whether or not it names its length", async () => {
	const over = DEFAULT_EDGE_LIMITS.maxRequestBodyBytes + 1;
	const declared = await call(app, "PATCH", "/identity/me", {
		as: "owner-a",
		body: { about: "x".repeat(over) },
	});
	expect(declared.status).toBe(413);
	expect(await declared.json()).toEqual({ code: "body_too_large" });
	// The agent's run too: its bound is the edge's, met before the standing gate or the host.
	const run = await call(app, "POST", "/agent/run", {
		as: "owner-a",
		body: { threadId: "t", messages: "x".repeat(over) },
	});
	expect(run.status).toBe(413);

	const { token } = await callerAssertion.mint(claimsFor("owner-a"));
	const chunk = new Uint8Array(64 * 1024).fill(0x20);
	let sent = 0;
	const unnamed = await app.request("/identity/me", {
		method: "PATCH",
		headers: {
			authorization: `Bearer ${token}`,
			"content-type": "application/json",
		},
		body: new ReadableStream<Uint8Array>({
			pull(controller) {
				if (sent > over) return controller.close();
				sent += chunk.byteLength;
				controller.enqueue(chunk);
			},
		}),
		duplex: "half",
	} as RequestInit);
	expect(unnamed.status).toBe(413);

	// Within the bound the route reads the body, and answers on what it says.
	const within = await call(app, "PATCH", "/identity/me", {
		as: "owner-a",
		body: { about: 7 },
	});
	expect(within.status).toBe(400);
	expect(await within.json()).toEqual({ code: "invalid_body" });
});

test("a sign-in may only be reported for the caller's own subject", async () => {
	const res = await call(app, "POST", "/identity/sign-in", {
		as: "owner-a",
		body: { claims: { oid: "owner-b" }, user: { id: "owner-b" } },
	});
	expect(res.status).toBe(403);
	expect(await res.json()).toEqual({ code: "forbidden" });
	const empty = await call(app, "POST", "/identity/sign-in", {
		as: "owner-a",
		body: "not json",
	});
	expect(empty.status).toBe(400);
});

test("with no voice agent behind the broker, the capability offers no voice", async () => {
	const res = await call(app, "GET", "/voice/capability", { as: "owner-a" });
	expect(res.status).toBe(200);
	expect(await res.json()).toEqual({ live: false });
});
