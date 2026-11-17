import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
	type AbstractIntlMessages,
	createTranslator,
	NextIntlClientProvider,
} from "next-intl";
import { renderToStaticMarkup } from "react-dom/server";
import { measureNames } from "@/src/stage/measure-names";
import {
	type ChartSpec,
	type Instrument,
	type RecordView,
	reduceStage,
	type Stage,
} from "@/src/stage/stage";
import { chartMeasure, stageToolHandlers } from "@/src/stage/tools";
import en from "../../../messages/en.json";
import { RecordCard } from "./RecordCard";
import { StagePanel } from "./StagePanel";
import { type StageActions, StageActionsProvider } from "./stage-actions";

/** The catalogue as the app's provider reads it: untyped, so a key is any string. */
const messages = en as unknown as AbstractIntlMessages;

const ada: RecordView = {
	kind: "person",
	id: "p1",
	name: "Ada Quill",
	fields: [{ label: "Role", value: "Engineer" }],
	links: [{ kind: "project", id: "pr1", name: "Ledger" }],
	measures: [
		{ key: "billableHours", unit: "hours" },
		{ key: "utilisation", unit: "%" },
	],
};

const hours: ChartSpec = {
	title: "Ada Quill — billable hours",
	unit: "hours",
	series: [{ name: "Ada Quill", points: [{ x: "2024-Q1", y: 410 }] }],
};

/**
 * A workspace's worth of stage around one card: the real tool handlers,
 * the measure action built the way the workspace builds it — the metrics
 * read, then the `showChart` handler — and the stage drawn by the panel.
 */
function workspace() {
	let stage: Stage = [];
	const handlers = stageToolHandlers({
		dispatch: (action) => {
			stage = reduceStage(stage, action);
		},
		library: async () => ({ documents: [], truncated: false }),
		document: async () => null,
		record: async () => null,
		records: async () => [],
		suggest: () => {},
	});
	const asked: string[] = [];
	const pending: Promise<void>[] = [];
	const actions: Partial<StageActions> = {
		showMeasure: (kind, id, measure) => {
			asked.push(`${kind}/${id}/${measure}`);
			pending.push(
				chartMeasure(
					handlers,
					async (_kind, _id, key) => (key === "billableHours" ? hours : null),
					kind,
					id,
					measure,
					undefined,
					measureNames(
						createTranslator({
							locale: "en",
							messages,
							namespace: "record",
						}),
					),
				),
			);
		},
	};
	const render = (node: React.ReactNode) =>
		renderToStaticMarkup(
			<NextIntlClientProvider locale="en" messages={en} timeZone="UTC">
				<StageActionsProvider value={actions as StageActions}>
					{node}
				</StageActionsProvider>
			</NextIntlClientProvider>,
		);
	return {
		actions: actions as StageActions,
		asked,
		stage: () => stage as Instrument[],
		settled: () => Promise.all(pending),
		card: () => render(<RecordCard record={ada} />),
		panel: () => render(<StagePanel stage={stage} />),
	};
}

/** A server render has no document; an earlier file's stub must not make it one. */
let savedDocument: PropertyDescriptor | undefined;
beforeAll(() => {
	savedDocument = Object.getOwnPropertyDescriptor(globalThis, "document");
	delete (globalThis as { document?: unknown }).document;
});
afterAll(() => {
	if (savedDocument)
		Object.defineProperty(globalThis, "document", savedDocument);
});

describe("the record card's figures", () => {
	test("are one chip per measure the record keeps, by the measure's name in the person's language with the unit beside", () => {
		const out = workspace().card();
		expect(out).toContain(`<p class="eyebrow">${en.record.measures}</p>`);
		const chips = out.match(
			/<button[^>]*class="chip record-measure"[^>]*>.*?<\/button>/g,
		);
		expect(chips).toHaveLength(2);
		expect(chips?.[0]).toContain(
			`<span>${en.record.measureNames.billableHours}</span><span class="chip-kind">${en.record.units.hours}</span>`,
		);
		expect(chips?.[1]).toContain(
			`<span>Utilization</span><span class="chip-kind">%</span>`,
		);
		// A card that names no measures draws no figures block.
		const bare = renderToStaticMarkup(
			<NextIntlClientProvider locale="en" messages={en} timeZone="UTC">
				<RecordCard record={{ ...ada, measures: undefined }} />
			</NextIntlClientProvider>,
		);
		expect(bare).not.toContain(en.record.measures);
	});

	test("pressed, a chip puts that measure's chart on the stage through the same handler the agent's showChart runs", async () => {
		const w = workspace();
		expect(w.panel()).not.toContain('class="chart-tile"');
		w.actions.showMeasure("person", "p1", "billableHours");
		await w.settled();
		expect(w.asked).toEqual(["person/p1/billableHours"]);
		// Titled with the name the chip shows, never the key the backend reads.
		expect(w.stage()).toMatchObject([
			{
				section: "chart",
				chart: { ...hours, title: "Ada Quill — Billable hours" },
			},
		]);
		const out = w.panel();
		expect(out).toContain('class="chart-tile"');
		expect(out).toContain("Ada Quill — Billable hours");
		expect(out).not.toContain("billableHours");
		// A measure the record does not keep places nothing.
		w.actions.showMeasure("person", "p1", "uptime");
		await w.settled();
		expect(w.stage()).toHaveLength(1);
	});
});
