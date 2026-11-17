import type { Caller } from "@/src/backend/client";
import { listRecords } from "@/src/backend/records";
import { withCaller } from "@/src/route";
import { isRecordKind } from "@/src/stage/stage";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_QUERY = 120;

/** The records as one line each, from the backend's sample, for the stage's listing. */
export const list = async (caller: Caller, req: Request): Promise<Response> => {
	const params = new URL(req.url).searchParams;
	const kind = params.get("kind");
	if (kind !== null && !isRecordKind(kind))
		return Response.json({ code: "bad_request" }, { status: 400 });
	const query = (params.get("query") ?? "").trim().slice(0, MAX_QUERY);
	return Response.json(
		{ records: await listRecords(caller, kind, query, req.signal) },
		{ headers: { "Cache-Control": "no-store" } },
	);
};

export const GET = withCaller(list);
