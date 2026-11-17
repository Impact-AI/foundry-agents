import { afterAll, beforeAll, expect, spyOn, test } from "bun:test";
import { cosmosDatabase, setCosmosDatabase } from "@platform/cosmos";
import { problemChannel } from "@platform/observability";
import { REDIS_AVAILABLE } from "@platform/redis/testing";
import { z } from "zod";
import type { TurnEvent, TurnInput } from "../index";
import { type AgentProduct, productTool } from "../index";
import type { FoundryAgentHost } from "./host";
import type { FakeFoundry } from "./testing/fake-foundry";
import { foundryParityFactory, REMEMBERED } from "./testing/parity-factory";
import type { ThreadDocument } from "./threads";

/**
 * A thread on the service's conversations (`history.store: foundry`), on
 * the stand-in service, where the parity suite cannot see: every response
 * kept in the thread's conversation and given only what is new, the
 * outputs a run ends with appended before its `finish`, the times and
 * responses the thread document keeps because the service does not, a
 * picture's item and response deleted once the turn settles, a
 * conversation past its time to live renewed, every delete an erase must
 * call — and a failing one keeping the thread for the retry — and threads
 * that stay in the store they were made in when the setting changes.
 */

const SHELF = "shelf";
const SHOW = "showShelf";
const STEPS = "steps";

const product: AgentProduct = {
	agentId: "sample",
	serviceName: "sample-agent",
	toolKeys: [SHELF, STEPS],
	persona: async () => "# CORE IDENTITY\nYou are the sample assistant.",
	guardrails: () => "You decline anything outside the sample's scope.",
	behaviour: ({ surface }) => `On the ${surface} surface, answer in one line.`,
	tools: () => ({
		[SHELF]: productTool({
			description: "Find the shelf a book is on.",
			parameters: z.object({ title: z.string().min(1) }),
			execute: async ({ title }) => ({ title, shelf: "the second" }),
		}),
		[STEPS]: productTool({
			description: "Take one more step.",
			parameters: z.object({}),
			execute: async () => "stepped",
		}),
	}),
	clientTools: [
		{
			name: SHOW,
			description: "Light up a shelf.",
			parameters: { type: "object", properties: {} },
		},
	],
};

const factory = foundryParityFactory({ memory: "own", history: "foundry" });
const t = test.skipIf(!REDIS_AVAILABLE);
let host: FoundryAgentHost;
let fake: FakeFoundry;
let me = "";

async function run(input: TurnInput): Promise<TurnEvent[]> {
	const outcome = await host.startTurn(input);
	expect(outcome.kind).toBe("started");
	if (outcome.kind !== "started") return [];
	const events: TurnEvent[] = [];
	const reader = outcome.events.getReader();
	for (;;) {
		const { done, value } = await reader.read();
		if (done) return events;
		events.push(value);
	}
}

function turn(
	threadId: string,
	content = "Where is the atlas?",
	overrides: Partial<TurnInput> = {},
): TurnInput {
	return {
		resourceId: me,
		threadId,
		messages: [{ id: crypto.randomUUID(), role: "user", content }],
		surface: "web",
		languageName: "English",
		caller: { oid: me, groups: [], tier: "base" },
		...overrides,
	};
}

async function document(threadId: string): Promise<ThreadDocument> {
	const found = await cosmosDatabase()
		.container("threads")
		.read<ThreadDocument>(threadId, me);
	if (!found) throw new Error(`no thread ${threadId}`);
	return found;
}

/** The conversation's items, oldest first, as the service holds them. */
async function itemsOf(threadId: string) {
	const { conversation } = await document(threadId);
	return fake.state.items.get(conversation?.id ?? "") ?? [];
}

/** The problem codes reported while `body` runs. */
async function reported(body: () => Promise<unknown>): Promise<unknown[]> {
	const codes: unknown[] = [];
	problemChannel.setSink((line) => codes.push(line.attributes));
	try {
		await body();
	} finally {
		problemChannel.setSink(null);
	}
	return codes;
}

beforeAll(async () => {
	if (!REDIS_AVAILABLE) return;
	host = (await factory.create(product)) as FoundryAgentHost;
	fake = factory.fake();
	await host.start();
	({ resourceId: me } = await factory.person());
	factory.answer("On the second shelf.");
});

afterAll(async () => {
	if (!REDIS_AVAILABLE) return;
	await host.stop();
	await factory.teardown();
});

