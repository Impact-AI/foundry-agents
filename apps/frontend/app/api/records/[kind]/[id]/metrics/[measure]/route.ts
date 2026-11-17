import type { Caller } from "@/src/backend/client";
import { readMetrics } from "@/src/backend/records";
import { type Params, withCaller } from "@/src/route";
import { isRecordKind } from "@/src/stage/stage";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** One measure of one record as the chart draws it, from the backend's sample records. */
export const read = async (
	caller: Caller,
	req: Request,
	{ kind, id, measure }: Params,
): Promise<Response> => {
	if (!isRecordKind(kind))
		return Response.json({ code: "bad_request" }, { status: 400 });
	const period = new URL(req.url).searchParams.get("period") ?? "quarter";
	if (period !== "quarter" && period !== "year")
		return Response.json({ code: "bad_request" }, { status: 400 });
	const chart = await readMetrics(
		caller,
		kind,
		id as string,
		measure as string,
		period,
		req.signal,
	);
	if (!chart) return Response.json({ code: "not_found" }, { status: 404 });
	return Response.json(
		{ found: true, chart },
		{ headers: { "Cache-Control": "no-store" } },
	);
};

export const GET = withCaller(read);
