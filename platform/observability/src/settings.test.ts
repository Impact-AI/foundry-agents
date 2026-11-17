import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { scopedEnv } from "@platform/test-support";
import {
	CONNECTION_STRING_VAR,
	connectionString,
	DEFAULT_TELEMETRY,
	fromStored,
	telemetryConfigured,
	telemetrySettings,
} from "./settings";

/**
 * Off unless configured, and unbreakable by a portal edit: the one number an
 * operator can change during an incident cannot be typed into a value that
 * silently stops recording.
 */

let restore: () => void;

beforeEach(() => {
	restore = scopedEnv({ [CONNECTION_STRING_VAR]: undefined });
});

afterEach(() => restore());

describe("the switch", () => {
	test("unset or blank means off; a value means on, trimmed", () => {
		delete process.env[CONNECTION_STRING_VAR];
		expect(telemetryConfigured()).toBe(false);
		process.env[CONNECTION_STRING_VAR] = "   ";
		expect(telemetryConfigured()).toBe(false);
		process.env[CONNECTION_STRING_VAR] = " InstrumentationKey=abc ";
		expect(connectionString()).toBe("InstrumentationKey=abc");
		expect(telemetryConfigured()).toBe(true);
	});
});

describe("the sampling ratio, merged over the defaults", () => {
	test("an empty document is the default and a valid ratio wins", () => {
		expect(fromStored({}, DEFAULT_TELEMETRY)).toEqual(DEFAULT_TELEMETRY);
		expect(
			fromStored({ samplingRatio: 0.25 }, DEFAULT_TELEMETRY).samplingRatio,
		).toBe(0.25);
	});

	test.each([
		["a string", { samplingRatio: "0.5" }],
		["null", { samplingRatio: null }],
		["NaN", { samplingRatio: Number.NaN }],
		["zero — which would silently record nothing", { samplingRatio: 0 }],
		["negative", { samplingRatio: -1 }],
		["above one", { samplingRatio: 50 }],
		["not an object at all", "nonsense"],
	])("%s falls back to the default rather than to zero", (_name, stored) => {
		expect(fromStored(stored, DEFAULT_TELEMETRY).samplingRatio).toBe(
			DEFAULT_TELEMETRY.samplingRatio,
		);
	});

	test("an unknown key is ignored rather than carried through", () => {
		expect(
			fromStored({ samplingRatio: 0.5, enabled: false }, DEFAULT_TELEMETRY),
		).toEqual({ samplingRatio: 0.5 });
	});

	test("the synchronous read a sampler uses answers the default before the first read", () => {
		expect(telemetrySettings().cached()).toEqual(DEFAULT_TELEMETRY);
	});
});
