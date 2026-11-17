import { expect, test } from "bun:test";
import { series } from "../sample/metrics";
import { QUARTERS, RECORD_KINDS, SAMPLE_RECORDS } from "../sample/records";
import { listRecords } from "./list-records";
import { lookupRecord } from "./lookup-record";
import { metrics } from "./metrics";

test("the sample is a dozen records of four kinds, every link resolves, and every figure covers every quarter", async () => {
	expect(SAMPLE_RECORDS.length).toBe(12);
	for (const kind of RECORD_KINDS)
		expect(SAMPLE_RECORDS.filter((r) => r.kind === kind).length).toBe(3);
	for (const record of SAMPLE_RECORDS) {
		for (const link of record.links)
			expect(
				(await lookupRecord({ kind: link.kind, id: link.id }, null)).found,
			).toBe(true);
		for (const values of Object.values(record.figures))
			expect(values.length).toBe(QUARTERS.length);
	}
});

test("lookupRecord answers the card by id or by an unambiguous name, else the nearest records", async () => {
	const byId = await lookupRecord(
		{ kind: "project", id: "ledger-migration" },
		null,
	);
	if (!byId.found) throw new Error("not found");
	expect(byId.record).toMatchObject({
		kind: "project",
		id: "ledger-migration",
		name: "Ledger Migration",
	});
	expect(byId.record.fields[0]).toEqual({
		label: "Status",
		value: "In progress",
	});
	expect(byId.record.links).toContainEqual({
		kind: "customer",
		id: "oakline-retail",
		name: "Oakline Retail",
	});
	expect(byId.measures).toEqual([
		{ key: "spend", unit: "kEUR" },
		{ key: "openIssues", unit: "issues" },
	]);

	const byName = await lookupRecord(
		{ kind: "customer", name: "halvard" },
		null,
	);
	expect(byName.found && byName.record.id).toBe("halvard-logistics");

	const missing = await lookupRecord({ kind: "asset", id: "nope" }, null);
	expect(missing.found).toBe(false);
	if (!missing.found) {
		expect(missing.nearest.map((r) => r.kind)).toEqual([
			"asset",
			"asset",
			"asset",
		]);
		expect(missing.nearest[0]).toMatchObject({
			id: "data-hall-2",
			summary: "Type: Facility · Location: Rotterdam",
		});
	}
});

test("listRecords filters by kind and by a query over names and fields", async () => {
	expect((await listRecords({}, null)).records.length).toBe(12);
	expect(
		(await listRecords({ kind: "person" }, null)).records.map((r) => r.id),
	).toEqual(["mara-lindqvist", "tobias-achterberg", "ines-valverde"]);
	expect(
		(
			await listRecords({ kind: "customer", query: "enterprise" }, null)
		).records.map((r) => r.name),
	).toEqual(["Halvard Logistics", "Oakline Retail"]);
	expect(
		(await listRecords({ query: "rotterdam" }, null)).records.map(
			(r) => r.kind,
		),
	).toEqual(["person", "asset"]);
});

test("metrics answers a series in the chart's shape per quarter, rolls a year up by the measure's rule, and names the measures it does keep", async () => {
	const quarterly = await metrics(
		{
			record: { kind: "customer", id: "halvard-logistics" },
			measure: "revenue",
		},
		null,
	);
	if (!quarterly.found) throw new Error("not found");
	expect(quarterly.chart.title).toBe("Halvard Logistics — revenue");
	expect(quarterly.chart.unit).toBe("kEUR");
	expect(quarterly.chart.series[0]?.name).toBe("Halvard Logistics");
	expect(quarterly.chart.series[0]?.points.length).toBe(8);
	expect(quarterly.chart.series[0]?.points[0]).toEqual({
		x: "2024-Q1",
		y: 310,
	});

	const yearly = await metrics(
		{
			record: { kind: "customer", id: "halvard-logistics" },
			measure: "revenue",
			period: "year",
		},
		null,
	);
	expect(yearly.found && yearly.chart.series[0]?.points).toEqual([
		{ x: "2024", y: 1295 },
		{ x: "2025", y: 1480 },
	]);
	const averaged = await metrics(
		{
			record: { kind: "asset", id: "data-hall-2" },
			measure: "uptime",
			period: "year",
		},
		null,
	);
	expect(averaged.found && averaged.chart.series[0]?.points[0]).toEqual({
		x: "2024",
		y: 99.93,
	});

	const unknown = await metrics(
		{
			record: { kind: "asset", id: "data-hall-2" },
			measure: "revenue",
		},
		null,
	);
	expect(unknown).toEqual({
		found: false,
		measures: [
			{ key: "uptime", unit: "%" },
			{ key: "runningCost", unit: "kEUR" },
		],
	});
	expect(
		await metrics(
			{ record: { kind: "person", id: "nobody" }, measure: "x" },
			null,
		),
	).toEqual({
		found: false,
		measures: [],
	});
});

test("a quarter the record keeps no figure for is null, not zero, and a real zero stays zero", () => {
	// Five quarters of eight, as a business system may answer: the first is a real 0.
	const record = {
		kind: "customer" as const,
		id: "partial",
		name: "Partial",
		fields: [],
		links: [],
		figures: { revenue: [0, 10, 20, 30, 40] },
	};
	expect(series(record, "revenue")?.series[0]?.points.map((p) => p.y)).toEqual([
		0,
		10,
		20,
		30,
		40,
		null,
		null,
		null,
	]);
	// A year missing a quarter of a measure that adds up has no total.
	expect(series(record, "revenue", "year")?.series[0]?.points).toEqual([
		{ x: "2024", y: 60 },
		{ x: "2025", y: null },
	]);
});
