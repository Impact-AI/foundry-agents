import { exportAccount } from "@/src/backend/account";
import type { Caller } from "@/src/backend/client";
import { errorOf, relayResponse } from "@/src/backend/client";
import { withCaller } from "@/src/route";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** The account's data, streamed from the backend as a download. */
export const download = async (
	caller: Caller,
	req: Request,
): Promise<Response> => {
	const res = await exportAccount(caller, req.signal);
	if (!res.ok) throw await errorOf(res);
	const relayed = relayResponse(res);
	relayed.headers.set("Content-Type", "application/json");
	relayed.headers.set(
		"Content-Disposition",
		'attachment; filename="account-export.json"',
	);
	relayed.headers.set("Cache-Control", "no-store");
	return relayed;
};

export const GET = withCaller(download);
