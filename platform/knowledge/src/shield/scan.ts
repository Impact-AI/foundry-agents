import { createHash } from "node:crypto";
import { knowledgeSettings } from "../config/knowledge";
import { FIELD } from "../index/definition";
import { oneOf } from "../index/odata";
import { walkChunks } from "../index/reads";
import { type ChunkPatch, mergeChunks } from "../index/writes";
import { shield } from "./client";

/**
 * The job's `shield` step: every chunk Prompt Shields has not read, or has
 * read in another version, read now, and the verdict merged back as
 * `injection` beside the hash of the text it was about. Searches serve only
 * `injection eq false`, so until this has run a new chunk is never handed
 * to a model. A verdict stands only beside the hash of the text it was
 * given about: a chunk whose text has changed is read again whatever
 * verdict it carries, so the scan is run over every chunk a rewrite could
 * have reached — the whole index after an indexer's run, whether or not
 * the service called that run a success — and the time between that run
 * and this scan is the one window in which an edited chunk can be served
 * under the verdict of its earlier text.
 *
 * What that costs: the index holds no hash of a chunk's current text, so
 * telling a changed chunk from an unchanged one means reading its text.
 * Every scan therefore reads every chunk's text once, a page of a thousand
 * at a time and never more than a page in memory, and sends Prompt Shields
 * only the chunks that need it. The read grows with the index, not with
 * the load that started it.
 *
 * A verdict is written only over the text it was given about. Prompt
 * Shields takes time, and another run of the job can rewrite or delete a
 * chunk meanwhile: the chunk is read again before its verdict is written,
 * one that is gone is left gone, and one whose text has changed has its
 * verdict withdrawn, so it is unserved until a scan reads the new text.
 *
 * A window of chunks at a time: read, cut into Prompt Shields' request size,
 * sent, and written back, so a library of any size holds one window.
 */

export interface ShieldReport {
	scanned: number;
	/** The chunks found carrying an attack, by file, for the log. */
	flagged: { path: string; chunkId: string }[];
	/**
	 * Chunks left with no verdict, and so unserved, for a later scan: their
	 * text changed while Prompt Shields was reading it, or they are another
	 * library's and Prompt Shields could not be asked about them.
	 */
	withheld: number;
}

export interface ShieldOptions {
	/**
	 * The library whose load this scan belongs to. Prompt Shields failing on
	 * that library's chunks fails the scan; failing on any other chunk
	 * withdraws those chunks' verdicts and is reported, so one library's
	 * load is not failed by another's text. Absent: every failure throws.
	 */
	library?: string;
}

/** Chunks read before their verdicts are written back. */
const WINDOW = 100;

export function textHash(text: string): string {
	return createHash("sha256").update(text).digest("hex");
}

interface Pending {
	chunkId: string;
	path: string;
	text: string;
	hash: string;
}

/** No verdict: the chunk is served by no search until a scan gives it one. */
const withdrawn = (chunkId: string): ChunkPatch => ({
	chunkId,
	injection: null,
	shieldedHash: null,
});

/** Scan `filter`'s chunks that need it; null scans the whole index. */
export async function shieldChunks(
	filter: string | null,
	options: ShieldOptions = {},
): Promise<ShieldReport> {
	const report: ShieldReport = { scanned: 0, flagged: [], withheld: 0 };
	// Two windows, so a failure on another library's text is told apart
	// from one on the text this load is answerable for.
	const own: Pending[] = [];
	const others: Pending[] = [];
	const flush = async (window: Pending[], tolerant: boolean) => {
		const batch = window.splice(0);
		if (tolerant) await scanOrWithhold(batch, report);
		else await scanWindow(batch, report);
	};
	for await (const chunk of walkChunks(filter, [
		FIELD.chunk,
		FIELD.path,
		FIELD.library,
		FIELD.injection,
		FIELD.shieldedHash,
	])) {
		const text = chunk.chunk ?? "";
		const hash = textHash(text);
		if (typeof chunk.injection === "boolean" && chunk.shieldedHash === hash)
			continue;
		const foreign =
			options.library !== undefined && chunk.library !== options.library;
		const window = foreign ? others : own;
		window.push({ chunkId: chunk.chunkId, path: chunk.path, text, hash });
		if (window.length >= WINDOW) await flush(window, foreign);
	}
	await flush(own, false);
	await flush(others, true);
	return report;
}

