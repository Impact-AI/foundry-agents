import {
	afterAll,
	beforeAll,
	expect,
	setSystemTime,
	spyOn,
	test,
} from "bun:test";
import { cosmosDatabase, setCosmosDatabase } from "@platform/cosmos";
import { REDIS_AVAILABLE } from "@platform/redis/testing";
import { z } from "zod";
import type { TurnEvent, TurnInput } from "../index";
import { type AgentProduct, productTool } from "../index";
import { problems } from "../keys";
import { createFoundryAgentHost, type FoundryAgentHost } from "./host";
import { foundryParityFactory } from "./testing/parity-factory";

/**
 * The ways a turn ends that are not its answer, on the stand-in service: a
 * person's stop part way through a response, a history that cannot be
 * written once the answer has streamed, a thread deleted under a turn still
 * running on it, an erase of a person with a message no thread leads to,
 * the same delete and an erase made on another replica than the turn's,
 * and the job's prune of a version a definition went back to.
 */

const product: AgentProduct = {
	agentId: "ends",
	serviceName: "ends-agent",
	toolKeys: ["steps"],
	persona: async () => "You are the sample assistant.",
	guardrails: () => "You decline anything outside the sample's scope.",
	behaviour: ({ surface }) => `On the ${surface} surface, answer in one line.`,
	tools: () => ({
		steps: productTool({
			description: "Take one more step.",
			parameters: z.object({}),
			execute: async () => {
				stepped++;
				await stepping?.();
				return "stepped";
			},
		}),
	}),
	clientTools: [],
};

/** How often the product's tool ran, and what a test has it wait for. */
let stepped = 0;
let stepping: (() => Promise<void>) | undefined;

const factory = foundryParityFactory({ memory: "own" });
const t = test.skipIf(!REDIS_AVAILABLE);
let host: FoundryAgentHost;
let me = "";
let quiet: ReturnType<typeof spyOn> | undefined;

/** A reply long enough, and slow enough, to be stopped part way: the reasoning is complete before its first word. */
const SLOW = {
	text: "The atlas is on the second shelf, behind the globes, where it has always been.",
	reasoning: ["Recalling the shelves."],
	pace: { wordMs: 40 },
};

function turn(threadId: string, overrides: Partial<TurnInput> = {}): TurnInput {
	return {
		resourceId: me,
		threadId,
		messages: [
			{ id: crypto.randomUUID(), role: "user", content: "Where is the atlas?" },
		],
		surface: "web",
		languageName: "English",
		caller: { oid: me, groups: [], tier: "base" },
		...overrides,
	};
}

/** The run's events, `midway` called once at its first word. */
async function run(
	input: TurnInput,
	midway?: () => Promise<void> | void,
	on: FoundryAgentHost = host,
) {
	const outcome = await on.startTurn(input);
	expect(outcome.kind).toBe("started");
	const events: TurnEvent[] = [];
	if (outcome.kind !== "started") return events;
	const reader = outcome.events.getReader();
	let called = false;
	for (;;) {
		const { done, value } = await reader.read();
		if (done) return events;
		events.push(value);
		if (value.type === "text" && midway && !called) {
			called = true;
			await midway();
		}
	}
}

/** Every message document the person's partition holds, as the thread each names. */
async function held(resourceId = me): Promise<string[]> {
	const documents = await cosmosDatabase()
		.container("messages")
		.query<{ id: string; threadId: string; item: { type?: string } }>(
			{ query: "SELECT * FROM c" },
			resourceId,
		);
	return documents.map((d) => `${d.threadId}:${d.item.type}`);
}

beforeAll(async () => {
	if (!REDIS_AVAILABLE) return;
	host = (await factory.create(product)) as FoundryAgentHost;
	await host.start();
	({ resourceId: me } = await factory.person());
	factory.answer("On the second shelf.");
	quiet = spyOn(console, "info").mockImplementation(() => {});
});

afterAll(async () => {
	if (!REDIS_AVAILABLE) return;
	quiet?.mockRestore();
	await host.stop();
	await factory.teardown();
});

