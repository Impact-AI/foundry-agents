import { type Caller, refusalResponse } from "./backend/client";
import { bodyTooLarge, readBounded } from "./bounded-body";
import { isOwnOriginRequest } from "./same-origin";
import { readCaller } from "./session";

/**
 * The shape of every route handler under `app/api/*`: session → client →
 * response. The handler gets the verified caller and never reads identity
 * off the request; a refusal from the backend crosses as the same code and
 * status it arrived with.
 *
 * What every route owes is paid here, once: a request that changes
 * something is taken only from a page of this app, its body is read under a
 * byte bound before the handler parses it, and an answer that names no
 * caching of its own is never stored, since every answer here is one
 * person's.
 */
export type Params = Record<string, string | string[]>;

export type CallerHandler = (
	caller: Caller,
	req: Request,
	params: Params,
) => Promise<Response>;

export interface RouteOptions {
	/**
	 * The bytes a body may hold; `"own"` for a route that reads its body
	 * under a bound of its own.
	 */
	maxBodyBytes?: number | "own";
}

/** A settings form's JSON, with room to spare: the largest field any route takes is a thousand characters. */
const JSON_BODY_BYTES = 64 * 1024;

const NO_STORE = { "Cache-Control": "no-store" };

function refused(status: number, code: string): Response {
	return Response.json({ code }, { status, headers: NO_STORE });
}

/** The request with its body already read, under the bound; null past it. */
async function bounded(req: Request, limit: number): Promise<Request | null> {
	if (!req.body) return req;
	const body = await readBounded(req, limit);
	return body ? new Request(req, { body }) : null;
}

function uncached(res: Response): Response {
	if (res.headers.has("cache-control")) return res;
	try {
		res.headers.set("Cache-Control", "no-store");
		return res;
	} catch {
		// A response whose headers are sealed is answered again with the header added.
		const headers = new Headers(res.headers);
		headers.set("Cache-Control", "no-store");
		return new Response(res.body, {
			status: res.status,
			statusText: res.statusText,
			headers,
		});
	}
}

/** Run a handler for the verified caller, answering refusals as codes. */
export async function handleAs(
	caller: Caller | null,
	handler: CallerHandler,
	req: Request,
	params: Params,
	options: RouteOptions = {},
): Promise<Response> {
	if (!caller) return refused(401, "unauthenticated");
	if (!isOwnOriginRequest(req)) return refused(403, "forbidden");
	try {
		const limit = options.maxBodyBytes ?? JSON_BODY_BYTES;
		const held = limit === "own" ? req : await bounded(req, limit);
		if (!held) return uncached(bodyTooLarge());
		return uncached(await handler(caller, held, params));
	} catch (err) {
		return refusalResponse(err);
	}
}

/** The Next route export: the session read here, the rest handed to `handleAs`. */
export function withCaller(handler: CallerHandler, options?: RouteOptions) {
	return async (
		req: Request,
		context: { params: Promise<Params> },
	): Promise<Response> =>
		handleAs(await readCaller(), handler, req, await context.params, options);
}
