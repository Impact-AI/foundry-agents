import { afterAll, beforeAll, expect, spyOn, test } from "bun:test";
import { setProviderFetch } from "@platform/llm";
import { problemChannel } from "@platform/observability";
import { REDIS_AVAILABLE } from "@platform/redis/testing";
import { scopedEnv } from "@platform/test-support";
import type { TurnEvent, TurnInput } from "../index";
import { type AgentProduct, WEB_SEARCH } from "../index";
import { resetFoundryClients } from "./client";
import type { FoundryAgentHost } from "./host";
import { ensureMemoryStore, type FoundryMemoryStore } from "./memory";
import type { FakeFoundry } from "./testing/fake-foundry";
import { foundryParityFactory, REMEMBERED } from "./testing/parity-factory";

/**
 * The host with memory on the Foundry store (`memory.store: "foundry"`,
 * the default), on the stand-in service: that the setting picks this
 * implementation, that a store which stops answering costs a turn its
 * deadline and not the turn, that the job makes the store once, and the
 * forget that `delete_scope` alone does not make final — an update still
 * waiting out its delay writes the forgotten words back, and the sweeper
 * deletes the scope again once the service says the update settled.
 * `host.test.ts` runs the same host on the own store.
 */

const product: AgentProduct = {
	agentId: "sample",
	serviceName: "sample-agent",
	toolKeys: [WEB_SEARCH],
	persona: async () => "# CORE IDENTITY\nYou are the {{sample}} assistant.",
	guardrails: () => "You decline anything outside the sample's scope.",
	behaviour: ({ surface }) => `On the ${surface} surface, answer in one line.`,
	tools: () => ({}),
	clientTools: [],
};

const factory = foundryParityFactory({ memory: "foundry" });
const RUN = REDIS_AVAILABLE;
const t = test.skipIf(!RUN);
let host: FoundryAgentHost;
let fake: FakeFoundry;
let memory: FoundryMemoryStore;

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
	who: string,
	threadId: string,
	content = "Where is the atlas?",
): TurnInput {
	return {
		resourceId: who,
		threadId,
		messages: [{ id: crypto.randomUUID(), role: "user", content }],
		surface: "web",
		languageName: "English",
		caller: { oid: who, groups: [], tier: "base" },
	};
}

const run = async (input: TurnInput) => drain(await host.startTurn(input));

/** What the fake's store holds for a person. */
const held = (who: string) =>
	[...fake.state.memories.values()]
		.filter((m) => m.scope === who)
		.map((m) => m.content);

beforeAll(async () => {
	if (!RUN) return;
	host = (await factory.create(product)) as FoundryAgentHost;
	fake = factory.fake();
	await host.start();
	memory = (await host.memory.selected()) as FoundryMemoryStore;
	factory.answer("On the second shelf.");
});

afterAll(async () => {
	if (!RUN) return;
	await host.stop();
	await factory.teardown();
});

t(
	"the default document names the Foundry store, and the host runs it: a turn's words reach the service's store and come back remembered",
	async () => {
		expect(memory.kind).toBe("foundry");
		expect(host.memory.kind).toBe("foundry");
		const { resourceId: who } = await factory.person();
		await run(turn(who, "thread-kind-1", "Call me Ada."));
		await factory.settled?.();
		expect(held(who)).toEqual([REMEMBERED]);
		expect((await host.readMemory(who)).items.map((i) => i.content)).toEqual([
			REMEMBERED,
		]);
		expect(
			factory.extractions().some((handed) => handed.includes("Call me Ada.")),
		).toBe(true);
		await host.eraseResource(who);
	},
);

t(
	"a memory store that stops answering costs a turn its deadline, not the turn",
	async () => {
		const undo = scopedEnv({ FOUNDRY_REQUEST_DEADLINE_MS: "100" });
		resetFoundryClients();
		// A request that is never answered, until whoever sent it gives up on it.
		setProviderFetch(async (input, init) => {
			const request = new Request(String(input), init);
			if (!request.url.includes("/memory_stores/")) return fake.fetch(request);
			return new Promise<Response>((_, reject) =>
				init?.signal?.addEventListener("abort", () =>
					reject(init.signal?.reason),
				),
			);
		});
		const quiet = spyOn(console, "error").mockImplementation(() => {});
		const { resourceId } = await factory.person();
		try {
			const events = await run(turn(resourceId, "thread-no-memory"));
			expect(events.at(-1)).toMatchObject({ type: "finish", reason: "stop" });
		} finally {
			quiet.mockRestore();
			fake.install();
			undo();
			resetFoundryClients();
		}
		await host.eraseResource(resourceId);
	},
);

