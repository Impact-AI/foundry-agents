import { describe, expect, test } from "bun:test";
import type { Send } from "@/src/route-call";
import {
	deleteConversation,
	listConversations,
	renameConversation,
} from "./conversation-calls";

/** A route that records what it was asked and answers as told. */
function route(answer: () => Response) {
	const calls: { url: string; init: RequestInit }[] = [];
	const send: Send = async (url, init) => {
		calls.push({ url, init });
		return answer();
	};
	return { calls, send };
}

describe("the picker's calls", () => {
	test("the list is read from the conversations route as it stands", async () => {
		const listed = [{ id: "c1", title: "", updatedAt: "2026-01-01T00:00:00Z" }];
		const r = route(() => Response.json({ conversations: listed }));
		expect(await listConversations(r.send)).toEqual({ conversations: listed });
		expect(r.calls[0]).toMatchObject({
			url: "/api/conversations",
			init: { method: "GET" },
		});
		const refused = route(() =>
			Response.json({ code: "unauthenticated" }, { status: 401 }),
		);
		expect(await listConversations(refused.send)).toEqual({
			code: "unauthenticated",
		});
	});

	test("a rename is a PATCH of the title to the conversation's route", async () => {
		const r = route(() => Response.json({ id: "c 1", title: "Plans" }));
		expect(await renameConversation("c 1", "Plans", r.send)).toEqual({});
		expect(r.calls).toHaveLength(1);
		expect(r.calls[0]?.url).toBe("/api/conversations/c%201");
		expect(r.calls[0]?.init.method).toBe("PATCH");
		expect(JSON.parse(String(r.calls[0]?.init.body))).toEqual({
			title: "Plans",
		});
	});

	test("a delete is a DELETE of the conversation's route", async () => {
		const r = route(() => new Response(null, { status: 204 }));
		expect(await deleteConversation("c1", r.send)).toEqual({});
		expect(r.calls[0]).toMatchObject({
			url: "/api/conversations/c1",
			init: { method: "DELETE" },
		});
	});

	test("a refusal answers the route's code, for the catalogue to render", async () => {
		const r = route(() =>
			Response.json({ code: "not_found" }, { status: 404 }),
		);
		expect(await deleteConversation("c1", r.send)).toEqual({
			code: "not_found",
		});
		const bare = route(() => new Response("no", { status: 500 }));
		expect(await renameConversation("c1", "x", bare.send)).toEqual({
			code: "generic",
		});
	});

	test("a route that cannot be reached says so", async () => {
		const send: Send = async () => {
			throw new TypeError("Failed to fetch");
		};
		expect(await deleteConversation("c1", send)).toEqual({
			code: "backend_unreachable",
		});
	});
});
