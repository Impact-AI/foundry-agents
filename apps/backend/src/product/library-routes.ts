import { meterCall, rateLimitedResponse } from "@platform/metering";
import { Hono } from "hono";
import type { AppEnv } from "../auth/context";
import { accessOf, callerAccess, requireStanding } from "../auth/standing";
import { problems } from "../problems";
import { NO_STORE, refuse } from "../routes/reply";
import { listLibrary, readDocument, searchLibrary } from "./library";

const QUERY_MAX = 400;
const TAGS_MAX = 8;
const TAG_MAX = 60;

/** A tag the index could hold: bounded, and without the `|` its filter separates values by. */
const isLibraryTag = (tag: string): boolean =>
	tag.length <= TAG_MAX && !tag.includes("|");

/**
 * The knowledge base for the stage: the library's cards for a query, and
 * one document for the reader. The same search the agent's tool runs, as
 * the same caller — the verified subject and the groups the account's row
 * holds, never a parameter — so what the interface draws is what the agent
 * cited. With no query the cards are the catalogue — every document the
 * caller may read, unranked — which is the answer to "what is there", a
 * question a search's reranker scores below its floor. A search is a spend
 * — a plan from the small model, an embedding, a query — so it stands
 * behind the standing gate and draws on the account's `media` allowance,
 * the day's bound on what the stage reads from the library; the catalogue
 * calls no model and is not charged. The catalogue's answer carries
 * `truncated`, true when the library holds more documents than the cards
 * show.
 */
export function libraryRoutes(): Hono<AppEnv> {
	const routes = new Hono<AppEnv>();
	routes.use("*", requireStanding);

	routes.get("/", async (c) => {
		const query = c.req.query("query")?.trim() ?? "";
		if (query.length > QUERY_MAX) return refuse(c, 400, "invalid_query");
		const tags = c.req
			.queries("tags")
			?.flatMap((t) => t.split(","))
			.map((t) => t.trim())
			.filter(Boolean);
		if (tags && (tags.length > TAGS_MAX || !tags.every(isLibraryTag)))
			return refuse(c, 400, "invalid_query");
		if (!query) {
			const listing = await listLibrary(callerAccess(c), { tags });
			if (listing.refused)
				problems.report("backend.knowledge.refused", {
					surface: "library",
					reason: listing.refused,
				});
			// `truncated` says the cards are not the whole catalogue, so whoever
			// shows or describes them does not call a part the whole.
			return c.json(
				{ documents: listing.documents, truncated: listing.truncated },
				200,
				NO_STORE,
			);
		}
		const verdict = await meterCall(
			c.get("subject"),
			"media",
			accessOf(c).tier,
		);
		if (!verdict.ok) return rateLimitedResponse(verdict.refusal);
		// A card is a document, so one passage a document fills the cards.
		const result = await searchLibrary(query, callerAccess(c), {
			tags,
			maxPerDocument: 1,
		});
		if (result.refused)
			problems.report("backend.knowledge.refused", {
				surface: "library",
				reason: result.refused,
			});
		return c.json({ documents: result.documents }, 200, NO_STORE);
	});

	routes.get("/:id", async (c) => {
		const document = await readDocument(c.req.param("id"), callerAccess(c));
		if (!document) return refuse(c, 404, "not_found");
		return c.json(document, 200, NO_STORE);
	});

	return routes;
}
