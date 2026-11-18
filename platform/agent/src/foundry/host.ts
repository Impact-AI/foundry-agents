import { type ConfigKey, envString } from "@platform/config";
import { runInUsageScope } from "@platform/observability";
import type { ReplyChannel } from "@platform/prompt";
import {
	claimHolder,
	claimOnce,
	extendClaim,
	releaseClaim,
} from "@platform/redis";
import type {
	AgentHost,
	CallerRefusal,
	EraseReport,
	LiveVoiceBinding,
	LiveVoiceOutcome,
	LiveVoiceRefusal,
	LiveVoiceRequest,
	LiveVoiceSettlement,
	LiveVoiceTools,
	MemoryItem,
	PersonBlocks,
	PersonMemory,
	ThreadPage,
	ThreadPageRequest,
	ThreadReadRequest,
	ThreadView,
	TurnInput,
	TurnOutcome,
} from "../contract/host";
import type { TurnEvent } from "../contract/messages";
import {
	type AgentProduct,
	memoryDetailsOf,
	type ProductTools,
	type ProductVoice,
	type VoiceAudio,
	WEB_SEARCH,
} from "../contract/product";
import { type DueQueue, dueQueue } from "../coordination/due-queue";
import {
	END_WAIT_MS,
	type RunningTurn,
	type ThreadEnds,
	threadEnds,
} from "../coordination/thread-ends";
import {
	layeredThreadLookup,
	ownershipOf,
	type ThreadLookup,
	ThreadLookupError,
} from "../coordination/thread-owner";
import type { PreparedTurn } from "../history/interface";
import { type HistoryStores, historyStores } from "../history/select";
import {
	composeTurnPrompt,
	type PromptDeps,
	readPersonBlocks,
	type TurnPrompt,
} from "../instructions";
import { type AgentKeys, agentKeys, problems } from "../keys";
import type { MemoryMessage } from "../memory/interface";
import { memoryStore, type SelectedMemoryStore } from "../memory/select";
import { type PersonCaches, personCaches } from "../person/caches";
import {
	agentSettings,
	historyKeptByService,
	isOpenAIVoice,
	type Transcriber,
	type VoiceEngine,
	voiceEngineForTier,
} from "../settings";
import { generateTitle } from "../title/generate-title";
import { titleFrom } from "../title/title-from";
import {
	defineToolGating,
	type ToolGatingConfig,
	toolGatingOptions,
} from "../tool-gating";
import { type AdmissionDeps, admitTurn } from "../turn/admit";
import {
	answersOpenCalls,
	invalidTurn,
	offeredClientTools,
	readTurnMessages,
	type SaidMessage,
	type TurnRequest,
} from "../turn/input";
import type { TurnScope } from "../turn/scope";
import { type ManagedVoiceModel, managedVoiceModel } from "../voice-models";
import { Warmer } from "../warmup";
import {
	type AgentKind,
	hasStatus,
	kindOptions,
	projectClient,
} from "./client";
import {
	agentDefinition,
	chatDeployment,
	functionTools,
	PERSONALIZATION_INPUT,
	type PromptAgentDefinition,
	type RealtimeDeployment,
	realtimeDeployments,
} from "./definition";
import { eraseResource } from "./erase";
import { boundHistory, HistoryItemTooLarge, removeHistoryOf } from "./history";
import { openThread } from "./open-thread";
import { fittingSkills } from "./skills";
import { spokenRecord } from "./spoken";
import {
	listThreadDocuments,
	nameUntitledThread,
	readThreadDocument,
	recentStamps,
	removeThreadDocuments,
	setThreadTitle,
	summaryOf,
	type ThreadDocument,
	threadOwner,
	touchThread,
} from "./threads";
import {
	answeredItems,
	liveHistoryLines,
	notAnswered,
	OPEN_CALL_WINDOW,
	openCalls,
	type StoredItem,
	saidItems,
	saidLines,
} from "./turn/input";
import {
	finishEvents,
	type LoopResult,
	outputText,
	runLoop,
	runProductTool,
	sourcesOf,
} from "./turn/loop";
import { type AgentVersions, agentVersions, pruneVersions } from "./versions";
import { fittedPersonalization, voiceInstructionCap } from "./voice-budget";
import {
	LANGUAGE_INPUT,
	type SessionReasoning,
	type VersionHearing,
	type VoiceAgentDefinition,
	voiceAgentDefinition,
	voiceLiveSession,
	voiceSessionUpdate,
} from "./voice-definition";
import {
	reportVoiceEngines,
	VOICE_LIVE_RUNTIME,
	voiceEnginesRunning,
	voiceLiveModel,
} from "./voice-engine";
import { voiceServiceTools } from "./voice-tools";
import { effectiveVoice, sessionTuning, versionHearing } from "./voice-tuning";
import {
	chargeWebSearches,
	webSearchAccountable,
	webSearchAvailable,
} from "./web-search-meter";

/**
 * The host on Foundry Agent Service: the agent is a prompt agent whose
 * versions hold parts one and two of the prompt and every tool, and a turn
 * is responses with part three as a structured input. The thread index and
 * its ownership claims are on Cosmos DB; a thread's messages are where the
 * thread was made (`history/select.ts`) — its own history on the same
 * Cosmos DB, every response keeping nothing (`store: false`) and given the
 * history, or, by the operator's `history.store`, a conversation of the
 * service's that each response is kept in. What is remembered about a
 * person is the memory store's (preview) or, by the operator's
 * `memory.store`, a container on the same Cosmos DB. The guards
 * in front of a turn — the spend bound, ownership, the claim — are the
 * framework-free core's, run before any call to the service.
 */

/** How long a live session's hold on its thread outlives the session's own limit, for the settle to land. */
const HOLD_GRACE_SECONDS = 120;
/** The owner a voice version's in-use mark is held under: any session's. */
const IN_USE = "in-use";
/** How long a settled session is remembered, so a settle repeated by a retrying broker writes nothing twice. */
const SETTLED_TTL_MS = 86_400_000;
/**
 * How long a thread waits to be named after the turn or session that asked:
 * a turn that continues it within the wait — a control's answer posted
 * back — moves the wait, so one exchange is named once.
 */
const TITLE_DELAY_MS = 2_000;
/** How often threads due a name are looked for. */
const TITLE_SWEEP_MS = 2_000;
/** A thread is named near its start: the newest items it is named from. */
const TITLE_ITEMS_READ = 40;

/** A live session's tools: the backend's it answers. */
interface SessionTools {
	serverTools: ProductTools;
}

/** How long a stop waits for the turns it ended: with the queues' own bound, inside what a shutdown leaves its closes. */
const STOP_WAIT_MS = 5_000;

/** A turn this replica runs: whose it is, how to end it, and when it is over. */
interface RunningEntry {
	resourceId: string;
	threadId: string;
	abort: AbortController;
	/** Settled once the turn is over, however it ended. */
	done: Promise<void>;
	/** The thread was deleted under the turn: it writes nothing. */
	ended: boolean;
	/** The person was erased under the turn: the thread it opened goes too. */
	erased: boolean;
}

