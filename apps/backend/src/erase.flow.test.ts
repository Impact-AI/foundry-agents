import { afterAll, beforeAll, expect, spyOn, test } from "bun:test";
import { resetAgentSettings } from "@platform/agent";
import {
	createFoundryAgentHost,
	type FoundryAgentHost,
} from "@platform/agent/foundry";
import {
	FAKE_FOUNDRY_ENDPOINT,
	fakeFoundry,
	standInExtractor,
} from "@platform/agent/testing";
import { fakeConfigStore } from "@platform/config/testing";
import { openTestCosmos, type TestCosmos } from "@platform/cosmos/testing";
import {
	callerAssertion,
	getAccount,
	setAccountDisabled,
	setVoiceTuning,
} from "@platform/identity";
import {
	ensurePipeline,
	resetAccessSettings,
	resetKnowledgeSettings,
	resetSearchClients,
	resetShield,
} from "@platform/knowledge";
import { standInKnowledge } from "@platform/knowledge/testing";
import { completion, configure } from "@platform/llm/testing";
import { invalidateLimits, resetMeteringKeyPrefix } from "@platform/metering";
import { closeRedis } from "@platform/redis";
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
import type { AppEnv } from "./auth/context";
import { cosmosContainers } from "./containers";
import { product, prompt } from "./product";
import { call, claimsFor } from "./testing/calls";
import { type Wiring, wire } from "./wiring";

/**
 * An erase against requests that were admitted before it and write after
 * it: a request is admitted on one read of the account's row, then its body
 * is read, and a client that holds the body — or a slow upload — stretches
 * that past the erase, and past the sign-in that makes a new account of the
 * id. Each write such a request makes is refused once the account is no
 * longer the one it was admitted on, and nothing of it lands under the id.
 * And an erase is one holder's while it sweeps: a sweep that lost its hold
 * stops at its next step.
 */
const t = test;
const namespace = throwawayNamespace();
const HOOK_BUDGET_MS = 60_000;

let app: Hono<AppEnv>;
let listener: ReturnType<typeof Bun.serve<BrowserSocket>>;
let voiceAgent: ReturnType<typeof fakeVoiceAgent>;
let host: FoundryAgentHost;
let wiring: Wiring;
let cosmos: TestCosmos;
let restoreEnv = () => {};
let restoreLlm = () => {};
let restoreConfig = () => {};
const quiet: ReturnType<typeof spyOn>[] = [];

