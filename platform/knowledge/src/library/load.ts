import {
	type BlobEntry,
	deleteBlob,
	describeBlob,
	listBlobs,
} from "@platform/storage";
import {
	type AccessSettings,
	defaultDocumentAccess,
	settledAccessSettings,
} from "../config/access";
import { FIELD } from "../index/definition";
import { equals } from "../index/odata";
import { walkChunks } from "../index/reads";
import { deleteChunks } from "../index/writes";
import {
	type IndexerRun,
	type RunOptions,
	runIndexer,
	settleIndex,
} from "../pipeline/run";
import { type ShieldReport, shieldChunks } from "../shield/scan";
import { GLOBAL_ACCESS_GROUP } from "../types";
import {
	CATALOG_MANIFEST_NAME,
	type Catalog,
	describeFile,
	parseCatalog,
} from "./catalog";
import { formatOf } from "./formats";
import { ManifestError, unmatchedPaths } from "./manifest";
import { FrontMatterError } from "./markdown";
import {
	documentIdOf,
	encodeMetadata,
	MetadataTooLargeError,
} from "./metadata";
import {
	ACCESS_MANIFEST_NAME,
	type AccessManifest,
	manifestAccessFor,
	parseAccessManifest,
} from "./readers";
import { readText } from "./text";

/**
 * A library, loaded: every file under `<name>/` in the library container
 * described in its blob's metadata — who may read it, from `access.json`;
 * what it is, from its front matter or `catalog.json` — then the indexer run
 * and waited for, and the index until a search sees what the run wrote,
 * then the chunks of every file the library no longer holds
 * deleted, then Prompt Shields asked about every chunk in the index whose
 * text it has not read. The indexer is one over the whole container and
 * reads what it decides has changed, so a run started for one library can
 * rewrite another's chunks. Whether a rewritten chunk keeps the verdict the
 * job wrote on it is the service's behaviour and is assumed neither way:
 * the scan walks every chunk and reads again any whose verdict is missing
 * or was given about other text, so a kept verdict is never served over
 * text it was not about, and a dropped one does not wait for somebody to
 * run the `shield` step by hand. The scan follows every run that may have
 * written, the ones that fail the load included: a run that stopped short
 * still rewrote what it reached. Prompt Shields failing on this library's
 * chunks fails the load; failing on another library's withdraws those
 * chunks' verdicts, so they are unserved, and is reported.
 *
 * `access.json` is held to the files: an entry that names a path, not a
 * pattern, and matches no file fails the load before anything is
 * described. A path mistyped by a letter or a case would otherwise leave
 * the file it meant with the readers of a file nobody named.
 *
 * A run the service did not call a success fails the load, whichever
 * files its failures name: a file that fails does not end a run, so a run
 * that ended otherwise stopped for a reason of its own, and what it never
 * reached is unknown and may be this library's files. A run that succeeded
 * and names a failed file of another library is that library's to hear
 * about, and is logged.
 *
 * A file that cannot be described, and a file the indexer failed, are
 * reported by name and fail the load; the files that could be are loaded
 * all the same. A load in which anything failed deletes nothing: a listing
 * or a run that went wrong must never be what empties a library.
 */

export type FileStatus = "described" | "unchanged" | "skipped" | "failed";

export interface FileResult {
	/** The blob's name, `<library>/<path>`. */
	path: string;
	status: FileStatus;
	detail?: string;
}

export interface LibraryLoad {
	results: FileResult[];
	described: number;
	unchanged: number;
	skipped: number;
	failed: number;
	/** Files the indexer's run read, across the container. */
	indexed: number;
	/** Chunks deleted because their file is no longer in the library. */
	pruned: number;
	/**
	 * Files this load described, found unchanged or described and the
	 * indexer then failed, whose readers stop short of everybody while access
	 * control is off:
	 * the readers are on the blob and on every chunk, and nothing holds a
	 * search or a reader to them until `access.enforceAccessControl` is on.
	 */
	unenforced: number;
	shield: ShieldReport;
}

export interface LoadOptions extends RunOptions {
	onFile?: (result: FileResult) => void;
}

/**
 * What starts the line a load says when it records readers that nothing
 * enforces, in capitals so it stands out in the job's log; the ingest
 * scripts look for it there and repeat the line (ingest.test.ts holds their
 * copy to this one). The load itself goes on: in a demo the open library is
 * the intent.
 */
export const UNENFORCED_READERS = "WARNING: READERS NOT ENFORCED";

/** The manifests are read, never indexed: a library's own description of itself. */
const MANIFESTS = new Set([ACCESS_MANIFEST_NAME, CATALOG_MANIFEST_NAME]);

async function readManifest<M>(
	name: string,
	parse: (text: string, path: string) => M,
): Promise<M | null> {
	const read = await readText(name);
	if (read.kind === "absent") return null;
	if (read.kind === "too-large")
		throw new Error(`${name}: ${read.bytes} bytes is too large for a manifest`);
	return parse(read.text, name);
}

