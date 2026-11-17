import type { Caller } from "@/src/backend/client";
import { listConversations } from "@/src/backend/conversations";
import { withCaller } from "@/src/route";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const list = async (caller: Caller): Promise<Response> =>
	Response.json({ conversations: await listConversations(caller) });

export const GET = withCaller(list);
