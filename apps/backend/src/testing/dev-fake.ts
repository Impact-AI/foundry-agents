import { createHash } from "node:crypto";
import { join } from "node:path";
import { resetAgentSettings } from "@platform/agent";
import {
	createFoundryAgentHost,
	ensureMemoryStore,
} from "@platform/agent/foundry";
import {
	FAKE_FOUNDRY_ENDPOINT,
	FAKE_RAI_POLICY,
	type FoundryAnswer,
	fakeFoundry,
	type SeenTurn,
	standInExtractor,
} from "@platform/agent/testing";
import { isProductionRuntime } from "@platform/config/deployment-guard";
import { fakeConfigStore } from "@platform/config/testing";
import { openTestCosmos } from "@platform/cosmos/testing";
import {
	documentIdOf,
	ensurePipeline,
	resetAccessSettings,
	resetKnowledgeSettings,
} from "@platform/knowledge";
import { standInKnowledge } from "@platform/knowledge/testing";
import { completion, configure } from "@platform/llm/testing";
import { invalidateLimits } from "@platform/metering";
import { closeRedis } from "@platform/redis";
import { throwawayNamespace } from "@platform/redis/testing";
import { type BrowserSocket, resetVoiceSettings } from "@platform/voice";
import { type FakeTurn, fakeVoiceAgent } from "@platform/voice/testing";
import { createApp } from "../app";
import { callerGateOpen } from "../auth/caller";
import { cosmosContainers } from "../containers";
import { mediaPath, product, prompt } from "../product";
import { wire } from "../wiring";

/**
 * For looking at the interface, and for the end-to-end suite
 * (`apps/frontend/e2e`): the real app on a port, with Foundry Agent Service
 * stood in for at its HTTP boundary (`@platform/agent/testing`) and
 * everything above it real — both of the service's SDKs, the thread index,
 * the accounts and the persona on the Cosmos DB emulator when
 * `COSMOS_ENDPOINT` and `COSMOS_KEY` name one (a throwaway database there,
 * as CI runs it) and in memory otherwise, the gate, the sample library
 * loaded as a deployment loads it — mirrored into an in-memory store the
 * media route reads the pictures from, described in its blobs' metadata,
 * indexed by a stand-in indexer through the job's own definitions into a
 * stand-in index that applies the filter as the service does, and read by a
 * stand-in Prompt Shields — beside one document only the group
 * `people-team` may read, with access control enforced; and a scripted model
 * that answers a short paragraph and drives the stage. Three turns fill the
 * stage in a fixed order; a fourth starts over. A message containing the
 * word "fail" is answered with a service error and one containing "blocked"
 * with the content filter's refusal, so both turn notices can be seen, and
 * a bare "hello" in words alone. One that asks for a project's "spend by
 * quarter" is answered as a model answers a question that needs several
 * actions: one response that charts the measure on the server and puts the
 * project and its lead on the stage, then the answer. A conversation's
 * first turn reasons before it acts and again before it answers, streamed
 * as the service streams a reasoning summary, so the thread's reasoning
 * can be seen while it runs and after. The titler answers a short title from the conversation's
 * opening, and memory — the fake's store, or the own store's extractor —
 * keeps two short statements after every turn, so the picker and the
 * settings page have something to show. The
 * voice agent's socket is stood in for too (`@platform/voice/testing`), so
 * the voice pane opens a real session through the backend's relay, sends
 * the microphone's audio, and hears one scripted spoken turn that searches
 * the library and opens a document, its answer spoken as a short tone.
 * The deployment wears a logo of its own, so the bar and the door draw one
 * through the frontend's relay and the backend's public route.
 *
 *   REDIS_URL=redis://127.0.0.1:6399 PORT=4199 \
 *   bun apps/backend/src/testing/dev-fake.ts
 *
 * Without `AUTH_SECRET` the gate stands open on one local account, and a
 * sign-in at the frontend under any name lands on it. With the frontend's
 * `AUTH_SECRET` the gate is closed as on a deployment: every local sign-in
 * is its own person, which is how the end-to-end suite keeps its tests
 * apart. Never run on a deployment.
 */

const PORT = Number(process.env.PORT ?? 4199);
const namespace = throwawayNamespace();

/* ---- the scripted model ---- */

