import { afterAll, expect, test } from "bun:test";
import { cosmosDatabase } from "@platform/cosmos";
import { REDIS_AVAILABLE } from "@platform/redis/testing";
import { type AgentProduct, type TurnInput, WEB_SEARCH } from "../index";
import { createFoundryAgentHost } from "./host";
import { ensureMemoryStore } from "./memory";
import { foundryParityFactory, REMEMBERED } from "./testing/parity-factory";

/**
 * An account's erase and an operator's change of `memory.store`. Nothing
 * moves between the two stores at a change, so what the store no longer in
 * use remembered stays in it; the erase is held here to reaching it, in
 * both directions, and to standing where the other store was never made.
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

type Host = ReturnType<typeof createFoundryAgentHost>;

function turn(who: string, threadId: string, content: string): TurnInput {
	return {
		resourceId: who,
		threadId,
		messages: [{ id: crypto.randomUUID(), role: "user", content }],
		surface: "web",
		languageName: "English",
		caller: { oid: who, groups: [], tier: "base" },
	};
}

async function run(host: Host, input: TurnInput) {
	const outcome = await host.startTurn(input);
	expect(outcome.kind).toBe("started");
	if (outcome.kind !== "started") return;
	const reader = outcome.events.getReader();
	for (;;) {
		const { done } = await reader.read();
		if (done) return;
	}
}

/** Everything the own store's container holds under an account. */
const ownFacts = async (who: string) =>
	(
		await cosmosDatabase()
			.container("memory")
			.query<{ id: string; text?: string }>({ query: "SELECT * FROM c" }, who)
	).map((d) => d.text ?? `(${d.id})`);

const t = test.skipIf(!REDIS_AVAILABLE);
const teardowns: (() => Promise<void>)[] = [];
afterAll(async () => {
	for (const teardown of teardowns) await teardown();
});

t(
	"an erase after the store changed from the service's to the deployment's own empties the service's scope too",
	async () => {
		const factory = foundryParityFactory({ memory: "foundry" });
		teardowns.push(() => factory.teardown());
		const first = (await factory.create(product)) as Host;
		const fake = factory.fake();
		await first.start();
		factory.answer("On the second shelf.");
		const inScope = (who: string) =>
			[...fake.state.memories.values()]
				.filter((m) => m.scope === who)
				.map((m) => m.content);

		const { resourceId: who } = await factory.person();
		await run(first, turn(who, "thread-change-1", "Call me Ada."));
		await factory.settled?.();
		expect(inScope(who)).toEqual([REMEMBERED]);

		// The operator's change: an edit of the document, then a restart.
		await first.stop();
		factory.editAgent({ memory: { store: "own", updateDelaySeconds: 0 } });
		const second = createFoundryAgentHost(product);
		await second.start();
		expect((await second.memory.selected()).kind).toBe("own");

		const report = await second.eraseResource(who);
		expect(report.memories).toBe(true);
		expect(inScope(who)).toEqual([]);
		// And nothing is left for the same id, should the document be changed back.
		await second.stop();
		factory.editAgent({ memory: { store: "foundry", updateDelaySeconds: 0 } });
		const third = createFoundryAgentHost(product);
		await third.start();
		expect((await third.readMemory(who)).items).toEqual([]);
		await third.stop();
	},
	60_000,
);

t(
	"an erase after the store changed from the deployment's own to the service's empties the memory container too",
	async () => {
		const factory = foundryParityFactory({ memory: "own" });
		teardowns.push(() => factory.teardown());
		const first = (await factory.create(product)) as Host;
		await first.start();
		factory.answer("On the second shelf.");

		const { resourceId: who } = await factory.person();
		await run(first, turn(who, "thread-change-2", "Call me Ada."));
		await factory.settled?.();
		expect(await ownFacts(who)).toEqual([REMEMBERED]);

		await first.stop();
		factory.editAgent({ memory: { store: "foundry", updateDelaySeconds: 0 } });
		// The job's `agent` step makes the store when the document names it.
		await ensureMemoryStore(product, { chat: "small", embedding: "embed" });
		const second = createFoundryAgentHost(product);
		await second.start();
		expect((await second.memory.selected()).kind).toBe("foundry");

		const report = await second.eraseResource(who);
		expect(report.memories).toBe(true);
		expect(await ownFacts(who)).toEqual([]);
		await second.stop();
	},
	60_000,
);

t(
	"an erase where the service's store was never made stands: a project with no such store has nothing of the person to forget",
	async () => {
		const factory = foundryParityFactory({ memory: "own" });
		teardowns.push(() => factory.teardown());
		const host = (await factory.create(product)) as Host;
		await host.start();
		factory.answer("On the second shelf.");

		const { resourceId: who } = await factory.person();
		await run(host, turn(who, "thread-change-3", "Call me Ada."));
		await factory.settled?.();
		expect(await ownFacts(who)).toEqual([REMEMBERED]);

		const report = await host.eraseResource(who);
		expect(report.memories).toBe(true);
		expect(await ownFacts(who)).toEqual([]);
		// Again, with nothing left in either: an erase is repeated until it reports clean.
		expect((await host.eraseResource(who)).memories).toBe(false);
		await host.stop();
	},
	60_000,
);

/** An own-store host with a remembered fact, the Foundry store answering as `status` does. */
async function ownStoreWithFoundryAnswering(threadId: string, status: number) {
	const factory = foundryParityFactory({ memory: "own" });
	teardowns.push(() => factory.teardown());
	const host = (await factory.create(product)) as Host;
	await host.start();
	factory.answer("On the second shelf.");
	const { resourceId: who } = await factory.person();
	await run(host, turn(who, threadId, "Call me Ada."));
	await factory.settled?.();
	expect(await ownFacts(who)).toEqual([REMEMBERED]);
	factory
		.fake()
		.failWhen((_, path) => path.startsWith("/memory_stores"), status);
	return { factory, host, who };
}

t(
	"an erase where the service's store refuses, or is in an outage, throws, so the account's erase stays unfinished and is tried again",
	async () => {
		// 403 is a deployment that lost the role or went private, while it may still hold the person's statements.
		for (const status of [403, 400, 503]) {
			const { host, who } = await ownStoreWithFoundryAnswering(
				`thread-refused-${status}`,
				status,
			);
			await expect(host.eraseResource(who), String(status)).rejects.toThrow();
			await host.stop();
		}
	},
	60_000,
);

t(
	"an erase where the service's store answers 404 completes: nothing of the person is there",
	async () => {
		const { host, who } = await ownStoreWithFoundryAnswering(
			"thread-absent",
			404,
		);
		const report = await host.eraseResource(who);
		expect(report.memories).toBe(true);
		expect(await ownFacts(who)).toEqual([]);
		await host.stop();
	},
	60_000,
);

t(
	"the store in use failing to forget throws, whatever it answers",
	async () => {
		const factory = foundryParityFactory({ memory: "foundry" });
		teardowns.push(() => factory.teardown());
		const host = (await factory.create(product)) as Host;
		await host.start();
		expect((await host.memory.selected()).kind).toBe("foundry");
		const { resourceId: who } = await factory.person();
		factory
			.fake()
			.failWhen((_, path) => path.startsWith("/memory_stores"), 403);
		await expect(host.eraseResource(who)).rejects.toThrow();
		await host.stop();
	},
	60_000,
);
