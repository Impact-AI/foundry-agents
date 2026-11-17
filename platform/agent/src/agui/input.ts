import type { Message } from "@ag-ui/core";
import { RunAgentInputSchema } from "@ag-ui/core/schemas";
import { overElementLimit } from "@platform/http/request-limit";
import {
	LIVE_CONTEXT_LINE_MAX,
	LIVE_CONTEXT_MAX_LINES,
	UI_SURFACE_READABLE,
} from "@platform/prompt";
import type {
	LiveContextLine,
	TurnMessage,
	TurnPart,
} from "../contract/messages";
import { cutTo } from "../cut";

/**
 * What an AG-UI run may say, read into a turn, and nothing else. The host
 * holds the conversation, so of the history a client resends only its tail
 * is read — the person's new message, or the answers to the controls it ran
 * — and everything before it is ignored: no message a client writes reaches
 * the model except that tail, so a system message in the history is inert.
 * The controls it registered are read by name and reach the model in the
 * product's words, never the client's; what is on its screen is quoted,
 * bounded. A field the protocol does not define, shared state, forwarded
 * props and an interrupt's resumption are refused rather than dropped: the
 * frontend's client sends none of them, so one is a probe.
 */
export interface RunInput {
	threadId: string;
	/** The client's id for the run, echoed on the events; the host mints its own. */
	runId: string;
	messages: TurnMessage[];
	/** The controls the client registered, by name. */
	clientTools: string[];
	liveContext: LiveContextLine[];
}

const ID_MAX = 200;
const STRICT = RunAgentInputSchema.strict();

/** A brace is the one character a key part refuses: an id is a part of the keys a turn is claimed under. */
function isId(value: string): boolean {
	return value.length > 0 && value.length <= ID_MAX && !/[{}]/.test(value);
}

/** Absent, null or `{}`: anything else is shared state this agent does not keep. */
function isEmpty(value: unknown): boolean {
	return (
		value === undefined ||
		value === null ||
		(typeof value === "object" &&
			!Array.isArray(value) &&
			Object.keys(value).length === 0)
	);
}

/** A part of the person's message, or null for one a turn does not carry: a picture is inline data or nothing. */
function partOf(
	part: Extract<Message, { role: "user" }>["content"][number],
): TurnPart | null {
	if (typeof part === "string") return null;
	if (part.type === "text") return { type: "text", text: part.text };
	if (
		part.type === "image" &&
		part.source.type === "data" &&
		part.source.mimeType.startsWith("image/")
	)
		return {
			type: "image",
			data: `data:${part.source.mimeType};base64,${part.source.value}`,
			mediaType: part.source.mimeType,
		};
	return null;
}

/** The tail of the history: its last message when the person wrote it, or the answers that end it. */
function tailOf(messages: readonly Message[]): TurnMessage[] | null {
	const last = messages.at(-1);
	if (last?.role === "user") {
		if (!isId(last.id)) return null;
		if (typeof last.content === "string")
			return [{ id: last.id, role: "user", content: last.content }];
		const parts = last.content.map(partOf);
		if (parts.some((part) => part === null)) return null;
		return [{ id: last.id, role: "user", content: parts as TurnPart[] }];
	}
	const answers: TurnMessage[] = [];
	for (let i = messages.length - 1; i >= 0; i -= 1) {
		const message = messages[i];
		if (message?.role !== "tool") break;
		if (!isId(message.id) || !isId(message.toolCallId)) return null;
		// The protocol lets a tool answer in parts; a control answers in words.
		if (typeof message.content !== "string") return null;
		answers.unshift({
			id: message.id,
			role: "tool",
			toolCallId: message.toolCallId,
			content: message.content,
		});
	}
	return answers.length ? answers : null;
}

/** Null for a body that is not a run this route takes. */
export function readRunInput(body: unknown): RunInput | null {
	// The schema walks every key and keeps an issue for every array element it refuses, so a body is counted, both, before it is read.
	if (overElementLimit(body)) return null;
	const parsed = STRICT.safeParse(body);
	if (!parsed.success) return null;
	const input = parsed.data;
	if (
		!isId(input.threadId) ||
		!isEmpty(input.state) ||
		!isEmpty(input.forwardedProps) ||
		(input.resume?.length ?? 0) > 0
	)
		return null;
	const messages = tailOf(input.messages);
	if (!messages) return null;
	return {
		threadId: input.threadId,
		runId: input.runId,
		messages,
		clientTools: input.tools.map((tool) => tool.name),
		liveContext: input.context
			.filter((line) => line.description !== UI_SURFACE_READABLE)
			.slice(0, LIVE_CONTEXT_MAX_LINES)
			.map((line) => ({
				label: cutTo(line.description, LIVE_CONTEXT_LINE_MAX),
				value: cutTo(line.value, LIVE_CONTEXT_LINE_MAX),
			})),
	};
}
