/**
 * A chart's vertical band: a floor and a ceiling on round numbers that hold
 * every point with a little air, and the step between the rules. Pure, so
 * the chart and the sparkline agree on it.
 */
export interface Band {
	lo: number;
	hi: number;
	step: number;
}

function niceStep(span: number, rules: number): number {
	const raw = span / Math.max(1, rules);
	const mag = 10 ** Math.floor(Math.log10(raw));
	const unit = raw / mag;
	const nice = unit <= 1 ? 1 : unit <= 2 ? 2 : unit <= 5 ? 5 : 10;
	return nice * mag;
}

export function niceBand(values: readonly number[], rules = 4): Band {
	const finite = values.filter((v) => Number.isFinite(v));
	if (finite.length === 0) return { lo: 0, hi: 1, step: 0.25 };
	let min = Math.min(...finite);
	let max = Math.max(...finite);
	if (min === max) {
		const pad = Math.abs(min) || 1;
		min -= pad / 2;
		max += pad / 2;
	}
	const step = niceStep(max - min, rules);
	const lo = Math.floor(min / step) * step;
	const hi = Math.ceil(max / step) * step;
	return { lo, hi: hi > lo ? hi : lo + step, step };
}

/** More rules than a plot could show: a band that asks for them gets its two edges. */
const MAX_RULES = 64;

/**
 * The rules a band is drawn with, floor to ceiling inclusive. Counted, then
 * placed by multiplication: adding the step to a running value stops moving
 * it once the value is large enough that the step is below its precision.
 */
export function bandRules(band: Band): number[] {
	const count = Math.round((band.hi - band.lo) / band.step);
	if (!Number.isFinite(count) || count < 1 || count > MAX_RULES)
		return [band.lo, band.hi];
	return Array.from(
		{ length: count + 1 },
		(_, i) => Math.round((band.lo + i * band.step) * 1e6) / 1e6,
	);
}

/** A value's place in a band, 0 at the floor and 1 at the ceiling. */
export function bandFraction(band: Band, value: number): number {
	const span = band.hi - band.lo;
	return span > 0 ? (value - band.lo) / span : 0.5;
}

/** A value as the page's language writes numbers; the browser's own only when no language is given. */
export function formatValue(value: number, locale?: string): string {
	if (Math.abs(value) >= 1000)
		return value.toLocaleString(locale, { maximumFractionDigits: 0 });
	return value.toLocaleString(locale, { maximumFractionDigits: 2 });
}
