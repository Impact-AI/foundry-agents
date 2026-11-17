import type { DocumentAccess } from "../types";
import {
	entryObject,
	type Manifest,
	manifestEntryFor,
	parseManifest,
	stringEntries,
} from "./manifest";

/**
 * Who may read each file of a library, from the `access.json` at its root:
 * `{ "<path or glob>": { "oids": [...], "groups": [...] }, "*": { ... } }`,
 * resolved by the manifests' one rule, and a file none of its entries names
 * gets the readers the settings say. A manifest that cannot be read fails
 * the whole load before a file is described, since a file indexed with the
 * wrong readers is retrievable by the wrong people until somebody notices.
 */

export const ACCESS_MANIFEST_NAME = "access.json";

export type AccessManifest = Manifest<DocumentAccess>;

const ID = { one: "an id", many: "ids" };

function entryAccess(value: unknown, key: string): DocumentAccess {
	const given = entryObject(value, key, ["oids", "groups"]);
	return {
		oids: stringEntries(given.oids, `entry "${key}".oids`, ID),
		groups: stringEntries(given.groups, `entry "${key}".groups`, ID),
	};
}

/** The manifest's text as entries, or a typed error naming what is wrong. */
export function parseAccessManifest(
	text: string,
	path = ACCESS_MANIFEST_NAME,
): AccessManifest {
	return parseManifest(text, path, entryAccess);
}

/** The readers the manifest names for one file, or null when it names none. */
export function manifestAccessFor(
	manifest: AccessManifest | null,
	relPath: string,
): DocumentAccess | null {
	return manifestEntryFor(manifest, relPath);
}
