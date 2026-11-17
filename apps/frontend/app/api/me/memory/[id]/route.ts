import type { Caller } from "@/src/backend/client";
import { correctMemory, removeMemory } from "@/src/backend/person";
import { MEMORY_ITEM_MAX } from "@/src/person";
import { type Params, withCaller } from "@/src/route";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const NO_STORE = { "Cache-Control": "no-store" };

/** One statement the assistant remembers: corrected, or removed. */
export const correct = async (
	caller: Caller,
	req: Request,
	{ id }: Params,
): Promise<Response> => {
	const body = (await req.json().catch(() => null)) as {
		content?: unknown;
	} | null;
	if (
		typeof body?.content !== "string" ||
		body.content.length > MEMORY_ITEM_MAX
	)
		return Response.json({ code: "bad_request" }, { status: 400 });
	return Response.json(
		await correctMemory(caller, id as string, body.content),
		{
			headers: NO_STORE,
		},
	);
};

export const remove = async (
	caller: Caller,
	_req: Request,
	{ id }: Params,
): Promise<Response> => {
	await removeMemory(caller, id as string);
	return new Response(null, { status: 204 });
};

export const PATCH = withCaller(correct);
export const DELETE = withCaller(remove);
