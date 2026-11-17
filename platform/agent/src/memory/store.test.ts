import { afterAll, beforeAll, beforeEach, expect, spyOn, test } from "bun:test";
import { fakeConfigStore } from "@platform/config/testing";
import { cosmosDatabase, setCosmosDatabase } from "@platform/cosmos";
import { openTestCosmos, type TestCosmos } from "@platform/cosmos/testing";
import { configure, recordRequests } from "@platform/llm/testing";
import { closeRedis } from "@platform/redis";
import { sweepNamespace, throwawayNamespace } from "@platform/redis/testing";
import { scopedEnv } from "@platform/test-support";
import { DEFAULT_MEMORY_DETAILS } from "../contract/product";
import {
	appendHistory,
	historyContainer,
	historyNewestFirst,
} from "../foundry/history";
import { agentKeys, problems } from "../keys";
import { personCaches } from "../person/caches";
import { resetAgentSettings } from "../settings";
import { standInExtractor } from "../testing/stand-in-extractor";
import { type MemoryStore, memoryContainer, memoryStore } from "./store";

/**
 * The store on its own: the facts a thread's messages leave, how the person
 * reads, corrects and removes them, and the forget that an extraction still
 * pending cannot write back after. The model is stood in for at the provider
 * fetch; the waits run on Redis where there is one and in the process
 * otherwise, and the suite holds either to the same answers.
 */

const namespace = throwawayNamespace();
const agent: Record<string, unknown> = { memory: { updateDelaySeconds: 0 } };
const extractor = standInExtractor((messages) =>
	messages
		.filter((m) => m.startsWith("user: "))
		.map((m) => m.slice("user: ".length)),
);
let cosmos: TestCosmos;
let store: MemoryStore;
let restores: (() => void)[] = [];
let who = "";
let thread = "";

const everything = () =>
	cosmosDatabase().container("memory").query({ query: "SELECT * FROM c" }, who);
/** The facts held, without the floor a forget or a removal leaves. */
const held = async () =>
	(await everything()).filter((doc) => doc.id !== "floor");

async function said(...lines: string[]) {
	// The history names a write by its millisecond: two in one are one write's.
	await Bun.sleep(2);
	await appendHistory(
		who,
		thread,
		lines.map((content, i) => ({
			item: {
				type: "message",
				role: i % 2 === 0 ? "user" : "assistant",
				content,
			},
		})),
	);
}

async function remembered(): Promise<string[]> {
	return (await store.read(who)).items.map((i) => i.content);
}

beforeAll(async () => {
	cosmos = await openTestCosmos([historyContainer, memoryContainer]);
	restores = [
		scopedEnv({ AGENT_KEY_PREFIX: namespace.prefix }),
		configure({
			AZURE_OPENAI_RESOURCE_NAME: "account",
			AZURE_OPENAI_CHAT_DEPLOYMENT: "chat",
			AZURE_OPENAI_SMALL_CHAT_DEPLOYMENT: "small",
		}),
		fakeConfigStore({ agent }),
		resetAgentSettings,
	];
	resetAgentSettings();
	recordRequests(
		async ({ request }) =>
			(await extractor.fetch(request)) ??
			Response.json(
				{ error: { message: "nothing stands in" } },
				{ status: 404 },
			),
	);
	const keys = agentKeys("memory-test");
	store = memoryStore({
		cache: personCaches(keys.memo).memory,
		keys,
		details: DEFAULT_MEMORY_DETAILS,
		// The own history, read as the host reads a thread on it.
		history: async (resourceId, threadId, limit, after) =>
			(await historyNewestFirst(resourceId, threadId, { limit }))
				.filter((document) => !after || document.at > after)
				.map((document) => document.item),
	});
});

beforeEach(() => {
	who = `person-${crypto.randomUUID().slice(0, 8)}`;
	thread = `thread-${crypto.randomUUID().slice(0, 8)}`;
	agent.memory = { updateDelaySeconds: 0 };
	resetAgentSettings();
	extractor.waitFor(null);
});

afterAll(async () => {
	store.stop();
	await cosmos.drop();
	for (const restore of restores.reverse()) restore();
	await sweepNamespace(namespace);
	await closeRedis();
});