t(
	"forgetting inside an update's delay is final: what the update writes back after the scope's delete is deleted, through what superseded it, and nothing reads it in between",
	async () => {
		const { resourceId: who } = await factory.person();
		const as = (content: string, threadId: string) =>
			turn(who, threadId, content);
		const undo = factory.editAgent({
			memory: { store: "foundry", updateDelaySeconds: 1 },
		});
		// Whatever the person said, kept word for word: so a statement says which turn it came from.
		fake.extract((messages) =>
			messages
				.filter((m) => m.startsWith("user: "))
				.map((m) => m.slice("user: ".length)),
		);
		try {
			await run(as("My favourite colour is teal.", "thread-race-1"));
			expect(held(who)).toEqual([]);
			expect(await host.forgetMemory(who)).toBe(false);

			// Said again after the forget and inside the delay: the waiting update is superseded, its words carried on.
			await run(as("I live by the sea.", "thread-race-2"));
			expect(factory.instructions()).not.toContain("teal");
			// The race the live store lost: the update extracts after the scope went, and writes the forgotten words back.
			await factory.settled?.();
			expect(held(who)).toEqual(
				expect.arrayContaining([
					"My favourite colour is teal.",
					"I live by the sea.",
				]),
			);
			// The sweeper finishes it, following the superseded update to the one that carried it on.
			expect(await memory.purger.sweep()).toBe(1);
			expect(held(who)).toEqual([]);
			expect(await host.readMemory(who)).toEqual({ items: [] });
			expect(await memory.purger.sweep()).toBe(0);

			// A read finishes it too, rather than show what was forgotten.
			await run(as("Call me Ada.", "thread-race-3"));
			expect(await host.forgetMemory(who)).toBe(false);
			await factory.settled?.();
			expect(held(who)).toEqual(["Call me Ada."]);
			expect(await host.readMemory(who)).toEqual({ items: [] });
			expect((await host.personalization(who, "written")).memory).toBeNull();
			expect(held(who)).toEqual([]);
			expect(await memory.purger.sweep()).toBe(1);

			// Once the forget is final, what is said is remembered again.
			await run(as("I prefer short answers.", "thread-race-4"));
			await factory.settled?.();
			expect((await host.readMemory(who)).items.map((i) => i.content)).toEqual([
				"I prefer short answers.",
			]);
			expect(await host.forgetMemory(who)).toBe(true);
			expect(await memory.purger.sweep()).toBe(0);
			expect(held(who)).toEqual([]);
		} finally {
			fake.extract(() => [REMEMBERED]);
			undo();
			await host.eraseResource(who);
		}
	},
);

t(
	"a forget waits on the service's word, not the clock: an update it cannot look up is waited for until the service answers",
	async () => {
		const { resourceId: who } = await factory.person();
		const undo = factory.editAgent({
			memory: { store: "foundry", updateDelaySeconds: 1 },
		});
		try {
			await run(turn(who, "thread-race-5", "Remember this."));
			const quiet = spyOn(console, "error").mockImplementation(() => {});
			fake.failWhen(
				(method, path) => method === "GET" && path.includes("/updates/"),
			);
			try {
				expect(await host.forgetMemory(who)).toBe(false);
				await factory.settled?.();
				expect(await host.readMemory(who)).toEqual({ items: [] });
				// The service still does not say the update settled: the sweep keeps waiting.
				expect(await memory.purger.sweep()).toBe(0);
			} finally {
				fake.failWhen(null);
				quiet.mockRestore();
			}
			expect(await memory.purger.sweep()).toBe(1);
			expect(held(who)).toEqual([]);
		} finally {
			undo();
			await host.eraseResource(who);
		}
	},
);

t(
	"an update the service never finishes is reported stalled once it is past its delay and grace — once — and a finished one passes in silence",
	async () => {
		const { resourceId: who } = await factory.person();
		const codes: unknown[] = [];
		problemChannel.setSink((line) =>
			codes.push(line.attributes["problem.code"]),
		);
		const quiet = spyOn(console, "error").mockImplementation(() => {});
		const pastGrace = () => Date.now() + 20 * 60 * 1000;
		try {
			// The fake extracts at once: looked up past its grace, the update has completed, and nothing is said.
			await run(turn(who, "thread-stall-1", "Call me Ada."));
			await factory.settled?.();
			expect(await memory.stalled(pastGrace())).toBe(0);
			expect(codes).toEqual([]);

			// The live store on a private deployment: the update is accepted and never leaves `in_progress`.
			await run(turn(who, "thread-stall-2", "I prefer short answers."));
			setProviderFetch(async (input, init) => {
				const request = new Request(String(input), init);
				if (request.method === "GET" && request.url.includes("/updates/"))
					return Response.json({ update_id: "x", status: "in_progress" });
				return fake.fetch(request);
			});
			// Not due: inside its delay and grace nothing is looked up.
			expect(await memory.stalled()).toBe(0);
			expect(codes).toEqual([]);
			expect(await memory.stalled(pastGrace())).toBe(1);
			expect(codes).toEqual(["agent.memory.extraction_stalled"]);
			expect(quiet).toHaveBeenCalledTimes(1);
			// Reported once: the sweep after finds nothing to say.
			expect(await memory.stalled(pastGrace())).toBe(0);
			expect(codes).toHaveLength(1);
		} finally {
			fake.install();
			problemChannel.setSink(null);
			quiet.mockRestore();
			await host.eraseResource(who);
		}
	},
);

t("the job's step is idempotent: the memory store is made once", async () => {
	expect(
		await ensureMemoryStore(product, { chat: "small", embedding: "embed" }),
	).toBe("exists");
	expect(fake.state.stores.get("person-memory")?.definition).toMatchObject({
		chat_model: "small",
		embedding_model: "embed",
	});
});
