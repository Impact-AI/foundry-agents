import { redirect } from "next/navigation";
import { BackendError, type Caller } from "@/src/backend/client";
import { readMemory, readPerson } from "@/src/backend/person";
import { ACCOUNT_ERASED } from "@/src/errors";
import type { Person, Remembered } from "@/src/person";

export interface SettingsReads {
	readPerson: (caller: Caller) => Promise<Person>;
	readMemory: (caller: Caller) => Promise<Remembered>;
}

/**
 * The person and what the assistant remembers, for the settings page; null
 * when the backend says this session's account is erased. That is what an
 * erase that stopped part way leaves too: the account's row is shut, so
 * nothing of the person can be read, and the one thing the session may
 * still do is ask for the erase again, which finishes it. The page then
 * offers exactly that rather than failing, so a person who reloads or comes
 * back after a failed erase can still finish it. A 401 that names anything
 * else is a session the backend does not accept, which is sent to sign in,
 * never told it is being erased. Any other refusal is the page's error.
 */
export async function readSettings(
	caller: Caller,
	reads: SettingsReads = { readPerson, readMemory },
	toSignIn: () => never = () => redirect("/login"),
): Promise<{ person: Person; remembered: Remembered } | null> {
	try {
		const [person, remembered] = await Promise.all([
			reads.readPerson(caller),
			reads.readMemory(caller),
		]);
		return { person, remembered };
	} catch (err) {
		if (err instanceof BackendError && err.status === 401) {
			if (err.code === ACCOUNT_ERASED) return null;
			toSignIn();
		}
		throw err;
	}
}
