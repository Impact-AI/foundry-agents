import { HttpAgent, type RunAgentInput } from "@ag-ui/client";
import { backendUrl, type Caller, callerHeaders } from "./client";
import { backendFacts } from "./facts";

/**
 * The CopilotKit runtime's one agent: the backend's AG-UI run route, behind
 * the assertion. The frontend never runs a model; it forwards the run with
 * the caller's credentials and streams the answer back. The backend reads
 * whose turn it is from the assertion alone, so the run names no account,
 * and it takes the language from `Accept-Language`, which `callerHeaders`
 * sets to the one this request resolved to.
 *
 * The headers are set where the request is sent, not on the agent: the
 * runtime copies the browser's `authorization` and `x-` headers onto an
 * agent's own wherever it set none of that name, and the backend is to see
 * none of them.
 *
 * The agent's id is the product's, answered by the backend rather than
 * configured here twice.
 */
export async function agentId(caller: Caller): Promise<string> {
	return (await backendFacts(caller)).agentId;
}

/**
 * A run whose browser left ends as an abort the agent's runner knows by
 * name. The request's signal is aborted with the server's own reason, which
 * the runner would take for a failure of the run: logged as one, and thrown
 * where nothing is left to catch it.
 */
export async function leavingQuietly(
	gone: AbortSignal,
	call: Promise<Response>,
): Promise<Response> {
	const left = () =>
		new DOMException("The browser left before the run ended", "AbortError");
	let res: Response;
	try {
		res = await call;
	} catch (err) {
		throw gone.aborted ? left() : err;
	}
	if (!res.body) return res;
	// The stream breaks the same way once the answer has begun.
	const reader = res.body.getReader();
	const body = new ReadableStream<Uint8Array>({
		async pull(controller) {
			try {
				const { done, value } = await reader.read();
				if (done) controller.close();
				else controller.enqueue(value);
			} catch (err) {
				controller.error(gone.aborted ? left() : err);
			}
		},
		cancel: (reason) => reader.cancel(reason),
	});
	return new Response(body, {
		status: res.status,
		statusText: res.statusText,
		headers: res.headers,
	});
}

/** The id the chat client gives each request of its own, among a run's forwarded props. */
const CLIENT_REQUEST_ID = "__copilotkitRequestId";

/**
 * The agent, sending the backend a run and nothing of the chat client's own
 * bookkeeping. The client marks every run with an id for its request, as a
 * forwarded prop; the backend takes no forwarded props and refuses a run
 * that carries one, so that one mark is left here. Anything else a browser
 * put beside it still crosses, for the backend to refuse.
 */
class BackendAgent extends HttpAgent {
	protected override requestInit(input: RunAgentInput): RequestInit {
		const { [CLIENT_REQUEST_ID]: _mark, ...forwardedProps } =
			(input.forwardedProps ?? {}) as Record<string, unknown>;
		return super.requestInit({ ...input, forwardedProps });
	}
}

export async function remoteAgent(
	caller: Caller,
	request: Request,
): Promise<Record<string, HttpAgent>> {
	const id = await agentId(caller);
	const headers = await callerHeaders(caller, {
		"Content-Type": "application/json",
		Accept: "text/event-stream",
	});
	return {
		[id]: new BackendAgent({
			agentId: id,
			url: `${backendUrl()}/agent/run`,
			fetch: (url, init) =>
				leavingQuietly(
					request.signal,
					fetch(url, {
						...init,
						headers,
						// The browser going away ends the backend's turn too.
						signal: init?.signal
							? AbortSignal.any([init.signal, request.signal])
							: request.signal,
					}),
				),
		}),
	};
}
