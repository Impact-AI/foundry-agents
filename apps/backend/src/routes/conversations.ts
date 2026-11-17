import { cleanTitle } from "@platform/agent";
import { Hono } from "hono";
import type { AppDeps } from "../app";
import type { AppEnv } from "../auth/context";
import { transcriptMessageOf } from "../transcript";
import { NO_STORE, readObject, refuse } from "./reply";

/** The picker's window: its newest conversations. The export reads every page instead. */
export const LIST_LIMIT = 30;

/**
 * The caller's conversations, through the host and nothing else. A thread
 * that is not this account's is absent on a read and refused on a write,
 * and the two are not told apart. A conversation is opened by its first
 * turn, under the id the client chose for it, and named by the agent once
 * a turn in it settles; a rename here is the person's, and stands.
 */
export function conversationRoutes({
	host,
}: Pick<AppDeps, "host">): Hono<AppEnv> {
	const routes = new Hono<AppEnv>();

	routes.get("/", async (c) => {
		const { threads } = await host.listThreads(c.get("caller").sub, {
			limit: LIST_LIMIT,
		});
		return c.json(
			{
				conversations: threads.map(({ id, title, updatedAt }) => ({
					id,
					title,
					updatedAt,
				})),
			},
			200,
			NO_STORE,
		);
	});

	routes.get("/:id", async (c) => {
		const thread = await host.readThread(
			c.get("caller").sub,
			c.req.param("id"),
		);
		if (!thread) return refuse(c, 404, "not_found");
		return c.json(
			{
				id: thread.id,
				title: thread.title,
				messages: thread.messages.map(transcriptMessageOf),
			},
			200,
			NO_STORE,
		);
	});

	routes.patch("/:id", async (c) => {
		const body = await readObject(c);
		const title =
			typeof body?.title === "string" ? cleanTitle(body.title) : null;
		if (!title) return refuse(c, 400, "invalid_body");
		const id = c.req.param("id");
		if (!(await host.renameThread(c.get("caller").sub, id, title)))
			return refuse(c, 404, "not_found");
		return c.json({ id, title }, 200, NO_STORE);
	});

	routes.delete("/:id", async (c) => {
		const removed = await host.deleteThread(
			c.get("caller").sub,
			c.req.param("id"),
		);
		return removed ? c.body(null, 204) : refuse(c, 404, "not_found");
	});

	return routes;
}
