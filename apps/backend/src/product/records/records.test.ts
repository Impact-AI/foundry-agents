import { afterAll, beforeAll, expect, test } from "bun:test";
import type { AgentHost } from "@platform/agent";
import { runInTurnScope, UNSCOPED_TURN } from "@platform/agent/testing";
import { resetSingleton } from "@platform/config";
import { openTestCosmos, type TestCosmos } from "@platform/cosmos/testing";
import { identityContainers } from "@platform/identity";
import { scopedEnv } from "@platform/test-support";
import { createApp } from "../../app";
import { product } from "../../product";
import { idleBroker } from "../../testing/broker";
import { call } from "../../testing/calls";
import { findRecord } from "../sample/records";
import { listRecordsTool } from "../tools/list-records";
import { lookupRecord } from "../tools/lookup-record";
import { metrics } from "../tools/metrics";
import { RecordsUnavailable } from "./contract";
import { httpRecordsSource } from "./http";
import { recordCard } from "./source";
import { CUSTOMERS_GROUP, startRecordsStandIn } from "./standin";

/**
 * The worked adaptation (docs/worked-example.md): the records from a
 * business system over HTTP, against its stand-in. What is proven here is
 * the adapter's side — the shape mapped, the caller carried and never taken
 * from the model, a hidden record answered as a missing one, every failure a
 * value — and that the tools and the stage's routes answer through it
 * unchanged.
 */

const SOURCE_KEY = "product:records-source";
const standIn = startRecordsStandIn();
const seller = { oid: "seller", groups: ["staff", CUSTOMERS_GROUP] };
const engineer = { oid: "engineer", groups: ["staff"] };
const source = httpRecordsSource({ url: standIn.url });

let restore = () => {};
let cosmos: TestCosmos;

beforeAll(async () => {
	restore = scopedEnv({
		RECORDS_API_URL: standIn.url,
		RECORDS_API_SCOPE: undefined,
		AUTH_SECRET: "test-secret",
		CONTAINER_APP_NAME: undefined,
		APP_CONFIG_ENDPOINT: undefined,
		AZURE_OPENAI_RESOURCE_NAME: undefined,
	});
	resetSingleton(SOURCE_KEY);
	cosmos = await openTestCosmos(identityContainers);
});

afterAll(async () => {
	await cosmos.drop();
	restore();
	resetSingleton(SOURCE_KEY);
	standIn.stop();
});

test("the system's own shape is mapped to the sample's, record for record", async () => {
	expect(await source.find("project", "ledger-migration", seller)).toEqual(
		findRecord("project", "ledger-migration"),
	);
	expect(await source.find("project", "nope", seller)).toBeNull();
});

test("the system answers only what the caller may see, and a hidden record as a missing one", async () => {
	expect(
		(await source.search("customer", null, seller)).records.map((r) => r.id),
	).toHaveLength(3);
	const none = { records: [], truncated: false };
	expect(await source.search("customer", null, engineer)).toEqual(none);
	expect(await source.find("customer", "oakline-retail", engineer)).toBeNull();
	// Nobody verified is told what everybody may see, and sends no caller.
	expect(await source.search("customer", null, null)).toEqual(none);
	expect(standIn.seen.at(-1)).toMatchObject({ oid: null, groups: null });

	const project = await source.find("project", "ledger-migration", engineer);
	if (!project) throw new Error("not found");
	const card = await recordCard(source, project, engineer);
	expect(card.links.map((l) => l.kind)).not.toContain("customer");
	const full = await recordCard(source, project, seller);
	expect(full.links).toContainEqual({
		kind: "customer",
		id: "oakline-retail",
		name: "Oakline Retail",
	});
});

test("the caller is the turn's, never the model's input", async () => {
	const before = standIn.seen.length;
	const answer = await runInTurnScope(
		{ ...UNSCOPED_TURN, caller: { ...engineer, tier: "base" } },
		() =>
			listRecordsTool.execute({ kind: "customer" }, {
				toolCallId: "t",
				messages: [],
			} as never),
	);
	expect(answer).toEqual({ records: [] });
	expect(standIn.seen.slice(before)).toEqual([
		{ path: "/records", oid: "engineer", groups: "staff" },
	]);
});

