import { afterAll, beforeAll, expect, spyOn, test } from "bun:test";
import {
	agentSettings,
	DEFAULT_AGENT_SETTINGS,
	resetAgentSettings,
	THREAD_PAGE_MAX,
} from "@platform/agent";
import {
	createFoundryAgentHost,
	type FoundryAgentHost,
} from "@platform/agent/foundry";
import {
	FAKE_FOUNDRY_ENDPOINT,
	type FakeFoundry,
	fakeFoundry,
	type SeenTurn,
	type StandInExtractor,
	standInExtractor,
} from "@platform/agent/testing";
import { fakeConfigStore } from "@platform/config/testing";
import { cosmosDatabase, setCosmosDatabase } from "@platform/cosmos";
import { openTestCosmos, type TestCosmos } from "@platform/cosmos/testing";
import { DEFAULT_EDGE_LIMITS } from "@platform/http";
import {
	callerAssertion,
	getAccount,
	localAccount,
	setAccountDisabled,
} from "@platform/identity";
import {
	documentIdOf,
	ensurePipeline,
	loadLibrary,
	resetAccessSettings,
	resetKnowledgeSettings,
	resetSearchClients,
	resetShield,
} from "@platform/knowledge";
import { standInKnowledge } from "@platform/knowledge/testing";
import { completion, configure } from "@platform/llm/testing";
import {
	invalidateLimits,
	LIMITS_KEY,
	resetMeteringKeyPrefix,
} from "@platform/metering";
import { UI_SURFACE_READABLE } from "@platform/prompt";
import { closeRedis, getRedis } from "@platform/redis";
import {
	REDIS_AVAILABLE,
	sweepNamespace,
	throwawayNamespace,
} from "@platform/redis/testing";
import { resetBlobService } from "@platform/storage";
import { scopedEnv } from "@platform/test-support";
import {
	type BrowserSocket,
	resetVoiceSettings,
	type ServerMessage,
} from "@platform/voice";
import { fakeVoiceAgent, openBrowserSocket } from "@platform/voice/testing";
import type { Hono } from "hono";
import { createApp } from "./app";
import { OPEN_GATE_ACCOUNT_ID } from "./auth/caller";
import type { AppEnv } from "./auth/context";
import { cosmosContainers } from "./containers";
import {
	guardrails,
	KNOWLEDGE_SEARCH,
	METRICS,
	product,
	prompt,
	WEB_SEARCH,
} from "./product";
import { LIST_LIMIT } from "./routes/conversations";
import { type CallOptions, call, claimsFor } from "./testing/calls";
import { type Wiring, wire } from "./wiring";

const STAGE_TOOLS = product.clientTools ?? [];

/**
 * The app end to end and, when `REDIS_URL` is set, on a real Redis: Foundry
 * Agent Service stood in for at its HTTP boundary, and everything above it
 * real — the gate, the rows, the host and both of the service's SDKs, the
 * stream, the media route, the voice refusals, and the erase that leaves
 * nothing. The knowledge base below the app — the blob store, the index,
 * the indexer and Prompt Shields — is stood in for at the SDK's boundaries,
 * and a library is loaded into it through the job's own steps; the
 * accounts, the persona and the thread index are on Cosmos DB as every store
 * suite meets it, in memory or, under `COSMOS_TESTS=1`, the emulator.
 *
 * One sequence on one account: the sign-in opens what the turn writes to,
 * which is what the export reads and the erase at the end has to leave
 * nothing of.
 */
const t = test;
const namespace = throwawayNamespace();
/** Loading a library through the job's steps beside other suites takes longer than the runner's default hook budget. */
const HOOK_BUDGET_MS = 60_000;

const OWNER = "account-a";
const OTHER = "account-b";
/** Who talks to the live voice. */
const SPEAKER = "account-speaker";
/** Who holds the app role `tester`, and so tunes their own live voice. */
const TESTER = "account-tester";
/**
 * The library both people search: a handbook everyone may read, the staff
 * notes only g-1 may, the board minutes only g-9 may, and the pictures they
 * show under the same rules.
 */
const LIBRARY = "people";
const HANDBOOK = documentIdOf(`${LIBRARY}/handbook.md`);
const STAFF = documentIdOf(`${LIBRARY}/staff.md`);
const DESK = `${LIBRARY}/pictures/desk.png`;
const MINUTES_PICTURE = `${LIBRARY}/pictures/minutes.png`;
const PNG = new Uint8Array([
	0x89,
	0x50,
	0x4e,
	0x47,
	0x0d,
	0x0a,
	0x1a,
	0x0a,
	...new Array(64).fill(0),
]);

let app: Hono<AppEnv>;
/** The app on a real listener, as a replica serves it: where a browser's live socket is upgraded. */
let listener: ReturnType<typeof Bun.serve<BrowserSocket>>;
let voiceAgent: ReturnType<typeof fakeVoiceAgent>;
let host: FoundryAgentHost;
let wiring: Wiring;
let cosmos: TestCosmos;
let knowledge: ReturnType<typeof standInKnowledge>;
let foundry: FakeFoundry;
let extractor: StandInExtractor;
let restoreEnv = () => {};
let restoreLlm = () => {};
let restoreConfig = () => {};
/** One account is one person: the account id is the memory scope. */
const resourceId = OWNER;
const quiet: ReturnType<typeof spyOn>[] = [];
/** The store's documents, read at each call, so a test can change one and invalidate the memo. */
const documents: Record<string, unknown> = {};
/** The tool the model calls before answering on its next turn, or none. */
let modelCalls: { name: string; args: Record<string, unknown> } | null = null;

beforeAll(async () => {
	quiet.push(spyOn(console, "log").mockImplementation(() => {}));
	quiet.push(spyOn(console, "warn").mockImplementation(() => {}));
	restoreEnv = scopedEnv({
		AGENT_KEY_PREFIX: namespace.prefix,
		FOUNDRY_PROJECT_ENDPOINT: FAKE_FOUNDRY_ENDPOINT,
		FOUNDRY_RAI_POLICY: undefined,
		FOUNDRY_MEMORY_STORE: undefined,
		AUTH_SECRET: "test-secret",
		// A flush names every waiting conversation at once; this replica's cap would answer some with their first line.
		TITLE_MAX_INFLIGHT: "100",
		AUTH_MODE: undefined,
		AUTH_REQUIRE_ROLE: undefined,
		CONTAINER_APP_NAME: undefined,
		AZURE_STORAGE_ACCOUNT: "account",
		AZURE_STORAGE_ENDPOINT: undefined,
		AZURE_STORAGE_CONTAINER: undefined,
		AZURE_STORAGE_RESOURCE_ID:
			"/subscriptions/s/resourceGroups/rg/providers/Microsoft.Storage/storageAccounts/account",
		AZURE_SEARCH_ENDPOINT: undefined,
		AZURE_SEARCH_INDEX: undefined,
		AZURE_OPENAI_EMBEDDING_MODEL: "text-embedding-3-large",
	});
	cosmos = await openTestCosmos(cosmosContainers);
	await prompt.seed();

	restoreLlm = configure({
		AZURE_OPENAI_RESOURCE_NAME: "account",
		AZURE_OPENAI_CHAT_DEPLOYMENT: "chat",
		AZURE_OPENAI_SMALL_CHAT_DEPLOYMENT: "small",
		AZURE_OPENAI_EMBEDDING_DEPLOYMENT: "embed",
	});
	// The own memory store: its documents are what the erase below is checked against; the Foundry store's suite is `platform/agent`'s.
	documents.agent = {
		memory: { store: "own", updateDelaySeconds: 0 },
		// Every conversation here is named by the stand-in titler, never by the bucket's fallback.
		titles: { burst: 1000, refillPerMinute: 1000 },
		titlesPerResource: { burst: 1000, refillPerMinute: 1000 },
	};
	// The planner's model call is not this suite's subject; the search it would plan is.
	documents.knowledge = { planner: { enabled: false } };
	restoreConfig = fakeConfigStore(documents);
	resetAgentSettings();
	resetVoiceSettings();
	resetAccessSettings();
	resetKnowledgeSettings();
	invalidateLimits();
	knowledge = standInKnowledge();
	await ensurePipeline();
	const files: Record<string, string | Uint8Array> = {
		"handbook.md": [
			"---",
			"title: Onboarding handbook",
			"summary: What a new colleague does in the first week.",
			"tags: [onboarding]",
			"---",
			"",
			"## Welcome",
			"",
			"Day one of the handbook: collect your badge at reception.",
			"",
			"![The reception desk, seen from the door](pictures/desk.png)",
			"",
			"## Your first week",
			"",
			"Meet your team, then set up your workstation.",
		].join("\n"),
		"staff.md":
			"---\ntitle: Staff notes\n---\n\nThe staff handbook says: ask first.",
		"board.md":
			"---\ntitle: Board minutes\n---\n\nThe board handbook minutes say: approved.\n\n![The vote](pictures/minutes.png)",
		"pictures/desk.png": PNG,
		"pictures/minutes.png": PNG,
		"access.json": JSON.stringify({
			"staff.md": { groups: ["g-1"] },
			"board.md": { groups: ["g-9"] },
			"pictures/minutes.png": { groups: ["g-9"] },
			"*": { groups: ["all"] },
		}),
	};
	for (const [path, bytes] of Object.entries(files))
		knowledge.store.put(`${LIBRARY}/${path}`, bytes);
	const loaded = await loadLibrary(LIBRARY, { pollMs: 0 });
	if (loaded.failed > 0) throw new Error(JSON.stringify(loaded.results));
	foundry = fakeFoundry();
	foundry.respond((seen) =>
		modelCalls && !answersACall(seen)
			? {
					calls: [
						{
							id: `call_${crypto.randomUUID().slice(0, 8)}`,
							name: modelCalls.name,
							args: modelCalls.args,
						},
					],
				}
			: { text: "The answer is forty-two." },
	);
	// As the extraction prompt asks: the whole list to keep, so what is kept
	// stays — a person's correction included — and a name said is added once.
	extractor = standInExtractor((messages, kept) =>
		kept.some((fact) => fact.includes("Ada")) ||
		!messages.some((m) => m.includes("Ada"))
			? kept
			: [...kept, "Goes by Ada."],
	);
	// The extractor and the titler are completions on the account, not responses on the agent.
	foundry.install(
		async (request) =>
			(await extractor.fetch(request)) ?? completion("Maps of the old town"),
	);

	host = createFoundryAgentHost(product);
	await host.start();
	// The voice agent's socket, stood in for: any version the stand-in Foundry made.
	voiceAgent = fakeVoiceAgent({
		agent: product.voice?.agentId ?? "",
		versions: () => true,
		inputs: {
			personalization: { required: true },
			language: { required: true },
		},
	});
	const voiceAccess = {
		endpoint: () => voiceAgent.endpoint,
		token: async () => "test-token",
	};
	wiring = wire(product, host, voiceAccess);
	app = createApp({ host, product, broker: wiring.broker });
	listener = Bun.serve<BrowserSocket>({
		port: 0,
		fetch: (request, server) => app.fetch(request, server),
		websocket: wiring.broker.websocket,
	});
}, HOOK_BUDGET_MS);

