import { type CallerClaims, callerAssertion } from "@platform/identity";
import type { Hono } from "hono";
import type { AppEnv } from "../auth/context";

/**
 * For tests: a request to the app as the frontend's server would make it —
 * under an assertion minted for a subject. The assertion is real;
 * `AUTH_SECRET` is the suite's.
 */
export interface CallOptions {
	/** The subject the assertion is minted for; none sends no assertion. */
	as?: string | CallerClaims;
	body?: unknown;
	headers?: Record<string, string>;
}

/** A session that began as the claims are made, as the frontend stamps every session it opens. */
export function claimsFor(sub: string): CallerClaims {
	return {
		sub,
		email: `${sub}@example.com`,
		roles: [],
		groups: [],
		tier: "base",
		signedInAt: Math.floor(Date.now() / 1000),
	};
}

export async function call(
	app: Hono<AppEnv>,
	method: string,
	path: string,
	options: CallOptions = {},
): Promise<Response> {
	const headers = new Headers(options.headers);
	if (options.as !== undefined) {
		const claims =
			typeof options.as === "string" ? claimsFor(options.as) : options.as;
		const { token } = await callerAssertion.mint(claims);
		headers.set("authorization", `Bearer ${token}`);
	}
	let body: string | FormData | undefined;
	if (options.body instanceof FormData || typeof options.body === "string") {
		body = options.body;
	} else if (options.body !== undefined) {
		headers.set("content-type", "application/json");
		body = JSON.stringify(options.body);
	}
	return app.request(path, { method, headers, body });
}
