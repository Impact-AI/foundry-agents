"use client";

import {
	CopilotChatConfigurationProvider,
	CopilotKit,
} from "@copilotkit/react-core/v2";

/**
 * The runtime and the thread, for the chat and the voice pane alike: one
 * endpoint, one agent, one explicit thread. Everything that uses `useAgent`
 * has to sit inside the configuration provider, or it binds to the default
 * agent rather than this one. The runtime's own inspector is never drawn:
 * left to its default it appears on localhost, over the bar's end. The
 * endpoint is named as the single route it is: left to find out, the client
 * first asks for a path under it that nothing here answers.
 */
export function ChatRuntime({
	agentId,
	threadId,
	children,
}: {
	agentId: string;
	threadId: string;
	children: React.ReactNode;
}) {
	return (
		<CopilotKit
			runtimeUrl="/api/copilotkit"
			useSingleEndpoint
			showDevConsole={false}
			enableInspector={false}
		>
			<CopilotChatConfigurationProvider
				agentId={agentId}
				threadId={threadId}
				hasExplicitThreadId
			>
				{children}
			</CopilotChatConfigurationProvider>
		</CopilotKit>
	);
}
