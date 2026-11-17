import type { KeyNamespace } from "@platform/redis";
import type { TurnRefusal } from "../contract/host";
import {
	claimTurn,
	deriveTurnKey,
	type TurnClaim,
} from "../coordination/idempotency";
import { spendTurn } from "../coordination/rate-limit";
import {
	ownershipOf,
	type ThreadLookup,
	ThreadLookupError,
} from "../coordination/thread-owner";
import { problems } from "../keys";
import type { ConversationStamp, PersonCache } from "../person/caches";

/**
 * The three guards every turn passes before the model is reached, in the
 * one order: the spend bound first, because it is the cheapest and
 * holds a script off the thread lookup; ownership next, failing closed
 * when the store cannot answer; the claim last, so a refused turn never
 * holds one. A turn that opens a thread also changes when the person last
 * talked, so the cached stamps go here, at the one event that moves them.
 */
export type Admission =
	| { kind: "admitted"; claim: TurnClaim }
	| { kind: "refused"; refusal: TurnRefusal };

export interface TurnIdentity {
	resourceId: string;
	threadId: string;
	/** Only the last id is read: what makes a retry the same turn. */
	messages: readonly { id?: string }[];
	turnKey?: string;
}

export interface AdmissionDeps {
	keys: KeyNamespace;
	lookup: ThreadLookup;
	stamps: PersonCache<ConversationStamp[]>;
}

export async function admitTurn(
	deps: AdmissionDeps,
	turn: TurnIdentity,
): Promise<Admission> {
	const budget = await spendTurn(deps.keys, turn.resourceId);
	if (!budget.allowed) {
		problems.report("agent.turn.rate_limited", {
			status: 429,
			retryAfterSeconds: budget.retryAfterSeconds,
		});
		return refused({
			code: "turn.rate_limited",
			status: 429,
			retryAfterSeconds: budget.retryAfterSeconds,
		});
	}
	try {
		const ownership = await ownershipOf(
			deps.lookup,
			turn.threadId,
			turn.resourceId,
		);
		if (ownership === "theirs") {
			problems.report("agent.turn.forbidden_thread", { status: 403 });
			return refused({ code: "thread.forbidden", status: 403 });
		}
		if (ownership === "nobodys") await deps.stamps.drop(turn.resourceId);
	} catch (err) {
		if (!(err instanceof ThreadLookupError)) throw err;
		problems.report("agent.turn.ownership_unavailable", { status: 503 });
		console.error(
			"[agent] thread ownership lookup failed:",
			(err.cause as Error)?.message ?? err.message,
		);
		return refused({ code: "thread.unavailable", status: 503 });
	}
	const claim = await claimTurn(deps.keys, deriveTurnKey(turn));
	if (claim.outcome === "held") {
		problems.report("agent.turn.duplicate", { status: 409 });
		return refused({ code: "turn.duplicate", status: 409 });
	}
	return { kind: "admitted", claim };
}

function refused(refusal: TurnRefusal): Admission {
	return { kind: "refused", refusal };
}
