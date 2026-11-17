"use client";

import {
	CopilotChatMessageView,
	type CopilotChatMessageViewProps,
} from "@copilotkit/react-core/v2";
import { useTranslations } from "next-intl";
import { AssistantMessage } from "./AssistantMessage";
import { ReasoningMessage, ReasoningProvider } from "./Reasoning";
import { SourcesProvider } from "./Sources";
import { ThinkingCursor } from "./ThinkingCursor";
import { UserMessage } from "./UserMessage";

/**
 * The thread, with the disclosure at its head: the first line a person reads
 * in a conversation says what they are talking to, before any turn does.
 * The wait under a turn is the frontend's own too (`ThinkingCursor`), and so is the
 * model's reasoning, one disclosure per turn (`Reasoning`), and the
 * documents a reply drew on, under it (`Sources`).
 */
function ThreadWithHead(props: CopilotChatMessageViewProps) {
	const tAi = useTranslations("ai");
	return (
		<>
			<div className="thread-head">
				<p className="ai-line">{tAi("first")}</p>
			</div>
			<ReasoningProvider
				messages={props.messages ?? []}
				isRunning={props.isRunning ?? false}
			>
				<SourcesProvider>
					<CopilotChatMessageView
						{...props}
						userMessage={UserMessage}
						assistantMessage={AssistantMessage}
						reasoningMessage={ReasoningMessage}
						cursor={ThinkingCursor}
					/>
				</SourcesProvider>
			</ReasoningProvider>
		</>
	);
}

// A slot replacement must carry the original's statics to satisfy its type.
export const MessageView = Object.assign(
	ThreadWithHead,
	CopilotChatMessageView,
);
