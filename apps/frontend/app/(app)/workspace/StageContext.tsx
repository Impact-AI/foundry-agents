"use client";

import { useAgentContext } from "@copilotkit/react-core/v2";
import { useMemo } from "react";
import { liveContextLines } from "@/src/stage/live-context";
import type { Stage } from "@/src/stage/stage";

/**
 * What is on the stage, told to the typed channel on every turn: one
 * readable per line, its description the line's label, so the backend
 * renders `stage.<section>: <one line>`. Renders nothing; must live inside
 * the runtime.
 */
function ContextLine({ label, value }: { label: string; value: string }) {
	useAgentContext({ description: label, value });
	return null;
}

export function StageContext({ stage }: { stage: Stage }) {
	const lines = useMemo(() => liveContextLines(stage), [stage]);
	return (
		<>
			{lines.map((line) => (
				<ContextLine key={line.label} label={line.label} value={line.value} />
			))}
		</>
	);
}
