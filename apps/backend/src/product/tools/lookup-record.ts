import { productTool } from "@platform/agent";
import { z } from "zod";
import { orUnavailable, type RecordsCaller } from "../records/contract";
import { recordCard, recordsSource, turnCaller } from "../records/source";
import {
	RECORD_KINDS,
	type RecordKind,
	recordSummary,
} from "../sample/records";

export const LOOKUP_RECORD = "lookupRecord";

const kind = z.enum(RECORD_KINDS as [RecordKind, ...RecordKind[]]);

/** The record by id, else the one record whose name contains the query, else nothing and the nearest names — of what the caller may see. */
export async function lookupRecord(
	input: { kind: RecordKind; id?: string; name?: string },
	caller: RecordsCaller | null,
) {
	const source = recordsSource();
	const byId = input.id
		? await source.find(input.kind, input.id, caller)
		: null;
	const byName = input.name
		? (await source.search(input.kind, input.name, caller)).records
		: [];
	const record = byId ?? (byName.length === 1 ? byName[0] : null);
	if (!record)
		return {
			found: false as const,
			nearest: (byName.length
				? byName
				: (await source.search(input.kind, null, caller)).records
			).map(recordSummary),
		};
	const view = await recordCard(source, record, caller);
	return { found: true as const, record: view, measures: view.measures };
}

export const lookupRecordTool = productTool({
	description:
		"Look up one person, project, customer or asset by id or by name. Reach for it when the person names one, before `showRecord` or `metrics`. Returns the record's fields, what it links to, and the measures `metrics` can chart for it; when the name is ambiguous or unknown, the nearest records instead; when the records cannot be read right now, `unavailable` and the reason, which you say plainly.",
	parameters: z
		.object({
			kind,
			id: z.string().min(1).max(80).optional(),
			name: z.string().min(1).max(120).optional(),
		})
		.refine((v) => v.id || v.name, { message: "an id or a name" }),
	execute: async (input) =>
		orUnavailable(() => lookupRecord(input, turnCaller())),
});
