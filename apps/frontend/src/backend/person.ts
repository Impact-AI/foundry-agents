import type {
	Person,
	PersonPatch,
	Remembered,
	RememberedItem,
} from "../person";
import { backendJson, type Caller } from "./client";

/**
 * The person behind the account, and what the assistant remembers about
 * them: what the backend's `/identity/me` answers, and the calls that change
 * them. One account is one person; none of these takes the account's id.
 */
export async function readPerson(caller: Caller): Promise<Person> {
	const { name, about, preferences } = await backendJson<Person>(
		caller,
		"/identity/me",
	);
	return { name, about, preferences };
}

export function updatePerson(
	caller: Caller,
	patch: PersonPatch,
): Promise<Person> {
	return backendJson<Person>(caller, "/identity/me", {
		method: "PATCH",
		json: patch,
	});
}

export function readMemory(caller: Caller): Promise<Remembered> {
	return backendJson<Remembered>(caller, "/identity/me/memory");
}

export function correctMemory(
	caller: Caller,
	id: string,
	content: string,
): Promise<RememberedItem> {
	return backendJson<RememberedItem>(
		caller,
		`/identity/me/memory/${encodeURIComponent(id)}`,
		{ method: "PATCH", json: { content } },
	);
}

export async function removeMemory(caller: Caller, id: string): Promise<void> {
	await backendJson<void>(
		caller,
		`/identity/me/memory/${encodeURIComponent(id)}`,
		{ method: "DELETE" },
	);
}

export async function forgetMemory(caller: Caller): Promise<void> {
	await backendJson<void>(caller, "/identity/me/memory", { method: "DELETE" });
}
