"use client";

import { UseAgentUpdate, useAgent } from "@copilotkit/react-core/v2";
import { useEffect } from "react";

/**
 * Forgets the authored suggestions on the rising edge of a run that answers
 * something said: they belonged to the reply being answered. A run that
 * opens on a tool's result is that same reply going on — the runtime starts
 * one after every call the browser answers, `suggestNext` included — so it
 * keeps what the reply has offered so far. Renders nothing.
 */
export function RunStartWatcher({ onRunStart }: { onRunStart: () => void }) {
	const { agent } = useAgent({ updates: [UseAgentUpdate.OnRunStatusChanged] });
	const { isRunning } = agent;
	useEffect(() => {
		if (isRunning && agent.messages.at(-1)?.role !== "tool") onRunStart();
	}, [isRunning, agent, onRunStart]);
	return null;
}