test("a turn's thread leaves its facts, newest first; the next extraction keeps a fact's id, drops what it left out and adds what it found", async () => {
	expect(await store.read(who)).toEqual({ items: [] });
	await said("Call me Ada.", "Hello Ada.");
	await store.handOver(who, thread, []);
	await store.flush();
	const [ada] = (await store.read(who)).items;
	expect(ada).toMatchObject({ content: "Call me Ada." });
	expect(Number.isNaN(Date.parse(ada?.updatedAt ?? ""))).toBe(false);
	expect(extractor.handed.at(-1)).toBe(
		"user: Call me Ada.\nassistant: Hello Ada.",
	);

	// The extractor is handed what is kept and answers the whole list: here it keeps one of two and adds one.
	extractor.extract(() => ["I restore old maps.", "Call me Ada."]);
	await said("I restore old maps.", "Noted.");
	await store.handOver(who, thread, []);
	await store.flush();
	const items = (await store.read(who)).items;
	expect(items.map((i) => i.content)).toEqual([
		"I restore old maps.",
		"Call me Ada.",
	]);
	expect(items.find((i) => i.content === "Call me Ada.")?.id).toBe(ada?.id);
	// An answer of no facts at all is not taken for the person's wish: what is kept stays.
	extractor.extract(() => []);
	await store.handOver(who, thread, []);
	await store.flush();
	expect(await remembered()).toEqual(["I restore old maps.", "Call me Ada."]);
	extractor.extract((messages) =>
		messages
			.filter((m) => m.startsWith("user: "))
			.map((m) => m.slice("user: ".length)),
	);
});

test("a thread with nothing said, or an answer that is not a list, leaves what is kept as it was", async () => {
	await store.handOver(who, "thread-empty", []);
	await store.flush();
	expect(await held()).toEqual([]);
	await said("Call me Ada.");
	await store.handOver(who, thread, []);
	await store.flush();
	extractor.extract(() => {
		throw new Error("not this time");
	});
	await said("And forget the rest.");
	await store.handOver(who, thread, []);
	await store.flush();
	expect(await remembered()).toEqual(["Call me Ada."]);
	extractor.extract((messages) =>
		messages
			.filter((m) => m.startsWith("user: "))
			.map((m) => m.slice("user: ".length)),
	);
});

test("the person corrects a fact capped at the bound, blank removes it, and another person's partition reaches none of it", async () => {
	await said("Call me Ada.");
	await store.handOver(who, thread, []);
	await store.flush();
	const [item] = (await store.read(who)).items;
	const id = item?.id ?? "-";
	expect(await store.update("somebody-else", id, "mine now")).toBeNull();
	expect(await store.remove("somebody-else", id)).toBe(false);
	const long = "x".repeat(2000);
	const capped = await store.update(who, id, `  ${long}`);
	expect(capped?.content).toBe("x".repeat(500));
	expect(await store.statements(who)).toEqual(["x".repeat(500)]);
	expect(await store.update(who, id, " \n")).toBeNull();
	expect(await remembered()).toEqual([]);
	expect(await store.remove(who, id)).toBe(false);
	expect(await store.update(who, id, "gone")).toBeNull();
});

test("statements are cached only once there is something to cache, and a correction is read on the next turn", async () => {
	expect(await store.statements(who)).toEqual([]);
	await said("Call me Ada.");
	await store.handOver(who, thread, []);
	await store.flush();
	expect(await store.statements(who)).toEqual(["Call me Ada."]);
	const [item] = (await store.read(who)).items;
	await store.update(who, item?.id ?? "-", "Goes by Ada.");
	expect(await store.statements(who)).toEqual(["Goes by Ada."]);
	expect(await store.remove(who, item?.id ?? "-")).toBe(true);
	expect(await store.statements(who)).toEqual([]);
});

test("forgetting says whether there was anything, and drops a wait still pending", async () => {
	expect(await store.forget(who)).toBe(false);
	agent.memory = { updateDelaySeconds: 30 };
	resetAgentSettings();
	await said("My favourite colour is teal.");
	await store.handOver(who, thread, []);
	expect(await store.forget(who)).toBe(false);
	// The wait went with the forget: running everything due extracts nothing of it.
	await store.flush();
	expect(await held()).toEqual([]);
	// Only what is said after the forget is read: the wait runs when flushed.
	await said("I prefer short answers.");
	await store.handOver(who, thread, []);
	expect(await remembered()).toEqual([]);
	await store.flush();
	expect(await remembered()).toEqual(["I prefer short answers."]);
	expect(extractor.handed.at(-1)).toBe("user: I prefer short answers.");
	expect(await store.forget(who)).toBe(true);
	expect(await store.forget(who)).toBe(false);
	expect(await store.statements(who)).toEqual([]);
});