t(
	"the start says, under a code and never as a failure, that new threads are kept in the service's conversations",
	async () => {
		const quiet = spyOn(console, "warn").mockImplementation(() => {});
		try {
			const codes = await reported(() => host.start());
			expect(codes).toEqual([
				expect.objectContaining({
					"problem.code": "agent.history.service_retention",
				}),
			]);
			expect(quiet).toHaveBeenCalledTimes(1);
		} finally {
			quiet.mockRestore();
		}
	},
);

t(
	"a new thread records its conversation, and each response is kept in it and given only what is new",
	async () => {
		await run(turn("thread-kept", "The codename is Heron."));
		await run(turn("thread-kept", "What was the codename?"));
		const thread = await document("thread-kept");
		expect(thread.store).toBe("foundry");
		expect(thread.conversation).toMatchObject({
			id: expect.stringMatching(/^conv_/),
			former: [],
		});
		expect(thread.conversation?.responseIds).toHaveLength(2);
		const seen = fake.turns().at(-1);
		expect(seen?.body).toMatchObject({
			store: true,
			conversation: thread.conversation?.id,
			truncation: "auto",
		});
		expect(seen?.body).not.toHaveProperty("include");
		expect(seen?.body).not.toHaveProperty("previous_response_id");
		// Given only the new words; the model read the rest from the conversation.
		expect(seen?.input).toHaveLength(1);
		expect(JSON.stringify(seen?.input)).not.toContain("Heron");
		expect(JSON.stringify(seen?.items)).toContain("Heron");
		// The service stood in for never made a request without a conversation for this thread.
		expect(
			fake
				.turns()
				.filter((t) => t.body.store === false && t.agent.name === "sample"),
		).toEqual([]);
	},
);

t(
	"the thread reads back from its conversation, each message with the time the document kept for it, and pages back to its first",
	async () => {
		for (const said of ["One.", "Two.", "Three."])
			await run(turn("thread-paged", said));
		const thread = await document("thread-paged");
		const read = await host.readThread(me, "thread-paged");
		expect(read?.messages.map((m) => m.text)).toEqual([
			"One.",
			"On the second shelf.",
			"Two.",
			"On the second shelf.",
			"Three.",
			"On the second shelf.",
		]);
		const times = new Map(
			thread.conversation?.itemTimes.map((t) => [t.id, t.at]),
		);
		for (const message of read?.messages ?? [])
			expect(message.createdAt).toBe(times.get(message.id) as string);
		const newest = await host.readThread(me, "thread-paged", { limit: 2 });
		expect(newest?.messages.map((m) => m.text)).toEqual([
			"Three.",
			"On the second shelf.",
		]);
		const older = await host.readThread(me, "thread-paged", {
			limit: 10,
			before: newest?.earlier ?? undefined,
		});
		expect(older?.messages.map((m) => m.text)).toEqual([
			"One.",
			"On the second shelf.",
			"Two.",
			"On the second shelf.",
		]);
		expect(older?.earlier).toBeNull();
	},
);

t(
	"a mixed response's output is in the conversation before its finish reaches anyone, and the browser's answer continues it",
	async () => {
		fake.script({
			calls: [
				{ id: "call_find", name: SHELF, args: { title: "Atlas" } },
				{ id: "call_show", name: SHOW, args: {} },
			],
		});
		const outcome = await host.startTurn(
			turn("thread-held", "Show me the atlas.", { clientTools: [SHOW] }),
		);
		if (outcome.kind !== "started") throw new Error("refused");
		const reader = outcome.events.getReader();
		for (;;) {
			const { value, done } = await reader.read();
			if (done) throw new Error("no finish");
			if (value?.type !== "finish") continue;
			const items = await itemsOf("thread-held");
			expect(
				items.some(
					(i) => i.type === "function_call_output" && i.call_id === "call_find",
				),
			).toBe(true);
			expect(
				items.filter((i) => i.call_id === "call_show").map((i) => i.type),
			).toEqual(["function_call"]);
			break;
		}
		await reader.cancel();
		const answered = await run(
			turn("thread-held", "", {
				clientTools: [SHOW],
				messages: [
					{ id: "t1", role: "tool", toolCallId: "call_show", content: "Lit." },
				],
			}),
		);
		expect(answered.at(-1)).toMatchObject({ type: "finish", reason: "stop" });
		expect(fake.turns().at(-1)?.input).toEqual([
			expect.objectContaining({
				type: "function_call_output",
				call_id: "call_show",
				output: "Lit.",
			}),
		]);
	},
);

