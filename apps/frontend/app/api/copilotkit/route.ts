import {
	CopilotRuntime,
	createCopilotRuntimeHandler,
} from "@copilotkit/runtime/v2";
import { overElementLimit } from "@platform/http/request-limit";
import { keepStreamAlive } from "@platform/http/streaming";
import { remoteAgent } from "@/src/backend/agent";
import type { Caller } from "@/src/backend/client";
import { backendFacts } from "@/src/backend/facts";
import { bodyTooLarge, readBounded } from "@/src/bounded-body";
import { withCaller } from "@/src/route";
import { CallerRunner } from "./caller-runner";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * What the chat client asks of the runtime: what it serves, a run, a run in
 * flight to attach to, and a stop. The runtime's single route answers more
 * (suggestions, transcription), none of which this app has.
 */
const CALLS: ReadonlySet<string> = new Set([
	"info",
	"agent/run",
	"agent/connect",
	"agent/stop",
]);

/** The body as JSON, or undefined for one that is not JSON. */
function parsed(body: ArrayBuffer): unknown {
	try {
		return JSON.parse(new TextDecoder().decode(body));
	} catch {
		return undefined;
	}
}

/** Whether the body is one of those calls; a body that is not the runtime's envelope is not. */
function knownCall(call: unknown): boolean {
	const method =
		call && typeof call === "object" ? Reflect.get(call, "method") : null;
	return typeof method === "string" && CALLS.has(method);
}

/**
 * The CopilotKit runtime, one agent per request: the backend's, scoped to
 * the caller's account and carrying the assertion. The browser talks
 * to this route alone. The runtime is made per POST with a runner that is the
 * caller's (`caller-runner.ts`): the runtime's own would keep every run of
 * every thread in this process and answer for it to whoever named the thread,
 * so nothing about a conversation is held here once its run has ended, and a
 * run in flight answers only the account that started it.
 * The body bound is the backend's `edge` document, read through the
 * facts memo, so this route refuses at the same size the edge does — counted
 * as it arrives, since a chunked body declares no length. The runtime parses
 * the whole body anyway, so it is read here, under the bound, held to a
 * count of array elements and object keys as well (`overElementLimit`), and handed on.
 * The runtime would keep a quiet stream open with comment frames of its own:
 * that is switched off, so the one cadence on the answer is this app's
 * (`keepStreamAlive`, `SSE_HEARTBEAT_MS`).
 */
export const run = async (caller: Caller, req: Request): Promise<Response> => {
	const limit = (await backendFacts(caller)).limits.maxRequestBodyBytes;
	const body = await readBounded(req, limit);
	if (!body) return bodyTooLarge();
	const call = parsed(body);
	if (!knownCall(call))
		return Response.json({ code: "not_found" }, { status: 404 });
	// The runtime validates the whole envelope, walking every key and keeping
	// an issue for every element it refuses: a body under the byte bound can
	// still be half a million of them, so it is counted before the runtime
	// reads it.
	if (overElementLimit(call)) return bodyTooLarge();
	const agents = await remoteAgent(caller, req);
	// No CORS is configured: every caller is this origin's own page, and a write
	// from anywhere else is refused before it reaches this handler, so no
	// answer names an origin.
	const handle = createCopilotRuntimeHandler({
		runtime: new CopilotRuntime({
			agents,
			runner: new CallerRunner(caller.claims.sub),
			sseKeepAliveIntervalSeconds: 0,
		}),
		basePath: "/api/copilotkit",
		mode: "single-route",
	});
	return keepStreamAlive(await handle(new Request(req, { body })));
};

export const POST = withCaller(run, { maxBodyBytes: "own" });
