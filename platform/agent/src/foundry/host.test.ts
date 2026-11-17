import { afterAll, beforeAll, expect, spyOn, test } from "bun:test";
import { fakeConfigStore } from "@platform/config/testing";
import { cosmosDatabase, setCosmosDatabase } from "@platform/cosmos";
import {
	DEFAULT_LIMITS,
	keys,
	meterCall,
	peekCredits,
	resetMeteringKeyPrefix,
	setMeteringKeyPrefix,
	usageSubject,
} from "@platform/metering";
import { REDIS_AVAILABLE } from "@platform/redis/testing";
import { z } from "zod";
import type { TurnEvent, TurnInput } from "../index";
import {
	type AgentProduct,
	productTool,
	type SkillSource,
	WEB_SEARCH,
} from "../index";
import { resetAgentSettings } from "../settings";
import { createFoundryAgentHost, type FoundryAgentHost } from "./host";
import { openThread } from "./open-thread";
import { publishSkills } from "./skills";
import { FAKE_RAI_POLICY, type FakeFoundry } from "./testing/fake-foundry";
import { foundryParityFactory, REMEMBERED } from "./testing/parity-factory";

/**
 * What the parity suite cannot see, on the stand-in service: the version a
 * turn runs on and what it holds, the requests the host sends and the ones
 * it never does — every response with `store: false`, given the thread's
 * history from this deployment's database — the controls answered here,
 * the write a mixed response holds before its `finish`, a picture that is
 * input to its turn and kept nowhere, web search, the skills pinned into a
 * version, and everything an erase must reach.
 */

const SHELF = "shelf";
const SHOW = "showShelf";
const HIDE = "hideShelf";
const STEPS = "steps";

