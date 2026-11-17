import type { RecordKind, SampleRecord } from "../sample/records";

/** Who is asking, as the gate read them: what a source decides what may be seen by. Null is nobody verified. */
export interface RecordsCaller {
	oid: string;
	groups: readonly string[];
}

export interface RecordsSource {
	/** The record, or null when there is none or the caller may not see it: the two are one answer. */
	find(
		kind: RecordKind,
		id: string,
		caller: RecordsCaller | null,
	): Promise<SampleRecord | null>;
	/** Records of one kind, or every kind, whose name or a field contains the query. */
	search(
		kind: RecordKind | null,
		query: string | null,
		caller: RecordsCaller | null,
	): Promise<RecordsListing>;
}

/** A listing: the records, and whether the source holds more than it listed. */
export interface RecordsListing {
	records: SampleRecord[];
	/** True when the listing stopped at the source's bound and more records match: a partial list, said as one. */
	truncated: boolean;
}

/** The source did not answer, or answered with something that is not records. Its message is safe to show. */
export class RecordsUnavailable extends Error {
	override name = "RecordsUnavailable";
}

/** A tool's answer, or the source's reason it has none: a value the model says, never a failed turn. */
export async function orUnavailable<T>(answer: () => Promise<T>) {
	try {
		return await answer();
	} catch (error) {
		if (error instanceof RecordsUnavailable)
			return { unavailable: true as const, reason: error.message };
		throw error;
	}
}
