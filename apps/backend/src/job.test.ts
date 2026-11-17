import {
	afterEach,
	beforeEach,
	expect,
	type Mock,
	spyOn,
	test,
} from "bun:test";
import { resetAgentSettings } from "@platform/agent";
import { FAKE_FOUNDRY_ENDPOINT, fakeFoundry } from "@platform/agent/testing";
import { resetAppConfigClient, setAppConfigClient } from "@platform/config";
import { fakeConfigStore } from "@platform/config/testing";
import { openTestCosmos } from "@platform/cosmos/testing";
import {
	FIELD,
	loadLibrary,
	resetKnowledgeSettings,
	resetSearchClients,
	resetShield,
} from "@platform/knowledge";
import {
	PIPELINE_ENV,
	stagedSettings,
	standInKnowledge,
} from "@platform/knowledge/testing";
import { configure } from "@platform/llm/testing";
import { problemChannel } from "@platform/observability";
import { promptContainers } from "@platform/prompt/store";
import { closeRedis } from "@platform/redis";
import { sweepNamespace, throwawayNamespace } from "@platform/redis/testing";
import { resetBlobService } from "@platform/storage";
import { scopedEnv } from "@platform/test-support";
import { RULES } from "./components";
import { configDocuments } from "./config-documents";
import { parseSteps, runSteps, STEPS } from "./job";
import { prompt } from "./product";

let quiet: Mock<typeof console.log>[] = [];
beforeEach(() => {
	quiet = [
		spyOn(console, "log").mockImplementation(() => {}),
		spyOn(console, "error").mockImplementation(() => {}),
	];
});
afterEach(() => {
	for (const spy of quiet) spy.mockRestore();
});

test("the steps run in the order given, a library by its name", () => {
	expect(parseSteps(["settings", "skills", "agent", "library"])).toEqual([
		{ label: "settings", name: "settings", argument: undefined },
		{ label: "skills", name: "skills", argument: undefined },
		{ label: "agent", name: "agent", argument: undefined },
		{ label: "library", name: "library", argument: undefined },
	]);
	expect(
		parseSteps([
			"library:handbook-2026",
			"remove-library:old",
			"remove-library",
		]),
	).toEqual([
		{
			label: "library:handbook-2026",
			name: "library",
			argument: "handbook-2026",
		},
		{ label: "remove-library:old", name: "remove-library", argument: "old" },
		{ label: "remove-library", name: "remove-library", argument: undefined },
	]);
});

test("an unknown step, an argument a step does not take, or none at all, refuses before anything runs", () => {
	expect(() => parseSteps(["settings", "migrate"])).toThrow(
		/unknown step "migrate"/,
	);
	expect(() => parseSteps(["agent:x"])).toThrow(/takes no such argument/);
	expect(() => parseSteps(["library:../up"])).toThrow(/takes no such argument/);
	expect(() => parseSteps(["library:"])).toThrow(/takes no such argument/);
	expect(() => parseSteps(["remove-library:@sample"])).toThrow(
		/takes no such argument/,
	);
	expect(() => parseSteps([])).toThrow(/name a step/);
	// A step is one the job declares, never a name every object answers to.
	for (const inherited of ["toString", "constructor", "valueOf", "__proto__"])
		expect(() => parseSteps([inherited])).toThrow(/unknown step/);
});

test("the first failed step stops the rest and fails the execution", async () => {
	const ran: string[] = [];
	const runner =
		(name: string, fails = false) =>
		async () => {
			ran.push(name);
			if (fails) throw new Error(`${name} refused`);
			return "done";
		};
	const ok = await runSteps(parseSteps(["settings", "skills", "agent"]), {
		settings: runner("settings"),
		skills: runner("skills", true),
		agent: runner("agent"),
	});
	expect(ok).toBe(false);
	expect(ran).toEqual(["settings", "skills"]);
});

