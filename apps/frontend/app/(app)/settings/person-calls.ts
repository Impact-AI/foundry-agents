import type { ErrorCode } from "@/src/errors";
import type { Person, PersonPatch, RememberedItem } from "@/src/person";
import { callRoute, jsonInit, type Send } from "@/src/route-call";

/**
 * The settings cards' calls, through this app's own routes (`app/api/me`):
 * the person's edit, and the three things they may do to what the assistant
 * remembers — correct a statement, remove one, forget all of it. Each
 * answers the route's code on a refusal, for the catalogue to render.
 */
const ME = "/api/me";
const MEMORY = "/api/me/memory";

const memoryItem = (id: string) => `${MEMORY}/${encodeURIComponent(id)}`;

export async function savePerson(
	patch: PersonPatch,
	send: Send = fetch,
): Promise<{ person?: Person; code?: ErrorCode }> {
	const answer = await callRoute<Person>(send, ME, jsonInit("PATCH", patch));
	return answer.ok ? { person: answer.body } : { code: answer.code };
}

export async function saveMemoryItem(
	id: string,
	content: string,
	send: Send = fetch,
): Promise<{ item?: RememberedItem; code?: ErrorCode }> {
	const answer = await callRoute<RememberedItem>(
		send,
		memoryItem(id),
		jsonInit("PATCH", { content }),
	);
	return answer.ok ? { item: answer.body } : { code: answer.code };
}

/** Gone already is gone: a statement the store no longer holds is not a failure to remove it. */
export async function removeMemoryItem(
	id: string,
	send: Send = fetch,
): Promise<{ code?: ErrorCode }> {
	const answer = await callRoute(send, memoryItem(id), { method: "DELETE" });
	return answer.ok || answer.code === "not_found" ? {} : { code: answer.code };
}

export async function forgetMemory(
	send: Send = fetch,
): Promise<{ code?: ErrorCode }> {
	const answer = await callRoute(send, MEMORY, { method: "DELETE" });
	return answer.ok ? {} : { code: answer.code };
}
