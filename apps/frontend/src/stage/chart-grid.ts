import type { ChartSpec } from "./stage";

/**
 * A chart's series laid on one x axis. A point belongs at its x label, not
 * at its index: one series may skip a label another has, or start later. The
 * labels are every series' own, in an order each series agrees with — the
 * longest series' first, and a label only a shorter one has goes in after
 * the label it follows there, or before the one it leads to when it comes
 * first, or at the end when it shares none. Each series' value at each label is a number,
 * or null where it has none, which the chart leaves as a gap.
 */
export interface ChartGrid {
	labels: string[];
	values: (number | null)[][];
}

export function chartGrid(series: ChartSpec["series"]): ChartGrid {
	const labels: string[] = [];
	const byLength = [...series].sort(
		(a, b) => b.points.length - a.points.length,
	);
	for (const s of byLength) {
		let after = -1;
		s.points.forEach(({ x }, k) => {
			let at = labels.indexOf(x);
			if (at === -1) {
				at =
					after === -1
						? (s.points
								.slice(k + 1)
								.map((p) => labels.indexOf(p.x))
								.find((i) => i !== -1) ?? labels.length)
						: after + 1;
				labels.splice(at, 0, x);
			}
			after = at;
		});
	}
	const values = series.map((s) => {
		const at = new Map<string, number | null>();
		for (const p of s.points) if (!at.has(p.x)) at.set(p.x, p.y);
		return labels.map((label) => at.get(label) ?? null);
	});
	return { labels, values };
}

/** The unbroken runs of a series, as label indexes with their values: a line is drawn per run. */
export function runsOf(
	values: readonly (number | null)[],
): { i: number; y: number }[][] {
	const runs: { i: number; y: number }[][] = [];
	let run: { i: number; y: number }[] = [];
	values.forEach((y, i) => {
		if (y === null) {
			if (run.length) runs.push(run);
			run = [];
		} else run.push({ i, y });
	});
	if (run.length) runs.push(run);
	return runs;
}

/**
 * The width an x label is reckoned at, per character: the axis sets its
 * labels at text-xs (12px) in the system sans, where a quarter such as
 * "2025-Q4" runs about 52px. The page's font is not known until it draws, so
 * this is an estimate, and it errs wide.
 */
export const X_LABEL_CHAR_PX = 7.5;
/** The clear space kept between two x labels drawn side by side. */
export const X_LABEL_GAP_PX = 8;

export interface XTick {
	/** The label's index on the axis. */
	i: number;
	anchor: "start" | "middle" | "end";
	/** The label's estimated extent, in pixels from the plot's left edge. */
	left: number;
	right: number;
}

/**
 * The x labels a plot `plotW` pixels wide draws: every label when they fit,
 * else every nth, by the widest label's estimated width, so none overlaps its
 * neighbour. The first label starts at its point and the last ends at its
 * own — centred, either would reach past the plot into the tile's edge, which
 * cuts it. The last is always drawn, and a label it would crowd gives way to
 * it.
 */
export function xTicks(labels: string[], plotW: number): XTick[] {
	const n = labels.length;
	if (n === 0) return [];
	const step = plotW / Math.max(1, n - 1);
	const tick = (i: number): XTick => {
		const x = i * step;
		const w = (labels[i]?.length ?? 0) * X_LABEL_CHAR_PX;
		if (i === 0) return { i, anchor: "start", left: x, right: x + w };
		if (i === n - 1) return { i, anchor: "end", left: x - w, right: x };
		return { i, anchor: "middle", left: x - w / 2, right: x + w / 2 };
	};
	const widest = Math.max(...labels.map((l) => l.length)) * X_LABEL_CHAR_PX;
	const clear = (a: XTick, b: XTick) => a.right + X_LABEL_GAP_PX <= b.left;
	// Every nth from the first, at the smallest n whose labels all clear one
	// another: the first, anchored at its start, reaches further right than a
	// centred label, so the width alone can leave the second crowding it.
	let every = Math.max(1, Math.ceil((widest + X_LABEL_GAP_PX) / step));
	let shown: XTick[] = [tick(0)];
	for (; every < n; every++) {
		shown = [tick(0)];
		for (let i = every; i < n - 1; i += every) shown.push(tick(i));
		if (shown.every((t, k) => k === 0 || clear(shown[k - 1] ?? t, t))) break;
	}
	if (n > 1) {
		const last = tick(n - 1);
		while (shown.length > 0) {
			const prev = shown.at(-1);
			if (prev && clear(prev, last)) break;
			shown.pop();
		}
		shown.push(last);
	}
	return shown;
}
