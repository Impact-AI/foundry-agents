import {
	type ChartSpec,
	type RecordKind,
	type RecordSummary,
	type RecordView,
	recordsSearch,
} from "../stage/stage";
import { BackendError, backendJson, type Caller } from "./client";

/** One entity from the backend's sample records, or null when there is none. */
export async function readRecord(
	caller: Caller,
	kind: RecordKind,
	id: string,
	signal?: AbortSignal,
): Promise<RecordView | null> {
	try {
		return await backendJson<RecordView>(
			caller,
			`/records/${encodeURIComponent(kind)}/${encodeURIComponent(id)}`,
			{ signal },
		);
	} catch (err) {
		if (err instanceof BackendError && err.status === 404) return null;
		throw err;
	}
}

/** The records of a kind, or every kind, whose name or a field contains the query: one line each. */
export async function listRecords(
	caller: Caller,
	kind: RecordKind | null,
	query: string,
	signal?: AbortSignal,
): Promise<RecordSummary[]> {
	const { records } = await backendJson<{ records: RecordSummary[] }>(
		caller,
		`/records${recordsSearch(kind, query)}`,
		{ signal },
	);
	return records;
}

/** One measure of one record, shaped for the chart, or null when the record or the measure is not there. */
export async function readMetrics(
	caller: Caller,
	kind: RecordKind,
	id: string,
	measure: string,
	period: "quarter" | "year",
	signal?: AbortSignal,
): Promise<ChartSpec | null> {
	try {
		const { chart } = await backendJson<{ chart: ChartSpec }>(
			caller,
			`/records/${encodeURIComponent(kind)}/${encodeURIComponent(id)}/metrics/${encodeURIComponent(measure)}?period=${period}`,
			{ signal },
		);
		return chart;
	} catch (err) {
		if (err instanceof BackendError && err.status === 404) return null;
		throw err;
	}
}