t(
	"a person's stop part way through a reply keeps no reasoning without what it led to, reports no failure, and the thread answers the next words",
	async () => {
		const reported = spyOn(problems, "report");
		const stop = new AbortController();
		try {
			factory.script(SLOW);
			const events = await run(
				turn("thread-stopped", { abortSignal: stop.signal }),
				() => stop.abort(),
			);
			expect(events.some((e) => e.type === "finish")).toBe(false);
			expect(reported.mock.calls.map(([code]) => code)).not.toContain(
				"agent.turn.failed",
			);
		} finally {
			reported.mockRestore();
		}
		expect(await held()).toEqual([]);
		const next = await run(turn("thread-stopped"));
		expect(next.at(-1)).toMatchObject({ type: "finish", reason: "stop" });
		const input = factory.fake().turns().at(-1)?.input ?? [];
		expect(input.filter((i) => i.type === "reasoning")).toEqual([]);
	},
);

t(
	"a caller gone before the run began ends it without asking the model for a word",
	async () => {
		const gone = new AbortController();
		gone.abort();
		const before = factory.turns();
		const events = await run(turn("thread-gone", { abortSignal: gone.signal }));
		expect(events.some((e) => e.type === "text")).toBe(false);
		expect(factory.turns()).toBe(before);
	},
);

/** The stores as they are, with one container's method failing while `failing` says so. */
function withStore(
	container: string,
	method: string,
	failing: () => boolean,
): () => void {
	const real = cosmosDatabase();
	setCosmosDatabase({
		verify: (d) => real.verify(d),
		container: (name) =>
			new Proxy(real.container(name), {
				get(target, field) {
					const value = Reflect.get(target, field);
					if (name !== container || field !== method)
						return typeof value === "function" ? value.bind(target) : value;
					return async (...args: unknown[]) => {
						if (failing()) throw new Error("the account is throttled");
						return (value as (...a: unknown[]) => unknown).apply(target, args);
					};
				},
			}),
	});
	return () => setCosmosDatabase(real);
}

t(
	"an answer whose exchange could not be written ends in an error with nothing kept, and the same turn sent again is kept once",
	async () => {
		const input = turn("thread-unkept");
		let refused = true;
		const restore = withStore("messages", "batch", () => refused);
		const reported = spyOn(problems, "report");
		const quiet = spyOn(console, "error").mockImplementation(() => {});
		try {
			const events = await run(input);
			expect(events.at(-1)).toEqual({ type: "error", code: "turn.failed" });
			expect(events.some((e) => e.type === "finish")).toBe(false);
			expect(reported.mock.calls).toContainEqual([
				"agent.turn.failed",
				{ reason: "settle" },
			]);
			expect(
				(await held()).filter((h) => h.startsWith("thread-unkept:")),
			).toEqual([]);
			refused = false;
			// The claim went back with the error: the retry carries the same message id.
			const again = await run(input);
			expect(again.at(-1)).toMatchObject({ type: "finish" });
		} finally {
			restore();
			reported.mockRestore();
			quiet.mockRestore();
		}
		expect((await host.readThread(me, "thread-unkept"))?.messages).toHaveLength(
			2,
		);
	},
);

t(
	"an exchange that was written stands when what follows the write fails: the turn finishes, and nothing is there twice",
	async () => {
		const input = turn("thread-moved");
		// The thread's document exists once the first turn has run: only its later moves fail.
		await run(turn("thread-moved"));
		let refused = true;
		const restore = withStore("threads", "patch", () => refused);
		const quiet = spyOn(console, "error").mockImplementation(() => {});
		try {
			const events = await run(input);
			expect(events.at(-1)).toMatchObject({ type: "finish" });
			expect(events.some((e) => e.type === "error")).toBe(false);
		} finally {
			refused = false;
			restore();
			quiet.mockRestore();
		}
		// Two exchanges, each once: a turn told it failed would have been sent again and kept twice.
		expect((await host.readThread(me, "thread-moved"))?.messages).toHaveLength(
			4,
		);
	},
);

t(
	"a write past one batch that fails part way leaves none of it behind",
	async () => {
		const { appendHistory } = await import("./history");
		const writes = Array.from({ length: 150 }, (_, i) => ({
			item: {
				type: "message" as const,
				role: "user" as const,
				content: `line ${i}`,
			},
		}));
		let batches = 0;
		const restore = withStore("messages", "batch", () => ++batches === 2);
		const quiet = spyOn(console, "error").mockImplementation(() => {});
		try {
			await expect(appendHistory(me, "thread-long", writes)).rejects.toThrow(
				"throttled",
			);
		} finally {
			restore();
			quiet.mockRestore();
		}
		expect(batches).toBe(2);
		expect((await held()).filter((h) => h.startsWith("thread-long:"))).toEqual(
			[],
		);
	},
);

