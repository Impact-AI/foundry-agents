import { expect, test } from "bun:test";
import { liveContextLines, renderContextLines } from "./live-context";
import type { Instrument } from "./stage";

const stage: Instrument[] = [
	{
		section: "library",
		query: "onboarding",
		tags: ["people"],
		documents: [
			{ id: "d1", title: "Onboarding handbook", summary: "", tags: [] },
			{ id: "d2", title: "First week checklist", summary: "", tags: [] },
		],
	},
	{
		section: "reader",
		document: {
			id: "d1",
			title: "Onboarding handbook",
			summary: "",
			tags: [],
			sections: Array.from({ length: 9 }, () => ({ heading: "h", text: "t" })),
			media: [],
		},
		page: 2,
	},
	{
		section: "media",
		item: {
			url: "https://media.example/a.png",
			title: "The office",
		},
	},
	{
		section: "chart",
		chart: {
			title: "Revenue by quarter",
			unit: "kEUR",
			series: [
				{ name: "2025", points: [{ x: "Q1", y: 1 }] },
				{ name: "2026", points: [{ x: "Q1", y: 2 }] },
			],
		},
	},
	{
		section: "record",
		record: {
			kind: "person",
			id: "p1",
			name: "Ada Quill",
			fields: [],
			links: [],
		},
	},
	{
		section: "records",
		kind: "project",
		query: "ledger",
		records: [
			{ kind: "project", id: "pr1", name: "Ledger Migration", summary: "" },
		],
	},
];

test("an empty stage says so, in one line", () => {
	expect(liveContextLines([])).toEqual([
		{ label: "stage.empty", value: "nothing is on the stage" },
	]);
});

test("every section is one `stage.<section>: <line>` line, in placement order", () => {
	expect(renderContextLines(liveContextLines(stage)).split("\n")).toEqual([
		'stage.library: 2 documents for "onboarding" tagged people: "Onboarding handbook", "First week checklist"',
		'stage.reader: "Onboarding handbook", page 2 of 9',
		'stage.media: image "The office"',
		'stage.chart: "Revenue by quarter" — 2025, 2026 in kEUR',
		'stage.record: person "Ada Quill"',
		'stage.records: 1 record of kind project for "ledger": "Ledger Migration"',
	]);
});
