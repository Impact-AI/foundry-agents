import { describe, expect, test } from "bun:test";
import { FOLLOW_UP_CUE } from "@platform/prompt";
import {
	type ChartSpec,
	type Instrument,
	type LibraryDocument,
	type ReaderDocument,
	type RecordSummary,
	type RecordView,
	reduceStage,
	type StageAction,
} from "./stage";
import {
	chartMeasure,
	readChart,
	readMediaItem,
	runStageTool,
	StageReadFailed,
	safeMediaUrl,
	stageToolHandlers,
} from "./tools";

const handbook: ReaderDocument = {
	id: "d1",
	title: "Onboarding handbook",
	summary: "s",
	tags: [],
	sections: [
		{ heading: "Welcome", text: "…" },
		{ heading: "Week one", text: "…" },
	],
	media: [],
};

const ada: RecordView = {
	kind: "person",
	id: "p1",
	name: "Ada Quill",
	fields: [{ label: "Role", value: "Engineer" }],
	links: [],
	measures: [{ key: "billableHours", unit: "hours" }],
};

const onFile: RecordSummary[] = [
	{ kind: "person", id: "p1", name: "Ada Quill", summary: "Role: Engineer" },
	{ kind: "project", id: "pr1", name: "Ledger", summary: "Status: Open" },
];

function harness() {
	let stage: Instrument[] = [];
	const actions: StageAction[] = [];
	const suggested: string[][] = [];
	const handlers = stageToolHandlers({
		dispatch: (action) => {
			actions.push(action);
			stage = reduceStage(stage, action);
		},
		library: async (query, tags) => ({
			documents:
				query === "nothing"
					? []
					: ([
							{ id: "d1", title: "Onboarding handbook", summary: "s", tags },
						] satisfies LibraryDocument[]),
			truncated: tags.includes("cut-short"),
		}),
		document: async (id) => (id === "d1" ? handbook : null),
		record: async (kind, id) => (kind === "person" && id === "p1" ? ada : null),
		records: async (kind, query) =>
			onFile.filter(
				(r) =>
					(!kind || r.kind === kind) &&
					(!query || r.name.toLowerCase().includes(query.toLowerCase())),
			),
		suggest: (options) => suggested.push(options),
	});
	return { handlers, stage: () => stage, actions, suggested };
}