/** A turn counted as running, from before its thread is opened until `over`. */
interface LiveTurn {
	entry: RunningEntry;
	turn: RunningTurn;
	/** Whether this turn made its thread, which is then its own to take out again. */
	made: boolean;
	over(): Promise<void>;
}

/** Whether `work` was over within `ms`. */
async function within(work: Promise<unknown>, ms: number): Promise<boolean> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	const late = new Promise<false>((resolve) => {
		timer = setTimeout(() => resolve(false), ms);
	});
	try {
		return await Promise.race([work.then(() => true as const), late]);
	} finally {
		clearTimeout(timer);
	}
}

interface OpenedThread {
	thread: ThreadDocument;
	/** The turn's input on the thread's store, and how its responses are asked for. */
	prepared: PreparedTurn;
}

export class FoundryAgentHost implements AgentHost {
	readonly toolGating: ConfigKey<ToolGatingConfig>;
	readonly keys: AgentKeys;
	readonly caches: PersonCaches;
	readonly lookup: ThreadLookup;
	readonly memory: SelectedMemoryStore;
	/** Where each thread's messages are: its own store, and the operator's for a new one. */
	readonly history: HistoryStores;
	/** Threads waiting to be named, off the request path. */
	readonly titles: DueQueue;
	readonly versions: AgentVersions<PromptAgentDefinition>;
	/** The voice agent's versions; null for a product with no live voice. */
	readonly voiceVersions: AgentVersions<VoiceAgentDefinition> | null;
	private readonly prompt: PromptDeps;
	private readonly warmer: Warmer;
	/** Every control the product defines: a call to one is the browser's, or answered here. */
	private readonly controls: ReadonlySet<string>;
	/** The turns streaming now, each with its thread and its end, so a stop or a delete can end them and wait. */
	private readonly running = new Set<RunningEntry>();
	/** The same end, for a turn another replica is streaming. */
	private readonly ends: ThreadEnds;

	constructor(readonly product: AgentProduct) {
		this.controls = new Set(product.clientTools.map((t) => t.name));
		for (const key of product.toolKeys)
			if (this.controls.has(key))
				throw new Error(
					`"${key}" is both a tool and a client control: a call to it could not say where it runs`,
				);
		this.keys = agentKeys(product.serviceName);
		this.ends = threadEnds(this.keys.namespace);
		this.caches = personCaches(this.keys.memo);
		this.toolGating = defineToolGating(toolGatingOptions(product));
		this.lookup = layeredThreadLookup(threadOwner, this.keys.memo);
		this.history = historyStores();
		this.titles = dueQueue({
			name: "title",
			namespace: this.keys.namespace,
			sweepMs: TITLE_SWEEP_MS,
			work: (resourceId, threadId) => this.nameThread(resourceId, threadId),
			failed(err) {
				problems.report("agent.title.failed", {});
				console.error("[title] a thread was not named:", err.message);
			},
		});
		this.memory = memoryStore({
			cache: this.caches.memory,
			keys: this.keys,
			details: memoryDetailsOf(product),
			history: (resourceId, threadId, limit, after) =>
				this.threadItems(resourceId, threadId, limit, after),
		});
		if (product.voice?.agentId === product.agentId)
			throw new Error(
				"the voice agent needs a name of its own: it is a second agent beside the typed one",
			);
		this.versions = agentVersions(product.agentId, this.keys, "prompt");
		this.voiceVersions = product.voice
			? agentVersions(product.voice.agentId, this.keys, "voice")
			: null;
		this.prompt = {
			caches: this.caches,
			memory: (resourceId) => this.memory.statements(resourceId),
			recentStamps,
			gating: this.toolGating,
		};
		this.warmer = new Warmer(() => [
			["foundry", () => this.agentExists(product.agentId, "prompt")],
			["cosmos", () => threadOwner("warm-probe")],
			["persona", () => product.persona()],
			["tool-gating", () => this.toolGating.read()],
			[
				"skills",
				async () =>
					fittingSkills(
						product.skills ?? [],
						{ surface: "", enabledTools: [] },
						true,
					),
			],
		]);
	}

	private admission(): AdmissionDeps {
		return {
			keys: this.keys.namespace,
			lookup: this.lookup,
			stamps: this.caches.stamps,
		};
	}

	private async agentExists(name: string, kind: AgentKind): Promise<boolean> {
		try {
			await projectClient().agents.get(name, kindOptions(kind));
			return true;
		} catch (err) {
			if (hasStatus(err, 404)) return false;
			throw err;
		}
	}

	/** The thread's index entry, made in the operator's store when this turn opens it; null when the id is somebody else's. */
	private async threadFor(
		resourceId: string,
		threadId: string,
		made: () => void = () => {},
	): Promise<ThreadDocument | null> {
		const existing = await readThreadDocument(resourceId, threadId);
		if (existing) return existing;
		const history = await this.history.forNew();
		// Said before the write: a thread half made is this turn's to take out too.
		made();
		return (
			(await openThread({ resourceId, threadId, title: "", history }))
				?.thread ?? null
		);
	}

	/** What memory extracts from: the thread's newest items, newest first, a turn the content filter blocked left out; none when there is no such thread. */
	private async threadItems(
		resourceId: string,
		threadId: string,
		limit: number,
		after?: string,
	): Promise<StoredItem[]> {
		const thread = await readThreadDocument(resourceId, threadId);
		return thread ? this.unblockedItems(thread, limit, after) : [];
	}

	/** The thread's newest items, newest first, from whichever store holds it, without the messages its `blocked` list names. */
	private async unblockedItems(
		thread: ThreadDocument,
		limit: number,
		after?: string,
	): Promise<StoredItem[]> {
		const blocked = new Set(thread.blocked ?? []);
		return (
			await this.history.for(thread).newestFirst(thread, limit, after)
		).filter((item) => !blocked.has(item.id));
	}

	/**
	 * Name a thread that still has no name, from its lines and never from one
	 * the content filter blocked: the small model's title when the person's
	 * bucket, the fleet's and this replica's cap allow one, the person's first
	 * line otherwise. A thread with no line left to name it by stays untitled.
	 * The name is written only while the thread has none, so a rename made
	 * meanwhile stands.
	 */
	private async nameThread(resourceId: string, threadId: string) {
		const thread = await readThreadDocument(resourceId, threadId);
		if (!thread || thread.title) return;
		const turns = saidLines(
			await this.unblockedItems(thread, TITLE_ITEMS_READ),
		);
		const opener = (turns.find((turn) => turn.role === "user") ?? turns[0])
			?.content;
		if (!opener) return;
		const title =
			(await generateTitle(turns, this.keys.namespace, resourceId)) ??
			titleFrom(opener);
		await nameUntitledThread(resourceId, threadId, title);
	}