afterAll(async () => {
	await wiring?.broker.drain();
	void listener?.stop(true);
	void voiceAgent?.stop();
	await host?.stop();
	wiring?.stop();
	resetBlobService();
	await cosmos?.drop();
	for (const spy of quiet) spy.mockRestore();
	restoreLlm();
	restoreConfig();
	resetAgentSettings();
	resetVoiceSettings();
	resetAccessSettings();
	resetKnowledgeSettings();
	resetSearchClients();
	resetShield();
	resetMeteringKeyPrefix();
	invalidateLimits();
	restoreEnv();
	await sweepNamespace(namespace);
	await sweepNamespace(namespace.child("metering"));
	await closeRedis();
}, HOOK_BUDGET_MS);

/**
 * A thread a live session wrote: bound to a session and settled with these
 * lines, in this order, as the broker hands a session's words over.
 */
async function spokenThread(
	resourceId: string,
	threadId: string,
	lines: { role: "user" | "assistant"; text: string }[],
) {
	const sessionId = crypto.randomUUID();
	const bound = await host.liveVoiceBinding(resourceId, threadId, {
		sessionId,
		maxSessionSeconds: 60,
		tier: "base",
		locale: "en",
	});
	expect(bound.kind).toBe("bound");
	const at = new Date().toISOString();
	return host.settleLiveVoice(resourceId, threadId, {
		sessionId,
		spoken: lines.map((line, i) => ({
			itemId: `item_${i}`,
			previousItemId: i ? `item_${i - 1}` : null,
			at,
			kind: "said" as const,
			role: line.role,
			text: line.text,
			interrupted: false,
		})),
	});
}

/** The `limits` document as an operator would store it, read by the next gate: past this replica's memo and the fleet's. */
async function retuneLimits(stored: unknown): Promise<void> {
	if (stored === undefined) delete documents.limits;
	else documents.limits = stored;
	await wiring.memo.drop(LIMITS_KEY);
	invalidateLimits();
}

/** Every key under the namespace that names the owner. */
async function ownerKeys(): Promise<string[]> {
	const redis = await getRedis();
	if (!redis) throw new Error("REDIS_URL is set but Redis did not answer");
	const [, keys] = (await redis.send("SCAN", [
		"0",
		"MATCH",
		`${namespace.prefix}*${OWNER}*`,
		"COUNT",
		"1000",
	])) as [string, string[]];
	return keys;
}

/** Whether the model's input answers a call: the step after a tool. */
function answersACall(seen: SeenTurn): boolean {
	return seen.input.some((item) => item.type === "function_call_output");
}

/** What the model was told on its latest turn, and what it was handed. */
const latest = () => foundry.turns().at(-1);

/** The tools the version the latest turn ran on holds, by name. */
function versionTools(): string[] {
	const seen = latest();
	const version = foundry.state.agents
		.get(seen?.agent.name ?? "")
		?.find((v) => v.version === seen?.agent.version);
	return (
		(version?.definition.tools ?? []) as { name?: string; type: string }[]
	).map((tool) => tool.name ?? tool.type);
}

async function until(condition: () => Promise<boolean>, timeoutMs = 10_000) {
	const deadline = Date.now() + timeoutMs;
	while (!(await condition())) {
		if (Date.now() > deadline) throw new Error("condition not met in time");
		await Bun.sleep(50);
	}
}

/** The app's language is the one the frontend resolved and sends as `Accept-Language`; this person chose Italian. */
const ITALIAN = { "accept-language": "it" };

/** An AG-UI run as the frontend's runtime posts it: the person's words, and `extra` over the rest. */
function runBody(threadId: string, text: string, extra = {}) {
	return {
		threadId,
		runId: crypto.randomUUID(),
		state: {},
		messages: [{ id: crypto.randomUUID(), role: "user", content: text }],
		tools: [],
		context: [],
		forwardedProps: {},
		...extra,
	};
}

function turn(threadId: string, text: string, as = OWNER) {
	return call(app, "POST", "/agent/run", {
		as,
		headers: ITALIAN,
		body: runBody(threadId, text),
	});
}

/** A sign-in as the frontend reports it, with the groups the provider named this time; the row records them. */
function signIn(
	who: string,
	name: string,
	groups: string[],
	roles: string[] = [],
) {
	const email = `${name.toLowerCase()}@example.com`;
	return call(app, "POST", "/identity/sign-in", {
		// As the frontend mints it: from the same claims the body reports.
		as: { ...claimsFor(who), roles, groups },
		body: {
			claims: { oid: who, email, name, roles, groups },
			user: { id: who, email, name },
			account: { provider: "microsoft-entra-id" },
		},
	});
}

/** The owner's sign-in. */
function signInOwner(groups: string[]) {
	return signIn(OWNER, "Ada", groups);
}

t(
	"a sign-in creates the account, and /me answers the person and re-resolves access and groups from the row",
	async () => {
		const signIn = await signInOwner(["g-1"]);
		expect(signIn.status).toBe(200);
		expect(await signIn.json()).toEqual({
			ok: true,
			accountId: OWNER,
			access: { tier: "base" },
		});
		const me = await call(app, "GET", "/identity/me", { as: OWNER });
		expect(await me.json()).toEqual({
			accountId: OWNER,
			name: "Ada",
			about: null,
			preferences: null,
			access: { tier: "base" },
			groups: ["g-1"],
			standing: "ok",
			agentId: product.agentId,
			limits: {
				maxRequestBodyBytes: DEFAULT_EDGE_LIMITS.maxRequestBodyBytes,
			},
			stageTools: STAGE_TOOLS,
		});
		expect((await call(app, "GET", "/identity/me", { as: OTHER })).status).toBe(
			404,
		);
	},
);

t(
	"the roles and groups a sign-in records are the assertion's: a body that claims more is given none of it",
	async () => {
		const who = "account-climber";
		const reported = await call(app, "POST", "/identity/sign-in", {
			as: who,
			body: {
				claims: { oid: who, roles: ["premium"], groups: ["people-team"] },
				user: { id: who },
				account: { provider: "microsoft-entra-id" },
			},
		});
		expect(await reported.json()).toEqual({
			ok: true,
			accountId: who,
			access: { tier: "base" },
		});
		expect(await getAccount(who)).toMatchObject({ roles: [], groups: [] });
		// A provider token that names no stable id names no account, whatever the session's user is called.
		const anonymous = await call(app, "POST", "/identity/sign-in", {
			as: who,
			body: {
				claims: { email: "climber@example.com" },
				user: { id: who },
				account: { provider: "microsoft-entra-id" },
			},
		});
		expect(anonymous.status).toBe(403);
	},
);

t(
	"a local subject is refused at the gate in entra mode, and in local mode every sign-in is a member on the base tier",
	async () => {
		const user = localAccount("Ada");
		const sub = user?.id ?? "";
		const ada = { claims: null, user, account: { provider: "local" } };
		// The gate answers before the route: a local subject holds only while
		// the mode is local, so in entra mode the assertion itself is refused.
		const refused = await call(app, "POST", "/identity/sign-in", {
			as: sub,
			body: ada,
		});
		expect(refused.status).toBe(401);
		expect(await refused.json()).toEqual({ code: "unauthenticated" });

		const restoreMode = scopedEnv({ AUTH_MODE: "local" });
		try {
			const signIn = await call(app, "POST", "/identity/sign-in", {
				as: sub,
				body: ada,
			});
			expect(await signIn.json()).toEqual({
				ok: true,
				accountId: sub,
				access: { tier: "base" },
			});
			const me = await call(app, "GET", "/identity/me", { as: sub });
			expect(await me.json()).toMatchObject({
				name: "Ada",
				access: { tier: "base" },
				groups: [],
			});
		} finally {
			await call(app, "DELETE", "/account", { as: sub });
			restoreMode();
		}
		expect(await getAccount(sub)).toBeNull();
	},
);

t(
	"an open gate lands every local sign-in on its one account, whatever the name",
	async () => {
		const restore = scopedEnv({ AUTH_SECRET: undefined, AUTH_MODE: "local" });
		try {
			const signIn = await call(app, "POST", "/identity/sign-in", {
				body: {
					claims: null,
					user: localAccount("Grace"),
					account: { provider: "local" },
				},
			});
			expect(await signIn.json()).toEqual({
				ok: true,
				accountId: OPEN_GATE_ACCOUNT_ID,
				access: { tier: "base" },
			});
			const me = await call(app, "GET", "/identity/me");
			expect(await me.json()).toMatchObject({
				accountId: OPEN_GATE_ACCOUNT_ID,
				name: "Grace",
			});
			await call(app, "DELETE", "/account");
			// No session stands behind an open gate: the erase of its one account shuts the checkout out of nothing.
			expect((await call(app, "GET", "/records")).status).toBe(200);
			expect((await call(app, "GET", "/conversations")).status).toBe(200);
			expect(await getAccount(OPEN_GATE_ACCOUNT_ID)).toBeNull();
			// A deactivation is one there too, on what the erase left as on a person's record.
			expect(await setAccountDisabled(OPEN_GATE_ACCOUNT_ID, true)).toBe(true);
			const shut = await call(app, "GET", "/records");
			expect(shut.status).toBe(403);
			expect(await shut.json()).toEqual({ code: "account_deactivated" });
		} finally {
			restore();
			await cosmos.database
				.container("accounts")
				.delete(OPEN_GATE_ACCOUNT_ID, OPEN_GATE_ACCOUNT_ID);
		}
		expect(await getAccount(OPEN_GATE_ACCOUNT_ID)).toBeNull();
	},
);

t(
	"the person's fields are edited on the account, validated and bounded, and nobody else's are reached",
	async () => {
		const edited = await call(app, "PATCH", "/identity/me", {
			as: OWNER,
			body: {
				name: " Ada Quill ",
				about: "I collect maps.",
				preferences: "Answer briefly.",
				locale: "fr",
			},
		});
		expect(edited.status).toBe(200);
		expect(await edited.json()).toEqual({
			name: "Ada Quill",
			about: "I collect maps.",
			preferences: "Answer briefly.",
		});
		expect(
			await (
				await call(app, "PATCH", "/identity/me", {
					as: OWNER,
					body: { name: "Ada" },
				})
			).json(),
		).toMatchObject({ name: "Ada", about: "I collect maps." });
		const me = (await (
			await call(app, "GET", "/identity/me", { as: OWNER })
		).json()) as Record<string, unknown>;
		expect(me).toMatchObject({
			name: "Ada",
			about: "I collect maps.",
			preferences: "Answer briefly.",
		});
		expect(me).not.toHaveProperty("locale");

		for (const body of [
			{},
			{ locale: "fr" },
			{ name: "   " },
			{ name: 42 },
			{ name: "x".repeat(61) },
			{ about: "x".repeat(1001) },
			{ preferences: ["no"] },
			"not json",
		]) {
			const refused = await call(app, "PATCH", "/identity/me", {
				as: OWNER,
				body,
			});
			expect(refused.status).toBe(400);
			expect(await refused.json()).toEqual({ code: "invalid_body" });
		}
		const nobody = await call(app, "PATCH", "/identity/me", {
			as: OTHER,
			body: { about: "Mine now." },
		});
		expect(nobody.status).toBe(404);
		expect(await nobody.json()).toEqual({ code: "no_account" });
		expect((await getAccount(OWNER))?.about).toBe("I collect maps.");
	},
);

