import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createRequire } from "node:module";
import { NextIntlClientProvider } from "next-intl";
import { renderToStaticMarkup } from "react-dom/server";
import {
	type Instrument,
	type LibraryDocument,
	type RecordSummary,
	reduceStage,
	type Stage,
} from "@/src/stage/stage";
import { stageToolHandlers } from "@/src/stage/tools";
import en from "../../messages/en.json";
import it from "../../messages/it.json";
import { StagePanel } from "../(app)/stage/StagePanel";
import { type StageControls, StageControlsContext } from "./stage-controls";
import { TopBar } from "./TopBar";

/**
 * The router's contexts, resolved the way `next/navigation` resolves them —
 * through `require`. Once any earlier file in the run has loaded Next's
 * server code, its require hook aliases this module to a vendored copy, and
 * a static `import` would hand this file the other one: a provider the
 * hooks never read, and a `useSearchParams()` that is null.
 */
const { PathnameContext, SearchParamsContext } = createRequire(import.meta.url)(
	"next/dist/shared/lib/hooks-client-context.shared-runtime",
) as typeof import("next/dist/shared/lib/hooks-client-context.shared-runtime");

/**
 * The bar as markup, with no DOM: a page under the shell's layout, with or
 * without a stage registered. A press is the control the button carries,
 * called by hand — the only way to press anything in a static render.
 */
const page = (
	pathname: string,
	controls: StageControls | null,
	messages = en,
	locale = "en",
) =>
	renderToStaticMarkup(
		<NextIntlClientProvider locale={locale} messages={messages} timeZone="UTC">
			<PathnameContext.Provider value={pathname}>
				<SearchParamsContext.Provider value={new URLSearchParams()}>
					<StageControlsContext.Provider value={controls}>
						<TopBar name="Ada Quill" />
					</StageControlsContext.Provider>
				</SearchParamsContext.Provider>
			</PathnameContext.Provider>
		</NextIntlClientProvider>,
	);

const libraryButton = (out: string) =>
	out.match(
		/<button[^>]*class="btn btn--ghost btn--sm topbar-library"[^>]*>.*?<\/button>/,
	)?.[0];

const recordsButton = (out: string) =>
	out.match(
		/<button[^>]*class="btn btn--ghost btn--sm topbar-library topbar-records"[^>]*>.*?<\/button>/,
	)?.[0];

const onFile: RecordSummary[] = [
	{ kind: "person", id: "p1", name: "Ada Quill", summary: "Role: Engineer" },
	{ kind: "project", id: "pr1", name: "Ledger", summary: "Status: Open" },
	{ kind: "project", id: "pr2", name: "Rollout", summary: "Status: Closed" },
];

/**
 * A workspace's worth of stage: the real tool handlers over a stubbed
 * library, the controls the bar reads built the way the workspace builds
 * them, and the stage drawn by the panel afterwards.
 */