describe("each tool mutates the stage and answers the status with the cue", () => {
	test("showLibrary", async () => {
		const h = harness();
		const answer = await h.handlers.showLibrary({
			query: "onboarding",
			tags: ["people"],
		});
		expect(answer).toBe(
			`Library on stage: 1 document for 'onboarding'. ${FOLLOW_UP_CUE}`,
		);
		expect(h.stage()).toMatchObject([
			{ section: "library", query: "onboarding", tags: ["people"] },
		]);
		expect(await h.handlers.showLibrary({ query: "nothing" })).toBe(
			`Library on stage: 0 documents for 'nothing'. ${FOLLOW_UP_CUE}`,
		);
	});

	test("the whole catalogue is called whole only when it is: a list cut short is said to be the first of more", async () => {
		const h = harness();
		expect(await h.handlers.showLibrary({})).toBe(
			`Library on stage: all 1 document the person may read. ${FOLLOW_UP_CUE}`,
		);
		const partial = await h.handlers.showLibrary({ tags: ["cut-short"] });
		expect(partial).toStartWith(
			"Library on stage: the first 1 document the person may read. The library holds more than this list shows",
		);
		expect(partial).not.toContain("all 1 document");
	});

	test("openDocument, at a page", async () => {
		const h = harness();
		expect(await h.handlers.openDocument({ id: "d1", page: 2 })).toBe(
			`Reader on stage: Onboarding handbook. ${FOLLOW_UP_CUE}`,
		);
		expect(h.stage()).toMatchObject([{ section: "reader", page: 2 }]);
		expect(await h.handlers.openDocument({ id: "nope" })).toBe(
			"No document with id 'nope' was found.",
		);
		expect(await h.handlers.openDocument({})).toBe("No document id was given.");
		expect(h.stage()).toHaveLength(1);
	});

	test("presentContent", async () => {
		const h = harness();
		expect(
			await h.handlers.presentContent({
				url: "/api/media/a/images/office.png",
				title: "The office",
			}),
		).toBe(`On stage: The office. ${FOLLOW_UP_CUE}`);
		expect(h.stage()).toMatchObject([
			{
				section: "media",
				item: { url: "/api/media/a/images/office.png", title: "The office" },
			},
		]);
		expect(
			await h.handlers.presentContent({ url: "javascript:alert(1)" }),
		).toBe(
			"That picture could not be shown: it needs the picture's own path in the library, starting with /api/media/, as a search result or a document gives it.",
		);
	});

	test("showChart", async () => {
		const h = harness();
		expect(
			await h.handlers.showChart({
				title: "Revenue",
				unit: "kEUR",
				series: [
					{
						name: "2026",
						points: [
							{ x: "Q1", y: 10 },
							{ x: "Q2", y: "12" },
						],
					},
				],
			}),
		).toBe(`Chart on stage: Revenue. ${FOLLOW_UP_CUE}`);
		expect(h.stage()).toMatchObject([
			{ section: "chart", chart: { title: "Revenue", unit: "kEUR" } },
		]);
		expect(await h.handlers.showChart({ title: "x", series: [] })).toContain(
			"could not be drawn",
		);
	});

	test("showRecord", async () => {
		const h = harness();
		expect(await h.handlers.showRecord({ kind: "person", id: "p1" })).toBe(
			`Record on stage: Ada Quill. ${FOLLOW_UP_CUE}`,
		);
		expect(h.stage()).toMatchObject([
			{ section: "record", record: { name: "Ada Quill" } },
		]);
		expect(await h.handlers.showRecord({ kind: "robot", id: "p1" })).toContain(
			"needs a kind",
		);
		expect(await h.handlers.showRecord({ kind: "project", id: "zz" })).toBe(
			"No project with id 'zz' was found.",
		);
	});

	test("showRecords, every record or a kind and a query, as the person's Records mark and the agent both call it", async () => {
		const h = harness();
		expect(await h.handlers.showRecords({})).toBe(
			`Records on stage: all 2 records. ${FOLLOW_UP_CUE}`,
		);
		expect(h.stage()).toMatchObject([
			{ section: "records", kind: null, query: "", records: onFile },
		]);
		expect(
			await h.handlers.showRecords({ kind: "project", query: "ledg" }),
		).toBe(
			`Records on stage: 1 record of kind project for 'ledg'. ${FOLLOW_UP_CUE}`,
		);
		expect(h.stage()).toMatchObject([
			{ section: "records", kind: "project", query: "ledg" },
		]);
		// A kind the contract does not name is every kind, never a refusal.
		expect(await h.handlers.showRecords({ kind: "robot", query: "zz" })).toBe(
			`Records on stage: 0 records for 'zz'. ${FOLLOW_UP_CUE}`,
		);
	});

	test("clearStage clears one section or all, with no cue", async () => {
		const h = harness();
		await h.handlers.showRecord({ kind: "person", id: "p1" });
		await h.handlers.openDocument({ id: "d1" });
		expect(await h.handlers.clearStage({ section: "record" })).toBe(
			"Stage cleared.",
		);
		expect(h.stage().map((i) => i.section)).toEqual(["reader"]);
		expect(await h.handlers.clearStage({ section: "elsewhere" })).toBe(
			"Stage cleared.",
		);
		expect(h.stage()).toEqual([]);
	});

	test("suggestNext hands over three short options and answers nothing", async () => {
		const h = harness();
		expect(
			await h.handlers.suggestNext({
				options: ["Open it", " Show the team ", "", "Four", 5],
			}),
		).toBe("");
		expect(h.suggested).toEqual([["Open it", "Show the team", "Four"]]);
		expect(h.stage()).toEqual([]);
	});
});

describe("a record's measure by hand", () => {
	const revenue: ChartSpec = {
		title: "Ada Quill — billable hours",
		unit: "hours",
		series: [{ name: "Ada Quill", points: [{ x: "2024-Q1", y: 410 }] }],
	};

	test("places the metrics route's series through the showChart handler, and nothing when the record keeps no such measure", async () => {
		const h = harness();
		const asked: string[] = [];
		const metrics = async (kind: string, id: string, measure: string) => {
			asked.push(`${kind}/${id}/${measure}`);
			return measure === "billableHours" ? revenue : null;
		};
		await chartMeasure(h.handlers, metrics, "person", "p1", "billableHours");
		expect(h.stage()).toMatchObject([{ section: "chart", chart: revenue }]);
		await chartMeasure(h.handlers, metrics, "person", "p1", "uptime");
		expect(asked).toEqual(["person/p1/billableHours", "person/p1/uptime"]);
		expect(h.stage()).toHaveLength(1);
	});

	test("given the card's names, titles the chart and gives its unit in them", async () => {
		const h = harness();
		await chartMeasure(
			h.handlers,
			async () => revenue,
			"person",
			"p1",
			"billableHours",
			undefined,
			{ label: (key) => `<${key}>`, unit: (unit) => `[${unit}]` },
		);
		expect(h.stage()).toMatchObject([
			{
				section: "chart",
				chart: { title: "Ada Quill — <billableHours>", unit: "[hours]" },
			},
		]);
	});
});

