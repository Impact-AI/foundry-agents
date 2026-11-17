import type { Caller } from "@/src/backend/client";
import {
	deleteConversation,
	readConversation,
	renameConversation,
} from "@/src/backend/conversations";
import { TITLE_LENGTH } from "@/src/chat/title";
import { type Params, withCaller } from "@/src/route";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const read = async (
	caller: Caller,
	_req: Request,
	{ id }: Params,
): Promise<Response> =>
	Response.json(await readConversation(caller, id as string));

export const rename = async (
	caller: Caller,
	req: Request,
	{ id }: Params,
): Promise<Response> => {
	const body = (await req.json().catch(() => ({}))) as { title?: unknown };
	const title = typeof body.title === "string" ? body.title.trim() : "";
	if (!title || title.length > TITLE_LENGTH)
		return Response.json({ code: "bad_request" }, { status: 400 });
	return Response.json(await renameConversation(caller, id as string, title));
};

const remove = async (
	caller: Caller,
	_req: Request,
	{ id }: Params,
): Promise<Response> => {
	await deleteConversation(caller, id as string);
	return new Response(null, { status: 204 });
};

export const GET = withCaller(read);
export const PATCH = withCaller(rename);
export const DELETE = withCaller(remove);
