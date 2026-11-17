import { afterEach, expect, spyOn, test } from "bun:test";
import { failureReason, reportFailure, throttledReport } from "./report";

let everyMs = 60_000;
const unavailable = throttledReport("report-test", "unavailable", {
	line: (count) => `bucket unavailable; ${count} request(s) fell back`,
	everyMs: () => everyMs,
});

afterEach(() => {
	everyMs = 60_000;
	unavailable.reset();
});

test("an Error reports its message and anything else its string", () => {
	expect(failureReason(new Error("ECONNREFUSED"))).toBe("ECONNREFUSED");
	expect(failureReason("down")).toBe("down");
	expect(failureReason(42)).toBe("42");
});

test("a failure line is the scope, what failed, and the reason", () => {
	const error = spyOn(console, "error").mockImplementation(() => {});
	try {
		reportFailure("redis", "dial failed", new Error("refused"));
		expect(error).toHaveBeenCalledWith("[redis] dial failed:", "refused");
	} finally {
		error.mockRestore();
	}
});

test("a throttled line speaks once per window, carrying the count it suppressed", () => {
	const error = spyOn(console, "error").mockImplementation(() => {});
	try {
		const err = new Error("connect ECONNREFUSED");
		unavailable(err);
		unavailable(err);
		unavailable(err);
		expect(error).toHaveBeenCalledTimes(1);
		expect(error.mock.calls[0]?.[0]).toBe(
			"[report-test] bucket unavailable; 1 request(s) fell back:",
		);
		expect(error.mock.calls[0]?.[1]).toBe("connect ECONNREFUSED");
		everyMs = 0;
		unavailable(err);
		expect(error).toHaveBeenCalledTimes(2);
		expect(String(error.mock.calls[1]?.[0])).toContain("3 request(s)");
	} finally {
		error.mockRestore();
	}
});

test("a window of zero prints every occurrence, and reset forgets the window", () => {
	everyMs = 0;
	const error = spyOn(console, "error").mockImplementation(() => {});
	try {
		unavailable("down");
		unavailable("down");
		expect(error).toHaveBeenCalledTimes(2);
		expect(String(error.mock.calls[1]?.[0])).toContain("1 request(s)");
		everyMs = 60_000;
		unavailable.reset();
		unavailable("down");
		expect(error).toHaveBeenCalledTimes(3);
	} finally {
		error.mockRestore();
	}
});

test("a console that throws does not fail the caller", () => {
	const error = spyOn(console, "error").mockImplementation(() => {
		throw new Error("no console");
	});
	try {
		expect(() => unavailable("down")).not.toThrow();
	} finally {
		error.mockRestore();
	}
});
