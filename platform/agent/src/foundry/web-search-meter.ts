import {
	getLimits,
	isUnmetered,
	keys,
	meterCall,
	peekCredits,
	usageSubject,
} from "@platform/metering";
import type { CallerIdentity } from "../turn/scope";

/**
 * Web search runs inside the response (the service's tool), so nothing of
 * the backend's stands in front of one search to refuse it, and the turn's `chat`
 * credit does not bound how many a response runs. The `toolSearch` bucket
 * bounds them all the same, one turn behind: every search a turn ran is
 * charged after it, and a turn starts without web search while the
 * account's bucket is empty. A turn nobody verified has no account to
 * charge and gets none.
 */
const SURFACE = "toolSearch";

/** Whether there is an account to charge a search to: never for a turn nobody verified. */
export function webSearchAccountable(caller: CallerIdentity | null): boolean {
	return Boolean(caller && usageSubject(caller.oid));
}

export async function webSearchAvailable(
	caller: CallerIdentity | null,
): Promise<boolean> {
	const subject = usageSubject(caller?.oid);
	if (!caller || !subject) return false;
	if (isUnmetered(caller.tier)) return true;
	const { burst, refillPerMinute } = (await getLimits()).toolSearch;
	const verdict = await peekCredits(keys.burst(subject, SURFACE), {
		capacity: burst,
		refillPerMinute,
	});
	return verdict.allowed;
}

/** One credit a search, until the bucket refuses: what is left over is not owed. */
export async function chargeWebSearches(
	caller: CallerIdentity | null,
	searches: number,
): Promise<void> {
	const subject = usageSubject(caller?.oid);
	if (!caller || !subject) return;
	for (let i = 0; i < searches; i++)
		if (!(await meterCall(subject, SURFACE, caller.tier)).ok) return;
}