test("the settings step writes every document and the persona's first version once, and a second deploy writes none; a published persona is the operator's and is left alone", async () => {
	const restore = scopedEnv({ APP_CONFIG_KEY_PREFIX: undefined });
	const cosmos = await openTestCosmos(promptContainers);
	const stored = new Map<string, string>();
	const status = (statusCode: number) =>
		Object.assign(new Error(`HTTP ${statusCode}`), { statusCode });
	setAppConfigClient({
		getConfigurationSetting: async ({ key }: { key: string }) => {
			const value = stored.get(key);
			if (value === undefined) throw status(404);
			return { key, value, etag: "1" };
		},
		addConfigurationSetting: async ({
			key,
			value,
		}: {
			key: string;
			value: string;
		}) => {
			if (stored.has(key)) throw status(412);
			stored.set(key, value);
			return { key, value };
		},
	} as unknown as Parameters<typeof setAppConfigClient>[0]);
	try {
		const documents = configDocuments();
		expect(await STEPS.settings?.()).toBe(
			`seeded ${Object.keys(documents).join(", ")}; the persona seeded as v1`,
		);
		expect(
			Object.fromEntries([...stored].map(([k, v]) => [k, JSON.parse(v)])),
		).toEqual(
			Object.fromEntries(
				Object.entries(documents).map(([k, v]) => [
					`app/${k}`,
					JSON.parse(JSON.stringify(v)),
				]),
			),
		);
		expect(await STEPS.settings?.()).toBe(
			"every document already stored; the persona v1 is the shipped text",
		);
		// The latest version is the last by `createdAt`, to the millisecond: an operator is never that quick after a deploy.
		await new Promise((resolve) => setTimeout(resolve, 2));
		await prompt.publish({
			label: "v2",
			text: "# CORE IDENTITY\nYou are brief.",
		});
		expect(await STEPS.settings?.()).toBe(
			"every document already stored; the persona v2 is the operator's; the shipped text changed and is not published over it",
		);
		expect(await prompt.version()).toMatchObject({ label: "v2" });
	} finally {
		await cosmos.drop();
		resetAppConfigClient();
		restore();
	}
});

test("the agent step makes the memory store, the version each surface asks for and the voice agent's, and a second deploy makes none of them; the skills step says the sample ships none", async () => {
	const cosmos = await openTestCosmos(promptContainers);
	// A fresh fake numbers its versions from one: a memo another run left would name versions it never made.
	const namespace = throwawayNamespace();
	const restores = [
		scopedEnv({
			FOUNDRY_PROJECT_ENDPOINT: FAKE_FOUNDRY_ENDPOINT,
			AGENT_KEY_PREFIX: namespace.prefix,
			// The realtime deployment the parameter file makes by default.
			AZURE_OPENAI_REALTIME_DEPLOYMENT: "realtime",
			AZURE_OPENAI_REALTIME_MODEL: "gpt-realtime-2.1",
		}),
		configure({
			AZURE_OPENAI_RESOURCE_NAME: "account",
			AZURE_OPENAI_CHAT_DEPLOYMENT: "chat",
			AZURE_OPENAI_SMALL_CHAT_DEPLOYMENT: "small",
			AZURE_OPENAI_EMBEDDING_DEPLOYMENT: "embed",
		}),
		fakeConfigStore({}),
	];
	resetAgentSettings();
	const foundry = fakeFoundry();
	restores.push(foundry.install());
	try {
		expect(await STEPS.skills?.()).toBe("the product ships no skills");
		expect(await STEPS.agent?.()).toBe(
			"the memory store made; version 1 for web; voice 1 (speechToSpeech); 0 old version(s) pruned",
		);
		// The voice agent holds the live surface's tools itself, and consults nobody.
		const [voice] = foundry.state.agents.get("assistant-voice") ?? [];
		if (!voice) throw new Error("no voice version was made");
		expect(voice.definition).not.toHaveProperty("subagent_config");
		expect(
			(voice.definition.tools as { name: string }[]).map((t) => t.name),
		).toEqual(expect.arrayContaining(["openDocument", "knowledgeSearch"]));
		expect(foundry.state.stores.get("person-memory")?.definition).toMatchObject(
			{
				chat_model: "small",
				embedding_model: "embed",
			},
		);
		expect(await STEPS.agent?.()).toBe(
			"the memory store kept as it is; version 1 for web; voice 1 (speechToSpeech); 0 old version(s) pruned",
		);
	} finally {
		for (const restore of restores.reverse()) restore();
		resetAgentSettings();
		await cosmos.drop();
		await sweepNamespace(namespace);
		await closeRedis();
	}
});