t(
	"a write larger than one batch may carry goes in several, each within the service's bound, and all of it is kept",
	async () => {
		const { appendHistory } = await import("./history");
		// Five tool outputs of half a megabyte: one batch could not carry them.
		const writes = Array.from({ length: 5 }, (_, i) => ({
			item: {
				type: "function_call_output" as const,
				call_id: `call_big_${i}`,
				output: String(i).repeat(500 * 1024),
			},
		}));
		let batches = 0;
		const restore = withStore("messages", "batch", () => {
			batches++;
			return false;
		});
		try {
			await appendHistory(me, "thread-heavy", writes);
		} finally {
			restore();
		}
		expect(batches).toBe(2);
		expect(
			(await held()).filter((h) => h.startsWith("thread-heavy:")),
		).toHaveLength(5);
	},
	30_000,
);

t(
	"an item no batch can hold is refused by name before anything is written",
	async () => {
		const { appendHistory, HistoryItemTooLarge } = await import("./history");
		let batches = 0;
		const restore = withStore("messages", "batch", () => {
			batches++;
			return false;
		});
		try {
			await expect(
				appendHistory(me, "thread-huge", [
					{ item: { type: "message", role: "user", content: "before it" } },
					{
						item: {
							type: "function_call_output",
							call_id: "call_huge",
							output: "x".repeat(2 * 1024 * 1024),
						},
					},
				]),
			).rejects.toBeInstanceOf(HistoryItemTooLarge);
		} finally {
			restore();
		}
		expect(batches).toBe(0);
		expect((await held()).filter((h) => h.startsWith("thread-huge:"))).toEqual(
			[],
		);
	},
);

t(
	"two writes on one thread in the same millisecond both stand: the later is asked again under later ids, and the earlier one's documents are never taken out",
	async () => {
		const { appendHistory } = await import("./history");
		const said = async (threadId: string) =>
			(
				await cosmosDatabase().container("messages").query<{
					id: string;
					threadId: string;
					seq: number;
					item: { content?: unknown };
				}>({ query: "SELECT * FROM c" }, me)
			)
				.filter((d) => d.threadId === threadId)
				.sort((a, b) => a.seq - b.seq)
				.map((d) => d.item.content);
		const instant = Date.now();
		setSystemTime(new Date(instant));
		try {
			await appendHistory(me, "thread-same-instant", [
				{ item: { type: "message", role: "user", content: "the first" } },
				{ item: { type: "message", role: "assistant", content: "its answer" } },
			]);
			await appendHistory(me, "thread-same-instant", [
				{ item: { type: "message", role: "user", content: "the second" } },
			]);
			expect(await said("thread-same-instant")).toEqual([
				"the first",
				"its answer",
				"the second",
			]);

			// Every id a write would be asked again under is taken: it fails, and what is there stays whole.
			for (const step of [0, 1, 2])
				await cosmosDatabase()
					.container("messages")
					.create({
						id: `thread-taken.${instant * 1000 + step * 1000}`,
						resourceId: me,
						threadId: "thread-taken",
						seq: instant * 1000 + step * 1000,
						at: new Date(instant).toISOString(),
						item: { type: "message", role: "user", content: `held ${step}` },
					});
			await expect(
				appendHistory(me, "thread-taken", [
					{ item: { type: "message", role: "user", content: "refused" } },
				]),
			).rejects.toMatchObject({ statusCode: 409 });
			expect(await said("thread-taken")).toEqual([
				"held 0",
				"held 1",
				"held 2",
			]);
		} finally {
			setSystemTime();
		}
	},
);

t(
	"a batch the store took and then failed to answer for is taken out again with the rest",
	async () => {
		const { appendHistory } = await import("./history");
		const real = cosmosDatabase();
		setCosmosDatabase({
			verify: (d) => real.verify(d),
			container: (name) =>
				new Proxy(real.container(name), {
					get(target, field) {
						const value = Reflect.get(target, field);
						if (name !== "messages" || field !== "batch")
							return typeof value === "function" ? value.bind(target) : value;
						return async (...args: unknown[]) => {
							// Written, and the answer lost on the way back.
							await (value as (...a: unknown[]) => unknown).apply(target, args);
							throw new Error("the answer timed out");
						};
					},
				}),
		});
		const quiet = spyOn(console, "error").mockImplementation(() => {});
		try {
			await expect(
				appendHistory(me, "thread-unanswered", [
					{ item: { type: "message", role: "user", content: "said once" } },
				]),
			).rejects.toThrow("the answer timed out");
		} finally {
			setCosmosDatabase(real);
			quiet.mockRestore();
		}
		expect(
			(await held()).filter((h) => h.startsWith("thread-unanswered:")),
		).toEqual([]);
	},
);

