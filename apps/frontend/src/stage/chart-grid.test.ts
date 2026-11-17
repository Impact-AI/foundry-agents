import { describe, expect, test } from "bun:test";
import { chartGrid, runsOf } from "./chart-grid";
import { readChart } from "./tools";

const series = (name: string, points: [string, number][]) => ({
	name,
	points: points.map(([x, y]) => ({ x, y })),
});

describe("a chart's series on one x axis", () => {
	test("a missing value is a gap at its label, not the next value moved into it", () => {
		const chart = readChart({
			title: "t",
			series: [
				{
					name: "a",
					points: [
						{ x: "Q1", y: 1 },
						{ x: "Q2", y: null },
						{ x: "Q3", y: 3 },
					],
				},
			],
		});
		if (!chart) throw new Error("no chart");
		const grid = chartGrid(chart.series);
		// The label stays on the axis, so the line breaks there rather than joining across it.
		expect(grid.labels).toEqual(["Q1", "Q2", "Q3"]);
		expect(grid.values).toEqual([[1, null, 3]]);
		const withQ2 = chartGrid([
			...chart.series,
			series("b", [
				["Q1", 5],
				["Q2", 6],
				["Q3", 7],
			]),
		]);
		expect(withQ2.labels).toEqual(["Q1", "Q2", "Q3"]);
		expect(withQ2.values[0]).toEqual([1, null, 3]);
	});

	test("series with different x sets line up by label", () => {
		const grid = chartGrid([
			series("late", [
				["Mar", 3],
				["Apr", 4],
			]),
			series("full", [
				["Jan", 10],
				["Feb", 20],
				["Mar", 30],
			]),
		]);
		expect(grid.labels).toEqual(["Jan", "Feb", "Mar", "Apr"]);
		expect(grid.values).toEqual([
			[null, null, 3, 4],
			[10, 20, 30, null],
		]);
	});

	test("a label only a shorter series has goes in where that series puts it", () => {
		const long = series("long", [
			["Q1", 1],
			["Q3", 3],
			["Q4", 4],
		]);
		const leading = chartGrid([
			long,
			series("short", [
				["Q2", 2],
				["Q3", 3],
			]),
		]);
		expect(leading.labels).toEqual(["Q1", "Q2", "Q3", "Q4"]);
		const disjoint = chartGrid([long, series("next", [["Q5", 5]])]);
		expect(disjoint.labels).toEqual(["Q1", "Q3", "Q4", "Q5"]);
		const between = chartGrid([
			series("long", [
				["Q1", 1],
				["Q3", 3],
				["Q4", 4],
			]),
			series("short", [
				["Q1", 1],
				["Q2", 2],
			]),
		]);
		expect(between.labels).toEqual(["Q1", "Q2", "Q3", "Q4"]);
	});

	test("a line is drawn per unbroken run", () => {
		expect(runsOf([1, 2, null, 4, null, null, 7, 8])).toEqual([
			[
				{ i: 0, y: 1 },
				{ i: 1, y: 2 },
			],
			[{ i: 3, y: 4 }],
			[
				{ i: 6, y: 7 },
				{ i: 7, y: 8 },
			],
		]);
		expect(runsOf([null, null])).toEqual([]);
	});
});

describe("reading a chart's points", () => {
	test("a null or a blank y is missing, never zero; a quoted numeral is a number", () => {
		const chart = readChart({
			title: "t",
			series: [
				{
					name: "a",
					points: [
						{ x: "Q1", y: null },
						{ x: "Q2", y: "" },
						{ x: "Q3", y: " 2.5 " },
						{ x: "Q4", y: false },
						{ x: "Q5", y: 0 },
					],
				},
			],
		});
		expect(chart?.series[0]?.points).toEqual([
			{ x: "Q1", y: null },
			{ x: "Q2", y: null },
			{ x: "Q3", y: 2.5 },
			{ x: "Q5", y: 0 },
		]);
	});
});
