import { createHash } from "node:crypto";
import http, { type IncomingMessage } from "node:http";
import https from "node:https";
import type { Duplex } from "node:stream";
import { isOwnOrigin } from "../src/same-origin";

/**
 * The live voice socket, relayed: the browser's WebSocket to this app's own
 * origin, carried byte for byte to the backend's `/voice/live` under the
 * caller's assertion.
 * Next's route handlers cannot take an upgrade, so this runs in the server
 * that hosts Next (`main.ts`), beside it.
 *
 * Three checks before anything is opened, each answered as the app's routes
 * answer them:
 *
 *   - the page's origin: a cookie rides on a WebSocket from any site, so a
 *     socket from another origin is refused (403) whatever it carries;
 *   - the session: `authorize` reads it the way every route does, and mints
 *     the assertion the backend verifies; no session is 401;
 *   - the backend's own answer to the upgrade — its gate and the account's
 *     standing.
 *
 * Once the backend answers 101 the two sockets are piped both ways: the
 * stream's own backpressure holds each side to the other's pace, and either
 * end closing closes the other. A refusal is never a bare dropped
 * connection, which a browser reads as nothing: the browser's upgrade is
 * accepted here and the refusal sent on it as the backend would send one —
 * `{ type: "refused", status, body }`, then a close with 4000 + the status.
 */

/** Where the browser opens its live session: a path no route of Next's claims. */
const LIVE_SOCKET_PATH = "/api/voice/live";

/** What the backend's upgrade carries: the assertion and the language, or why not. */
export type Authorization =
	| { ok: true; headers: Record<string, string> }
	| { ok: false; status: number; body: unknown };

export interface RelayDeps {
	/** The backend's base URL: `BACKEND_URL`. */
	backendUrl: string;
	/** The origin pages are served from: `AUTH_URL`'s, else the request's own host. */
	publicOrigin: string | null;
	authorize(request: IncomingMessage): Promise<Authorization>;
	/** How long the backend has to answer the upgrade; a test's, shorter. */
	upstreamDeadlineMs?: number;
}

/** The bytes of a refusal body the relay reads from the backend: a code, never a page. */
const MAX_REFUSAL_BYTES = 16 * 1024;
const WEBSOCKET_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";
/**
 * The browser's headers the backend's upgrade needs: the handshake's own.
 * Everything else the backend reads — who is calling, in which language —
 * is the caller's, minted here; nothing the browser wrote names either.
 */
const HANDSHAKE = ["sec-websocket-key", "sec-websocket-version"];
/** How long the backend has to answer the upgrade before the browser is told it cannot be reached. */
const UPSTREAM_DEADLINE_MS = 10_000;
/** A server going away, as a WebSocket close says it. */
const GOING_AWAY = 1001;

/** The sessions this process is carrying, each as its two ends. */
const relayed = new Set<{ socket: Duplex; backend: Duplex }>();

/**
 * End every relayed session, for a server that is stopping: the browser is
 * sent a close it can read as the server leaving, and the backend's end is
 * dropped, which is how the backend learns a browser went and settles the
 * session. A frame the pipe had half written reads as an abnormal close,
 * which a browser treats the same way. Answers how many were open.
 */
export function endRelayedSockets(): number {
	const open = relayed.size;
	const close = Buffer.alloc(2);
	close.writeUInt16BE(GOING_AWAY);
	for (const { socket, backend } of relayed) {
		backend.unpipe(socket);
		socket.unpipe(backend);
		if (!socket.destroyed) socket.end(frame(0x8, close));
		backend.destroy();
	}
	relayed.clear();
	return open;
}

export function isLiveSocket(request: IncomingMessage): boolean {
	const path = (request.url ?? "").split("?")[0];
	return (
		path === LIVE_SOCKET_PATH &&
		(request.headers.upgrade ?? "").toLowerCase() === "websocket"
	);
}

/** The origin a page of this app was served from, as the request says it. */
function requestOrigin(request: IncomingMessage): string | null {
	const host = request.headers["x-forwarded-host"] ?? request.headers.host;
	if (!host || Array.isArray(host)) return null;
	const forwarded = request.headers["x-forwarded-proto"];
	const proto =
		(Array.isArray(forwarded) ? forwarded[0] : forwarded)?.split(",")[0] ??
		("encrypted" in request.socket ? "https" : "http");
	return `${proto}://${host.split(",")[0]?.trim()}`;
}

/** Whether the page that opened the socket is this app's: the `Origin` a browser always sends on one. */
function fromOwnOrigin(
	request: IncomingMessage,
	publicOrigin: string | null,
): boolean {
	const origin = request.headers.origin;
	if (!origin) return false;
	return isOwnOrigin(origin, publicOrigin ?? requestOrigin(request));
}

/** One WebSocket frame from a server: unmasked, final, small. */
function frame(opcode: number, payload: Buffer): Buffer {
	const length = payload.length;
	const head =
		length < 126
			? Buffer.from([0x80 | opcode, length])
			: Buffer.from([0x80 | opcode, 126, length >> 8, length & 0xff]);
	return Buffer.concat([head, payload]);
}

/**
 * The browser's upgrade accepted here only to say no on it: the refusal as
 * the backend shapes one, then the close. A request that is not a valid
 * upgrade gets the status as plain HTTP.
 */
