"use client";

import { useTranslations } from "next-intl";
import { useRef } from "react";
import { readChart } from "@/src/stage/tools";
import { useRevealOnMount } from "../stage/reveal";
import { Sparkline } from "../stage/Sparkline";
import "./chat-cards.css";

/**
 * A chart's card in the thread, drawn by `showChart`'s render beside the
 * sentence that made it: the title and the first series at glancing size.
 * The chart itself is on the stage; this is where it is consumed.
 */
export function ChatChartCard({
	args,
	status,
}: {
	args: Record<string, unknown>;
	status: string;
}) {
	const t = useTranslations("chart");
	const root = useRef<HTMLElement>(null);
	const chart = readChart(args);
	useRevealOnMount(root, status === "complete");
	if (!chart) return null;
	const first = chart.series[0];
	return (
		<figure className="chat-card chat-card--chart" ref={root}>
			<figcaption className="chat-card-title">
				{chart.title}
				{chart.unit ? (
					<span className="chat-card-note"> · {chart.unit}</span>
				) : null}
			</figcaption>
			{first ? <Sparkline points={first.points} /> : null}
			<p className="chat-card-note">{t("onStage")}</p>
		</figure>
	);
}
