import { productTool } from "@platform/agent";
import { z } from "zod";
import { orUnavailable, type RecordsCaller } from "../records/contract";
import { recordsSource, turnCaller } from "../records/source";
import { type Period, series } from "../sample/metrics";
import { measuresKept, RECORD_KINDS, type RecordKind } from "../sample/records";

export const METRICS = "metrics";

const kind = z.enum(RECORD_KINDS as [RecordKind, ...RecordKind[]]);

/** The series, or the measures the record does keep when it does not keep this one; nothing of a record the caller may not see. */
export async function metrics(
	input: {
		record: { kind: RecordKind; id: string };
		measure: string;
		period?: Period;
	},
	caller: RecordsCaller | null,
) {
	const record = await recordsSource().find(
		input.record.kind,
		input.record.id,
		caller,
	);
	if (!record) return { found: false as const, measures: [] };
	const found = series(record, input.measure, input.period ?? "quarter");
	if (!found) return { found: false as const, measures: measuresKept(record) };
	return { found: true as const, chart: found };
}

export const metricsTool = productTool({
	description:
		"A record's figures over time: one measure of one person, project, customer or asset, per quarter or per year. Reach for it for any question with a number in the answer — spend, revenue, uptime, hours — and hand what it returns to `showChart` as it is. Returns the chart's title, unit and series; a point whose `y` is null is a period the record keeps no figure for, which you call missing, never zero; for a measure the record does not keep, the ones it does; when the records cannot be read right now, `unavailable` and the reason, which you say plainly.",
	parameters: z.object({
		record: z.object({ kind, id: z.string().min(1).max(80) }),
		measure: z.string().min(1).max(40),
		period: z.enum(["quarter", "year"]).optional(),
	}),
	execute: async (input) => orUnavailable(() => metrics(input, turnCaller())),
});
