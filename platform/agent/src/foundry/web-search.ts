import { emitUsage } from "@platform/observability";
import type { CitedSource } from "../contract/messages";
import { WEB_SEARCH } from "../contract/product";
import { agentSettings } from "../settings";
import { streamResponse } from "./client";
import { chatDeployment, webSearchTool } from "./definition";
import { readResponse } from "./turn/events";

/**
 * Web search as one call: a response on the chat's deployment with the
 * typed turns' own web search tool (`webSearchTool`, the same definition a
 * prompt agent's version carries), read by the typed turns' own reader
 * (`readResponse`: the answer without its citation markers, the pages it
 * cited, the searches the service ran). For a channel whose agent cannot
 * hold the service's tool beside its function tools — the voice agent
 * (`voice-tools.ts`) — so it calls this as a function of the backend's and
 * gets what a typed turn would have searched.
 *
 * The call is made cheap and quick, since a person is waiting to hear it:
 * the tool is required, so the model searches rather than deciding
 * whether to; the answer is capped and its reasoning is the `agent`
 * document's `webSearch` settings, not the chat's. Bounded as a typed
 * turn's response is: a slot of the chat deployment's concurrency cap for
 * the whole stream (`streamResponse`), the client's request deadline and
 * retry budget, and nothing kept by the service.
 */

const INSTRUCTIONS =
	"Search the web for what is asked and answer it from the pages you read, in two or three terse sentences: the facts, with dates and figures where they matter, and the sites they come from. Say what the pages say, not what you remember. If the pages do not answer it, say so in one sentence.";

export interface WebSearchResult {
	/** The grounded answer, without citation markers; empty when the response failed. */
	answer: string;
	sources: CitedSource[];
	/** Searches the service ran inside the response: what the `toolSearch` bucket is charged. */
	searches: number;
	failed: boolean;
}

export async function searchTheWeb(
	query: string,
	signal?: AbortSignal,
): Promise<WebSearchResult> {
	const [model, settings] = await Promise.all([
		chatDeployment(),
		agentSettings(),
	]);
	const sources: CitedSource[] = [];
	let searches = 0;
	const startedAt = performance.now();
	const read = await readResponse(
		streamResponse(
			{
				model,
				instructions: INSTRUCTIONS,
				input: [{ type: "message", role: "user", content: query }],
				tools: webSearchTool(true, settings.webSearch.contextSize),
				tool_choice: "required",
				max_output_tokens: settings.webSearch.maxOutputTokens,
				reasoning: { effort: settings.webSearch.reasoningEffort },
				store: false,
			},
			signal,
		),
		{
			runsOn: () => "service",
			cited: sources,
			emit: (event) => {
				if (event.type === "tool-call" && event.name === WEB_SEARCH) searches++;
			},
		},
	);
	if (read.usage)
		emitUsage({
			kind: "chat",
			provider: "foundry-agent-service",
			model: `${model}:${WEB_SEARCH}`,
			inputTokens: read.usage.inputTokens,
			outputTokens: read.usage.outputTokens,
			finishReason: read.end.kind === "completed" ? read.end.reason : "error",
			ttftMs: null,
			durationMs: performance.now() - startedAt,
		});
	const failed = read.end.kind !== "completed";
	return {
		answer: failed ? "" : read.text.trim(),
		sources,
		searches,
		failed,
	};
}
