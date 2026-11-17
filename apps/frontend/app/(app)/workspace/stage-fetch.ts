import { callRoute, type Send } from "@/src/route-call";
import {
	type ChartSpec,
	type LibraryDocument,
	type LibraryListing,
	librarySearch,
	type ReaderDocument,
	type RecordKind,
	type RecordSummary,
	type RecordView,
	recordsSearch,
} from "@/src/stage/stage";
import { StageReadFailed } from "@/src/stage/tools";

/**
 * The browser's reads behind the stage tools, through this app's own
 * routes: the backend is never called from here directly. Nothing there is
 * a null; a read that was refused or never answered is `StageReadFailed`,
 * which the handler says to the person and to the assistant as a failure.
 */
export async function read<T>(
	url: string,
	send: Send = fetch,
): Promise<T | null> {
	const answer = await callRoute<T>(send, url, { cache: "no-store" });
	if (answer.ok) return answer.body;
	if (answer.code === "not_found") return null;
	throw new StageReadFailed(answer.code);
}

export async function fetchLibrary(
	query: string,
	tags: string[],
): Promise<LibraryListing> {
	const answer = await read<{
		documents?: LibraryDocument[];
		truncated?: boolean;
	}>(`/api/library${librarySearch(query, tags)}`);
	return {
		documents: Array.isArray(answer?.documents) ? answer.documents : [],
		truncated: answer?.truncated === true,
	};
}

export function fetchDocument(id: string): Promise<ReaderDocument | null> {
	return read<ReaderDocument>(`/api/library/${encodeURIComponent(id)}`);
}

export function fetchRecord(
	kind: RecordKind,
	id: string,
): Promise<RecordView | null> {
	return read<RecordView>(
		`/api/records/${encodeURIComponent(kind)}/${encodeURIComponent(id)}`,
	);
}

export async function fetchRecords(
	kind: RecordKind | null,
	query: string,
): Promise<RecordSummary[]> {
	const answer = await read<{ records?: RecordSummary[] }>(
		`/api/records${recordsSearch(kind, query)}`,
	);
	return Array.isArray(answer?.records) ? answer.records : [];
}

/** One measure of one record as the chart draws it, or null when the record keeps no such measure. */
export async function fetchMetrics(
	kind: RecordKind,
	id: string,
	measure: string,
): Promise<ChartSpec | null> {
	const answer = await read<{ chart?: ChartSpec }>(
		`/api/records/${encodeURIComponent(kind)}/${encodeURIComponent(id)}/metrics/${encodeURIComponent(measure)}`,
	);
	return answer?.chart ?? null;
}
