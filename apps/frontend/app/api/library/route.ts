import type { Caller } from "@/src/backend/client";
import { listLibrary } from "@/src/backend/library";
import { withCaller } from "@/src/route";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_QUERY = 200;
const MAX_TAGS = 12;

/** The library's cards for a query, from the backend's search under the caller's access. */
export const list = async (caller: Caller, req: Request): Promise<Response> => {
	const params = new URL(req.url).searchParams;
	const query = (params.get("query") ?? "").trim().slice(0, MAX_QUERY);
	const tags = params
		.getAll("tags")
		.flatMap((t) => t.split(","))
		.map((t) => t.trim().slice(0, 60))
		.filter(Boolean)
		.slice(0, MAX_TAGS);
	return Response.json(await listLibrary(caller, query, tags, req.signal), {
		headers: { "Cache-Control": "no-store" },
	});
};

export const GET = withCaller(list);
