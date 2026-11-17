import { throttledReport } from "@platform/config";

import {
	type KnowledgeBaseEffort,
	knowledgeSettings,
	type RetrievalEngine,
} from "../config/knowledge";
import { isSearchConfigured } from "../index/client";
import { readableSettings } from "../query/access";
import { knowledgeBasePlanner } from "./definition";

/**
 * Which engine answers. Under access control the knowledge base answers
 * too: every `retrieve` call carries the caller's readers clause as the
 * source's `filterAddOn`, so the base chooses among the chunks the caller
 * may read, as the hybrid query does (`knowledgeBaseSearch`).
 */

export const PLANNER_UNCONFIGURED = "knowledge_base.planner_unconfigured";

const unplanned = throttledReport("knowledge", PLANNER_UNCONFIGURED, {
	line: (count) =>
		`[knowledge] ${PLANNER_UNCONFIGURED}: retrieval.reasoningEffort or retrieval.voiceReasoningEffort is above minimal but the knowledge base has no planning model (AZURE_OPENAI_KNOWLEDGE_BASE_DEPLOYMENT and AZURE_OPENAI_KNOWLEDGE_BASE_MODEL, which the template sets with KNOWLEDGE_BASE=true), so the search runs at minimal (${count} turn(s))`,
	everyMs: () => 60_000,
});

export async function retrievalEngine(): Promise<RetrievalEngine> {
	const [{ retrieval }, access] = await Promise.all([
		knowledgeSettings(),
		readableSettings(),
	]);
	if (retrieval.engine !== "knowledgeBase") return "hybrid";
	// Unread settings choose the hybrid search, which refuses on them itself.
	if (!access) return "hybrid";
	return "knowledgeBase";
}

/** Which channel asks: a typed turn, or a live session. */
export type RetrievalChannel = "typed" | "voice";

/** How a search asks the base: the effort its `retrieve` call carries. Null while the hybrid search answers. */
export interface KnowledgeBaseRetrieval {
	effort: KnowledgeBaseEffort;
}

/**
 * The effort the setting names for the channel, when the base can plan:
 * above `minimal` without a planning model it cannot, and `minimal`
 * answers, said once per window. Never anything above what the setting
 * names.
 */
async function knowledgeBaseEffort(
	channel: RetrievalChannel,
): Promise<KnowledgeBaseEffort> {
	const { retrieval } = await knowledgeSettings();
	const wanted =
		channel === "voice"
			? (retrieval.voiceReasoningEffort ?? retrieval.reasoningEffort)
			: retrieval.reasoningEffort;
	if (wanted === "minimal") return "minimal";
	if (knowledgeBasePlanner()) return wanted;
	unplanned(new Error(PLANNER_UNCONFIGURED));
	return "minimal";
}

/** The one decision both channels take: the engine, and the effort for this channel. */
export async function knowledgeBaseRetrieval(
	channel: RetrievalChannel,
): Promise<KnowledgeBaseRetrieval | null> {
	if (!isSearchConfigured()) return null;
	if ((await retrievalEngine()) !== "knowledgeBase") return null;
	return { effort: await knowledgeBaseEffort(channel) };
}

/** Forget the report's window. For tests. */
export function resetRetrievalEngineReports(): void {
	unplanned.reset();
}
