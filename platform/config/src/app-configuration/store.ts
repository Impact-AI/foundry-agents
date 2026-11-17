import type { ConfigurationSetting } from "@azure/app-configuration";
import { isNotFound, isPreconditionFailed } from "../azure-errors";
import { withDeadline } from "../deadline";
import { envInt } from "../env";
import { appConfigClient, qualifyKey } from "./client";

/**
 * Reads of JSON documents in the store, and the two conditional writes that
 * seeding a document needs (see `seed`); an operator edits the rest in the
 * portal.
 *
 * No caching here: each reader owns a cache calibrated to its own path (see
 * `config-key`), and a layer underneath would make those TTLs lie. No
 * transactions either, since the store is per key; what it offers instead is
 * the etag, so a read-modify-write detects a concurrent edit.
 */

const JSON_CONTENT_TYPE = "application/json";

export interface ConfigEntry<T> {
	value: T | null;
	/** Absent when the key does not exist. */
	etag?: string;
}

export interface ReadOptions {
	abortSignal?: AbortSignal;
}

export interface WriteOptions {
	/** Fail unless the stored etag still matches: the store's optimistic concurrency. */
	etag?: string;
}

export class ConfigConflictError extends Error {
	constructor(readonly configKey: string) {
		super(
			`App Configuration key "${configKey}" changed underneath this write — re-read it and retry.`,
		);
		this.name = "ConfigConflictError";
	}
}

export class AppConfigTimeoutError extends Error {
	constructor(
		readonly configKey: string,
		readonly timeoutMs: number,
	) {
		super(
			`App Configuration key "${configKey}" did not answer within ${timeoutMs}ms. ` +
				"Check that the store's private DNS zone is attached and APP_CONFIG_ENDPOINT resolves from the app's subnet.",
		);
		this.name = "AppConfigTimeoutError";
	}
}

/**
 * Two seconds covers a warm token plus a cold acquisition; a store slower than
 * that is not one a page should wait for.
 */
export const DEFAULT_APP_CONFIG_TIMEOUT_MS = 2000;

export function appConfigTimeoutMs(): number {
	return envInt("APP_CONFIG_TIMEOUT_MS", DEFAULT_APP_CONFIG_TIMEOUT_MS, {
		min: 1,
	});
}

/** A value hand-edited in the portal into something that is not JSON reads as the string it is. */
function parseValue<T>(setting: ConfigurationSetting): T | null {
	if (setting.value == null) return null;
	try {
		return JSON.parse(setting.value) as T;
	} catch {
		return setting.value as unknown as T;
	}
}

/** The key with its etag; `{ value: null }` when absent. Throws on a real failure. */
export async function readConfigEntry<T = unknown>(
	key: string,
	options: ReadOptions = {},
): Promise<ConfigEntry<T>> {
	try {
		const setting = await appConfigClient().getConfigurationSetting(
			{ key: qualifyKey(key) },
			{ abortSignal: options.abortSignal },
		);
		return { value: parseValue<T>(setting), etag: setting.etag };
	} catch (err) {
		if (isNotFound(err)) return { value: null };
		throw err;
	}
}

export async function readConfig<T = unknown>(
	key: string,
	options: ReadOptions = {},
): Promise<T | null> {
	return (await readConfigEntry<T>(key, options)).value;
}

/** {@link readConfig} under a deadline, for a caller on a render path. */
export function readConfigWithin<T = unknown>(
	key: string,
	timeoutMs: number = appConfigTimeoutMs(),
): Promise<T | null> {
	return withDeadline(
		(abortSignal) => readConfig<T>(key, { abortSignal }),
		timeoutMs,
		() => new AppConfigTimeoutError(key, timeoutMs),
	);
}

/** Upsert; with an etag, a conditional write that throws {@link ConfigConflictError}. */
export async function writeConfig(
	key: string,
	value: unknown,
	options: WriteOptions = {},
): Promise<void> {
	const setting: ConfigurationSetting = {
		key: qualifyKey(key),
		value: JSON.stringify(value),
		contentType: JSON_CONTENT_TYPE,
		isReadOnly: false,
	};
	try {
		await appConfigClient().setConfigurationSetting(
			options.etag ? { ...setting, etag: options.etag } : setting,
			options.etag ? { onlyIfUnchanged: true } : undefined,
		);
	} catch (err) {
		if (options.etag && isPreconditionFailed(err)) {
			throw new ConfigConflictError(key);
		}
		throw err;
	}
}

/** Create the key only if absent, atomically. False when it already existed. */
export async function addConfigIfAbsent(
	key: string,
	value: unknown,
): Promise<boolean> {
	try {
		await appConfigClient().addConfigurationSetting({
			key: qualifyKey(key),
			value: JSON.stringify(value),
			contentType: JSON_CONTENT_TYPE,
		});
		return true;
	} catch (err) {
		if (isPreconditionFailed(err)) return false;
		throw err;
	}
}