t(
	"a turn reaches the provider with the three parts in order and the person's blocks, and streams back",
	async () => {
		const res = await turn("thread-1", "Where is the map?");
		expect(res.status).toBe(200);
		expect(res.headers.get("x-accel-buffering")).toBe("no");
		expect(await res.text()).toContain("forty-two");

		const instructions = latest()?.instructions ?? "";
		const order = [
			guardrails.defaults.scope,
			"You are a helpful assistant",
			"your first act is `knowledgeSearch`",
			"TODAY IS",
			"THEIR NAME: Ada",
			"I collect maps.",
			"Answer briefly.",
			"<person_language>",
			"Italian",
		];
		const positions = order.map((s) => instructions.indexOf(s));
		expect(positions.every((p) => p >= 0)).toBe(true);
		expect([...positions].sort((a, b) => a - b)).toEqual(positions);
		// Every control of the stage, then the service's web search, then every tool the operator left on.
		expect(versionTools()).toEqual([
			...STAGE_TOOLS.map((tool) => tool.name),
			"web_search",
			...product.toolKeys.filter((key) => key !== WEB_SEARCH),
		]);

		// The scope is the caller's account, and a run has no field to name another.
		const elsewhere = await turn("thread-1", "hi", OTHER);
		expect(elsewhere.status).toBe(403);
		const named = await call(app, "POST", "/agent/run", {
			as: OWNER,
			body: { ...runBody("thread-x", "hi"), resourceId: OTHER },
		});
		expect(named.status).toBe(400);
		expect(await named.json()).toEqual({ code: "turn.invalid" });
		expect(
			(await call(app, "GET", "/conversations/thread-1", { as: OTHER })).status,
		).toBe(404);
		const empty = await call(app, "POST", "/agent/run", {
			as: OWNER,
			body: {},
		});
		expect(empty.status).toBe(400);
	},
);

t(
	"two people in different groups each find only their own group's document, a local account only what is open to everyone, and a search follows the groups the row holds — never an older assertion's",
	async () => {
		const SECOND = "account-c";
		/** The latest hybrid request: a `*` read is a walk, not a search. */
		const hybrid = () =>
			knowledge.index.searches.filter((s) => s.text !== "*").at(-1);
		/** What the model was handed back after the search: the passages, as the tool returned them. */
		const handedBack = () => JSON.stringify(latest()?.input);
		/** A turn that searches the library, as `as`. */
		const search = async (as: CallOptions["as"], threadId: string) => {
			modelCalls = { name: KNOWLEDGE_SEARCH, args: { query: "the handbook" } };
			try {
				const res = await call(app, "POST", "/agent/run", {
					as,
					body: runBody(threadId, "handbook?"),
				});
				expect(res.status).toBe(200);
				expect(await res.text()).toContain("forty-two");
			} finally {
				modelCalls = null;
			}
		};
		const readers = (oid: string, groups: string) =>
			`injection eq false and documentId ne null and (oids/any(t: t eq '${oid}') or groups/any(t: search.in(t, '${groups}', '|')))`;

		documents.access = { enforceAccessControl: true };
		resetAccessSettings();
		const local = localAccount("Lin");
		const restoreMode = scopedEnv({ AUTH_MODE: undefined });
		try {
			expect((await signInOwner(["g-1"])).status).toBe(200);
			expect((await signIn(SECOND, "Grace", ["g-9"])).status).toBe(200);

			// The assertion still names g-9 from an older session; the row says g-1, and the row decides.
			await search({ ...claimsFor(OWNER), groups: ["g-9"] }, "thread-search-1");
			expect(hybrid()?.options.filter).toBe(readers(OWNER, "g-1|all"));
			expect(handedBack()).toContain("ask first");
			expect(handedBack()).toContain("collect your badge");
			expect(handedBack()).not.toContain("approved");

			await search(SECOND, "thread-search-2");
			expect(hybrid()?.options.filter).toBe(readers(SECOND, "g-9|all"));
			expect(handedBack()).toContain("approved");
			expect(handedBack()).toContain("collect your badge");
			expect(handedBack()).not.toContain("ask first");

			// No Microsoft identity, so no groups and a subject no access.json names.
			process.env.AUTH_MODE = "local";
			const sub = local?.id ?? "";
			const signedIn = await call(app, "POST", "/identity/sign-in", {
				as: sub,
				body: { claims: null, user: local, account: { provider: "local" } },
			});
			expect(signedIn.status).toBe(200);
			await search(sub, "thread-search-local");
			expect(hybrid()?.options.filter).toBe(readers(sub, "all"));
			expect(handedBack()).toContain("collect your badge");
			expect(handedBack()).not.toContain("ask first");
			expect(handedBack()).not.toContain("approved");
		} finally {
			for (const who of [SECOND, local?.id ?? ""])
				await call(app, "DELETE", "/account", { as: who });
			restoreMode();
			documents.access = { enforceAccessControl: false };
			resetAccessSettings();
		}

		await search(OWNER, "thread-search-3");
		expect(hybrid()?.options.filter).toBe(
			"injection eq false and documentId ne null",
		);
		expect(handedBack()).toContain("ask first");
		expect(handedBack()).toContain("approved");
	},
);

/** A run's answer as its AG-UI events, one server-sent event each. */
function eventsOf(text: string): Record<string, unknown>[] {
	return text
		.split("\n\n")
		.filter((frame) => frame.startsWith("data: "))
		.map((frame) => JSON.parse(frame.slice(6)));
}

t(
	"the library is the caller's search with every picture a path on the media route, and one document is rendered for the reader or is 404",
	async () => {
		const listed = await call(app, "GET", "/library?query=handbook", {
			as: OWNER,
		});
		expect(listed.status).toBe(200);
		const { documents: cards } = (await listed.json()) as {
			documents: {
				id: string;
				title: string;
				summary: string;
				tags: string[];
				thumbnailUrl?: string;
			}[];
		};
		const handbook = cards.find((c) => c.id === HANDBOOK);
		expect(handbook).toEqual({
			id: HANDBOOK,
			title: "Onboarding handbook",
			summary: "What a new colleague does in the first week.",
			tags: ["onboarding"],
			thumbnailUrl: `/api/media/${DESK}`,
		});
		// A card is a document: each appears once, however many of its passages matched.
		expect(new Set(cards.map((c) => c.id)).size).toBe(cards.length);
		const served = await call(app, "GET", `/media/${DESK}`, { as: OWNER });
		expect(served.status).toBe(200);

		const opened = await call(app, "GET", `/library/${HANDBOOK}`, {
			as: OWNER,
		});
		expect(opened.status).toBe(200);
		expect(await opened.json()).toEqual({
			id: HANDBOOK,
			title: "Onboarding handbook",
			summary: "What a new colleague does in the first week.",
			tags: ["onboarding"],
			thumbnailUrl: `/api/media/${DESK}`,
			sections: [
				{
					heading: "Welcome",
					text: "Day one of the handbook: collect your badge at reception.",
				},
				{
					heading: "Your first week",
					text: "Meet your team, then set up your workstation.",
				},
			],
			markdown: true,
			media: [
				{
					type: "image",
					url: `/api/media/${DESK}`,
					title: "The reception desk, seen from the door",
				},
			],
		});

		for (const id of ["nope", "0".repeat(32)]) {
			const missing = await call(app, "GET", `/library/${id}`, { as: OWNER });
			expect(missing.status).toBe(404);
			expect(await missing.json()).toEqual({ code: "not_found" });
		}
		// No query is the catalogue: every document the caller may read, one card each, unranked.
		const catalogue = await call(app, "GET", "/library", { as: OWNER });
		expect(catalogue.status).toBe(200);
		const { documents: all } = (await catalogue.json()) as {
			documents: { id: string; title: string }[];
		};
		expect(all.map((d) => d.id)).toContain(HANDBOOK);
		expect(new Set(all.map((d) => d.id)).size).toBe(all.length);
		expect(
			(
				await call(app, "GET", `/library?query=${"x".repeat(401)}`, {
					as: OWNER,
				})
			).status,
		).toBe(400);

		// Under enforcement the reader admits the document's groups as the row holds them and nobody else, whatever the assertion names, and absent and refused are one answer.
		documents.access = { enforceAccessControl: true };
		resetAccessSettings();
		try {
			await signInOwner(["g-9"]);
			const outsider = await call(app, "GET", `/library/${STAFF}`, {
				as: { ...claimsFor(OWNER), groups: ["g-1"] },
			});
			expect(outsider.status).toBe(404);
			await signInOwner(["g-1"]);
			const member = await call(app, "GET", `/library/${STAFF}`, {
				as: { ...claimsFor(OWNER), groups: ["g-9"] },
			});
			expect(member.status).toBe(200);
		} finally {
			await signInOwner(["g-1"]);
			documents.access = { enforceAccessControl: false };
			resetAccessSettings();
		}
	},
);

t(
	"a tag the index could not hold is a bad query, with or without words to search for",
	async () => {
		for (const query of [
			"/library?tags=a%7Cb",
			"/library?query=handbook&tags=a%7Cb",
			`/library?tags=${"t".repeat(61)}`,
			`/library?tags=${Array.from({ length: 9 }, (_, i) => `t${i}`).join(",")}`,
		]) {
			const refused = await call(app, "GET", query, { as: OWNER });
			expect(refused.status, query).toBe(400);
			expect(await refused.json()).toEqual({ code: "invalid_query" });
		}
		expect(
			(await call(app, "GET", "/library?tags=onboarding", { as: OWNER }))
				.status,
		).toBe(200);
	},
);

t.skipIf(!REDIS_AVAILABLE)(
	"a search of the library draws on the day's allowance, and the catalogue, which asks no model, does not",
	async () => {
		const who = "account-searcher";
		await retuneLimits({ media: { perDay: 2 } });
		try {
			for (const _ of [1, 2])
				expect(
					(await call(app, "GET", "/library?query=handbook", { as: who }))
						.status,
				).toBe(200);
			const refused = await call(app, "GET", "/library?query=handbook", {
				as: who,
			});
			expect(refused.status).toBe(429);
			expect(await refused.json()).toMatchObject({
				code: "rate_limited",
				surface: "media",
			});
			expect((await call(app, "GET", "/library", { as: who })).status).toBe(
				200,
			);
		} finally {
			await retuneLimits(undefined);
		}
	},
);

