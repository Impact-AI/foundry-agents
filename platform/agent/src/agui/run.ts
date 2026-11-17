import { EventEncoder } from "@ag-ui/encoder";
import type { AgentHost, TurnInput, TurnRefusal } from "../contract/host";
import { problems } from "../keys";
import type { CallerIdentity } from "../turn/scope";
import { aguiEvents } from "./events";
import { readRunInput } from "./input";

/**
 * Who a run is for, as the backend verified it: the account the turn's
 * memory is, the interface and language it came from, and the person's
 * identity for a tool that decides who may read what. Nothing in the run's
 * body names any of it.
 */
export interface RunCaller {
	resourceId: string;
	surface: string;
	languageName: string;
	caller?: CallerIdentity | null;
	/** Handed to the turn as `TurnInput.stillAdmitted`. */
	stillAdmitted?: TurnInput["stillAdmitted"];
}

function refusal(
	status: number,
	code: string,
	headers?: Record<string, string>,
): Response {
	return Response.json({ code }, { status, headers });
}

function refused({ code, status, ...rest }: TurnRefusal): Response {
	// The caller's refusal is answered in the caller's own words.
	if ("reason" in rest) return refusal(status, rest.reason);
	return refusal(
		status,
		code,
		"retryAfterSeconds" in rest
			? { "Retry-After": String(rest.retryAfterSeconds) }
			: undefined,
	);
}

/**
 * One AG-UI run, served by the host: the client's `RunAgentInput` in, read
 * by `readRunInput`, and the turn out as AG-UI events over server-sent
 * events. A body that is not a run this route takes is a 400; a turn the
 * host refuses is its status with `{ code }`, and a `Retry-After` on a 429,
 * before any event is sent; a turn that could not be started at all is a
 * 500 with `turn.failed`, reported. The client going away aborts the turn.
 */
export async function serveAgentRun(
	host: AgentHost,
	request: Request,
	who: RunCaller,
): Promise<Response> {
	let body: unknown;
	try {
		body = await request.json();
	} catch {
		body = null;
	}
	const run = readRunInput(body);
	if (!run) {
		problems.report("agent.turn.invalid", { status: 400, reason: "body" });
		return refusal(400, "turn.invalid");
	}
	let outcome: Awaited<ReturnType<AgentHost["startTurn"]>>;
	try {
		outcome = await host.startTurn({
			resourceId: who.resourceId,
			threadId: run.threadId,
			messages: run.messages,
			clientTools: run.clientTools,
			surface: who.surface,
			languageName: who.languageName,
			liveContext: run.liveContext,
			caller: who.caller ?? null,
			abortSignal: request.signal,
			stillAdmitted: who.stillAdmitted,
		});
	} catch (err) {
		// A store or the service failed before the stream: the same code a failed stream ends on.
		problems.report("agent.turn.failed", { status: 500, reason: "start" });
		console.error(
			"[agent] a turn could not be started:",
			(err as Error).message,
		);
		return refusal(500, "turn.failed");
	}
	if (outcome.kind === "refused") return refused(outcome.refusal);
	const encoder = new EventEncoder();
	const bytes = new TextEncoder();
	const events = aguiEvents(outcome.events, {
		threadId: run.threadId,
		runId: run.runId,
	}).pipeThrough(
		new TransformStream({
			transform(event, controller) {
				controller.enqueue(bytes.encode(encoder.encodeSSE(event)));
			},
		}),
	);
	return new Response(events, {
		headers: {
			"Content-Type": "text/event-stream",
			"Cache-Control": "no-store",
		},
	});
}
