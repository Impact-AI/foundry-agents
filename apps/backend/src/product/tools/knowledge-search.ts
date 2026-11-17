import { currentTurn, productTool } from "@platform/agent";
import { knowledgeBaseRetrieval, knowledgeSettings } from "@platform/knowledge";
import { z } from "zod";
import { problems } from "../../problems";
import { searchLibrary, sourceOf } from "../library";
import { SURFACES } from "../surfaces";

export const KNOWLEDGE_SEARCH = "knowledgeSearch";

/**
 * The search is the caller's, on the engine `retrieval.engine` names: the
 * hybrid query, or the knowledge base with the backend as its caller, at
 * the effort the channel's setting names, for a typed turn and a live
 * session alike: the agent never calls the base itself. A live session's search is
 * bounded by `retrieval.voiceDeadlineMs`, a typed turn's by
 * `retrieval.deadlineMs`. Who is asking rides from the verified
 * assertion through the turn to the readers clause. The answer carries the
 * passages whole, each with its id and, per passage, the document and the
 * media paths the stage's library and media sections take as they are.
 */
export const knowledgeSearch = productTool({
	description:
		"Search the knowledge base. Reach for it first for anything the library might hold — a document, a picture, a fact about the organisation's own material. Returns the best passages, each whole, with its document's id for `openDocument` and media URLs ready for `presentContent`; plus the words of the question none of them contained. Name a document in the answer by its title; a passage id or a citation marker is never written into the text. It finds passages, not the catalogue: for \"what documents do we have\", call `showLibrary` with no query instead.",
	parameters: z.object({
		query: z.string().min(1).max(400),
		tags: z
			.array(
				z
					.string()
					.min(1)
					.max(60)
					.refine((tag) => !tag.includes("|")),
			)
			.max(8)
			.optional(),
	}),
	execute: async ({ query, tags }) => {
		// The one decision both channels take, for this channel.
		const turn = currentTurn();
		const voice = turn.surface === SURFACES.live;
		const [base, { retrieval }] = await Promise.all([
			knowledgeBaseRetrieval(voice ? "voice" : "typed"),
			knowledgeSettings(),
		]);
		const result = await searchLibrary(query, turn.caller, {
			tags,
			engine: base ? "knowledgeBase" : "hybrid",
			effort: base?.effort,
			deadlineMs: voice ? retrieval.voiceDeadlineMs : undefined,
		});
		if (result.refused)
			problems.report("backend.knowledge.refused", {
				surface: "knowledge",
				reason: result.refused,
			});
		return {
			passages: result.passages,
			documents: result.documents,
			unmatchedTerms: result.unmatchedTerms,
		};
	},
	// The documents the passages came from are the sources under the answer.
	sources: (result) => result.documents.map(sourceOf),
});
