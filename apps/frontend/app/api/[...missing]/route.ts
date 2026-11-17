export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * A path under `/api/` that no route answers. Without this the framework
 * answers it with the not-found page: a document, where every other answer
 * under `/api/` is data, and one the proxy gives no policy to. It asks for
 * no session, since it holds nothing: a path the door stands before is
 * refused there first, and the rest learn only that nothing is here.
 */
const missing = (): Response =>
	Response.json(
		{ code: "not_found" },
		{ status: 404, headers: { "Cache-Control": "no-store" } },
	);

export const GET = missing;
export const HEAD = missing;
export const POST = missing;
export const PUT = missing;
export const PATCH = missing;
export const DELETE = missing;
export const OPTIONS = missing;
