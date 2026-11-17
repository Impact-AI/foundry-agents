import type { IndexerExecutionResult } from "@azure/search-documents";
import { envString, isConflict } from "@platform/config";
import { knowledgeSettings } from "../config/knowledge";
import { searchClient, searchIndexerClient } from "../index/client";
import { pipelineNames } from "./definitions";

/**
 * One indexer run, started and waited for. The run reads every blob changed
 * since the last, through the skillset, into the index; a file that fails
 * does not stop the others, and comes back here as a failure naming it.
 */

export interface IndexerFailure {
	/** The file's blob name when the service's key names one, else the key as given. */
	path: string;
	/** Whether `path` is a blob's name: false when the key named no blob in the container. */
	named: boolean;
	message: string;
}

export interface IndexerRun {
	/** Files the run read, failures included. */
	itemCount: number;
	failures: IndexerFailure[];
	/**
	 * Whether the service called the run a success. A file that fails does
	 * not end a run, so a run that ended otherwise stopped for a reason of
	 * its own: it can still name files it failed, and what it did not reach
	 * is unknown.
	 */
	succeeded: boolean;
}

export interface RunOptions {
	/** How often the status is asked for. */
	pollMs?: number;
	/**
	 * How far apart the index's count is read while it settles; at most
	 * `pollMs` when not given.
	 */
	settleMs?: number;
}

/** Reads of the index's count that must agree, `settleMs` apart, before it is taken as settled. */
const SETTLE_READS = 3;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * The blob a failure's key names. The service keys an item by its blob's
 * URL, alone or as `localId=<url>&documentKey=…`; the path below the
 * container is what a person recognises.
 */
export function pathOfIndexerKey(key: string): string {
	return blobOfIndexerKey(key) ?? key;
}

/** The blob name inside the key, or null when it names none. */
function blobOfIndexerKey(key: string): string | null {
	const container = envString("AZURE_STORAGE_CONTAINER") ?? "library";
	const url = /https?:\/\/[^&\s]+/.exec(key)?.[0];
	if (!url) return null;
	const marker = `/${container}/`;
	const at = url.indexOf(marker);
	if (at < 0) return null;
	try {
		return decodeURIComponent(url.slice(at + marker.length)) || null;
	} catch {
		return null;
	}
}

/**
 * Run the indexer and wait for that run to end. A run already in progress
 * (one the service starts when an indexer is created, or anybody's) is
 * waited out first, since it may have read a blob before the job described
 * it. A run is told apart from the one before by its start time as the
 * service recorded it, so no clock here is compared with the service's.
 */
export async function runIndexer(
	options: RunOptions = {},
): Promise<IndexerRun> {
	const client = searchIndexerClient();
	const { indexer } = pipelineNames();
	const pollMs = options.pollMs ?? 5_000;
	const { waitMinutes } = (await knowledgeSettings()).indexer;
	const deadline = Date.now() + waitMinutes * 60_000;

	const latest = async () =>
		(await client.getIndexerStatus(indexer)).lastResult;
	const settled = async (): Promise<IndexerExecutionResult | undefined> => {
		for (;;) {
			const last = await latest();
			if (last?.status !== "inProgress") return last;
			if (Date.now() > deadline)
				throw new Error(
					`the indexer "${indexer}" was still running after ${waitMinutes} minutes`,
				);
			await sleep(pollMs);
		}
	};

	let before = await settled();
	for (;;) {
		try {
			await client.runIndexer(indexer);
			break;
		} catch (err) {
			if (!isConflict(err)) throw err;
			before = await settled();
		}
	}
	const startedBefore = before?.startTime?.getTime();
	for (;;) {
		const last = await latest();
		const isNew = last && last.startTime?.getTime() !== startedBefore;
		if (isNew && last.status !== "inProgress") {
			if (last.status !== "success" && last.errors.length === 0)
				throw new Error(
					`the indexer "${indexer}" ended ${last.status}: ${last.errorMessage ?? "no reason given"}`,
				);
			return {
				itemCount: last.itemCount,
				failures: last.errors.map((e) => {
					const blob = blobOfIndexerKey(e.key ?? "");
					return {
						path: blob ?? e.key ?? "",
						named: blob !== null,
						message: e.errorMessage,
					};
				}),
				succeeded: last.status === "success",
			};
		}
		if (Date.now() > deadline)
			throw new Error(
				`the indexer "${indexer}" did not finish within ${waitMinutes} minutes`,
			);
		await sleep(pollMs);
	}
}

/**
 * Wait until the index shows what the indexer's run wrote. A run the
 * service calls ended has written its chunks, but a search sees a write only
 * after the index's next refresh, which the service makes about a second
 * later and on no schedule it states: a scan begun as the run ends can read
 * an index that still looks as it did before the run — empty, after a
 * rebuild — and give nothing a verdict. So the count of chunks is read
 * `settleMs` apart until {@link SETTLE_READS} reads in a row agree, within
 * the indexer's own wait.
 */
export async function settleIndex(options: RunOptions = {}): Promise<number> {
	const settleMs = options.settleMs ?? Math.min(options.pollMs ?? 5_000, 2_000);
	const { waitMinutes } = (await knowledgeSettings()).indexer;
	const deadline = Date.now() + waitMinutes * 60_000;
	let count = await searchClient().getDocumentsCount();
	for (let agreeing = 1; agreeing < SETTLE_READS; ) {
		if (Date.now() > deadline)
			throw new Error(
				`the index's count of chunks was still changing after ${waitMinutes} minutes`,
			);
		await sleep(settleMs);
		const now = await searchClient().getDocumentsCount();
		agreeing = now === count ? agreeing + 1 : 1;
		count = now;
	}
	return count;
}
