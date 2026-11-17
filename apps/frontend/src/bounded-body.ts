import {
	cappedRequest,
	isBodyOverLimit,
	overDeclaredLimit,
} from "@platform/http/request-limit";

/**
 * A request body under a byte bound. `Content-Length` is a claim a chunked
 * body does not make, so the declared size refuses early and a count of the
 * bytes as they arrive refuses the rest.
 */

export function bodyTooLarge(): Response {
	return Response.json({ code: "body_too_large" }, { status: 413 });
}

/** The body's bytes, or null once they are past `limit`; never more than `limit` held. */
export async function readBounded(
	req: Request,
	limit: number,
): Promise<ArrayBuffer | null> {
	if (overDeclaredLimit(req, limit)) return null;
	try {
		return await cappedRequest(req, limit).arrayBuffer();
	} catch (err) {
		if (isBodyOverLimit(err)) return null;
		throw err;
	}
}
