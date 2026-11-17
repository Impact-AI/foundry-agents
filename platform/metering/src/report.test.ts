import { afterEach, expect, spyOn, test } from "bun:test";
import { scopedEnv } from "@platform/test-support";
import { reportUnavailable, resetUnavailableReporting } from "./report";

let restore: (() => void) | undefined;

afterEach(() => {
	restore?.();
	restore = undefined;
	resetUnavailableReporting();
});

test("failing open says so once per window, with the count it suppressed", () => {
	const error = spyOn(console, "error").mockImplementation(() => {});
	try {
		const err = new Error("connect ECONNREFUSED");
		reportUnavailable(err);
		reportUnavailable(err);
		reportUnavailable(err);
		// The first speaks; the two behind it are counted and silent, which is
		// what stops an outage writing a line per request.
		expect(error).toHaveBeenCalledTimes(1);
		expect(String(error.mock.calls[0]?.[0])).toContain("1 request(s)");
		expect(error.mock.calls[0]?.[1]).toBe("connect ECONNREFUSED");
	} finally {
		error.mockRestore();
	}
});

test("a window of zero prints every request, carrying what went through since the last line", () => {
	restore = scopedEnv({ METERING_UNAVAILABLE_LOG_SECONDS: "0" });
	const error = spyOn(console, "error").mockImplementation(() => {});
	try {
		reportUnavailable("down");
		reportUnavailable("down");
		expect(error).toHaveBeenCalledTimes(2);
		expect(String(error.mock.calls[1]?.[0])).toContain("1 request(s)");
	} finally {
		error.mockRestore();
	}
});

test("a console that throws does not fail the request being admitted", () => {
	const error = spyOn(console, "error").mockImplementation(() => {
		throw new Error("no console");
	});
	try {
		expect(() => reportUnavailable("down")).not.toThrow();
	} finally {
		error.mockRestore();
	}
});
