import type { Caller } from "@/src/backend/client";
import { voiceCapability } from "@/src/backend/voice";
import { withCaller } from "@/src/route";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const capability = async (caller: Caller): Promise<Response> =>
	Response.json(await voiceCapability(caller), {
		headers: { "Cache-Control": "no-store" },
	});

export const GET = withCaller(capability);