test("the agent step run alone on a private deployment whose document was edited to the Foundry store runs the own store under the run-time guard, and makes none", async () => {
	const cosmos = await openTestCosmos(promptContainers);
	const namespace = throwawayNamespace();
	const restores = [
		scopedEnv({
			FOUNDRY_PROJECT_ENDPOINT: FAKE_FOUNDRY_ENDPOINT,
			AGENT_KEY_PREFIX: namespace.prefix,
			PRIVATE_NETWORKING: "True",
			AZURE_OPENAI_REALTIME_DEPLOYMENT: "realtime",
			AZURE_OPENAI_REALTIME_MODEL: "gpt-realtime-2.1",
		}),
		configure({
			AZURE_OPENAI_RESOURCE_NAME: "account",
			AZURE_OPENAI_CHAT_DEPLOYMENT: "chat",
			AZURE_OPENAI_SMALL_CHAT_DEPLOYMENT: "small",
			AZURE_OPENAI_EMBEDDING_DEPLOYMENT: "embed",
		}),
		// A document written before the deployment went private, or a portal edit after.
		fakeConfigStore({ agent: { memory: { store: "foundry" } } }),
	];
	resetAgentSettings();
	const foundry = fakeFoundry();
	restores.push(foundry.install());
	const errors = quiet[1] as Mock<typeof console.error>;
	try {
		expect(await STEPS.agent?.()).toBe(
			"the memory store refused on a private deployment, the own store runs; version 1 for web; voice 1 (speechToSpeech); 0 old version(s) pruned",
		);
		expect(foundry.state.stores.size).toBe(0);
		expect(
			errors.mock.calls.some(([line]) =>
				String(line).includes("Foundry memory store on a private deployment"),
			),
		).toBe(true);
	} finally {
		for (const restore of restores.reverse()) restore();
		resetAgentSettings();
		await cosmos.drop();
		await sweepNamespace(namespace);
		await closeRedis();
	}
});

test("a private deploy whose agent document names the own store passes, makes no Foundry store, and primes the versions", async () => {
	const cosmos = await openTestCosmos(promptContainers);
	const namespace = throwawayNamespace();
	const restores = [
		scopedEnv({
			FOUNDRY_PROJECT_ENDPOINT: FAKE_FOUNDRY_ENDPOINT,
			AGENT_KEY_PREFIX: namespace.prefix,
			PRIVATE_NETWORKING: "True",
			AZURE_OPENAI_REALTIME_DEPLOYMENT: "realtime",
			AZURE_OPENAI_REALTIME_MODEL: "gpt-realtime-2.1",
		}),
		configure({
			AZURE_OPENAI_RESOURCE_NAME: "account",
			AZURE_OPENAI_CHAT_DEPLOYMENT: "chat",
			AZURE_OPENAI_SMALL_CHAT_DEPLOYMENT: "small",
			AZURE_OPENAI_EMBEDDING_DEPLOYMENT: "embed",
		}),
		// A document written before the deployment went private, or a portal edit after.
		fakeConfigStore({ agent: { memory: { store: "own" } } }),
	];
	resetAgentSettings();
	const foundry = fakeFoundry();
	restores.push(foundry.install());
	const errors = quiet[1] as Mock<typeof console.error>;
	try {
		expect(await STEPS.agent?.()).toBe(
			"the memory store not in use; version 1 for web; voice 1 (speechToSpeech); 0 old version(s) pruned",
		);
		expect(foundry.state.stores.size).toBe(0);
		expect(errors).not.toHaveBeenCalled();
	} finally {
		for (const restore of restores.reverse()) restore();
		resetAgentSettings();
		await cosmos.drop();
		await sweepNamespace(namespace);
		await closeRedis();
	}
});

