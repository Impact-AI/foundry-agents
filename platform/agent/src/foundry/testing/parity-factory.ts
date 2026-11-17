import { fakeConfigStore } from "@platform/config/testing";
import { openTestCosmos, type TestCosmos } from "@platform/cosmos/testing";
import {
	identityContainers,
	updatePerson,
	upsertAccount,
} from "@platform/identity";
import { configure } from "@platform/llm/testing";
import { closeRedis } from "@platform/redis";
import { sweepNamespace, throwawayNamespace } from "@platform/redis/testing";
import { scopedEnv } from "@platform/test-support";
import type { ParityFactory } from "../../contract/parity";
import type { AgentProduct } from "../../contract/product";
import { memoryContainer } from "../../memory/store";
import {
	type HistoryStoreKind,
	type MemoryStoreKind,
	resetAgentSettings,
} from "../../settings";
import {
	type StandInExtractor,
	standInExtractor,
} from "../../testing/stand-in-extractor";
import { resetFoundryClients } from "../client";
import { threadContainers } from "../containers";
import { createFoundryAgentHost, type FoundryAgentHost } from "../host";
import { ensureMemoryStore } from "../memory";
import {
	FAKE_FOUNDRY_ENDPOINT,
	FAKE_RAI_POLICY,
	type FakeFoundry,
	fakeFoundry,
} from "./fake-foundry";

/**
 * The host on Foundry through the parity suite: the service stood in for at
 * its HTTP boundary by the fake, with both SDKs above it real; the thread
 * index and the accounts on Cosmos DB as every store suite meets it; the
 * fleet's keys under a throwaway prefix swept after; memory on whichever
 * store `memory` names — the fake's memory store, made by the job's own
 * step, or the own store with its extractor stood in for — keeping what is
 * kept and one fixed statement, at once; a new thread's messages in
 * whichever store `history` names — the deployment's own container, or the
 * fake's conversations; and a turn bucket the suite's turns never empty.
 */
export const REMEMBERED = "Prefers answers about maps in one sentence.";

export function foundryParityFactory({
	memory = "foundry",
	history = "own",
}: {
	memory?: MemoryStoreKind;
	history?: HistoryStoreKind;
} = {}): ParityFactory & {
	fake(): FakeFoundry;
	/** The own store's extractor, to decide what a turn leaves remembered; the fake's `extract` is the Foundry store's. */
	extractor: StandInExtractor;
	/** Change the operator's `agent` document as a portal edit would, read on the next turn. Returns the undo. */
	editAgent(change: Record<string, unknown>): () => void;
} {
	const namespace = throwawayNamespace();
	const restores: (() => void)[] = [];
	let fake: FakeFoundry | undefined;
	// What a well-behaved model answers: everything kept, and the one statement every turn teaches it.
	const extractor = standInExtractor((_, kept) => [
		...new Set([...kept, REMEMBERED]),
	]);
	let cosmos: TestCosmos | undefined;
	let host: FoundryAgentHost | undefined;
	const agent: Record<string, unknown> = {
		memory: { store: memory, updateDelaySeconds: 0 },
		history: { store: history },
		turns: { burst: 100, refillPerMinute: 100 },
	};
	const latest = () => fake?.turns().at(-1);

	return {
		name: `foundry, memory on ${memory === "own" ? "the own store" : "the memory store"}, history on ${history === "own" ? "the own store" : "the service's conversations"}`,

		fake: () => {
			if (!fake) throw new Error("create the host first");
			return fake;
		},
		extractor,

		editAgent(change) {
			const before = { ...agent };
			Object.assign(agent, change);
			resetAgentSettings();
			return () => {
				for (const key of Object.keys(agent)) delete agent[key];
				Object.assign(agent, before);
				resetAgentSettings();
			};
		},

		async create(product: AgentProduct) {
			cosmos = await openTestCosmos([
				...identityContainers,
				...threadContainers,
				memoryContainer,
			]);
			restores.push(
				scopedEnv({
					FOUNDRY_PROJECT_ENDPOINT: FAKE_FOUNDRY_ENDPOINT,
					FOUNDRY_RAI_POLICY: FAKE_RAI_POLICY,
					FOUNDRY_MEMORY_STORE: undefined,
					AGENT_KEY_PREFIX: namespace.prefix,
				}),
				configure({
					AZURE_OPENAI_RESOURCE_NAME: "account",
					AZURE_OPENAI_CHAT_DEPLOYMENT: "chat",
					AZURE_OPENAI_SMALL_CHAT_DEPLOYMENT: "small",
					AZURE_OPENAI_EMBEDDING_DEPLOYMENT: "embed",
				}),
				fakeConfigStore({ agent }),
				resetFoundryClients,
			);
			resetAgentSettings();
			resetFoundryClients();
			fake = fakeFoundry();
			fake.extract(() => [REMEMBERED]);
			restores.push(
				fake.install(
					async (request) =>
						(await extractor.fetch(request)) ??
						Response.json(
							{ error: { message: "nothing stands in" } },
							{ status: 404 },
						),
				),
			);
			if (memory === "foundry")
				await ensureMemoryStore(product, { chat: "small", embedding: "embed" });
			host = createFoundryAgentHost(product);
			return host;
		},

		async person() {
			const account = `account-${crypto.randomUUID().slice(0, 8)}`;
			const person = {
				name: "Ada",
				about: "I restore old maps.",
				preferences: "Answer in one sentence.",
			};
			await upsertAccount({ id: account, name: person.name });
			await updatePerson(account, person);
			return { resourceId: account, ...person };
		},

		async editPerson(resourceId, about) {
			await updatePerson(resourceId, { about });
		},

		answer: (text) => fake?.answer(text),
		script: (...answers) => fake?.script(...answers),
		instructions: () => latest()?.instructions ?? "",
		conversation: () => JSON.stringify(latest()?.items ?? []),
		turns: () => fake?.turns().length ?? 0,
		extractions: () =>
			memory === "foundry" ? (fake?.extractions() ?? []) : extractor.handed,

		async settled() {
			await host?.memory.flush();
			await host?.titles.flush();
			// The fake's store extracts on its own timers.
			while (fake?.state.timers.size) await Bun.sleep(10);
		},

		async teardown() {
			await cosmos?.drop();
			// Last staged, first restored: the environment goes back after everything that read it.
			for (const restore of restores.reverse()) restore();
			resetAgentSettings();
			await sweepNamespace(namespace);
			await closeRedis();
		},
	};
}
