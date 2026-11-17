import { envInt } from "@platform/config/env";
import { heartbeatStream } from "./heartbeat";

/**
 * A response ready to cross a proxy it knows nothing about.
 *
 * Two things go wrong on the way to the browser, and neither produces a
 * diagnosable symptom: a proxy that buffers turns a token-by-token answer into
 * one late blob, and a proxy with an idle timeout severs a stream whose first
 * byte is further away than its timeout. The header answers the first where it
 * is honoured and is inert elsewhere; the heartbeat answers the second whether
 * or not anything on the path honours anything.
 */

/**
 * The de-facto "pass this through as it arrives" header, named by nginx and
 * copied by other appliances. Addressed to intermediaries, not to the browser,
 * so its absence in devtools means nothing: read it at the origin or not at all.
 */
export const PROXY_BUFFERING_HEADER = "X-Accel-Buffering";

export const DEFAULT_SSE_HEARTBEAT_MS = 15_000;

/**
 * How often a stream must say something. It has to sit below the smallest
 * idle timeout anywhere on the path, which is a property of the deployment,
 * not of this code. `0` switches the heartbeat off; the header is unaffected.
 */
export function heartbeatIntervalMs(): number {
	return envInt("SSE_HEARTBEAT_MS", DEFAULT_SSE_HEARTBEAT_MS, { min: 0 });
}

function isEventStream(headers: Headers): boolean {
	return (headers.get("content-type") ?? "")
		.toLowerCase()
		.includes("text/event-stream");
}

/**
 * The headers the rebuilt response carries. A response `fetch` answered has
 * had its body decoded already, so the encoding and the length its headers
 * still name describe bytes that are no longer there: relayed as they are,
 * the browser would decode a body that is not encoded. A response has a URL
 * only while it is the one `fetch` answered: a caller that rebuilds a
 * fetched response before handing it here has lost the URL with it, and
 * drops the two headers itself.
 */
function relayHeaders(res: Response): Headers {
	const headers = new Headers(res.headers);
	if (res.url !== "" && headers.has("content-encoding")) {
		headers.delete("content-encoding");
		headers.delete("content-length");
	}
	headers.set(PROXY_BUFFERING_HEADER, "no");
	return headers;
}

/**
 * Rebuilt rather than mutated: a response from `fetch` has immutable headers,
 * and a new response over the same body is the one way to add one.
 */
function rebuilt(
	res: Response,
	body: ConstructorParameters<typeof Response>[0],
	headers: Headers,
): Response {
	return new Response(body, {
		status: res.status,
		statusText: res.statusText,
		headers,
	});
}

/** The same response, telling every intermediary not to buffer it. */
export function withoutProxyBuffering(res: Response): Response {
	return rebuilt(res, res.body, relayHeaders(res));
}

/**
 * No buffering, and — only for `text/event-stream`, since a comment frame is
 * inert under the SSE grammar alone — never silent for longer than
 * `intervalMs`. Any other body gets the header and nothing else, and so does
 * an event stream whose bytes are still encoded: a frame spliced into
 * compressed bytes would corrupt them.
 */
export function keepStreamAlive(
	res: Response,
	intervalMs: number = heartbeatIntervalMs(),
): Response {
	const headers = relayHeaders(res);
	const beats =
		isEventStream(headers) &&
		res.body !== null &&
		!headers.has("content-encoding");
	const body =
		beats && res.body ? heartbeatStream(res.body, intervalMs) : res.body;
	// The frames are bytes the declared length never counted.
	if (beats && intervalMs > 0) headers.delete("content-length");
	return rebuilt(res, body, headers);
}