test("the agent step warns, under a code, while new threads are kept in the service's conversations, and does not fail", async () => {
	const cosmos = await openTestCosmos(promptContainers);
	const namespace = throwawayNamespace();
	const restores = [
		scopedEnv({
			FOUNDRY_PROJECT_ENDPOINT: FAKE_FOUNDRY_ENDPOINT,
			AGENT_KEY_PREFIX: namespace.prefix,
			// The realtime deployment the parameter file makes by default.
			AZURE_OPENAI_REALTIME_DEPLOYMENT: "realtime",
			AZURE_OPENAI_REALTIME_MODEL: "gpt-realtime-2.1",
		}),
		configure({
			AZURE_OPENAI_RESOURCE_NAME: "account",
			AZURE_OPENAI_CHAT_DEPLOYMENT: "chat",
			AZURE_OPENAI_SMALL_CHAT_DEPLOYMENT: "small",
			AZURE_OPENAI_EMBEDDING_DEPLOYMENT: "embed",
		}),
		fakeConfigStore({
			agent: { memory: { store: "own" }, history: { store: "foundry" } },
		}),
	];
	resetAgentSettings();
	const foundry = fakeFoundry();
	restores.push(foundry.install());
	const warnings = spyOn(console, "warn").mockImplementation(() => {});
	const codes: unknown[] = [];
	problemChannel.setSink((line) => codes.push(line.attributes["problem.code"]));
	try {
		expect(await STEPS.agent?.()).toBe(
			"the memory store not in use; version 1 for web; voice 1 (speechToSpeech); 0 old version(s) pruned; new threads on the service's conversations, whose deletes leave the run state's copy until its time to live",
		);
		expect(codes).toEqual(["agent.history.service_retention"]);
		expect(warnings).toHaveBeenCalledTimes(1);
	} finally {
		problemChannel.setSink(null);
		warnings.mockRestore();
		for (const restore of restores.reverse()) restore();
		resetAgentSettings();
		await cosmos.drop();
		await sweepNamespace(namespace);
		await closeRedis();
	}
});

test("the agent step makes a version per engine in use, and with speech-to-speech unconfigured makes the cascade's and says so under a code, without failing", async () => {
	const cosmos = await openTestCosmos(promptContainers);
	const namespace = throwawayNamespace();
	const env = {
		FOUNDRY_PROJECT_ENDPOINT: FAKE_FOUNDRY_ENDPOINT,
		AGENT_KEY_PREFIX: namespace.prefix,
	};
	const restores = [
		configure({
			AZURE_OPENAI_RESOURCE_NAME: "account",
			AZURE_OPENAI_CHAT_DEPLOYMENT: "chat",
			AZURE_OPENAI_SMALL_CHAT_DEPLOYMENT: "small",
			AZURE_OPENAI_EMBEDDING_DEPLOYMENT: "embed",
		}),
		fakeConfigStore({
			agent: {
				memory: { store: "own" },
				voice: {
					engine: "cascade",
					engineByTier: { premium: "speechToSpeech" },
					transcription: "azure-speech",
				},
			},
		}),
	];
	resetAgentSettings();
	const foundry = fakeFoundry();
	restores.push(foundry.install());
	const errors = spyOn(console, "error").mockImplementation(() => {});
	const codes: unknown[] = [];
	problemChannel.setSink((line) => codes.push(line.attributes["problem.code"]));
	try {
		const unconfigured = scopedEnv({
			...env,
			AZURE_OPENAI_REALTIME_DEPLOYMENT: undefined,
		});
		try {
			expect(await STEPS.agent?.()).toBe(
				"the memory store not in use; version 1 for web; voice 1 (cascade); 0 old version(s) pruned; voice.engine names speechToSpeech but no realtime deployment is configured (AZURE_OPENAI_REALTIME_DEPLOYMENT) and voice.managedModel.speechToSpeech names none: the cascade runs",
			);
			expect(codes).toEqual(["agent.voice.speech_to_speech_unconfigured"]);
		} finally {
			unconfigured();
		}
		codes.length = 0;
		const configured = scopedEnv({
			...env,
			AZURE_OPENAI_REALTIME_DEPLOYMENT: "realtime",
			AZURE_OPENAI_REALTIME_MODEL: "gpt-realtime-2.1",
		});
		const warnings = spyOn(console, "warn").mockImplementation(() => {});
		try {
			expect(await STEPS.agent?.()).toBe(
				"the memory store not in use; version 1 for web; voice 1 (cascade), 2 (speechToSpeech); 0 old version(s) pruned; voice.transcription azure-speech is documented only beside a cascade: speech-to-speech transcribes with mai-transcribe",
			);
			expect(codes).toEqual(["agent.voice.transcriber_replaced"]);
			const models = (foundry.state.agents.get("assistant-voice") ?? []).map(
				(v) => (v.definition as { model: string }).model,
			);
			expect(models).toEqual(["chat", "realtime"]);
		} finally {
			warnings.mockRestore();
			configured();
		}
	} finally {
		problemChannel.setSink(null);
		errors.mockRestore();
		for (const restore of restores.reverse()) restore();
		resetAgentSettings();
		await cosmos.drop();
		await sweepNamespace(namespace);
		await closeRedis();
	}
});