t(
	"a delete under another person's name ends nothing: their turn on that thread id finishes untouched, here and on another replica",
	async () => {
		const { resourceId: stranger } = await factory.person();
		const elsewhere = createFoundryAgentHost(product);
		try {
			for (const on of [host, elsewhere]) {
				factory.script(SLOW);
				let deleted = true;
				const events = await run(
					turn("thread-theirs"),
					async () => {
						// The stranger names this person's thread: asked of the replica the turn is not on, too.
						deleted = await (on === host ? elsewhere : host).deleteThread(
							stranger,
							"thread-theirs",
						);
						expect(await on.deleteThread(stranger, "thread-theirs")).toBe(
							false,
						);
					},
					on,
				);
				expect(deleted).toBe(false);
				expect(events.at(-1)).toMatchObject({ type: "finish", reason: "stop" });
				expect(events.some((e) => e.type === "error")).toBe(false);
			}
			expect(
				(await host.readThread(me, "thread-theirs"))?.messages,
			).toHaveLength(4);
		} finally {
			await elsewhere.stop();
		}
	},
);

t(
	"an end asked for under another person reaches no turn of this one's, past the ownership read: the turns a thread's end stops are its person's alone",
	async () => {
		const { resourceId: stranger } = await factory.person();
		const elsewhere = createFoundryAgentHost(product);
		/** The step a delete takes after it has read the caller's thread, asked for directly. */
		const endTurns = (on: FoundryAgentHost, threadId?: string) =>
			(
				on as unknown as {
					endTurns(resourceId: string, threadId?: string): Promise<void>;
				}
			).endTurns(stranger, threadId);
		try {
			for (const on of [host, elsewhere]) {
				factory.script(SLOW);
				const events = await run(
					turn("thread-keyed"),
					async () => {
						// The stranger's end names this person's thread, then every thread: on the turn's replica and on the other.
						for (const from of [host, elsewhere]) {
							await endTurns(from, "thread-keyed");
							await endTurns(from);
						}
					},
					on,
				);
				expect(events.at(-1)).toMatchObject({ type: "finish", reason: "stop" });
				expect(events.some((e) => e.type === "error")).toBe(false);
			}
			expect(
				(await host.readThread(me, "thread-keyed"))?.messages,
			).toHaveLength(4);
		} finally {
			await elsewhere.stop();
		}
	},
);

t(
	"a thread deleted, or its person erased, while a turn on it is still being put together is left with no message",
	async () => {
		const real = host.versions.ensure.bind(host.versions);
		for (const end of ["delete", "erase"] as const) {
			const { resourceId: who } = await factory.person();
			const threadId = `thread-early-${end}`;
			let ended: Promise<unknown> = Promise.resolve();
			// The version is slow to be found: the thread is open and the turn is not streaming yet.
			const slow = spyOn(host.versions, "ensure").mockImplementationOnce(
				async (definition) => {
					ended =
						end === "delete"
							? host.deleteThread(who, threadId)
							: host.eraseResource(who);
					await Bun.sleep(100);
					return real(definition);
				},
			);
			const before = factory.turns();
			try {
				const events = await run(
					turn(threadId, {
						resourceId: who,
						caller: { oid: who, groups: [], tier: "base" },
					}),
				);
				await ended;
				expect(events.at(-1)).toEqual({ type: "error", code: "turn.failed" });
				// Ended before it began: the model was asked nothing.
				expect(factory.turns()).toBe(before);
			} finally {
				slow.mockRestore();
			}
			expect(await held(who)).toEqual([]);
			expect(await host.readThread(who, threadId)).toBeNull();
		}
	},
	20_000,
);

