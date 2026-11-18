import { z } from "zod";
import {
	type ProductTools,
	productTool,
	WEB_SEARCH,
} from "../contract/product";
import { currentTurn } from "../turn/scope";
import { searchTheWeb } from "./web-search";
import { chargeWebSearches, webSearchAvailable } from "./web-search-meter";

/**
 * What a typed turn has from the service that a voice agent cannot hold:
 * web search, as a function tool the backend runs.
 *
 * A voice agent takes server-side tools only through a toolbox, and "a
 * voice-based agent can have individual tools or one toolbox, but not
 * both. Attaching a toolbox replaces the agent's individual tools list"
 * (Learn, foundry/agents/how-to/configure-voice-agent). Its controls and
 * the backend's tools are function tools, so a toolbox would cost every
 * one of them. So `webSearch` is the backend's function, running what the
 * typed turn runs: a response on the chat's deployment with the typed
 * turns' web search tool (`web-search.ts`), answering with what the pages
 * said and which pages they were. It is charged to the `toolSearch` bucket
 * a typed turn's searches are, and refused while that bucket is empty.
 */

const SEARCH_DESCRIPTION =
	"Search the web, for what the knowledge base does not hold or what is current. Give a whole question. Returns an answer grounded in the pages it read, and the pages' titles and URLs: say the answer and where it comes from by the site's name, never a URL.";

function webSearchTool() {
	return productTool({
		description: SEARCH_DESCRIPTION,
		parameters: z.object({
			query: z
				.string()
				.min(1)
				.max(500)
				.describe("The question to search for, whole."),
		}),
		async execute({ query }) {
			const { caller } = currentTurn();
			if (!(await webSearchAvailable(caller))) return { error: "rate_limited" };
			const result = await searchTheWeb(query);
			// Charged however the response ended: a search that ran was spent.
			await chargeWebSearches(caller, result.searches).catch((err: Error) =>
				console.error("[agent] web searches went uncharged:", err.message),
			);
			if (result.failed) return { error: "search_failed" };
			return { answer: result.answer, sources: result.sources };
		},
	});
}

/** The tool a voice session has in place of the service's: web search, when the turn has it. */
export function voiceServiceTools(input: { webSearch: boolean }): ProductTools {
	return input.webSearch ? { [WEB_SEARCH]: webSearchTool() } : {};
}