t.skipIf(!REDIS_AVAILABLE)(
	"a copy that still stands is confirmed without a credit of the day, so a picture a browser holds draws when the day's allowance is spent; anything else is a request for the picture",
	async () => {
		const who = "account-viewer";
		await retuneLimits({ media: { perDay: 2 } });
		try {
			const first = await call(app, "GET", `/media/${DESK}`, { as: who });
			expect(first.status).toBe(200);
			await first.text();
			const etag = String(first.headers.get("etag"));
			// Asked about again and again: none of it is counted.
			for (const _ of [1, 2, 3, 4, 5])
				expect(
					(
						await call(app, "GET", `/media/${DESK}`, {
							as: who,
							headers: { "If-None-Match": etag },
						})
					).status,
				).toBe(304);
			const second = await call(app, "GET", `/media/${DESK}`, { as: who });
			expect(second.status).toBe(200);
			await second.text();
			// The allowance is spent: the picture itself is refused, by any way of asking for it,
			for (const headers of [
				undefined,
				{ "If-None-Match": "*" },
				{ "If-None-Match": '"another"' },
			]) {
				const refused = await call(app, "GET", `/media/${DESK}`, {
					as: who,
					headers,
				});
				expect(refused.status).toBe(429);
				expect(await refused.json()).toMatchObject({
					code: "rate_limited",
					surface: "media",
				});
			}
			// and the copy already held is still confirmed, and drawn.
			expect(
				(
					await call(app, "GET", `/media/${DESK}`, {
						as: who,
						headers: { "If-None-Match": etag },
					})
				).status,
			).toBe(304);
		} finally {
			await retuneLimits(undefined);
		}
	},
);

t.skipIf(!REDIS_AVAILABLE)(
	"a run past the day's allowance is refused, and a run the host turns away before it starts is not counted",
	async () => {
		const who = "account-chatter";
		await retuneLimits({ chat: { perDay: 2 } });
		try {
			// Neither is a turn: a body that is no run, and a thread that is somebody else's.
			for (const _ of [1, 2, 3]) {
				const invalid = await call(app, "POST", "/agent/run", {
					as: who,
					body: { threadId: "" },
				});
				expect(invalid.status).toBe(400);
			}
			expect((await turn("thread-1", "mine now?", who)).status).toBe(403);
			for (const text of ["one", "two"]) {
				const answered = await turn(`thread-${who}`, text, who);
				expect(answered.status).toBe(200);
				await answered.text();
			}
			const refused = await turn(`thread-${who}`, "three", who);
			expect(refused.status).toBe(429);
			expect(await refused.json()).toMatchObject({
				code: "rate_limited",
				surface: "chat",
			});
		} finally {
			await retuneLimits(undefined);
		}
	},
);

t(
	"a record is read by kind and id, and refused on an unknown one or without an assertion",
	async () => {
		const one = await call(app, "GET", "/records/customer/halvard-logistics", {
			as: OWNER,
		});
		const card = (await one.json()) as { fields: unknown[]; links: unknown[] };
		expect(card).toMatchObject({
			kind: "customer",
			id: "halvard-logistics",
			name: "Halvard Logistics",
		});
		expect(card.fields).toContainEqual({ label: "Sector", value: "Logistics" });
		expect(card.links).toContainEqual({
			kind: "person",
			id: "ines-valverde",
			name: "Inés Valverde",
		});
		expect(
			(
				await call(app, "GET", "/records/asset/nope", {
					as: OWNER,
				})
			).status,
		).toBe(404);
		expect(
			(
				await call(app, "GET", "/records/thing/halvard-logistics", {
					as: OWNER,
				})
			).status,
		).toBe(404);
		expect(
			(await call(app, "GET", "/records/customer/halvard-logistics")).status,
		).toBe(401);
		const measure = "m".repeat(41);
		expect(
			(
				await call(
					app,
					"GET",
					`/records/customer/halvard-logistics/metrics/${measure}`,
					{ as: OWNER },
				)
			).status,
		).toBe(404);
	},
);

t(
	"a metrics call runs on the server and hands the model a series shaped for the chart",
	async () => {
		modelCalls = {
			name: METRICS,
			args: {
				record: { kind: "customer", id: "halvard-logistics" },
				measure: "revenue",
				period: "year",
			},
		};
		try {
			const res = await turn("thread-metrics", "How is revenue going?");
			expect(res.status).toBe(200);
			expect(await res.text()).toContain("forty-two");
		} finally {
			modelCalls = null;
		}
		const handedBack = JSON.stringify(latest()?.input);
		expect(handedBack).toContain("Halvard Logistics — revenue");
		expect(handedBack).toContain("kEUR");
		expect(handedBack).toContain("2025");
	},
);

t(
	"a stage control the client registered reaches the model, its call streams back as a tool call, and the stage's lines reach the prompt",
	async () => {
		modelCalls = { name: "showLibrary", args: { query: "onboarding" } };
		let text = "";
		try {
			const res = await call(app, "POST", "/agent/run", {
				as: OWNER,
				body: runBody("thread-stage", "What is there about onboarding?", {
					tools: STAGE_TOOLS.map(({ name, description, parameters }) => ({
						name,
						description,
						parameters,
					})),
					context: [
						{ description: UI_SURFACE_READABLE, value: "web" },
						{ description: "stage.empty", value: "nothing is up" },
					],
				}),
			});
			expect(res.status).toBe(200);
			text = await res.text();
		} finally {
			modelCalls = null;
		}
		const events = eventsOf(text);
		const calls = events.filter((e) => e.type === "TOOL_CALL_START");
		expect(calls.length).toBe(1);
		expect(calls[0]?.toolCallName).toBe("showLibrary");
		const args = events.find((e) => e.type === "TOOL_CALL_ARGS")?.delta;
		expect(JSON.parse(String(args))).toEqual({ query: "onboarding" });
		expect(events.at(-1)?.type).toBe("RUN_FINISHED");

		const tools = versionTools();
		for (const tool of STAGE_TOOLS) expect(tools).toContain(tool.name);
		expect(tools).toContain(KNOWLEDGE_SEARCH);
		const instructions = latest()?.instructions ?? "";
		expect(instructions).toContain("THE STAGE.");
		expect(instructions).toContain("- stage.empty: nothing is up");
		expect(instructions).not.toContain(UI_SURFACE_READABLE);
	},
);

t(
	"conversations are listed, read, renamed, opened by a live session, and deleted",
	async () => {
		const list = await call(app, "GET", "/conversations", {
			as: OWNER,
		});
		const { conversations } = (await list.json()) as {
			conversations: { id: string }[];
		};
		expect(conversations.map((c) => c.id)).toContain("thread-1");

		const read = await call(app, "GET", "/conversations/thread-1", {
			as: OWNER,
		});
		const thread = (await read.json()) as {
			messages: { role: string; parts: { type: string; text?: string }[] }[];
		};
		expect(thread.messages.map((m) => m.role)).toEqual(["user", "assistant"]);
		expect(thread.messages[0]?.parts).toEqual([
			{ type: "text", text: "Where is the map?" },
		]);

		const renamed = await call(app, "PATCH", "/conversations/thread-1", {
			as: OWNER,
			body: { title: " Maps " },
		});
		expect(await renamed.json()).toEqual({ id: "thread-1", title: "Maps" });

		expect(
			await spokenThread(OWNER, "thread-voice", [
				{ role: "user", text: "Can you hear me?" },
			]),
		).toMatchObject({ written: 1 });
		// Named on the server once the session settles, from what was said in it.
		await host.titles.flush();
		const voiceThread = await host.readThread(resourceId, "thread-voice");
		expect(voiceThread?.title).toBe("Maps of the old town");
		expect(
			(
				await call(app, "DELETE", "/conversations/thread-voice", {
					as: OWNER,
				})
			).status,
		).toBe(204);
		expect(
			(
				await call(app, "GET", "/conversations/thread-voice", {
					as: OWNER,
				})
			).status,
		).toBe(404);
	},
);

