import { currentTurn } from "@platform/agent";
import { envString, processSingleton } from "@platform/config";
import {
	findRecord,
	measuresKept,
	type RecordField,
	type RecordKind,
	type SampleRecord,
	searchRecords,
} from "../sample/records";
import type { RecordsCaller, RecordsSource } from "./contract";
import { httpRecordsSource } from "./http";

/**
 * Where the records the tools and the stage read come from. Two answer the
 * same questions: the sample's own module, in memory, and a business system
 * over HTTP when `RECORDS_API_URL` names one. Everything above this seam —
 * the three tools, the routes the stage reads by hand, the stage's card,
 * list and chart, voice — is the same whichever answers.
 */

/** The sample's records: everybody's, so the caller changes nothing. */
const sampleSource: RecordsSource = {
	find: async (kind, id) => findRecord(kind, id),
	search: async (kind, query) => ({
		records: searchRecords(kind, query),
		truncated: false,
	}),
};

/** The source this process reads: the business system `RECORDS_API_URL` names, else the sample. */
export function recordsSource(): RecordsSource {
	return processSingleton("product:records-source", () => {
		const url = envString("RECORDS_API_URL");
		return url
			? httpRecordsSource({ url, scope: envString("RECORDS_API_SCOPE") })
			: sampleSource;
	});
}

/** The caller of the turn a tool runs in. */
export function turnCaller(): RecordsCaller | null {
	const caller = currentTurn().caller;
	return caller ? { oid: caller.oid, groups: caller.groups } : null;
}

/** The record as a card: the stage's `showRecord` and the `/records/:kind/:id` route answer this shape. */
export interface RecordView {
	kind: RecordKind;
	id: string;
	name: string;
	fields: RecordField[];
	links: { kind: RecordKind; id: string; name: string }[];
	/** The figures the card can chart, one chip each: only those the record keeps. */
	measures: { key: string; unit: string }[];
}

/**
 * The record as a card. A link names a record the caller may also see, by
 * its name; a link to one they may not is left off, so a card never says
 * that a record they cannot open exists.
 */
export async function recordCard(
	source: RecordsSource,
	record: SampleRecord,
	caller: RecordsCaller | null,
): Promise<RecordView> {
	const linked = await Promise.all(
		record.links.map((l) => source.find(l.kind, l.id, caller)),
	);
	return {
		kind: record.kind,
		id: record.id,
		name: record.name,
		fields: record.fields,
		links: linked.flatMap((r) =>
			r ? [{ kind: r.kind, id: r.id, name: r.name }] : [],
		),
		measures: measuresKept(record),
	};
}
