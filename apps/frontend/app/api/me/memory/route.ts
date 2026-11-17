import type { Caller } from "@/src/backend/client";
import { forgetMemory, readMemory } from "@/src/backend/person";
import { withCaller } from "@/src/route";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const NO_STORE = { "Cache-Control": "no-store" };

/** What the assistant remembers about the person: read, and forgotten all at once. */
export const read = async (caller: Caller): Promise<Response> =>
	Response.json(await readMemory(caller), { headers: NO_STORE });

export const forget = async (caller: Caller): Promise<Response> => {
	await forgetMemory(caller);
	return new Response(null, { status: 204 });
};

export const GET = withCaller(read);
export const DELETE = withCaller(forget);
