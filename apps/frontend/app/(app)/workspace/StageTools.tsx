"use client";

import { useFrontendTool } from "@copilotkit/react-core/v2";
import { briefSchema, type StageToolBrief } from "@/src/stage/tool-briefs";
import type { StageToolHandler, StageToolHandlers } from "@/src/stage/tools";
import { ChatChartCard } from "../chat/ChatChartCard";
import { ChatMediaCard } from "../chat/ChatMediaCard";

/**
 * Registers the briefed tools for the typed channel, one hook per brief,
 * each in a component of its own so the count is fixed for a mount. The
 * two that put a picture in front of the person also draw a card in the
 * thread beside the sentence that made it.
 */
function StageTool({
	brief,
	handler,
}: {
	brief: StageToolBrief;
	handler: StageToolHandler;
}) {
	useFrontendTool(
		{
			name: brief.name,
			description: brief.description,
			parameters: briefSchema(brief),
			handler: (args) => handler(args),
			...(brief.name === "showChart"
				? {
						render: ({ args, status }) => (
							<ChatChartCard args={args} status={status} />
						),
					}
				: brief.name === "presentContent"
					? {
							render: ({ args, status }) => (
								<ChatMediaCard args={args} status={status} />
							),
						}
					: {}),
		},
		[brief, handler],
	);
	return null;
}

export function StageTools({
	briefs,
	handlers,
}: {
	briefs: readonly StageToolBrief[];
	handlers: StageToolHandlers;
}) {
	return (
		<>
			{briefs.map((brief) => (
				<StageTool
					key={brief.name}
					brief={brief}
					handler={handlers[brief.name as keyof StageToolHandlers]}
				/>
			))}
		</>
	);
}
