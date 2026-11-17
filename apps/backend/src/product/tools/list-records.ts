import { productTool } from "@platform/agent";
import { z } from "zod";
import {
	orUnavailable,
	type RecordsCaller,
	type RecordsSource,
} from "../records/contract";
import { recordsSource, turnCaller } from "../records/source";
import {
	RECORD_KINDS,
	type RecordKind,
	recordSummary,
} from "../sample/records";

export const LIST_RECORDS = "listRecords";

const kind = z.enum(RECORD_KINDS as [RecordKind, ...RecordKind[]]);

/** The records the caller may see, one line each. */
export async function listRecords(
	input: { kind?: RecordKind; query?: string },
	caller: RecordsCaller | null,
	source: RecordsSource = recordsSource(),
) {
	const { records, truncated } = await source.search(
		input.kind ?? null,
		input.query ?? null,
		caller,
	);
	return {
		records: records.map(recordSummary),
		// Said only when it is so: a partial list, which the model says is one.
		...(truncated ? { truncated: true as const } : {}),
	};
}

export const listRecordsTool = productTool({
	description:
		'List the people, projects, customers or assets on record, optionally only those whose name or fields contain a query. Reach for it for "which projects…", "who works on…", "what customers do we have in…". Returns one line per record with its kind and id, for `lookupRecord` and `showRecord`, and a `summary` of its key fields (for a project, its status, delivery date and budget): answer and filter from those lines — "which projects deliver in Q1 2027", "which are on hold" — by listing once and reading them, without looking up each record. The system matches the query itself, and what it matches differs by system: when a query finds nothing a question needs, list without it and read the lines. With `truncated`, the system holds more matching records than it listed: say the list is partial and ask for a narrower query, never present it as all of them. Or, when the records cannot be read right now, `unavailable` and the reason, which you say plainly.',
	parameters: z.object({
		kind: kind.optional(),
		query: z.string().min(1).max(120).optional(),
	}),
	execute: async (input) =>
		orUnavailable(() => listRecords(input, turnCaller())),
});
