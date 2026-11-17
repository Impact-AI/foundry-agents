import type { Context } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";

export const NO_STORE = { "Cache-Control": "no-store" };

/** A refusal: a code and typed facets, never a sentence. The client's catalogue carries the words. */
export function refuse(
	c: Context,
	status: ContentfulStatusCode,
	code: string,
	facets: Record<string, unknown> = {},
): Response {
	return c.json({ code, ...facets }, status, NO_STORE);
}

/** The body as a JSON object, or null when it is not one. */
export async function readObject(
	c: Context,
): Promise<Record<string, unknown> | null> {
	try {
		const body: unknown = await c.req.json();
		return body && typeof body === "object" && !Array.isArray(body)
			? (body as Record<string, unknown>)
			: null;
	} catch {
		return null;
	}
}