t(
	"a picture is served by its path to a reader its blob admits, streamed and inert; a path that is not one plain picture of a library, or not theirs, is refused",
	async () => {
		const served = await call(app, "GET", `/media/${DESK}`, { as: OWNER });
		expect(served.status).toBe(200);
		expect(served.headers.get("content-type")).toBe("image/png");
		// Asked again on every draw, and never kept by a shared cache.
		expect(served.headers.get("cache-control")).toBe("private, no-cache");
		expect(served.headers.get("content-security-policy")).toBe(
			"default-src 'none'; sandbox",
		);
		expect(served.headers.get("x-content-type-options")).toBe("nosniff");
		expect(new Uint8Array(await served.arrayBuffer())).toEqual(PNG);

		// The copy a browser holds is named by the content, and is not sent again while it stands:
		const etag = served.headers.get("etag");
		expect(etag).toMatch(/^"[A-Za-z0-9+/=]+"$/);
		const again = await call(app, "GET", `/media/${DESK}`, {
			as: OWNER,
			headers: { "If-None-Match": `W/${etag}, "another"` },
		});
		expect(again.status).toBe(304);
		expect(again.headers.get("etag")).toBe(etag);
		expect(again.headers.get("cache-control")).toBe("private, no-cache");
		expect(await again.text()).toBe("");
		// and another copy is answered whole.
		const other = await call(app, "GET", `/media/${DESK}`, {
			as: OWNER,
			headers: { "If-None-Match": '"another"' },
		});
		expect(other.status).toBe(200);
		expect(new Uint8Array(await other.arrayBuffer())).toEqual(PNG);
		// `*` names no copy: it is a request for the picture, answered whole.
		const any = await call(app, "GET", `/media/${DESK}`, {
			as: OWNER,
			headers: { "If-None-Match": "*" },
		});
		expect(any.status).toBe(200);
		expect(new Uint8Array(await any.arrayBuffer())).toEqual(PNG);

		// The blob is asked about once, for who may see it and for its validator both: once more only to send it.
		const objects = knowledge.store.objects;
		const read = objects.get.bind(objects);
		let reads = 0;
		objects.get = (key) => {
			if (key === DESK) reads++;
			return read(key);
		};
		try {
			await call(app, "GET", `/media/${DESK}`, {
				as: OWNER,
				headers: { "If-None-Match": String(etag) },
			});
			expect(reads).toBe(1);
			await (await call(app, "GET", `/media/${DESK}`, { as: OWNER })).text();
			expect(reads).toBe(3);
			// A copy named that is no longer the content is asked about once too, then sent.
			await (
				await call(app, "GET", `/media/${DESK}`, {
					as: OWNER,
					headers: { "If-None-Match": '"another"' },
				})
			).text();
			expect(reads).toBe(5);
		} finally {
			objects.get = read;
		}

		// A path that does not decode, hides a separator or names no library never reaches the store;
		// one that climbs is resolved by the URL itself before it arrives.
		for (const path of [
			`/media/${LIBRARY}/..%2F${DESK}`,
			`/media/${LIBRARY}/pictures%5Cdesk.png`,
			`/media/${LIBRARY}/pictures%2Fdesk.png`,
			`/media/${LIBRARY}/%E0%A4%A`,
			"/media/desk.png",
			"/media/",
		]) {
			const refused = await call(app, "GET", path, { as: OWNER });
			expect(refused.status, path).toBe(400);
			expect(await refused.json()).toEqual({ code: "invalid_path" });
		}

		// A document, a manifest, a picture nobody described, or nothing at all: one answer.
		knowledge.store.put(`${LIBRARY}/pictures/stray.png`, PNG, {
			contentType: "image/png",
		});
		for (const path of [
			`${LIBRARY}/handbook.md`,
			`${LIBRARY}/access.json`,
			`${LIBRARY}/pictures/stray.png`,
			`${LIBRARY}/pictures/absent.png`,
		]) {
			const absent = await call(app, "GET", `/media/${path}`, { as: OWNER });
			expect(absent.status, path).toBe(404);
			expect(await absent.json()).toEqual({ code: "not_found" });
		}

		documents.access = { enforceAccessControl: true };
		resetAccessSettings();
		try {
			await signInOwner(["g-1"]);
			const outsider = await call(app, "GET", `/media/${MINUTES_PICTURE}`, {
				as: OWNER,
			});
			expect(outsider.status).toBe(404);
			expect(await outsider.json()).toEqual({ code: "not_found" });
			// Holding a copy is not being allowed to see it: who may is asked before the copy is.
			expect(
				(
					await call(app, "GET", `/media/${MINUTES_PICTURE}`, {
						as: OWNER,
						headers: { "If-None-Match": "*" },
					})
				).status,
			).toBe(404);
			await signInOwner(["g-9"]);
			expect(
				(await call(app, "GET", `/media/${MINUTES_PICTURE}`, { as: OWNER }))
					.status,
			).toBe(200);
		} finally {
			await signInOwner(["g-1"]);
			documents.access = { enforceAccessControl: false };
			resetAccessSettings();
		}

		// Only a raster leaves, whatever a blob's type was rewritten to after the load.
		const desk = knowledge.store.objects.get(DESK);
		if (!desk) throw new Error("the desk picture was not loaded");
		desk.contentType = "image/svg+xml";
		try {
			const svg = await call(app, "GET", `/media/${DESK}`, { as: OWNER });
			expect(svg.status).toBe(415);
			expect(await svg.json()).toEqual({ code: "unsupported_type" });
		} finally {
			desk.contentType = "image/png";
		}
		expect((await call(app, "GET", `/media/${DESK}`)).status).toBe(401);
	},
);

/** A browser's live socket to the listener, as the frontend relays it: under the caller's assertion. */
async function liveSocket(as: string) {
	const { token } = await callerAssertion.mint(claimsFor(as));
	return openBrowserSocket(`ws://127.0.0.1:${listener.port}/voice/live`, {
		headers: { authorization: `Bearer ${token}` },
	});
}

const message =
	<T extends ServerMessage["type"]>(type: T) =>
	(m: ServerMessage): m is Extract<ServerMessage, { type: T }> =>
		m.type === type;

t(
	"the live route answers only an upgrade, and the gate answers before any upgrade",
	async () => {
		const plain = await call(app, "GET", "/voice/live", { as: OWNER });
		expect(plain.status).toBe(426);
		expect(await plain.json()).toEqual({ code: "upgrade_required" });
		// No caller, no socket: the gate answers before any upgrade.
		expect(
			(await fetch(`http://127.0.0.1:${listener.port}/voice/live`)).status,
		).toBe(401);
	},
);

t(
	"a live session on one socket: the start, the person's audio relayed, their search run on the server as them, a stage control there and back, a typed turn meanwhile busy, and the spoken turns in the thread when it ends",
	async () => {
		const capability = await call(app, "GET", "/voice/capability", {
			as: SPEAKER,
		});
		expect(await capability.json()).toEqual({ live: REDIS_AVAILABLE });
		if (!REDIS_AVAILABLE) return;
		// Their own account, so what the session leaves remembered is nobody else's test.
		expect((await signIn(SPEAKER, "Sam", [])).status).toBe(200);
		const browser = await liveSocket(SPEAKER);
		browser.send({ type: "start", threadId: "thread-live" });
		const ready = await browser.next(message("ready"));
		expect(ready.language).toBe("en");
		expect(ready.audio.sampleRate).toBe(24_000);
		const { id } = ready.session;
		const upgrade = voiceAgent.upgrades.at(-1);
		expect(upgrade?.url.searchParams.get("agent_session_id")).toBe(id);
		expect(upgrade?.url.searchParams.get("transport")).toBe("websocket");
		expect(
			JSON.parse(upgrade?.headers.get("x-ms-voice-structured-inputs") ?? "{}")
				.language,
		).toBe("en");
		browser.sendAudio(new Uint8Array(4_800));
		await until(async () => voiceAgent.appended() >= 4_800);

		// One channel at a time: the typed turn is the safeguard's to refuse.
		const typed = await turn("thread-live", "and typing too?", SPEAKER);
		expect(typed.status).toBe(409);
		expect(await typed.json()).toEqual({ code: "thread.busy" });

		const played = voiceAgent.play({
			heard: "Find the onboarding handbook.",
			calls: [
				{ name: KNOWLEDGE_SEARCH, arguments: { query: "handbook" } },
				{ name: "openDocument", arguments: { id: HANDBOOK } },
			],
			answer: "The onboarding handbook is open: collect your badge first.",
		});
		const stage = await browser.next(message("stage-call"));
		expect(stage).toMatchObject({
			name: "openDocument",
			args: { id: HANDBOOK },
		});
		browser.send({
			type: "tool-output",
			callId: stage.callId,
			output: "The handbook is open.",
		});
		await played;
		const searched = voiceAgent.received.find(
			(e) =>
				e.type === "conversation.item.create" &&
				(e.item as { call_id?: string }).call_id === "call_1_0",
		)?.item as { output: string } | undefined;
		expect(searched?.output).toContain("collect your badge");
		await browser.next((m) => m.type === "line" && m.role === "assistant");
		expect(browser.audioBytes()).toBeGreaterThan(0);

		browser.send({ type: "end" });
		expect(await browser.next(message("ended"))).toEqual({
			type: "ended",
			reason: "client",
			written: 2,
		});
		expect((await browser.closed).code).toBe(1000);

		const thread = await call(app, "GET", "/conversations/thread-live", {
			as: SPEAKER,
		});
		const said = JSON.stringify(await thread.json());
		expect(said).toContain("Find the onboarding handbook.");
		expect(said).toContain("collect your badge first");
		// The thread is the typed channel's again.
		expect((await turn("thread-live", "thanks", SPEAKER)).status).toBe(200);
	},
);

t(
	"voice tuning is a tester's alone, checked whole, kept on their account and never in the shared documents, and their next session opens with it",
	async () => {
		const tuning = (as: string, body?: unknown) =>
			body === undefined
				? call(app, "GET", "/voice/tuning", { as })
				: call(app, "PUT", "/voice/tuning", { as, body });
		expect((await signIn(SPEAKER, "Sam", [])).status).toBe(200);
		for (const answer of [
			await tuning(SPEAKER),
			await tuning(SPEAKER, { engine: "cascade" }),
		]) {
			expect(answer.status).toBe(403);
			expect(await answer.json()).toEqual({ code: "forbidden" });
		}
		expect((await getAccount(SPEAKER))?.voiceTuning).toBeNull();

		expect((await signIn(TESTER, "Tess", [], ["user", "tester"])).status).toBe(
			200,
		);
		const shared = JSON.stringify(documents);
		const seen = await tuning(TESTER);
		expect(seen.status).toBe(200);
		const view = (await seen.json()) as {
			tuning: unknown;
			effective: Record<string, unknown>;
			choices: { noiseReductions: string[] };
		};
		expect(view.tuning).toEqual({});
		// No realtime deployment here: the cascade runs, and says so.
		expect(view.effective.engine).toBe("cascade");
		expect(view.choices.noiseReductions).not.toContain("near_field");

		// An invalid noise type would run a session without its instructions: refused, never stored.
		const refused = await tuning(TESTER, {
			engine: "cascade",
			noiseReduction: "near_field",
		});
		expect(refused.status).toBe(400);
		expect(await refused.json()).toEqual({
			code: "invalid_body",
			field: "noiseReduction",
		});
		// With no realtime deployment, speech-to-speech runs on a managed model or not at all.
		expect(
			(
				await tuning(TESTER, {
					engine: "speechToSpeech",
					modelSource: "deployment",
				})
			).status,
		).toBe(400);
		// An OpenAI voice is speech-to-speech's alone: the cascade refuses one, so it never reaches the service.
		const openai = await tuning(TESTER, { voice: "marin" });
		expect(openai.status).toBe(400);
		expect(await openai.json()).toEqual({
			code: "invalid_body",
			field: "voice",
		});
		expect((await getAccount(TESTER))?.voiceTuning).toBeNull();

		const saved = await tuning(TESTER, {
			noiseReduction: "azure_deep_noise_suppression",
			silenceMs: 700,
			interimResponses: false,
		});
		expect(saved.status).toBe(200);
		expect(
			((await saved.json()) as { effective: Record<string, unknown> })
				.effective,
		).toMatchObject({
			noiseReduction: "azure_deep_noise_suppression",
			silenceMs: 700,
			interimResponses: false,
		});
		expect((await getAccount(TESTER))?.voiceTuning).toEqual({
			noiseReduction: "azure_deep_noise_suppression",
			silenceMs: 700,
			interimResponses: false,
		});
		// The documents every other session reads are as they were.
		expect(JSON.stringify(documents)).toBe(shared);
		resetAgentSettings();
		expect((await agentSettings()).voice.noiseReduction).toBe(
			DEFAULT_AGENT_SETTINGS.voice.noiseReduction,
		);

		if (REDIS_AVAILABLE) {
			const browser = await liveSocket(TESTER);
			browser.send({ type: "start", threadId: "thread-tuned" });
			await browser.next(message("ready"));
			const update = voiceAgent.received.findLast(
				(e) => e.type === "session.update",
			) as { session: Record<string, unknown> } | undefined;
			const input =
				(update?.session.audio as { input?: Record<string, unknown> })?.input ??
				{};
			// How the session hears is the version's: a session cannot change it.
			expect(input).not.toHaveProperty("noise_reduction");
			expect(input).not.toHaveProperty("turn_detection");
			expect(update?.session).not.toHaveProperty("interim_response");
			// Fillers off, the noise suppression and the timer make a version of their own.
			const tuned = voiceAgent.upgrades
				.at(-1)
				?.url.searchParams.get("x-agent-version-override");
			const untuned = voiceAgent.upgrades
				.at(0)
				?.url.searchParams.get("x-agent-version-override");
			expect(tuned).not.toBe(untuned);
			const definition = [...foundry.state.agents.values()]
				.flat()
				.find((v) => v.version === tuned && v.definition.kind === "voice")
				?.definition as
				| { audio: { input: Record<string, unknown> } }
				| undefined;
			expect(definition?.audio.input.noise_reduction).toEqual({
				type: "azure_deep_noise_suppression",
			});
			expect(definition?.audio.input.turn_detection).toMatchObject({
				silence_duration_ms: 700,
			});
			browser.send({ type: "end" });
			await browser.next(message("ended"));
		}

		// Cleared, the account holds nothing.
		expect((await tuning(TESTER, {})).status).toBe(200);
		expect((await getAccount(TESTER))?.voiceTuning).toBeNull();
	},
);

