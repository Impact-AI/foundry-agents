import { afterAll, expect, test } from "bun:test";
import { resetSingleton } from "@platform/config";
import { scopedEnv } from "@platform/test-support";
import { recordSummary } from "../sample/records";
import { listRecords } from "../tools/list-records";
import { RecordsUnavailable } from "./contract";
import { httpRecordsSource, LIST_MAX, PAGE_SIZE, PAGES_MAX } from "./http";
import {
	displayAmount,
	displayDate,
	NOT_PROVIDED,
	PROJECT_SUMMARY_FIELDS,
	projectMapping,
	statusLabel,
} from "./project-mapping";
import { recordCard } from "./source";
import {
	EXECUTIVES_GROUP,
	RESTRICTED_PROJECT,
	standInArgs,
	startRecordsStandIn,
} from "./standin";

/**
 * A system shaped unlike the app (docs/worked-example.md#mapping-a-real-system):
 * the project API's mapping — names, amounts in minor units, dates, statuses,
 * values it holds none of — and the adapter's paging, its bound, and one
 * deadline across every page, against the stand-in's project API.
 */

const projects = startRecordsStandIn({ system: "projects" });
const source = httpRecordsSource({
	url: projects.url,
	mapping: projectMapping,
});
const staff = { oid: "staff", groups: ["staff"] };
const executive = { oid: "exec", groups: ["staff", EXECUTIVES_GROUP] };

afterAll(() => projects.stop());

/** One record in the stand-in's sample shape, for a system that answers it in bulk. */
const sampleItem = (i: number) => ({
	type: "person",
	key: `person-${i}`,
	title: `Person ${i}`,
	attributes: [],
	related: [],
	quarterly: {},
});

test("the project API's record is mapped field by field: names, amounts, dates, statuses, and a missing value said as missing", () => {
	expect(
		projectMapping.toRecord(
			projectMapping.schema.parse({
				project_number: "P-0001",
				customer_name: "Acme",
				budget_minor: 12_500_000,
				currency: "USD",
				delivery_date: null,
				status: "on_hold",
				reader_groups: ["delivery"],
			}),
		),
	).toEqual({
		kind: "project",
		id: "P-0001",
		name: "P-0001 (Acme)",
		fields: [
			{ label: "Customer", value: "Acme" },
			{ label: "Budget", value: "USD 125,000.00" },
			{ label: "Delivery date", value: NOT_PROVIDED },
			{ label: "Status", value: "On hold" },
		],
		summaryFields: PROJECT_SUMMARY_FIELDS,
		links: [],
		figures: {},
	});

	// Minor units by the currency's own exponent; nothing held is never a zero.
	expect(displayAmount(1999, "EUR")).toBe("EUR 19.99");
	expect(displayAmount(15_000_000, "JPY")).toBe("JPY 15,000,000");
	expect(displayAmount(0, "USD")).toBe("USD 0.00");
	expect(displayAmount(null, "USD")).toBe(NOT_PROVIDED);
	expect(displayDate("2027-03-15")).toBe("March 15, 2027");
	expect(displayDate(null)).toBe(NOT_PROVIDED);
	expect(statusLabel("closed")).toBe("Closed");
	expect(statusLabel("awaiting_SIGNOFF")).toBe("Awaiting signoff");

	const valid = {
		project_number: "P-1",
		customer_name: null,
		budget_minor: null,
		currency: "USD",
		delivery_date: "2027-01-31",
		status: "active",
	};
	expect(projectMapping.schema.safeParse(valid).success).toBe(true);
	expect(projectMapping.toRecord(projectMapping.schema.parse(valid))).toEqual(
		expect.objectContaining({
			name: "P-1",
			fields: expect.arrayContaining([
				{ label: "Customer", value: NOT_PROVIDED },
				{ label: "Budget", value: NOT_PROVIDED },
			]),
		}),
	);
	for (const wrong of [
		{ delivery_date: "2027-02-30" },
		{ delivery_date: "15/03/2027" },
		{ budget_minor: 12.5 },
		{ currency: "dollars" },
		{ project_number: undefined },
	])
		expect(
			projectMapping.schema.safeParse({ ...valid, ...wrong }).success,
		).toBe(false);
});

test("a listing's line carries the fields the mapping names, in its order, and the first two when it names none", () => {
	const record = projectMapping.toRecord(
		projectMapping.schema.parse({
			project_number: "P-0001",
			customer_name: "Acme",
			budget_minor: 12_500_000,
			currency: "USD",
			delivery_date: "2027-02-15",
			status: "on_hold",
		}),
	);
	expect(recordSummary(record)).toEqual({
		kind: "project",
		id: "P-0001",
		name: "P-0001 (Acme)",
		summary:
			"Status: On hold · Delivery date: February 15, 2027 · Budget: USD 125,000.00",
	});
	// A label the record has no field for is left out, never said as empty.
	expect(
		recordSummary({ ...record, summaryFields: ["Owner", "Status"] }).summary,
	).toBe("Status: On hold");
	expect(recordSummary({ ...record, summaryFields: undefined }).summary).toBe(
		"Customer: Acme · Budget: USD 125,000.00",
	);
});

