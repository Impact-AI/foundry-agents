import { afterAll, beforeAll, expect, spyOn, test } from "bun:test";
import { HttpAgent } from "@ag-ui/client";
import { leavingQuietly } from "./agent";

/**
 * A run whose browser leaves, as the agent's runner sees it: the request's
 * signal aborted with the server's own reason, before the answer began or
 * part way through it.
 */
let server: ReturnType<typeof Bun.serve>;

beforeAll(() => {
	server = Bun.serve({
		port: 0,
		idleTimeout: 0,
		fetch(req) {
			if (new URL(req.url).pathname === "/silent")
				return new Promise<Response>(() => {});
			// A run that starts and then says nothing more.
			return new Response(
				new ReadableStream({
					start(controller) {
						controller.enqueue(
							new TextEncoder().encode(
								`data: ${JSON.stringify({ type: "RUN_STARTED", threadId: "t", runId: "r" })}\n\n`,
							),
						);
					},
				}),
				{ headers: { "Content-Type": "text/event-stream" } },
			);
		},
	});
});

afterAll(() => {
	void server.stop(true);
});

/** What Next aborts a request's signal with when its response is abandoned. */
function responseAborted(): Error {
	const reason = new Error("gone");
	reason.name = "ResponseAborted";
	return reason;
}

/**
 * The run's outcome and the error lines written. Passed on as the server's
 * own reason, the abort is a failed run to the runner: it rejects, logs
 * "Agent execution failed", and throws again where nothing catches it.
 */
async function runThenLeave(path: string) {
	const gone = new AbortController();
	const agent = new HttpAgent({
		url: `http://localhost:${server.port}${path}`,
		fetch: (url, init) =>
			leavingQuietly(gone.signal, fetch(url, { ...init, signal: gone.signal })),
	});
	const logged = spyOn(console, "error").mockImplementation(() => {});
	try {
		const run = agent.runAgent().then(
			() => "ended",
			(err: Error) => `failed: ${err.name}`,
		);
		await Bun.sleep(50);
		gone.abort(responseAborted());
		return { outcome: await run, logged: logged.mock.calls.length };
	} finally {
		logged.mockRestore();
	}
}

test("a browser leaving before the answer began ends the run as an abort: nothing failed, nothing logged", async () => {
	expect(await runThenLeave("/silent")).toEqual({
		outcome: "ended",
		logged: 0,
	});
});

test("a browser leaving part way through the answer ends the run the same way", async () => {
	expect(await runThenLeave("/started")).toEqual({
		outcome: "ended",
		logged: 0,
	});
});

test("a failure that is not the browser leaving is passed on as it is", async () => {
	const here = new AbortController();
	const broken = new Error("refused");
	await expect(
		leavingQuietly(here.signal, Promise.reject(broken)),
	).rejects.toBe(broken);
});