t(
	"an erase that runs before a turn's thread is there to be found leaves neither the thread nor a message of it",
	async () => {
		const { resourceId: who } = await factory.person();
		const real = host.history.forNew.bind(host.history);
		let erased: Promise<unknown> = Promise.resolve();
		// The store for a new thread is slow to be chosen: the turn is counted and has opened nothing yet.
		const slow = spyOn(host.history, "forNew").mockImplementationOnce(
			async () => {
				erased = host.eraseResource(who);
				await Bun.sleep(100);
				return real();
			},
		);
		const before = factory.turns();
		try {
			const events = await run(
				turn("thread-unopened", {
					resourceId: who,
					caller: { oid: who, groups: [], tier: "base" },
				}),
			);
			await erased;
			expect(events.at(-1)).toEqual({ type: "error", code: "turn.failed" });
			expect(factory.turns()).toBe(before);
		} finally {
			slow.mockRestore();
		}
		expect(await held(who)).toEqual([]);
		expect(await host.readThread(who, "thread-unopened")).toBeNull();
		expect((await host.listThreads(who)).threads).toEqual([]);
	},
	20_000,
);

t(
	"a turn that opens its thread after an erase gave up waiting for it takes the thread out again itself",
	async () => {
		const { resourceId: who } = await factory.person();
		const real = host.history.forNew.bind(host.history);
		let erased: Promise<unknown> = Promise.resolve();
		// Slower than the erase's wait: the erase is over before the thread exists.
		const slow = spyOn(host.history, "forNew").mockImplementationOnce(
			async () => {
				erased = host.eraseResource(who);
				await erased;
				return real();
			},
		);
		const quiet = spyOn(console, "warn").mockImplementation(() => {});
		try {
			const events = await run(
				turn("thread-late", {
					resourceId: who,
					caller: { oid: who, groups: [], tier: "base" },
				}),
			);
			expect(events.at(-1)).toEqual({ type: "error", code: "turn.failed" });
		} finally {
			slow.mockRestore();
			quiet.mockRestore();
		}
		expect(await held(who)).toEqual([]);
		expect((await host.listThreads(who)).threads).toEqual([]);
	},
	20_000,
);

t(
	"a turn that opens its thread after an erase gave up waiting, and then fails before it streams, leaves no thread either",
	async () => {
		const { resourceId: who } = await factory.person();
		const real = host.history.forNew.bind(host.history);
		// Slower than the erase's wait, and then the version cannot be found: the turn never streams.
		const slow = spyOn(host.history, "forNew").mockImplementationOnce(
			async () => {
				await host.eraseResource(who);
				return real();
			},
		);
		const broken = spyOn(host.versions, "ensure").mockImplementationOnce(
			async () => {
				throw new Error("no version to be had");
			},
		);
		const quiet = spyOn(console, "warn").mockImplementation(() => {});
		try {
			await expect(
				host.startTurn(
					turn("thread-late-throw", {
						resourceId: who,
						caller: { oid: who, groups: [], tier: "base" },
					}),
				),
			).rejects.toThrow("no version to be had");
		} finally {
			slow.mockRestore();
			broken.mockRestore();
			quiet.mockRestore();
		}
		expect(await held(who)).toEqual([]);
		expect(await host.readThread(who, "thread-late-throw")).toBeNull();
		expect((await host.listThreads(who)).threads).toEqual([]);
	},
	20_000,
);

t(
	"a thread whose delete answered that it is gone is not made again by the turn the delete gave up waiting for",
	async () => {
		const { resourceId: who } = await factory.person();
		const input = (id = crypto.randomUUID()) =>
			turn("thread-back", {
				resourceId: who,
				caller: { oid: who, groups: [], tier: "base" },
				messages: [{ id, role: "user", content: "Where is the atlas?" }],
			});
		await run(input());
		expect(await host.readThread(who, "thread-back")).not.toBeNull();
		// The next turn is slow to read its thread: the delete waits its bound out, removes the thread and answers.
		const opening = host as unknown as {
			threadFor(...args: unknown[]): Promise<unknown>;
		};
		const real = opening.threadFor.bind(host);
		let deleted = false;
		const slow = spyOn(opening, "threadFor").mockImplementationOnce(
			async (...args: unknown[]) => {
				deleted = await host.deleteThread(who, "thread-back");
				return real(...args);
			},
		);
		const quiet = spyOn(console, "warn").mockImplementation(() => {});
		try {
			const events = await run(input());
			expect(events.at(-1)).toEqual({ type: "error", code: "turn.failed" });
		} finally {
			slow.mockRestore();
			quiet.mockRestore();
		}
		expect(deleted).toBe(true);
		expect(await host.readThread(who, "thread-back")).toBeNull();
		expect((await host.listThreads(who)).threads).toEqual([]);
		expect(await held(who)).toEqual([]);
	},
	20_000,
);

