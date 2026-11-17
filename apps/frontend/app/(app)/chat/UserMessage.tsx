"use client";

import {
	CopilotChatUserMessage,
	type CopilotChatUserMessageProps,
} from "@copilotkit/react-core/v2";
import { useTranslations } from "next-intl";
import { imageKey, isImageDataPart, isSlotPart } from "@/src/chat/sent-images";
import { useHeldImages } from "./held-images-context";
import { ImageSlot } from "./ImageSlot";

/**
 * A part has no id of its own; its position in its message is its identity,
 * and a slot's store key counts positions among the image-shaped parts alone.
 */
function keyedParts(messageId: string, parts: readonly unknown[]) {
	let imageIndex = 0;
	return parts.map((part, position) => {
		const slot =
			isSlotPart(part) || isImageDataPart(part) ? imageIndex++ : null;
		return {
			part,
			key: `${messageId}:${position}`,
			slotKey: slot === null ? null : imageKey(messageId, slot),
		};
	});
}

/**
 * A person's turn: its text, and each picture either as it was sent (this
 * session) or as the slot the transcript hands back, filled from the
 * browser's store when this is the device that sent it. Its head says whose
 * it is, to a reader who cannot see which side it is drawn on: a heading
 * nobody sees, so the turns are also places to move between.
 */
function PersonTurn({ message }: CopilotChatUserMessageProps) {
	const t = useTranslations("chat");
	const held = useHeldImages();
	const content = message.content;
	if (typeof content === "string") {
		return (
			<div className="user-message">
				<h3 className="sr-only">{t("speakerYou")}</h3>
				<div className="bubble">{content}</div>
			</div>
		);
	}
	return (
		<div className="user-message">
			<h3 className="sr-only">{t("speakerYou")}</h3>
			{keyedParts(message.id, content).map(({ part, key, slotKey }) => {
				if (isImageDataPart(part)) {
					return (
						<span key={key} className="image-slot">
							{/* biome-ignore lint/performance/noImgElement: a data URL that never left the browser */}
							<img
								src={`data:${part.source.mimeType ?? "image/jpeg"};base64,${part.source.value}`}
								alt={t("imageSent")}
							/>
						</span>
					);
				}
				if (slotKey !== null) {
					return <ImageSlot key={key} picture={held.pictureFor(slotKey)} />;
				}
				const text = (part as { text?: unknown }).text;
				if (typeof text === "string" && text.trim()) {
					return (
						<div key={key} className="bubble">
							{text}
						</div>
					);
				}
				return null;
			})}
		</div>
	);
}

// A slot replacement must carry the original's statics to satisfy its type.
export const UserMessage = Object.assign(PersonTurn, CopilotChatUserMessage);
