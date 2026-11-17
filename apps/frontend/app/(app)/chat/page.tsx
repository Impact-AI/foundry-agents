import { getLocale } from "next-intl/server";
import { agentId } from "@/src/backend/agent";
import {
	type ConversationSummary,
	listConversations,
	readConversation,
	type TranscriptMessage,
} from "@/src/backend/conversations";
import { backendFacts } from "@/src/backend/facts";
import { voiceCapability } from "@/src/backend/voice";
import { requireCaller } from "@/src/session";
import { conversationParam } from "@/src/workspace-href";
import { Workspace } from "../workspace/Workspace";
import { ChatRuntime } from "./ChatRuntime";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** The open conversation: the one asked for, else the newest, else a fresh id the first turn will create. */
function pickThread(
	asked: string | null,
	conversations: ConversationSummary[],
): string {
	return asked ?? conversations[0]?.id ?? crypto.randomUUID();
}

/**
 * The workspace, the caller's own. Everything the browser needs
 * to register the stage's tools and open a voice channel is resolved here,
 * from the backend's own answers: the agent's id, the tools it briefs, the
 * voice this environment has.
 */
export default async function WorkspacePage({
	searchParams,
}: {
	searchParams: Promise<{ c?: string }>;
}) {
	const caller = await requireCaller();
	const [agent, facts, capability, locale, conversations] = await Promise.all([
		agentId(caller),
		backendFacts(caller),
		voiceCapability(caller),
		getLocale(),
		// A list that cannot be read is the page's error, with its way to try
		// again: an empty one would open a new conversation over the real ones.
		listConversations(caller),
	]);
	const threadId = pickThread(
		conversationParam((await searchParams).c),
		conversations,
	);
	const known = conversations.find((c) => c.id === threadId);
	// Likewise a conversation that cannot be read: drawn empty, its next turn would look like its first.
	const transcript: TranscriptMessage[] = known
		? (await readConversation(caller, threadId)).messages
		: [];

	return (
		<ChatRuntime agentId={agent} threadId={threadId}>
			<Workspace
				key={threadId}
				threadId={threadId}
				conversations={conversations}
				transcript={transcript}
				briefs={facts.stageTools}
				capability={capability}
				locale={locale}
			/>
		</ChatRuntime>
	);
}
