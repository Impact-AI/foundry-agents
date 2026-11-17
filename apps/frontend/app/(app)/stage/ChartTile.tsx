"use client";

import type { ChartSpec } from "@/src/stage/stage";
import { Chart } from "./Chart";
import "./chart.css";

export function ChartTile({ chart }: { chart: ChartSpec }) {
	return (
		<div className="chart-tile">
			<Chart chart={chart} />
		</div>
	);
}
