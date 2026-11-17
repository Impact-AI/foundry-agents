import { expect, test } from "bun:test";
import { bandFraction, bandRules, niceBand } from "./chart-band";

test("a band holds every point on round rules, with air", () => {
	const band = niceBand([12, 47, 31, 58]);
	expect(band).toEqual({ lo: 0, hi: 60, step: 20 });
	expect(bandRules(band)).toEqual([0, 20, 40, 60]);
	expect(bandFraction(band, 30)).toBeCloseTo(0.5);
});

test("a flat series still gets a band, and an empty one a default", () => {
	const flat = niceBand([5, 5, 5]);
	expect(flat.lo).toBeLessThan(5);
	expect(flat.hi).toBeGreaterThan(5);
	expect(niceBand([])).toEqual({ lo: 0, hi: 1, step: 0.25 });
	const one = niceBand([Number.NaN, 3]);
	expect(one.lo).toBeLessThan(3);
	expect(one.hi).toBeGreaterThan(3);
});

test("negative values keep their floor", () => {
	const band = niceBand([-12, 8]);
	expect(band.lo).toBeLessThanOrEqual(-12);
	expect(band.hi).toBeGreaterThanOrEqual(8);
});

test("the rules end whatever the values are: a band too large for its step to move it is drawn by its edges", () => {
	const huge = niceBand([1e17, 1e17 + 16]);
	const rules = bandRules(huge);
	expect(rules.length).toBeLessThanOrEqual(65);
	expect(rules.every(Number.isFinite)).toBe(true);
	expect(bandRules({ lo: 0, hi: 1e9, step: 1 })).toEqual([0, 1e9]);
	expect(bandRules({ lo: 0, hi: 1, step: 0 })).toEqual([0, 1]);
});