const product: AgentProduct = {
	agentId: "sample",
	serviceName: "sample-agent",
	toolKeys: [SHELF, STEPS, WEB_SEARCH],
	persona: async () => "# CORE IDENTITY\nYou are the {{sample}} assistant.",
	guardrails: () => "You decline anything outside the sample's scope.",
	behaviour: ({ surface }) => `On the ${surface} surface, answer in one line.`,
	tools: ({ enabledTools }) => ({
		...(enabledTools.includes(SHELF)
			? {
					[SHELF]: productTool({
						description: "Find the shelf a book is on.",
						parameters: z.object({ title: z.string().min(1) }),
						execute: async ({ title }) => ({ title, shelf: "the second" }),
						// The book found is the document the answer drew on.
						sources: ({ title }) => [{ id: `book-${title}`, title }],
					}),
				}
			: {}),
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
		{
			name: HIDE,
			description: "Dim a shelf.",
			parameters: { type: "object", properties: {} },
		},
	],
	skills: [
		{
			name: "shelf-finder",
			description: "Use when a book is lost.",
			instructions: "Call `shelf` first.",
			requiresTools: [SHELF],
		},
		{
			name: "voice-only",
			description: "Use when speaking.",
			instructions: "Speak briefly.",
			surfaces: ["voice"],
		},
	],
};

// The own memory store: its race is this file's; the Foundry store's is `memory.test.ts`'s.
const factory = foundryParityFactory({ memory: "own" });
const RUN = REDIS_AVAILABLE;
const t = test.skipIf(!RUN);
let host: FoundryAgentHost;
let fake: FakeFoundry;
let me = "";
let other = "";

async function drain(
	outcome: Awaited<ReturnType<FoundryAgentHost["startTurn"]>>,
) {
	expect(outcome.kind).toBe("started");
	const events: TurnEvent[] = [];
	if (outcome.kind !== "started") return events;
	const reader = outcome.events.getReader();
	for (;;) {
		const { done, value } = await reader.read();
		if (done) return events;
		events.push(value);
	}
}

function turn(
	overrides: Partial<TurnInput> = {},
	content = "Where is the atlas?",
): TurnInput {
	return {
		resourceId: me,
		threadId: "thread-impl",
		messages: [{ id: crypto.randomUUID(), role: "user", content }],
		surface: "web",
		languageName: "English",
		caller: { oid: me, groups: [], tier: "base" },
		...overrides,
	};
}

const run = async (input: TurnInput) => drain(await host.startTurn(input));

/** A thread's history as this deployment's database holds it, oldest first. */
async function history(threadId: string, resourceId = me) {
	const documents = await cosmosDatabase()
		.container("messages")
		.query<{
			id: string;
			seq: number;
			threadId: string;
			item: Record<string, unknown>;
		}>(
			{
				query:
					"SELECT * FROM c WHERE c.threadId = @threadId ORDER BY c.seq ASC",
				parameters: [{ name: "@threadId", value: threadId }],
			},
			resourceId,
		);
	return documents.map((d) => d.item);
}

beforeAll(async () => {
	if (!RUN) return;
	host = (await factory.create(product)) as FoundryAgentHost;
	fake = factory.fake();
	await publishSkills(product.skills ?? []);
	await host.start();
	({ resourceId: me } = await factory.person());
	({ resourceId: other } = await factory.person());
	factory.answer("On the second shelf.");
});

afterAll(async () => {
	if (!RUN) return;
	await host.stop();
	await factory.teardown();
});

t(
	"the memory store the operator's document names is the one the host runs: here the deployment's own",
	async () => {
		expect((await host.memory.selected()).kind).toBe("own");
		expect(host.memory.kind).toBe("own");
	},
);

t(
	"a turn runs on a version that holds parts one and two, every control and tool, the fitting skills and the guardrail, and sends none of it",
	async () => {
		await run(turn());
		const seen = fake.turns().at(-1);
		const versions = fake.state.agents.get("sample") ?? [];
		expect(versions).toHaveLength(1);
		const definition = versions[0]?.definition as Record<string, unknown>;
		expect(definition.instructions).toMatch(
			/\{ \{sample\}\} assistant[\s\S]*\n\n\{\{personalization\}\}$/,
		);
		expect(definition.structured_inputs).toEqual({
			personalization: expect.objectContaining({
				schema: { type: "string" },
				required: true,
			}),
		});
		expect(
			(definition.tools as { type: string; name?: string }[]).map(
				(t) => t.name ?? t.type,
			),
		).toEqual([SHOW, HIDE, "web_search", SHELF, STEPS]);
		expect(definition.skills).toEqual([{ name: "shelf-finder", version: "1" }]);
		expect(definition.rai_config).toEqual({
			rai_policy_name: FAKE_RAI_POLICY,
		});
		expect(versions[0]?.metadata.hash).toMatch(/^[0-9a-f]{32}$/);
		// What the version decides is never sent with a response; who is asking is. Nothing is kept by the service.
		expect(Object.keys(seen?.body ?? {}).sort()).toEqual(
			[
				"agent_reference",
				"include",
				"input",
				"store",
				"stream",
				"structured_inputs",
				"truncation",
			].sort(),
		);
		expect(seen?.body.store).toBe(false);
		expect(seen?.body.include).toEqual(["reasoning.encrypted_content"]);
		expect(seen?.instructions).toContain("<personalization>");
	},
);

t(
	"one version per definition across hosts, a new one when the operator's words change, and the prune keeps the newest",
	async () => {
		const second = createFoundryAgentHost(product);
		expect(await second.prime(["web"])).toEqual({
			versions: ["1"],
			voice: {},
			pruned: 0,
		});
		await run(turn({ surface: "voice" }));
		const versions = (fake.state.agents.get("sample") ?? []).map(
			(v) => v.version,
		);
		expect(versions).toEqual(["1", "2"]);
		const voice = fake.state.agents.get("sample")?.[1]?.definition as {
			skills: unknown;
		};
		expect(voice.skills).toEqual([
			{ name: "shelf-finder", version: "1" },
			{ name: "voice-only", version: "1" },
		]);
	},
);

t(
	"a version pruned under a replica that still pins it is made again, and the turn answers",
	async () => {
		const pinned = fake.turns().at(-1)?.agent.version ?? "-";
		fake.state.agents.set(
			"sample",
			(fake.state.agents.get("sample") ?? []).filter(
				(v) => v.version !== pinned,
			),
		);
		const events = await run(turn({ surface: "voice" }));
		expect(events.at(-1)).toMatchObject({ type: "finish" });
		expect(fake.turns().at(-1)?.agent.version).not.toBe(pinned);
	},
);

t(
	"a control this client did not register is answered here, and the turn carries on",
	async () => {
		fake.script({ calls: [{ id: "call_hide", name: HIDE, args: {} }] });
		const events = await run(turn({ clientTools: [SHOW] }));
		expect(events.filter((e) => e.type === "tool-result")).toEqual([
			expect.objectContaining({
				name: HIDE,
				result: expect.objectContaining({ error: "not_available" }),
				isError: true,
				runsOn: "server",
			}),
		]);
		expect(events.at(-1)).toMatchObject({ type: "finish", reason: "stop" });
		expect(JSON.stringify(fake.turns().at(-1)?.input)).toContain(
			"not_available",
		);
	},
);

t(
	"a reply that wrote its words and then called only an unregistered control ends there, said once",
	async () => {
		const before = fake.turns().length;
		fake.script({
			text: "The atlas is on the second shelf.",
			calls: [{ id: "call_hide_after", name: HIDE, args: {} }],
		});
		const events = await run(
			turn({ threadId: "thread-said-once", clientTools: [SHOW] }),
		);
		expect(fake.turns().length - before).toBe(1);
		expect(events.at(-1)).toMatchObject({ type: "finish", reason: "stop" });
		expect(
			events
				.filter((e) => e.type === "text")
				.map((e) => (e as { text: string }).text)
				.join(""),
		).toBe("The atlas is on the second shelf.");
		expect(events.filter((e) => e.type === "tool-result")).toEqual([
			expect.objectContaining({ name: HIDE, isError: true }),
		]);
		const kept = await history("thread-said-once");
		expect(
			kept.filter((i) => i.type === "message" && i.role === "assistant"),
		).toHaveLength(1);
		expect(
			kept.filter((i) => i.call_id === "call_hide_after").map((i) => i.type),
		).toEqual(["function_call", "function_call_output"]);
	},
);

t(
	"a model that keeps calling an unregistered control is asked once without tools, and the turn ends in words",
	async () => {
		const before = fake.turns().length;
		fake.respond((seen) =>
			seen.body.tool_choice === "none"
				? { text: "The atlas is on the second shelf." }
				: {
						calls: [
							{ id: `call_hide_${seen.input.length}`, name: HIDE, args: {} },
						],
					},
		);
		try {
			const events = await run(
				turn({ threadId: "thread-words-at-last", clientTools: [SHOW] }),
			);
			expect(
				events
					.filter((e) => e.type === "text")
					.map((e) => (e as { text: string }).text)
					.join(""),
			).toBe("The atlas is on the second shelf.");
			expect(events.at(-1)).toMatchObject({ type: "finish", reason: "stop" });
			const asked = fake.turns().slice(before);
			expect(asked.map((seen) => seen.body.tool_choice)).toEqual([
				undefined,
				"none",
			]);
		} finally {
			fake.state.responder = null;
		}
	},
);

t(
	"a mixed response's held output is in the history before its finish reaches anyone",
	async () => {
		fake.script({
			calls: [
				{ id: "call_find", name: SHELF, args: { title: "Atlas" } },
				{ id: "call_show", name: SHOW, args: {} },
			],
		});
		const outcome = await host.startTurn(
			turn({ threadId: "thread-held", clientTools: [SHOW] }),
		);
		if (outcome.kind !== "started") throw new Error("refused");
		const reader = outcome.events.getReader();
		for (;;) {
			const { value } = await reader.read();
			if (value?.type !== "finish") continue;
			const kept = await history("thread-held");
			expect(
				kept.some(
					(i) => i.type === "function_call_output" && i.call_id === "call_find",
				),
			).toBe(true);
			// The browser's call is the one left open, for its answer to continue the turn.
			expect(
				kept.filter((i) => i.call_id === "call_show").map((i) => i.type),
			).toEqual(["function_call"]);
			break;
		}
		await reader.cancel();
	},
);

t(
	"a turn the browser's answer continues is given the model's reasoning back under the id the service gave it, and answers",
	async () => {
		fake.script({
			reasoning: ["The shelf should light up."],
			calls: [{ id: "call_light", name: SHOW, args: {} }],
		});
		const asked = await run(
			turn({ threadId: "thread-reasoned", clientTools: [SHOW] }),
		);
		expect(asked.at(-1)).toMatchObject({
			type: "finish",
			reason: "tool-calls",
		});
		const answered = await run(
			turn({
				threadId: "thread-reasoned",
				clientTools: [SHOW],
				messages: [
					{ id: "t1", role: "tool", toolCallId: "call_light", content: "Lit." },
				],
			}),
		);
		expect(answered.at(-1)).toMatchObject({ type: "finish", reason: "stop" });
		const given = fake.turns().at(-1)?.input ?? [];
		const reasoning = given.find((i) => i.type === "reasoning");
		expect(reasoning).toMatchObject({
			id: expect.stringMatching(/^rs/),
			encrypted_content: expect.any(String),
		});
		// Kept under its own id beside the host's, so it can be given back.
		expect(
			(await history("thread-reasoned")).find((i) => i.type === "reasoning"),
		).toMatchObject({ service_id: reasoning?.id });
	},
);

t(
	"words from a person whose browser never answered close the open call, and the turn runs",
	async () => {
		fake.script({ calls: [{ id: "call_never", name: SHOW, args: {} }] });
		await run(turn({ threadId: "thread-unanswered", clientTools: [SHOW] }));
		const events = await run(
			turn(
				{ threadId: "thread-unanswered", clientTools: [SHOW] },
				"Never mind.",
			),
		);
		expect(events.at(-1)).toMatchObject({ type: "finish", reason: "stop" });
		expect(JSON.stringify(fake.turns().at(-1)?.input)).toContain(
			"not_answered",
		);
	},
);

t(
	"a run that fails after a backend tool ran keeps the call with its output, and the person's next words read on from both",
	async () => {
		fake.script(
			{ calls: [{ id: "call_lost", name: STEPS, args: {} }] },
			// The step that would have answered from the output never completes.
			{ status: 400 },
		);
		const quiet = spyOn(console, "error").mockImplementation(() => {});
		try {
			const failed = await run(turn({ threadId: "thread-lost" }));
			expect(failed.at(-1)).toEqual({ type: "error", code: "turn.failed" });
		} finally {
			quiet.mockRestore();
		}
		const events = await run(turn({ threadId: "thread-lost" }, "And now?"));
		expect(events.at(-1)).toMatchObject({ type: "finish", reason: "stop" });
		const input = fake.turns().at(-1)?.input ?? [];
		const call = input.findIndex(
			(i) => i.type === "function_call" && i.call_id === "call_lost",
		);
		expect(call).toBeGreaterThan(0);
		expect(input[call + 1]).toMatchObject({
			type: "function_call_output",
			call_id: "call_lost",
			output: "stepped",
		});
	},
);

t(
	"a turn that keeps calling stops at the step limit, its last outputs still written, and is asked once more without tools for its words",
	async () => {
		fake.script(
			...Array.from({ length: 6 }, (_, i) => ({
				calls: [{ id: `call_step_${i}`, name: STEPS, args: {} }],
			})),
		);
		const events = await run(turn({ threadId: "thread-steps" }));
		expect(events.at(-1)).toMatchObject({ type: "finish", reason: "stop" });
		expect(fake.turns().at(-1)?.body.tool_choice).toBe("none");
		expect(events.some((e) => e.type === "text")).toBe(true);
		expect(
			fake
				.turns()
				.filter((t) =>
					t.items.some((i) => String(i.call_id).startsWith("call_step")),
				).length,
		).toBe(6);
		expect(
			(await history("thread-steps"))
				.filter((i) => i.call_id === "call_step_5")
				.map((i) => i.type),
		).toEqual(["function_call", "function_call_output"]);
	},
);

t(
	"web search runs inside the response: a service call and its result; the web pages it cited are never a library document, so nothing is put under the answer",
	async () => {
		fake.script({
			text: "The atlas moved.",
			web: [
				{ url: "https://example.org/atlas", title: "Atlas" },
				{ url: "https://example.org/atlas", title: "Atlas again" },
				{ url: "https://example.org/elsewhere", title: "Not a document" },
			],
		});
		const events = await run(turn({ threadId: "thread-web" }));
		expect(
			events.filter((e) => e.type === "tool-call" || e.type === "tool-result"),
		).toEqual([
			expect.objectContaining({
				type: "tool-call",
				name: WEB_SEARCH,
				runsOn: "service",
			}),
			expect.objectContaining({
				type: "tool-result",
				name: WEB_SEARCH,
				isError: false,
				runsOn: "service",
			}),
		]);
		expect(events.filter((e) => e.type === "sources")).toEqual([]);
		expect(events.at(-1)).toEqual(expect.objectContaining({ type: "finish" }));
	},
);

t(
	"the documents the backend's tools handed the model are the sources under the answer, each once across the turn's calls, before finish",
	async () => {
		fake.script(
			{
				calls: [
					{ id: "call_src_1", name: SHELF, args: { title: "Atlas" } },
					{ id: "call_src_2", name: SHELF, args: { title: "Almanac" } },
				],
			},
			{ calls: [{ id: "call_src_3", name: SHELF, args: { title: "Atlas" } }] },
			{ text: "Both are on the second shelf." },
		);
		const events = await run(turn({ threadId: "thread-sources" }));
		expect(events.filter((e) => e.type === "sources")).toEqual([
			{
				type: "sources",
				sources: [
					{ id: "book-Atlas", title: "Atlas" },
					{ id: "book-Almanac", title: "Almanac" },
				],
			},
		]);
		expect(events.at(-1)).toMatchObject({ type: "finish", reason: "stop" });
		expect(events.at(-2)?.type).toBe("sources");
	},
);

t(
	"of the documents a turn retrieved, the chips are the ones the reply names; a reply naming none keeps them all",
	async () => {
		fake.script(
			{
				calls: [
					{ id: "call_named_1", name: SHELF, args: { title: "Atlas" } },
					{ id: "call_named_2", name: SHELF, args: { title: "Almanac" } },
					{ id: "call_named_3", name: SHELF, args: { title: "Gazetteer" } },
				],
			},
			{ text: "The **Atlas** is on the second shelf." },
		);
		const events = await run(turn({ threadId: "thread-named" }));
		expect(events.filter((e) => e.type === "sources")).toEqual([
			{ type: "sources", sources: [{ id: "book-Atlas", title: "Atlas" }] },
		]);
	},
);

t(
	"each web search a turn ran is charged to the account after it, and an account with none left is given turns without web search",
	async () => {
		setMeteringKeyPrefix(`test-meter-${crypto.randomUUID()}`);
		try {
			const subject = usageSubject(other);
			if (!subject) throw new Error("no subject");
			const { burst, refillPerMinute } = DEFAULT_LIMITS.toolSearch;
			const all = () =>
				peekCredits(
					keys.burst(subject, "toolSearch"),
					{ capacity: burst, refillPerMinute },
					burst,
				);
			const asOther = { resourceId: other, threadId: "thread-meter" };
			const caller = { oid: other, groups: [], tier: "base" as const };
			expect((await all()).allowed).toBe(true);
			fake.script({
				text: "Found it.",
				web: [{ url: "https://example.org", title: "Example" }],
			});
			await run(turn({ ...asOther, caller }));
			expect((await all()).allowed).toBe(false);

			while ((await meterCall(subject, "toolSearch", "base")).ok);
			await run(turn({ ...asOther, caller }));
			const ran = fake.turns().at(-1)?.agent.version;
			const definition = fake.state.agents
				.get("sample")
				?.find((v) => v.version === ran)?.definition as {
				tools: { type: string }[];
			};
			expect(definition.tools.map((t) => t.type)).not.toContain("web_search");
			// A turn nobody verified has no account to charge, and searches nothing.
			await run(turn({ ...asOther, caller: undefined }));
			expect(fake.turns().at(-1)?.agent.version).toBe(ran);
			// The erase below counts on every conversation left being the first person's.
			await host.eraseResource(other);
		} finally {
			resetMeteringKeyPrefix();
		}
	},
);

t(
	"a picture is input to its own turn only: the history keeps its marker, and no later turn is given it",
	async () => {
		fake.script({
			calls: Array.from({ length: 3 }, (_, i) => ({
				id: `call_far_${i}`,
				name: STEPS,
				args: {},
			})),
		});
		await run(
			turn({
				threadId: "thread-pictures",
				messages: [
					{
						id: crypto.randomUUID(),
						role: "user",
						content: [
							{ type: "text", text: "This map?" },
							{
								type: "image",
								data: "data:image/png;base64,iVBORw0KGgoAAA",
								mediaType: "image/png",
							},
						],
					},
				],
			}),
		);
		// Every step of its own turn is given it, however many calls came between.
		const ofThisTurn = fake.turns().slice(-2);
		for (const seen of ofThisTurn)
			expect(JSON.stringify(seen.items)).toContain("iVBORw0KGgoAAA");
		const kept = JSON.stringify(await history("thread-pictures"));
		expect(kept).not.toContain("iVBORw0KGgoAAA");
		expect(kept).toContain("[picture: shown once, not kept]");
		await run(turn({ threadId: "thread-pictures" }, "And the other one?"));
		const next = JSON.stringify(fake.turns().at(-1)?.items);
		expect(next).not.toContain("iVBORw0KGgoAAA");
		expect(next).toContain("[picture: shown once, not kept]");
		const thread = await host.readThread(me, "thread-pictures");
		expect(thread?.messages[0]).toMatchObject({
			text: "This map?",
			imageSlots: 1,
		});
	},
);

t(
	"a turn is given its thread's history within the agent document's bound, starting at the person's words, so no output goes without its call",
	async () => {
		for (const said of ["First.", "Second.", "Third."])
			await run(turn({ threadId: "thread-bounded" }, said));
		fake.script({ calls: [{ id: "call_bound", name: STEPS, args: {} }] });
		await run(turn({ threadId: "thread-bounded" }, "Fourth."));
		const given = () =>
			(fake.turns().at(-1)?.input ?? []).filter(
				(i) => i.type === "message" && i.role === "user",
			).length;
		await run(turn({ threadId: "thread-bounded" }, "Fifth."));
		expect(given()).toBe(5);
		// Five items reach into the fourth exchange, its call and output but not its words: it is left out whole.
		const undo = factory.editAgent({ history: { maxItems: 5 } });
		try {
			await run(turn({ threadId: "thread-bounded" }, "Sixth."));
			const input = fake.turns().at(-1)?.input ?? [];
			expect(input[0]).toMatchObject({ type: "message", role: "user" });
			expect(JSON.stringify(input[0])).toContain("Fifth.");
			expect(input.some((i) => i.call_id === "call_bound")).toBe(false);
			expect(given()).toBe(2);
		} finally {
			undo();
		}
		// Room for its words too, and the fourth exchange is given with its call and output.
		const wider = factory.editAgent({ history: { maxItems: 8 } });
		try {
			await run(turn({ threadId: "thread-bounded" }, "Seventh."));
			const input = fake.turns().at(-1)?.input ?? [];
			expect(input[0]).toMatchObject({ type: "message", role: "user" });
			expect(JSON.stringify(input[0])).toContain("Fourth.");
			expect(
				input.filter((i) => i.call_id === "call_bound").map((i) => i.type),
			).toEqual(["function_call", "function_call_output"]);
		} finally {
			wider();
		}
		const tight = factory.editAgent({ history: { maxChars: 1 } });
		try {
			await run(turn({ threadId: "thread-bounded" }, "Eighth."));
			// Nothing fits, so only the newest exchange the person began: never none of it.
			expect(given()).toBe(2);
		} finally {
			tight();
		}
	},
);

t(
	"a delete that failed part way is finished by the next one: the claim on the id goes with it",
	async () => {
		await run(turn({ threadId: "thread-half-deleted" }));
		const real = cosmosDatabase();
		for (const failing of ["threads", "threadIds"]) {
			await run(turn({ threadId: "thread-half-deleted" }, failing));
			let refused = true;
			setCosmosDatabase({
				verify: (d) => real.verify(d),
				container: (name) =>
					new Proxy(real.container(name), {
						get(target, field) {
							const value = Reflect.get(target, field);
							if (name !== failing || field !== "delete" || !refused)
								return typeof value === "function" ? value.bind(target) : value;
							return async () => {
								refused = false;
								throw new Error("the account is throttled");
							};
						},
					}),
			});
			try {
				await expect(
					host.deleteThread(me, "thread-half-deleted"),
				).rejects.toThrow("throttled");
				expect(await host.deleteThread(me, "thread-half-deleted")).toBe(true);
			} finally {
				setCosmosDatabase(real);
			}
			expect(
				await real
					.container("threadIds")
					.read("thread-half-deleted", "thread-half-deleted"),
			).toBeNull();
			expect(await host.readThread(me, "thread-half-deleted")).toBeNull();
		}
	},
);

t(
	"a first turn whose index entry cannot be written leaves no claim naming the person",
	async () => {
		const real = cosmosDatabase();
		setCosmosDatabase({
			verify: (d) => real.verify(d),
			container: (name) =>
				name === "threads"
					? {
							...real.container(name),
							read: (id, key) => real.container(name).read(id, key),
							create: async () => {
								throw new Error("the account is throttled");
							},
						}
					: real.container(name),
		});
		try {
			await expect(
				host.startTurn(turn({ threadId: "thread-never-made" })),
			).rejects.toThrow("throttled");
		} finally {
			setCosmosDatabase(real);
		}
		expect(
			await real
				.container("threadIds")
				.read("thread-never-made", "thread-never-made"),
		).toBeNull();
	},
);

t(
	"two first writes that open one thread at once both land in it, one index entry between them",
	async () => {
		const written = await Promise.all(
			[0, 1].map(() =>
				openThread({
					resourceId: me,
					threadId: "thread-spoken-race",
					title: "",
					history: host.history.for({}),
				}),
			),
		);
		expect(written.map((w) => w?.created).sort()).toEqual([false, true]);
		expect(await host.readThread(me, "thread-spoken-race")).toMatchObject({
			id: "thread-spoken-race",
			messages: [],
		});
	},
);

t(
	"a thread longer than the read bound shows its newest messages, each with its own turn's time, and pages back to its first",
	async () => {
		const said = ["One.", "Two.", "Three."];
		for (const content of said) {
			await run(turn({ threadId: "thread-long" }, content));
			await Bun.sleep(5);
		}
		const undo = factory.editAgent({ foundry: { maxItemsRead: 3 } });
		try {
			const newest = await host.readThread(me, "thread-long");
			// Three items, newest first: the last answer, its question, the answer before.
			expect(newest?.messages.map((m) => m.text)).toEqual([
				"On the second shelf.",
				"Three.",
				"On the second shelf.",
			]);
			const pages = [newest?.messages ?? []];
			for (let before = newest?.earlier; before; ) {
				const older = await host.readThread(me, "thread-long", { before });
				pages.unshift(older?.messages ?? []);
				before = older?.earlier;
			}
			const whole = pages.flat();
			expect(whole.filter((m) => m.role === "user").map((m) => m.text)).toEqual(
				said,
			);
			// A question and its answer share the turn's time, and every turn is later than the one before.
			const times = whole.map((m) => m.createdAt);
			for (let i = 0; i < times.length; i += 2) {
				expect(times[i + 1]).toBe(times[i] as string);
				if (i)
					expect((times[i] as string) > (times[i - 1] as string)).toBe(true);
			}
		} finally {
			undo();
		}
	},
);

t(
	"an ownership store that cannot answer is a 503 before the service is asked, never a pass",
	async () => {
		const real = cosmosDatabase();
		const asked = fake.turns().length;
		setCosmosDatabase({
			verify: (d) => real.verify(d),
			container: (name) =>
				name === "threadIds"
					? {
							...real.container(name),
							read: async () => {
								throw new Error("the account is throttled");
							},
						}
					: real.container(name),
		});
		const quiet = spyOn(console, "error").mockImplementation(() => {});
		try {
			expect(
				await host.startTurn(turn({ threadId: "thread-unreadable" })),
			).toEqual({
				kind: "refused",
				refusal: { code: "thread.unavailable", status: 503 },
			});
		} finally {
			quiet.mockRestore();
			setCosmosDatabase(real);
		}
		expect(fake.turns().length).toBe(asked);
	},
);

t(
	"forgetting inside an extraction's delay is final: the wait is dropped, and what is said after the forget is remembered again",
	async () => {
		const { resourceId: who } = await factory.person();
		const as = (content: string, threadId: string) =>
			turn(
				{
					resourceId: who,
					threadId,
					caller: { oid: who, groups: [], tier: "base" },
				},
				content,
			);
		const undo = factory.editAgent({ memory: { updateDelaySeconds: 1 } });
		// Whatever the person said, kept word for word: so a statement says which turn it came from.
		factory.extractor.extract((messages) =>
			messages
				.filter((m) => m.startsWith("user: "))
				.map((m) => m.slice("user: ".length)),
		);
		try {
			await run(as("My favourite colour is teal.", "thread-race-1"));
			expect(await host.readMemory(who)).toEqual({ items: [] });
			expect(await host.forgetMemory(who)).toBe(false);
			// The wait went with the forget: running everything due extracts nothing of it.
			await factory.settled?.();
			expect(await host.readMemory(who)).toEqual({ items: [] });
			expect(factory.instructions()).not.toContain("teal");

			await run(as("I prefer short answers.", "thread-race-2"));
			await factory.settled?.();
			expect((await host.readMemory(who)).items.map((i) => i.content)).toEqual([
				"I prefer short answers.",
			]);
			expect(await host.forgetMemory(who)).toBe(true);
			expect(await host.readMemory(who)).toEqual({ items: [] });
		} finally {
			factory.extractor.extract((_, kept) => [
				...new Set([...kept, REMEMBERED]),
			]);
			undo();
			// The erase below counts on every conversation left being the first person's.
			await host.eraseResource(who);
		}
	},
);

t(
	"an extraction in flight when the person forgets writes nothing back, and nothing reads it in between",
	async () => {
		const { resourceId: who } = await factory.person();
		const as = (content: string, threadId: string) =>
			turn(
				{
					resourceId: who,
					threadId,
					caller: { oid: who, groups: [], tier: "base" },
				},
				content,
			);
		// The facts held: a forget leaves its floor, a document of when it happened and nothing said.
		const held = async () =>
			(
				await cosmosDatabase()
					.container("memory")
					.query({ query: "SELECT * FROM c" }, who)
			).filter((doc) => doc.id !== "floor");
		factory.extractor.extract((messages) =>
			messages
				.filter((m) => m.startsWith("user: "))
				.map((m) => m.slice("user: ".length)),
		);
		let release = () => {};
		factory.extractor.waitFor(new Promise<void>((r) => (release = r)));
		try {
			// The race the service's store lost: the extraction began before the forget and answers after it.
			await run(as("I live by the sea.", "thread-race-3"));
			expect(await host.forgetMemory(who)).toBe(false);
			release();
			await factory.settled?.();
			expect(await held()).toEqual([]);
			expect(await host.readMemory(who)).toEqual({ items: [] });
			expect((await host.personalization(who, "written")).memory).toBeNull();
			// The thread goes on: what was said before the forget is not learned again, what is said after it is.
			await run(as("I keep bees.", "thread-race-3"));
			await factory.settled?.();
			expect(
				(await host.readMemory(who)).items.map((item) => item.content),
			).toEqual(["I keep bees."]);
		} finally {
			release();
			factory.extractor.waitFor(null);
			factory.extractor.extract((_, kept) => [
				...new Set([...kept, REMEMBERED]),
			]);
			await host.eraseResource(who);
		}
	},
);

t(
	"an erase reaches every message of the person's history, every statement the service holds for them, and their index — and the service never held a conversation",
	async () => {
		await factory.settled?.();
		expect((await host.readMemory(me)).items.map((i) => i.content)).toContain(
			REMEMBERED,
		);
		const report = await host.eraseResource(me);
		expect(report.threads).toBeGreaterThan(0);
		expect(report.memories).toBe(true);
		expect(
			await cosmosDatabase()
				.container("messages")
				.query({ query: "SELECT * FROM c" }, me),
		).toEqual([]);
		// Nothing was asked of the service that would keep a word of it.
		expect(
			fake.requests.filter((r) =>
				/\/conversations|DELETE \/openai\/v1\/responses/.test(r),
			),
		).toEqual([]);
		expect(
			await cosmosDatabase()
				.container("memory")
				.query({ query: "SELECT * FROM c" }, me),
		).toEqual([]);
		expect(
			await cosmosDatabase()
				.container("threads")
				.query({ query: "SELECT * FROM c" }, me),
		).toEqual([]);
		expect(await host.listThreads(me)).toEqual({ threads: [], next: null });
	},
);

t(
	"a spent turn bucket is a 429 before the service is asked, with when to come back",
	async () => {
		const undo = fakeConfigStore({
			agent: { turns: { burst: 1, refillPerMinute: 1 } },
		});
		resetAgentSettings();
		try {
			await run(turn({ resourceId: other, threadId: "thread-bucket" }));
			const asked = fake.turns().length;
			const refused = await host.startTurn(
				turn({ resourceId: other, threadId: "thread-bucket" }),
			);
			expect(refused).toMatchObject({
				kind: "refused",
				refusal: {
					code: "turn.rate_limited",
					status: 429,
					retryAfterSeconds: expect.any(Number),
				},
			});
			expect(fake.turns().length).toBe(asked);
		} finally {
			undo();
			resetAgentSettings();
		}
	},
);

t(
	"the job's steps are idempotent: a skill whose words did not change is not published again",
	async () => {
		const catalogue = product.skills ?? [];
		expect(await publishSkills(catalogue)).toEqual({
			"shelf-finder": "unchanged",
			"voice-only": "unchanged",
		});
		const [first, ...rest] = catalogue;
		expect(
			await publishSkills([
				{ ...(first as SkillSource), instructions: "Call `shelf`, then look." },
				...rest,
			]),
		).toEqual({ "shelf-finder": "published", "voice-only": "unchanged" });
		expect(fake.state.skills.get("shelf-finder")?.default_version).toBe("2");
	},
);
