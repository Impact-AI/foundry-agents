import { deleteAccount } from "@/src/backend/account";
import type { Caller } from "@/src/backend/client";
import { withCaller } from "@/src/route";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Everything the account holds, erased by the backend; the browser signs out after. */
const erase = async (caller: Caller): Promise<Response> => {
	await deleteAccount(caller);
	return new Response(null, { status: 204 });
};

export const DELETE = withCaller(erase);