	/** A thread with no name queued to be named. Never throws: a name is a label, not the turn. */
	private async nameLater(thread: ThreadDocument): Promise<void> {
		if (thread.title) return;
		try {
			await this.titles.schedule(thread.resourceId, thread.id, TITLE_DELAY_MS);
		} catch (err) {
			problems.report("agent.title.failed", {});
			console.error(
				"[title] a thread was not queued to be named:",
				(err as Error).message,
			);
		}
	}

	/** An output for every call the thread's latest exchange left open, saying nobody answered it. */
	private async closingWrites(thread: ThreadDocument) {
		const newest = await this.history
			.for(thread)
			.newestFirst(thread, OPEN_CALL_WINDOW);
		return notAnswered(openCalls(newest)).map((item) => ({ item }));
	}

	/** The turn's input on its thread, or why it is refused. */
	private async open(
		input: TurnInput,
		request: TurnRequest,
		live: LiveTurn,
	): Promise<OpenedThread | "invalid" | "forbidden"> {
		const { resourceId, threadId } = input;
		const bound = (await agentSettings()).history;
		if (request.kind === "answered") {
			const thread = await readThreadDocument(resourceId, threadId);
			if (!thread) return "invalid";
			const store = this.history.for(thread);
			const open = openCalls(
				await store.newestFirst(thread, OPEN_CALL_WINDOW),
				this.controls,
			);
			if (!answersOpenCalls(open, request.results)) return "invalid";
			const answers = answeredItems(request.results);
			return {
				thread,
				prepared: await store.prepare(thread, { answers }, bound),
			};
		}
		const thread = await this.threadFor(resourceId, threadId, () => {
			live.made = true;
		});
		if (!thread) return "forbidden";
		const said = saidItems(request.messages);
		return {
			thread,
			prepared: await this.history.for(thread).prepare(thread, { said }, bound),
		};
	}

	/** The version's definition for a turn of this shape. */
	private async definitionFor(
		turn: { surface: string; enabledTools: readonly string[] },
		fixed: string,
		skillsEnabled: boolean,
		serverTools = this.product.tools(turn),
	): Promise<PromptAgentDefinition> {
		const [settings, skills] = await Promise.all([
			agentSettings(),
			fittingSkills(this.product.skills ?? [], turn, skillsEnabled),
		]);
		return agentDefinition({
			fixed,
			clientTools: this.product.clientTools,
			serverTools,
			webSearch: turn.enabledTools.includes(WEB_SEARCH),
			skills: skills.map(({ name, version }) => ({ name, version })),
			settings,
		});
	}

	async startTurn(input: TurnInput): Promise<TurnOutcome> {
		const request = readTurnMessages(input.messages);
		const offered = offeredClientTools(
			this.product.clientTools,
			input.clientTools,
		);
		if (!request || !offered) return invalidTurn();
		const admission = await admitTurn(this.admission(), input);
		if (admission.kind === "refused") return admission;
		const { release, keep } = admission.claim;
		// One channel at a time: a live session holds its thread until it is settled.
		if ((await claimHolder(this.liveHold(input.threadId))).outcome === "held") {
			await release();
			problems.report("agent.turn.busy", { status: 409 });
			return {
				kind: "refused",
				refusal: { code: "thread.busy", status: 409 },
			};
		}
		// Counted as running before the thread is opened: a delete or an erase
		// that lands while the turn is still being put together finds it.
		const runId = crypto.randomUUID();
		const live = this.begin(input.resourceId, input.threadId, runId);
		let streaming = false;
		try {
			// Asked once the turn is counted here and in the fleet's set, and
			// before anything is written: whatever ended the caller's standing
			// after the request was admitted — an erase that shut the account —
			// either finds this turn and ends it, or is found here.
			await live.turn.registered();
			const unadmitted = await input.stillAdmitted?.();
			if (unadmitted) {
				await release();
				return { kind: "refused", refusal: callerRefused(unadmitted) };
			}
			const opened = await this.open(input, request, live);
			if (opened === "invalid") {
				await release();
				return invalidTurn();
			}
			if (opened === "forbidden") {
				await release();
				return {
					kind: "refused",
					refusal: { code: "thread.forbidden", status: 403 },
				};
			}
			const scope: TurnScope = {
				resourceId: input.resourceId,
				threadId: input.threadId,
				surface: input.surface,
				languageName: input.languageName,
				liveContext: input.liveContext ?? [],
				caller: input.caller ?? null,
			};
			const { parts, turn, gating } = await composeTurnPrompt(
				this.product,
				this.prompt,
				scope,
				{
					withheld: (await webSearchAvailable(scope.caller))
						? []
						: [WEB_SEARCH],
				},
			);
			const serverTools = this.product.tools(turn);
			const definition = await this.definitionFor(
				turn,
				parts.fixed,
				gating.skillsEnabled,
				serverTools,
			);
			const version = await this.versions.ensure(definition);
			const events = this.stream(input, request, opened, live, {
				scope,
				definition,
				version,
				personalization: parts.personalization,
				registered: new Set(offered.map((t) => t.name)),
				serverTools,
				runId,
				release,
				keep,
			});
			streaming = true;
			return { kind: "started", runId, events };
		} catch (err) {
			await release();
			throw err;
		} finally {
			// A turn that never streamed is over here.
			if (!streaming) {
				await this.leaveNothing(
					live,
					input.resourceId,
					input.threadId,
					input.stillAdmitted,
				);
				await live.over();
			}
		}
	}

	/** A thread's history, then its index entry — what an erase finds a thread by, so it goes last — then the lookup's memory of it. */
	private async takeOut(resourceId: string, threadId: string): Promise<void> {
		const thread = await readThreadDocument(resourceId, threadId);
		if (thread) await this.takeOutHeld(resourceId, thread);
		else {
			await removeThreadDocuments(resourceId, threadId);
			await this.lookup.forget(threadId);
		}
	}

	/** As `takeOut`, for a thread whose document was read before it went: what was written to its history after it went is found by the document held. */
	private async takeOutHeld(
		resourceId: string,
		thread: ThreadDocument,
	): Promise<void> {
		await this.history.for(thread).remove(thread);
		await removeThreadDocuments(resourceId, thread.id);
		await this.lookup.forget(thread.id);
	}

	/**
	 * What a turn that was ended leaves behind, taken out: the path every
	 * ended turn goes through, streamed or not, failed or not. An erase takes
	 * the person's every thread, so whatever this turn opened after the erase
	 * stopped looking goes with them. A delete took the thread it named, so a
	 * thread this turn then made under that id is nobody's: the delete
	 * answered that it was gone. A thread the turn only joined is the
	 * delete's own to remove. Never throws: it runs where a turn is ending.
	 */
	private async leaveNothing(
		live: LiveTurn,
		resourceId: string,
		threadId: string,
		stillAdmitted?: () => Promise<CallerRefusal | null>,
	): Promise<void> {
		try {
			const { entry, turn } = live;
			if (!entry.ended && !(await turn.ended())) {
				// Not told, and still a thread it made that nobody may keep: its caller's account erased since — an erase that could not find this turn, or one whose wait it outlived.
				if (live.made && (await stillAdmitted?.())?.status === 401)
					await this.takeOut(resourceId, threadId);
				return;
			}
			if (!entry.erased && !turn.whole() && !live.made) return;
			await this.takeOut(resourceId, threadId);
		} catch (err) {
			problems.report("agent.turn.failed", { reason: "ended" });
			console.error(
				"[agent] a turn that was ended may have left its thread behind:",
				(err as Error).message,
			);
		}
	}