t(
	"a thread deleted while one of a response's tools runs has no further tool run as the person, and the delete waits for the turn no longer than its bound",
	async () => {
		factory.script(
			{
				calls: [
					{ id: "call_one", name: "steps", args: {} },
					{ id: "call_two", name: "steps", args: {} },
				],
			},
			SLOW,
		);
		stepped = 0;
		let deleted: Promise<boolean> = Promise.resolve(false);
		let waited = 0;
		// The first call deletes the thread and then outlasts the delete's wait, deaf to the turn's signal.
		stepping = async () => {
			stepping = undefined;
			const began = Date.now();
			deleted = host.deleteThread(me, "thread-tools").then((gone) => {
				waited = Date.now() - began;
				return gone;
			});
			await Bun.sleep(6_500);
		};
		try {
			const events = await run(turn("thread-tools"));
			expect(await deleted).toBe(true);
			expect(waited).toBeGreaterThanOrEqual(4_500);
			expect(waited).toBeLessThan(6_400);
			expect(stepped).toBe(1);
			expect(events.at(-1)).toMatchObject({ type: "error" });
		} finally {
			stepping = undefined;
		}
		expect((await held()).filter((h) => h.startsWith("thread-tools:"))).toEqual(
			[],
		);
		expect(await host.readThread(me, "thread-tools")).toBeNull();
	},
	20_000,
);

t(
	"a thread deleted while a turn streams on it is left with no message: the turn is stopped and has settled before the delete reads",
	async () => {
		factory.script(
			{ calls: [{ id: "call_before", name: "steps", args: {} }] },
			SLOW,
		);
		let deleted = false;
		const events = await run(turn("thread-deleted"), async () => {
			deleted = await host.deleteThread(me, "thread-deleted");
		});
		expect(deleted).toBe(true);
		expect(events.some((e) => e.type === "finish")).toBe(false);
		expect(
			(await held()).filter((h) => h.startsWith("thread-deleted:")),
		).toEqual([]);
		expect(await host.readThread(me, "thread-deleted")).toBeNull();
	},
);

t(
	"a thread deleted on one replica while another streams a turn on it is left with no message, and the next turn on that replica is untouched",
	async () => {
		// A second host on the same stores and the same Redis: another replica.
		const elsewhere = createFoundryAgentHost(product);
		try {
			factory.script(
				{ calls: [{ id: "call_far", name: "steps", args: {} }] },
				SLOW,
			);
			let deleted = false;
			const events = await run(
				turn("thread-far"),
				async () => {
					deleted = await host.deleteThread(me, "thread-far");
				},
				elsewhere,
			);
			expect(deleted).toBe(true);
			expect(events.some((e) => e.type === "finish")).toBe(false);
			expect(events.at(-1)).toMatchObject({ type: "error" });
			expect((await held()).filter((h) => h.startsWith("thread-far:"))).toEqual(
				[],
			);
			expect(await host.readThread(me, "thread-far")).toBeNull();
			// The note was the turn's: the same id answers again.
			const next = await run(turn("thread-far"), undefined, elsewhere);
			expect(next.at(-1)).toMatchObject({ type: "finish", reason: "stop" });
			await host.deleteThread(me, "thread-far");
		} finally {
			await elsewhere.stop();
		}
	},
);

t(
	"an erase on one replica while another streams the person's turn leaves none of their messages",
	async () => {
		const elsewhere = createFoundryAgentHost(product);
		const { resourceId: them } = await factory.person();
		try {
			factory.script(
				{ calls: [{ id: "call_gone", name: "steps", args: {} }] },
				SLOW,
			);
			const events = await run(
				turn("thread-erased", {
					resourceId: them,
					caller: { oid: them, groups: [], tier: "base" },
				}),
				async () => {
					await host.eraseResource(them);
				},
				elsewhere,
			);
			expect(events.some((e) => e.type === "finish")).toBe(false);
			expect(await held(them)).toEqual([]);
			expect(await host.readThread(them, "thread-erased")).toBeNull();
		} finally {
			await elsewhere.stop();
		}
	},
);

