"use client";

import { useTranslations } from "next-intl";
import { useEffect, useRef } from "react";
import type { MediaItem } from "@/src/stage/stage";
import { IconButton, IconClose } from "../../components/controls";
import { MediaImage } from "../../components/MediaImage";
import { useReturnFocus } from "../../components/use-return-focus";
import "./media-overlay.css";

/**
 * One picture, given the room to be looked at. It takes the stage's column
 * and nothing else: the conversation stays lit and usable beside it, so
 * enlarging is not leaving the conversation. Escape closes it; focus goes to
 * the way out on open and back to the opener on close.
 */
export function MediaOverlay({
	item,
	onClose,
}: {
	item: MediaItem;
	onClose: () => void;
}) {
	const t = useTranslations("media");
	const closeRef = useRef<HTMLButtonElement>(null);
	useReturnFocus();
	useEffect(() => {
		closeRef.current?.focus();
	}, []);
	useEffect(() => {
		const onKey = (e: KeyboardEvent) => {
			if (e.key === "Escape") onClose();
		};
		window.addEventListener("keydown", onKey);
		return () => window.removeEventListener("keydown", onKey);
	}, [onClose]);

	return (
		<aside className="media-overlay" aria-label={t("label")}>
			<header className="media-overlay-head">
				<h2 className="media-overlay-title">{item.title ?? t("label")}</h2>
				<IconButton ref={closeRef} label={t("close")} onClick={onClose}>
					<IconClose />
				</IconButton>
			</header>
			<div className="media-overlay-stage">
				<MediaImage src={item.url} alt={item.title ? "" : t("label")} />
			</div>
			{item.caption ? (
				<footer className="media-overlay-foot">
					<p className="media-overlay-text">{item.caption}</p>
				</footer>
			) : null}
		</aside>
	);
}