t(
	"a step limit holds the last step's outputs, and words from a person whose browser never answered close the call",
	async () => {
		const undo = factory.editAgent({ foundry: { maxSteps: 1 } });
		try {
			// Words beside the call: a wordless turn at the limit is asked once more.
			fake.script({
				text: "Going.",
				calls: [{ id: "call_step", name: STEPS, args: {} }],
			});
			const events = await run(turn("thread-steps", "Keep going."));
			expect(events.at(-1)).toMatchObject({
				type: "finish",
				reason: "max-steps",
			});
		} finally {
			undo();
		}
		expect(
			(await itemsOf("thread-steps"))
				.filter((i) => i.call_id === "call_step")
				.map((i) => i.type),
		).toEqual(["function_call", "function_call_output"]);
		fake.script({ calls: [{ id: "call_open", name: SHOW, args: {} }] });
		await run(turn("thread-steps", "Light it.", { clientTools: [SHOW] }));
		const events = await run(turn("thread-steps", "Never mind."));
		expect(events.at(-1)).toMatchObject({ type: "finish" });
		expect(fake.turns().at(-1)?.input[0]).toMatchObject({
			type: "function_call_output",
			call_id: "call_open",
			output: JSON.stringify({ error: "not_answered" }),
		});
	},
);

t(
	"a picture is input to its turn and then deleted from the conversation, with the response it went to; a purge that fails is reported, never the turn",
	async () => {
		const picture = (text: string): TurnInput["messages"] => [
			{
				id: crypto.randomUUID(),
				role: "user",
				content: [
					{ type: "text", text },
					{
						type: "image",
						data: "data:image/png;base64,iVBORw0KGgoAAA",
						mediaType: "image/png",
					},
				],
			},
		];
		await run(turn("thread-picture", "", { messages: picture("This map?") }));
		expect(JSON.stringify(fake.turns().at(-1)?.input)).toContain(
			"iVBORw0KGgoAAA",
		);
		const items = JSON.stringify(await itemsOf("thread-picture"));
		expect(items).not.toContain("iVBORw0KGgoAAA");
		expect(items).toContain("[picture: shown once, not kept]");
		const [first] = (await document("thread-picture")).conversation
			?.responseIds ?? [""];
		expect(fake.state.responses.has(first ?? "")).toBe(false);
		// What the delete reached is still in the service's run state: the limit the documentation names.
		expect(JSON.stringify(fake.state.retained)).toContain("iVBORw0KGgoAAA");
		expect(
			(await host.readThread(me, "thread-picture"))?.messages[0],
		).toMatchObject({ text: "This map?", imageSlots: 1 });

		fake.failWhen(
			(method, path) => method === "DELETE" && path.includes("/items/"),
			500,
		);
		const quiet = spyOn(console, "error").mockImplementation(() => {});
		try {
			const codes = await reported(() =>
				run(turn("thread-picture", "", { messages: picture("And this?") })),
			);
			expect(codes).toContainEqual(
				expect.objectContaining({
					"problem.code": "agent.history.picture_kept",
				}),
			);
		} finally {
			fake.failWhen(null);
			quiet.mockRestore();
		}
		expect(
			(await host.readThread(me, "thread-picture"))?.messages.at(-1),
		).toMatchObject({ role: "assistant", text: "On the second shelf." });
	},
);

t(
	"a picture is deleted from the conversation even when the turn's record could not be written",
	async () => {
		const picture = (text: string): TurnInput["messages"] => [
			{
				id: crypto.randomUUID(),
				role: "user",
				content: [
					{ type: "text", text },
					{
						type: "image",
						data: "data:image/png;base64,iVBORw0KGgoBBB",
						mediaType: "image/png",
					},
				],
			},
		];
		await run(turn("thread-picture-unrecorded", "The codename is Heron."));
		// The thread's record refuses every write from here: the settle cannot record the turn.
		const real = cosmosDatabase();
		setCosmosDatabase({
			verify: (d) => real.verify(d),
			container: (name) =>
				new Proxy(real.container(name), {
					get(target, field) {
						const value = Reflect.get(target, field);
						if (name !== "threads" || field !== "patch")
							return typeof value === "function" ? value.bind(target) : value;
						return async () => {
							throw new Error("the account is throttled");
						};
					},
				}),
		});
		const quiet = spyOn(console, "error").mockImplementation(() => {});
		try {
			await run(
				turn("thread-picture-unrecorded", "", {
					messages: picture("This map?"),
				}),
			);
		} finally {
			setCosmosDatabase(real);
			quiet.mockRestore();
		}
		const items = JSON.stringify(await itemsOf("thread-picture-unrecorded"));
		expect(items).not.toContain("iVBORw0KGgoBBB");
		expect(items).toContain("[picture: shown once, not kept]");
	},
);