const TURN_SCRIPT = [
	{
		reasoning: {
			first: [
				"**Finding the onboarding documents**\n\nThe person asked for the library. A search for *onboarding* should bring the handbook up first, with the two documents it links to.",
				"**Choosing what to show**\n\nThe library tile shows every match at once, so one call is enough; the answer can then say which document is which.",
			],
			answer: [
				"**Wording the answer**\n\nThree documents came back. Lead with the handbook, list the other two in a line each, and offer to open one.",
			],
		},
		calls: [{ name: "showLibrary", args: { query: "onboarding" } }],
		suggest: [
			"Open the onboarding handbook",
			"Who looks after new colleagues?",
			"Show me the rollout plan",
		],
		answer:
			"Here is what the library holds on **onboarding** — three documents, the handbook first. The handbook covers the first week day by day; the other two are the documents it links to.\n\n- *Onboarding handbook* — day one, the first week, who to ask\n- *Field tablet rollout plan* — the project most new colleagues join first\n- *Customer support playbook* — how a ticket is answered\n\nShall I open one?",
	},
	{
		calls: [
			{ name: "openDocument", args: { id: "{{rollout}}" } },
			{
				name: "showChart",
				args: {
					title: "Vans fitted, by month",
					unit: "vans",
					series: [
						{
							name: "Planned",
							points: [
								{ x: "Apr", y: 20 },
								{ x: "May", y: 45 },
								{ x: "Jun", y: 80 },
								{ x: "Jul", y: 120 },
								{ x: "Aug", y: 165 },
								{ x: "Sep", y: 210 },
							],
						},
						{
							name: "Fitted",
							points: [
								{ x: "Apr", y: 18 },
								{ x: "May", y: 41 },
								{ x: "Jun", y: 77 },
								{ x: "Jul", y: 109 },
							],
						},
					],
				},
			},
		],
		suggest: [
			"Why is July behind?",
			"Who runs the rollout?",
			"Show me the warehouse",
		],
		answer:
			"The rollout plan is open at its first page, and the chart beside it shows the fitted count against the plan. Wave one — the Nordic fleet — landed on time; July is eleven vans behind, which the plan puts down to the leased vans needing a different mount.",
	},
	{
		calls: [
			{
				name: "showRecord",
				args: { kind: "customer", id: "halvard-logistics" },
			},
			{
				name: "presentContent",
				args: {
					url: "{{fleet}}",
					title: "The Nordic fleet at the Gothenburg depot",
					caption:
						"Forty of the eighty wave-one vans, photographed the week the tablets went in.",
				},
			},
		],
		suggest: [
			"Chart their revenue",
			"Who is their contact?",
			"Open the support playbook",
		],
		answer:
			"**Halvard Logistics** is the customer behind wave one: an enterprise account in the Nordics since 2019, with Inés Valverde as their contact. The picture is their Gothenburg depot the week the tablets went in.",
	},
];

/** The words of a message item, markers of pictures included. */
function textOf(item: Record<string, unknown>): string {
	const content = item.content;
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.map((part) => (typeof part?.text === "string" ? part.text : ""))
		.join(" ");
}

/** The step of the scripted turn the model is on: which thing the person said, and how many of its calls are answered. */
function stepOf(turn: SeenTurn) {
	let lastUserAt = -1;
	let users = 0;
	turn.items.forEach((item, i) => {
		if (
			item.type === "message" &&
			item.role === "user" &&
			textOf(item).trim()
		) {
			users += 1;
			lastUserAt = i;
		}
	});
	const answered = turn.items
		.slice(lastUserAt + 1)
		.filter((item) => item.type === "function_call_output").length;
	const said = lastUserAt >= 0 ? textOf(turn.items[lastUserAt] ?? {}) : "";
	return { turn: Math.max(0, users - 1), answered, said };
}

/** How long each word of a reasoning summary takes to arrive: slow enough to watch the thinking. */
const REASONING_WORD_MS = 140;
/** The wait before an answer: fast enough to use, slow enough to see the wait. */
const BEAT_MS = 900;

/** The script's `{{name}}` values, once the library has loaded: the rollout plan's id, and the depot's picture. */
const placeholders: Record<string, string> = {};

function scriptedTurn(seen: SeenTurn): FoundryAnswer {
	const { turn, answered, said } = stepOf(seen);
	console.log(
		`[dev-fake] turn ${turn + 1}, step ${answered}: "${said.slice(0, 40)}"`,
	);
	if (/\bfail\b/i.test(said)) return { status: 400 };
	if (/\bblocked\b/i.test(said)) return { blocked: "violence" };
	// A bare greeting is answered in words alone, as a model answers one: the
	// turn `scripts/smoke.sh` sends, which no browser carries tools for.
	if (/^\s*hello\W*$/i.test(said))
		return {
			text: "Hello — what shall we look at?",
			pace: { beforeMs: BEAT_MS },
		};
	if (/\bspend by quarter\b/i.test(said)) return severalActions(answered);
	const script = TURN_SCRIPT[turn % TURN_SCRIPT.length];
	if (!script) return { text: "Hello." };
	const calls = [
		...script.calls,
		{ name: "suggestNext", args: { options: script.suggest } },
	];
	const call = calls[answered];
	const reasoning =
		turn === 0 && "reasoning" in script ? script.reasoning : undefined;
	const pace = { beforeMs: BEAT_MS, wordMs: REASONING_WORD_MS };
	if (!call) return { text: script.answer, reasoning: reasoning?.answer, pace };
	const args = JSON.parse(
		JSON.stringify(call.args).replace(
			/\{\{(\w+)\}\}/g,
			(_, name: string) => placeholders[name] ?? "",
		),
	) as Record<string, unknown>;
	return {
		// Unique across turns and threads: a replayed thread renders every past call, keyed by its id.
		calls: [
			{
				id: `call_${crypto.randomUUID().replaceAll("-", "").slice(0, 12)}`,
				name: call.name,
				args,
			},
		],
		reasoning: answered === 0 ? reasoning?.first : undefined,
		pace,
	};
}

