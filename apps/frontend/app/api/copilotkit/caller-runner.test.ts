import { expect, test } from "bun:test";
import { type AbstractAgent, type BaseEvent, EventType } from "@ag-ui/client";
import type { AgentRunnerRunRequest } from "@copilotkit/runtime/v2";
import { CallerRunner } from "./caller-runner";

/** An agent whose events the test sends, and whose run ends when the test says. */
function agent() {
	let emit: (event: BaseEvent) => void = () => {};
	const ended = Promise.withResolvers<void>();
	const stand = {
		runAgent(
			_input: unknown,
			{ onEvent }: { onEvent: (e: { event: BaseEvent }) => void },
		) {
			emit = (event) => onEvent({ event });
			return ended.promise;
		},
		abortRun() {},
	} as unknown as AbstractAgent;
	return {
		stand,
		emit: (event: BaseEvent) => emit(event),
		end: () => ended.resolve(),
	};
}

const text = (messageId: string, delta: string) =>
	({ type: EventType.TEXT_MESSAGE_CONTENT, messageId, delta }) as BaseEvent;
const args = (toolCallId: string, delta: string) =>
	({ type: EventType.TOOL_CALL_ARGS, toolCallId, delta }) as BaseEvent;

test("a page attaching mid-answer is given the run so far with each part's deltas joined, then the rest as it comes", async () => {
	const runner = new CallerRunner("account-1");
	const { stand, emit, end } = agent();
	const started: BaseEvent[] = [];
	let completed = 0;
	runner
		.run({
			threadId: "thread-1",
			agent: stand,
			input: { runId: "run-1" },
		} as unknown as AgentRunnerRunRequest)
		.subscribe({
			next: (event) => started.push(event),
			complete: () => completed++,
		});

	emit({ type: EventType.TEXT_MESSAGE_START, messageId: "m1" } as BaseEvent);
	for (let i = 0; i < 1_000; i++) emit(text("m1", `w${i} `));
	emit({ type: EventType.TOOL_CALL_START, toolCallId: "c1" } as BaseEvent);
	for (const part of ['{"a"', ":1}"]) emit(args("c1", part));
	emit(text("m1", "after"));

	const attached: BaseEvent[] = [];
	runner
		.connect({ threadId: "thread-1" } as Parameters<CallerRunner["connect"]>[0])
		.subscribe({
			next: (event) => attached.push(event),
			complete: () => completed++,
		});
	// The run so far, compacted: one event a part, its text whole.
	expect(attached).toEqual([
		{ type: EventType.TEXT_MESSAGE_START, messageId: "m1" } as BaseEvent,
		text("m1", Array.from({ length: 1_000 }, (_, i) => `w${i} `).join("")),
		{ type: EventType.TOOL_CALL_START, toolCallId: "c1" } as BaseEvent,
		args("c1", '{"a":1}'),
		text("m1", "after"),
	]);
	// The request that started it saw every delta as it came.
	expect(started).toHaveLength(1_005);

	emit(text("m1", " more"));
	expect(attached.at(-1)).toEqual(text("m1", " more"));
	end();
	await Bun.sleep(0);
	// The run's closing reaches both, and then nothing of it is held.
	expect(attached.at(-1)).toEqual(started.at(-1));
	expect(completed).toBe(2);
	expect(
		await runner.isRunning({ threadId: "thread-1" } as Parameters<
			CallerRunner["isRunning"]
		>[0]),
	).toBe(false);
});