test("an extraction in flight when the person forgets writes nothing back", async () => {
	let release = () => {};
	extractor.waitFor(new Promise<void>((r) => (release = r)));
	await said("I live by the sea.");
	await store.handOver(who, thread, []);
	expect(await store.forget(who)).toBe(false);
	release();
	await store.flush();
	expect(await held()).toEqual([]);
	expect(await store.statements(who)).toEqual([]);
	// An extraction begun after the forget reads nothing said before it, and writes what was said since.
	extractor.waitFor(null);
	await store.handOver(who, thread, []);
	await store.flush();
	expect(await remembered()).toEqual([]);
	await said("I keep bees.");
	await store.handOver(who, thread, []);
	await store.flush();
	expect(await remembered()).toEqual(["I keep bees."]);
});

test("a removed fact is not learned again from the words that taught it", async () => {
	await said("I live by the sea.", "Lovely.");
	await said("I keep bees.", "Noted.");
	await store.handOver(who, thread, []);
	await store.flush();
	const sea = (await store.read(who)).items.find(
		(item) => item.content === "I live by the sea.",
	);
	expect(await store.remove(who, sea?.id ?? "-")).toBe(true);
	expect(await store.remove(who, "floor")).toBe(false);
	expect(await store.update(who, "floor", "a fact now")).toBeNull();
	// As the model is asked to: what is kept stays, and what the person says is added.
	extractor.extract((messages, kept) => [
		...kept,
		...messages
			.filter((m) => m.startsWith("user: "))
			.map((m) => m.slice("user: ".length)),
	]);
	await said("I restore old maps.", "Noted.");
	await store.handOver(who, thread, []);
	await store.flush();
	expect(extractor.handed.at(-1)).toBe(
		"user: I restore old maps.\nassistant: Noted.",
	);
	extractor.extract((messages) =>
		messages
			.filter((m) => m.startsWith("user: "))
			.map((m) => m.slice("user: ".length)),
	);
	// The fact that was not removed stays; the removed one stays gone.
	expect((await remembered()).sort()).toEqual([
		"I keep bees.",
		"I restore old maps.",
	]);
});

test("a fact removed while an extraction is in flight is not written back, and one corrected meanwhile is not deleted", async () => {
	await said("Call me Ada.");
	await store.handOver(who, thread, []);
	await store.flush();
	const [ada] = (await store.read(who)).items;
	let release = () => {};
	extractor.waitFor(new Promise<void>((r) => (release = r)));
	// The answer drops what is kept: the correction below is the later word.
	extractor.extract(() => ["I keep bees."]);
	await said("I keep bees.");
	await store.handOver(who, thread, []);
	await Bun.sleep(20);
	await store.update(who, ada?.id ?? "-", "Goes by Ada.");
	release();
	await store.flush();
	expect((await remembered()).sort()).toEqual(["Goes by Ada.", "I keep bees."]);

	// A removal during the call: the list was answered from before it, and nothing of it is written.
	const bees = (await store.read(who)).items.find(
		(item) => item.content === "I keep bees.",
	);
	extractor.waitFor(new Promise<void>((r) => (release = r)));
	extractor.extract(() => ["Goes by Ada.", "I keep bees.", "I sail."]);
	await said("I sail.");
	await store.handOver(who, thread, []);
	await Bun.sleep(20);
	expect(await store.remove(who, bees?.id ?? "-")).toBe(true);
	release();
	await store.flush();
	expect(await remembered()).toEqual(["Goes by Ada."]);
	extractor.waitFor(null);
	extractor.extract((messages) =>
		messages
			.filter((m) => m.startsWith("user: "))
			.map((m) => m.slice("user: ".length)),
	);
});

const asUsers = (messages: string[]) =>
	messages
		.filter((m) => m.startsWith("user: "))
		.map((m) => m.slice("user: ".length));

/** The database, with `before` awaited ahead of the memory container's delete of each fact, in the order they are asked. */
function deletesHeld(before: ((id: string) => Promise<void>)[]) {
	const database = cosmos.database;
	let asked = 0;
	setCosmosDatabase({
		...database,
		container(name) {
			const container = database.container(name);
			if (name !== "memory") return container;
			return new Proxy(container, {
				get(target, property, receiver) {
					const member = Reflect.get(target, property, receiver);
					if (property !== "delete" || typeof member !== "function")
						return member;
					return async (id: string, partition: string) => {
						await before[asked++]?.(id);
						return member.call(target, id, partition);
					};
				},
			});
		},
	});
	return () => setCosmosDatabase(database);
}

