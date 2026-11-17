import type { SharedCache } from "@platform/config";
import { getRedis } from "./client/connection";
import { reportRedisFailure } from "./client/report";
import type { KeyNamespace } from "./keys";

/**
 * The layer the fleet shares under each replica's own process memo: after the
 * process memo misses and before the origin is asked, one GET; after an origin
 * answer, one SET with the memo's own TTL. The fleet then reads an origin
 * about once per TTL in total, and a replica that has just scaled up warms in
 * a millisecond instead of paying the origin on somebody's request.
 *
 * Three rules, each the reason for a line below:
 *
 * - Reads fail soft. No Redis, a sick Redis, an envelope this build cannot
 *   read: all of it is a miss, never an error on a request path.
 * - Only truth is written. A replica that served its compiled-in fallback
 *   keeps that answer to itself; sharing it would broadcast one replica's blip
 *   to the fleet for a TTL. `write` is for a value the origin answered.
 * - Every key expires and has a size budget. Under a `volatile-*` eviction
 *   policy an unbounded cache does not fail loudly, it silently evicts some
 *   other TTL'd key, so a value over budget is refused rather than written.
 */

/** The most one memo value may serialise to; over it, the write is refused. */
export const DEFAULT_MEMO_MAX_BYTES = 1_000_000;

/** Bumped when the envelope changes shape, so a deploy never reads its predecessor's as its own. */
const ENVELOPE_VERSION = "v1";

/** A shared value and the moment it was written, which is when its origin answered. */
export interface SharedMemoHit<T> {
	value: T;
	at: number;
}

export interface SharedMemo extends SharedCache {
	/** The fleet's memo of `name`, or null for a miss of any kind. */
	read<T>(name: string): Promise<SharedMemoHit<T> | null>;
	/**
	 * Share a value the origin just answered, for `ttlSeconds`: the same TTL
	 * the caller's process memo uses, so the two clocks agree. Whole seconds;
	 * a TTL under one writes nothing.
	 */
	write(name: string, value: unknown, ttlSeconds: number): Promise<void>;
	/** Drop `name`, so every replica's next miss goes to the origin. */
	drop(name: string): Promise<void>;
}

export interface SharedMemoOptions {
	maxBytes?: number;
}

export function sharedMemo(
	namespace: KeyNamespace,
	{ maxBytes = DEFAULT_MEMO_MAX_BYTES }: SharedMemoOptions = {},
): SharedMemo {
	const key = (name: string) => namespace.key("memo", ENVELOPE_VERSION, name);
	return {
		async read<T>(name: string): Promise<SharedMemoHit<T> | null> {
			const redis = await getRedis();
			if (!redis) return null;
			try {
				const raw = await redis.get(key(name));
				return raw === null ? null : decode<T>(raw);
			} catch (err) {
				reportRedisFailure(`memo read of "${name}" failed; a miss`, err);
				return null;
			}
		},
		async write(name, value, ttlSeconds) {
			const ttl = Math.floor(ttlSeconds);
			if (!(ttl > 0)) return;
			const redis = await getRedis();
			if (!redis) return;
			let blob: string;
			try {
				blob = JSON.stringify({ at: Date.now(), value });
			} catch (err) {
				// A value that cannot be written as JSON is not shared; the
				// process memo still holds it.
				reportRedisFailure(`memo write of "${name}" failed; not shared`, err);
				return;
			}
			const bytes = Buffer.byteLength(blob);
			if (bytes > maxBytes) {
				console.error(
					`[redis] refusing to share memo "${name}": ${bytes} bytes against a budget of ${maxBytes}`,
				);
				return;
			}
			try {
				await redis.set(key(name), blob, "EX", ttl);
			} catch (err) {
				reportRedisFailure(`memo write of "${name}" failed; not shared`, err);
			}
		},
		async drop(name) {
			const redis = await getRedis();
			if (!redis) return;
			try {
				await redis.del(key(name));
			} catch (err) {
				reportRedisFailure(
					`memo drop of "${name}" failed; it expires on its own`,
					err,
				);
			}
		},
	};
}

function decode<T>(raw: string): SharedMemoHit<T> | null {
	try {
		const parsed = JSON.parse(raw) as { at?: unknown; value?: unknown };
		if (typeof parsed?.at !== "number") return null;
		return { at: parsed.at, value: parsed.value as T };
	} catch {
		return null;
	}
}