function sameMetadata(a: Record<string, string>, b: Record<string, string>) {
	const keys = Object.keys(a);
	return (
		keys.length === Object.keys(b).length && keys.every((k) => a[k] === b[k])
	);
}

interface Context {
	library: string;
	access: AccessManifest | null;
	catalog: Catalog | null;
	settings: AccessSettings;
}

/** One blob described in its metadata, or the reason it was not. */
async function describe(blob: BlobEntry, ctx: Context): Promise<FileResult> {
	const relPath = blob.name.slice(ctx.library.length + 1);
	const format = formatOf(relPath);
	if (!format)
		return {
			path: blob.name,
			status: "skipped",
			detail: "not a format a library takes",
		};
	let markdown: string | null = null;
	if (format.markdown) {
		const read = await readText(blob.name);
		if (read.kind === "too-large")
			return {
				path: blob.name,
				status: "failed",
				detail: `${read.bytes} bytes is too large to read its front matter`,
			};
		markdown = read.kind === "text" ? read.text : "";
	}
	try {
		const { title, summary, tags } = describeFile(
			relPath,
			ctx.catalog,
			markdown,
		);
		const metadata = encodeMetadata({
			id: documentIdOf(blob.name),
			path: blob.name,
			library: ctx.library,
			kind: format.kind,
			title,
			summary,
			tags,
			readers:
				manifestAccessFor(ctx.access, relPath) ??
				defaultDocumentAccess(ctx.settings),
		});
		const retype = blob.contentType !== format.contentType;
		if (!retype && sameMetadata(metadata, blob.metadata))
			return { path: blob.name, status: "unchanged" };
		await describeBlob(blob, {
			...(retype ? { contentType: format.contentType } : {}),
			metadata,
		});
		return { path: blob.name, status: "described" };
	} catch (err) {
		// The author's mistakes, said against the file; anything else is the
		// store's, and stops the load.
		if (err instanceof FrontMatterError || err instanceof MetadataTooLargeError)
			return { path: blob.name, status: "failed", detail: err.message };
		throw err;
	}
}

/** The chunks of `library` whose file is not among `kept`, deleted. */
async function prune(library: string, kept: ReadonlySet<string>) {
	const gone: string[] = [];
	for await (const chunk of walkChunks(equals(FIELD.library, library), [
		FIELD.path,
	]))
		if (!kept.has(chunk.path)) gone.push(chunk.chunkId);
	return deleteChunks(gone);
}

export async function loadLibrary(
	library: string,
	options: LoadOptions = {},
): Promise<LibraryLoad> {
	const prefix = `${library}/`;
	const blobs: BlobEntry[] = [];
	for await (const blob of listBlobs(prefix)) blobs.push(blob);
	if (blobs.length === 0)
		throw new Error(
			`nothing is uploaded under ${prefix} in the library container`,
		);

	const ctx: Context = {
		library,
		access: await readManifest(
			`${prefix}${ACCESS_MANIFEST_NAME}`,
			parseAccessManifest,
		),
		catalog: await readManifest(
			`${prefix}${CATALOG_MANIFEST_NAME}`,
			parseCatalog,
		),
		settings: await settledAccessSettings(),
	};

	const files = new Set(
		blobs
			.map((blob) => blob.name.slice(prefix.length))
			.filter((relPath) => !MANIFESTS.has(relPath)),
	);
	const unmatched = unmatchedPaths(ctx.access, files);
	if (unmatched.length)
		throw new ManifestError(
			`${prefix}${ACCESS_MANIFEST_NAME}`,
			`${unmatched.map((p) => `"${p}"`).join(", ")} ${unmatched.length === 1 ? "names" : "name"} no file in the library; a path is matched exactly, case included`,
		);

	const results: FileResult[] = [];
	for (const blob of blobs) {
		if (MANIFESTS.has(blob.name.slice(prefix.length))) continue;
		const result = await describe(blob, ctx);
		results.push(result);
		options.onFile?.(result);
	}

	// A file whose own description failed carries none of this load's readers; one the indexer fails below does.
	const undescribed = new Set(
		results.filter((r) => r.status === "failed").map((r) => r.path),
	);
	const run = await runAndScan(library, options);
	const failedHere = new Map(
		run.failures
			.filter((f) => f.path.startsWith(prefix))
			.map((f) => [f.path, f.message]),
	);
	for (const failure of run.failures)
		if (!failure.path.startsWith(prefix))
			console.warn(
				`[library] the indexer failed ${failure.path}: ${failure.message}`,
			);
	for (const result of results) {
		const message = failedHere.get(result.path);
		if (message && result.status !== "failed") {
			result.status = "failed";
			result.detail = `the indexer: ${message}`;
			options.onFile?.(result);
		}
	}

	const count = (status: FileStatus) =>
		results.filter((r) => r.status === status).length;
	const failed = count("failed");
	const kept = new Set(
		results.filter((r) => r.status !== "skipped").map((r) => r.path),
	);
	const pruned = failed === 0 ? await prune(library, kept) : 0;
	// A file the indexer failed is counted: its blob carries the readers, and
	// an earlier version's chunks stay findable, since no prune runs past a
	// failure. One whose description failed carries none of them.
	const unenforced = ctx.settings.enforceAccessControl
		? 0
		: [...kept].filter(
				(path) =>
					!undescribed.has(path) && restricted(path.slice(prefix.length), ctx),
			).length;
	if (unenforced > 0)
		console.warn(
			`[library] ${UNENFORCED_READERS}: ${unenforced} file(s) under ${prefix} name readers short of everybody, and access control is off: every signed-in person can find and read them until access.enforceAccessControl is on`,
		);
	return {
		results,
		described: count("described"),
		unchanged: count("unchanged"),
		skipped: count("skipped"),
		failed,
		indexed: run.itemCount,
		pruned,
		unenforced,
		shield: await shieldChunks(null, { library }),
	};
}