/** The calls of one response: a tool of the backend's beside two of the stage's controls, and then the answer. */
function severalActions(answered: number): FoundryAnswer {
	const project = { kind: "project", id: "warehouse-vision" };
	const id = () =>
		`call_${crypto.randomUUID().replaceAll("-", "").slice(0, 12)}`;
	if (answered > 0)
		return { text: SEVERAL_ACTIONS_ANSWER, pace: { beforeMs: BEAT_MS } };
	return {
		calls: [
			{
				id: id(),
				name: "metrics",
				args: { record: project, measure: "spend", period: "quarter" },
			},
			{ id: id(), name: "showRecord", args: project },
			{
				id: id(),
				name: "showRecord",
				args: { kind: "person", id: "tobias-achterberg" },
			},
		],
		pace: { beforeMs: BEAT_MS },
	};
}

const SEVERAL_ACTIONS_ANSWER =
	"Warehouse Vision is in its pilot, on budget so far, with Tobias Achterberg leading it.";

/* ---- the process ---- */

// Everything below stands in for a service, and the gate it serves behind is
// whatever the environment leaves: never on a deployment or in the
// production image, which ships this file with the rest of the source.
if (isProductionRuntime())
	throw new Error(
		"dev-fake serves stand-ins behind a development gate: it does not run on a deployment or under NODE_ENV=production",
	);

process.env.AUTH_MODE = "local";
process.env.AZURE_STORAGE_ACCOUNT = "devstore";
process.env.AZURE_STORAGE_RESOURCE_ID =
	"/subscriptions/dev/resourceGroups/dev/providers/Microsoft.Storage/storageAccounts/devstore";
delete process.env.AZURE_STORAGE_ENDPOINT;
delete process.env.AZURE_STORAGE_CONTAINER;
delete process.env.AZURE_SEARCH_ENDPOINT;
delete process.env.AZURE_SEARCH_INDEX;
process.env.AZURE_OPENAI_EMBEDDING_MODEL = "text-embedding-3-large";
process.env.AGENT_KEY_PREFIX = namespace.prefix;
process.env.FOUNDRY_PROJECT_ENDPOINT = FAKE_FOUNDRY_ENDPOINT;
process.env.FOUNDRY_RAI_POLICY = FAKE_RAI_POLICY;
delete process.env.FOUNDRY_MEMORY_STORE;
delete process.env.CONTAINER_APP_NAME;

const cosmos = await openTestCosmos(
	cosmosContainers,
	Boolean(process.env.COSMOS_ENDPOINT && process.env.COSMOS_KEY),
);
await prompt.seed();

const restoreLlm = configure({
	AZURE_OPENAI_RESOURCE_NAME: "account",
	AZURE_OPENAI_CHAT_DEPLOYMENT: "chat",
	AZURE_OPENAI_SMALL_CHAT_DEPLOYMENT: "small",
	AZURE_OPENAI_EMBEDDING_DEPLOYMENT: "embed",
});
/**
 * The deployment's logo: a 1×1 WebP, named for its bytes as a writer names
 * one. WebP because the stand-in store is one container standing for every
 * container, and its indexer reads it whole: a WebP is no format a library
 * holds, so the indexer passes it over as it would never see it on the
 * appearance container of a deployment.
 */
const LOGO = Buffer.from(
	"UklGRhoAAABXRUJQVlA4TA0AAAAvAAAAEAcQERGIiP4HAA==",
	"base64",
);
const LOGO_KEY = `appearance/logo/${createHash("sha256").update(LOGO).digest("hex")}.webp`;

const restoreConfig = fakeConfigStore({
	appearance: { brand: { logo: LOGO_KEY } },
	agent: { memory: { updateDelaySeconds: 0 } },
	// The planner's small model is not scripted here; the plain search runs.
	knowledge: { planner: { enabled: false } },
	access: { enforceAccessControl: true },
});
resetAgentSettings();
resetVoiceSettings();
resetAccessSettings();
resetKnowledgeSettings();
invalidateLimits();