	/** A turn counted as running on its person's thread, here and for the fleet, until `over`. */
	private begin(resourceId: string, threadId: string, runId: string): LiveTurn {
		const abort = new AbortController();
		let finished: () => void = () => {};
		const entry: RunningEntry = {
			resourceId,
			threadId,
			abort,
			done: new Promise<void>((resolve) => {
				finished = resolve;
			}),
			ended: false,
			erased: false,
		};
		this.running.add(entry);
		const turn = this.ends.running(resourceId, threadId, runId, (whole) => {
			entry.ended = true;
			entry.erased ||= whole;
			abort.abort();
		});
		return {
			entry,
			turn,
			made: false,
			over: async () => {
				await turn.done();
				this.running.delete(entry);
				finished();
			},
		};
	}

	private stream(
		input: TurnInput,
		request: TurnRequest,
		opened: OpenedThread,
		live: LiveTurn,
		run: {
			scope: TurnScope;
			definition: PromptAgentDefinition;
			version: string;
			personalization: string;
			registered: ReadonlySet<string>;
			serverTools: ReturnType<AgentProduct["tools"]>;
			runId: string;
			release: () => Promise<void>;
			keep: () => () => void;
		},
	): ReadableStream<TurnEvent> {
		const { entry, turn } = live;
		const { abort } = entry;
		const stopped = () => abort.abort();
		// A caller that left before the run began has no event to send.
		if (input.abortSignal?.aborted) stopped();
		else input.abortSignal?.addEventListener("abort", stopped, { once: true });
		const maxSteps = async () => (await agentSettings()).foundry.maxSteps;
		return new ReadableStream<TurnEvent>({
			start: (controller) => {
				const ended = async () => entry.ended || (await turn.ended());
				/** A thread deleted under the turn has nothing to write to: told so, or found gone. */
				const gone = async () =>
					(await ended()) ||
					!(await readThreadDocument(input.resourceId, input.threadId));
				/**
				 * Asked before each write the turn makes, not only its first: the
				 * thread still there and its caller's account not erased since.
				 * An erase this replica could not tell — a turn its set never
				 * recorded, or one that outlived the erase's wait — is found here.
				 * Only an erase stops a write: a store that did not answer, or a
				 * deactivation of the same person, does not cost them an answer
				 * they were shown; what an erase then finds it sweeps.
				 */
				const mayWrite = async () =>
					!(await gone()) && (await input.stillAdmitted?.())?.status !== 401;
				/** What a write found after it landed: the thread gone, or the account erased since — never a store that only did not answer. */
				const unwritten = async () =>
					(await gone()) || (await input.stillAdmitted?.())?.status === 401;
				// The claim outlives its TTL for as long as the turn runs.
				const unkeep = run.keep();
				let searches = 0;
				const emit = (event: TurnEvent) => {
					if (
						event.type === "tool-call" &&
						event.runsOn === "service" &&
						event.name === WEB_SEARCH
					)
						searches++;
					try {
						controller.enqueue(event);
					} catch {}
				};
				void runInUsageScope(
					{ turnId: run.runId, surface: input.surface },
					async () => {
						let result: LoopResult | null = null;
						// Whether what the turn wrote is in the thread's history.
						let kept = false;
						try {
							// Ended while it was being put together: the model is asked nothing.
							if (await ended()) {
								emit({ type: "error", code: "turn.failed" });
								await run.release();
								return;
							}
							result = await runLoop({
								scope: run.scope,
								agent: { name: this.product.agentId, version: run.version },
								personalization: run.personalization,
								input: opened.prepared.input,
								shape: opened.prepared.shape,
								serverTools: run.serverTools,
								registered: run.registered,
								controls: this.controls,
								maxSteps: await maxSteps(),
								signal: abort.signal,
								ended,
								reensure: async () => {
									await this.versions.forget(run.definition);
									return this.versions.ensure(run.definition);
								},
								emit,
							});
							if (!(await mayWrite())) {
								emit(
									result.kind === "failed"
										? result.event
										: { type: "error", code: "turn.failed" },
								);
								await run.release();
								return;
							}
							await this.history
								.for(opened.thread)
								.settle(opened.thread, opened.prepared, {
									...result,
									blocked:
										result.kind === "failed" &&
										result.event.code === "turn.blocked",
								});
							// Landed after the thread went or the account was erased: taken out again, and nothing more is written.
							if (await unwritten()) {
								await this.takeOutHeld(input.resourceId, opened.thread);
								emit({ type: "error", code: "turn.failed" });
								await run.release();
								return;
							}
							kept = true;
							if (result.kind === "finished") {
								for (const event of finishEvents(result, result.sources))
									emit(event);
								// The work after the answer is written as the answer was: only while it may be.
								if (!(await mayWrite())) return;
								await this.memory.handOver(input.resourceId, input.threadId, [
									...(request.kind === "said"
										? spokenBy(request.messages)
										: []),
									...(result.text
										? [{ role: "assistant" as const, content: result.text }]
										: []),
								]);
								if (!(await mayWrite())) return;
								await this.nameLater(opened.thread);
							} else {
								emit(result.event);
								await run.release();
							}
						} catch (err) {
							console.error("[agent] a turn failed:", (err as Error).message);
							// An answer that streamed and was not kept is a turn that
							// failed: the person is told, and the claim goes back so
							// their retry is answered. Once it is kept, what failed is
							// only the work after it, and the turn stands.
							if (!kept || result?.kind !== "finished") {
								if (result && !kept)
									problems.report("agent.turn.failed", {
										// An item the history cannot hold fails every retry the same way.
										reason:
											err instanceof HistoryItemTooLarge
												? "item_too_large"
												: "settle",
									});
								emit({ type: "error", code: "turn.failed" });
								await run.release();
							}
						} finally {
							unkeep();
							input.abortSignal?.removeEventListener("abort", stopped);
							// Charged however the turn ended: a search that ran was spent.
							await chargeWebSearches(run.scope.caller, searches).catch(
								(err: Error) =>
									console.error(
										"[agent] web searches went uncharged:",
										err.message,
									),
							);
							await this.leaveNothing(
								live,
								input.resourceId,
								input.threadId,
								input.stillAdmitted,
							);
							await live.over();
							try {
								controller.close();
							} catch {}
						}
					},
				).catch(() => {});
			},
			cancel: () => abort.abort(),
		});
	}

	async listThreads(
		resourceId: string,
		page?: ThreadPageRequest,
	): Promise<ThreadPage> {
		const { documents, next } = await listThreadDocuments(resourceId, page);
		return { threads: documents.map(summaryOf), next };
	}

