import { humanizeMeasure } from "../measure-name";
import { MEASURES, type Measure, QUARTERS, type SampleRecord } from "./records";

/**
 * A record's figures as a series the stage's chart draws: one point per
 * quarter, or per year with the quarters rolled up the way the measure
 * says — a cost adds up, a percentage averages. A quarter the record keeps
 * no value for is `null`, never `0`: the chart leaves a gap there, and a
 * year missing a quarter of a measure that adds up has no total.
 */

export type Period = "quarter" | "year";

export interface ChartPoint {
	x: string;
	/** Null where the record keeps no value for the period. */
	y: number | null;
}

export interface ChartSeries {
	title: string;
	unit: string;
	series: { name: string; points: ChartPoint[] }[];
}

function measureOf(
	record: Pick<SampleRecord, "kind">,
	key: string,
): Measure | null {
	return MEASURES[record.kind].find((m) => m.key === key) ?? null;
}

function byYear(
	points: ChartPoint[],
	aggregate: Measure["aggregate"],
): ChartPoint[] {
	const years = new Map<string, (number | null)[]>();
	for (const { x, y } of points) {
		const year = x.slice(0, 4);
		years.set(year, [...(years.get(year) ?? []), y]);
	}
	return [...years].map(([x, values]) => {
		const known = values.filter((v): v is number => v !== null);
		if (!known.length || (aggregate === "sum" && known.length < values.length))
			return { x, y: null };
		const total = known.reduce((sum, v) => sum + v, 0);
		const y = aggregate === "sum" ? total : total / known.length;
		return { x, y: Math.round(y * 100) / 100 };
	});
}

/** Null when the record keeps no such measure. */
export function series(
	record: SampleRecord,
	key: string,
	period: Period = "quarter",
): ChartSeries | null {
	const measure = measureOf(record, key);
	const values = record.figures[key];
	if (!measure || !values) return null;
	const quarterly = QUARTERS.map((x, i) => ({ x, y: values[i] ?? null }));
	return {
		title: `${record.name} — ${humanizeMeasure(measure.key)}`,
		unit: measure.unit,
		series: [
			{
				name: record.name,
				points:
					period === "year" ? byYear(quarterly, measure.aggregate) : quarterly,
			},
		],
	};
}
