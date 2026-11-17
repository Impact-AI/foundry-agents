import type { Caller } from "@/src/backend/client";
import { updatePerson } from "@/src/backend/person";
import { readPersonPatch } from "@/src/person";
import { withCaller } from "@/src/route";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** The person's own fields: the validated ones only, forwarded; the backend checks again. */
export const edit = async (caller: Caller, req: Request): Promise<Response> => {
	const patch = readPersonPatch(await req.json().catch(() => null));
	if (!patch) return Response.json({ code: "bad_request" }, { status: 400 });
	return Response.json(await updatePerson(caller, patch), {
		headers: { "Cache-Control": "no-store" },
	});
};

export const PATCH = withCaller(edit);
