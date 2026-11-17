import { expect, test } from "bun:test";
import { clampCost, clampRefund, rollingDay } from "./script";

test("a cost is clamped into [1, capacity]", () => {
	expect(clampCost(1, 10)).toBe(1);
	expect(clampCost(4, 10)).toBe(4);
	// Never zero or negative: either leaves the route unbounded.
	expect(clampCost(0, 10)).toBe(1);
	expect(clampCost(-5, 10)).toBe(1);
	expect(clampCost(0.5, 10)).toBe(1);
	// A mis-parsed knob: NaN would lose every comparison and refuse for ever,
	// Infinity would empty the bucket per call. Both read as one credit.
	expect(clampCost(Number.NaN, 10)).toBe(1);
	expect(clampCost(Number.POSITIVE_INFINITY, 10)).toBe(1);
	// Never above capacity: a cost the bucket cannot hold is a route never admitted.
	expect(clampCost(50, 10)).toBe(10);
	expect(clampCost(5, 0)).toBe(1);
	// A capacity below one credit: a full bucket pays it whole, where a cost
	// of one would never be affordable.
	expect(clampCost(1, 0.5)).toBe(0.5);
	expect(clampCost(0, 0.5)).toBe(0.5);
	expect(clampCost(Number.NaN, 0.5)).toBe(0.5);
});

test("a refund is clamped, and zero means do not run the script", () => {
	// Zero is a no-op rather than a floor of one — the mirror of the cost
	// clamp, which floors at one because a zero debit would unbound the route.
	expect(clampRefund(0, 10)).toBe(0);
	expect(clampRefund(-5, 10)).toBe(0);
	expect(clampRefund(4, 10)).toBe(4);
	expect(clampRefund(50, 10)).toBe(10);
	// Non-finite is dropped at both ends: NaN would be stored, and Infinity is
	// "we do not know how much went unused", whose safe reading is none.
	expect(clampRefund(Number.NaN, 10)).toBe(0);
	expect(clampRefund(Number.POSITIVE_INFINITY, 10)).toBe(0);
});

test("a rolling day holds the whole allowance and refills it over 1440 minutes", () => {
	expect(rollingDay(1440)).toEqual({ capacity: 1440, refillPerMinute: 1 });
	expect(rollingDay(200).refillPerMinute).toBeCloseTo(200 / 1440, 10);
});