	async readThread(
		resourceId: string,
		threadId: string,
		request: ThreadReadRequest = {},
	): Promise<ThreadView | null> {
		const thread = await readThreadDocument(resourceId, threadId);
		if (!thread) return null;
		const { foundry } = await agentSettings();
		const page = await this.history.for(thread).page(thread, {
			before: request.before,
			messages:
				request.limit === undefined
					? Number.POSITIVE_INFINITY
					: Math.max(Math.trunc(request.limit) || 1, 1),
			maxItems: foundry.maxItemsRead,
		});
		return { ...summaryOf(thread), ...page };
	}

	renameThread(
		resourceId: string,
		threadId: string,
		title: string,
	): Promise<boolean> {
		return setThreadTitle(resourceId, threadId, titleFrom(title));
	}

	async deleteThread(resourceId: string, threadId: string): Promise<boolean> {
		// The caller's own thread, before anything is ended: a thread id names
		// nothing of anybody else's.
		if (!(await readThreadDocument(resourceId, threadId))) return false;
		// A turn streaming on the thread would write after the delete, to a
		// thread nothing finds any more: it is stopped and waited for first.
		await this.endTurns(resourceId, threadId);
		// Read again: the turn that was stopped may have made the thread, and
		// taken it out as it ended. Gone either way, which is what was asked.
		await this.takeOut(resourceId, threadId);
		// The newest conversation may have been this one.
		await this.caches.stamps.drop(resourceId);
		return true;
	}

	/**
	 * Stop the person's turns on a thread — on every thread of theirs when
	 * none is named — and wait until each is over: this replica's own, then
	 * any another replica is streaming (`coordination/thread-ends.ts`), for
	 * `END_WAIT_MS` in all. A turn that outlasts the wait is marked ended and
	 * writes nothing; one whose replica cannot reach Redis is not told.
	 */
	private async endTurns(resourceId: string, threadId?: string): Promise<void> {
		const turns = [...this.running].filter(
			(t) =>
				t.resourceId === resourceId &&
				(threadId === undefined || t.threadId === threadId),
		);
		for (const turn of turns) {
			turn.ended = true;
			turn.erased ||= threadId === undefined;
			turn.abort.abort();
		}
		// One bound for both waits: a turn of this replica's is in the fleet's set too.
		const until = Date.now() + END_WAIT_MS;
		if (
			!(await within(Promise.all(turns.map((turn) => turn.done)), END_WAIT_MS))
		)
			console.warn("[agent] a thread ended with a turn still running here");
		if (
			!(await this.ends.end(
				resourceId,
				threadId,
				Math.max(until - Date.now(), 0),
			))
		)
			console.warn(
				"[agent] a thread ended with a turn still running on another replica",
			);
	}

	readMemory(resourceId: string): Promise<PersonMemory> {
		return this.memory.read(resourceId);
	}

	updateMemoryItem(
		resourceId: string,
		itemId: string,
		content: string,
	): Promise<MemoryItem | null> {
		return this.memory.update(resourceId, itemId, content);
	}

	removeMemoryItem(resourceId: string, itemId: string): Promise<boolean> {
		return this.memory.remove(resourceId, itemId);
	}

	forgetMemory(resourceId: string): Promise<boolean> {
		return this.memory.forget(resourceId);
	}

	personChanged(resourceId: string): Promise<void> {
		return this.caches.person.drop(resourceId);
	}

	personalization(
		resourceId: string,
		channel: ReplyChannel,
	): Promise<PersonBlocks> {
		return readPersonBlocks(this.prompt, resourceId, null, channel);
	}

	eraseResource(
		resourceId: string,
		options: { stillHeld?: () => Promise<boolean> } = {},
	): Promise<EraseReport> {
		return eraseResource(
			{
				endTurns: (r) => this.endTurns(r),
				deleteThread: (r, t) => this.deleteThread(r, t),
				sweepHistory: removeHistoryOf,
				memory: this.memory,
				caches: this.caches,
				stillHeld: options.stillHeld,
			},
			resourceId,
		);
	}

	warmUp(): Promise<void> {
		return this.warmer.warm();
	}

	/**
	 * The project must answer, for the agent and, for a product with a live
	 * voice, for the voice agent: an agent that does not exist yet is the
	 * first turn's, or the first session's, to make, but a project that
	 * refuses either fails the start. The voice is the product's only live
	 * engine, so a replica that cannot reach it is not one to route to.
	 * While `history.store` names the service's conversations, the start
	 * says once what that keeps (`agent.history.service_retention`); while
	 * the voice document asks for speech-to-speech that cannot run, or a
	 * transcriber it replaces, it says that too (`voice-engine.ts`).
	 */
	async start(): Promise<void> {
		await this.agentExists(this.product.agentId, "prompt");
		if (this.product.voice)
			await this.agentExists(this.product.voice.agentId, "voice");
		const settings = await agentSettings();
		historyKeptByService(settings.history);
		if (this.product.voice) reportVoiceEngines(settings.voice);
		this.memory.start();
		this.titles.start();
	}

	async stop(): Promise<void> {
		const turns = [...this.running];
		for (const running of turns) running.abort.abort();
		// Together, and each bounded: a stop is one part of a shutdown that has a deadline of its own.
		await Promise.all([
			within(Promise.all(turns.map((turn) => turn.done)), STOP_WAIT_MS),
			this.memory.stop(),
			this.titles.stop(),
		]);
		await this.ends.stop();
	}

	/** The product's live voice, for a path that has none without it. */
	private voice(): ProductVoice & {
		versions: AgentVersions<VoiceAgentDefinition>;
	} {
		const { voice } = this.product;
		if (!voice || !this.voiceVersions)
			throw new Error("the product has no live voice");
		return { ...voice, versions: this.voiceVersions };
	}

	/**
	 * What a live session is told: the voice surface's prompt in the spoken
	 * register. A typed turn asks the person's `toolSearch` bucket as it
	 * starts; a session lasts many turns, so its search — the backend's
	 * function (`voice-tools.ts`), not the service's tool — asks the bucket
	 * at each call instead, and the bucket refilling mid-session gives search
	 * back as the next typed turn would get it. Web search is withheld only
	 * from a session nobody verified, which has no account to charge, as a
	 * typed turn's is. The job's step makes the version a verified person's
	 * session asks for (`accountable`).
	 */
	private async liveTurnPrompt(
		scope: TurnScope,
		accountable = webSearchAccountable(scope.caller),
	): Promise<TurnPrompt> {
		return composeTurnPrompt(this.product, this.prompt, scope, {
			channel: "spoken",
			withheld: accountable ? [] : [WEB_SEARCH],
		});
	}

