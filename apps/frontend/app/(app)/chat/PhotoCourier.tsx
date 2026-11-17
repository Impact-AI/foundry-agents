"use client";

import {
	UseAgentUpdate,
	useAgent,
	useCopilotKit,
} from "@copilotkit/react-core/v2";
import { useTranslations } from "next-intl";
import { useEffect } from "react";
import { mayPost } from "@/src/chat/send-queue";
import { useVoiceChannel } from "../workspace/voice-context";
import type { CapturedPhoto } from "./CameraCapture";

/**
 * A picture from the camera becomes a turn of its own: one line of text and
 * the picture, put on the thread and run, once the thread can take a turn
 * (`mayPost`): no run, no open call, no live voice session holding it. The
 * keeper then stores it like any other picture that left this browser.
 */
export function PhotoCourier({
	photo,
	onSent,
}: {
	photo: CapturedPhoto | null;
	onSent: () => void;
}) {
	const t = useTranslations("chat");
	const { copilotkit } = useCopilotKit();
	const { agent } = useAgent({
		updates: [
			UseAgentUpdate.OnRunStatusChanged,
			UseAgentUpdate.OnMessagesChanged,
		],
	});
	const voice = useVoiceChannel();
	// The picture waits, as typed words do, for a thread that can take a turn.
	const ready = mayPost(
		agent.messages,
		agent.isRunning,
		Boolean(voice?.open || voice?.held),
	);
	useEffect(() => {
		if (!photo || !ready) return;
		onSent();
		agent.addMessage({
			id: crypto.randomUUID(),
			role: "user",
			content: [
				{ type: "text", text: t("pictureSent") },
				{
					type: "image",
					source: {
						type: "data",
						value: photo.value,
						mimeType: photo.mimeType,
					},
				},
			],
		} as Parameters<typeof agent.addMessage>[0]);
		void copilotkit.runAgent({ agent }).catch(() => {});
	}, [photo, ready, agent, copilotkit, onSent, t]);
	return null;
}
