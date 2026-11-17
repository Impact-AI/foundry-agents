import { processSingleton, resetSingleton } from "@platform/config/singleton";

/**
 * The paths that are noise at any sampling rate: liveness, readiness, the
 * browser's reflexive favicon fetch, and a build's content-hashed static
 * chunks, which at a ratio of 1 would be most of everything recorded.
 *
 * A service adds its own — a warm, a beacon — with {@link registerProbePaths}.
 * The set is per process so a development server's module re-evaluation
 * does not forget what was registered.
 */

export const DEFAULT_PROBE_PATHS = ["/health", "/healthz", "/favicon.ico"];
export const DEFAULT_PROBE_PREFIXES = ["/_next/static/"];

const PROBE_PATHS = "observability:probe-paths";

function probePaths(): Set<string> {
	return processSingleton(PROBE_PATHS, () => new Set(DEFAULT_PROBE_PATHS));
}

/** Add whole paths to the probe list. A path registered twice is one path. */
export function registerProbePaths(paths: Iterable<string>): void {
	for (const path of paths) probePaths().add(path);
}

/** Forget every registered path and go back to the defaults. For tests. */
export function resetProbePaths(): void {
	resetSingleton(PROBE_PATHS);
}

/** Is this something that happens on a timer and says nothing when it succeeds? */
export function isProbePath(pathname: string): boolean {
	const path =
		pathname.length > 1 && pathname.endsWith("/")
			? pathname.slice(0, -1)
			: pathname;
	if (probePaths().has(path)) return true;
	return DEFAULT_PROBE_PREFIXES.some((prefix) => path.startsWith(prefix));
}