t(
	"standing is re-read at the point of use: a deactivated account cannot spend, and keeps its rights",
	async () => {
		await setAccountDisabled(OWNER, true);
		try {
			const spend = await turn("thread-2", "still there?");
			expect(spend.status).toBe(403);
			expect(await spend.json()).toEqual({ code: "account_deactivated" });
			for (const path of [
				"/library?query=handbook",
				"/library",
				"/voice/live",
				"/voice/tuning",
				"/records",
				"/records/customer/halvard-logistics",
				`/media/${DESK}`,
			]) {
				const shut = await call(app, "GET", path, { as: OWNER });
				expect(shut.status, path).toBe(403);
				expect(await shut.json()).toEqual({ code: "account_deactivated" });
			}
			const me = await call(app, "GET", "/identity/me", { as: OWNER });
			expect(((await me.json()) as { standing: unknown }).standing).toEqual({
				status: 403,
				code: "account_deactivated",
			});
			expect(
				(await call(app, "GET", "/account/export", { as: OWNER })).status,
			).toBe(200);
		} finally {
			await setAccountDisabled(OWNER, false);
		}
	},
);

t(
	"erasing a deactivated account takes the person's words and leaves it deactivated: neither the next spend nor the next sign-in gets back in",
	async () => {
		const who = "account-shut";
		expect((await signIn(who, "Shut", ["g-1"], ["premium"])).status).toBe(200);
		await call(app, "PATCH", "/identity/me", {
			as: who,
			body: { about: "Mine to take back." },
		});
		await setAccountDisabled(who, true);
		expect((await call(app, "DELETE", "/account", { as: who })).status).toBe(
			204,
		);
		expect(await getAccount(who)).toMatchObject({
			id: who,
			disabled: true,
			email: null,
			name: null,
			about: null,
			roles: [],
			groups: [],
		});
		// The erase ended the account's sessions, as any erase does: what is left is nobody's to read or write.
		for (const [method, path, body] of [
			["POST", "/agent/run", {}],
			["GET", "/records", undefined],
			["GET", "/account/export", undefined],
			["DELETE", "/identity/me/memory", undefined],
			["PUT", "/voice/tuning", { tuning: { engine: "cascade" } }],
			[
				"PATCH",
				"/identity/me",
				{ name: "Back", about: "Written after the erase." },
			],
		] as const) {
			const refused = await call(app, method, path, { as: who, body });
			expect(refused.status, `${method} ${path}`).toBe(401);
			expect(await refused.json()).toEqual({ code: "account_erased" });
		}
		const again = await signIn(who, "Shut", ["g-1"], ["premium"]);
		expect(await again.json()).toEqual({ ok: false, reason: "deactivated" });
		// Asking for the erase again is answered as the first was, and changes nothing.
		expect((await call(app, "DELETE", "/account", { as: who })).status).toBe(
			204,
		);
		const left = await cosmos.database.container("accounts").read(who, who);
		expect(left).toMatchObject({
			disabled: true,
			email: null,
			name: null,
			about: null,
			preferences: null,
			roles: [],
			groups: [],
			voiceTuning: null,
			createdAt: null,
			lastLoginAt: null,
			ttl: -1,
		});
	},
);

t(
	"what is remembered is the person's to read, correct and forget, a statement at a time or all at once, and nobody else's to touch",
	async () => {
		const res = await turn("thread-memory", "I am Ada, remember that.");
		expect(res.status).toBe(200);
		await res.text();
		const remembered = async () =>
			(
				(await (
					await call(app, "GET", "/identity/me/memory", { as: OWNER })
				).json()) as {
					items: { id: string; content: string; updatedAt: string }[];
				}
			).items;
		await until(async () => (await remembered()).length > 0);
		const [item] = await remembered();
		expect(item).toMatchObject({ content: "Goes by Ada." });
		expect(Number.isNaN(Date.parse(item?.updatedAt ?? ""))).toBe(false);
		const id = item?.id ?? "-";

		const corrected = "Goes by Ada, not Adeline.";
		const patched = await call(app, "PATCH", `/identity/me/memory/${id}`, {
			as: OWNER,
			body: { content: corrected },
		});
		expect(patched.status).toBe(200);
		expect(await patched.json()).toMatchObject({ id, content: corrected });
		for (const body of [{}, { content: 42 }, { content: null }, "not json"]) {
			const refused = await call(app, "PATCH", `/identity/me/memory/${id}`, {
				as: OWNER,
				body,
			});
			expect(refused.status).toBe(400);
			expect(await refused.json()).toEqual({ code: "invalid_body" });
		}
		// Another account reaches none of it, by any verb.
		expect(
			(
				await call(app, "PATCH", `/identity/me/memory/${id}`, {
					as: OTHER,
					body: { content: "mine now" },
				})
			).status,
		).toBe(404);
		expect(
			(await call(app, "DELETE", `/identity/me/memory/${id}`, { as: OTHER }))
				.status,
		).toBe(404);
		expect(
			await (
				await call(app, "GET", "/identity/me/memory", { as: OTHER })
			).json(),
		).toEqual({ items: [] });

		const next = await turn("thread-memory", "And the maps?");
		await next.text();
		expect(latest()?.instructions).toContain(corrected);
		expect(
			extractor.handed.some((handed) => handed.includes("remember that")),
		).toBe(true);

		expect(
			(await call(app, "DELETE", `/identity/me/memory/${id}`, { as: OWNER }))
				.status,
		).toBe(204);
		expect(
			(await call(app, "DELETE", `/identity/me/memory/${id}`, { as: OWNER }))
				.status,
		).toBe(404);
		await (await turn("thread-memory", "Ada, once more.")).text();
		await until(async () => (await remembered()).length > 0);
		expect(
			(await call(app, "DELETE", "/identity/me/memory", { as: OWNER })).status,
		).toBe(204);
		expect(await remembered()).toEqual([]);

		// Remembered again, for the export and the erase to find.
		await (await turn("thread-memory", "Ada again.")).text();
		await until(async () => (await remembered()).length > 0);
	},
);

t(
	"a conversation is named on the server once a turn in it settles, and a name given by hand stands",
	async () => {
		await host.titles.flush();
		expect((await host.readThread(resourceId, "thread-memory"))?.title).toBe(
			"Maps of the old town",
		);
		await call(app, "PATCH", "/conversations/thread-memory", {
			as: OWNER,
			body: { title: "Chosen by hand" },
		});
		await (await turn("thread-memory", "One more thing.")).text();
		await host.titles.flush();
		expect((await host.readThread(resourceId, "thread-memory"))?.title).toBe(
			"Chosen by hand",
		);
	},
);

t(
	"the export carries the account — the person's fields and what the assistant remembers — and every conversation",
	async () => {
		const res = await call(app, "GET", "/account/export", { as: OWNER });
		expect(res.status).toBe(200);
		expect(res.headers.get("content-disposition")).toContain("attachment");
		const body = (await res.json()) as {
			format: string;
			account: {
				id: string;
				email: string;
				name: string;
				about: string;
				preferences: string;
				memory: { id: string; content: string; updatedAt: string }[];
			};
			conversations: { id: string; messages: unknown[] }[];
		};
		expect(body.format).toBe("personal-data-export/3");
		expect(body.account).toMatchObject({
			id: OWNER,
			email: "ada@example.com",
			name: "Ada",
			about: "I collect maps.",
			preferences: "Answer briefly.",
		});
		expect(body.account.memory.map((m) => m.content)).toEqual(["Goes by Ada."]);
		expect(Object.keys(body)).toEqual([
			"format",
			"exportedAt",
			"account",
			"conversations",
		]);
		const first = body.conversations.find((c) => c.id === "thread-1");
		expect(first?.messages.length).toBe(2);
		expect(body.conversations.map((c) => c.id)).toContain("thread-memory");
	},
);

t(
	"the export carries every conversation past a page of them, each once, while the picker shows its window",
	async () => {
		const many = THREAD_PAGE_MAX + 5;
		for (let i = 0; i < many; i++)
			expect(
				await spokenThread(OTHER, `thread-many-${i}`, [
					{ role: "user", text: `Conversation ${i}` },
				]),
			).toMatchObject({ written: 1 });
		const res = await call(app, "GET", "/account/export", { as: OTHER });
		const { conversations } = (await res.json()) as {
			conversations: { id: string }[];
		};
		const ids = conversations.map((c) => c.id);
		expect(new Set(ids).size).toBe(ids.length);
		for (let i = 0; i < many; i++) expect(ids).toContain(`thread-many-${i}`);

		const picker = await call(app, "GET", "/conversations", { as: OTHER });
		const listed = (await picker.json()) as { conversations: unknown[] };
		expect(listed.conversations.length).toBe(LIST_LIMIT);
	},
	// A page and more of threads, each written and then exported: on the emulator, longer than the runner's default.
	HOOK_BUDGET_MS,
);

t(
	"the export carries the whole of a conversation longer than one read of it, oldest first, while the thread view shows its newest",
	async () => {
		const lines = ["One.", "Two.", "Three.", "Four.", "Five."];
		await spokenThread(
			OTHER,
			"thread-long",
			lines.map((text) => ({ role: "user" as const, text })),
		);
		const saved = documents.agent;
		documents.agent = { ...(saved as object), foundry: { maxItemsRead: 2 } };
		resetAgentSettings();
		type Read = { messages: { parts: { text?: string }[] }[] };
		const texts = (thread: Read | undefined) =>
			thread?.messages.map((m) => m.parts[0]?.text);
		try {
			const view = await call(app, "GET", "/conversations/thread-long", {
				as: OTHER,
			});
			expect(texts((await view.json()) as Read)).toEqual(["Four.", "Five."]);
			const res = await call(app, "GET", "/account/export", { as: OTHER });
			const { conversations } = (await res.json()) as {
				conversations: (Read & { id: string })[];
			};
			expect(texts(conversations.find((c) => c.id === "thread-long"))).toEqual(
				lines,
			);
		} finally {
			documents.agent = saved;
			resetAgentSettings();
		}
	},
);

