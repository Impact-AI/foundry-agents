import { expect, test } from "bun:test";
import { type StoredItem, threadMessages } from "./input";

const said = (id: string, text: string): StoredItem => ({
	id,
	type: "message",
	role: "user",
	content: [{ type: "input_text", text }],
});
const answered = (id: string, text: string): StoredItem => ({
	id,
	type: "message",
	role: "assistant",
	content: [{ type: "output_text", text }],
});
const conversation = [
	said("u1", "First."),
	answered("a1", "One."),
	said("u2", "Second.\n[picture: shown once, not kept]"),
	{
		id: "c1",
		type: "function_call",
		call_id: "call_1",
		name: "shelf",
		arguments: "{}",
	},
	{ id: "o1", type: "function_call_output", call_id: "call_1", output: "{}" },
	answered("a2", "Two."),
];

test("a thread shows the person's words and the answers, each at its own time, a picture by its slot; calls and outputs are not shown", () => {
	const at = (day: number) => `2026-01-0${day}T00:00:00.000Z`;
	const messages = threadMessages(
		conversation.map((item, i) => ({ item, at: at(i + 1) })),
	);
	expect(messages.map((m) => [m.id, m.createdAt, m.imageSlots])).toEqual([
		["u1", at(1), 0],
		["a1", at(2), 0],
		["u2", at(3), 1],
		["a2", at(6), 0],
	]);
	expect(messages[2]?.text).toBe("Second.");
});
