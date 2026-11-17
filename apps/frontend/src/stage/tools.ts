import { withFollowUp } from "@platform/prompt";
import { isMediaPath } from "../same-origin";
import { type MeasureNames, namedChart } from "./measure-names";
import {
	type ChartSpec,
	type Instrument,
	isRecordKind,
	isSection,
	type LibraryListing,
	type MediaItem,
	type ReaderDocument,
	type RecordKind,
	type RecordSummary,
	type RecordView,
	type StageAction,
} from "./stage";
import { isStageToolName, type StageToolName } from "./tool-briefs";

/**
 * What each registered tool does: mutate the stage, answer the assistant
 * with a short status ending in the follow-up cue. Both channels run these —
 * CopilotKit calls them for a typed turn, the live session's function calls
 * reach them through `runStageTool` — so the stage reacts to a spoken
 * command exactly as to a typed one.
 */
/**
 * A read behind a control that did not come back: refused, or unreachable.
 * Not the same as nothing found, which a read answers with an empty list or
 * a null; `code` is the refusal's, as the catalogue renders it.
 */
export class StageReadFailed extends Error {
	constructor(readonly code: string) {
		super(`stage read failed: ${code}`);
		this.name = "StageReadFailed";
	}
}

export interface StageToolDeps {
	dispatch: (action: StageAction) => void;
	/** A read failed: said to the person where they are looking, as well as to the assistant. */
	failed?: (code: string) => void;
	library: (query: string, tags: string[]) => Promise<LibraryListing>;
	document: (id: string) => Promise<ReaderDocument | null>;
	record: (kind: RecordKind, id: string) => Promise<RecordView | null>;
	records: (kind: RecordKind | null, query: string) => Promise<RecordSummary[]>;
	suggest: (options: string[]) => void;
}

export type StageToolHandler = (
	args: Record<string, unknown>,
) => Promise<string>;

export type StageToolHandlers = Record<StageToolName, StageToolHandler>;

const text = (value: unknown, max = 400): string =>
	typeof value === "string" ? value.trim().slice(0, max) : "";

const strings = (value: unknown, max = 12): string[] =>
	Array.isArray(value)
		? value
				.map((v) => text(v, 80))
				.filter(Boolean)
				.slice(0, max)
		: [];

/** Only a path under this origin's media route, which the backend hands out, may reach a `src`. */
export function safeMediaUrl(value: unknown): string | null {
	const url = text(value, 2000);
	return url && isMediaPath(url) ? url : null;
}

/** The largest value a chart plots: past it a number has no whole steps left to rule a band with. */
const CHART_VALUE_MAX = 1e15;

export function readMediaItem(args: Record<string, unknown>): MediaItem | null {
	const url = safeMediaUrl(args.url);
	if (!url) return null;
	const title = text(args.title, 160);
	const caption = text(args.caption, 600);
	return {
		url,
		...(title ? { title } : {}),
		...(caption ? { caption } : {}),
	};
}

export function readChart(args: Record<string, unknown>): ChartSpec | null {
	const title = text(args.title, 160);
	if (!title || !Array.isArray(args.series)) return null;
	const series = args.series
		.map((s) => {
			const entry = (s ?? {}) as { name?: unknown; points?: unknown };
			const points = Array.isArray(entry.points)
				? entry.points
						.map((p) => {
							const point = (p ?? {}) as { x?: unknown; y?: unknown };
							// A number, or a numeral the model quoted; a null or a blank
							// is a value the series does not have, kept so its label
							// stays on the axis as a gap, never a zero; anything else
							// is no point.
							const y =
								point.y === null ||
								(typeof point.y === "string" && !point.y.trim())
									? null
									: typeof point.y === "number"
										? point.y
										: typeof point.y === "string"
											? Number(point.y)
											: Number.NaN;
							return { x: text(point.x, 40), y };
						})
						.filter(
							(p) =>
								p.x &&
								(p.y === null ||
									(Number.isFinite(p.y) && Math.abs(p.y) <= CHART_VALUE_MAX)),
						)
						.slice(0, 200)
				: [];
			return { name: text(entry.name, 60) || "series", points };
		})
		.filter((s) => s.points.some((p) => p.y !== null))
		.slice(0, 6);
	if (!series.length) return null;
	const unit = text(args.unit, 24);
	return { title, ...(unit ? { unit } : {}), series };
}