	/**
	 * A live session's tools, all the backend's: the product's for the turn
	 * and what a typed turn has from the service that a voice agent cannot
	 * hold, web search and the skills that fit the turn as its agent version
	 * would pin them, as functions of the backend's (`voice-tools.ts`).
	 */
	private async voiceTools(prompt: TurnPrompt): Promise<SessionTools> {
		const skills = await fittingSkills(
			this.product.skills ?? [],
			prompt.turn,
			prompt.gating.skillsEnabled,
		);
		return {
			serverTools: {
				...this.product.tools(prompt.turn),
				...voiceServiceTools({
					webSearch: prompt.turn.enabledTools.includes(WEB_SEARCH),
					skills,
				}),
			},
		};
	}

	/**
	 * The voice agent's version of one engine for a live session's prompt:
	 * parts one and two of it, every function tool the voice surface has,
	 * the audio defaults, and the engine's model — the chat's deployment for
	 * the cascade, a realtime one for speech-to-speech, which the caller has
	 * already checked exists (`voice-engine.ts`, `voice-tuning.ts`), or a
	 * managed model of the engine's (`voice-models.ts`). One version per
	 * definition across the fleet (`versions.ts`), so each engine — and each
	 * realtime or managed model, fillers off and an OpenAI voice, which takes
	 * no fillers — is a version of one voice agent, and every call that
	 * touches it carries the preview opt-in.
	 */
	private async ensureVoiceVersion(
		prompt: TurnPrompt,
		{ serverTools }: SessionTools,
		shape: {
			engine: VoiceEngine;
			realtime: RealtimeDeployment | null;
			/** A managed model the version names in place of a deployment. */
			managed: ManagedVoiceModel | null;
			interim: boolean;
			/** An OpenAI voice the version speaks with; absent: the base tier's Azure voice. */
			voice?: string;
			/** A voice tester's turn detection and noise suppression. */
			heard?: VersionHearing;
		},
	): Promise<{
		version: string;
		audio: VoiceAudio;
		/** Every layer's memory of this version forgotten, for a version the service no longer has. */
		forget(): Promise<void>;
	}> {
		const voice = this.voice();
		const { definition, audio } = await this.voiceDefinition(
			prompt,
			{ serverTools },
			shape,
		);
		const version = await voice.versions.ensure(definition);
		return {
			version,
			audio,
			forget: () => voice.versions.forget(definition),
		};
	}

	/** The definition a voice version of `shape` is made of, and the audio documents it read: saved as a version on a voice agent, sent as the session's update on Voice Live. */
	private async voiceDefinition(
		prompt: TurnPrompt,
		{ serverTools }: SessionTools,
		shape: Parameters<FoundryAgentHost["ensureVoiceVersion"]>[2],
	): Promise<{ definition: VoiceAgentDefinition; audio: VoiceAudio }> {
		const voice = this.voice();
		const { engine, realtime, managed } = shape;
		if (engine === "speechToSpeech" && !realtime && !managed)
			throw new Error(
				"speech-to-speech needs a realtime deployment or a managed model",
			);
		const [settings, audio, tools, model] = await Promise.all([
			agentSettings(),
			voice.audio(),
			functionTools(this.product.clientTools, serverTools),
			managed
				? managed.name
				: realtime
					? realtime.deployment
					: chatDeployment(),
		]);
		const definition = voiceAgentDefinition({
			fixed: prompt.parts.fixed,
			tools,
			languages: voice.languages,
			engine,
			model,
			managed,
			settings: settings.voice,
			voiceName: shape.voice ?? audio.voices.base,
			raiPolicy: envString("FOUNDRY_RAI_POLICY"),
			interim: shape.interim,
			...(shape.heard ? { heard: shape.heard } : {}),
		});
		return { definition, audio };
	}

	/**
	 * A voice version a live session runs on, marked for as long as the
	 * session can last, so the job's prune keeps it however many versions
	 * came after it. Best effort: without Redis the mark is not kept, and a
	 * pruned version is made again on the session's next open.
	 */
	private async markVersionInUse(version: string, ttlMs: number) {
		const key = this.keys.namespace.key("voice-version-in-use", version);
		const claimed = await claimOnce(key, IN_USE, ttlMs);
		if (claimed.outcome === "held") await extendClaim(key, IN_USE, ttlMs);
	}

	/** Whether a session may still be running on a voice version: the prune's question. */
	private async versionInUse(version: string): Promise<boolean> {
		const held = await claimHolder(
			this.keys.namespace.key("voice-version-in-use", version),
		);
		// Unanswerable is in use: a version kept a run too long costs nothing.
		return held.outcome !== "free";
	}

	/**
	 * A live session's calls: the backend's tools the version was made with,
	 * run in the session's scope under a usage scope of its own, with the
	 * documents each handed the model; and every control the product
	 * defines left to the browser.
	 */
	private liveTools(
		scope: TurnScope,
		{ serverTools }: SessionTools,
		sessionId: string,
	): LiveVoiceTools {
		return {
			inBrowser: (name) => this.controls.has(name),
			onServer: (name) => Object.hasOwn(serverTools, name),
			run: async (name, args) => {
				const answer = await runInUsageScope(
					{ turnId: sessionId, surface: scope.surface },
					() => runProductTool(serverTools, scope, { name, arguments: args }),
				);
				return {
					output: outputText(answer.result),
					sources: sourcesOf(serverTools, name, answer),
				};
			},
		};
	}

	/** The key a live session holds its thread under, owned by the session's id. */
	private liveHold(threadId: string): string {
		return this.keys.namespace.key("live-thread", threadId);
	}

