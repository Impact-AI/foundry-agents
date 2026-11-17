"use client";

import type { Attachment } from "@copilotkit/react-core/v2";
import { useTranslations } from "next-intl";
import { IconButton, IconClose } from "../../components/controls";

function sourceUrl(source: Attachment["source"]): string | null {
	if (source.type === "url") return source.value;
	if (source.type === "data")
		return `data:${source.mimeType ?? "image/jpeg"};base64,${source.value}`;
	return null;
}

/** The pictures waiting to go with the next message, each with its way out. */
export function AttachmentQueue({
	attachments,
	onRemove,
}: {
	attachments: readonly Attachment[];
	onRemove?: (id: string) => void;
}) {
	const t = useTranslations("chat");
	if (!attachments.length) return null;
	return (
		<ul className="attachments" aria-label={t("attachments")}>
			{attachments.map((attachment) => {
				const src = sourceUrl(attachment.source);
				return (
					<li
						key={attachment.id}
						className="attachment"
						data-state={attachment.status}
					>
						{attachment.type === "image" && src ? (
							// biome-ignore lint/performance/noImgElement: a data URL that never left the browser
							<img src={src} alt={attachment.filename ?? t("imageSent")} />
						) : (
							<span className="attachment-name">{attachment.filename}</span>
						)}
						<IconButton
							label={t("attachmentRemove")}
							size="sm"
							className="attachment-remove"
							onClick={() => onRemove?.(attachment.id)}
						>
							<IconClose />
						</IconButton>
					</li>
				);
			})}
		</ul>
	);
}
