import { envInt, envString } from "@platform/config";

/**
 * Environment variables rather than store keys, against the rule for a
 * tunable: this client sits under the shared memo that App Configuration is
 * itself read through, so a key here would be fetched by the path it bounds.
 */

export const DEFAULT_COMMAND_TIMEOUT_MS = 1_000;
export const DEFAULT_CONNECT_TIMEOUT_MS = 5_000;
export const DEFAULT_RETRY_COOLDOWN_MS = 10_000;

/** Where Redis is, or `undefined` when the process runs without one. */
export function redisUrl(): string | undefined {
	return envString("REDIS_URL");
}

/**
 * How long one command may be outstanding. A second, because every caller
 * stands in front of an origin of its own and a lookup slower than that origin
 * is worth nothing. There is no opt-out: the bound is what makes "no answer"
 * the same outcome as "no Redis", so a non-positive value is the default.
 */
export function commandTimeoutMs(): number {
	return envInt("REDIS_COMMAND_TIMEOUT_MS", DEFAULT_COMMAND_TIMEOUT_MS, {
		min: 1,
	});
}

/** How long one dial may take before the process carries on without Redis. */
export function connectTimeoutMs(): number {
	return envInt("REDIS_CONNECT_TIMEOUT_MS", DEFAULT_CONNECT_TIMEOUT_MS, {
		min: 1,
	});
}

/**
 * How long after a failed dial or a lost socket callers are answered "no
 * Redis" without a new dial. Paying a dial timeout per request would turn a
 * Redis outage into a latency outage; zero redials on every call.
 */
export function retryCooldownMs(): number {
	return envInt("REDIS_RETRY_COOLDOWN_MS", DEFAULT_RETRY_COOLDOWN_MS, {
		min: 0,
	});
}
