import { beforeEach, expect, test } from "bun:test";
import {
	FAKE_FOUNDRY_ENDPOINT,
	type FakeFoundry,
	fakeFoundry,
} from "./fake-foundry";

/**
 * The stand-in's conversations, held to the rules the host is written
 * against: items taken in twenties, an output only for a call still open
 * (and Q9's, added while another call waits), responses either kept in a
 * conversation or kept nowhere, deletes that leave the run state's copy,
 * and a conversation past its time to live answering 404.
 */

let fake: FakeFoundry;
type Json = Record<string, unknown>;

async function call(method: string, path: string, body?: unknown) {
	const response = await fake.fetch(
		new Request(`${FAKE_FOUNDRY_ENDPOINT}/openai/v1${path}`, {
			method,
			headers: {
				authorization: "Bearer token",
				"content-type": "application/json",
			},
			body: body === undefined ? undefined : JSON.stringify(body),
		}),
	);
	const text = await response.text();
	return { status: response.status, text };
}

const json = (text: string) => JSON.parse(text) as Json;
const words = (item: Json | undefined) =>
	((item?.content ?? []) as { text?: string }[])[0]?.text;
const say = (content: string) => ({ type: "message", role: "user", content });
const AGENT = { type: "agent_reference", name: "sample", version: "1" };

beforeEach(() => {
	fake = fakeFoundry();
	fake.state.agents.set("sample", [
		{
			object: "agent.version",
			id: "sample:1",
			name: "sample",
			version: "1",
			created_at: 0,
			definition: { instructions: "Be brief." },
			metadata: {},
		},
	]);
});

async function conversation(items: unknown[] = []): Promise<string> {
	const made = await call("POST", "/conversations", { items });
	expect(made.status).toBe(200);
	return String(json(made.text).id);
}

async function itemsOf(id: string, query = "") {
	const listed = await call("GET", `/conversations/${id}/items${query}`);
	expect(listed.status).toBe(200);
	return json(listed.text).data as Json[];
}

test("a conversation takes at most twenty items at a time, and lists them newest first", async () => {
	const many = Array.from({ length: 21 }, (_, i) => say(`line ${i}`));
	expect((await call("POST", "/conversations", { items: many })).status).toBe(
		400,
	);
	const id = await conversation(many.slice(0, 20));
	expect(
		(await call("POST", `/conversations/${id}/items`, { items: many })).status,
	).toBe(400);
	const newest = await itemsOf(id, "?limit=2");
	expect(newest.map(words)).toEqual(["line 19", "line 18"]);
	const older = await itemsOf(id, `?limit=1&after=${newest[1]?.id}`);
	expect(words(older[0])).toBe("line 17");
});

test("a response in a conversation is kept there, and only that shape or the stateless one is taken", async () => {
	const id = await conversation();
	const refused = [
		{ conversation: id, store: false },
		{ conversation: id },
		{ store: true },
		{ store: false, previous_response_id: "resp_1" },
	];
	for (const fields of refused)
		expect(
			(
				await call("POST", "/responses", {
					agent_reference: AGENT,
					input: [say("Hello")],
					stream: true,
					...fields,
				})
			).status,
		).toBe(400);
	fake.script({ calls: [{ id: "call_1", name: "look", args: {} }] });
	const kept = await call("POST", "/responses", {
		agent_reference: AGENT,
		input: [say("Hello")],
		stream: true,
		store: true,
		conversation: id,
	});
	expect(kept.status).toBe(200);
	expect(fake.state.responses.size).toBe(1);
	expect((await itemsOf(id)).map((i) => i.type)).toEqual([
		"function_call",
		"message",
	]);
	// Its call is open: the next response must answer it first.
	expect(
		(
			await call("POST", "/responses", {
				agent_reference: AGENT,
				input: [say("And?")],
				stream: true,
				store: true,
				conversation: id,
			})
		).status,
	).toBe(400);
	const answered = await call("POST", "/responses", {
		agent_reference: AGENT,
		input: [{ type: "function_call_output", call_id: "call_1", output: "{}" }],
		stream: true,
		store: true,
		conversation: id,
	});
	expect(answered.status).toBe(200);
	// The model read the conversation, then the output.
	expect(
		fake
			.turns()
			.at(-1)
			?.items.map((i) => i.type),
	).toEqual(["message", "function_call", "function_call_output"]);
});

test("an output is added only for a call still open, even while another one waits", async () => {
	const id = await conversation();
	fake.script({
		calls: [
			{ id: "call_a", name: "look", args: {} },
			{ id: "call_b", name: "show", args: {} },
		],
	});
	await call("POST", "/responses", {
		agent_reference: AGENT,
		input: [say("Both")],
		stream: true,
		store: true,
		conversation: id,
	});
	const output = (callId: string) => ({
		type: "function_call_output",
		call_id: callId,
		output: "{}",
	});
	expect(
		(
			await call("POST", `/conversations/${id}/items`, {
				items: [output("call_x")],
			})
		).status,
	).toBe(400);
	expect(
		(
			await call("POST", `/conversations/${id}/items`, {
				items: [output("call_a")],
			})
		).status,
	).toBe(200);
	expect(
		(
			await call("POST", `/conversations/${id}/items`, {
				items: [output("call_a")],
			})
		).status,
	).toBe(400);
});

test("what a delete removes stays in the run state, a response is deleted once, and an expired conversation answers 404", async () => {
	const id = await conversation([say("Remember the map.")]);
	const [item] = await itemsOf(id);
	expect(
		(await call("DELETE", `/conversations/${id}/items/${item?.id}`)).status,
	).toBe(200);
	expect(await itemsOf(id)).toEqual([]);
	expect(fake.state.retained.map((i) => i.id)).toEqual([item?.id]);
	expect((await call("DELETE", "/responses/resp_none")).text).toContain(
		"not found",
	);

	const other = await conversation([say("Another.")]);
	expect((await call("DELETE", `/conversations/${other}`)).status).toBe(200);
	expect(fake.state.retained).toHaveLength(2);
	expect((await call("GET", `/conversations/${other}/items`)).status).toBe(404);

	fake.expire(id);
	expect((await call("GET", `/conversations/${id}/items`)).status).toBe(404);
	expect(fake.deletes()).toEqual([
		`DELETE /openai/v1/conversations/${id}/items/${item?.id}`,
		"DELETE /openai/v1/responses/resp_none",
		`DELETE /openai/v1/conversations/${other}`,
	]);
});
