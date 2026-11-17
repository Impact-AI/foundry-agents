import { createHash } from "node:crypto";
import { readdir } from "node:fs/promises";
import { join, relative, sep } from "node:path";
import { deleteBlob, listBlobs, putBlob } from "@platform/storage";
import { formatOf } from "./formats";

/**
 * A directory made the container's copy under `<library>/`, as the ingest
 * script makes an operator's: a file whose bytes the blob does not already
 * hold is uploaded, a blob the directory no longer has is deleted, and
 * everything else is left alone, so an unchanged file keeps its blob and
 * the indexer, which reads what changed, reads nothing. For a library that
 * ships inside the job's image; one a person uploads is mirrored by the
 * ingest script from their machine.
 */

export interface Mirror {
	uploaded: number;
	unchanged: number;
	deleted: number;
}

/** Every file under `dir`, relative, sorted; hidden files and folders are not a library's. */
async function filesUnder(dir: string): Promise<string[]> {
	const entries = await readdir(dir, { recursive: true, withFileTypes: true });
	return entries
		.filter((e) => e.isFile())
		.map((e) => relative(dir, join(e.parentPath, e.name)).split(sep).join("/"))
		.filter((path) => !path.split("/").some((part) => part.startsWith(".")))
		.sort();
}

const md5 = (bytes: Uint8Array) =>
	Buffer.from(createHash("md5").update(bytes).digest()).toString("base64");

export async function mirrorDirectory(
	dir: string,
	library: string,
): Promise<Mirror> {
	const prefix = `${library}/`;
	const held = new Map<string, string | undefined>();
	for await (const blob of listBlobs(prefix))
		held.set(
			blob.name,
			blob.contentMD5 && Buffer.from(blob.contentMD5).toString("base64"),
		);

	const mirror: Mirror = { uploaded: 0, unchanged: 0, deleted: 0 };
	const present = new Set<string>();
	for (const relPath of await filesUnder(dir)) {
		const name = `${prefix}${relPath}`;
		present.add(name);
		const bytes = new Uint8Array(
			await Bun.file(join(dir, relPath)).arrayBuffer(),
		);
		if (held.get(name) === md5(bytes)) {
			mirror.unchanged++;
			continue;
		}
		await putBlob(name, bytes, {
			contentType:
				formatOf(relPath)?.contentType ??
				(relPath.endsWith(".json") ? "application/json" : undefined),
		});
		mirror.uploaded++;
	}
	for (const name of held.keys())
		if (!present.has(name)) {
			await deleteBlob(name);
			mirror.deleted++;
		}
	return mirror;
}