test("for 200 projects the list tool's answer carries every delivery date and status, so the model can answer by quarter", async () => {
	const answer = await listRecords({ kind: "project" }, staff, source);
	expect(answer.records).toHaveLength(200);
	expect(answer).not.toHaveProperty("truncated");
	for (const line of answer.records) {
		expect(line.summary).toMatch(/^Status: [A-Z]/);
		expect(line.summary).toContain("Delivery date: ");
	}
	const q1 = answer.records.filter((r) =>
		/Delivery date: (January|February|March) \d+, 2027/.test(r.summary),
	);
	// Days in the months 1–3 of 2027: every twelfth project from the 12th, 1st and 2nd (P-0001 has none).
	expect(q1).toHaveLength(49);
	expect(q1.map((r) => r.id)).toContain("P-0012");
	expect(q1.map((r) => r.id)).not.toContain("P-0001");
	// Compact enough for the listing's bound: a line is well under 200 characters.
	expect(JSON.stringify(answer).length).toBeLessThan(200 * 200);
});

test("the project stand-in's q matches the delivery date by its ISO prefix and the status by its code or its words", async () => {
	const january = (await source.search("project", "2027-01", staff)).records;
	expect(january.map((r) => r.id)).toEqual(
		Array.from(
			{ length: 16 },
			(_, i) => `P-${String((i + 1) * 12).padStart(4, "0")}`,
		),
	);
	for (const r of january)
		expect(r.fields).toContainEqual({
			label: "Delivery date",
			value: "January 15, 2027",
		});
	expect((await source.search("project", "2027", staff)).records).toHaveLength(
		199,
	);
	const onHold = (await source.search("project", "on hold", staff)).records;
	expect(onHold.map((r) => r.id)).toEqual(
		(await source.search("project", "on_hold", staff)).records.map((r) => r.id),
	);
	expect(onHold).toHaveLength(7);
	// A date's prefix only: the middle of a date is no match.
	expect((await source.search("project", "-01-", staff)).records).toHaveLength(
		0,
	);
});

test("the stand-in listens on the loopback by default and on the host it is given, as its third argument", async () => {
	expect(standInArgs([])).toEqual({
		port: 4400,
		system: "sample",
		hostname: "127.0.0.1",
	});
	expect(standInArgs(["4401", "projects", "0.0.0.0"])).toEqual({
		port: 4401,
		system: "projects",
		hostname: "0.0.0.0",
	});
	const everywhere = startRecordsStandIn({
		system: "projects",
		hostname: "0.0.0.0",
	});
	try {
		expect(everywhere.url).toStartWith("http://127.0.0.1:");
		const port = new URL(everywhere.url).port;
		const page = await fetch(`http://localhost:${port}/records?limit=1`);
		expect(((await page.json()) as { items: unknown[] }).items).toHaveLength(1);
	} finally {
		everywhere.stop();
	}
});

test("a listing follows the system's pages to the end, each asked for once and in order", async () => {
	const before = projects.seen.length;
	const listing = await source.search("project", null, staff);
	expect(listing.truncated).toBe(false);
	expect(listing.records).toHaveLength(200);
	expect(new Set(listing.records.map((r) => r.id)).size).toBe(200);
	expect(listing.records[50]?.id).toBe("P-0051");
	expect(projects.seen.slice(before).map((s) => s.cursor ?? null)).toEqual([
		null,
		"50",
		"100",
		"150",
	]);
	// The caller goes with every page, not only the first.
	expect(
		projects.seen.slice(before).every((s) => s.oid === "staff"),
	).toBeTrue();

	const first = listing.records[0];
	if (!first) throw new Error("no first project");
	expect(first.fields).toContainEqual({
		label: "Delivery date",
		value: NOT_PROVIDED,
	});
	expect(listing.records[2]?.fields).toContainEqual({
		label: "Budget",
		value: NOT_PROVIDED,
	});
	expect(listing.records[6]?.fields).toContainEqual({
		label: "Budget",
		value: "JPY 15,000,000",
	});
	// A record that keeps no figures offers no chart to open.
	expect((await recordCard(source, first, staff)).measures).toEqual([]);

	const acme = await source.search(null, "acme", staff);
	expect(acme.records).toHaveLength(100);
	expect(acme.records.every((r) => r.name.endsWith("(Acme)"))).toBeTrue();
	expect(await source.search("person", null, staff)).toEqual({
		records: [],
		truncated: false,
	});
});

test("the restricted project is invisible to a caller outside its reader group, listed or asked for by number", async () => {
	expect(await source.find("project", RESTRICTED_PROJECT, staff)).toBeNull();
	expect(await source.find("project", RESTRICTED_PROJECT, null)).toBeNull();
	expect(
		(await source.search(null, RESTRICTED_PROJECT, staff)).records,
	).toEqual([]);
	expect(
		(await source.search("project", null, staff)).records.map((r) => r.id),
	).not.toContain(RESTRICTED_PROJECT);

	const found = await source.find("project", RESTRICTED_PROJECT, executive);
	expect(found?.name).toBe(`${RESTRICTED_PROJECT} (Restricted Holdings)`);
	expect(
		(await source.search("project", null, executive)).records,
	).toHaveLength(201);
	expect(await source.find("project", "P-0042", staff)).toMatchObject({
		id: "P-0042",
	});
});

