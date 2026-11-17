import { timingSafeEqual } from "node:crypto";
import { callerHeaders } from "@/src/backend/client";
import { readCaller } from "@/src/session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const NO_STORE = { "Cache-Control": "no-store" };

/** The key the server hosting this app minted at start (`server/main.ts`): only it can ask. */
function fromOwnServer(req: Request): boolean {
	const key = process.env.VOICE_RELAY_KEY;
	const given = req.headers.get("x-voice-relay-key");
	if (!key || !given) return false;
	const a = Buffer.from(key);
	const b = Buffer.from(given);
	return a.length === b.length && timingSafeEqual(a, b);
}

/**
 * The live voice socket's caller (`server/relay.ts`): the session behind
 * the browser's cookies, read as every route reads it, and the headers the
 * backend's upgrade carries for it — the assertion and the language. It
 * answers only the server hosting this app, which calls it over loopback
 * with a key minted at start and held in that process alone; to anybody
 * else it does not exist. Nothing it returns reaches a browser: the relay
 * puts it on the request to the backend.
 */
export async function GET(req: Request): Promise<Response> {
	if (!fromOwnServer(req))
		return Response.json(
			{ code: "not_found" },
			{ status: 404, headers: NO_STORE },
		);
	const caller = await readCaller();
	if (!caller)
		return Response.json(
			{ code: "unauthenticated" },
			{ status: 401, headers: NO_STORE },
		);
	return Response.json(
		{ headers: await callerHeaders(caller) },
		{ headers: NO_STORE },
	);
}
