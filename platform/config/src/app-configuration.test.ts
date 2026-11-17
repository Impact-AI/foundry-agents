import { afterEach, beforeEach, expect, test } from "bun:test";
import type { AppConfigurationClient } from "@azure/app-configuration";
import { scopedEnv } from "@platform/test-support";
import {
	AppConfigTimeoutError,
	readConfig,
	readConfigWithin,
	resetAppConfigClient,
	seedConfigDocuments,
	setAppConfigClient,
} from "./app-configuration";
import {
	addConfigIfAbsent,
	ConfigConflictError,
	readConfigEntry,
	writeConfig,
} from "./app-configuration/store";

/**
 * The store faked at the SDK boundary: what is under test is this package's
 * seam — key namespacing, JSON round-tripping, which HTTP statuses mean
 * "absent" and which "someone else wrote first" — not the store itself.
 */
interface Stored {
	value: string;
	etag: string;
	contentType?: string;
}

function fakeStore(seed: Record<string, Stored> = {}) {
	const settings = new Map(Object.entries(seed));
	let etags = 100;
	const fail = (statusCode: number) =>
		Object.assign(new Error(`HTTP ${statusCode}`), { statusCode });
	const client = {
		getConfigurationSetting: async (
			{ key }: { key: string },
			options?: { abortSignal?: AbortSignal },
		) => {
			if (options?.abortSignal?.aborted) throw new Error("aborted");
			const found = settings.get(key);
			if (!found) throw fail(404);
			return { key, ...found };
		},
		setConfigurationSetting: async (
			setting: {
				key: string;
				value?: string;
				etag?: string;
				contentType?: string;
			},
			options?: { onlyIfUnchanged?: boolean },
		) => {
			if (
				options?.onlyIfUnchanged &&
				settings.get(setting.key)?.etag !== setting.etag
			) {
				throw fail(412);
			}
			const etag = `etag-${++etags}`;
			settings.set(setting.key, {
				value: setting.value ?? "",
				etag,
				contentType: setting.contentType,
			});
			return { key: setting.key, value: setting.value, etag };
		},
		addConfigurationSetting: async (setting: {
			key: string;
			value?: string;
		}) => {
			if (settings.has(setting.key)) throw fail(412);
			const etag = `etag-${++etags}`;
			settings.set(setting.key, { value: setting.value ?? "", etag });
			return { key: setting.key, value: setting.value, etag };
		},
	} as unknown as AppConfigurationClient;
	return { client, settings };
}

let restoreEnv: () => void = () => {};

beforeEach(() => {
	restoreEnv = scopedEnv({
		APP_CONFIG_KEY_PREFIX: undefined,
		APP_CONFIG_ENDPOINT: undefined,
	});
});

afterEach(() => {
	resetAppConfigClient();
	restoreEnv();
});

test("callers pass bare names; the store sees them under the prefix, never doubled", async () => {
	const { client, settings } = fakeStore();
	setAppConfigClient(client);
	await writeConfig("limits", { a: 1 });
	expect([...settings.keys()]).toEqual(["app/limits"]);
	await writeConfig("app/limits", { a: 2 });
	expect([...settings.keys()]).toEqual(["app/limits"]);
	expect(await readConfig<{ a: number }>("limits")).toEqual({ a: 2 });
});

test("the prefix is configuration", async () => {
	process.env.APP_CONFIG_KEY_PREFIX = "sample/";
	const { client, settings } = fakeStore();
	setAppConfigClient(client);
	await writeConfig("limits", 1);
	expect([...settings.keys()]).toEqual(["sample/limits"]);
});

test("an absent key is null, a non-JSON value is its string, a real failure propagates", async () => {
	const { client } = fakeStore({
		"app/raw": { value: "not json", etag: "e1" },
	});
	setAppConfigClient(client);
	expect(await readConfigEntry("missing")).toEqual({ value: null });
	expect(await readConfig<string>("raw")).toBe("not json");
	setAppConfigClient({
		getConfigurationSetting: async () => {
			throw Object.assign(new Error("forbidden"), { statusCode: 403 });
		},
	} as unknown as AppConfigurationClient);
	await expect(readConfig("raw")).rejects.toThrow("forbidden");
});

test("a conditional write goes through on the current etag and refuses on a stale one", async () => {
	const { client } = fakeStore();
	setAppConfigClient(client);
	await writeConfig("doc", { v: 1 });
	const { etag } = await readConfigEntry("doc");
	await writeConfig("doc", { v: 2 }, { etag });
	await expect(writeConfig("doc", { v: 3 }, { etag })).rejects.toBeInstanceOf(
		ConfigConflictError,
	);
	expect(await readConfig<{ v: number }>("doc")).toEqual({ v: 2 });
});

test("add-if-absent writes once and declines after", async () => {
	const { client } = fakeStore();
	setAppConfigClient(client);
	expect(await addConfigIfAbsent("seed", 1)).toBe(true);
	expect(await addConfigIfAbsent("seed", 2)).toBe(false);
	expect(await readConfig<number>("seed")).toBe(1);
});

test("seeding writes an absent key and a `{}`, verbatim, and never an edited one or one edited under it", async () => {
	const { client, settings } = fakeStore({
		"app/empty": { value: "{}", etag: "e1" },
		"app/edited": { value: '{"c":99}', etag: "e2" },
		"app/raced": { value: "{}", etag: "e3" },
	});
	const read = client.getConfigurationSetting.bind(client);
	client.getConfigurationSetting = (async (
		...args: Parameters<typeof read>
	) => {
		const answer = await read(...args);
		if (args[0].key === "app/raced")
			settings.set("app/raced", { value: '{"d":1}', etag: "e4" });
		return answer;
	}) as typeof client.getConfigurationSetting;
	setAppConfigClient(client);
	const written = await seedConfigDocuments({
		absent: { a: 1, text: "two words" },
		empty: { b: [1, 2] },
		edited: { c: 3 },
		raced: { d: 2 },
	});
	expect(written).toEqual(["absent", "empty"]);
	expect(settings.get("app/absent")?.value).toBe('{"a":1,"text":"two words"}');
	expect(settings.get("app/empty")?.value).toBe('{"b":[1,2]}');
	expect(settings.get("app/edited")?.value).toBe('{"c":99}');
	expect(settings.get("app/raced")?.value).toBe('{"d":1}');
	expect(await seedConfigDocuments({ absent: { a: 2 } })).toEqual([]);
});

test("a read under a deadline fails with the deadline's error when the store hangs", async () => {
	setAppConfigClient({
		getConfigurationSetting: () => new Promise(() => {}),
	} as unknown as AppConfigurationClient);
	await expect(readConfigWithin("slow", 20)).rejects.toBeInstanceOf(
		AppConfigTimeoutError,
	);
});

test("without an endpoint the error names the variable", async () => {
	resetAppConfigClient();
	await expect(readConfig("x")).rejects.toThrow("APP_CONFIG_ENDPOINT");
});
