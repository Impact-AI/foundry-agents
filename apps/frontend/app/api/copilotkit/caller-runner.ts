import { type AbstractAgent, type BaseEvent, EventType } from "@ag-ui/client";
import {
	AgentRunner,
	type AgentRunnerConnectRequest,
	type AgentRunnerIsRunningRequest,
	type AgentRunnerRunRequest,
	type AgentRunnerStopRequest,
	finalizeRunEvents,
	ThreadAlreadyRunningError,
} from "@copilotkit/runtime/v2";
import { EMPTY, Observable, Subject } from "rxjs";

/**
 * The runtime's runner, as this app needs one: it keeps nothing about a
 * conversation, and what it holds while a run is in flight is the caller's
 * own.
 *
 * The runtime's default runner keeps every finished run of every thread in a
 * map of the process, by thread id alone, and answers `agent/connect` and
 * `agent/stop` from it for whoever names the thread: a second account would
 * be handed the first one's conversation, could end its turn, and the copy
 * would outlive a delete and an erase until the replica restarted. The
 * conversation is the backend's, which decides whose a thread is; this
 * process is a relay.
 *
 * So a run is held here only while it streams, under the account that
 * started it and the thread it is on, and is let go when it ends. A
 * `connect` attaches to the caller's own run in flight, which is what a page
 * reloaded mid-answer asks for, and otherwise answers nothing: the page
 * reads a conversation's history from the backend. A `stop` ends only a run
 * the same account started, on the replica that is streaming it.
 *
 * The runtime can name an owner on each call (`ownerId`) for a runner that
 * keeps threads apart by it. This one is made for one account, the one the
 * session's assertion names, and reads no other.
 */

/** The streamed parts of one message or call, merged where they follow one another. */
const DELTAS = new Set<string>([
	EventType.TEXT_MESSAGE_CONTENT,
	EventType.REASONING_MESSAGE_CONTENT,
	EventType.TOOL_CALL_ARGS,
]);

/** The message or call a delta belongs to. */
function partOf(event: BaseEvent): unknown {
	const { messageId, toolCallId } = event as {
		messageId?: unknown;
		toolCallId?: unknown;
	};
	return messageId ?? toolCallId;
}

/**
 * A run's events, for the request that started it and for a page that
 * attaches mid-answer: each is sent on as it comes, and kept so whoever
 * attaches later is given the run so far first. What is kept is compacted:
 * the deltas of one message or one call that follow one another are kept
 * as one, its text joined, so the run so far is one event a message part
 * and a call rather than one a token. A late attacher reads the same text
 * in fewer events, and nothing is held once the run ends.
 */
class RunEvents {
	private readonly kept: BaseEvent[] = [];
	private readonly live = new Subject<BaseEvent>();
	private done = false;

	next(event: BaseEvent): void {
		const last = this.kept.at(-1);
		if (
			last &&
			DELTAS.has(event.type) &&
			last.type === event.type &&
			partOf(last) === partOf(event)
		) {
			const { delta } = last as BaseEvent & { delta: string };
			this.kept[this.kept.length - 1] = {
				...last,
				delta: delta + (event as BaseEvent & { delta: string }).delta,
			} as BaseEvent;
		} else this.kept.push(event);
		this.live.next(event);
	}

	complete(): void {
		this.done = true;
		this.live.complete();
	}

	/** The run so far, then the rest as it comes. */
	observable(): Observable<BaseEvent> {
		return new Observable<BaseEvent>((subscriber) => {
			for (const event of this.kept) {
				if (subscriber.closed) return;
				subscriber.next(event);
			}
			if (this.done) return subscriber.complete();
			return this.live.subscribe(subscriber);
		});
	}
}

interface Flight {
	runId: string;
	agent: AbstractAgent;
	stopRequested: boolean;
	events: RunEvents;
}

/** The runs streaming through this process, by account and thread. Empty at rest. */
const inFlight = new Map<string, Flight>();

/** An account id and a thread id cannot run into each other: neither holds a line feed. */
const keyOf = (accountId: string, threadId: string) =>
	`${accountId}\n${threadId}`;

/** How many runs this process holds: zero whenever nothing is streaming. */
export const heldRuns = (): number => inFlight.size;

/**
 * What ending a run cleanly needs of an event: its type and the ids that
 * say which message or call it opens or closes. Never its words.
 */
function outline(event: BaseEvent): BaseEvent | null {
	switch (event.type) {
		case EventType.TEXT_MESSAGE_START:
		case EventType.TEXT_MESSAGE_END:
		case EventType.TOOL_CALL_START:
		case EventType.TOOL_CALL_END:
		case EventType.TOOL_CALL_RESULT:
		case EventType.RUN_FINISHED:
		case EventType.RUN_ERROR: {
			const { messageId, toolCallId } = event as {
				messageId?: unknown;
				toolCallId?: unknown;
			};
			return { type: event.type, messageId, toolCallId } as BaseEvent;
		}
		default:
			return null;
	}
}

export class CallerRunner extends AgentRunner {
	constructor(private readonly accountId: string) {
		super();
	}

	run(request: AgentRunnerRunRequest): Observable<BaseEvent> {
		const key = keyOf(this.accountId, request.threadId);
		if (inFlight.has(key)) throw new ThreadAlreadyRunningError();
		const flight: Flight = {
			runId: request.input.runId,
			agent: request.agent,
			stopRequested: false,
			events: new RunEvents(),
		};
		inFlight.set(key, flight);
		const outlines: BaseEvent[] = [];
		// A run that ended without saying so is closed as the runtime closes one,
		// and then nothing of it is held.
		const settle = (interruptionMessage?: string) => {
			const closing = finalizeRunEvents(outlines, {
				stopRequested: flight.stopRequested,
				...(interruptionMessage ? { interruptionMessage } : {}),
			});
			for (const event of closing) flight.events.next(event);
			if (inFlight.get(key) === flight) inFlight.delete(key);
			flight.events.complete();
		};
		request.agent
			.runAgent(request.input, {
				onEvent: ({ event }) => {
					const kept = outline(event);
					if (kept) outlines.push(kept);
					flight.events.next(event);
				},
			})
			.then(
				() => settle(),
				(error: unknown) =>
					settle(error instanceof Error ? error.message : String(error)),
			);
		return flight.events.observable();
	}

	connect(request: AgentRunnerConnectRequest): Observable<BaseEvent> {
		const flight = inFlight.get(keyOf(this.accountId, request.threadId));
		return flight ? flight.events.observable() : EMPTY;
	}

	isRunning(request: AgentRunnerIsRunningRequest): Promise<boolean> {
		return Promise.resolve(
			inFlight.has(keyOf(this.accountId, request.threadId)),
		);
	}

	// Called by the runtime through `AgentRunner`, a reach fallow 3.35 does not follow.
	// fallow-ignore-next-line unused-class-member
	stop(request: AgentRunnerStopRequest): Promise<boolean> {
		const flight = inFlight.get(keyOf(this.accountId, request.threadId));
		if (!flight || flight.stopRequested) return Promise.resolve(false);
		if (request.runId !== undefined && flight.runId !== request.runId)
			return Promise.resolve(false);
		flight.stopRequested = true;
		try {
			flight.agent.abortRun();
			return Promise.resolve(true);
		} catch (error) {
			console.error("[chat] a run could not be stopped:", error);
			flight.stopRequested = false;
			return Promise.resolve(false);
		}
	}
}