/**
 * A window of another library's chunks: scanned as any window is, and when
 * Prompt Shields cannot be asked, their verdicts withdrawn rather than left
 * standing over text nobody read. A withdrawal that fails throws: a chunk
 * that may be served under a stale verdict is not a thing to report and
 * move past.
 */
async function scanOrWithhold(window: Pending[], report: ShieldReport) {
	const before = {
		scanned: report.scanned,
		flagged: report.flagged.length,
		withheld: report.withheld,
	};
	const progress: Progress = { step: "asking Prompt Shields" };
	try {
		await scanWindow(window, report, progress);
	} catch (err) {
		// Nothing of this window was kept, whatever it had counted on the way.
		report.scanned = before.scanned;
		report.flagged.length = before.flagged;
		await mergeChunks(window.map((chunk) => withdrawn(chunk.chunkId)));
		report.withheld = before.withheld + window.length;
		console.warn(
			`[shield] ${window.length} chunk(s) of other libraries (${[...new Set(window.map((c) => c.path))].join(", ")}) are unserved until a scan reads them; ${progress.step} failed: ${err instanceof Error ? err.message : String(err)}`,
		);
	}
}

/** Which of a window's three steps is under way, for whoever reports its failure. */
interface Progress {
	step:
		| "asking Prompt Shields"
		| "reading the chunks back from the index"
		| "writing the verdicts to the index";
}

/** The hash of each chunk's text as the index holds it now; a chunk that is gone has none. */
async function currentHashes(
	window: readonly Pending[],
): Promise<Map<string, string>> {
	const now = new Map<string, string>();
	// `search.in` has no escape for its delimiter; a key holding it is read
	// as absent, and so is never stamped.
	const keys = window.map((c) => c.chunkId).filter((k) => !k.includes("|"));
	if (keys.length === 0) return now;
	for await (const chunk of walkChunks(oneOf(FIELD.key, keys), [FIELD.chunk]))
		now.set(chunk.chunkId, textHash(chunk.chunk ?? ""));
	return now;
}

/**
 * One window: every chunk cut into pieces no longer than a request may
 * carry, the pieces packed into requests, and a chunk attacked if any of
 * its pieces was.
 */
async function scanWindow(
	window: Pending[],
	report: ShieldReport,
	progress?: Progress,
) {
	if (window.length === 0) return;
	const { batchChars, batchDocuments } = (await knowledgeSettings()).shield;
	const attacked = window.map(() => false);
	let request: { owner: number; text: string }[] = [];
	let size = 0;
	const send = async () => {
		if (request.length === 0) return;
		const verdicts = await shield().scan(request.map((p) => p.text));
		request.forEach((piece, k) => {
			if (verdicts[k]) attacked[piece.owner] = true;
		});
		request = [];
		size = 0;
	};
	for (const [owner, chunk] of window.entries()) {
		for (let at = 0; at < Math.max(chunk.text.length, 1); at += batchChars) {
			const text = chunk.text.slice(at, at + batchChars);
			if (request.length >= batchDocuments || size + text.length > batchChars)
				await send();
			request.push({ owner, text });
			size += text.length;
		}
	}
	await send();
	// The text may have moved while Prompt Shields read it.
	if (progress) progress.step = "reading the chunks back from the index";
	const now = await currentHashes(window);
	const patches: ChunkPatch[] = [];
	for (const [i, chunk] of window.entries()) {
		const current = now.get(chunk.chunkId);
		if (current === undefined) continue;
		if (current !== chunk.hash) {
			patches.push(withdrawn(chunk.chunkId));
			report.withheld++;
			continue;
		}
		patches.push({
			chunkId: chunk.chunkId,
			injection: attacked[i],
			shieldedHash: chunk.hash,
		});
		report.scanned++;
		if (attacked[i])
			report.flagged.push({ path: chunk.path, chunkId: chunk.chunkId });
	}
	// A chunk deleted between the read above and this write is its own end.
	if (progress) progress.step = "writing the verdicts to the index";
	await mergeChunks(patches);
}
