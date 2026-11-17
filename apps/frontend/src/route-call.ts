import { type ErrorCode, errorCodeOf } from "./errors";

/**
 * The browser's call to one of this app's own routes (`app/api/*`), the one
 * shape every client caller reads: the body when the route said yes, the
 * code when it said no — read the way every refusal is read, so a 429 with
 * no body is still `rate_limited` — and `backend_unreachable` when nothing
 * answered. `send` is `fetch` unless a test hands in a route of its own.
 */
export type Send = (url: string, init: RequestInit) => Promise<Response>;

export type RouteAnswer<T> =
	| { ok: true; body: T }
	| { ok: false; code: ErrorCode };

export async function callRoute<T>(
	send: Send,
	url: string,
	init: RequestInit = {},
): Promise<RouteAnswer<T>> {
	try {
		const res = await send(url, init);
		const body = (await res.json().catch(() => null)) as unknown;
		return res.ok
			? { ok: true, body: body as T }
			: { ok: false, code: errorCodeOf(body, res.status) };
	} catch {
		return { ok: false, code: "backend_unreachable" };
	}
}

/** A JSON body for a write. */
export const jsonInit = (method: string, body: unknown): RequestInit => ({
	method,
	headers: { "Content-Type": "application/json" },
	body: JSON.stringify(body),
});