	async liveVoiceBinding(
		resourceId: string,
		threadId: string,
		request: LiveVoiceRequest,
	): Promise<LiveVoiceOutcome> {
		const voice = this.product.voice;
		// The locale reaches a prompt and a transcriber: one the product does not speak goes no further.
		if (!voice?.languages.isLocale(request.locale))
			return liveRefused({ code: "turn.invalid", status: 400 });
		try {
			const ownership = await ownershipOf(this.lookup, threadId, resourceId);
			if (ownership === "theirs")
				return liveRefused({ code: "thread.forbidden", status: 403 });
			if (ownership === "nobodys") await this.caches.stamps.drop(resourceId);
		} catch (err) {
			if (!(err instanceof ThreadLookupError)) throw err;
			return liveRefused({ code: "thread.unavailable", status: 503 });
		}
		const hold = this.liveHold(threadId);
		const held = await claimOnce(
			hold,
			request.sessionId,
			(request.maxSessionSeconds + HOLD_GRACE_SECONDS) * 1000,
		);
		if (held.outcome === "held" && held.owner !== request.sessionId)
			return liveRefused({ code: "thread.busy", status: 409 });
		// Counted as running before the thread is made or written, as a typed
		// turn is, and the caller asked again then: an erase finds the
		// binding, or the binding finds the erase.
		const live = this.begin(resourceId, threadId, request.sessionId);
		try {
			await live.turn.registered();
			const unadmitted = await request.stillAdmitted?.();
			if (unadmitted) {
				await releaseClaim(hold, request.sessionId);
				return liveRefused(callerRefused(unadmitted));
			}
			const thread = await this.threadFor(resourceId, threadId, () => {
				live.made = true;
			});
			if (!thread) {
				await releaseClaim(hold, request.sessionId);
				return liveRefused({ code: "thread.forbidden", status: 403 });
			}
			const store = this.history.for(thread);
			// What a typed turn on the own store would be given, read before the closing outputs: they answer calls it holds.
			const settings = await agentSettings();
			const bound = settings.history;
			const history = liveHistoryLines(
				boundHistory(await store.newestFirst(thread, bound.maxItems), bound),
			);
			// A session's words after an open call end the search for it, as typed words do.
			await store.append(thread, await this.closingWrites(thread));
			const caller = request.caller ?? null;
			const scope: TurnScope = {
				resourceId,
				threadId,
				surface: voice.surface,
				languageName: voice.languages.languageName(request.locale),
				liveContext: request.screen ?? [],
				caller,
			};
			const prompt = await this.liveTurnPrompt(scope);
			const tools = await this.voiceTools(prompt);
			// The person's tier picks the engine — or a voice tester's tuning does — and with it the version the client asks for.
			const documents = await voice.audio();
			const effective = effectiveVoice(
				settings,
				{
					realtime: realtimeDeployments(),
					voices: documents.voices,
					openaiVoices: documents.openaiVoices,
				},
				request.tier,
				request.tuning ?? null,
			);
			const shape = {
				engine: effective.engine,
				realtime: effective.realtime,
				managed: effective.managed,
				interim: effective.interimResponses,
				// An OpenAI voice is the version's, since the version's fillers depend on it.
				...(isOpenAIVoice(effective.voice) ? { voice: effective.voice } : {}),
				// So are a tester's turn detection and noise suppression: a session cannot change either.
				...(request.tuning
					? {
							heard: versionHearing(
								request.tuning,
								effective,
								voice.languages.codes,
							),
						}
					: {}),
			};
			const reasoning: SessionReasoning | null =
				effective.reasoningEffort && effective.reasoningEffort !== "none"
					? {
							effort: effective.reasoningEffort as SessionReasoning["effort"],
						}
					: null;
			const personalization = await fittedPersonalization(
				prompt,
				voiceInstructionCap(effective),
			);
			const update = (audio: VoiceAudio, transcription: Transcriber) =>
				voiceSessionUpdate({
					transcription,
					reasoning,
					audio,
					voice: effective.voice,
					tier: request.tier,
					locale: request.locale,
					languages: voice.languages,
					...(request.tuning
						? {
								tuned: sessionTuning(request.tuning, effective),
							}
						: {}),
				});
			const common = {
				maxSteps: settings.foundry.maxSteps,
				tools: this.liveTools(scope, tools, request.sessionId),
				history,
			};
			let binding: LiveVoiceBinding;
			if (settings.voice.runtime === "voiceLive") {
				// No version: Voice Live is told everything in the session's own update, on a model it hosts.
				const managed = voiceLiveModel(effective.engine, effective.managed);
				const { definition, audio } = await this.voiceDefinition(
					prompt,
					tools,
					{ ...shape, managed },
				);
				binding = {
					...common,
					agentName: VOICE_LIVE_RUNTIME,
					version: managed.name,
					runtime: { kind: "voiceLive", model: managed.name },
					reensure: async () => managed.name,
					structuredInputs: {
						[PERSONALIZATION_INPUT]: personalization,
						[LANGUAGE_INPUT]: request.locale,
					},
					session: voiceLiveSession(
						definition,
						update(audio, definition.audio.input.transcription.model),
						personalization,
					),
				};
			} else {
				const { version, audio, forget } = await this.ensureVoiceVersion(
					prompt,
					tools,
					shape,
				);
				const holdMs = (request.maxSessionSeconds + HOLD_GRACE_SECONDS) * 1000;
				await this.markVersionInUse(version, holdMs);
				binding = {
					...common,
					agentName: voice.agentId,
					version,
					// This engine's version only: the other engine's is not the one that went missing.
					reensure: async () => {
						await forget();
						const again = (await this.ensureVoiceVersion(prompt, tools, shape))
							.version;
						await this.markVersionInUse(again, holdMs);
						return again;
					},
					structuredInputs: {
						[PERSONALIZATION_INPUT]: personalization,
						[LANGUAGE_INPUT]: request.locale,
					},
					session: update(audio, effective.transcription),
				};
			}
			// Ended while it was being opened — the thread deleted, the person
			// erased — the session has no thread: the binding's own is taken
			// out as it ends, and asked again it finds why.
			if (live.entry.ended || (await live.turn.ended())) {
				await releaseClaim(hold, request.sessionId);
				return liveRefused({ code: "thread.unavailable", status: 503 });
			}
			return { kind: "bound", binding };
		} catch (err) {
			await releaseClaim(hold, request.sessionId);
			throw err;
		} finally {
			// A thread this binding made after a delete or an erase ended it is taken out again; the session then settles into nothing.
			await this.leaveNothing(
				live,
				resourceId,
				threadId,
				request.stillAdmitted,
			);
			await live.over();
		}
	}

	async settleLiveVoice(
		resourceId: string,
		threadId: string,
		settle: Parameters<AgentHost["settleLiveVoice"]>[2],
	): Promise<LiveVoiceSettlement | null> {
		const { sessionId, stillAdmitted } = settle;
		// Counted as running while it writes: an erase or a delete of the
		// thread ends it and waits for it, so what it wrote goes with the
		// thread; one that began after is found by nothing, and finds no
		// thread to write to.
		const live = this.begin(resourceId, threadId, `${sessionId}:settle`);
		try {
			await live.turn.registered();
			if (live.entry.ended || (await live.turn.ended())) return null;
			const thread = await readThreadDocument(resourceId, threadId);
			if (!thread) return null;
			const now = new Date().toISOString();
			const { lines, settlement } = spokenRecord(settle.spoken, now);
			const once = this.keys.namespace.key("live-settled", sessionId);
			if ((await claimOnce(once, "settled", SETTLED_TTL_MS)).outcome === "held")
				return { ...settlement, written: 0, interrupted: 0, repeated: true };
			const unheard = settlement.skipped.failed + settlement.skipped.unsettled;
			if (unheard) {
				problems.report("agent.voice.unheard", {
					reason: settlement.skipped.failed ? "failed" : "unsettled",
					measured: unheard,
				});
				console.warn(
					`[agent] ${unheard} of a live session's turns had no transcript and are not in the thread (${settlement.skipped.failed} failed, ${settlement.skipped.unsettled} never came)`,
				);
			}
			if (!lines.length) return { ...settlement, repeated: false };
			/** As a typed turn's: before each write, the thread still there and its caller's account not erased since. */
			const gone = async () =>
				live.entry.ended ||
				(await live.turn.ended()) ||
				!(await readThreadDocument(resourceId, threadId));
			const mayWrite = async () =>
				!(await gone()) && (await stillAdmitted?.())?.status !== 401;
			if (!(await mayWrite())) return null;
			try {
				await this.history.for(thread).append(thread, [
					...(await this.closingWrites(thread)),
					// Each line keeps when it was said; one that led to a filtered answer is marked blocked.
					...lines.map((line) => ({
						item: { type: "message", role: line.role, content: line.text },
						at: line.at,
						...(line.blocked ? { blocked: true } : {}),
					})),
				]);
			} catch (err) {
				// A retry may write it all: a line written twice is better than one lost.
				await releaseClaim(once, "settled");
				throw err;
			}
			// Landed after the thread went or the account was erased — a settle that outlived the erase's wait: taken out again.
			if ((await gone()) || (await stillAdmitted?.())?.status === 401) {
				await this.takeOutHeld(resourceId, thread);
				return null;
			}
			await touchThread(resourceId, threadId);
			if (!(await mayWrite())) return { ...settlement, repeated: false };
			await this.nameLater(thread);
			if (!(await mayWrite())) return { ...settlement, repeated: false };
			await this.memory.handOver(
				resourceId,
				threadId,
				lines.flatMap((line) =>
					line.blocked ? [] : [{ role: line.role, content: line.text }],
				),
			);
			return { ...settlement, repeated: false };
		} finally {
			await live.over();
			// However it ended, the thread is the typed channel's again.
			await releaseClaim(this.liveHold(threadId), sessionId);
		}
	}

