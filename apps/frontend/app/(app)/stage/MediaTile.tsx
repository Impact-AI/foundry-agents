"use client";

import { useTranslations } from "next-intl";
import type { MediaItem } from "@/src/stage/stage";
import { MediaImage } from "../../components/MediaImage";
import { useStageActions } from "./stage-actions";
import "./media.css";

/**
 * A presented picture as a tile, then whatever framing the assistant gave
 * it. It fills its frame here and is a press away from the overlay, where
 * it is shown whole.
 */
export function MediaTile({ item }: { item: MediaItem }) {
	const t = useTranslations("media");
	const actions = useStageActions();
	const described = item.title ?? t("label");
	return (
		<figure className="stage-media">
			<button
				type="button"
				className="stage-media-frame"
				onClick={() => actions.enlarge(item)}
				aria-label={t("enlarge", { title: described })}
			>
				<MediaImage src={item.url} alt={described} />
			</button>
			{item.title || item.caption ? (
				<figcaption className="stage-media-caption">
					{item.title ? (
						<span className="stage-media-title">{item.title}</span>
					) : null}
					{item.caption ? (
						<span className="stage-media-text">{item.caption}</span>
					) : null}
				</figcaption>
			) : null}
		</figure>
	);
}
