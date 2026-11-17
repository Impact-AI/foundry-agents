import { afterEach, expect, spyOn, test } from "bun:test";
import { scopedEnv } from "@platform/test-support";
import {
	configTtlMs,
	DEFAULT_CONFIG_TTL_MS,
	envFlag,
	envInt,
	envString,
	isOn,
} from "./env";

const NAME = "PLATFORM_CONFIG_ENV_TEST";

afterEach(() => {
	delete process.env[NAME];
});

test("unset or blank is the fallback, silently", () => {
	expect(envInt(NAME, 7)).toBe(7);
	process.env[NAME] = "  ";
	expect(envInt(NAME, 7)).toBe(7);
});

test("an integer in range is read as given", () => {
	process.env[NAME] = "12";
	expect(envInt(NAME, 7, { min: 1, max: 20 })).toBe(12);
});

test("a typo, a float, infinity or an out-of-range value is the fallback, warned once", () => {
	const warn = spyOn(console, "warn").mockImplementation(() => {});
	try {
		for (const raw of ["abc", "1.5", "Infinity", "0", "99"]) {
			process.env[NAME] = raw;
			expect(envInt(NAME, 7, { min: 1, max: 20 })).toBe(7);
		}
		expect(warn).toHaveBeenCalledTimes(1);
	} finally {
		warn.mockRestore();
	}
});

test("a flag is off only for the explicit off-values; unset or blank is whatever the reader says it is", () => {
	for (const raw of ["0", "false", "No", " off "]) {
		process.env[NAME] = raw;
		expect(envFlag(NAME)).toBe(false);
		expect(envFlag(NAME, true)).toBe(false);
	}
	for (const raw of ["1", "true", "yes", "anything"]) {
		process.env[NAME] = raw;
		expect(envFlag(NAME)).toBe(true);
	}
	for (const raw of ["", "  "]) {
		process.env[NAME] = raw;
		expect(envFlag(NAME)).toBe(false);
		expect(envFlag(NAME, true)).toBe(true);
	}
	delete process.env[NAME];
	expect(envFlag(NAME)).toBe(false);
	expect(envFlag(NAME, true)).toBe(true);
	expect(isOn(undefined)).toBe(false);
	expect(isOn(undefined, true)).toBe(true);
	expect(isOn("off", true)).toBe(false);
});

test("the memo pace is one variable, at least a millisecond", () => {
	expect(configTtlMs()).toBe(DEFAULT_CONFIG_TTL_MS);
	const restore = scopedEnv({ CONFIG_TTL_MS: "5000" });
	try {
		expect(configTtlMs()).toBe(5000);
	} finally {
		restore();
	}
});

test("a string is trimmed, and blank is undefined", () => {
	process.env[NAME] = "  value ";
	expect(envString(NAME)).toBe("value");
	process.env[NAME] = "   ";
	expect(envString(NAME)).toBeUndefined();
});
