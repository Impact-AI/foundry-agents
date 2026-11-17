import { randomBytes } from "node:crypto";
import { createServer, type IncomingMessage } from "node:http";
import path from "node:path";
import {
	type Authorization,
	endRelayedSockets,
	isLiveSocket,
	refuse,
	relayLiveSocket,
} from "./relay";

/**
 * The frontend's server: Next, as its standalone build serves it, and the
 * live voice socket beside it (`relay.ts`), which Next's route handlers
 * cannot take. It is Next's documented custom server: the same request
 * handler, on a listener of this file's whose upgrades this file answers.
 *
 * Built by `bun run build:server` into the standalone tree next to Next's
 * own `server.js` — `main.js`, which the image runs — and run in place with
 * `--dev` for a local session with voice.
 *
 * The relay reads the caller the way every route does: it asks this app's
 * own route `/api/voice/relay-caller` over loopback, with the browser's
 * cookies and a key only this process holds, and gets back the assertion
 * for the backend. The key is minted at start and never leaves the process,
 * so the route answers nobody else.
 */

const dev = process.argv.includes("--dev");
// Where `main.js` was started from: the standalone tree. Not `__dirname`, which the bundler fixes at build time.
const dir = dev
	? process.cwd()
	: path.dirname(path.resolve(process.argv[1] ?? "."));
const port = Number.parseInt(process.env.PORT ?? "", 10) || 3000;
// The image names every interface (`HOSTNAME=0.0.0.0`). A local session
// names none, and listens on this machine alone: Next is told the host it is
// reached at, and Auth.js writes the redirect after a sign-in from it, so a
// wildcard here would send the browser to an address its session cookie was
// not set for.
const hostname = process.env.HOSTNAME || (dev ? "localhost" : "0.0.0.0");

if (!dev) {
	(process.env as Record<string, string>).NODE_ENV = "production";
	process.chdir(dir);
	// What the standalone `server.js` hands Next: the config the build traced, never a next.config to load.
	const { config } = require(
		path.join(dir, ".next", "required-server-files.json"),
	) as { config: unknown };
	process.env.__NEXT_PRIVATE_STANDALONE_CONFIG = JSON.stringify(config);
}

/** This server, as it listens: the wildcard addresses are reached on IPv4 loopback, a named host by its name. */
const loopback = `http://${["0.0.0.0", "::"].includes(hostname) ? "127.0.0.1" : hostname}:${port}`;

const RELAY_KEY = randomBytes(32).toString("base64url");
process.env.VOICE_RELAY_KEY = RELAY_KEY;

/** This server answering itself: longer than that is a server that cannot. */
const AUTHORIZE_DEADLINE_MS = 5_000;
/**
 * How long a stopping server gives the answers it is streaming. The
 * platform ends the container thirty seconds after the signal unless the
 * template says otherwise; this leaves it room to exit by itself first.
 */
const DRAIN_MS = 25_000;

/** The caller behind the browser's cookies, as this app's own route reads it. */
async function authorize(request: IncomingMessage): Promise<Authorization> {
	const headers: Record<string, string> = { "x-voice-relay-key": RELAY_KEY };
	for (const name of [
		"cookie",
		"accept-language",
		"x-forwarded-host",
		"x-forwarded-proto",
	]) {
		const value = request.headers[name];
		if (typeof value === "string") headers[name] = value;
	}
	const response = await fetch(`${loopback}/api/voice/relay-caller`, {
		headers,
		cache: "no-store",
		signal: AbortSignal.timeout(AUTHORIZE_DEADLINE_MS),
	});
	const body = (await response.json().catch(() => null)) as {
		headers?: Record<string, string>;
	} | null;
	return response.ok && body?.headers
		? { ok: true, headers: body.headers }
		: { ok: false, status: response.status, body };
}

const next = require("next") as (options: Record<string, unknown>) => {
	prepare(): Promise<void>;
	getRequestHandler(): (
		req: IncomingMessage,
		res: import("node:http").ServerResponse,
	) => Promise<void>;
	upgradeHandler: (
		req: IncomingMessage,
		socket: import("node:stream").Duplex,
		head: Buffer,
	) => Promise<void>;
};
// A listener Next is told is its own, so it attaches no upgrade handler to this one: this file decides every upgrade.
const decoy = createServer();
const app = next({ dev, dir, hostname, port, httpServer: decoy });

async function main(): Promise<void> {
	await app.prepare();
	const handle = app.getRequestHandler();
	const backendUrl = process.env.BACKEND_URL;
	const publicOrigin = process.env.AUTH_URL
		? new URL(process.env.AUTH_URL).origin
		: null;
	const server = createServer((req, res) => void handle(req, res));
	server.on("upgrade", (request, socket, head) => {
		if (isLiveSocket(request) && !backendUrl) {
			refuse(socket, request, 503, { code: "unconfigured" });
			return;
		}
		if (isLiveSocket(request) && backendUrl) {
			void relayLiveSocket(request, socket, head, {
				backendUrl,
				publicOrigin,
				authorize,
			}).catch((err: Error) => {
				console.error("[voice] the socket was not relayed:", err.message);
				socket.destroy();
			});
			return;
		}
		// Next's own sockets: its development reloads.
		if (dev) void app.upgradeHandler(request, socket, head);
		else socket.destroy();
	});
	const keepAlive = Number.parseInt(process.env.KEEP_ALIVE_TIMEOUT ?? "", 10);
	if (Number.isFinite(keepAlive) && keepAlive >= 0)
		server.keepAliveTimeout = keepAlive;
	server.listen(port, hostname, () =>
		console.log(
			`[frontend] ready on http://${hostname}:${port}${backendUrl ? "" : " (no BACKEND_URL: no live voice)"}`,
		),
	);
	// On a signal: no new connections, the live sessions told the server is
	// leaving, and the answers already streaming given until the bound to end.
	let stopping = false;
	const stop = () => {
		if (stopping) return;
		stopping = true;
		server.close(() => process.exit(0));
		server.closeIdleConnections();
		endRelayedSockets();
		setTimeout(() => process.exit(0), DRAIN_MS).unref();
	};
	process.on("SIGTERM", stop);
	process.on("SIGINT", stop);
}

main().catch((err) => {
	console.error(err);
	process.exit(1);
});
