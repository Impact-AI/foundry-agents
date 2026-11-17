import type { TurnOutcome } from "../contract/host";
import type { TurnMessage } from "../contract/messages";
import type { ClientTool } from "../contract/product";
import { problems } from "../keys";

/**
 * What a turn may carry, decided before any store is asked, for every
 * implementation alike: the person's messages, or only the results of the
 * controls the client ran — never a mix — and controls the product defines,
 * offered in its words. Whether the results answer what the agent actually
 * left open is the implementation's to read from its thread, and
 * `answersOpenCalls` is the rule it reads it by.
 */

export type ToolResultMessage = Extract<TurnMessage, { role: "tool" }>;
export type SaidMessage = Exclude<TurnMessage, { role: "tool" }>;

export type TurnRequest =
	| { kind: "said"; messages: SaidMessage[] }
	| { kind: "answered"; results: ToolResultMessage[] };

/** Null for no messages, or for results mixed with anything else. */
export function readTurnMessages(
	messages: readonly TurnMessage[],
): TurnRequest | null {
	if (messages.length === 0) return null;
	const results = messages.filter(
		(m): m is ToolResultMessage => m.role === "tool",
	);
	if (results.length === 0)
		return { kind: "said", messages: messages as SaidMessage[] };
	return results.length === messages.length
		? { kind: "answered", results }
		: null;
}

/** The product's controls this client registered, in the product's words. Null when it named one the product does not define. */
export function offeredClientTools(
	defined: readonly ClientTool[],
	names: readonly string[] = [],
): ClientTool[] | null {
	const offered: ClientTool[] = [];
	for (const name of new Set(names)) {
		const tool = defined.find((t) => t.name === name);
		if (!tool) return null;
		offered.push(tool);
	}
	return offered;
}

/** A call the agent made to a control the client runs, not yet answered. */
export interface OpenCall {
	id: string;
	name: string;
}

export function invalidTurn(): TurnOutcome {
	problems.report("agent.turn.invalid", { status: 400 });
	return { kind: "refused", refusal: { code: "turn.invalid", status: 400 } };
}

/** Whether the results answer exactly the calls left open: each one once, and nothing else. */
export function answersOpenCalls(
	open: readonly OpenCall[],
	results: readonly ToolResultMessage[],
): boolean {
	const answered = new Set(results.map((r) => r.toolCallId));
	return (
		answered.size === results.length &&
		answered.size === open.length &&
		open.every((call) => answered.has(call.id))
	);
}
