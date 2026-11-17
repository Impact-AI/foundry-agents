"use client";

import { useTranslations } from "next-intl";
import { useRef } from "react";
import { readMediaItem } from "@/src/stage/tools";
import { MediaImage } from "../../components/MediaImage";
import { useRevealOnMount } from "../stage/reveal";
import { useStageActions } from "../stage/stage-actions";
import "./chat-cards.css";

/** A presented picture's card in the thread, beside the sentence; a press opens it full-size. */
export function ChatMediaCard({
	args,
	status,
}: {
	args: Record<string, unknown>;
	status: string;
}) {
	const t = useTranslations("media");
	const actions = useStageActions();
	const root = useRef<HTMLDivElement>(null);
	const item = readMediaItem(args);
	useRevealOnMount(root, status === "complete");
	if (!item) return null;
	const described = item.title ?? t("label");
	return (
		<div className="chat-card chat-card--media" ref={root}>
			<button
				type="button"
				className="chat-card-frame"
				onClick={() => actions.enlarge(item)}
				aria-label={t("enlarge", { title: described })}
			>
				<MediaImage src={item.url} alt={described} />
			</button>
			<p className="chat-card-title">{described}</p>
			{item.caption ? <p className="chat-card-note">{item.caption}</p> : null}
		</div>
	);
}
