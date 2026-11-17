import {
	addConfigIfAbsent,
	ConfigConflictError,
	readConfigEntry,
	writeConfig,
} from "./store";

function isEmptyObject(value: unknown): boolean {
	return (
		!!value &&
		typeof value === "object" &&
		!Array.isArray(value) &&
		Object.keys(value).length === 0
	);
}

/**
 * Write each document where its key is absent or holds `{}`, which is what a
 * template writes before anything is seeded, so an operator's edit is never
 * overwritten. Both writes are conditional: a key somebody writes between
 * the read and the write is theirs. Returns the keys written.
 */
export async function seedConfigDocuments(
	documents: Record<string, unknown>,
): Promise<string[]> {
	const written: string[] = [];
	for (const [key, value] of Object.entries(documents)) {
		const stored = await readConfigEntry(key);
		if (stored.etag === undefined) {
			if (await addConfigIfAbsent(key, value)) written.push(key);
			continue;
		}
		if (!isEmptyObject(stored.value)) continue;
		try {
			await writeConfig(key, value, { etag: stored.etag });
			written.push(key);
		} catch (err) {
			if (!(err instanceof ConfigConflictError)) throw err;
		}
	}
	return written;
}
