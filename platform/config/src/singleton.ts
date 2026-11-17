/**
 * One instance per process, keyed by name.
 *
 * Kept on `globalThis` rather than at module scope because a development
 * server re-evaluates modules on every recompile, and a client, a pool or a
 * credential built at module scope would be rebuilt — and its connections and
 * token caches leaked — on every generation.
 */
const registry = globalThis as typeof globalThis & {
	__platformSingletons?: Map<string, unknown>;
};

function singletons(): Map<string, unknown> {
	registry.__platformSingletons ??= new Map();
	return registry.__platformSingletons;
}

/** The instance under `key`, created on first use. */
export function processSingleton<T>(key: string, create: () => T): T {
	const held = singletons();
	if (!held.has(key)) held.set(key, create());
	return held.get(key) as T;
}

/** Whether an instance is held under `key`, without creating one. */
export function hasSingleton(key: string): boolean {
	return singletons().has(key);
}

/** Replace the instance under `key`. For tests that inject a stand-in. */
export function setSingleton<T>(key: string, value: T): void {
	singletons().set(key, value);
}

/** Forget the instance under `key`, so the next use creates it again. */
export function resetSingleton(key: string): void {
	singletons().delete(key);
}