export function refuse(
	socket: Duplex,
	request: IncomingMessage,
	status: number,
	body: unknown,
): void {
	const key = request.headers["sec-websocket-key"];
	if (typeof key !== "string" || !key) {
		socket.end(`HTTP/1.1 ${status} Refused\r\nConnection: close\r\n\r\n`);
		return;
	}
	const accept = createHash("sha1")
		.update(key + WEBSOCKET_GUID)
		.digest("base64");
	const code = 4000 + status;
	const close = Buffer.alloc(2);
	close.writeUInt16BE(code > 4999 ? 4000 : code);
	socket.write(
		[
			"HTTP/1.1 101 Switching Protocols",
			"Upgrade: websocket",
			"Connection: Upgrade",
			`Sec-WebSocket-Accept: ${accept}`,
			"",
			"",
		].join("\r\n"),
	);
	socket.write(
		frame(0x1, Buffer.from(JSON.stringify({ type: "refused", status, body }))),
	);
	socket.end(frame(0x8, close));
}

/** The backend's upgrade: the browser's handshake and the caller's headers, nothing else. */
function upstreamHeaders(
	request: IncomingMessage,
	caller: Record<string, string>,
): Record<string, string> {
	const headers: Record<string, string> = {};
	for (const name of HANDSHAKE) {
		const value = request.headers[name];
		if (typeof value === "string") headers[name] = value;
	}
	for (const [name, value] of Object.entries(caller))
		headers[name.toLowerCase()] = value;
	return { ...headers, connection: "Upgrade", upgrade: "websocket" };
}

async function readBody(response: IncomingMessage): Promise<unknown> {
	const chunks: Buffer[] = [];
	let size = 0;
	for await (const chunk of response) {
		size += (chunk as Buffer).length;
		if (size > MAX_REFUSAL_BYTES) break;
		chunks.push(chunk as Buffer);
	}
	try {
		return JSON.parse(Buffer.concat(chunks).toString("utf8"));
	} catch {
		return null;
	}
}

export async function relayLiveSocket(
	request: IncomingMessage,
	socket: Duplex,
	head: Buffer,
	deps: RelayDeps,
): Promise<void> {
	socket.on("error", () => socket.destroy());
	if (!fromOwnOrigin(request, deps.publicOrigin))
		return refuse(socket, request, 403, { code: "forbidden" });
	let caller: Authorization;
	try {
		caller = await deps.authorize(request);
	} catch (err) {
		console.error(
			"[voice] the caller could not be read:",
			(err as Error).message,
		);
		return refuse(socket, request, 503, { code: "unavailable" });
	}
	if (!caller.ok) return refuse(socket, request, caller.status, caller.body);
	if (socket.destroyed) return;

	const target = new URL("/voice/live", deps.backendUrl);
	const client = target.protocol === "https:" ? https : http;
	const upstream = client.request(target, {
		method: "GET",
		headers: upstreamHeaders(request, caller.headers),
	});
	// The browser went while the backend was being asked: nothing to relay to.
	const abandon = () => upstream.destroy();
	socket.once("close", abandon);
	// A backend that takes the connection and never answers is unreachable, said so in time.
	const deadline = setTimeout(
		() => upstream.destroy(new Error("the backend did not answer the upgrade")),
		deps.upstreamDeadlineMs ?? UPSTREAM_DEADLINE_MS,
	);
	const answered = () => {
		clearTimeout(deadline);
		socket.off("close", abandon);
	};
	upstream.on("upgrade", (response, backend, backendHead) => {
		answered();
		if (socket.destroyed) {
			backend.destroy();
			return;
		}
		const lines = [
			`HTTP/1.1 101 ${response.statusMessage ?? "Switching Protocols"}`,
		];
		for (let i = 0; i < response.rawHeaders.length; i += 2)
			lines.push(`${response.rawHeaders[i]}: ${response.rawHeaders[i + 1]}`);
		socket.write(`${lines.join("\r\n")}\r\n\r\n`);
		if (backendHead.length) socket.write(backendHead);
		if (head.length) backend.write(head);
		for (const side of [socket, backend])
			if ("setNoDelay" in side)
				(side as { setNoDelay(on: boolean): void }).setNoDelay(true);
		const pair = { socket, backend };
		relayed.add(pair);
		backend.on("error", () => backend.destroy());
		// Either end closing closes the other; each pipe holds the writer to the reader's pace.
		backend.on("close", () => {
			relayed.delete(pair);
			socket.destroy();
		});
		socket.on("close", () => {
			relayed.delete(pair);
			backend.destroy();
		});
		backend.pipe(socket);
		socket.pipe(backend);
	});
	upstream.on("response", async (response) => {
		answered();
		// A refusal whose body breaks off is still a refusal: the status is said without it.
		const body = await readBody(response).catch(() => null);
		if (socket.destroyed) return;
		refuse(
			socket,
			request,
			response.statusCode ?? 502,
			body ?? { code: "generic" },
		);
	});
	upstream.on("error", () => {
		answered();
		if (!socket.destroyed)
			refuse(socket, request, 503, { code: "backend_unreachable" });
	});
	upstream.end();
}
