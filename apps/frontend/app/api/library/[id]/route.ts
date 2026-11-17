import type { Caller } from "@/src/backend/client";
import { readDocument } from "@/src/backend/library";
import { type Params, withCaller } from "@/src/route";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** One document for the reader; the backend's 404 crosses as the same code. */
export const read = async (
	caller: Caller,
	req: Request,
	{ id }: Params,
): Promise<Response> => {
	const document = await readDocument(caller, id as string, req.signal);
	if (!document) return Response.json({ code: "not_found" }, { status: 404 });
	return Response.json(document, { headers: { "Cache-Control": "no-store" } });
};

export const GET = withCaller(read);