t(
	"a conversation past its time to live is renewed by the next turn, which answers; the old one is kept for a delete to reach",
	async () => {
		await run(turn("thread-expired", "The codename is Heron."));
		const before = await document("thread-expired");
		const expired = before.conversation?.id ?? "";
		fake.expire(expired);
		const quiet = spyOn(console, "warn").mockImplementation(() => {});
		let events: TurnEvent[] = [];
		try {
			const codes = await reported(async () => {
				events = await run(turn("thread-expired", "Still there?"));
			});
			expect(codes).toContainEqual(
				expect.objectContaining({
					"problem.code": "agent.history.conversation_expired",
				}),
			);
		} finally {
			quiet.mockRestore();
		}
		expect(events.at(-1)).toMatchObject({ type: "finish" });
		const after = await document("thread-expired");
		expect(after.conversation?.id).not.toBe(expired);
		expect(after.conversation?.former).toEqual([expired]);
		expect(after.conversation?.responseIds).toEqual([
			...(before.conversation?.responseIds ?? []),
			expect.any(String),
		]);
		// The earlier messages went with it.
		expect(
			(await host.readThread(me, "thread-expired"))?.messages.map(
				(m) => m.text,
			),
		).toEqual(["Still there?", "On the second shelf."]);
	},
);

t(
	"a thread stays in the store it was made in when the setting changes; the setting decides only new threads",
	async () => {
		const toOwn = factory.editAgent({ history: { store: "own" } });
		try {
			await run(turn("thread-kept", "Back on the conversation?"));
			expect((await document("thread-kept")).store).toBe("foundry");
			expect(fake.turns().at(-1)?.body.store).toBe(true);
			await run(turn("thread-made-own", "A new one."));
			expect((await document("thread-made-own")).store).toBe("own");
			expect(fake.turns().at(-1)?.body).toMatchObject({ store: false });
		} finally {
			toOwn();
		}
		await run(turn("thread-made-own", "And again."));
		expect(fake.turns().at(-1)?.body).toMatchObject({ store: false });
		expect(fake.turns().at(-1)?.body).not.toHaveProperty("conversation");
		expect(
			(await host.readThread(me, "thread-made-own"))?.messages.map(
				(m) => m.text,
			),
		).toEqual([
			"A new one.",
			"On the second shelf.",
			"And again.",
			"On the second shelf.",
		]);
	},
);

t(
	"the own memory store extracts from a thread on the service's conversations",
	async () => {
		const handed = factory.extractor.handed.length;
		await run(turn("thread-remembered", "I collect sea charts."));
		await factory.settled?.();
		expect(factory.extractor.handed.slice(handed).join("\n")).toContain(
			"I collect sea charts.",
		);
		expect((await host.readMemory(me)).items.map((i) => i.content)).toContain(
			REMEMBERED,
		);
	},
);

t(
	"an erase calls every delete — each response, each item, the conversation and the one it replaced — and a failing one keeps the thread for the retry",
	async () => {
		const threads = ["thread-kept", "thread-expired", "thread-paged"];
		const documents = await Promise.all(threads.map(document));
		fake.failWhen(
			(method, path) =>
				method === "DELETE" && path.startsWith("/openai/v1/responses/"),
			500,
		);
		try {
			const codes = await reported(async () => {
				await expect(host.eraseResource(me)).rejects.toThrow();
			});
			expect(codes).toContainEqual(
				expect.objectContaining({
					"problem.code": "agent.erase.incomplete",
					"problem.reason": "history_delete_failed",
				}),
			);
		} finally {
			fake.failWhen(null);
		}
		// Nothing was taken off the index for a thread whose messages are still on the service.
		expect((await host.listThreads(me)).threads.length).toBeGreaterThanOrEqual(
			threads.length,
		);
		const report = await host.eraseResource(me);
		expect(report.threads).toBeGreaterThanOrEqual(threads.length);
		expect(await host.listThreads(me)).toEqual({ threads: [], next: null });
		const deletes = fake.deletes();
		for (const thread of documents) {
			const record = thread.conversation;
			for (const responseId of record?.responseIds ?? [])
				expect(deletes).toContain(`DELETE /openai/v1/responses/${responseId}`);
			for (const id of [record?.id, ...(record?.former ?? [])])
				expect(deletes).toContain(`DELETE /openai/v1/conversations/${id}`);
			expect(fake.state.conversations.has(record?.id ?? "")).toBe(false);
		}
		// Every item went through the API one by one.
		expect(deletes.filter((d) => d.includes("/items/")).length).toBeGreaterThan(
			0,
		);
		for (const items of fake.state.items.values()) expect(items).toEqual([]);
	},
);
