import { appConfigAvailable } from "./app-configuration/client";
import { readConfigWithin } from "./app-configuration/store";
import { configTtlMs } from "./env";
import { failureReason } from "./report";

/**
 * One memoised, fail-soft reader for a document an operator tunes in the store.
 *
 * The rules every such document follows, in one place: the compiled-in default
 * is the answer when the store has never answered; the last good value is the
 * answer over a failed refresh; `parse` merges what is stored over the default
 * and refuses anything of the wrong shape, so a hand edit in the portal can take
 * nothing down and remove no bound; and the store is read through a memo, never
 * per request, because a read is an authenticated round trip to a private
 * endpoint. A refresh that failed while a last good value is held is not asked
 * again for a short pace, so a store that goes down costs one caller its
 * deadline and not every caller. With nothing held the default would stand in
 * for a value the store has, so the pace is a fifth of a second and no more:
 * long enough that a burst of requests is one read and one warning, short
 * enough that a caller who tries again a moment later asks the store. Callers
 * that arrive together share the one read either way, and a read that failed
 * warns once, not once per caller.
 *
 * The memo is the definition's own, not the store key's: two readers of one
 * key, each with its own parse, never serve each other's shape. A reader
 * that is defined per call holds its definition on `processSingleton`.
 */

/** A cache shared by every replica, such as a TTL'd key in Redis. Optional. */
export interface SharedCache {
	read<T>(key: string): Promise<{ value: T; at: number } | null>;
	write<T>(key: string, value: T, ttlSeconds: number): Promise<void>;
}

export interface ConfigKeyOptions<T> {
	/** The bare key in the store. */
	key: string;
	defaultValue: T;
	/**
	 * Turn what is stored into a value, merging over the default and refusing
	 * anything missing, non-numeric, non-positive or of the wrong type.
	 */
	parse: (stored: unknown, defaultValue: T) => T;
	/** How long a read is served from memory; `CONFIG_TTL_MS` unless the definition pins its own pace. */
	ttlMs?: number;
	shared?: SharedCache;
	/**
	 * The origin read. For tests; defaults to the store under its deadline,
	 * and to "nothing stored" on a checkout with no store configured.
	 */
	read?: (key: string) => Promise<unknown>;
}

export interface ConfigKey<T> {
	/** The current value, refreshed when the memo has expired. Never throws. */
	read(): Promise<T>;
	/** What the memo holds right now, for a synchronous caller; the default before the first read. */
	cached(): T;
	invalidate(): void;
}

interface Memo<T> {
	value: T;
	at: number;
}

/** How long a failed refresh stands over a last good value before the store is asked again; never longer than the memo itself. */
const FAILURE_PACE_MS = 5_000;

/** The same with nothing held, where what is served meanwhile is the default. */
const COLD_FAILURE_PACE_MS = 200;

/** Without a store there is nothing to merge, and nothing to warn about. */
function readStored(key: string): Promise<unknown> {
	return appConfigAvailable() ? readConfigWithin(key) : Promise.resolve(null);
}

export function defineConfigKey<T>(options: ConfigKeyOptions<T>): ConfigKey<T> {
	const ttlMs = options.ttlMs ?? configTtlMs();
	const read = options.read ?? readStored;
	const failurePaceMs = Math.min(ttlMs, FAILURE_PACE_MS);
	const coldPaceMs = Math.min(ttlMs, COLD_FAILURE_PACE_MS);
	const state: {
		memo?: Memo<T>;
		inFlight?: Promise<T>;
		failedAt?: number;
		/** Raised by `invalidate`: a read begun under an earlier one answers its caller and changes nothing held. */
		generation: number;
	} = { generation: 0 };

	function parse(stored: unknown): T {
		return stored == null
			? options.defaultValue
			: options.parse(stored, options.defaultValue);
	}

	async function refresh(generation: number): Promise<T> {
		const current = () => generation === state.generation;
		const shared = await options.shared
			?.read<unknown>(options.key)
			.catch(() => null);
		if (shared) {
			const value = parse(shared.value);
			if (current()) state.memo = { value, at: shared.at };
			return value;
		}
		const stored = await read(options.key);
		const value = parse(stored);
		// A read that an invalidation overtook answers its own caller and no one
		// else: what it read may be what was just replaced, on every replica.
		if (!current()) return value;
		state.memo = { value, at: Date.now() };
		// Only a value the origin answered is shared; a fallback must not travel.
		await options.shared
			?.write(options.key, stored ?? null, ttlMs / 1000)
			.catch(() => {});
		return value;
	}

	return {
		async read() {
			const memo = state.memo;
			if (memo && Date.now() - memo.at < ttlMs) return memo.value;
			if (
				state.failedAt !== undefined &&
				Date.now() - state.failedAt < (memo ? failurePaceMs : coldPaceMs)
			)
				return memo?.value ?? options.defaultValue;
			const generation = state.generation;
			if (!state.inFlight) {
				const started = refresh(generation)
					.catch((err) => {
						console.warn(
							`[config] "${options.key}" could not be read — serving ${memo ? "the last good value" : "the default"}:`,
							failureReason(err),
						);
						throw err;
					})
					.finally(() => {
						if (state.inFlight === started) state.inFlight = undefined;
					});
				state.inFlight = started;
			}
			try {
				const value = await state.inFlight;
				if (generation === state.generation) state.failedAt = undefined;
				return value;
			} catch {
				if (generation === state.generation) state.failedAt = Date.now();
				return memo?.value ?? options.defaultValue;
			}
		},
		cached() {
			return state.memo?.value ?? options.defaultValue;
		},
		invalidate() {
			state.generation++;
			state.memo = undefined;
			state.failedAt = undefined;
			state.inFlight = undefined;
		},
	};
}