// The library through the job's own steps, over the stand-ins.
standInKnowledge().store.put(LOGO_KEY, new Uint8Array(LOGO), {
	contentType: "image/webp",
});
await ensurePipeline();
const shipped = product.library;
if (!shipped) throw new Error("dev-fake serves the product's own library");
const SAMPLE_LIBRARY = shipped.name;
for (const loaded of [
	await shipped.load(),
	await shipped.load(undefined, {
		dir: join(import.meta.dir, "restricted-library"),
		name: "restricted",
	}),
])
	if (loaded.failed > 0)
		throw new Error(
			`a library did not load: ${JSON.stringify(loaded.results.filter((r) => r.status === "failed"))}`,
		);
placeholders.onboarding = documentIdOf(
	`${SAMPLE_LIBRARY}/onboarding-handbook.md`,
);
placeholders.rollout = documentIdOf(
	`${SAMPLE_LIBRARY}/field-tablet-rollout-plan.md`,
);
placeholders.fleet =
	mediaPath(`${SAMPLE_LIBRARY}/pictures/depot-dawn.png`) ?? "";

/** A title for the conversation the titler was shown, by what its opening asked about. */
const TITLES: [RegExp, string][] = [
	[/library|document|handbook|onboarding/i, "The document library"],
	[/project|working|who/i, "Who works on what"],
	[/chart|spend|quarter|revenue/i, "Spend by quarter"],
	[/rollout|tablet|van/i, "The tablet rollout"],
];

async function titleFor(request: Request): Promise<Response> {
	const said = JSON.stringify(
		((await request.json()) as { input?: unknown }).input ?? "",
	);
	const opening = said.slice(said.indexOf("Person:"));
	return completion(
		TITLES.find(([pattern]) => pattern.test(opening))?.[1] ??
			"A quick question",
	);
}

const foundry = fakeFoundry();
foundry.respond(scriptedTurn);
// Two statements after every turn, whichever store the `agent` document names: the fake's memory store, or the own store's extractor.
const REMEMBERED = [
	"Is joining the field operations team.",
	"Prefers short answers, with the document first.",
];
foundry.extract(() => REMEMBERED);
const extractor = standInExtractor(() => REMEMBERED);
const uninstall = foundry.install(
	async (request) => (await extractor.fetch(request)) ?? titleFor(request),
);
await ensureMemoryStore(product, { chat: "small", embedding: "embed" });

/* ---- the voice agent ---- */

/**
 * The live session's other end: the voice agent's socket stood in for, and
 * one spoken turn played on its own once the session has its update and the
 * first of the browser's audio — the person asks, the voice searches the
 * library on the server and opens a document on the stage, and the answer
 * follows as audio and words: the transcript, the stage, the end and the
 * thread can all be seen.
 */
const VOICE_TURNS: FakeTurn[] = [
	{
		heard: "What happens on my first day?",
		calls: [
			{
				name: "knowledgeSearch",
				arguments: { query: "onboarding first day" },
			},
			{ name: "openDocument", arguments: { id: placeholders.onboarding } },
		],
		answer:
			"On your first day you collect your badge and meet your buddy. The onboarding handbook is open beside us.",
	},
];
const voiceAgent = fakeVoiceAgent({
	agent: product.voice?.agentId ?? "",
	versions: () => true,
	inputs: {
		personalization: { required: true },
		language: { required: true },
	},
	autoplay: VOICE_TURNS,
	answerAudioBytes: 48_000,
});

const host = createFoundryAgentHost(product);
const wiring = wire(product, host, {
	endpoint: () => voiceAgent.endpoint,
	token: async () => "dev-fake",
});
await host.start();
const app = createApp({ host, product, broker: wiring.broker });
const listening = Bun.serve<BrowserSocket>({
	fetch: (req, server) => app.fetch(req, server),
	port: PORT,
	hostname: "127.0.0.1",
	idleTimeout: 255,
	websocket: wiring.broker.websocket,
});
console.log(
	`[dev-fake] ${product.serviceName} on http://127.0.0.1:${listening.port}, Foundry stood in for, Cosmos DB ${cosmos.target === "emulator" ? "on the emulator" : "in memory"}, the gate ${callerGateOpen() ? "open: sign in under any name" : "closed: each sign-in is its own person"}`,
);

let stopping = false;
async function stop(): Promise<void> {
	if (stopping) return;
	stopping = true;
	await listening.stop(true);
	await host.stop();
	await wiring.broker.drain();
	void voiceAgent.stop();
	wiring.stop();
	uninstall();
	restoreLlm();
	restoreConfig();
	await closeRedis();
	await cosmos.drop();
	process.exit(0);
}
process.on("SIGINT", () => void stop());
process.on("SIGTERM", () => void stop());
