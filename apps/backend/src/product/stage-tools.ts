/**
 * The controls the interface registers and runs in the browser, as data:
 * one list, in the live voice API's function shape, which the surface block
 * describes, the live briefing attaches to the session, and `/identity/me`
 * answers so the interface registers the same eight under the same names.
 * Everything a control can place, the interface also opens by hand — the
 * bar's Library and Records marks, a card's chips — through the same
 * handler, so the two roads cannot drift.
 * None of them runs here — the agent's call streams to the browser, which
 * answers with a status line.
 */

import { RECORD_KINDS } from "./sample/records";

export interface StageTool {
	type: "function";
	name: string;
	description: string;
	/** A JSON schema for the arguments. */
	parameters: Record<string, unknown>;
}

type StageSection =
	| "library"
	| "reader"
	| "media"
	| "chart"
	| "record"
	| "records";

const STAGE_SECTIONS: readonly StageSection[] = [
	"library",
	"reader",
	"media",
	"chart",
	"record",
	"records",
];

const string = (description: string) => ({ type: "string", description });
const number = (description: string) => ({ type: "number", description });
const stringList = (description: string) => ({
	type: "array",
	items: { type: "string" },
	description,
});

function parameters(
	properties: Record<string, unknown>,
	required: readonly string[] = [],
): Record<string, unknown> {
	return {
		type: "object",
		properties,
		required: [...required],
		additionalProperties: false,
	};
}

export const SHOW_LIBRARY = "showLibrary";
export const OPEN_DOCUMENT = "openDocument";
export const PRESENT_CONTENT = "presentContent";
export const SHOW_CHART = "showChart";
export const SHOW_RECORD = "showRecord";
export const SHOW_RECORDS = "showRecords";
export const CLEAR_STAGE = "clearStage";
export const SUGGEST_NEXT = "suggestNext";

export const STAGE_TOOLS: readonly StageTool[] = [
	{
		type: "function",
		name: SHOW_LIBRARY,
		description:
			"Fill the stage's library with the knowledge base's documents as cards with title, summary, thumbnail and tags. With no query (or an empty one) it lists every document the person may read: use that when they ask what documents, files or material there are. With a query it shows the documents a search finds: use that when they ask what there is on a subject, or to show the documents behind an answer.",
		parameters: parameters({
			query: string(
				"What to search the knowledge base for; leave it out to list every document.",
			),
			tags: stringList("Keep only documents carrying one of these tags."),
		}),
	},
	{
		type: "function",
		name: OPEN_DOCUMENT,
		description:
			"Open one document in the stage's reader: its sections in order and its media. Use it when the person wants to read a document, or when your answer rests on one.",
		parameters: parameters(
			{
				id: string("The document's id, as a search returned it."),
				page: number("The section to open at, counted from 1."),
			},
			["id"],
		),
	},
	{
		type: "function",
		name: PRESENT_CONTENT,
		description:
			"Put one picture on the stage's media section. The URL must be one a search returned on this turn, exactly as returned; never one you composed.",
		parameters: parameters(
			{
				url: string("The picture's URL as a search returned it."),
				title: string("A short title."),
				caption: string("One line on what the picture shows."),
			},
			["url"],
		),
	},
	{
		type: "function",
		name: SHOW_CHART,
		description:
			"Draw a chart on the stage from one or more series of points. Use it for any figure over time.",
		parameters: parameters(
			{
				title: string("What the chart shows."),
				unit: string("The unit every y value is in."),
				series: {
					type: "array",
					description: "One line each.",
					items: {
						type: "object",
						properties: {
							name: { type: "string" },
							points: {
								type: "array",
								items: {
									type: "object",
									properties: {
										x: { type: "string" },
										y: {
											type: ["number", "null"],
											description:
												"Null where there is no figure for x, never 0.",
										},
									},
									required: ["x", "y"],
									additionalProperties: false,
								},
							},
						},
						required: ["name", "points"],
						additionalProperties: false,
					},
				},
			},
			["title", "series"],
		),
	},
	{
		type: "function",
		name: SHOW_RECORD,
		description:
			"Show a person, project, customer or asset as a card on the stage, by the record's kind and id.",
		parameters: parameters(
			{
				kind: {
					type: "string",
					enum: [...RECORD_KINDS],
				},
				id: string("The record's id."),
			},
			["kind", "id"],
		),
	},
	{
		type: "function",
		name: SHOW_RECORDS,
		description:
			"List the people, projects, customers or assets on record on the stage, grouped by kind, each a chip that opens its card. With nothing it lists every record: use that when the person asks what records, people, projects, customers or assets there are. With a kind, or a query their name or fields must contain, it lists those.",
		parameters: parameters({
			kind: {
				type: "string",
				enum: [...RECORD_KINDS],
				description: "Only records of this kind; leave it out for every kind.",
			},
			query: string(
				"Only records whose name or fields contain this; leave it out to list them all.",
			),
		}),
	},
	{
		type: "function",
		name: CLEAR_STAGE,
		description:
			"Clear one section of the stage, or the whole stage when no section is named.",
		parameters: parameters({
			section: { type: "string", enum: [...STAGE_SECTIONS] },
		}),
	},
	{
		type: "function",
		name: SUGGEST_NEXT,
		description:
			"Offer three short things the person might ask next, shown as chips under the composer. Every reply ends with one call.",
		parameters: parameters(
			{
				options: stringList("Three suggestions, a few words each."),
			},
			["options"],
		),
	},
];

export const STAGE_TOOL_NAMES: readonly string[] = STAGE_TOOLS.map(
	(tool) => tool.name,
);
