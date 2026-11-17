import { join } from "node:path";
import {
	type FileResult,
	type LibraryLoad,
	loadLibrary,
	mirrorDirectory,
} from "@platform/knowledge";

/**
 * The sample's library: nine fictional documents in Markdown, each with the
 * pictures it shows, and an `access.json` that makes every one readable by
 * every signed-in person. A deployment loads it from its migrate job, the
 * local launcher loads it into its stand-ins, and a product replaces the
 * directory with its own documents, or switches the load off, which removes
 * it.
 */
export const SAMPLE_LIBRARY_DIR = join(
	import.meta.dir,
	"..",
	"..",
	"..",
	"sample",
	"library",
);

/**
 * The sample's name as a library. An uploaded library's name starts with a
 * letter or a digit (`LIBRARY_NAME`), so no upload can be the sample.
 */
export const SAMPLE_LIBRARY = "@sample";

/**
 * A directory, made the library container's copy under `<name>/` — a file
 * already there unchanged is left alone, so the indexer reads nothing twice
 * — then loaded as an uploaded library is. The sample by default.
 */
export async function loadSampleLibrary(
	onFile?: (result: FileResult) => void,
	source: { dir: string; name: string } = {
		dir: SAMPLE_LIBRARY_DIR,
		name: SAMPLE_LIBRARY,
	},
): Promise<LibraryLoad> {
	await mirrorDirectory(source.dir, source.name);
	return loadLibrary(source.name, { onFile });
}