test("a listing stops at its bound and says it is partial, instead of refusing the whole question", async () => {
	const many = startRecordsStandIn({ system: "projects", projects: 520 });
	try {
		const bounded = httpRecordsSource({
			url: many.url,
			mapping: projectMapping,
		});
		const listing = await bounded.search("project", null, staff);
		expect(listing.truncated).toBe(true);
		expect(listing.records).toHaveLength(LIST_MAX);
		expect(many.seen).toHaveLength(LIST_MAX / PAGE_SIZE);
	} finally {
		many.stop();
	}

	// A system that answers a `next` with every page, however empty, still stops.
	let asked = 0;
	const endless = Bun.serve({
		port: 0,
		fetch: () => {
			asked++;
			return Response.json({ items: [], next: `page-${asked}` });
		},
	});
	try {
		const listing = await httpRecordsSource({
			url: `http://127.0.0.1:${endless.port}`,
		}).search(null, null, staff);
		expect(listing).toEqual({ records: [], truncated: true });
		expect(asked).toBe(PAGES_MAX);
	} finally {
		endless.stop(true);
	}
});

test("a system that does not page answers one page with no next, and that page is the whole listing, up to the bound", async () => {
	let size = 80;
	const unpaged = Bun.serve({
		port: 0,
		fetch: () =>
			Response.json({
				items: Array.from({ length: size }, (_, i) => sampleItem(i)),
			}),
	});
	try {
		const plain = httpRecordsSource({
			url: `http://127.0.0.1:${unpaged.port}`,
		});
		const listing = await plain.search(null, null, staff);
		expect(listing.truncated).toBe(false);
		expect(listing.records).toHaveLength(80);

		size = 600;
		const over = await plain.search(null, null, staff);
		expect(over.truncated).toBe(true);
		expect(over.records).toHaveLength(LIST_MAX);
	} finally {
		unpaged.stop(true);
	}
});

test("the tool tells the model a listing is partial, and says nothing of it when it is whole", async () => {
	const bulk = Bun.serve({
		port: 0,
		fetch: (r) =>
			Response.json({
				items: Array.from(
					{ length: new URL(r.url).searchParams.get("q") ? 3 : 600 },
					(_, i) => sampleItem(i),
				),
			}),
	});
	const restore = scopedEnv({
		RECORDS_API_URL: `http://127.0.0.1:${bulk.port}`,
		RECORDS_API_SCOPE: undefined,
	});
	resetSingleton("product:records-source");
	try {
		const partial = await listRecords({}, staff);
		expect(partial.truncated).toBe(true);
		expect(partial.records).toHaveLength(LIST_MAX);
		expect(await listRecords({ query: "person" }, staff)).not.toHaveProperty(
			"truncated",
		);
	} finally {
		restore();
		resetSingleton("product:records-source");
		bulk.stop(true);
	}
});

test("one deadline covers every page of a listing and the one token minted for it", async () => {
	const slow = startRecordsStandIn({ system: "projects", delayMs: 60 });
	let minted = 0;
	const hurried = httpRecordsSource({
		url: slow.url,
		mapping: projectMapping,
		deadlineMs: 150,
		bearer: async () => `token-${++minted}`,
	});
	try {
		// One page fits inside the deadline...
		expect(await hurried.find("project", "P-0002", staff)).toMatchObject({
			id: "P-0002",
		});
		// ...four do not, though each alone would.
		const started = performance.now();
		const failure = await hurried
			.search("project", null, staff)
			.catch((e) => e);
		expect(failure).toBeInstanceOf(RecordsUnavailable);
		expect((failure as Error).message).toContain(
			"did not answer within 150 ms",
		);
		expect(performance.now() - started).toBeLessThan(1000);
		expect(minted).toBe(2);
	} finally {
		slow.stop();
	}

	// Inside the deadline, every page carries the one token minted for the listing.
	const bearers: string[] = [];
	const guarded = Bun.serve({
		port: 0,
		fetch: (r) => {
			bearers.push(r.headers.get("authorization") ?? "");
			const page = Number(new URL(r.url).searchParams.get("cursor") ?? 0);
			return Response.json({
				items: [sampleItem(page)],
				next: page < 2 ? String(page + 1) : null,
			});
		},
	});
	let calls = 0;
	try {
		const listing = await httpRecordsSource({
			url: `http://127.0.0.1:${guarded.port}`,
			bearer: async () => `minted-${++calls}`,
		}).search(null, null, staff);
		expect(listing.records).toHaveLength(3);
		expect(bearers).toEqual([
			"Bearer minted-1",
			"Bearer minted-1",
			"Bearer minted-1",
		]);
	} finally {
		guarded.stop(true);
	}
});