	/**
	 * The job's `agent` step: the version each typed surface's turns will
	 * ask for, made before traffic arrives, then, for a product with a live
	 * voice, the voice agent's version for its surface, and all but the
	 * newest `keepVersions` of each agent deleted. The versions are the ones
	 * a turn computes for an account with its web searches in hand: a
	 * definition depends on who is asking only through that one allowance.
	 * The voice surface has no prompt-agent version: a live session is the
	 * voice agent's alone. The voice agent gets one version per engine some
	 * tier is answered by — speech-to-speech only with a realtime deployment
	 * (`voice-engine.ts`) — and the prune never deletes either engine's
	 * current one, however many versions of the other came after it, nor
	 * one a live session is marked as running on (a voice tester's own).
	 *
	 * A project that refuses a running engine's version fails the step, and
	 * the deploy with it: the voice agent is the product's only live engine,
	 * and a deploy that went on without it would serve sessions nothing can
	 * answer. An engine that falls back to the cascade is not refused: the
	 * cascade's version is the one made.
	 */
	async prime(surfaces: readonly string[]): Promise<{
		versions: string[];
		/** The voice agent's version for each engine that runs. */
		voice: Partial<Record<VoiceEngine, string>>;
		pruned: number;
	}> {
		const spoken = this.product.voice?.surface;
		const nobody = (surface: string): TurnScope => ({
			resourceId: null,
			threadId: null,
			surface,
			languageName: "English",
			liveContext: [],
			caller: null,
		});
		const versions: string[] = [];
		for (const surface of surfaces) {
			if (surface === spoken) continue;
			const { parts, turn, gating } = await composeTurnPrompt(
				this.product,
				this.prompt,
				nobody(surface),
				{ channel: "written" },
			);
			versions.push(
				await this.versions.ensure(
					await this.definitionFor(turn, parts.fixed, gating.skillsEnabled),
				),
			);
		}
		const settings = await agentSettings();
		const { keepVersions } = settings.foundry;
		const voice: Partial<Record<VoiceEngine, string>> = {};
		let pruned = 0;
		if (spoken && this.product.voice) {
			const prompt = await this.liveTurnPrompt(nobody(spoken), true);
			const tools = await this.voiceTools(prompt);
			const [primary] = realtimeDeployments();
			// The voice agent's versions, made whichever runtime is chosen, so a switch to it needs no deploy.
			const running = voiceEnginesRunning({
				...settings.voice,
				runtime: "agent",
			});
			// Each engine's model: the document's managed one, or this deployment's.
			const modelOf = (engine: VoiceEngine) => {
				const managed = managedVoiceModel(settings.voice.managedModel[engine]);
				return {
					engine,
					managed: managed?.engine === engine ? managed : null,
					realtime:
						engine === "speechToSpeech" && !managed ? (primary ?? null) : null,
				};
			};
			for (const engine of running)
				voice[engine] = (
					await this.ensureVoiceVersion(prompt, tools, {
						...modelOf(engine),
						interim: true,
					})
				).version;
			// A tier the voice document gives an OpenAI voice speaks it on speech-to-speech, on a version of its own.
			const kept = [...Object.values(voice)];
			const speechToSpeech = modelOf("speechToSpeech");
			if (
				running.includes("speechToSpeech") &&
				(speechToSpeech.managed?.openaiVoices ?? Boolean(primary))
			) {
				const { openaiVoices } = await this.product.voice.audio();
				const spoken = new Set(
					(["base", "premium"] as const).flatMap((tier) => {
						const named = openaiVoices?.[tier];
						return named &&
							isOpenAIVoice(named) &&
							voiceEngineForTier(settings.voice, tier) === "speechToSpeech"
							? [named]
							: [];
					}),
				);
				for (const named of spoken)
					kept.push(
						(
							await this.ensureVoiceVersion(prompt, tools, {
								...speechToSpeech,
								interim: false,
								voice: named,
							})
						).version,
					);
			}
			pruned += await pruneVersions(
				this.product.voice.agentId,
				keepVersions,
				"voice",
				kept,
				(version) => this.versionInUse(version),
			);
		}
		// The versions just made current are kept, wherever they stand among
		// the newest: a definition returned to is found at its old number.
		pruned += await pruneVersions(
			this.product.agentId,
			keepVersions,
			"prompt",
			versions,
		);
		return { versions, voice, pruned };
	}
}

/** The caller's own refusal, handed on as it said it. */
function callerRefused(refusal: CallerRefusal): {
	code: "caller.refused";
	status: CallerRefusal["status"];
	reason: string;
} {
	return {
		code: "caller.refused",
		status: refusal.status,
		reason: refusal.code,
	};
}

function liveRefused(refusal: LiveVoiceRefusal): LiveVoiceOutcome {
	// The caller reported its own refusal.
	if (refusal.code === "caller.refused") return { kind: "refused", refusal };
	problems.report(
		refusal.code === "turn.invalid"
			? "agent.turn.invalid"
			: refusal.code === "thread.forbidden"
				? "agent.turn.forbidden_thread"
				: refusal.code === "thread.busy"
					? "agent.turn.busy"
					: "agent.turn.ownership_unavailable",
		{ status: refusal.status },
	);
	return { kind: "refused", refusal };
}

/** The words a person said this turn, for the memory store: never a picture. */
function spokenBy(messages: readonly SaidMessage[]): MemoryMessage[] {
	return messages.flatMap((message) => {
		const content =
			typeof message.content === "string"
				? message.content
				: message.content
						.flatMap((part) => (part.type === "text" ? [part.text] : []))
						.join("\n");
		return content.trim() ? [{ role: message.role, content }] : [];
	});
}

export function createFoundryAgentHost(
	product: AgentProduct,
): FoundryAgentHost {
	return new FoundryAgentHost(product);
}
