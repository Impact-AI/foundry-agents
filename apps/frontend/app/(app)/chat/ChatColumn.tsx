"use client";

import { type AttachmentsConfig, CopilotChat } from "@copilotkit/react-core/v2";
import { useFormatter, useTranslations } from "next-intl";
import { useMemo, useState } from "react";
import type {
	ConversationSummary,
	TranscriptMessage,
} from "@/src/backend/conversations";
import { downscaleImage, MAX_ATTACHMENT_BYTES } from "@/src/chat/downscale";
import { CameraCapture, type CapturedPhoto } from "./CameraCapture";
import { ChatView } from "./ChatView";
import { ConversationPicker } from "./ConversationPicker";
import { CameraProvider } from "./camera-context";
import { ChatNoticesProvider } from "./chat-notices-context";
import { HeldImagesProvider } from "./held-images-context";
import { MessageView } from "./MessageView";
import { PastTurns } from "./PastTurns";
import { PhotoCourier } from "./PhotoCourier";
import { SentImageKeeper } from "./SentImageKeeper";
import "./chat.css";

/** The conversation's column: one panel holding its head, the thread, and the composer or the voice pane in its place. */
export function ChatColumn({
	threadId,
	conversations,
	transcript,
	stageProblem,
	onDismissStageProblem,
}: {
	threadId: string;
	conversations: ConversationSummary[];
	transcript: TranscriptMessage[];
	/** The code of a read behind the stage that failed, said beside the composer. */
	stageProblem: string | null;
	onDismissStageProblem: () => void;
}) {
	const t = useTranslations("chat");
	const format = useFormatter();
	const [cameraOpen, setCameraOpen] = useState(false);
	const [photo, setPhoto] = useState<CapturedPhoto | null>(null);
	const [rejected, setRejected] = useState<string | null>(null);

	const attachments = useMemo<AttachmentsConfig>(
		() => ({
			enabled: true,
			accept: "image/*",
			maxSize: MAX_ATTACHMENT_BYTES,
			onUpload: (file) => downscaleImage(file),
			onUploadFailed: ({ reason }) =>
				setRejected(
					reason === "file-too-large"
						? t("attachTooLarge", {
								limit: format.number(MAX_ATTACHMENT_BYTES / 1024 ** 2, {
									style: "unit",
									unit: "megabyte",
								}),
							})
						: reason === "invalid-type"
							? t("attachNotImage")
							: t("attachFailed"),
				),
		}),
		[t, format],
	);
	const notices = useMemo(
		() => ({
			rejected,
			dismissRejected: () => setRejected(null),
			stageProblem,
			dismissStageProblem: onDismissStageProblem,
		}),
		[rejected, stageProblem, onDismissStageProblem],
	);

	return (
		<div className="chat-column">
			<div className="panel chat-pane card-frame">
				<ConversationPicker conversations={conversations} current={threadId} />
				<HeldImagesProvider threadId={threadId}>
					<CameraProvider onOpen={() => setCameraOpen(true)}>
						<ChatNoticesProvider value={notices}>
							<PastTurns threadId={threadId} transcript={transcript} />
							<SentImageKeeper threadId={threadId} />
							<PhotoCourier photo={photo} onSent={() => setPhoto(null)} />
							<CopilotChat
								attachments={attachments}
								chatView={ChatView}
								messageView={MessageView}
							/>
						</ChatNoticesProvider>
					</CameraProvider>
				</HeldImagesProvider>
			</div>
			{cameraOpen ? (
				<CameraCapture
					onClose={() => setCameraOpen(false)}
					onCapture={(taken) => {
						setPhoto(taken);
						setCameraOpen(false);
					}}
				/>
			) : null}
		</div>
	);
}