test("a fact the person removes while the answer is being made is not kept reworded, though the floor had moved before the extraction began", async () => {
	await said("I keep bees.");
	await store.handOver(who, thread, []);
	await store.flush();
	const [bees] = (await store.read(who)).items;
	// A removal part way: its floor is raised, naming the fact, and the extraction begins before its delete lands.
	await cosmosDatabase()
		.container("memory")
		.create({
			id: "floor",
			resourceId: who,
			at: new Date().toISOString(),
			removed: [bees?.id],
		});
	let release = () => {};
	extractor.waitFor(new Promise<void>((r) => (release = r)));
	// The answer holds the fact reworded, and one more.
	extractor.extract(() => ["Keeps bees.", "I sail."]);
	await said("I sail.");
	await store.handOver(who, thread, []);
	await Bun.sleep(20);
	// The delete lands while the model answers; the floor does not move again before the write.
	expect(
		await cosmosDatabase()
			.container("memory")
			.delete(bees?.id ?? "-", who),
	).toBe(true);
	release();
	await store.flush();
	expect(await remembered()).toEqual([]);
	extractor.waitFor(null);
	extractor.extract(asUsers);
});

test("a fact another extraction superseded while the answer was being made is not the person's removal: both answers stand, and nothing is lost with its rewording", async () => {
	await said("I keep bees.");
	await said("I like tea.");
	await store.handOver(who, thread, []);
	await store.flush();
	expect((await remembered()).sort()).toEqual(["I keep bees.", "I like tea."]);
	const bees = (await store.read(who)).items.find(
		(item) => item.content === "I keep bees.",
	);
	// This thread's extraction reads both facts and waits on the model.
	let release = () => {};
	extractor.waitFor(new Promise<void>((r) => (release = r)));
	extractor.extract(() => ["I like green tea.", "I sail."]);
	await said("I sail.");
	await store.handOver(who, thread, []);
	await Bun.sleep(20);
	// Meanwhile another thread's extraction rewords one of them: its delete and its own fact, the floor untouched.
	const memory = cosmosDatabase().container("memory");
	expect(await memory.delete(bees?.id ?? "-", who)).toBe(true);
	const now = new Date().toISOString();
	await memory.create({
		id: `fact_${crypto.randomUUID()}`,
		resourceId: who,
		text: "I keep bees in two hives.",
		createdAt: now,
		updatedAt: now,
	});
	release();
	await store.flush();
	expect((await remembered()).sort()).toEqual([
		"I keep bees in two hives.",
		"I like green tea.",
		"I sail.",
	]);
	extractor.waitFor(null);
	extractor.extract(asUsers);
});

test("a removal moves the floor again once its fact is gone: an extraction that read the fact beside another removal's writes nothing", async () => {
	await said("I keep bees.");
	await said("I like tea.");
	await store.handOver(who, thread, []);
	await store.flush();
	const items = (await store.read(who)).items;
	const bees = items.find((item) => item.content === "I keep bees.");
	const tea = items.find((item) => item.content === "I like tea.");
	let releaseModel = () => {};
	let releaseTea = () => {};
	const teaHeld = new Promise<void>((r) => (releaseTea = r));
	let second: Promise<boolean> = Promise.resolve(false);
	const restore = deletesHeld([
		// Before the first fact goes, the person removes a second, whose own
		// delete waits, and an extraction begins that reads both.
		async () => {
			second = store.remove(who, tea?.id ?? "-");
			for (let i = 0; i < 100; i++) {
				const floor = await cosmos.database
					.container("memory")
					.read<{ id: string; removed?: string[] }>("floor", who);
				if (floor?.removed?.includes(tea?.id ?? "-")) break;
				await Bun.sleep(5);
			}
			extractor.waitFor(new Promise<void>((r) => (releaseModel = r)));
			extractor.extract(() => ["Keeps bees.", "Likes tea.", "I sail."]);
			await said("I sail.");
			await store.handOver(who, thread, []);
			await Bun.sleep(20);
		},
		() => teaHeld,
	]);
	try {
		expect(await store.remove(who, bees?.id ?? "-")).toBe(true);
		// The first fact is gone and the floor names the second: only the move after the delete tells this extraction.
		releaseModel();
		await store.flush();
		expect(await remembered()).toEqual(["I like tea."]);
		releaseTea();
		expect(await second).toBe(true);
		expect(await remembered()).toEqual([]);
	} finally {
		releaseTea();
		restore();
		extractor.waitFor(null);
		extractor.extract(asUsers);
	}
});