t(
	"DELETE /account that the service fails part way says the erase is incomplete and leaves the row shut for the next ask to finish",
	async () => {
		// The memory's forget fails: the threads are gone, the account's row is not.
		const real = cosmosDatabase();
		setCosmosDatabase({
			verify: (d) => real.verify(d),
			container: (name) =>
				name === "memory"
					? {
							...real.container(name),
							query: async () => {
								throw new Error("the account is throttled");
							},
						}
					: real.container(name),
		});
		const quiet = spyOn(console, "error").mockImplementation(() => {});
		try {
			const res = await call(app, "DELETE", "/account", { as: OWNER });
			expect(res.status).toBe(503);
			expect(await res.json()).toEqual({ code: "erase_incomplete" });
		} finally {
			setCosmosDatabase(real);
			quiet.mockRestore();
		}
		// The first write shut the row and the sweep that failed let it go: nothing is read or made under the id, and the next ask takes the erase up.
		expect(await getAccount(OWNER)).toBeNull();
		expect(
			await cosmos.database.container("accounts").read(OWNER, OWNER),
		).toMatchObject({ erasingBy: null, about: null });
		expect(
			(await call(app, "GET", "/conversations", { as: OWNER })).status,
		).toBe(401);
	},
);

t(
	"DELETE /account leaves nothing: rows, threads and every message of their history, what is remembered, and every cached copy — and a second delete is clean",
	async () => {
		const res = await call(app, "DELETE", "/account", { as: OWNER });
		expect(res.status).toBe(204);

		expect(await getAccount(OWNER)).toBeNull();
		expect((await host.listThreads(resourceId)).threads).toEqual([]);
		expect(await host.readMemory(resourceId)).toEqual({ items: [] });
		expect(
			await cosmos.database
				.container("memory")
				.query({ query: "SELECT * FROM c" }, resourceId),
		).toEqual([]);
		// Every message the owner had is gone from the history, and the service was never given one to keep.
		expect(
			await cosmos.database
				.container("messages")
				.query({ query: "SELECT * FROM c" }, resourceId),
		).toEqual([]);
		expect(foundry.turns().every((turn) => turn.body.store === false)).toBe(
			true,
		);
		for (const cache of [
			host.caches.memory,
			host.caches.person,
			host.caches.stamps,
		])
			expect(await cache.read(resourceId)).toBeNull();
		if (REDIS_AVAILABLE) {
			// Every memo about the person is gone. What may remain under the
			// namespace is a metering bucket, which carries a TTL.
			const keys = await ownerKeys();
			expect(keys.filter((k) => k.includes(":memo:"))).toEqual([]);
			const redis = await getRedis();
			for (const key of keys)
				expect(Number(await redis?.send("TTL", [key]))).toBeGreaterThan(0);
		}
		// The session that asked is over with the account: it reads nothing.
		const after = await call(app, "GET", "/identity/me", { as: OWNER });
		expect(after.status).toBe(401);
		expect(await after.json()).toEqual({ code: "account_erased" });
		// Asking for the erase again, its answer lost, is answered as the first was, by steps that find nothing.
		expect((await call(app, "DELETE", "/account", { as: OWNER })).status).toBe(
			204,
		);
		expect(await getAccount(OWNER)).toBeNull();
	},
);

/** The database with the accounts container's reads, or its erase, failing. */
function failingAccounts(
	what: "read" | "batch",
): ReturnType<typeof cosmosDatabase> {
	const database = cosmos.database;
	return {
		...database,
		container(name) {
			const container = database.container(name);
			if (name !== "accounts") return container;
			return new Proxy(container, {
				get(target, property, receiver) {
					if (property === what)
						return async () => {
							throw new Error("the store did not answer");
						};
					return Reflect.get(target, property, receiver);
				},
			});
		},
	};
}

t(
	"a caller whose row cannot be read is refused on every route but the sign-in report and the warm-up: a session its account's erase ended is never let through on a guess",
	async () => {
		const who = "account-unread";
		const began = Math.floor(Date.now() / 1000) - 5 * 60;
		const before = { ...claimsFor(who), signedInAt: began };
		expect((await signIn(who, "First", [])).status).toBe(200);
		expect((await call(app, "DELETE", "/account", { as: before })).status).toBe(
			204,
		);
		// The id is a new person's now; the old session is still open on another device.
		expect((await signIn(who, "Second", [])).status).toBe(200);
		const after = claimsFor(who);
		await call(app, "PATCH", "/identity/me", {
			as: after,
			body: { about: "The second person's." },
		});

		const loud = spyOn(console, "error").mockImplementation(() => {});
		setCosmosDatabase(failingAccounts("read"));
		try {
			for (const [method, path, body] of [
				["PATCH", "/identity/me", { about: "Written by the first." }],
				["GET", "/identity/me", undefined],
				["GET", "/account/export", undefined],
				["DELETE", "/account", undefined],
				["GET", "/conversations", undefined],
				["DELETE", "/identity/me/memory", undefined],
				["GET", "/voice/capability", undefined],
				["GET", "/records", undefined],
			] as const) {
				const refused = await call(app, method, path, { as: before, body });
				expect(refused.status, `${method} ${path}`).toBe(503);
				expect(await refused.json()).toEqual({ code: "account_unavailable" });
			}
			// Nothing of a person is read or written by the warm-up, so it asks for no row.
			expect((await call(app, "GET", "/warm", { as: before })).status).toBe(
				204,
			);
		} finally {
			setCosmosDatabase(cosmos.database);
			loud.mockRestore();
		}
		// The second person's account is as they left it.
		expect(await getAccount(who)).toMatchObject({
			name: "Second",
			about: "The second person's.",
		});
		// With the row readable again the old session is over, for the erase too: the account under the id is not its own.
		for (const [method, path] of [
			["DELETE", "/account"],
			["GET", "/account/export"],
		] as const) {
			const refused = await call(app, method, path, { as: before });
			expect(refused.status, `${method} ${path}`).toBe(401);
			expect(await refused.json()).toEqual({ code: "account_erased" });
		}
		expect(await getAccount(who)).toMatchObject({ name: "Second" });
	},
);

t(
	"an erase whose last write fails is a 503 the same session retries to a clean 204",
	async () => {
		const who = "account-retried";
		expect((await signIn(who, "Retried", [])).status).toBe(200);
		const session = claimsFor(who);
		await call(app, "PATCH", "/identity/me", {
			as: session,
			body: { about: "Until the erase finishes." },
		});
		const loud = spyOn(console, "error").mockImplementation(() => {});
		setCosmosDatabase(failingAccounts("batch"));
		try {
			const refused = await call(app, "DELETE", "/account", { as: session });
			expect(refused.status).toBe(503);
			expect(await refused.json()).toEqual({ code: "erase_incomplete" });
		} finally {
			setCosmosDatabase(cosmos.database);
			loud.mockRestore();
		}
		// The row was written whole or not at all: it is a person's still, so the session is not over.
		expect(await getAccount(who)).toMatchObject({
			about: "Until the erase finishes.",
		});
		expect(
			(await call(app, "DELETE", "/account", { as: session })).status,
		).toBe(204);
		expect(await getAccount(who)).toBeNull();
		expect(
			await cosmos.database.container("accounts").read(who, who),
		).toMatchObject({ about: null, email: null });
	},
);

t(
	"a session that began before its account was erased is over on every route, and a sign-in after the erase is a new person's",
	async () => {
		const who = "account-erased";
		const began = Math.floor(Date.now() / 1000) - 5 * 60;
		const before = { ...claimsFor(who), signedInAt: began };
		expect((await signIn(who, "Edsger", [])).status).toBe(200);
		await call(app, "PATCH", "/identity/me", {
			as: before,
			body: { about: "Gone with the account." },
		});
		expect((await call(app, "GET", "/records", { as: before })).status).toBe(
			200,
		);
		expect((await call(app, "DELETE", "/account", { as: before })).status).toBe(
			204,
		);

		// A second device's session, older than the erase: a spend, a live voice start, a read and an edit.
		for (const [method, path, body] of [
			["POST", "/agent/run", {}],
			["GET", "/voice/live", undefined],
			["GET", "/records", undefined],
			["GET", "/conversations", undefined],
			["PATCH", "/identity/me", { about: "Written after the erase." }],
			["DELETE", "/identity/me/memory", undefined],
			["GET", "/account/export", undefined],
		] as const) {
			const refused = await call(app, method, path, { as: before, body });
			expect(refused.status, `${method} ${path}`).toBe(401);
			expect(await refused.json()).toEqual({ code: "account_erased" });
		}
		expect(await getAccount(who)).toBeNull();
		expect(
			await cosmos.database
				.container("memory")
				.query({ query: "SELECT * FROM c" }, who),
		).toEqual([]);

		// The same id signs in again: a new account, with nothing of the old one.
		expect((await signIn(who, "Edsger", [])).status).toBe(200);
		const after = claimsFor(who);
		const me = await call(app, "GET", "/identity/me", { as: after });
		expect(me.status).toBe(200);
		expect(await me.json()).toMatchObject({ name: "Edsger", about: null });
		expect((await call(app, "GET", "/records", { as: after })).status).toBe(
			200,
		);
		// The old session is still the erased person's, whoever holds the id now.
		const stale = await call(app, "GET", "/records", { as: before });
		expect(stale.status).toBe(401);
		expect(
			(
				await call(app, "PATCH", "/identity/me", {
					as: before,
					body: { about: "Not mine to write." },
				})
			).status,
		).toBe(401);
		expect((await getAccount(who))?.about).toBeNull();
	},
);

t(
	"an erase asked for again by the session it ended does nothing, and never reaches the account a sign-in made since",
	async () => {
		const who = "account-erased-twice";
		const began = Math.floor(Date.now() / 1000) - 5 * 60;
		const before = { ...claimsFor(who), signedInAt: began };
		expect((await signIn(who, "First", [])).status).toBe(200);
		const swept = spyOn(host, "eraseResource");
		try {
			expect(
				(await call(app, "DELETE", "/account", { as: before })).status,
			).toBe(204);
			expect(swept).toHaveBeenCalledTimes(1);
			// The answer was lost, say: asked again, it is the same answer, and nothing is swept or written a second time.
			const marker = await cosmos.database.container("accounts").read(who, who);
			expect(
				(await call(app, "DELETE", "/account", { as: before })).status,
			).toBe(204);
			expect(swept).toHaveBeenCalledTimes(1);
			expect(
				await cosmos.database.container("accounts").read(who, who),
			).toEqual(marker);

			// The person signs in again and writes; the old session's next ask is refused, and the new account is whole.
			expect((await signIn(who, "Second", [])).status).toBe(200);
			const after = claimsFor(who);
			await call(app, "PATCH", "/identity/me", {
				as: after,
				body: { about: "The second person's." },
			});
			const refused = await call(app, "DELETE", "/account", { as: before });
			expect(refused.status).toBe(401);
			expect(await refused.json()).toEqual({ code: "account_erased" });
			expect(swept).toHaveBeenCalledTimes(1);
			expect(await getAccount(who)).toMatchObject({
				name: "Second",
				about: "The second person's.",
			});
			expect((await call(app, "GET", "/records", { as: after })).status).toBe(
				200,
			);
		} finally {
			swept.mockRestore();
		}
	},
);

