"use client";

import {
	type AbstractAgent,
	UseAgentUpdate,
	useAgent,
	useCopilotKit,
} from "@copilotkit/react-core/v2";
import { useEffect, useMemo, useRef } from "react";
import type { TranscriptMessage } from "@/src/backend/conversations";
import { type ReplayedMessage, replayMessages } from "@/src/chat/sent-images";

type ThreadMessages = Parameters<AbstractAgent["setMessages"]>[0];

/** The messages with the past turns at their head, or null when they are all there already. */
function withPast(
	messages: readonly { id: string }[],
	past: readonly ReplayedMessage[],
): ThreadMessages | null {
	const there = new Set(messages.map((m) => m.id));
	if (past.every((m) => there.has(m.id))) return null;
	const known = new Set(past.map((m) => m.id));
	const fresh = messages.filter((m) => !known.has(m.id));
	return [...past, ...fresh] as ThreadMessages;
}

/** Put the past turns at the head of the agent's thread, unless they are all there already. */
function seat(agent: AbstractAgent, past: readonly ReplayedMessage[]): void {
	const seated = withPast(agent.messages, past);
	if (seated) agent.setMessages(seated);
}

/**
 * The conversation so far, put on the thread once the runtime is ready, so
 * a reopened conversation reads from its first line. The backend already
 * holds these turns; the replay is for the screen, and a run sends the thread
 * with its slots as markers rather than with pictures again.
 *
 * The runtime keeps no conversation: asked to connect to a thread, it
 * answers with a run in flight or with nothing. The chat takes that answer
 * for the thread's whole history, and twice lets go of what the thread held.
 * It empties the thread before it asks, whenever the thread is not the one
 * it was last on, so the turns are put back as each run or connect begins —
 * after the emptying, and before the agent takes the thread it will add the
 * run's events to. And it opens the answer with a snapshot of no messages,
 * read once the runtime has answered, so the turns are kept at the head of
 * whatever a snapshot holds as it is read.
 */
export function PastTurns({
	threadId,
	transcript,
}: {
	threadId: string;
	transcript: TranscriptMessage[];
}) {
	const { copilotkit } = useCopilotKit();
	const { agent, isReady } = useAgent({
		updates: [UseAgentUpdate.OnMessagesChanged],
	});
	const past = useMemo(() => replayMessages(transcript), [transcript]);
	const replayed = useRef<ReplayedMessage[] | null>(null);
	useEffect(() => {
		if (!past.length || !isReady || replayed.current === past) return;
		replayed.current = past;
		seat(agent, past);
	}, [past, isReady, agent]);

	useEffect(() => {
		if (!past.length) return;
		const subscription = copilotkit.subscribe({
			onAgentRunStarted: ({ agent: starting }) => {
				if (starting.threadId === threadId) seat(starting, past);
			},
		});
		return () => subscription.unsubscribe();
	}, [copilotkit, threadId, past]);

	useEffect(() => {
		if (!past.length) return;
		const subscription = agent.subscribe({
			onMessagesSnapshotEvent: ({ event }) => {
				if (agent.threadId !== threadId) return;
				const seated = withPast(event.messages, past);
				return seated ? { messages: seated, stopPropagation: true } : undefined;
			},
		});
		return () => subscription.unsubscribe();
	}, [agent, threadId, past]);
	return null;
}
