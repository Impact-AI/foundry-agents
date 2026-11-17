"use client";

import {
	CopilotChatAssistantMessage,
	type CopilotChatAssistantMessageProps,
} from "@copilotkit/react-core/v2";
import { useTranslations } from "next-intl";
import { MarkdownImage } from "../../components/MediaImage";
import { SourceChips } from "./Sources";
import "../../components/markdown/markdown.css";

/**
 * The prose as every other Markdown on the page is drawn: pictures only
 * from this origin's media route, and none of the renderer's own controls —
 * its copy and download buttons carry English labels and classes this
 * app's sheet does not style.
 */
const markdownRenderer = {
	components: { img: MarkdownImage },
	controls: false,
};

/**
 * The assistant's turn, in the frontend's own box: the prose, then the cards the
 * tools it called draw in the thread, then the documents it drew on. Its
 * words say whose they are under a heading nobody sees, as a person's turn
 * does. The runtime's toolbar is not drawn; a turn is read, not rated.
 */
function AssistantTurn(props: CopilotChatAssistantMessageProps) {
	const t = useTranslations("chat");
	return (
		<CopilotChatAssistantMessage
			{...props}
			markdownRenderer={markdownRenderer}
			toolbarVisible={false}
		>
			{({ markdownRenderer: prose, toolCallsView, message }) => {
				const hasWords = Boolean(message.content?.trim());
				return (
					<div className="assistant-message" data-message-id={message.id}>
						{hasWords ? (
							<>
								<h3 className="sr-only">{t("speakerAssistant")}</h3>
								<div className="markdown">{prose}</div>
							</>
						) : null}
						{toolCallsView}
						<SourceChips messageId={message.id} />
					</div>
				);
			}}
		</CopilotChatAssistantMessage>
	);
}

// A slot replacement must carry the original's statics to satisfy its type.
export const AssistantMessage = Object.assign(
	AssistantTurn,
	CopilotChatAssistantMessage,
);
