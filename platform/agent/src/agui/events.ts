import { type BaseEvent, EventType } from "@ag-ui/core";
import type { TurnEvent } from "../contract/messages";

/**
 * A turn's events as AG-UI's, under the client's thread and run ids. Text
 * and reasoning arrive as deltas, so each run of them is one message opened
 * on its first delta and closed by whatever comes next; a new reasoning id
 * is a new reasoning message. A message's tool calls hang off it, and text
 * after a call is a message of its own, so it reads below the call it
 * follows. A call is sent whole, its arguments in one delta. A call to a
 * control the browser runs is held until the server's results of its step
 * are sent, and then hangs off a message after them: the browser's answers
 * end the history it sends back, so they are the next run's whole tail.
 * The documents the answer drew on are a `sources` custom event. The run
 * ends `RUN_FINISHED` on `finish` and `RUN_ERROR` with the contract's code —
 * never a cause — on `error`, or on a stream that stops before either.
 */
export function aguiEvents(
	turn: ReadableStream<TurnEvent>,
	run: { threadId: string; runId: string },
): ReadableStream<BaseEvent> {
	const reader = turn.getReader();
	const state = newState();
	let started = false;
	return new ReadableStream<BaseEvent>({
		async pull(controller) {
			if (!started) {
				started = true;
				controller.enqueue({ type: EventType.RUN_STARTED, ...run });
				return;
			}
			// A pull that enqueues nothing is not asked again, so a held call reads on.
			for (;;) {
				let next: Awaited<ReturnType<typeof reader.read>>;
				try {
					next = await reader.read();
				} catch {
					next = { done: true, value: undefined };
				}
				if (next.done) {
					for (const event of [...held(state), ...close(state)])
						controller.enqueue(event);
					controller.enqueue(runError("turn.failed"));
					controller.close();
					return;
				}
				const events = translate(state, next.value, run);
				for (const event of events) controller.enqueue(event);
				if (next.value.type === "finish" || next.value.type === "error") {
					controller.close();
					void reader.cancel().catch(() => {});
					return;
				}
				if (events.length) return;
			}
		},
		cancel(reason) {
			return reader.cancel(reason);
		},
	});
}

interface State {
	/** The open text message's id. */
	text: string | null;
	/** The open reasoning message: its own id, and the turn's id for the part. */
	reasoning: { messageId: string; part: string } | null;
	/** The assistant message the next call hangs off: the latest text's, or one the first call opened. */
	message: string | null;
	/** The calls to the browser's controls not yet sent: they go after the step's server results. */
	controls: Extract<TurnEvent, { type: "tool-call" }>[];
}

function newState(): State {
	return { text: null, reasoning: null, message: null, controls: [] };
}

function callEvents(
	state: State,
	call: { id: string; name: string; args: unknown },
): BaseEvent[] {
	state.message ??= crypto.randomUUID();
	return [
		{
			type: EventType.TOOL_CALL_START,
			toolCallId: call.id,
			toolCallName: call.name,
			parentMessageId: state.message,
		} as BaseEvent,
		{
			type: EventType.TOOL_CALL_ARGS,
			toolCallId: call.id,
			delta: JSON.stringify(call.args ?? {}),
		} as BaseEvent,
		{ type: EventType.TOOL_CALL_END, toolCallId: call.id } as BaseEvent,
	];
}

/**
 * The held calls to the browser's controls, sent: on the message before
 * them, or, after a server result, on one of their own. Sent before
 * whatever comes next that is not the step's server calls and results.
 */
function held(state: State): BaseEvent[] {
	const calls = state.controls;
	state.controls = [];
	return calls.length
		? [...close(state), ...calls.flatMap((call) => callEvents(state, call))]
		: [];
}

function runError(code: string): BaseEvent {
	return { type: EventType.RUN_ERROR, message: code, code } as BaseEvent;
}

function close(state: State): BaseEvent[] {
	const out: BaseEvent[] = [];
	if (state.text) {
		out.push({ type: EventType.TEXT_MESSAGE_END, messageId: state.text });
		state.text = null;
	}
	if (state.reasoning) {
		const { messageId } = state.reasoning;
		out.push(
			{ type: EventType.REASONING_MESSAGE_END, messageId },
			{ type: EventType.REASONING_END, messageId },
		);
		state.reasoning = null;
	}
	return out;
}

function translate(
	state: State,
	event: TurnEvent,
	run: { threadId: string; runId: string },
): BaseEvent[] {
	const out =
		event.type === "tool-call" || event.type === "tool-result"
			? []
			: held(state);
	return [...out, ...step(state, event, run)];
}

function step(
	state: State,
	event: TurnEvent,
	run: { threadId: string; runId: string },
): BaseEvent[] {
	switch (event.type) {
		case "text": {
			const out = state.text ? [] : close(state);
			if (!state.text) {
				state.text = crypto.randomUUID();
				state.message = state.text;
				out.push({
					type: EventType.TEXT_MESSAGE_START,
					messageId: state.text,
					role: "assistant",
				} as BaseEvent);
			}
			out.push({
				type: EventType.TEXT_MESSAGE_CONTENT,
				messageId: state.text,
				delta: event.text,
			} as BaseEvent);
			return out;
		}
		case "reasoning": {
			const out = state.reasoning?.part === event.id ? [] : close(state);
			if (!state.reasoning) {
				const messageId = crypto.randomUUID();
				state.reasoning = { messageId, part: event.id };
				out.push(
					{ type: EventType.REASONING_START, messageId } as BaseEvent,
					{
						type: EventType.REASONING_MESSAGE_START,
						messageId,
						role: "reasoning",
					} as BaseEvent,
				);
			}
			out.push({
				type: EventType.REASONING_MESSAGE_CONTENT,
				messageId: state.reasoning.messageId,
				delta: event.text,
			} as BaseEvent);
			return out;
		}
		case "tool-call":
			// A control's call waits for the step's server results (`held`): sent
			// beside a server call, the client groups them in one message and sends
			// the server's result back among its own answers, which a turn that
			// left only the controls open must refuse (`turn.invalid`).
			if (event.runsOn === "client") {
				state.controls.push(event);
				return [];
			}
			return [...close(state), ...callEvents(state, event)];
		case "tool-result":
			// A call after a result hangs off a message of its own, for the same reason.
			state.message = null;
			return [
				...close(state),
				{
					type: EventType.TOOL_CALL_RESULT,
					messageId: crypto.randomUUID(),
					toolCallId: event.id,
					content: JSON.stringify(event.result ?? null),
					role: "tool",
					// Beside the protocol's fields: a client that draws a result can tell a failed one.
					...(event.isError ? { isError: true } : {}),
				} as BaseEvent,
			];
		case "sources":
			return [
				...close(state),
				{
					type: EventType.CUSTOM,
					name: "sources",
					value: event.sources,
				} as BaseEvent,
			];
		case "finish":
			return [...close(state), { type: EventType.RUN_FINISHED, ...run }];
		case "error":
			return [...close(state), runError(event.code)];
	}
}
