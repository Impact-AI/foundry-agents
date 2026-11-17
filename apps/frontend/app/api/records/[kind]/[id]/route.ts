import type { Caller } from "@/src/backend/client";
import { readRecord } from "@/src/backend/records";
import { type Params, withCaller } from "@/src/route";
import { isRecordKind } from "@/src/stage/stage";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** One entity card from the backend's sample records. */
export const read = async (
	caller: Caller,
	req: Request,
	{ kind, id }: Params,
): Promise<Response> => {
	if (!isRecordKind(kind))
		return Response.json({ code: "bad_request" }, { status: 400 });
	const record = await readRecord(caller, kind, id as string, req.signal);
	if (!record) return Response.json({ code: "not_found" }, { status: 404 });
	return Response.json(record, { headers: { "Cache-Control": "no-store" } });
};

export const GET = withCaller(read);
