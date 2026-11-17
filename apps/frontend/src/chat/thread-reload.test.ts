import { expect, test } from "bun:test";
import type { Transcript } from "@/src/backend/conversations";
import type { Send } from "@/src/route-call";
import type { ReplayedMessage } from "./sent-images";
import { type ReloadableThread, reloadThread } from "./thread-reload";

/** The thread read again from the conversation, and left alone when that would be wrong. */

const transcript: Transcript = {
	id: "t/1",
	title: "Voice",
	messages: [
		{
			id: "u1",
			role: "user",
			parts: [{ type: "text", text: "Hello" }],
			createdAt: "2026-10-23T10:00:00Z",
		},
		{
			id: "a1",
			role: "assistant",
			parts: [{ type: "text", text: "Hi there" }],
			createdAt: "2026-10-23T10:00:01Z",
		},
	],
};

function thread(over: Partial<ReloadableThread> = {}) {
	const set: ReplayedMessage[][] = [];
	const t: ReloadableThread = {
		threadId: "t/1",
		isRunning: false,
		setMessages: (messages) => set.push(messages),
		...over,
	};
	return { t, set };
}

const answering =
	(status: number, body: unknown): Send =>
	async (url) => {
		expect(url).toBe("/api/conversations/t%2F1");
		return Response.json(body, { status });
	};

test("the conversation's messages replace the thread's, as a page load would show them", async () => {
	const { t, set } = thread();
	expect(await reloadThread(t, "t/1", answering(200, transcript))).toBe(true);
	expect(set).toHaveLength(1);
	expect(set[0]?.map((m) => [m.id, m.role])).toEqual([
		["u1", "user"],
		["a1", "assistant"],
	]);
});

test("a failed read, a thread now on another conversation, or a run under way changes nothing", async () => {
	for (const [over, send] of [
		[{}, answering(503, { code: "backend_unreachable" })],
		[{ threadId: "t/2" }, answering(200, transcript)],
		[{ isRunning: true }, answering(200, transcript)],
	] as const) {
		const { t, set } = thread(over);
		expect(await reloadThread(t, "t/1", send)).toBe(false);
		expect(set).toHaveLength(0);
	}
});