t(
	"a stop ends the turns it finds streaming and is over only once they are",
	async () => {
		const elsewhere = createFoundryAgentHost(product);
		factory.script(SLOW);
		let left = -1;
		let stopped: Promise<void> = Promise.resolve();
		const events = await run(
			turn("thread-stopping"),
			() => {
				stopped = elsewhere.stop().then(() => {
					left = (Reflect.get(elsewhere, "running") as Set<unknown>).size;
				});
			},
			elsewhere,
		);
		await stopped;
		expect(left).toBe(0);
		expect(events.some((e) => e.type === "finish")).toBe(false);
		await host.deleteThread(me, "thread-stopping");
	},
);

t("an erase reaches a message whose thread has no index entry", async () => {
	await run(turn("thread-kept"));
	// A cursor this store never handed out is no cursor: the newest page.
	const newest = await host.readThread(me, "thread-kept");
	expect(newest?.messages).toHaveLength(2);
	for (const before of ["", "not-a-cursor"])
		expect(
			(await host.readThread(me, "thread-kept", { before }))?.messages,
		).toEqual(newest?.messages);
	await cosmosDatabase()
		.container("messages")
		.create({
			id: "thread-orphan.1",
			resourceId: me,
			threadId: "thread-orphan",
			seq: 1,
			at: new Date().toISOString(),
			item: {
				id: "thread-orphan.1",
				type: "message",
				role: "user",
				content: "Said to a thread already gone.",
			},
		});
	expect(await held()).toContain("thread-orphan:message");
	await host.eraseResource(me);
	expect(await held()).toEqual([]);
});

t(
	"the job's prune keeps the version it has just made current, however many came after it",
	async () => {
		const [first] = (await host.prime(["one"])).versions;
		for (const surface of ["two", "three", "four"]) await host.prime([surface]);
		const restore = factory.editAgent({ foundry: { keepVersions: 2 } });
		try {
			// The definition gone back to is found at its old number, past the newest kept.
			const back = await host.prime(["one"]);
			expect(back.versions).toEqual([first as string]);
			const left = (factory.fake().state.agents.get("ends") ?? []).map(
				(v) => v.version,
			);
			expect(left).toContain(first as string);
			expect(left).toHaveLength(3);
		} finally {
			restore();
		}
	},
);

t(
	"a turn the caller no longer admits once it is counted as running is refused in the caller's words and makes no thread",
	async () => {
		let askedWhileCounted = false;
		const outcome = await host.startTurn(
			turn("thread-unadmitted", {
				stillAdmitted: async () => {
					// Asked once the turn is counted: an erase now would find it.
					askedWhileCounted = true;
					return { status: 401, code: "account_erased" };
				},
			}),
		);
		expect(askedWhileCounted).toBe(true);
		expect(outcome).toEqual({
			kind: "refused",
			refusal: {
				code: "caller.refused",
				status: 401,
				reason: "account_erased",
			},
		});
		expect(
			(await host.listThreads(me)).threads.map((thread) => thread.id),
		).not.toContain("thread-unadmitted");
		expect(await held()).not.toContainEqual(
			expect.stringMatching(/^thread-unadmitted:/),
		);
	},
);

t(
	"an erase whose caller no longer holds it stops before its next step, and one whose cache cannot be dropped finishes all the same",
	async () => {
		const { resourceId: them } = await factory.person();
		await run(turn("thread-kept", { resourceId: them }));
		await expect(
			host.eraseResource(them, { stillHeld: async () => false }),
		).rejects.toThrow("no longer the caller's");
		expect((await host.listThreads(them)).threads.map((t) => t.id)).toEqual([
			"thread-kept",
		]);
		// A copy the drop did not reach, as a cache that stopped answering leaves one.
		const caches = (
			host as unknown as {
				caches: { person: { read(id: string): Promise<unknown> } };
			}
		).caches;
		const kept = spyOn(caches.person, "read").mockImplementation(async () => ({
			name: "still cached",
		}));
		const reported = spyOn(problems, "report");
		try {
			expect(await host.eraseResource(them)).toMatchObject({ threads: 1 });
			expect(reported).toHaveBeenCalledWith("agent.erase.incomplete", {
				reason: "cache_kept",
			});
		} finally {
			kept.mockRestore();
			reported.mockRestore();
		}
		expect((await host.listThreads(them)).threads).toEqual([]);
	},
);
