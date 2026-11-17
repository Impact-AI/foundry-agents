"use client";

import { useTranslations } from "next-intl";
import type { SentImage } from "@/src/chat/sent-images";

/** Where a picture was: the picture when this device kept it, a note when it did not. */
export function ImageSlot({ picture }: { picture: SentImage | null }) {
	const t = useTranslations("chat");
	if (picture) {
		return (
			<span className="image-slot" title={t("imageKeptHere")}>
				{/* biome-ignore lint/performance/noImgElement: a data URL from the browser's own store */}
				<img
					src={`data:${picture.mimeType};base64,${picture.value}`}
					alt={t("imageSent")}
				/>
			</span>
		);
	}
	return <span className="image-slot">{t("imageAbsent")}</span>;
}