/** An App Configuration that answers from, and writes into, `stored`. */
function memoryStore(initial: Record<string, unknown> = {}) {
	const stored = new Map<string, string>(
		Object.entries(initial).map(([k, v]) => [`app/${k}`, JSON.stringify(v)]),
	);
	const status = (statusCode: number) =>
		Object.assign(new Error(`HTTP ${statusCode}`), { statusCode });
	setAppConfigClient({
		getConfigurationSetting: async ({ key }: { key: string }) => {
			const value = stored.get(key);
			if (value === undefined) throw status(404);
			return { key, value, etag: "1" };
		},
		addConfigurationSetting: async ({
			key,
			value,
		}: {
			key: string;
			value: string;
		}) => {
			if (stored.has(key)) throw status(412);
			stored.set(key, value);
			return { key, value };
		},
	} as unknown as Parameters<typeof setAppConfigClient>[0]);
	return {
		read: (name: string) => {
			const value = stored.get(`app/${name}`);
			return value === undefined ? undefined : JSON.parse(value);
		},
		size: () => stored.size,
	};
}

/** The settings step under `env`, against `initial`; cosmos only when the step gets as far as the persona. */
async function settingsStep(
	env: Record<string, string | undefined>,
	initial: Record<string, unknown> = {},
) {
	const restore = scopedEnv({
		APP_CONFIG_KEY_PREFIX: undefined,
		PRIVATE_NETWORKING: undefined,
		MEMORY_STORE: undefined,
		HISTORY_STORE: undefined,
		VOICE_ENGINE: undefined,
		RETRIEVAL_ENGINE: undefined,
		...env,
	});
	resetAgentSettings();
	resetKnowledgeSettings();
	const cosmos = await openTestCosmos(promptContainers);
	const store = memoryStore(initial);
	const warn = spyOn(console, "warn").mockImplementation(() => {});
	try {
		let line: string | undefined;
		let error: Error | undefined;
		try {
			line = await STEPS.settings?.();
		} catch (err) {
			error = err as Error;
		}
		const outcome = { line, error };
		return {
			...outcome,
			store,
			warnings: warn.mock.calls.map(([line]) => String(line)),
		};
	} finally {
		warn.mockRestore();
		await cosmos.drop();
		resetAppConfigClient();
		resetAgentSettings();
		resetKnowledgeSettings();
		restore();
	}
}

const rule = (code: string) =>
	RULES.find((r) => r.code === code)?.message as string;

test("a private deploy choosing the Foundry memory store fails before any document is written, naming the code and own", async () => {
	const run = await settingsStep({
		PRIVATE_NETWORKING: "true",
		MEMORY_STORE: "foundry",
	});
	expect(run.error?.message).toBe(
		rule("agent.memory.store_unreachable_private"),
	);
	expect(run.error?.message).toContain("MEMORY_STORE=own");
	expect(run.store.size()).toBe(0);
});

test("a public deploy choosing the Foundry memory store seeds it; a private one choosing own seeds own", async () => {
	const open = await settingsStep({ MEMORY_STORE: "foundry" });
	expect(open.error).toBeUndefined();
	expect(open.store.read("agent").memory.store).toBe("foundry");
	const closed = await settingsStep({
		PRIVATE_NETWORKING: "true",
		MEMORY_STORE: "own",
	});
	expect(closed.error).toBeUndefined();
	expect(closed.store.read("agent").memory.store).toBe("own");
});

