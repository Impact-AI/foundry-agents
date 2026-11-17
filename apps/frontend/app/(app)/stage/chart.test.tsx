import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { NextIntlClientProvider } from "next-intl";
import { renderToStaticMarkup } from "react-dom/server";
import {
	X_LABEL_CHAR_PX,
	X_LABEL_GAP_PX,
	xTicks,
} from "@/src/stage/chart-grid";
import type { ChartSpec } from "@/src/stage/stage";
import en from "../../../messages/en.json";
import { Chart } from "./Chart";

const spend: ChartSpec = {
	title: "Spend",
	unit: "kEUR",
	series: [
		{
			name: "Warehouse",
			points: ["2024-Q1", "2024-Q2", "2025-Q3", "2025-Q4"].map((x, i) => ({
				x,
				y: i * 10,
			})),
		},
	],
};

/** A server render has no document; an earlier file's stub must not make it one. */
let savedDocument: PropertyDescriptor | undefined;
beforeAll(() => {
	savedDocument = Object.getOwnPropertyDescriptor(globalThis, "document");
	delete (globalThis as { document?: unknown }).document;
});
afterAll(() => {
	if (savedDocument)
		Object.defineProperty(globalThis, "document", savedDocument);
});

test("the x axis's first label starts at its point and its last ends at its own, so neither runs past the plot's edge", () => {
	const out = renderToStaticMarkup(
		<NextIntlClientProvider locale="en" messages={en} timeZone="UTC">
			<Chart chart={spend} />
		</NextIntlClientProvider>,
	);
	const ticks = [
		...out.matchAll(
			/<text class="chart-x"[^>]*text-anchor="(\w+)"[^>]*>([^<]*)</g,
		),
	].map((m) => [m[2], m[1]]);
	expect(ticks).toEqual([
		["2024-Q1", "start"],
		["2024-Q2", "middle"],
		["2025-Q3", "middle"],
		["2025-Q4", "end"],
	]);
});

const quarters = ["2024", "2025"].flatMap((y) =>
	["Q1", "Q2", "Q3", "Q4"].map((q) => `${y}-${q}`),
);

/**
 * A drawn label's extent, worked out here from its point, its anchor and the
 * component's own per-character estimate rather than read back from the
 * layout under test.
 */
function extent(x: number, anchor: string, label: string) {
	const w = label.length * X_LABEL_CHAR_PX;
	if (anchor === "start") return { left: x, right: x + w };
	if (anchor === "end") return { left: x - w, right: x };
	return { left: x - w / 2, right: x + w / 2 };
}

function expectApartAndInside(
	drawn: { x: number; anchor: string; label: string }[],
	from: number,
	to: number,
) {
	const boxes = drawn.map((d) => extent(d.x, d.anchor, d.label));
	for (const box of boxes) {
		expect(box.left).toBeGreaterThanOrEqual(from);
		expect(box.right).toBeLessThanOrEqual(to);
	}
	for (let k = 1; k < boxes.length; k++)
		expect(boxes[k - 1]?.right ?? 0).toBeLessThanOrEqual(
			(boxes[k]?.left ?? 0) - X_LABEL_GAP_PX,
		);
}

describe("eight quarters on the x axis", () => {
	// The plot is the chart's width less its 48px left and 16px right padding.
	for (const [name, width] of [
		["narrow", 320],
		["wide", 960],
	] as const) {
		test(`in a ${name} chart, no two drawn labels overlap and none passes the plot's edges`, () => {
			const plotW = width - 64;
			const step = plotW / (quarters.length - 1);
			const drawn = xTicks(quarters, plotW).map((t) => ({
				x: t.i * step,
				anchor: t.anchor,
				label: quarters[t.i] ?? "",
			}));
			expectApartAndInside(drawn, 0, plotW);
			// The axis always ends at the latest quarter, and starts at the first.
			expect(drawn[0]?.label).toBe("2024-Q1");
			expect(drawn.at(-1)?.label).toBe("2025-Q4");
			if (name === "wide") expect(drawn).toHaveLength(quarters.length);
			else expect(drawn.length).toBeLessThan(quarters.length);
		});
	}

	test("the rendered chart draws the labels the layout picks, apart and inside its plot", () => {
		const out = renderToStaticMarkup(
			<NextIntlClientProvider locale="en" messages={en} timeZone="UTC">
				<Chart
					chart={{
						title: "Spend",
						series: [
							{ name: "Warehouse", points: quarters.map((x, y) => ({ x, y })) },
						],
					}}
				/>
			</NextIntlClientProvider>,
		);
		const drawn = [
			...out.matchAll(
				/<text class="chart-x" x="([\d.]+)"[^>]*text-anchor="(\w+)"[^>]*>([^<]*)</g,
			),
		].map((m) => ({ x: Number(m[1]), anchor: m[2] ?? "", label: m[3] ?? "" }));
		expect(drawn.length).toBeGreaterThan(1);
		// A server render draws at the fallback size, 640px wide: the plot runs from 48 to 624.
		expectApartAndInside(drawn, 48, 624);
		expect(drawn.map((d) => d.label)).toEqual(
			xTicks(quarters, 576).map((t) => quarters[t.i] ?? ""),
		);
	});
});
