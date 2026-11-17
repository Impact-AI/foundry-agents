"use client";

import { useTranslations } from "next-intl";
import { useRef } from "react";
import type { Instrument, Stage } from "@/src/stage/stage";
import { ChartTile } from "./ChartTile";
import { LibraryTile } from "./LibraryTile";
import { MediaTile } from "./MediaTile";
import { ReaderTile } from "./ReaderTile";
import { RecordCard } from "./RecordCard";
import { RecordsTile } from "./RecordsTile";
import { StageTile } from "./StageTile";
import { useStageActions } from "./stage-actions";
import { useExitingStage, useFlip } from "./stage-motion";
import { useTileLabel } from "./tile-labels";
import "./stage.css";

/**
 * The stage, laid out from whatever the conversation has placed on it: one
 * tile per instrument in placement order, the count picking the grid. Every
 * change is seen happening — a tile arrives, a tile fades in place, the
 * ones that stay slide to their new cells.
 */
export function StagePanel({ stage }: { stage: Stage }) {
	const t = useTranslations("stage");
	const label = useTileLabel();
	const actions = useStageActions();
	const tiles = useExitingStage(stage);
	const count = Math.min(Math.max(tiles.length, 1), 4);
	const root = useRef<HTMLDivElement>(null);
	useFlip(root, `${count}|${tiles.map((tile) => tile.key).join("|")}`);

	const body = (instrument: Instrument) => {
		switch (instrument.section) {
			case "library":
				return <LibraryTile instrument={instrument} />;
			case "reader":
				return <ReaderTile instrument={instrument} />;
			case "media":
				return <MediaTile item={instrument.item} />;
			case "chart":
				return <ChartTile chart={instrument.chart} />;
			case "record":
				return <RecordCard record={instrument.record} />;
			case "records":
				return <RecordsTile instrument={instrument} />;
		}
	};

	return (
		<div className={`stage stage--${count}`} ref={root}>
			{tiles.map(({ instrument, key, leaving }) => (
				<StageTile
					key={key}
					section={key}
					label={label(key)}
					closeLabel={t("close")}
					leaving={leaving}
					onClose={() => actions.close(key)}
				>
					{body(instrument)}
				</StageTile>
			))}
		</div>
	);
}