export function stageToolHandlers(deps: StageToolDeps): StageToolHandlers {
	const place = (instrument: Instrument) =>
		deps.dispatch({ type: "place", instrument });
	/**
	 * A control whose read failed leaves the stage as it was and says so, to
	 * the person and to the assistant: a read that did not come back is
	 * never shown, or reported, as one that found nothing.
	 */
	const reading =
		(what: string, run: StageToolHandler): StageToolHandler =>
		async (args) => {
			try {
				return await run(args);
			} catch (err) {
				if (!(err instanceof StageReadFailed)) throw err;
				deps.failed?.(err.code);
				return `${what} could not be read (${err.code}); nothing changed on the stage. Say that it did not load, not that there is nothing.`;
			}
		};
	return {
		showLibrary: reading("The library", async (args) => {
			const query = text(args.query, 200);
			const tags = strings(args.tags);
			const { documents, truncated } = await deps.library(query, tags);
			place({ section: "library", query, tags, documents });
			const count = `${documents.length} document${documents.length === 1 ? "" : "s"}`;
			// A list cut short is never called the whole library: the person
			// hears there is more, and how to reach it.
			const partial =
				" The library holds more than this list shows: say so, and offer to search for what they are after.";
			return withFollowUp(
				query
					? `Library on stage: ${count} for '${query}'.`
					: truncated
						? `Library on stage: the first ${count} the person may read.${partial}`
						: `Library on stage: all ${count} the person may read.`,
			);
		}),
		openDocument: reading("That document", async (args) => {
			const id = text(args.id, 120);
			if (!id) return "No document id was given.";
			const document = await deps.document(id);
			if (!document) return `No document with id '${id}' was found.`;
			const page =
				typeof args.page === "number" ? args.page : Number(args.page);
			place({
				section: "reader",
				document,
				page: Number.isFinite(page) ? page : 1,
			});
			return withFollowUp(`Reader on stage: ${document.title}.`);
		}),
		presentContent: async (args) => {
			const item = readMediaItem(args);
			if (!item)
				return "That picture could not be shown: it needs the picture's own path in the library, starting with /api/media/, as a search result or a document gives it.";
			place({ section: "media", item });
			return withFollowUp(`On stage: ${item.title ?? "the picture"}.`);
		},
		showChart: async (args) => {
			const chart = readChart(args);
			if (!chart)
				return "That chart could not be drawn: it needs a title and at least one series with points.";
			place({ section: "chart", chart });
			return withFollowUp(`Chart on stage: ${chart.title}.`);
		},
		showRecord: reading("That record", async (args) => {
			const id = text(args.id, 120);
			if (!isRecordKind(args.kind) || !id)
				return "A record needs a kind (person, project, customer or asset) and an id.";
			const record = await deps.record(args.kind, id);
			if (!record) return `No ${args.kind} with id '${id}' was found.`;
			place({ section: "record", record });
			return withFollowUp(`Record on stage: ${record.name}.`);
		}),
		showRecords: reading("The records", async (args) => {
			const kind = isRecordKind(args.kind) ? args.kind : null;
			const query = text(args.query, 120);
			const records = await deps.records(kind, query);
			place({ section: "records", kind, query, records });
			const count = `${records.length} record${records.length === 1 ? "" : "s"}`;
			const scope = [
				kind ? `of kind ${kind}` : "",
				query ? `for '${query}'` : "",
			]
				.filter(Boolean)
				.join(" ");
			return withFollowUp(
				scope
					? `Records on stage: ${count} ${scope}.`
					: `Records on stage: all ${count}.`,
			);
		}),
		clearStage: async (args) => {
			deps.dispatch({
				type: "clear",
				...(isSection(args.section) ? { section: args.section } : {}),
			});
			return "Stage cleared.";
		},
		suggestNext: async (args) => {
			deps.suggest(strings(args.options, 3));
			return "";
		},
	};
}

/**
 * A record's measure on the chart, by hand: the series the metrics route
 * answers — what the agent's `metrics` tool returns — placed through the
 * same `showChart` handler the agent's call runs, so a chip and a tool call
 * draw one chart. Given the names the card reads, the chart is titled with
 * them, in the person's language.
 */
export async function chartMeasure(
	handlers: Pick<StageToolHandlers, "showChart">,
	metrics: (
		kind: RecordKind,
		id: string,
		measure: string,
	) => Promise<ChartSpec | null>,
	kind: RecordKind,
	id: string,
	measure: string,
	failed?: (code: string) => void,
	names?: MeasureNames,
): Promise<void> {
	try {
		const chart = await metrics(kind, id, measure);
		if (chart)
			await handlers.showChart({
				...(names ? namedChart(chart, measure, names) : chart),
			});
	} catch (err) {
		if (!(err instanceof StageReadFailed)) throw err;
		failed?.(err.code);
	}
}

/** A call by name, as the live session makes it: an unknown tool is answered, never left hanging. */
export async function runStageTool(
	handlers: StageToolHandlers,
	name: string,
	args: Record<string, unknown>,
): Promise<string> {
	if (!isStageToolName(name)) return `There is no tool called '${name}'.`;
	try {
		return await handlers[name](args);
	} catch (err) {
		console.error(`[stage] ${name} failed:`, err);
		return `${name} failed; nothing changed on the stage.`;
	}
}
