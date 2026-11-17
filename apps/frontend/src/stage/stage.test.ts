import { describe, expect, test } from "bun:test";
import {
	type ChartSpec,
	type Instrument,
	librarySearch,
	pageCount,
	placeInstrument,
	type ReaderDocument,
	reduceStage,
	removeInstrument,
	STAGE_CAPACITY,
	stageChange,
} from "./stage";

const document: ReaderDocument = {
	id: "d1",
	title: "Onboarding handbook",
	summary: "How a new colleague's first weeks go.",
	tags: ["people"],
	sections: Array.from({ length: 9 }, (_, i) => ({
		heading: `Section ${i + 1}`,
		text: "…",
	})),
	media: [],
};

const chart = (title: string): Instrument => ({
	section: "chart",
	chart: { title, series: [{ name: "a", points: [{ x: "Q1", y: 1 }] }] },
});

const reader = (page: number): Instrument => ({
	section: "reader",
	document,
	page,
});

describe("placing", () => {
	test("a section replaces itself in place", () => {
		const stage = placeInstrument(
			[chart("Revenue"), { section: "media", item: { url: "https://x/a" } }],
			chart("Headcount"),
		);
		expect(stage.map((i) => i.section)).toEqual(["chart", "media"]);
		expect(
			(stage[0] as Extract<Instrument, { section: "chart" }>).chart.title,
		).toBe("Headcount");
	});

	test("a new section appends, and the oldest gives way past capacity", () => {
		let stage: Instrument[] = [];
		const all: Instrument[] = [
			{ section: "library", query: "q", tags: [], documents: [] },
			reader(1),
			{ section: "media", item: { url: "https://x/a" } },
			chart("c"),
			{
				section: "record",
				record: {
					kind: "person",
					id: "p1",
					name: "Ada",
					fields: [],
					links: [],
				},
			},
		];
		for (const i of all) stage = placeInstrument(stage, i);
		expect(stage.length).toBe(STAGE_CAPACITY);
		expect(stage.map((i) => i.section)).toEqual([
			"reader",
			"media",
			"chart",
			"record",
		]);
	});

	test("a reader's page is clamped to the document", () => {
		expect(pageCount(document)).toBe(9);
		expect((placeInstrument([], reader(40))[0] as { page: number }).page).toBe(
			9,
		);
		expect((placeInstrument([], reader(0))[0] as { page: number }).page).toBe(
			1,
		);
		expect(
			(placeInstrument([], reader(Number.NaN))[0] as { page: number }).page,
		).toBe(1);
		const bare = { ...document, sections: [] };
		expect(
			(
				placeInstrument([], {
					section: "reader",
					document: bare,
					page: 3,
				})[0] as {
					page: number;
				}
			).page,
		).toBe(1);
	});
});

describe("the reducer", () => {
	const stage = [chart("c"), reader(2)];

	test("clears one section or all", () => {
		expect(
			reduceStage(stage, { type: "clear", section: "chart" }).map(
				(i) => i.section,
			),
		).toEqual(["reader"]);
		expect(reduceStage(stage, { type: "clear" })).toEqual([]);
		expect(removeInstrument(stage, "media")).toEqual(stage);
	});

	test("turns the reader's page and leaves the rest alone", () => {
		const pages = (s: Instrument[]) =>
			s.map((i) => (i.section === "reader" ? i.page : i.section));
		expect(pages(reduceStage(stage, { type: "page", page: 5 }))).toEqual([
			"chart",
			5,
		]);
		expect(pages(reduceStage(stage, { type: "page", page: 99 }))).toEqual([
			"chart",
			9,
		]);
	});

	test("a place through the reducer is a place", () => {
		const spec: ChartSpec = { title: "x", series: [{ name: "s", points: [] }] };
		const next = reduceStage([], {
			type: "place",
			instrument: { section: "chart", chart: spec },
		});
		expect(next).toEqual([{ section: "chart", chart: spec }]);
	});
});

test("a library search is the query and each tag, or nothing when it asks for everything", () => {
	expect(librarySearch("", [])).toBe("");
	expect(librarySearch("first week", [])).toBe("?query=first+week");
	expect(librarySearch("", ["people", "hr"])).toBe("?tags=people&tags=hr");
	expect(librarySearch("a&b", ["x"])).toBe("?query=a%26b&tags=x");
});

describe("what a change of the stage is said to have done", () => {
	test("a tile that arrives is placed, one that goes is removed, and the ones that stay are neither", () => {
		const one = placeInstrument([], reader(1));
		const two = placeInstrument(one, chart("Revenue"));
		expect(stageChange([], one)).toEqual({ placed: ["reader"], removed: [] });
		expect(stageChange(one, two)).toEqual({ placed: ["chart"], removed: [] });
		expect(stageChange(two, removeInstrument(two, "reader"))).toEqual({
			placed: [],
			removed: ["reader"],
		});
		expect(stageChange(two, [])).toEqual({
			placed: [],
			removed: ["reader", "chart"],
		});
		expect(stageChange(two, two)).toEqual({ placed: [], removed: [] });
	});

	test("a section that shows another thing is placed again; a reader turning its page is not", () => {
		const stage = placeInstrument(
			placeInstrument([], reader(1)),
			chart("Revenue"),
		);
		expect(
			stageChange(stage, placeInstrument(stage, chart("Headcount"))),
		).toEqual({ placed: ["chart"], removed: [] });
		expect(
			stageChange(stage, reduceStage(stage, { type: "page", page: 3 })),
		).toEqual({ placed: [], removed: [] });
	});
});