test("two removals that overlap are both known as the person's: an extraction that read the first fact, whose removal has yet to move the floor again, keeps nothing reworded", async () => {
	await said("I keep bees.");
	await said("I like tea.");
	await store.handOver(who, thread, []);
	await store.flush();
	const items = (await store.read(who)).items;
	const bees = items.find((item) => item.content === "I keep bees.");
	const tea = items.find((item) => item.content === "I like tea.");
	let releaseModel = () => {};
	let releaseFloor = () => {};
	const floorHeld = new Promise<void>((r) => (releaseFloor = r));
	const database = cosmos.database;
	let deletes = 0;
	let holding = false;
	let waiting = false;
	setCosmosDatabase({
		...database,
		container(name) {
			const container = database.container(name);
			if (name !== "memory") return container;
			return new Proxy(container, {
				get(target, property, receiver) {
					const member = Reflect.get(target, property, receiver);
					if (typeof member !== "function") return member;
					if (property === "delete")
						return async (id: string, partition: string) => {
							// Before the first fact goes, the person removes a second, whole, and an extraction begins that reads the first.
							if (deletes++ === 0) {
								expect(await store.remove(who, tea?.id ?? "-")).toBe(true);
								extractor.waitFor(new Promise<void>((r) => (releaseModel = r)));
								extractor.extract(() => ["Keeps bees.", "I sail."]);
								await said("I sail.");
								const asked = extractor.handed.length;
								await store.handOver(who, thread, []);
								// Until the answer is being made: the extraction has read the fact by then.
								for (let i = 0; i < 400; i++) {
									if (extractor.handed.length > asked) break;
									await Bun.sleep(5);
								}
								holding = true;
							}
							return member.call(target, id, partition);
						};
					if (property === "patch")
						return async (id: string, ...rest: unknown[]) => {
							// The first removal's move after its delete waits out the extraction's write.
							if (id === "floor" && holding) {
								holding = false;
								waiting = true;
								await floorHeld;
							}
							return member.call(target, id, ...rest);
						};
					return member;
				},
			});
		},
	});
	try {
		const first = store.remove(who, bees?.id ?? "-");
		// Until the first removal's fact is gone and its second move of the floor is waiting.
		for (let i = 0; i < 400 && !waiting; i++) await Bun.sleep(5);
		expect(waiting).toBe(true);
		// The fact is gone and the floor has not moved since the extraction began: only its naming the first removal tells.
		releaseModel();
		await store.flush();
		expect(await remembered()).toEqual([]);
		releaseFloor();
		expect(await first).toBe(true);
		expect(await remembered()).toEqual([]);
	} finally {
		releaseFloor();
		setCosmosDatabase(database);
		extractor.waitFor(null);
		extractor.extract(asUsers);
	}
});

test("a forget moves the floor again once the facts are gone: an extraction that began as it deleted writes nothing back", async () => {
	await said("I keep bees.");
	await store.handOver(who, thread, []);
	await store.flush();
	let releaseModel = () => {};
	const restore = deletesHeld([
		// The forget has raised its floor; an extraction begins and reads the fact before it goes.
		async () => {
			extractor.waitFor(new Promise<void>((r) => (releaseModel = r)));
			extractor.extract(() => ["Keeps bees.", "I sail."]);
			await said("I sail.");
			await store.handOver(who, thread, []);
			await Bun.sleep(20);
		},
	]);
	try {
		expect(await store.forget(who)).toBe(true);
		releaseModel();
		await store.flush();
		expect(await remembered()).toEqual([]);
	} finally {
		restore();
		extractor.waitFor(null);
		extractor.extract(asUsers);
	}
});

test("an erased account keeps no floor, and an extraction in flight when it went writes nothing", async () => {
	let release = () => {};
	extractor.waitFor(new Promise<void>((r) => (release = r)));
	await said("I live by the sea.");
	await store.handOver(who, thread, []);
	await Bun.sleep(20);
	const reported = spyOn(problems, "report");
	const quiet = spyOn(console, "warn").mockImplementation(() => {});
	try {
		expect(await store.forget(who, { erasing: true })).toBe(false);
		release();
		await store.flush();
		expect(await everything()).toEqual([]);
		// An account made again under the id while the mark stands learns nothing yet, and that is said.
		extractor.waitFor(null);
		await said("I keep bees.");
		await store.handOver(who, thread, []);
		await store.flush();
		expect(await everything()).toEqual([]);
		expect(
			reported.mock.calls.filter(
				([code, detail]) =>
					code === "agent.memory.extraction_failed" &&
					(detail as { reason?: string }).reason === "erased",
			).length,
		).toBeGreaterThanOrEqual(1);
	} finally {
		reported.mockRestore();
		quiet.mockRestore();
	}
});
