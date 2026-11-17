import { afterEach, expect, spyOn, test } from "bun:test";
import { resetAppConfigClient, setAppConfigClient } from "@platform/config";
import { scopedEnv } from "@platform/test-support";
import { stagedAccessSettings, stagedSettings } from "../testing/fake-config";
import {
	AccessSettingsUnreadError,
	accessSettings,
	DEFAULT_ACCESS_SETTINGS,
	defaultAccessSettings,
	defaultDocumentAccess,
	parseAccessSettings,
	resetAccessSettings,
	settledAccessSettings,
} from "./access";

let restore = () => {};

afterEach(() => {
	restore();
	restore = () => {};
	resetAccessSettings();
});

test("enforcement is off and global access on until an operator says otherwise", () => {
	expect(DEFAULT_ACCESS_SETTINGS).toEqual({
		enforceAccessControl: false,
		globalDocumentAccess: true,
	});
});

test("a hardened deployment enforces readers by default, with undeclared documents still everybody's; a stored document still decides", async () => {
	const hardened = scopedEnv({ HARDENED: "true" });
	try {
		expect(defaultAccessSettings()).toEqual({
			enforceAccessControl: true,
			globalDocumentAccess: true,
		});
		resetAccessSettings();
		// No store: the deployment's default.
		expect((await accessSettings()).enforceAccessControl).toBe(true);
		// A stored switch that is absent keeps the hardened default; one that is set is the operator's.
		restore = stagedAccessSettings({ globalDocumentAccess: false });
		expect(await accessSettings()).toEqual({
			enforceAccessControl: true,
			globalDocumentAccess: false,
		});
		restore();
		restore = stagedAccessSettings({ enforceAccessControl: false });
		expect((await accessSettings()).enforceAccessControl).toBe(false);
	} finally {
		hardened();
	}
	for (const demo of [undefined, "false"]) {
		const off = scopedEnv({ HARDENED: demo });
		try {
			expect(defaultAccessSettings()).toEqual(DEFAULT_ACCESS_SETTINGS);
		} finally {
			off();
		}
	}
});

test("a stored switch is taken only as a boolean; anything else closes it, and an absent one keeps the default", () => {
	expect(
		parseAccessSettings(
			{ enforceAccessControl: true, globalDocumentAccess: false },
			DEFAULT_ACCESS_SETTINGS,
		),
	).toEqual({ enforceAccessControl: true, globalDocumentAccess: false });
	expect(
		parseAccessSettings(
			{ enforceAccessControl: "true", globalDocumentAccess: 1, extra: true },
			DEFAULT_ACCESS_SETTINGS,
		),
	).toEqual({ enforceAccessControl: true, globalDocumentAccess: false });
	expect(parseAccessSettings({}, DEFAULT_ACCESS_SETTINGS)).toEqual(
		DEFAULT_ACCESS_SETTINGS,
	);
	expect(parseAccessSettings("oops", DEFAULT_ACCESS_SETTINGS)).toEqual({
		enforceAccessControl: true,
		globalDocumentAccess: false,
	});
});

test("a store that is configured and has never answered is an error, not the default; once it answers, its document is read", async () => {
	let down = true;
	setAppConfigClient({
		getConfigurationSetting: async () => {
			if (down) throw new Error("the store is unreachable");
			return { value: JSON.stringify({ enforceAccessControl: true }) };
		},
	} as unknown as Parameters<typeof setAppConfigClient>[0]);
	restore = resetAppConfigClient;
	resetAccessSettings();
	await expect(accessSettings()).rejects.toBeInstanceOf(
		AccessSettingsUnreadError,
	);
	down = false;
	// A failed read is paced by the reader for a moment, so the next one is a fresh definition's.
	resetAccessSettings();
	expect(await accessSettings()).toEqual({
		enforceAccessControl: true,
		globalDocumentAccess: true,
	});
});

test("the key reads the stored document through the memo, and the default with no store", async () => {
	expect(await accessSettings()).toEqual(DEFAULT_ACCESS_SETTINGS);
	restore = stagedAccessSettings({ enforceAccessControl: true });
	expect(await accessSettings()).toEqual({
		enforceAccessControl: true,
		globalDocumentAccess: true,
	});
});

test("an undescribed document is everybody's while global access is on, and nobody's when it is off", () => {
	expect(defaultDocumentAccess(DEFAULT_ACCESS_SETTINGS)).toEqual({
		oids: [],
		groups: ["all"],
	});
	expect(
		defaultDocumentAccess({
			enforceAccessControl: true,
			globalDocumentAccess: false,
		}),
	).toEqual({ oids: [], groups: [] });
});

test("a document stored as null closes both switches, where an absent one keeps the defaults", async () => {
	restore = stagedSettings({ access: null });
	expect(await accessSettings()).toEqual({
		enforceAccessControl: true,
		globalDocumentAccess: false,
	});
	restore();
	restore = stagedSettings({});
	expect(await accessSettings()).toEqual(DEFAULT_ACCESS_SETTINGS);
});

test("a job's read asks a store that has not answered again, and gives up only after its last wait", async () => {
	let failures = 2;
	let asked = 0;
	setAppConfigClient({
		getConfigurationSetting: async () => {
			asked++;
			if (failures-- > 0) throw new Error("the store is unreachable");
			return { value: JSON.stringify({ enforceAccessControl: true }) };
		},
	} as unknown as Parameters<typeof setAppConfigClient>[0]);
	restore = resetAppConfigClient;
	resetAccessSettings();
	const warned = spyOn(console, "warn").mockImplementation(() => {});
	try {
		expect(await settledAccessSettings([1, 1, 1])).toEqual({
			enforceAccessControl: true,
			globalDocumentAccess: true,
		});
		expect(asked).toBe(3);
		failures = 100;
		resetAccessSettings();
		await expect(settledAccessSettings([1, 1])).rejects.toBeInstanceOf(
			AccessSettingsUnreadError,
		);
		// Once before each wait, and once after the last.
		expect(asked).toBe(6);
	} finally {
		warned.mockRestore();
	}
});

test("an answer an invalidation overtook is the caller's alone: a read that then fails with nothing held is refused, never the open default", async () => {
	let release: () => void = () => {};
	let asked = 0;
	setAppConfigClient({
		getConfigurationSetting: async () => {
			asked++;
			// Only the second read is answered, and late.
			if (asked !== 2) throw new Error("the store is unreachable");
			await new Promise<void>((resolve) => {
				release = resolve;
			});
			return { value: JSON.stringify({ enforceAccessControl: true }) };
		},
	} as unknown as Parameters<typeof setAppConfigClient>[0]);
	restore = resetAppConfigClient;
	resetAccessSettings();
	const warned = spyOn(console, "warn").mockImplementation(() => {});
	try {
		// Two steps ask together and share the first read, which fails.
		const first = settledAccessSettings([20, 2_000]);
		const second = settledAccessSettings([40]);
		// The first waits less, asks again and is still waiting on the store
		// when the second's wait ends: that invalidates under the read in
		// flight, and the second's own read fails.
		await expect(second).rejects.toBeInstanceOf(AccessSettingsUnreadError);
		release();
		// The read that was overtaken answers its own caller with what the store said,
		expect(await first).toEqual({
			enforceAccessControl: true,
			globalDocumentAccess: true,
		});
		// and left nothing held: the next read fails, and is a refusal.
		await new Promise((r) => setTimeout(r, 250));
		await expect(accessSettings()).rejects.toBeInstanceOf(
			AccessSettingsUnreadError,
		);
	} finally {
		warned.mockRestore();
	}
});
