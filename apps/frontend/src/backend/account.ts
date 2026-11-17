import { backendFetch, backendJson, type Caller } from "./client";

/** The account and everything held under it — its conversations, what the assistant remembers — gone. */
export async function deleteAccount(caller: Caller): Promise<void> {
	// An erase walks every conversation the account holds.
	await backendJson<void>(caller, "/account", {
		method: "DELETE",
		deadlineMs: 120_000,
	});
}

/** The account's data as one streamed JSON document, handed on as it arrives. */
export function exportAccount(
	caller: Caller,
	signal?: AbortSignal,
): Promise<Response> {
	return backendFetch(caller, "/account/export", { signal });
}
