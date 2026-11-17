import { emitUsage } from "@platform/observability";
import { NOT_AVAILABLE_OUTPUT } from "../../contract/host";
import type {
	DocumentSource,
	TurnEvent,
	TurnUsage,
} from "../../contract/messages";
import type { ProductTools } from "../../contract/product";
import type { TurnShape } from "../../history/interface";
import { namedSources, uniqueSources } from "../../turn/named-sources";
import { runInTurnScope, type TurnScope } from "../../turn/scope";
import { hasStatus, streamResponse } from "../client";
import { PERSONALIZATION_INPUT } from "../definition";
import {
	type FunctionCall,
	failureEvent,
	type ReadOptions,
	readResponse,
} from "./events";
import type { FunctionCallOutputItem, InputItem } from "./input";

/**
 * The turn's tool loop, the host's rather than the service's, because half the
 * tools run in the person's browser. Each step is one response on the
 * agent version, with part three of the prompt as its structured input,
 * shaped by the store the thread's messages are in (`TurnShape`): on the
 * own store, `store: false` — the service keeps nothing — given the
 * thread's history and this turn's input, then everything the turn has
 * written so far; on the service's conversations, stored in the thread's
 * conversation and given only what is new. When it ends with calls:
 *
 *   - the backend's tools run here, in the turn's scope, and their outputs
 *     are the next step's input;
 *   - a call to a control this client runs ends the run with
 *     `finish("tool-calls")`, and the browser's results continue the turn
 *     as a turn of their own;
 *   - a control the product defines that this client did not register is
 *     answered here, `{"error":"not_available"}`, so no call is left open
 *     that nobody can answer; when the response also carried words and
 *     called nothing but controls, the reply is complete and the turn ends
 *     rather than asking the model again; when it carried no words, the
 *     next step is asked with `tool_choice: "none"`, so a model that keeps
 *     reaching for a control it was told is not there still answers;
 *   - when one response calls both kinds, the outputs already in hand are
 *     held (Q9) — among what the turn wrote, or appended to the
 *     conversation before the run ends — so the browser's results are all
 *     that is left open; `finish` waits for that write, because the browser
 *     continues the moment the run ends.
 *
 * A step limit ends a turn that keeps calling: what the last step's calls
 * answered is held all the same, so the history never holds a call
 * without its output. A turn that reaches it having said nothing is given
 * one step more, without tools: no turn ends with no words unless the
 * browser still has a call to answer.
 *
 * The loop never throws: however a run ends, it answers with what the turn
 * wrote — the reasoning, the calls, their outputs and the answers, in order
 * — and the responses it made, for the host to keep in, or delete from,
 * the thread's history.
 */

export interface LoopContext {
	scope: TurnScope;
	agent: { name: string; version: string };
	/** Part three of the prompt, for this turn. */
	personalization: string;
	/** What the first response is given: on the own store, the thread's history, then this turn's input. */
	input: InputItem[];
	/** How each response is asked for, given its input, and holds what a run ends with. */
	shape: TurnShape;
	serverTools: ProductTools;
	/** The product's controls this client registered and will run. */
	registered: ReadonlySet<string>;
	/** Every control the product defines. */
	controls: ReadonlySet<string>;
	maxSteps: number;
	signal?: AbortSignal;
	/** Whether the thread ended under the turn: asked before each further step, and a yes is the turn's end. */
	ended?: () => Promise<boolean>;
	/** The version went missing under the turn (a prune): the version to use instead. */
	reensure(): Promise<string>;
	emit(event: TurnEvent): void;
}

export type LoopResult =
	| {
			kind: "finished";
			reason: string;
			usage: TurnUsage;
			/** Everything the model said this turn, for the memory store. */
			text: string;
			/** What the turn wrote, in order, for the history. */
			written: InputItem[];
			/** Every response the turn made, in order. */
			responseIds: string[];
			/** Whether a control of the browser's is left to answer. */
			awaitingClient: boolean;
			/** The documents the backend's tools handed the model, each once, in the order they first did. */
			sources: DocumentSource[];
	  }
	| {
			kind: "failed";
			event: Extract<TurnEvent, { type: "error" }>;
			written: InputItem[];
			responseIds: string[];
	  };