/** A turn run to its end, so what it writes is written: its status. */
async function said(threadId: string, who: string): Promise<number> {
	const res = await turn(threadId, "ciao", who);
	await res.text();
	return res.status;
}

/** The accounts container with `who`'s row read through `meanwhile` once, at its `nth` read: what lands between a request's read and its write. */
function racedAccounts(
	who: string,
	nth: number,
	meanwhile: () => Promise<void>,
): ReturnType<typeof cosmosDatabase> {
	const database = cosmos.database;
	let reads = 0;
	return {
		...database,
		container(name) {
			const container = database.container(name);
			if (name !== "accounts") return container;
			return new Proxy(container, {
				get(target, property, receiver) {
					if (property !== "read")
						return Reflect.get(target, property, receiver);
					return async (id: string, key: string) => {
						const found = await target.read(id, key);
						if (id === who && ++reads === nth) await meanwhile();
						return found;
					};
				},
			});
		},
	};
}

t(
	"an erase already past the gate when another finished and the person signed in again leaves the new account alone, swept nothing included",
	async () => {
		const who = "account-erased-raced";
		const began = Math.floor(Date.now() / 1000) - 5 * 60;
		const before = { ...claimsFor(who), signedInAt: began };
		expect((await signIn(who, "First", [])).status).toBe(200);
		const swept = spyOn(host, "eraseResource");
		let raced = false;
		// The session is the account's own at the gate (the first read). Before its erase reads the row to shut it (the second), the erase asked for on another device runs whole and the person signs in again, talks and writes.
		setCosmosDatabase(
			racedAccounts(who, 2, async () => {
				raced = true;
				setCosmosDatabase(cosmos.database);
				expect(
					(await call(app, "DELETE", "/account", { as: before })).status,
				).toBe(204);
				expect((await signIn(who, "Second", [])).status).toBe(200);
				const after = claimsFor(who);
				expect(await said("thread-second-person", who)).toBe(200);
				await call(app, "PATCH", "/identity/me", {
					as: after,
					body: { about: "The second person's." },
				});
			}),
		);
		try {
			const refused = await call(app, "DELETE", "/account", { as: before });
			expect(refused.status).toBe(401);
			expect(await refused.json()).toEqual({ code: "account_erased" });
		} finally {
			setCosmosDatabase(cosmos.database);
		}
		expect(raced).toBe(true);
		// One sweep, the other device's: the one refused never began.
		expect(swept).toHaveBeenCalledTimes(1);
		swept.mockRestore();
		expect(await getAccount(who)).toMatchObject({
			name: "Second",
			about: "The second person's.",
		});
		expect((await host.listThreads(who)).threads.map((t) => t.id)).toEqual([
			"thread-second-person",
		]);
		expect(
			(await call(app, "GET", "/records", { as: claimsFor(who) })).status,
		).toBe(200);
	},
);

t(
	"while an erase sweeps, the id is shut: another device's turn and a sign-in are refused, a second erase starts no second sweep, and the account made afterwards finds nothing",
	async () => {
		const who = "account-erased-shut";
		expect((await signIn(who, "First", [])).status).toBe(200);
		const session = claimsFor(who);
		expect(await said("thread-first-person", who)).toBe(200);
		const sweep = host.eraseResource.bind(host);
		let second: Promise<Response> | undefined;
		const swept = spyOn(host, "eraseResource").mockImplementation(
			async (resourceId) => {
				const result = await sweep(resourceId);
				// The sweep has run and the row is not finished: what lands now would be left under the erased id.
				const late = await turn("thread-under-the-sweep", "ciao", who);
				expect(late.status).toBe(401);
				expect(await late.json()).toEqual({ code: "account_erased" });
				const signedIn = await signIn(who, "Second", []);
				expect(await signedIn.json()).toEqual({
					ok: false,
					reason: "unavailable",
				});
				second = call(app, "DELETE", "/account", { as: session });
				return result;
			},
		);
		try {
			expect(
				(await call(app, "DELETE", "/account", { as: session })).status,
			).toBe(204);
			// The second ask waited for the first and is answered as it was.
			expect((await second)?.status).toBe(204);
			expect(swept).toHaveBeenCalledTimes(1);
		} finally {
			swept.mockRestore();
		}
		expect((await host.listThreads(who)).threads).toEqual([]);
		expect((await signIn(who, "Second", [])).status).toBe(200);
		const listed = await call(app, "GET", "/conversations", {
			as: claimsFor(who),
		});
		expect(await listed.json()).toMatchObject({ conversations: [] });
	},
);

t(
	"an erase whose sweep failed is finished by the person's next sign-in, which sweeps again and is a new account",
	async () => {
		const who = "account-erase-resumed";
		expect((await signIn(who, "First", [])).status).toBe(200);
		expect(await said("thread-left-behind", who)).toBe(200);
		const sweep = host.eraseResource.bind(host);
		let sweeps = 0;
		const swept = spyOn(host, "eraseResource").mockImplementation(
			async (resourceId) => {
				if (sweeps++ === 0) throw new Error("the service did not answer");
				return sweep(resourceId);
			},
		);
		const loud = spyOn(console, "error").mockImplementation(() => {});
		try {
			const refused = await call(app, "DELETE", "/account", {
				as: claimsFor(who),
			});
			expect(refused.status).toBe(503);
			expect((await host.listThreads(who)).threads).toHaveLength(1);
			const signedIn = await signIn(who, "Second", []);
			expect(await signedIn.json()).toMatchObject({ ok: true });
			expect(sweeps).toBe(2);
		} finally {
			swept.mockRestore();
			loud.mockRestore();
		}
		expect(await getAccount(who)).toMatchObject({
			name: "Second",
			about: null,
		});
		expect((await host.listThreads(who)).threads).toEqual([]);
	},
);

t(
	"a session from before an erase is over on the account made since, deactivated or not: it reads nothing, writes nothing and sweeps nothing",
	async () => {
		const who = "account-remade-shut";
		const began = Math.floor(Date.now() / 1000) - 5 * 60;
		const before = { ...claimsFor(who), signedInAt: began };
		expect((await signIn(who, "First", [])).status).toBe(200);
		expect((await call(app, "DELETE", "/account", { as: before })).status).toBe(
			204,
		);
		expect((await signIn(who, "Second", [])).status).toBe(200);
		const after = claimsFor(who);
		expect(await said("thread-second-kept", who)).toBe(200);
		expect(await setAccountDisabled(who, true)).toBe(true);
		const swept = spyOn(host, "eraseResource");
		try {
			for (const [method, path, body] of [
				["GET", "/account/export", undefined],
				["GET", "/identity/me", undefined],
				["PATCH", "/identity/me", { about: "The first person's words." }],
				["GET", "/identity/me/memory", undefined],
				["GET", "/conversations", undefined],
				["DELETE", "/account", undefined],
			] as const) {
				const refused = await call(app, method, path, { as: before, body });
				expect(`${method} ${path} ${refused.status}`).toBe(
					`${method} ${path} 401`,
				);
				expect(await refused.json()).toEqual({ code: "account_erased" });
			}
			expect(swept).not.toHaveBeenCalled();
		} finally {
			swept.mockRestore();
		}
		expect((await getAccount(who))?.about).toBeNull();
		expect((await host.listThreads(who)).threads.map((t) => t.id)).toEqual([
			"thread-second-kept",
		]);
		// The account's own session is a deactivated person's: shut out of the product, with its rights over what is held.
		expect((await call(app, "GET", "/records", { as: after })).status).toBe(
			403,
		);
		expect(
			(await call(app, "GET", "/account/export", { as: after })).status,
		).toBe(200);
	},
);

t(
	"on the service's conversations the export carries a thread whole, and DELETE /account reaches its conversation: a delete the service fails keeps the account to retry from, and the retry deletes every response, item and conversation",
	async () => {
		const who = "account-conversations";
		expect((await signIn(who, "Grace", [])).status).toBe(200);
		const saved = documents.agent;
		documents.agent = { ...(saved as object), history: { store: "foundry" } };
		resetAgentSettings();
		try {
			for (const said of ["The codename is Heron.", "And the second?"])
				expect(
					await (await turn("thread-conversation", said, who)).text(),
				).toContain("forty-two");
		} finally {
			documents.agent = saved;
			resetAgentSettings();
		}
		// Kept in the conversation: each response stored there, given only what is new.
		expect(latest()?.body).toMatchObject({ store: true });
		expect(JSON.stringify(latest()?.input)).not.toContain("Heron");
		const conversationId = String(latest()?.body.conversation);

		const exported = await call(app, "GET", "/account/export", { as: who });
		const { conversations } = (await exported.json()) as {
			conversations: {
				id: string;
				messages: { parts: { text?: string }[] }[];
			}[];
		};
		expect(
			conversations
				.find((c) => c.id === "thread-conversation")
				?.messages.map((m) => m.parts[0]?.text),
		).toEqual([
			"The codename is Heron.",
			"The answer is forty-two.",
			"And the second?",
			"The answer is forty-two.",
		]);

		foundry.failWhen(
			(method, path) => method === "DELETE" && path.includes("/conversations/"),
			500,
		);
		const loud = spyOn(console, "error").mockImplementation(() => {});
		try {
			const refused = await call(app, "DELETE", "/account", { as: who });
			expect(refused.status).toBe(503);
			expect(await refused.json()).toEqual({ code: "erase_incomplete" });
		} finally {
			foundry.failWhen(null);
			loud.mockRestore();
		}
		// The row is shut, and what the sweep did not reach is still there for the next ask.
		expect(await getAccount(who)).toBeNull();
		expect((await host.listThreads(who)).threads.map((t) => t.id)).toEqual([
			"thread-conversation",
		]);

		expect((await call(app, "DELETE", "/account", { as: who })).status).toBe(
			204,
		);
		expect(await getAccount(who)).toBeNull();
		expect((await host.listThreads(who)).threads).toEqual([]);
		expect(foundry.state.conversations.has(conversationId)).toBe(false);
		expect(foundry.state.items.get(conversationId)).toEqual([]);
		const deletes = foundry.deletes();
		// Both responses, asked again by the retry, which finds them already gone.
		expect(
			new Set(
				deletes.filter((d) => d.startsWith("DELETE /openai/v1/responses/")),
			).size,
		).toBe(2);
		expect(deletes).toContain(
			`DELETE /openai/v1/conversations/${conversationId}`,
		);
	},
	// The failed deletes are retried with the client's backoff before the erase gives up.
	15_000,
);
