import type { ConfigKey } from "@platform/config";
import {
	composeSystemPromptParts,
	languageDirective,
	type PersonalizationInput,
	type ReplyChannel,
	renderDossierBlock,
	renderIdentityBlock,
	renderLiveContextBlock,
	renderMemoryBlock,
	type SystemPromptParts,
	todayUtc,
} from "@platform/prompt";
import type { PersonBlocks } from "./contract/host";
import type { AgentProduct, ProductTurn } from "./contract/product";
import type { PersonCaches } from "./person/caches";
import {
	type RecentStamps,
	readLastConversation,
} from "./person/last-conversation";
import { readPerson } from "./person/person";
import { agentSettings } from "./settings";
import type { ToolGatingConfig } from "./tool-gating";
import type { TurnScope } from "./turn/scope";

/**
 * Everything the model is told before the first message, assembled per turn
 * through `composeSystemPromptParts` and nowhere else: the product's
 * guardrails, its persona and surface block, then the personalization — the
 * date, who they are, what they wrote, what is remembered about them, when
 * they last talked, what is on their screen, and the language last, because
 * it has to outrank the English above it. The reads run together, so the
 * turn pays for the slowest, and none of them throws: each answers
 * "nothing" instead. Where the memory and the threads live is the host's, so
 * it hands those two reads in; the rest is the same for every host.
 */
export interface PromptDeps {
	caches: PersonCaches;
	/** What is remembered about the person, as statements newest first; null when it cannot be read. */
	memory(resourceId: string): Promise<readonly string[] | null>;
	recentStamps: RecentStamps;
	gating: ConfigKey<ToolGatingConfig>;
}

/**
 * The person's blocks, rendered for the channel: the one path both channels
 * read them through, so a spoken session opens knowing what a typed turn is
 * told. `threadId` is the conversation being had, which the last-conversation
 * stamp skips; a channel that opens a thread of its own passes none.
 */
export async function readPersonBlocks(
	deps: PromptDeps,
	resourceId: string | null,
	threadId: string | null,
	channel: ReplyChannel,
): Promise<PersonBlocks> {
	const [person, memory, lastConversationAt, settings] = await Promise.all([
		readPerson(resourceId, deps.caches.person),
		resourceId ? deps.memory(resourceId) : null,
		readLastConversation(
			deps.recentStamps,
			deps.caches.stamps,
			resourceId,
			threadId,
		),
		agentSettings(),
	]);
	return {
		identity: renderIdentityBlock(person.identity),
		// What they stated before what is remembered, so where the two
		// disagree the agent meets their own words first.
		dossier: renderDossierBlock(person.dossier, channel),
		memory: memory ? renderMemoryBlock(memory, settings.memory.maxChars) : null,
		lastConversationAt,
	};
}

/** One turn's prompt, split where an agent version ends, with the shape of turn and the switches its tools are drawn by. */
export interface TurnPrompt {
	parts: SystemPromptParts;
	/** Part three's blocks, rendered: what a channel with a token budget leaves whole blocks of out (`voice-budget.ts`). */
	blocks: PersonalizationInput;
	turn: ProductTurn;
	gating: ToolGatingConfig;
}

export async function composeTurnPrompt(
	product: AgentProduct,
	deps: PromptDeps,
	scope: TurnScope,
	options: { channel?: ReplyChannel; withheld?: readonly string[] } = {},
): Promise<TurnPrompt> {
	const channel = options.channel ?? "written";
	const [persona, guardrails, gating, person] = await Promise.all([
		product.persona(),
		product.guardrails(channel),
		deps.gating.read(),
		readPersonBlocks(deps, scope.resourceId, scope.threadId, channel),
	]);
	// A tool withheld from this turn is gone from its version and its words alike.
	const withheld = options.withheld ?? [];
	const turn: ProductTurn = {
		surface: scope.surface,
		enabledTools: gating.enabledTools.filter((key) => !withheld.includes(key)),
	};
	const blocks: PersonalizationInput = {
		today: todayUtc(),
		...person,
		liveContext: renderLiveContextBlock(
			scope.liveContext.map((line) => `${line.label}: ${line.value}`),
		),
		language: languageDirective(scope.languageName, {
			properNouns: product.properNouns,
		}),
	};
	return {
		turn,
		gating,
		blocks,
		parts: composeSystemPromptParts({
			guardrails,
			persona,
			behaviour: product.behaviour(turn),
			personalization: blocks,
		}),
	};
}