describe("a call by name, as the live session makes it", () => {
	test("reaches the handler, and an unknown or failing tool is still answered", async () => {
		const h = harness();
		expect(
			await runStageTool(h.handlers, "showRecord", {
				kind: "person",
				id: "p1",
			}),
		).toContain("Record on stage");
		expect(await runStageTool(h.handlers, "launchRocket", {})).toBe(
			"There is no tool called 'launchRocket'.",
		);
		const failing = {
			...h.handlers,
			showChart: async () => {
				throw new Error("boom");
			},
		};
		expect(await runStageTool(failing, "showChart", {})).toBe(
			"showChart failed; nothing changed on the stage.",
		);
	});
});

describe("the readers at the boundary", () => {
	test("only the backend's own paths reach a src", () => {
		expect(safeMediaUrl("https://a.example/x.png")).toBeNull();
		expect(safeMediaUrl("/api/media/abc")).toBe("/api/media/abc");
		expect(safeMediaUrl("//evil.example/x")).toBeNull();
		// A browser reads `\` as `/` and drops tabs and newlines: each is another host.
		expect(safeMediaUrl("/\\evil.example/x.png")).toBeNull();
		expect(safeMediaUrl("/\t/evil.example/x.png")).toBeNull();
		expect(safeMediaUrl("/\n/evil.example/x.png")).toBeNull();
		expect(safeMediaUrl("http://a.example/x.png")).toBeNull();
		expect(safeMediaUrl("data:text/html,hi")).toBeNull();
		// A `src` is a request made with the session: no other route of this app is one.
		expect(safeMediaUrl("/api/account/export")).toBeNull();
		expect(safeMediaUrl("/api/media/../account/export")).toBeNull();
		// A picture is all the stage shows: a `type` the model still sends changes nothing.
		expect(
			readMediaItem({ url: "/api/media/x", type: "video", caption: "c" }),
		).toEqual({ url: "/api/media/x", caption: "c" });
	});

	test("a chart keeps only finite points and named series, and a null as a gap, never a zero", () => {
		expect(
			readChart({
				title: "t",
				series: [
					{
						name: "a",
						points: [
							{ x: "Q1", y: "nope" },
							{ x: "Q2", y: 3 },
							{ x: "Q3", y: null },
						],
					},
					{ points: [] },
					{ name: "none", points: [{ x: "Q1", y: null }] },
				],
			}),
		).toEqual({
			title: "t",
			series: [
				{
					name: "a",
					points: [
						{ x: "Q2", y: 3 },
						{ x: "Q3", y: null },
					],
				},
			],
		});
	});
});

test("a chart's values are bounded in size as well as in number: one too large to rule a band with is a missing value", () => {
	const chart = readChart({
		title: "Load",
		series: [
			{
				name: "a",
				points: [
					{ x: "Jan", y: 1e17 },
					{ x: "Feb", y: 12 },
					{ x: "Mar", y: -1e300 },
				],
			},
		],
	});
	expect(chart?.series[0]?.points).toEqual([{ x: "Feb", y: 12 }]);
});

describe("a read that did not come back is a failure, never an empty stage", () => {
	const failing = () => {
		const failed: string[] = [];
		const placed: StageAction[] = [];
		const refuse = async (): Promise<never> => {
			throw new StageReadFailed("backend_unreachable");
		};
		const handlers = stageToolHandlers({
			dispatch: (action) => placed.push(action),
			failed: (code) => failed.push(code),
			library: refuse,
			document: refuse,
			record: refuse,
			records: refuse,
			suggest: () => {},
		});
		return { handlers, failed, placed };
	};

	test("each reading control leaves the stage alone, tells the person, and tells the assistant it did not load", async () => {
		const h = failing();
		const answers = [
			await h.handlers.showLibrary({}),
			await h.handlers.openDocument({ id: "d1" }),
			await h.handlers.showRecord({ kind: "person", id: "p1" }),
			await h.handlers.showRecords({}),
		];
		for (const answer of answers) {
			expect(answer).toContain("could not be read (backend_unreachable)");
			expect(answer).not.toContain("on stage");
			expect(answer).not.toContain("0 ");
		}
		expect(h.placed).toEqual([]);
		expect(h.failed).toEqual(Array(4).fill("backend_unreachable"));
	});

	test("a measure charted by hand says so too", async () => {
		const h = failing();
		const said: string[] = [];
		await chartMeasure(
			h.handlers,
			async () => {
				throw new StageReadFailed("forbidden");
			},
			"person",
			"p1",
			"billableHours",
			(code) => said.push(code),
		);
		expect(said).toEqual(["forbidden"]);
		expect(h.placed).toEqual([]);
	});
});
