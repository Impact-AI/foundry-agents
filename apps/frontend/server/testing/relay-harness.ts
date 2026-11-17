import { createServer } from "node:http";
import { endRelayedSockets, relayLiveSocket } from "../relay";

/**
 * The relay on Node's own HTTP server — the runtime the image serves it on,
 * and one whose upgrade sockets Bun's `node:http` does not yet write to —
 * for `relay.test.ts`, which builds this file, runs it under `node` and
 * talks to it. The caller is stood in for: the cookie `session=ok` is a
 * person, `session=deactivated` one whose account the backend refuses,
 * `session=silent` one whose upgrade the backend never answers, and
 * anything else is nobody. `SIGUSR2` ends the relayed sessions as a
 * stopping server does.
 *
 *   RELAY_TEST_BACKEND  the stand-in backend's base URL
 *   RELAY_TEST_ORIGIN   the origin pages are served from
 */
const backendUrl = process.env.RELAY_TEST_BACKEND ?? "";
const publicOrigin = process.env.RELAY_TEST_ORIGIN ?? null;
const CALLERS: Record<string, string> = {
	"session=ok": "Bearer minted",
	"session=deactivated": "Bearer refused-by-standing",
	"session=silent": "Bearer never-answered",
};
const server = createServer((_req, res) => {
	res.statusCode = 404;
	res.end();
});
server.on("upgrade", (request, socket, head) => {
	void relayLiveSocket(request, socket, head, {
		backendUrl,
		publicOrigin,
		authorize: async (req) =>
			req.headers.cookie && req.headers.cookie in CALLERS
				? {
						ok: true,
						headers: {
							Authorization: CALLERS[req.headers.cookie] as string,
							"Accept-Language": "it",
						},
					}
				: { ok: false, status: 401, body: { code: "unauthenticated" } },
		upstreamDeadlineMs: 300,
	});
});
process.on("SIGUSR2", () => endRelayedSockets());
server.listen(0, "127.0.0.1", () => {
	const address = server.address();
	console.log(
		JSON.stringify({ port: typeof address === "object" ? address?.port : 0 }),
	);
});
