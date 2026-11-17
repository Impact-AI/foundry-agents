/**
 * A library's manifests — `access.json` and `catalog.json` at its root — share
 * one shape and one rule: `{ "<path or glob>": entry, "*": entry }`, paths
 * relative to the library. Per file, on purpose: an exact path wins, then
 * the first glob in the manifest's order that matches, then the `*` entry,
 * and a file none of them names gets nothing from it. A directory is not an
 * entry — `docs/` names nothing under it; write `docs/**` to mean that —
 * because inheritance that is implied is inheritance nobody reviews.
 */

export class ManifestError extends Error {
	constructor(path: string, problem: string) {
		super(`${path}: ${problem}`);
		this.name = "ManifestError";
	}
}

export interface Manifest<E> {
	/** In the manifest's order, the `*` entry aside. */
	entries: readonly { pattern: string; entry: E }[];
	/** The `*` entry: every file nothing more specific names. */
	fallback: E | null;
}

const GLOB_CHARS = /[*?[\]{}]/;

/**
 * The manifest's text as entries, each read by `readEntry`, or a typed error
 * naming the manifest and what is wrong. `readEntry` throws a plain error
 * naming the field; the path is added here.
 */
export function parseManifest<E>(
	text: string,
	path: string,
	readEntry: (value: unknown, key: string) => E,
): Manifest<E> {
	let parsed: unknown;
	try {
		parsed = JSON.parse(text);
	} catch (err) {
		throw new ManifestError(path, `not JSON (${(err as Error).message})`);
	}
	if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
		throw new ManifestError(path, "must be an object keyed by path");
	const entries: { pattern: string; entry: E }[] = [];
	let fallback: E | null = null;
	try {
		for (const [key, value] of Object.entries(parsed)) {
			const pattern = key.trim().replace(/^\.\//, "");
			if (!pattern) throw new Error("an entry has an empty path");
			if (pattern === "*") fallback = readEntry(value, key);
			else entries.push({ pattern, entry: readEntry(value, key) });
		}
	} catch (err) {
		throw new ManifestError(path, (err as Error).message);
	}
	return { entries, fallback };
}

/** The entry the manifest names for one file, or null when it names none. */
export function manifestEntryFor<E>(
	manifest: Manifest<E> | null,
	relPath: string,
): E | null {
	if (!manifest) return null;
	const exact = manifest.entries.find((e) => e.pattern === relPath);
	if (exact) return exact.entry;
	const glob = manifest.entries.find(
		(e) => GLOB_CHARS.test(e.pattern) && new Bun.Glob(e.pattern).match(relPath),
	);
	return glob?.entry ?? manifest.fallback;
}

/**
 * The entries that name one path, not a pattern, and match none of `files`:
 * a name written for a file the library does not hold.
 */
export function unmatchedPaths<E>(
	manifest: Manifest<E> | null,
	files: ReadonlySet<string>,
): string[] {
	return (manifest?.entries ?? [])
		.map((e) => e.pattern)
		.filter((pattern) => !GLOB_CHARS.test(pattern) && !files.has(pattern));
}

/** An object entry with only `fields`, for a reader to take apart. */
export function entryObject(
	value: unknown,
	key: string,
	fields: readonly string[],
): Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value))
		throw new Error(
			`entry "${key}" must be an object with ${fields.join(" and ")}`,
		);
	const given = value as Record<string, unknown>;
	for (const field of Object.keys(given))
		if (!fields.includes(field))
			throw new Error(`entry "${key}" has an unknown field "${field}"`);
	return given;
}

/**
 * A tag is refused with `|` in it: the index's `search.in` reads the
 * character as its delimiter and has no escape for it, so such a tag could
 * be filtered on only one at a time.
 */
export function tagProblem(tag: string): string | null {
	return tag.includes("|") ? `the tag "${tag}" holds "|"` : null;
}

/** A list of non-empty strings, trimmed and without repeats; `what` names one, `an id`. */
export function stringEntries(
	value: unknown,
	where: string,
	what: { one: string; many: string },
): string[] {
	if (value === undefined) return [];
	if (!Array.isArray(value))
		throw new Error(`${where} must be an array of ${what.many}`);
	const out: string[] = [];
	for (const item of value) {
		if (typeof item !== "string" || !item.trim())
			throw new Error(`${where} holds something that is not ${what.one}`);
		const trimmed = item.trim();
		if (!out.includes(trimmed)) out.push(trimmed);
	}
	return out;
}
