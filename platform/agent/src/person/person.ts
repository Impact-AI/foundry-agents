import { getAccount } from "@platform/identity";
import { EMPTY_DOSSIER } from "@platform/prompt";
import type { PersonCache, PersonContext } from "./caches";

/**
 * Who the agent is talking to and what they wrote about themselves, from
 * the account the resource id is. Never throws: a row that cannot be read
 * costs the tailoring, not the turn. Only an origin answer is cached,
 * "nothing known" included — most people write no dossier, and declining
 * to cache that would leave most turns paying the query.
 */
const NOBODY: PersonContext = {
	identity: { name: null },
	dossier: EMPTY_DOSSIER,
};

export async function readPerson(
	resourceId: string | null,
	cache: PersonCache<PersonContext>,
): Promise<PersonContext> {
	if (!resourceId) return NOBODY;
	try {
		const cached = await cache.read(resourceId);
		if (cached) return cached;
		const account = await getAccount(resourceId);
		const person: PersonContext = account
			? {
					identity: { name: account.name },
					dossier: { about: account.about, preferences: account.preferences },
				}
			: NOBODY;
		await cache.write(resourceId, person);
		return person;
	} catch (err) {
		console.error(
			"[person] read failed, continuing without it:",
			(err as Error).message,
		);
		return NOBODY;
	}
}
