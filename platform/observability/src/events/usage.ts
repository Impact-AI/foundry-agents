import { AsyncLocalStorage } from "node:async_hooks";
import { defineEventChannel } from "./channel";

/**
 * What a model call cost: one line per completion, embedding, transcription
 * or synthesis, with counts and timings and nothing else — no prompt, no
 * message content, no user text. The caller that measured a call hands over
 * the numbers it has; a provider adapter that must first flatten its SDK's
 * usage block does that before calling {@link emitUsage}, so this module knows
 * no SDK.
 *
 * Every key is always present and an unknown is `null`, never absent and never
 * zero: every column here gets averaged, and a zero is a measured observation
 * that would drag the mean down for every row it is pooled with, while a null
 * says the concept does not exist for this kind of call.
 */

/** The `evt` value every line carries. Queries key off this literal. */
export const USAGE_EVENT = "llm_usage";

/**
 * Which kind of spend a line describes. They are not commensurable — a
 * transcription is priced in seconds of audio, a completion in tokens — which
 * is why the row says which it is rather than leaving a reader to infer it
 * from which columns are null.
 */
export type UsageKind =
	| "chat"
	| "embedding"
	| "transcription"
	| "speech"
	/** One response of a live voice session: the voice agent's tokens (the chat deployment's, in a cascade), priced at its tier. */
	| "voice";

/** What a turn is, as far as a model call is concerned. */
export interface UsageScope {
	/**
	 * An id minted for the turn, so the several calls one turn makes can be
	 * counted together. Never an account, session or thread id.
	 */
	turnId: string | null;
	/** Which client surface the turn came from. */
	surface: string | null;
}

/** Which call it was and how long it took: what every line knows. */
interface UsageCall {
	kind: UsageKind;
	provider: string;
	model: string;
	durationMs: number;
}

/** What a call measured. Null where the kind has no such concept. */
interface UsageMeasures {
	finishReason: string | null;
	inputTokens: number | null;
	outputTokens: number | null;
	/** Taken when the provider reports one; summed from the halves when both are known. */
	totalTokens: number | null;
	reasoningTokens: number | null;
	cachedInputTokens: number | null;
	/** Time to the first content delta. Null on a non-streaming path. */
	ttftMs: number | null;
	/** Seconds of audio billed, the real cost unit of a duration-billed model. */
	audioSeconds: number | null;
	/** Bytes of audio in or out. */
	audioBytes: number | null;
	/** Characters of text in or out. A count, never the text. */
	characters: number | null;
	/** How many values one embedding call embedded, in this provider call. */
	embeddedValues: number | null;
}

export interface UsageLine extends UsageScope, UsageCall, UsageMeasures {
	evt: typeof USAGE_EVENT;
	ts: string;
}

/**
 * One call's worth of numbers. Everything optional defaults to null, so a
 * call site states what it measured and stays silent about the rest.
 */
export interface UsageEmission extends UsageCall, Partial<UsageMeasures> {
	/** Given wins over the ambient scope; both absent is null. */
	surface?: string | null;
}

/**
 * Per async context, not a module-level slot: a replica serves many turns at
 * once, and a shared slot would stamp one turn's id onto another's calls.
 */
const scopeStorage = new AsyncLocalStorage<UsageScope>();

export function runInUsageScope<T>(scope: UsageScope, fn: () => T): T {
	return scopeStorage.run(scope, fn);
}

/** The current turn's scope, or undefined outside one (a worker, a test). */
export function currentUsageScope(): UsageScope | undefined {
	return scopeStorage.getStore();
}

export const usageChannel = defineEventChannel<UsageLine>({
	event: USAGE_EVENT,
	switchVar: "LLM_USAGE_LOG",
});

/** A finite number, or null. Providers omit fields and occasionally send junk. */
function count(value: number | null | undefined): number | null {
	return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/** To a tenth of a millisecond: finer than any latency claim, readable in a log. */
function millis(value: number | null | undefined): number | null {
	const finite = count(value);
	return finite === null ? null : Math.round(finite * 10) / 10;
}

/** Write one line, or nothing. Never throws. */
export function emitUsage(input: UsageEmission): void {
	const scope = currentUsageScope();
	const inputTokens = count(input.inputTokens);
	const outputTokens = count(input.outputTokens);
	usageChannel.emit({
		evt: USAGE_EVENT,
		ts: new Date().toISOString(),
		turnId: scope?.turnId ?? null,
		surface: input.surface ?? scope?.surface ?? null,
		kind: input.kind,
		provider: input.provider,
		model: input.model,
		finishReason: input.finishReason ?? null,
		inputTokens,
		outputTokens,
		// Summed only when both halves are known: a half-reported call is a null
		// rather than a number that quietly understates the turn.
		totalTokens:
			count(input.totalTokens) ??
			(inputTokens !== null && outputTokens !== null
				? inputTokens + outputTokens
				: null),
		reasoningTokens: count(input.reasoningTokens),
		cachedInputTokens: count(input.cachedInputTokens),
		ttftMs: millis(input.ttftMs),
		durationMs: millis(input.durationMs) ?? 0,
		audioSeconds: count(input.audioSeconds),
		audioBytes: count(input.audioBytes),
		characters: count(input.characters),
		embeddedValues: count(input.embeddedValues),
	});
}
