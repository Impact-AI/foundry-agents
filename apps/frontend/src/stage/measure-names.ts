import { humanizeMeasure } from "../../../backend/src/product/measure-name";
import type { ChartSpec } from "./stage";

/** The `record` catalogue's translator, as much of it as a name needs. */
export interface RecordTranslator {
	(key: string): string;
	has(key: string): boolean;
}

/** A key the catalogue can hold: one segment, never a path of its own. */
const catalogueKey = (key: string) => /^[A-Za-z0-9_]+$/.test(key);

/**
 * What a person reads for a measure: its name in their language, as the
 * catalogue's `record.measureNames` gives it, keyed like the record kinds by
 * what the backend calls it; a measure the catalogue does not name reads as
 * its key in words, so a system's new measure still reads well.
 */
export function measureLabel(t: RecordTranslator, key: string): string {
	const path = `measureNames.${key}`;
	return catalogueKey(key) && t.has(path) ? t(path) : humanizeMeasure(key);
}

/** A unit in the person's language where the catalogue has a word for it (`record.units`); a symbol, or a unit it lacks, as the backend gives it. */
export function unitLabel(t: RecordTranslator, unit: string): string {
	const path = `units.${unit}`;
	return catalogueKey(unit) && t.has(path) ? t(path) : unit;
}

/** How the figure chips and the chart they draw name a measure and its unit. */
export interface MeasureNames {
	label: (key: string) => string;
	unit: (unit: string) => string;
}

export function measureNames(t: RecordTranslator): MeasureNames {
	return {
		label: (key) => measureLabel(t, key),
		unit: (unit) => unitLabel(t, unit),
	};
}

/**
 * A measure's chart as the metrics route answers it — one series, named for
 * the record — titled and its unit given in the person's language.
 */
export function namedChart(
	chart: ChartSpec,
	measure: string,
	names: MeasureNames,
): ChartSpec {
	const [only, ...more] = chart.series;
	return {
		...chart,
		...(only && !more.length
			? { title: `${only.name} — ${names.label(measure)}` }
			: {}),
		...(chart.unit ? { unit: names.unit(chart.unit) } : {}),
	};
}
