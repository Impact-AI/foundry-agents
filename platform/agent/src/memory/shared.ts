import { cutTo } from "../cut";
import type { PersonCache } from "../person/caches";
import { agentSettings } from "../settings";
import type { MemoryStore } from "./interface";

/**
 * What both stores do the same way around what each keeps differently: the
 * statements a turn carries, read through the fleet-shared cache, and what
 * a correction comes to before the store writes it.
 */

/** The statements: the cache's, else `read`'s; null when they cannot be read. */
export async function cachedStatements(
	cache: PersonCache<string[]>,
	resourceId: string,
	read: () => Promise<string[]>,
): Promise<string[] | null> {
	try {
		const cached = await cache.read(resourceId);
		if (cached) return cached;
		const statements = await read();
		// Only something remembered is cached: nothing yet is the state the next extraction changes.
		if (statements.length) await cache.write(resourceId, statements);
		return statements;
	} catch (err) {
		console.error(
			"[memory] read failed, continuing without it:",
			(err as Error).message,
		);
		return null;
	}
}

/**
 * A correction, as far as both stores take it the same way: the text to
 * write, trimmed to the operator's limit; or null, when the fact is not the
 * person's (`owned` answers nothing) or the text is empty, which removes it.
 */
export async function correction(
	store: Pick<MemoryStore, "remove">,
	resourceId: string,
	itemId: string,
	content: string,
	owned: () => Promise<unknown>,
): Promise<string | null> {
	const { memory } = await agentSettings();
	const text = cutTo(content.trim(), memory.itemMaxChars);
	if (!(await owned())) return null;
	if (!text) {
		await store.remove(resourceId, itemId);
		return null;
	}
	return text;
}