test("every component variable seeds its field in an absent document", async () => {
	const run = await settingsStep({
		MEMORY_STORE: "own",
		HISTORY_STORE: "foundry",
		VOICE_ENGINE: "cascade",
		RETRIEVAL_ENGINE: "knowledgeBase",
	});
	expect(run.error).toBeUndefined();
	expect(run.store.read("agent")).toMatchObject({
		memory: { store: "own" },
		history: { store: "foundry" },
		voice: { engine: "cascade" },
	});
	expect(run.store.read("knowledge").retrieval.engine).toBe("knowledgeBase");
	expect(run.warnings).toEqual([]);
});

test("unset variables seed today's defaults: foundry memory on public, own on private", async () => {
	const open = await settingsStep({});
	expect(open.store.read("agent")).toMatchObject({
		memory: { store: "foundry" },
		history: { store: "own" },
		voice: { engine: "speechToSpeech" },
	});
	expect(open.store.read("knowledge").retrieval.engine).toBe("hybrid");
	const closed = await settingsStep({ PRIVATE_NETWORKING: "true" });
	expect(closed.store.read("agent").memory.store).toBe("own");
});

test("a component variable with an unknown value fails before any document is written", async () => {
	const run = await settingsStep({ VOICE_ENGINE: "telepathy" });
	expect(run.error?.message).toStartWith(
		"components.unknown_value: VOICE_ENGINE is telepathy",
	);
	expect(run.store.size()).toBe(0);
});

test("an existing document is never overwritten: a field that differs from its variable is a warning under a code", async () => {
	const run = await settingsStep(
		{ MEMORY_STORE: "foundry" },
		{ agent: { memory: { store: "own" } } },
	);
	expect(run.error).toBeUndefined();
	expect(run.store.read("agent")).toEqual({ memory: { store: "own" } });
	expect(run.warnings).toEqual([
		expect.stringContaining(
			"settings.component_differs: MEMORY_STORE is foundry but the app/agent document's memory.store is own",
		),
	]);
});

test("a stored document edited to an incompatible component since the last deploy fails the next one", async () => {
	const memory = await settingsStep(
		{ PRIVATE_NETWORKING: "true" },
		{ agent: { memory: { store: "foundry" } } },
	);
	expect(memory.error?.message).toBe(
		rule("agent.memory.store_unreachable_private"),
	);
});

test("an index the index step must make again is refilled and scanned in that step, so a deploy that loads no library leaves no empty index", async () => {
	const restoreEnv = scopedEnv({
		...PIPELINE_ENV,
		AZURE_SEARCH_ENDPOINT: "https://search.test",
		AZURE_SEARCH_INDEX: undefined,
		AZURE_STORAGE_CONTAINER: undefined,
		APP_CONFIG_ENDPOINT: undefined,
	});
	const restoreSettings = stagedSettings({});
	const warn = spyOn(console, "warn").mockImplementation(() => {});
	try {
		const k = standInKnowledge();
		expect(await STEPS.index?.()).not.toContain("rebuilt");
		k.store.put("handbook/onboarding.md", "Collect your badge at reception.", {
			contentType: "application/octet-stream",
		});
		await loadLibrary("handbook", { pollMs: 0 });
		const loaded = k.index.documents.size;
		expect(loaded).toBeGreaterThan(0);
		// The index as an earlier template made it: its vector field not stored.
		const index = k.indexer.index as NonNullable<typeof k.indexer.index>;
		k.indexer.index = {
			...index,
			fields: index.fields.map((f) =>
				f.name === FIELD.vector ? { ...f, stored: false } : f,
			),
		};
		expect(await STEPS.index?.()).toContain(
			`the index was rebuilt and refilled: the indexer read 1 file(s), 0 failed, ${loaded} chunk(s) read by Prompt Shields, 0 flagged`,
		);
		expect(k.index.documents.size).toBe(loaded);
		for (const doc of k.index.documents.values())
			expect(doc.injection).toBe(false);
	} finally {
		warn.mockRestore();
		restoreSettings();
		restoreEnv();
		resetSearchClients();
		resetBlobService();
		resetShield();
	}
});