beforeAll(async () => {
	quiet.push(spyOn(console, "log").mockImplementation(() => {}));
	quiet.push(spyOn(console, "warn").mockImplementation(() => {}));
	quiet.push(spyOn(console, "error").mockImplementation(() => {}));
	restoreEnv = scopedEnv({
		AGENT_KEY_PREFIX: namespace.prefix,
		FOUNDRY_PROJECT_ENDPOINT: FAKE_FOUNDRY_ENDPOINT,
		FOUNDRY_RAI_POLICY: undefined,
		FOUNDRY_MEMORY_STORE: undefined,
		AUTH_SECRET: "test-secret",
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
	restoreConfig = fakeConfigStore({
		agent: { memory: { store: "own", updateDelaySeconds: 0 } },
		knowledge: { planner: { enabled: false } },
	});
	resetAgentSettings();
	resetVoiceSettings();
	resetAccessSettings();
	resetKnowledgeSettings();
	invalidateLimits();
	standInKnowledge();
	await ensurePipeline();
	const foundry = fakeFoundry();
	foundry.respond(() => ({ text: "The answer is forty-two." }));
	const extractor = standInExtractor((_messages, kept) => kept);
	foundry.install(
		async (request) =>
			(await extractor.fetch(request)) ?? completion("A conversation"),
	);
	host = createFoundryAgentHost(product);
	await host.start();
	voiceAgent = fakeVoiceAgent({
		agent: product.voice?.agentId ?? "",
		versions: () => true,
		inputs: {
			personalization: { required: true },
			language: { required: true },
		},
	});
	wiring = wire(product, host, {
		endpoint: () => voiceAgent.endpoint,
		token: async () => "test-token",
	});
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

async function until(condition: () => Promise<boolean>, timeoutMs = 10_000) {
	const deadline = Date.now() + timeoutMs;
	while (!(await condition())) {
		if (Date.now() > deadline) throw new Error("condition not met in time");
		await Bun.sleep(25);
	}
}

function runBody(threadId: string, text: string) {
	return {
		threadId,
		runId: crypto.randomUUID(),
		state: {},
		messages: [{ id: crypto.randomUUID(), role: "user", content: text }],
		tools: [],
		context: [],
		forwardedProps: {},
	};
}

function signIn(who: string, name: string, roles: string[] = []) {
	return call(app, "POST", "/identity/sign-in", {
		as: { ...claimsFor(who), roles },
		body: {
			claims: {
				oid: who,
				email: `${who}@example.com`,
				name,
				roles,
				groups: [],
			},
			user: { id: who, email: `${who}@example.com`, name },
			account: { provider: "microsoft-entra-id" },
		},
	});
}

type Claims = ReturnType<typeof claimsFor>;

/** A request whose headers arrive now and whose body arrives on `release`: past the gate, holding its body. */
async function held(method: string, path: string, as: Claims, body: unknown) {
	const { token } = await callerAssertion.mint(as);
	let release: () => void = () => {};
	const gate = new Promise<void>((resolve) => {
		release = resolve;
	});
	const bytes = new TextEncoder().encode(JSON.stringify(body));
	const stream = new ReadableStream<Uint8Array>({
		async start(controller) {
			controller.enqueue(bytes.slice(0, 1));
			await gate;
			controller.enqueue(bytes.slice(1));
			controller.close();
		},
	});
	const response = app.request(
		new Request(`http://localhost${path}`, {
			method,
			headers: {
				authorization: `Bearer ${token}`,
				"content-type": "application/json",
				"accept-language": "en",
			},
			body: stream,
			// A streamed request body is sent half-duplex.
			duplex: "half",
		} as RequestInit),
	) as Promise<Response>;
	// Past the gate before the test goes on: the body is what it waits for.
	await Bun.sleep(100);
	return { response, release };
}

const rawRow = (who: string) =>
	cosmos.database
		.container("accounts")
		.read<{ id: string; erasing?: number }>(who, who);

/** A session from before now: signed in two minutes ago, so a sign-in after an erase does not admit it. */
const before = (who: string): Claims => ({
	...claimsFor(who),
	signedInAt: Math.floor(Date.now() / 1000) - 120,
});

const threadIds = async (who: string) =>
	(await host.listThreads(who)).threads.map((thread) => thread.id);

t(
	"a turn admitted before an erase, its body arriving after the erase finished, writes nothing under the erased id",
	async () => {
		const who = "erase-turn-after";
		expect((await signIn(who, "First")).status).toBe(200);
		const pending = await held(
			"POST",
			"/agent/run",
			claimsFor(who),
			runBody("thread-late", "my words"),
		);
		expect(
			(await call(app, "DELETE", "/account", { as: claimsFor(who) })).status,
		).toBe(204);
		pending.release();
		const answered = await pending.response;
		expect(answered.status).toBe(401);
		expect(await answered.json()).toEqual({ code: "account_erased" });
		expect(await threadIds(who)).toEqual([]);
		expect((await signIn(who, "Second")).status).toBe(200);
		const listed = await call(app, "GET", "/conversations", {
			as: claimsFor(who),
		});
		expect(listed.status).toBe(200);
		expect(
			((await listed.json()) as { conversations: unknown[] }).conversations,
		).toEqual([]);
	},
);

t(
	"a turn admitted before an erase, its body arriving while the erase sweeps, writes nothing under the erased id",
	async () => {
		const who = "erase-turn-during";
		expect((await signIn(who, "First")).status).toBe(200);
		const pending = await held(
			"POST",
			"/agent/run",
			claimsFor(who),
			runBody("thread-during", "words during the sweep"),
		);
		const sweep = host.eraseResource.bind(host);
		let answered: Response | null = null;
		const swept = spyOn(host, "eraseResource").mockImplementation(
			async (resourceId, options) => {
				const report = await sweep(resourceId, options);
				expect((await rawRow(who))?.erasing).toBeNumber();
				pending.release();
				answered = await pending.response;
				return report;
			},
		);
		try {
			expect(
				(await call(app, "DELETE", "/account", { as: claimsFor(who) })).status,
			).toBe(204);
		} finally {
			swept.mockRestore();
		}
		expect(answered).not.toBeNull();
		expect((answered as unknown as Response).status).toBe(401);
		expect(await threadIds(who)).toEqual([]);
	},
);

t(
	"an edit admitted before an erase, its body arriving after the next sign-in made a new account, writes nothing to it and says nothing of it",
	async () => {
		const who = "erase-edit";
		const old = before(who);
		expect((await signIn(who, "First")).status).toBe(200);
		const pending = await held("PATCH", "/identity/me", old, {
			about: "written by the session from before",
		});
		expect(
			(await call(app, "DELETE", "/account", { as: claimsFor(who) })).status,
		).toBe(204);
		expect((await signIn(who, "Second")).status).toBe(200);
		expect(
			(
				await call(app, "PATCH", "/identity/me", {
					as: claimsFor(who),
					body: { preferences: "the second person's" },
				})
			).status,
		).toBe(200);
		pending.release();
		const answered = await pending.response;
		expect(answered.status).toBe(401);
		const said = await answered.text();
		expect(JSON.parse(said)).toEqual({ code: "account_erased" });
		expect(said).not.toContain("Second");
		const now = await getAccount(who);
		expect(now?.about).toBeNull();
		expect(now?.preferences).toBe("the second person's");
	},
);

t(
	"a tuning admitted before an erase, its body arriving after the next sign-in, leaves the new account's tuning as it is",
	async () => {
		const who = "erase-tuning";
		const old = before(who);
		expect((await signIn(who, "First", ["tester"])).status).toBe(200);
		const pending = await held(
			"PUT",
			"/voice/tuning",
			{ ...old, roles: ["tester"] },
			{},
		);
		expect(
			(await call(app, "DELETE", "/account", { as: claimsFor(who) })).status,
		).toBe(204);
		expect((await signIn(who, "Second", ["tester"])).status).toBe(200);
		expect(await setVoiceTuning(who, { engine: "cascade" })).toBe(true);
		pending.release();
		const answered = await pending.response;
		expect(answered.status).toBe(401);
		expect(await answered.json()).toEqual({ code: "account_erased" });
		expect((await getAccount(who))?.voiceTuning).toEqual({ engine: "cascade" });
	},
);

t(
	"a sweep that lost its hold — stalled past the hold, taken over by a sign-in — stops at its next step and leaves the new account's thread",
	async () => {
		const who = "erase-stalled";
		expect((await signIn(who, "First")).status).toBe(200);
		const first = await call(app, "POST", "/agent/run", {
			as: claimsFor(who),
			body: runBody("thread-old", "old words"),
		});
		await first.text();
		const sweep = host.eraseResource.bind(host);
		let go: () => void = () => {};
		const stalled = new Promise<void>((resolve) => {
			go = resolve;
		});
		let calls = 0;
		const swept = spyOn(host, "eraseResource").mockImplementation(
			async (resourceId, options) => {
				if (calls++ === 0) await stalled;
				return sweep(resourceId, options);
			},
		);
		try {
			const erase = call(app, "DELETE", "/account", { as: claimsFor(who) });
			await until(async () => typeof (await rawRow(who))?.erasing === "number");
			// The hold aged past its bound, as a process frozen that long leaves it.
			const erasing = (await rawRow(who))?.erasing ?? 0;
			await cosmos.database
				.container("accounts")
				.patch(who, who, [
					{ op: "set", path: "/erasing", value: erasing - 301 },
				]);
			expect(await (await signIn(who, "Second")).json()).toMatchObject({
				ok: true,
			});
			const talked = await call(app, "POST", "/agent/run", {
				as: claimsFor(who),
				body: runBody("thread-new", "the new person's words"),
			});
			expect(talked.status).toBe(200);
			await talked.text();
			go();
			const answered = await erase;
			expect(answered.status).toBe(503);
		} finally {
			swept.mockRestore();
		}
		expect(await threadIds(who)).toEqual(["thread-new"]);
		expect((await getAccount(who))?.name).toBe("Second");
	},
);

t(
	"a deactivation that lands while the sweep runs ends as a tombstone, and the next sign-in is refused",
	async () => {
		const who = "erase-deactivated";
		expect((await signIn(who, "First")).status).toBe(200);
		const sweep = host.eraseResource.bind(host);
		const swept = spyOn(host, "eraseResource").mockImplementation(
			async (resourceId, options) => {
				expect(await setAccountDisabled(who, true)).toBe(true);
				return sweep(resourceId, options);
			},
		);
		try {
			expect(
				(await call(app, "DELETE", "/account", { as: claimsFor(who) })).status,
			).toBe(204);
		} finally {
			swept.mockRestore();
		}
		const row = await rawRow(who);
		expect(row).toMatchObject({ disabled: true, ttl: -1, createdAt: null });
		expect(row?.erasing ?? null).toBeNull();
		expect(await (await signIn(who, "Again")).json()).toMatchObject({
			ok: false,
			reason: "deactivated",
		});
	},
);

t(
	"a second erase while the first holds it waits, then says it is not done; a sign-in meanwhile is told to come back, and after it is admitted",
	async () => {
		const who = "erase-busy";
		expect((await signIn(who, "First")).status).toBe(200);
		const sweep = host.eraseResource.bind(host);
		let go: () => void = () => {};
		const slow = new Promise<void>((resolve) => {
			go = resolve;
		});
		const swept = spyOn(host, "eraseResource").mockImplementation(
			async (resourceId, options) => {
				await slow;
				return sweep(resourceId, options);
			},
		);
		try {
			const first = call(app, "DELETE", "/account", { as: claimsFor(who) });
			await until(async () => typeof (await rawRow(who))?.erasing === "number");
			const second = await call(app, "DELETE", "/account", {
				as: claimsFor(who),
			});
			expect(second.status).toBe(503);
			expect(await (await signIn(who, "Second")).json()).toMatchObject({
				ok: false,
				reason: "unavailable",
			});
			go();
			expect((await first).status).toBe(204);
		} finally {
			swept.mockRestore();
		}
		expect(await (await signIn(who, "Second")).json()).toMatchObject({
			ok: true,
		});
	},
);

const message =
	<T extends ServerMessage["type"]>(type: T) =>
	(m: ServerMessage): m is Extract<ServerMessage, { type: T }> =>
		m.type === type;

t.skipIf(!REDIS_AVAILABLE)(
	"a live socket accepted before an erase, its start sent after it, is refused and opens no thread",
	async () => {
		const who = "erase-live";
		expect((await signIn(who, "First")).status).toBe(200);
		const { token } = await callerAssertion.mint(claimsFor(who));
		const browser = await openBrowserSocket(
			`ws://127.0.0.1:${listener.port}/voice/live`,
			{ headers: { authorization: `Bearer ${token}` } },
		);
		expect(
			(await call(app, "DELETE", "/account", { as: claimsFor(who) })).status,
		).toBe(204);
		browser.send({ type: "start", threadId: "thread-spoken" });
		const refused = await browser.next(message("refused"));
		expect(refused.status).toBe(401);
		expect(refused.body).toEqual({ code: "account_erased" });
		expect(await threadIds(who)).toEqual([]);
	},
);

/** Every document a container holds for one person. */
const rowsOf = async (container: string, who: string) =>
	(
		await cosmos.database
			.container(container)
			.query<{ id: string; text?: string }>(
				{
					query: "SELECT * FROM c WHERE c.resourceId = @r",
					parameters: [{ name: "@r", value: who }],
				},
				who,
			)
	).filter((row) => row.id !== "floor");

/** Over real HTTP, as a browser sends it: the headers now, a chunked body whose end arrives on `release`. */
async function heldOnTheWire(method: string, path: string, as: Claims) {
	const { token } = await callerAssertion.mint(as);
	let data = "";
	let closed: () => void = () => {};
	const done = new Promise<void>((resolve) => {
		closed = resolve;
	});
	const socket = await Bun.connect({
		hostname: "127.0.0.1",
		port: Number(listener.port),
		socket: {
			data(_socket, chunk) {
				data += new TextDecoder().decode(chunk);
			},
			close() {
				closed();
			},
		},
	});
	socket.write(
		`${method} ${path} HTTP/1.1\r\nHost: localhost\r\nAuthorization: Bearer ${token}\r\nContent-Type: application/json\r\nTransfer-Encoding: chunked\r\nConnection: close\r\n\r\n1\r\n{\r\n`,
	);
	// Past the gate before the test goes on: the rest of the body is what it waits for.
	await Bun.sleep(150);
	return {
		said: () => data,
		release: async () => {
			socket.write("1\r\n}\r\n0\r\n\r\n");
			await Promise.race([done, Bun.sleep(5_000)]);
			socket.end();
			return data.split("\r\n")[0] ?? "";
		},
	};
}

/** The thread the account made after an erase talks in: a thread's id is one person's across the deployment. */
const newThread = (who: string) => `thread-new-${who}`;

/** An account erased and made again by the next sign-in, which then talks and is remembered: what a request from before the erase must leave as it is. */
async function remade(who: string) {
	expect(
		(await call(app, "DELETE", "/account", { as: claimsFor(who) })).status,
	).toBe(204);
	expect((await signIn(who, "Second", ["tester"])).status).toBe(200);
	const talked = await call(app, "POST", "/agent/run", {
		as: claimsFor(who),
		body: runBody(newThread(who), "the second person's words"),
	});
	expect(talked.status).toBe(200);
	await talked.text();
	// Named by its own title job first, so what is compared after is the account at rest.
	await until(async () =>
		(await host.listThreads(who)).threads.every((thread) => thread.title),
	);
	expect(
		(
			await call(app, "PATCH", "/identity/me", {
				as: claimsFor(who),
				body: { preferences: "the second person's" },
			})
		).status,
	).toBe(200);
	const now = new Date().toISOString();
	await cosmos.database.container("memory").create({
		id: "fact_new",
		resourceId: who,
		text: "the second person's fact",
		createdAt: now,
		updatedAt: now,
	});
}

/** What the account made after an erase holds: its row's person, its threads with their titles, its remembered facts. */
async function heldBy(who: string) {
	const account = await getAccount(who);
	return {
		person: {
			name: account?.name,
			about: account?.about,
			preferences: account?.preferences,
			voiceTuning: account?.voiceTuning,
		},
		threads: (await host.listThreads(who)).threads.map((thread) => ({
			id: thread.id,
			title: thread.title,
		})),
		facts: (await rowsOf("memory", who)).map((row) => [row.id, row.text]),
	};
}

t(
	"a forget of everything remembered, admitted before an erase and its body arriving after the next sign-in, leaves the new account's memory",
	async () => {
		const who = "erase-held-forget";
		expect((await signIn(who, "First")).status).toBe(200);
		const pending = await heldOnTheWire(
			"DELETE",
			"/identity/me/memory",
			before(who),
		);
		expect(pending.said()).toBe("");
		await remade(who);
		const holding = await heldBy(who);
		expect(holding.facts).toContainEqual([
			"fact_new",
			"the second person's fact",
		]);
		expect(await pending.release()).toContain("401");
		expect(await heldBy(who)).toEqual(holding);
		// Nor did the refused forget leave its floor under the id: the new account removed nothing.
		expect(
			await cosmos.database.container("memory").read("floor", who),
		).toBeNull();
	},
	HOOK_BUDGET_MS,
);

t(
	"a delete of a conversation, admitted before an erase and its body arriving after the next sign-in, leaves the new account's thread of that id",
	async () => {
		const who = "erase-held-delete";
		expect((await signIn(who, "First")).status).toBe(200);
		const pending = await heldOnTheWire(
			"DELETE",
			`/conversations/${newThread(who)}`,
			before(who),
		);
		await remade(who);
		const holding = await heldBy(who);
		expect(holding.threads.map((thread) => thread.id)).toEqual([
			newThread(who),
		]);
		expect(await pending.release()).toContain("401");
		expect(await heldBy(who)).toEqual(holding);
	},
	HOOK_BUDGET_MS,
);

t(
	"an erase asked again, admitted before an erase and its body arriving after the next sign-in, sweeps nothing of the new account",
	async () => {
		const who = "erase-held-erase";
		expect((await signIn(who, "First")).status).toBe(200);
		const pending = await heldOnTheWire("DELETE", "/account", before(who));
		await remade(who);
		const holding = await heldBy(who);
		expect(await pending.release()).toContain("401");
		expect(await heldBy(who)).toEqual(holding);
	},
	HOOK_BUDGET_MS,
);

/** A route's path with its parameters filled by what the account made after an erase holds, so a write that went through would reach it. */
function reaching(path: string, who: string): string {
	const ids: Record<string, string> = {
		"/conversations/:id": `/conversations/${newThread(who)}`,
		"/identity/me/memory/:id": "/identity/me/memory/fact_new",
	};
	return ids[path] ?? path.replace(/:[A-Za-z]+/g, "x");
}

/** A body each write would act on, were it let through; a route not named here is sent an empty object. */
const bodyFor = (route: string, who: string): unknown =>
	({
		"PATCH /identity/me": { about: "written by the session from before" },
		"PATCH /conversations/:id": { title: "Renamed from before" },
		"PATCH /identity/me/memory/:id": { content: "rewritten from before" },
		"PUT /voice/tuning": { engine: "cascade" },
		"POST /agent/run": runBody(newThread(who), "words from before"),
	})[route] ?? {};

/** The one route that writes for a session that has no account yet, and makes one: what an erase's next sign-in is. */
const OWN_RULE = new Set(["POST /identity/sign-in"]);

t(
	"every route that may write, admitted before an erase and its body arriving after the next sign-in, is refused and leaves the new account as it is",
	async () => {
		const writes = [
			...new Set(
				app.routes
					.filter(
						(route) =>
							!["GET", "HEAD", "OPTIONS", "ALL"].includes(route.method) &&
							!OWN_RULE.has(`${route.method} ${route.path}`),
					)
					.map((route) => `${route.method} ${route.path}`),
			),
		].sort();
		// The routes are read off the app, so one added later is held to this too.
		expect(writes.length).toBeGreaterThanOrEqual(9);
		const answered: Record<string, string> = {};
		const left: Record<string, boolean> = {};
		for (const [index, route] of writes.entries()) {
			const [method = "", path = ""] = route.split(" ");
			const who = `erase-route-${index}`;
			expect((await signIn(who, "First", ["tester"])).status).toBe(200);
			const pending = await held(
				method,
				reaching(path, who),
				{ ...before(who), roles: ["tester"] },
				bodyFor(route, who),
			);
			await remade(who);
			const holding = await heldBy(who);
			pending.release();
			const response = await pending.response;
			answered[route] = `${response.status} ${await response.text()}`;
			left[route] = Bun.deepEquals(await heldBy(who), holding);
		}
		const refused = `401 ${JSON.stringify({ code: "account_erased" })}`;
		expect(answered).toEqual(
			Object.fromEntries(writes.map((route) => [route, refused])),
		);
		expect(left).toEqual(
			Object.fromEntries(writes.map((route) => [route, true])),
		);
	},
	HOOK_BUDGET_MS * 3,
);

t(
	"a live session's settle that outlives the erase's wait for it writes, then takes out what it wrote: nothing is left under the erased id",
	async () => {
		const who = "erase-late-settle";
		expect((await signIn(who, "First")).status).toBe(200);
		const sessionId = crypto.randomUUID();
		const bound = await host.liveVoiceBinding(who, "thread-spoken", {
			sessionId,
			maxSessionSeconds: 60,
			tier: "base",
			locale: "en",
		});
		expect(bound.kind).toBe("bound");
		const history = (
			host as unknown as {
				history: { for: (thread: unknown) => { append: unknown } };
			}
		).history;
		const choose = history.for.bind(history);
		let started: () => void = () => {};
		const appending = new Promise<void>((resolve) => {
			started = resolve;
		});
		let go: () => void = () => {};
		const after = new Promise<void>((resolve) => {
			go = resolve;
		});
		const chosen = spyOn(history, "for").mockImplementation((thread) => {
			const store = choose(thread) as {
				append: (...args: unknown[]) => Promise<unknown>;
			};
			return Object.assign(Object.create(store), {
				append: async (...args: unknown[]) => {
					started();
					await after;
					return store.append(...args);
				},
			});
		});
		try {
			const at = new Date().toISOString();
			const settled = host.settleLiveVoice(who, "thread-spoken", {
				sessionId,
				spoken: [
					{
						itemId: "item_0",
						previousItemId: null,
						at,
						kind: "said",
						role: "user",
						text: "words said before the erase",
						interrupted: false,
					},
				],
			});
			await appending;
			// The erase ends the settle and waits its bound for it, then sweeps; the settle's write lands after.
			expect(
				(await call(app, "DELETE", "/account", { as: claimsFor(who) })).status,
			).toBe(204);
			go();
			expect(await settled).toBeNull();
		} finally {
			chosen.mockRestore();
		}
		expect(await rowsOf("messages", who)).toEqual([]);
		expect(await threadIds(who)).toEqual([]);
	},
	HOOK_BUDGET_MS,
);

t(
	"a turn the erase cannot find, opening its thread after the erase swept, writes nothing and takes out the thread it made",
	async () => {
		const who = "erase-unseen-turn";
		expect((await signIn(who, "First")).status).toBe(200);
		const inner = host as unknown as {
			open: (...args: unknown[]) => Promise<unknown>;
			endTurns: (...args: unknown[]) => Promise<unknown>;
		};
		const open = inner.open.bind(host);
		let reached: () => void = () => {};
		const opening = new Promise<void>((resolve) => {
			reached = resolve;
		});
		let go: () => void = () => {};
		const after = new Promise<void>((resolve) => {
			go = resolve;
		});
		const opened = spyOn(inner, "open").mockImplementation(
			async (...args: unknown[]) => {
				reached();
				await after;
				return open(...args);
			},
		);
		// A replica whose record of its running turns never reached Redis: the erase is told of none.
		const unseen = spyOn(inner, "endTurns").mockImplementation(
			async () => undefined,
		);
		try {
			const turn = call(app, "POST", "/agent/run", {
				as: claimsFor(who),
				body: runBody("thread-unseen", "words before the erase"),
			});
			await opening;
			expect(
				(await call(app, "DELETE", "/account", { as: claimsFor(who) })).status,
			).toBe(204);
			go();
			await (await turn).text();
		} finally {
			opened.mockRestore();
			unseen.mockRestore();
		}
		// The answer closes on the turn's error; what it made is taken out as the turn ends, just after.
		await until(async () => (await threadIds(who)).length === 0);
		expect(await rowsOf("messages", who)).toEqual([]);
	},
	HOOK_BUDGET_MS,
);
