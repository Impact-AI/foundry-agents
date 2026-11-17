"use client";

import { useLocale, useTranslations } from "next-intl";
import { type PointerEvent, useEffect, useId, useRef, useState } from "react";
import {
	bandFraction,
	bandRules,
	formatValue,
	niceBand,
} from "@/src/stage/chart-band";
import { chartGrid, runsOf, xTicks } from "@/src/stage/chart-grid";
import type { ChartSpec } from "@/src/stage/stage";
import { uniqueKeys } from "@/src/unique-keys";

/**
 * A line chart of the assistant's series: the band's rules, one line per
 * series in the fan's hues, every series' x labels on one axis — a point
 * sits at its label, and a label a series has no value for is a gap in its
 * line — and a cursor that reads every series at the nearest x. Drawn as
 * SVG at the plot's own pixel size, so the labels are the page's type and
 * never shrink with the tile.
 */
const PAD = { top: 12, right: 16, bottom: 30, left: 48 };
const HUES = 6;
const FALLBACK = { w: 640, h: 300 };

function usePlotSize() {
	const ref = useRef<HTMLDivElement>(null);
	const [size, setSize] = useState(FALLBACK);
	useEffect(() => {
		const el = ref.current;
		if (!el) return;
		const read = () => {
			const { width, height } = el.getBoundingClientRect();
			if (width > 0 && height > 0)
				setSize((prev) => {
					const w = Math.round(width);
					const h = Math.round(height);
					return prev.w === w && prev.h === h ? prev : { w, h };
				});
		};
		read();
		const ro = new ResizeObserver(read);
		ro.observe(el);
		return () => ro.disconnect();
	}, []);
	return { ref, size };
}

export function Chart({ chart }: { chart: ChartSpec }) {
	const t = useTranslations("chart");
	const locale = useLocale();
	const id = useId();
	const [cursor, setCursor] = useState<number | null>(null);
	const { ref, size } = usePlotSize();
	const W = size.w;
	const H = size.h;

	const { labels, values } = chartGrid(chart.series);
	const slots = Math.max(1, labels.length - 1);
	const band = niceBand(values.flat().filter((v): v is number => v !== null));
	const rules = bandRules(band);
	const keys = uniqueKeys(chart.series.map((s) => s.name));
	const plotW = Math.max(1, W - PAD.left - PAD.right);
	const plotH = Math.max(1, H - PAD.top - PAD.bottom);
	const xAt = (i: number) => PAD.left + (i / slots) * plotW;
	const yAt = (v: number) => PAD.top + (1 - bandFraction(band, v)) * plotH;

	const onMove = (e: PointerEvent<SVGSVGElement>) => {
		const box = e.currentTarget.getBoundingClientRect();
		const x = ((e.clientX - box.left) / box.width) * W;
		const i = Math.round(((x - PAD.left) / plotW) * slots);
		setCursor(Math.min(labels.length - 1, Math.max(0, i)));
	};

	const at = cursor ?? labels.length - 1;
	const atCursor = values.map((v) => v[at] ?? null);
	const ticks = xTicks(labels, plotW);

	return (
		<figure className="chart">
			<figcaption className="chart-head">
				<span className="chart-title">{chart.title}</span>
				{chart.unit ? <span className="chart-unit">{chart.unit}</span> : null}
			</figcaption>
			<div className="chart-plot" ref={ref}>
				<svg
					viewBox={`0 0 ${W} ${H}`}
					width={W}
					height={H}
					role="img"
					aria-labelledby={`${id}-title`}
					onPointerMove={onMove}
					onPointerLeave={() => setCursor(null)}
				>
					<title id={`${id}-title`}>{t("alt", { title: chart.title })}</title>
					{rules.map((v) => (
						<g key={v} className="chart-rule">
							<line x1={PAD.left} x2={W - PAD.right} y1={yAt(v)} y2={yAt(v)} />
							<text x={PAD.left - 8} y={yAt(v)} dy="0.35em" textAnchor="end">
								{formatValue(v, locale)}
							</text>
						</g>
					))}
					{ticks.map(({ i, anchor }) => (
						<text
							key={labels[i]}
							className="chart-x"
							x={xAt(i)}
							y={H - PAD.bottom + 18}
							textAnchor={anchor}
						>
							{labels[i]}
						</text>
					))}
					{labels.length > 0 ? (
						<line
							className="chart-cursor"
							x1={xAt(at)}
							x2={xAt(at)}
							y1={PAD.top}
							y2={H - PAD.bottom}
							data-on={cursor !== null || undefined}
						/>
					) : null}
					{keys.map((key, n) => (
						<g key={key} className="chart-series" data-hue={n % HUES}>
							{runsOf(values[n] ?? []).map((run) =>
								run.length > 1 ? (
									<polyline
										key={run[0]?.i}
										points={run.map((p) => `${xAt(p.i)},${yAt(p.y)}`).join(" ")}
									/>
								) : (
									<circle
										key={run[0]?.i}
										cx={xAt(run[0]?.i ?? 0)}
										cy={yAt(run[0]?.y ?? 0)}
										r={2.5}
									/>
								),
							)}
							{atCursor[n] != null ? (
								<circle cx={xAt(at)} cy={yAt(atCursor[n])} r={4} />
							) : null}
						</g>
					))}
				</svg>
			</div>
			<div className="chart-legend">
				{chart.series.map((s, n) => (
					<span key={keys[n]} className="chart-key" data-hue={n % HUES}>
						<span className="chart-swatch" aria-hidden="true" />
						<span className="chart-key-name">{s.name}</span>
						<span className="chart-key-value">
							{atCursor[n] == null ? "—" : formatValue(atCursor[n], locale)}
						</span>
					</span>
				))}
				{labels[at] ? <span className="chart-at">{labels[at]}</span> : null}
			</div>
		</figure>
	);
}
