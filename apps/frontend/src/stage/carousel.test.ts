import { describe, expect, test } from "bun:test";
import {
	GRID_MAX,
	gridFor,
	viewAt,
	viewCount,
	viewHolding,
	viewSpan,
} from "./carousel";

const FLOOR = { width: 280, height: 260 };

describe("gridFor", () => {
	test("a narrow, short track is one card", () => {
		expect(gridFor(420, 380, 16, FLOOR)).toEqual({ cols: 1, rows: 1 });
	});

	test("a wide, tall tile is two by two", () => {
		// The library alone on a large screen.
		expect(gridFor(870, 750, 16, FLOOR)).toEqual({ cols: 2, rows: 2 });
	});

	test("sub-pixel rounding does not lose a column", () => {
		expect(gridFor(575.5, 300, 16, FLOOR).cols).toBe(2);
	});

	test("never more than the cap across or down", () => {
		expect(gridFor(5000, 5000, 16, FLOOR)).toEqual({
			cols: GRID_MAX,
			rows: GRID_MAX,
		});
	});

	test("nothing measured yet is one card, never zero", () => {
		expect(gridFor(0, 0, 16, FLOOR)).toEqual({ cols: 1, rows: 1 });
	});
});

describe("viewCount", () => {
	test("nine documents four a view take three views", () => {
		expect(viewCount(9, 4)).toBe(3);
	});

	test("one a view is one view per card", () => {
		expect(viewCount(9, 1)).toBe(9);
	});

	test("an empty track is still one view", () => {
		expect(viewCount(0, 4)).toBe(1);
	});
});

describe("viewSpan", () => {
	test("each view names its own cards, with no overlap", () => {
		expect([0, 1, 2].map((v) => viewSpan(v, 4, 9))).toEqual([
			{ first: 1, last: 4 },
			{ first: 5, last: 8 },
			{ first: 9, last: 9 },
		]);
	});

	test("one a view names one card", () => {
		expect(viewSpan(3, 1, 9)).toEqual({ first: 4, last: 4 });
	});
});

describe("viewAt", () => {
	test("rounds to the nearest view's start", () => {
		expect(viewAt(0, 861, 5)).toBe(0);
		expect(viewAt(861 * 2 + 300, 861, 5)).toBe(2);
		expect(viewAt(861 * 2 + 500, 861, 5)).toBe(3);
	});

	test("stays inside the views there are", () => {
		expect(viewAt(-40, 861, 5)).toBe(0);
		expect(viewAt(861 * 9, 861, 5)).toBe(4);
		expect(viewAt(100, 0, 5)).toBe(0);
	});
});

describe("viewHolding", () => {
	test("a reshaped grid keeps the card that led the view in sight", () => {
		// Card 5 (index 4) led view 4 of one-a-view; four a view, it is in view 1.
		expect(viewHolding(4, 4)).toBe(1);
		expect(viewHolding(4, 1)).toBe(4);
		expect(viewHolding(0, 4)).toBe(0);
	});
});
