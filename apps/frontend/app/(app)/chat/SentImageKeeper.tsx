"use client";

import { UseAgentUpdate, useAgent } from "@copilotkit/react-core/v2";
import { useEffect, useState } from "react";
import { keepSentImages } from "@/src/chat/image-store";
import { sentImagesIn } from "@/src/chat/sent-images";
import { useHeldImages } from "./held-images-context";

/**
 * Every picture that leaves this browser is kept in it, keyed by the message
 * it rode in, so the slot the backend hands back can show it again here —
 * and nowhere else. The runtime's agent outlives a change of conversation,
 * so what it holds as this thread mounts was sent in the one before: kept
 * under this thread's id, a deleted conversation's picture would survive in
 * the next one.
 */
export function SentImageKeeper({ threadId }: { threadId: string }) {
	const { agent } = useAgent({ updates: [UseAgentUpdate.OnMessagesChanged] });
	const { refresh } = useHeldImages();
	const messages = agent.messages;
	const [inherited] = useState(
		() => new Set(agent.messages.map((message) => message.id)),
	);
	useEffect(() => {
		const images = sentImagesIn(messages, inherited);
		if (!images.length) return;
		void keepSentImages(threadId, images).then(refresh);
	}, [messages, threadId, refresh, inherited]);
	return null;
}