test("a slow, failing or garbled system is a reason the model can say, and a bearer goes with every call", async () => {
	const slow = startRecordsStandIn({ delayMs: 300 });
	const hurried = httpRecordsSource({ url: slow.url, deadlineMs: 50 });
	await expect(hurried.search(null, null, seller)).rejects.toThrow(
		"did not answer within 50 ms",
	);
	slow.stop();

	const odd = Bun.serve({
		port: 0,
		fetch: (r) =>
			new URL(r.url).pathname === "/records"
				? Response.json({ rows: [] })
				: new Response("no", { status: 500 }),
	});
	const garbled = httpRecordsSource({ url: `http://127.0.0.1:${odd.port}` });
	await expect(garbled.search(null, null, seller)).rejects.toThrow(
		"not a listing",
	);
	await expect(garbled.find("person", "x", seller)).rejects.toThrow(
		"answered 500",
	);
	odd.stop(true);

	const gone = httpRecordsSource({ url: "http://127.0.0.1:9" });
	await expect(gone.find("person", "x", seller)).rejects.toBeInstanceOf(
		RecordsUnavailable,
	);

	let bearer = "";
	const guarded = Bun.serve({
		port: 0,
		fetch: (r) => {
			bearer = r.headers.get("authorization") ?? "";
			return Response.json({ items: [] });
		},
	});
	await httpRecordsSource({
		url: `http://127.0.0.1:${guarded.port}/`,
		bearer: async () => "minted",
	}).search(null, null, seller);
	expect(bearer).toBe("Bearer minted");
	guarded.stop(true);
});

test("one deadline covers the token as well as the request: a token provider that never answers is a reason, in time", async () => {
	let called = false;
	const listening = Bun.serve({
		port: 0,
		fetch: () => {
			called = true;
			return Response.json({ items: [] });
		},
	});
	const stuck = httpRecordsSource({
		url: `http://127.0.0.1:${listening.port}`,
		deadlineMs: 50,
		bearer: () => new Promise<string>(() => {}),
	});
	const started = performance.now();
	const failure = await stuck.search(null, null, seller).catch((e) => e);
	expect(failure).toBeInstanceOf(RecordsUnavailable);
	expect((failure as Error).message).toContain("did not answer within 50 ms");
	expect(performance.now() - started).toBeLessThan(1000);
	expect(called).toBe(false);
	listening.stop(true);
});

test("the tools answer through the business system as through the sample", async () => {
	const found = await lookupRecord({ kind: "project", name: "ledger" }, seller);
	expect(found.found && found.record.id).toBe("ledger-migration");
	const chart = await metrics(
		{ record: { kind: "customer", id: "oakline-retail" }, measure: "revenue" },
		seller,
	);
	expect(chart.found).toBe(true);
	expect(
		await metrics(
			{
				record: { kind: "customer", id: "oakline-retail" },
				measure: "revenue",
			},
			engineer,
		),
	).toEqual({ found: false, measures: [] });
});

test("the stage's routes read the business system as the account the gate read, and a system that does not answer is a 503", async () => {
	const untouched = new Proxy({} as AgentHost, {
		get(_, key) {
			throw new Error(`the host must not be reached here (${String(key)})`);
		},
	});
	const app = createApp({
		host: untouched,
		product,
		broker: idleBroker(untouched),
	});
	const customers = await call(app, "GET", "/records?kind=customer", {
		as: "owner-a",
	});
	expect(await customers.json()).toEqual({ records: [] });
	expect(standIn.seen.at(-1)).toMatchObject({ oid: "owner-a" });
	expect(
		(
			await call(app, "GET", "/records/customer/oakline-retail", {
				as: "owner-a",
			})
		).status,
	).toBe(404);
	const card = await call(app, "GET", "/records/project/ledger-migration", {
		as: "owner-a",
	});
	expect(card.status).toBe(200);
	expect(
		((await card.json()) as { links: { kind: string }[] }).links.map(
			(l) => l.kind,
		),
	).not.toContain("customer");

	const restoreDown = scopedEnv({ RECORDS_API_URL: "http://127.0.0.1:9" });
	resetSingleton(SOURCE_KEY);
	try {
		const down = await call(app, "GET", "/records", { as: "owner-a" });
		expect(down.status).toBe(503);
		expect(await down.json()).toEqual({ code: "unavailable" });
	} finally {
		restoreDown();
		resetSingleton(SOURCE_KEY);
	}
});
