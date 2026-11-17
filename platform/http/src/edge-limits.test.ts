import { describe, expect, spyOn, test } from "bun:test";
import {
	DEFAULT_EDGE_LIMITS,
	edgeLimits,
	edgeLimitsFromStored,
} from "./edge-limits";

/**
 * A hand edit in the portal must not be able to stop every request with a body: an
 * unusable number is ignored, never obeyed, and nothing reads as "no limit".
 */
describe("what the store is allowed to say", () => {
	test("an empty document, a raised limit, and an unrelated field", () => {
		expect(edgeLimitsFromStored({})).toEqual(DEFAULT_EDGE_LIMITS);
		expect(edgeLimitsFromStored(null)).toEqual(DEFAULT_EDGE_LIMITS);
		expect(edgeLimitsFromStored({ maxRequestBodyBytes: 1_048_576 })).toEqual({
			maxRequestBodyBytes: 1_048_576,
		});
		expect(
			edgeLimitsFromStored({ other: 5, maxRequestBodyBytes: 262_144 }),
		).toEqual({ maxRequestBodyBytes: 262_144 });
	});

	test("zero, a negative, a fraction, a non-number, kilobytes, and too many zeroes are refused", () => {
		const quiet = spyOn(console, "error").mockImplementation(() => {});
		try {
			for (const value of [
				0,
				-1,
				1.5,
				"131072",
				true,
				null,
				[],
				{},
				Number.NaN,
				Number.POSITIVE_INFINITY,
				128,
				1_000_000_000,
			]) {
				expect(edgeLimitsFromStored({ maxRequestBodyBytes: value })).toEqual(
					DEFAULT_EDGE_LIMITS,
				);
			}
		} finally {
			quiet.mockRestore();
		}
	});
});

test("a bare checkout has no store, and the cached read is the default", () => {
	expect(edgeLimits().cached()).toEqual(DEFAULT_EDGE_LIMITS);
	expect(DEFAULT_EDGE_LIMITS.maxRequestBodyBytes).toBe(1_048_576);
});