/** A tool's result as the model reads it: a string as it is, anything else as JSON. */
export function outputText(value: unknown): string {
	return typeof value === "string" ? value : JSON.stringify(value ?? null);
}

function output(callId: string, value: unknown): FunctionCallOutputItem {
	return {
		type: "function_call_output",
		call_id: callId,
		output: outputText(value),
	};
}

/**
 * One of the backend's tools, its arguments validated before it runs, inside
 * the turn's scope: a failure is an answer the model reads. A typed turn's
 * loop and a live session's calls run their tools through this one door.
 */
export async function runProductTool(
	tools: ProductTools,
	scope: TurnScope,
	call: Pick<FunctionCall, "name" | "arguments">,
	signal?: AbortSignal,
): Promise<{ result: unknown; isError: boolean }> {
	const tool = tools[call.name];
	if (!tool) return { result: { error: "not_available" }, isError: true };
	let args: unknown;
	try {
		args = JSON.parse(call.arguments || "{}");
	} catch {
		return { result: { error: "invalid_arguments" }, isError: true };
	}
	const parsed = tool.parameters.safeParse(args);
	if (!parsed.success)
		return {
			result: { error: "invalid_arguments", issues: parsed.error.issues },
			isError: true,
		};
	try {
		return {
			result: await runInTurnScope(scope, () =>
				tool.execute(parsed.data, { signal }),
			),
			isError: false,
		};
	} catch (err) {
		console.error(
			`[agent] the tool "${call.name}" failed:`,
			(err as Error).message,
		);
		return { result: { error: "tool_failed" }, isError: true };
	}
}

async function* stepEvents(
	ctx: LoopContext,
	input: InputItem[],
	wordsOnly: boolean,
) {
	const body = (version: string) => ({
		agent_reference: { type: "agent_reference", name: ctx.agent.name, version },
		input,
		...ctx.shape.fields,
		...(wordsOnly ? { tool_choice: "none" } : {}),
		truncation: "auto",
		structured_inputs: { [PERSONALIZATION_INPUT]: ctx.personalization },
	});
	try {
		yield* streamResponse(body(ctx.agent.version), ctx.signal);
	} catch (err) {
		// A version pruned under a replica that still pinned it: made again once.
		if (!hasStatus(err, 404)) throw err;
		ctx.agent.version = await ctx.reensure();
		yield* streamResponse(body(ctx.agent.version), ctx.signal);
	}
}

/** What a tool's answer named, or nothing when it failed or the tool names no document: a typed turn's call or a live session's. */
export function sourcesOf(
	tools: ProductTools,
	name: string,
	answer: { result: unknown; isError: boolean },
): DocumentSource[] {
	const tool = tools[name];
	if (answer.isError || !tool?.sources) return [];
	try {
		return tool.sources(answer.result);
	} catch {
		return [];
	}
}

/** What a turn is told when its thread was deleted under it. */
function threadEnded(): Extract<TurnEvent, { type: "error" }> {
	return { type: "error", code: "turn.failed" };
}

