/**
 * The stage — the workspace's left side as a composition the conversation
 * drives. Every tool the browser registers places one instrument in one of
 * six sections; the stage lays out whatever is on it, in placement order,
 * and a section replaces itself (a second chart is the chart, changed).
 * Pure data, so the tool handlers, the panel and the live context agree on
 * one shape and none of them imports another.
 */

const SECTIONS = [
	"library",
	"reader",
	"media",
	"chart",
	"record",
	"records",
] as const;

export type Section = (typeof SECTIONS)[number];

export function isSection(value: unknown): value is Section {
	return (SECTIONS as readonly unknown[]).includes(value);
}

/** A listing of the library: its cards, and whether the catalogue was cut short of all there is. */
export interface LibraryListing {
	documents: LibraryDocument[];
	truncated: boolean;
}

export interface LibraryDocument {
	id: string;
	title: string;
	summary: string;
	tags: string[];
	thumbnailUrl?: string;
	mediaUrl?: string;
}

/** A library search as a URL's query string: `?`-led, or empty when it asks for everything. */
export function librarySearch(query: string, tags: readonly string[]): string {
	const params = new URLSearchParams();
	if (query) params.set("query", query);
	for (const tag of tags) params.append("tags", tag);
	const search = params.toString();
	return search ? `?${search}` : "";
}

/** A picture: the stage shows nothing else. */
export interface MediaItem {
	url: string;
	title?: string;
	caption?: string;
}

export interface ReaderDocument {
	id: string;
	title: string;
	summary: string;
	tags: string[];
	sections: { heading: string; text: string }[];
	/** The sections' text is Markdown, rendered; absent or false, it is shown as written. */
	markdown?: boolean;
	media: MediaItem[];
}

export interface ChartSpec {
	title: string;
	unit?: string;
	/** A `y` of null is a label with no value: a gap in the line, never a zero. */
	series: { name: string; points: { x: string; y: number | null }[] }[];
}

export const RECORD_KINDS = ["person", "project", "customer", "asset"] as const;
export type RecordKind = (typeof RECORD_KINDS)[number];

export function isRecordKind(value: unknown): value is RecordKind {
	return (RECORD_KINDS as readonly unknown[]).includes(value);
}

export interface RecordView {
	kind: RecordKind;
	id: string;
	name: string;
	fields: { label: string; value: string }[];
	links: { kind: RecordKind; id: string; name: string }[];
	/** The figures the card can chart by hand, as the backend names them; absent on a card that keeps none. */
	measures?: { key: string; unit: string }[];
}

/** One line of a listing, as `listRecords` and the `/records` route answer it. */
export interface RecordSummary {
	kind: RecordKind;
	id: string;
	name: string;
	summary: string;
}

/** A records listing as a URL's query string: `?`-led, or empty when it asks for every record. */
export function recordsSearch(kind: RecordKind | null, query: string): string {
	const params = new URLSearchParams();
	if (kind) params.set("kind", kind);
	if (query) params.set("query", query);
	const search = params.toString();
	return search ? `?${search}` : "";
}

export type Instrument =
	| {
			section: "library";
			query: string;
			tags: string[];
			documents: LibraryDocument[];
	  }
	| { section: "reader"; document: ReaderDocument; page: number }
	| { section: "media"; item: MediaItem }
	| { section: "chart"; chart: ChartSpec }
	| { section: "record"; record: RecordView }
	| {
			section: "records";
			kind: RecordKind | null;
			query: string;
			records: RecordSummary[];
	  };

export type Stage = readonly Instrument[];

/** The most the stage lays out; the oldest gives way when a fifth arrives. */
export const STAGE_CAPACITY = 4;

export type StageAction =
	| { type: "place"; instrument: Instrument }
	| { type: "remove"; section: Section }
	| { type: "clear"; section?: Section }
	| { type: "page"; page: number };

/** A document's pages are its sections; a document with none is one page. */
export function pageCount(document: ReaderDocument): number {
	return Math.max(1, document.sections.length);
}

function clampPage(document: ReaderDocument, page: number): number {
	const count = pageCount(document);
	if (!Number.isFinite(page)) return 1;
	return Math.min(count, Math.max(1, Math.round(page)));
}

export function placeInstrument(stage: Stage, next: Instrument): Instrument[] {
	const placed =
		next.section === "reader"
			? { ...next, page: clampPage(next.document, next.page) }
			: next;
	const at = stage.findIndex((i) => i.section === placed.section);
	if (at >= 0) {
		const out = stage.slice();
		out[at] = placed;
		return out;
	}
	const out = [...stage, placed];
	return out.length > STAGE_CAPACITY
		? out.slice(out.length - STAGE_CAPACITY)
		: out;
}

export function removeInstrument(stage: Stage, section: Section): Instrument[] {
	return stage.filter((i) => i.section !== section);
}

export function reduceStage(stage: Stage, action: StageAction): Instrument[] {
	switch (action.type) {
		case "place":
			return placeInstrument(stage, action.instrument);
		case "remove":
			return removeInstrument(stage, action.section);
		case "clear":
			return action.section ? removeInstrument(stage, action.section) : [];
		case "page":
			return stage.map((i) =>
				i.section === "reader"
					? { ...i, page: clampPage(i.document, action.page) }
					: i,
			);
	}
}

/** What an instrument shows: a reader turned to another page still shows its document. */
function shown(instrument: Instrument): unknown {
	return instrument.section === "reader" ? instrument.document : instrument;
}

/**
 * What a change of the stage put on it and took off, by section, in the
 * order they stand: said to a reader who cannot see a tile arrive. A
 * section that shows another thing than it did is placed again; a reader
 * turning its page is not.
 */
export function stageChange(
	was: Stage,
	now: Stage,
): { placed: Section[]; removed: Section[] } {
	const before = new Map(was.map((i) => [i.section, shown(i)]));
	const after = new Set(now.map((i) => i.section));
	return {
		placed: now
			.filter((i) => before.get(i.section) !== shown(i))
			.map((i) => i.section),
		removed: was.map((i) => i.section).filter((s) => !after.has(s)),
	};
}
