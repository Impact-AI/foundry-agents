import type { Caller } from "@/src/backend/client";
import { saveVoiceTuning, type VoiceTuning } from "@/src/backend/voice";
import { withCaller } from "@/src/route";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * A voice tester's tuning, forwarded whole: an object, or nothing. Who is a
 * tester and whether every value holds is the backend's to decide, from the
 * account's row; a refusal crosses as its code and status.
 */
const save = async (caller: Caller, req: Request): Promise<Response> => {
	const body: unknown = await req.json().catch(() => null);
	if (!body || typeof body !== "object" || Array.isArray(body))
		return Response.json({ code: "bad_request" }, { status: 400 });
	return Response.json(await saveVoiceTuning(caller, body as VoiceTuning), {
		headers: { "Cache-Control": "no-store" },
	});
};

export const PUT = withCaller(save);