function workspace() {
	let stage: Stage = [];
	const handlers = stageToolHandlers({
		dispatch: (action) => {
			stage = reduceStage(stage, action);
		},
		library: async (query) => ({
			documents: query
				? []
				: ([
						{ id: "d1", title: "Onboarding handbook", summary: "s", tags: [] },
						{ id: "d2", title: "Expense policy", summary: "s", tags: [] },
					] satisfies LibraryDocument[]),
			truncated: false,
		}),
		document: async () => null,
		record: async () => null,
		records: async (kind, query) => (kind || query ? [] : onFile),
		suggest: () => {},
	});
	const pending: Promise<string>[] = [];
	const controls: StageControls = {
		home: () => {
			stage = [];
		},
		library: () => {
			pending.push(handlers.showLibrary({}));
		},
		records: () => {
			pending.push(handlers.showRecords({}));
		},
		stageUp: false,
	};
	const panel = () =>
		renderToStaticMarkup(
			<NextIntlClientProvider locale="en" messages={en} timeZone="UTC">
				<StagePanel stage={stage} />
			</NextIntlClientProvider>,
		);
	return {
		controls,
		stage: () => stage as Instrument[],
		settled: () => Promise.all(pending),
		panel,
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

describe("the bar's Library mark", () => {
	test("stands on the workspace whenever there is a stage, up or not, in the controls' style with its words as its name", () => {
		const w = workspace();
		const out = page("/chat", w.controls);
		const button = libraryButton(out);
		expect(button).toBeDefined();
		expect(button).toContain('type="button"');
		expect(button).toContain('aria-hidden="true"'); // the glyph is decoration
		expect(button).toContain(
			`<span class="topbar-library-label">${en.workspace.library}</span>`,
		);
		// Nothing on the stage yet, so no way home — but the library is a way in.
		expect(out).not.toContain(`>${en.workspace.home}</button>`);
		expect(
			libraryButton(page("/chat", { ...w.controls, stageUp: true })),
		).toBeDefined();
		expect(page("/chat", w.controls, it, "it")).toContain(
			`>${it.workspace.library}</span>`,
		);
	});

	test("is absent from a room with no stage, as the way home is", () => {
		for (const pathname of ["/settings", "/privacy"]) {
			const out = page(pathname, null);
			expect(libraryButton(out)).toBeUndefined();
			expect(out).not.toContain(en.workspace.home);
		}
	});

	test("pressed, it puts the library tile on the stage with every document", async () => {
		const w = workspace();
		expect(w.panel()).not.toContain('class="library"');
		w.controls.library();
		await w.settled();
		expect(w.stage()).toMatchObject([
			{ section: "library", query: "", tags: [] },
		]);
		const out = w.panel();
		expect(out).toContain('class="library"');
		expect(out).toContain("Onboarding handbook");
		expect(out).toContain("Expense policy");
	});
});

describe("the bar's Records mark", () => {
	test("stands beside the Library mark wherever there is a stage, with its words as its name, and nowhere else", () => {
		const w = workspace();
		const out = page("/chat", w.controls);
		const button = recordsButton(out);
		expect(button).toBeDefined();
		expect(button).toContain('type="button"');
		expect(button).toContain('aria-hidden="true"');
		expect(button).toContain(
			`<span class="topbar-library-label">${en.workspace.records}</span>`,
		);
		expect(out.indexOf("topbar-records")).toBeGreaterThan(
			out.indexOf('topbar-library"'),
		);
		expect(
			recordsButton(page("/chat", { ...w.controls, stageUp: true })),
		).toBeDefined();
		expect(page("/chat", w.controls, it, "it")).toContain(
			`>${it.workspace.records}</span>`,
		);
		for (const pathname of ["/settings", "/privacy"])
			expect(recordsButton(page(pathname, null))).toBeUndefined();
	});

	test("pressed, it puts the records tile on the stage with every record, grouped by kind, each a chip that opens the record", async () => {
		const w = workspace();
		expect(w.panel()).not.toContain('class="records"');
		w.controls.records();
		await w.settled();
		expect(w.stage()).toMatchObject([
			{ section: "records", kind: null, query: "", records: onFile },
		]);
		const out = w.panel();
		expect(out).toContain('class="records"');
		expect(out).toContain(`aria-label="${en.stage.sections.records}"`);
		const groups = out.match(/<p class="eyebrow">([^<]+)<\/p>/g) ?? [];
		expect(groups).toEqual([
			`<p class="eyebrow">${en.record.kinds.person}</p>`,
			`<p class="eyebrow">${en.record.kinds.project}</p>`,
		]);
		expect(out.match(/class="chip"/g)).toHaveLength(3);
		expect(out).toContain('title="Role: Engineer">Ada Quill</button>');
		expect(out.indexOf("Ada Quill")).toBeLessThan(out.indexOf("Ledger"));
		expect(out.indexOf("Ledger")).toBeLessThan(out.indexOf("Rollout"));
	});
});
