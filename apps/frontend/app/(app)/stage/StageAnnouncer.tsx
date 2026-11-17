"use client";

import { useTranslations } from "next-intl";
import { useEffect, useRef, useState } from "react";
import { type Stage, stageChange } from "@/src/stage/stage";
import { useTileLabel } from "./tile-labels";

/**
 * What the stage's last change did, said to a reader who cannot see a tile
 * arrive or go: which sections are on it now that were not, and which have
 * left. Always in the tree and drawn nowhere, so the change of words is
 * what a screen reader announces — politely, after whatever it is saying.
 */
export function StageAnnouncer({ stage }: { stage: Stage }) {
	const t = useTranslations("stage");
	const label = useTileLabel();
	const was = useRef(stage);
	const [said, setSaid] = useState({ text: "", times: 0 });

	useEffect(() => {
		const before = was.current;
		was.current = stage;
		const { placed, removed } = stageChange(before, stage);
		if (!placed.length && !removed.length) return;
		const text = stage.length
			? [
					...placed.map((section) => t("placed", { section: label(section) })),
					...removed.map((section) =>
						t("removed", { section: label(section) }),
					),
				].join(" ")
			: t("cleared");
		setSaid((last) => ({ text, times: last.times + 1 }));
	}, [stage, t, label]);

	return (
		<span className="sr-only" role="status">
			{said.text}
			{/* The same words twice — a second chart after the first — are still a change to announce. */}
			{said.times % 2 ? "" : " "}
		</span>
	);
}
