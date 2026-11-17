import { envString } from "@platform/config/env";
import { isBodyOverLimit } from "@platform/http/request-limit";
import { keepStreamAlive } from "@platform/http/streaming";
import { errorCodeOf, retryAfterSeconds } from "../errors";
import type { Locale } from "../i18n/locales";
import { type CallerClaims, callerAssertion } from "../identity";

/**
 * The one way this app reaches the backend. Every call carries a caller
 * assertion minted here from a verified session, and the language this
 * request resolved to: one account is one person, so who is calling is the
 * whole scope. Nothing else in the app calls `fetch` against the backend, so
 * the secret that signs the assertion never leaves the server.
 */

export interface Caller {
	claims: CallerClaims;
	/** Resolved here, by the one order, so the backend answers in the language the page is in. */
	locale: Locale;
}

export class BackendError extends Error {
	constructor(
		readonly status: number,
		readonly code: string,
		readonly retryAfterSeconds?: number,
	) {
		super(`backend answered ${status} ${code}`);
		this.name = "BackendError";
	}
}

export function backendUrl(): string {
	const url = envString("BACKEND_URL");
	if (!url)
		throw new Error(
			"BACKEND_URL is not set — this app has no backend to talk to.",
		);
	return url.replace(/\/+$/, "");
}

export interface CallOptions {
	method?: string;
	body?: BodyInit | null;
	headers?: Record<string, string>;
	/** The request this call serves: it going away ends the call. */
	signal?: AbortSignal;
	/** How long a call with no `signal` may take, answer included. */
	deadlineMs?: number;
}

/** A call nobody can abandon is bounded here, so a backend that never answers fails the request rather than holding it. */
const BACKEND_DEADLINE_MS = 30_000;

/**
 * Whether a failure is the caller leaving. Next aborts a request's signal
 * with its own `ResponseAborted`, and `fetch` rejects with whatever reason
 * the signal carries, so the name alone is not the test: the signal is.
 */
export function isAbort(err: unknown, signal?: AbortSignal): boolean {
	if (signal?.aborted) return true;
	return (
		err instanceof Error &&
		(err.name === "AbortError" || err.name === "ResponseAborted")
	);
}

/** The headers every call carries: the assertion and the language, beside any the call adds. */
export async function callerHeaders(
	caller: Caller,
	headers: Record<string, string> = {},
): Promise<Record<string, string>> {
	const { token } = await callerAssertion.mint(caller.claims);
	return {
		...headers,
		Authorization: `Bearer ${token}`,
		"Accept-Language": caller.locale,
	};
}

/** A raw call: the response as the backend sent it, whatever its status. */
export async function backendFetch(
	caller: Caller,
	path: string,
	options: CallOptions = {},
): Promise<Response> {
	const headers = await callerHeaders(caller, options.headers);
	try {
		return await fetch(`${backendUrl()}${path}`, {
			method: options.method ?? "GET",
			headers,
			body: options.body ?? null,
			signal:
				options.signal ??
				AbortSignal.timeout(options.deadlineMs ?? BACKEND_DEADLINE_MS),
			// A relayed stream must not be buffered here either.
			cache: "no-store",
			// Node's fetch refuses a streamed request body unless told it is
			// half-duplex; a forwarded upload is exactly that.
			...(options.body instanceof ReadableStream ? { duplex: "half" } : {}),
		} as RequestInit);
	} catch (err) {
		if (options.signal && isAbort(err, options.signal)) throw err;
		// A forwarded body counted past its bound fails the call, not the backend.
		if (isBodyOverLimit(err)) throw new BackendError(413, "body_too_large");
		throw new BackendError(503, "backend_unreachable");
	}
}

/** A JSON call: the parsed body, or a `BackendError` carrying the backend's code. */
export async function backendJson<T>(
	caller: Caller,
	path: string,
	options: CallOptions & { json?: unknown } = {},
): Promise<T> {
	const res = await backendFetch(caller, path, {
		...options,
		headers: {
			...options.headers,
			...(options.json !== undefined
				? { "Content-Type": "application/json" }
				: {}),
		},
		body:
			options.json !== undefined ? JSON.stringify(options.json) : options.body,
	});
	if (!res.ok) throw await errorOf(res);
	if (res.status === 204) return undefined as T;
	try {
		return (await res.json()) as T;
	} catch (err) {
		if (options.signal && isAbort(err, options.signal)) throw err;
		// The deadline covers the body too: one that stops arriving is a
		// backend that did not answer, as one that never sent headers is.
		if (isDeadline(err)) throw new BackendError(503, "backend_unreachable");
		throw err;
	}
}

/** The call's own deadline ending it, whichever name the runtime gives that. */
function isDeadline(err: unknown): boolean {
	return (
		err instanceof Error &&
		(err.name === "TimeoutError" || err.name === "AbortError")
	);
}

/** The backend's refusal as an error, the code read from the body. */
export async function errorOf(res: Response): Promise<BackendError> {
	const body = await res.json().catch(() => null);
	return new BackendError(
		res.status,
		errorCodeOf(body, res.status),
		res.status === 429
			? retryAfterSeconds(
					res.headers.get("retry-after") ??
						(body as { retryAfterSeconds?: unknown })?.retryAfterSeconds,
				)
			: undefined,
	);
}

const HOP_BY_HOP = [
	"connection",
	"keep-alive",
	"transfer-encoding",
	"content-length",
];

/**
 * A backend response handed on to the browser: the body streamed as it
 * arrives, kept alive through any proxy, hop-by-hop headers dropped. The
 * encoding goes with them: `fetch` has decoded the body, so the header
 * names bytes that are no longer there, and an event stream that still
 * carried it would be handed on as encoded bytes no keepalive may enter.
 */
export function relayResponse(res: Response): Response {
	const headers = new Headers(res.headers);
	for (const name of HOP_BY_HOP) headers.delete(name);
	headers.delete("content-encoding");
	return keepStreamAlive(
		new Response(res.body, {
			status: res.status,
			statusText: res.statusText,
			headers,
		}),
	);
}

/** A refusal as this app's own routes answer it: the same code, the same status. */
export function refusalResponse(err: unknown): Response {
	if (err instanceof BackendError) {
		return Response.json(
			{ code: err.code },
			{
				status: err.status,
				headers: {
					"Cache-Control": "no-store",
					...(err.retryAfterSeconds
						? { "Retry-After": String(err.retryAfterSeconds) }
						: {}),
				},
			},
		);
	}
	if (isAbort(err)) return new Response(null, { status: 499 });
	console.error("[backend] call failed:", err);
	return Response.json(
		{ code: "generic" },
		{ status: 500, headers: { "Cache-Control": "no-store" } },
	);
}
