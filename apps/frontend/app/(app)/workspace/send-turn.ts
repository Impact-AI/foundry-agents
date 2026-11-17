"use client";

import {
	UseAgentUpdate,
	useAgent,
	useCopilotKit,
} from "@copilotkit/react-core/v2";
import { useCallback, useRef } from "react";
import { mayPost } from "@/src/chat/send-queue";

/**
 * Post words as the person's own turn: a message of its own and a run. It
 * goes past the composer, so a draft half typed there and a picture waiting
 * in it stay where they are. The caller has decided the thread can take it.
 * What comes back ends when the run does, or at once with nothing to say.
 * Must live inside the runtime.
 */
export function usePostTurn(): (text: string) => Promise<void> {
	const { copilotkit } = useCopilotKit();
	const { agent } = useAgent({ updates: [UseAgentUpdate.OnRunStatusChanged] });
	return useCallback(
		(text: string) => {
			const said = text.trim();
			if (!said) return Promise.resolve();
			agent.addMessage({
				id: crypto.randomUUID(),
				role: "user",
				content: said,
			} as Parameters<typeof agent.addMessage>[0]);
			return copilotkit
				.runAgent({ agent })
				.then(() => {})
				.catch(() => {});
		},
		[agent, copilotkit],
	);
}

/**
 * Post words as the person's own turn, exactly as typing them would: a chip,
 * an opener on the desk. Nothing downstream knows the conversation was
 * steered. Only onto a thread that can take one (`mayPost`): `voiceHolds`
 * is whether a live session has it. A turn sent a moment ago is not in what
 * the page has drawn yet, so it is remembered here until its run is over:
 * two presses in one instant are one turn. Answers with the send's end, or
 * with nothing when nothing was sent. Must live inside the runtime.
 */
export function useSendTurn(
	voiceHolds: boolean,
): (text: string) => Promise<void> | undefined {
	const { agent } = useAgent({ updates: [UseAgentUpdate.OnRunStatusChanged] });
	const post = usePostTurn();
	const sending = useRef(false);
	return useCallback(
		(text: string) => {
			if (sending.current || !text.trim()) return undefined;
			if (!mayPost(agent.messages, agent.isRunning, voiceHolds))
				return undefined;
			sending.current = true;
			return post(text).finally(() => {
				sending.current = false;
			});
		},
		[agent, post, voiceHolds],
	);
}
