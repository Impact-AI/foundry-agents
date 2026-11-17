import {
	type LibraryDocument,
	type LibraryListing,
	librarySearch,
	type ReaderDocument,
} from "../stage/stage";
import { BackendError, backendJson, type Caller } from "./client";

/**
 * The documents the backend's knowledge search returned for a query, under
 * the caller's access, and whether the catalogue was cut short: it lists up
 * to a bound, and says so when there is more than it read.
 */
export async function listLibrary(
	caller: Caller,
	query: string,
	tags: string[],
	signal?: AbortSignal,
): Promise<LibraryListing> {
	const { documents, truncated } = await backendJson<{
		documents: LibraryDocument[];
		truncated?: boolean;
	}>(caller, `/library${librarySearch(query, tags)}`, { signal });
	return { documents, truncated: truncated === true };
}

/** One asset rendered for the reader, or null when the backend has none by that id. */
export async function readDocument(
	caller: Caller,
	id: string,
	signal?: AbortSignal,
): Promise<ReaderDocument | null> {
	try {
		return await backendJson<ReaderDocument>(
			caller,
			`/library/${encodeURIComponent(id)}`,
			{ signal },
		);
	} catch (err) {
		if (err instanceof BackendError && err.status === 404) return null;
		throw err;
	}
}