export async function runLoop(ctx: LoopContext): Promise<LoopResult> {
	const usage = { inputTokens: 0, outputTokens: 0 };
	const written: InputItem[] = [];
	const responseIds: string[] = [];
	const said: string[] = [];
	const sources: DocumentSource[] = [];
	let firstContentAt: number | null = null;
	const read: ReadOptions = {
		emit(event) {
			if (
				firstContentAt === null &&
				(event.type === "text" || event.type === "reasoning")
			)
				firstContentAt = performance.now();
			ctx.emit(event);
		},
		runsOn: (name) => (ctx.registered.has(name) ? "client" : "server"),
		signal: ctx.signal,
	};
	let input = ctx.input;
	// Set after a step that wrote nothing and called a control this client
	// cannot run, or that hit the step limit wordless: the next step may not
	// call anything, so the turn ends in words rather than in silence.
	let wordsOnly = false;
	for (let step = 0; ; step++) {
		if (step > 0 && (await ctx.ended?.()))
			return { kind: "failed", event: threadEnded(), written, responseIds };
		const startedAt = performance.now();
		firstContentAt = null;
		// Never throws: a stream that breaks is a response that failed.
		const response = await readResponse(
			stepEvents(ctx, input, wordsOnly),
			read,
		);
		if (response.responseId) responseIds.push(response.responseId);
		written.push(...response.items);
		if (response.usage)
			emitUsage({
				kind: "chat",
				provider: "foundry-agent-service",
				model: `${ctx.agent.name}:${ctx.agent.version}`,
				inputTokens: response.usage.inputTokens,
				outputTokens: response.usage.outputTokens,
				finishReason:
					response.end.kind === "completed" ? response.end.reason : "error",
				ttftMs: firstContentAt === null ? null : firstContentAt - startedAt,
				durationMs: performance.now() - startedAt,
			});
		usage.inputTokens += response.usage?.inputTokens ?? 0;
		usage.outputTokens += response.usage?.outputTokens ?? 0;
		if (response.text) said.push(response.text);
		if (response.end.kind === "failed")
			return {
				kind: "failed",
				event: response.end.event,
				written,
				responseIds,
			};

		const outputs: FunctionCallOutputItem[] = [];
		let awaitingClient = false;
		let refusedControl = false;
		for (const call of response.calls) {
			if (ctx.registered.has(call.name)) {
				awaitingClient = true;
				continue;
			}
			if (ctx.controls.has(call.name)) refusedControl = true;
			// Asked before each call: a thread that ended runs no further tool as the person.
			if (await ctx.ended?.())
				return { kind: "failed", event: threadEnded(), written, responseIds };
			const answer = ctx.controls.has(call.name)
				? { result: JSON.parse(NOT_AVAILABLE_OUTPUT), isError: true }
				: await runProductTool(ctx.serverTools, ctx.scope, call, ctx.signal);
			ctx.emit({
				type: "tool-result",
				id: call.callId,
				name: call.name,
				result: answer.result,
				isError: answer.isError,
				runsOn: "server",
			});
			sources.push(...sourcesOf(ctx.serverTools, call.name, answer));
			outputs.push(output(call.callId, answer.result));
		}
		written.push(...outputs);

		const finished = (reason: string): LoopResult => ({
			kind: "finished",
			reason,
			usage,
			text: said.join("\n\n"),
			written,
			responseIds,
			awaitingClient,
			sources: uniqueSources(sources),
		});
		if (outputs.length === 0)
			return finished(awaitingClient ? "tool-calls" : response.end.reason);
		// Nothing said yet and nobody else to answer: one more step, without
		// tools, rather than a turn that ends with no words.
		const wordless = !awaitingClient && said.length === 0 && !wordsOnly;
		if (wordless && (refusedControl || step + 1 >= ctx.maxSteps)) {
			wordsOnly = true;
			input = ctx.shape.next(ctx.input, written, outputs);
			continue;
		}
		// A response that wrote its words and then only drove the stage is
		// complete: a control's answer is a status line, not something the
		// model reads to finish. Asked again, it can restate the whole reply,
		// which would then stream twice and be kept twice.
		const onlyControls = response.calls.every((call) =>
			ctx.controls.has(call.name),
		);
		const ending =
			onlyControls && response.text
				? "stop"
				: awaitingClient || step + 1 >= ctx.maxSteps
					? "max-steps"
					: null;
		if (ending) {
			try {
				await ctx.shape.hold(outputs);
			} catch (err) {
				return {
					kind: "failed",
					event: failureEvent(err, "append"),
					written,
					responseIds,
				};
			}
			return finished(awaitingClient ? "tool-calls" : ending);
		}
		input = ctx.shape.next(ctx.input, written, outputs);
	}
}

/**
 * The events a turn's stream ends with: the documents the reply drew on —
 * of everything retrieved, the ones its words name, or all when it names
 * none — once, then `finish`. The one place the chips are decided, for
 * both retrieval engines.
 */
export function finishEvents(
	result: Extract<LoopResult, { kind: "finished" }>,
	retrieved: readonly DocumentSource[],
): TurnEvent[] {
	const sources = namedSources(result.text, retrieved);
	return [
		...(sources.length ? [{ type: "sources", sources } as TurnEvent] : []),
		{ type: "finish", reason: result.reason, usage: result.usage },
	];
}