/** Whether a file's readers, as the load records them, leave anybody out. */
function restricted(relPath: string, ctx: Context): boolean {
	const readers =
		manifestAccessFor(ctx.access, relPath) ??
		defaultDocumentAccess(ctx.settings);
	return !readers.groups.includes(GLOBAL_ACCESS_GROUP);
}

/**
 * The indexer's run, waited for until a search sees what it wrote, and the
 * scan a run that did not succeed still owes.
 * An index whose count does not settle within the indexer's wait is a
 * warning: the load goes on, and the scan reads what a search sees then.
 * A run that ends in failure, or whose wait throws, may have rewritten
 * chunks before it stopped, and the scan at the end of a clean load is
 * never reached then: so the index is scanned here before the failure is
 * thrown. The run's failure is the one reported; a scan that fails beside
 * it is named in the same message.
 */
async function runAndScan(
	library: string | undefined,
	options: RunOptions,
): Promise<IndexerRun> {
	let run: IndexerRun | null = null;
	let failure: Error | null = null;
	try {
		run = await runIndexer(options);
		if (!run.succeeded)
			failure = new Error(
				`the indexer's run did not succeed, so what it never reached is unknown: ${run.failures.map((f) => `${f.path || "(no file named)"}: ${f.message}`).join("; ")}`,
			);
	} catch (err) {
		failure = err instanceof Error ? err : new Error(String(err));
	}
	// The scan reads what a search sees, which trails the run's writes. The
	// count is the whole index's, so a load or removal running beside this
	// one can keep it moving past the wait: that is a warning, not this
	// load's failure, and the scan still reads what the index shows.
	try {
		await settleIndex(options);
	} catch (err) {
		console.warn(
			`[library] ${err instanceof Error ? err.message : String(err)}: scanning what the index shows now`,
		);
	}
	if (!failure && run) return run;
	try {
		await shieldChunks(null, library ? { library } : {});
	} catch (err) {
		throw new Error(
			`${failure?.message}; and the chunks that run wrote could not be scanned: ${err instanceof Error ? err.message : String(err)}`,
			{ cause: failure },
		);
	}
	throw failure;
}

/** What refilling a rebuilt index read and scanned. */
export interface IndexRefill {
	/** Files the indexer's run read. */
	indexed: number;
	/** Files the run failed, by name; each is left out of the index until a load reads it again. */
	failures: IndexerRun["failures"];
	shield: ShieldReport;
}

/**
 * An index the `index` step has just made again holds nothing, and the
 * libraries it projected are still in their blobs, described: so the step
 * refills it there and then, whether or not a library load follows in the
 * same deploy — the indexer runs on demand only, and a deploy that ends in
 * `remove-library` never runs it. The indexer was reset with the rebuild,
 * so the run reads every blob; then the whole index is scanned, since a
 * chunk is served only once Prompt Shields has read it. A run that does
 * not succeed is scanned all the same and fails the step; a file the run
 * failed is named and leaves the step standing, as it leaves a load.
 */
export async function refillIndex(
	options: RunOptions = {},
): Promise<IndexRefill> {
	const run = await runAndScan(undefined, options);
	for (const failure of run.failures)
		console.warn(
			`[index] the indexer failed ${failure.path}: ${failure.message}`,
		);
	return {
		indexed: run.itemCount,
		failures: run.failures,
		shield: await shieldChunks(null),
	};
}

/**
 * A library taken out: its blobs deleted, then every chunk the index holds
 * for it. Each half is quiet on a second run, so a removal interrupted
 * between them is finished by running it again.
 */
export async function removeLibrary(
	library: string,
): Promise<{ blobs: number; chunks: number }> {
	const names: string[] = [];
	for await (const blob of listBlobs(`${library}/`)) names.push(blob.name);
	for (const name of names) await deleteBlob(name);
	const keys: string[] = [];
	for await (const chunk of walkChunks(equals(FIELD.library, library), []))
		keys.push(chunk.chunkId);
	return { blobs: names.length, chunks: await deleteChunks(keys) };
}
