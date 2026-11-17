import { spendCredits } from "@platform/metering";
import type { KeyNamespace } from "@platform/redis";
import { agentSettings } from "../settings";

/**
 * A turn is a model completion, the expensive thing this service does, and
 * this bounds how fast one resource may spend it. The bucket is keyed on
 * the verified scope and lives in Redis, because a replica-local counter
 * multiplies the budget by the replica count. A cost bound, so it fails
 * open: the authorization in front of every caller fails closed on its own.
 */
export type TurnBudget =
	| { allowed: true }
	| { allowed: false; retryAfterSeconds: number };

export async function spendTurn(
	keys: KeyNamespace,
	resourceId: string,
): Promise<TurnBudget> {
	const { turns } = await agentSettings();
	const verdict = await spendCredits(keys.tenantKey(resourceId, "turns"), {
		capacity: turns.burst,
		refillPerMinute: turns.refillPerMinute,
	});
	return verdict.allowed
		? { allowed: true }
		: {
				allowed: false,
				retryAfterSeconds: Math.max(1, verdict.retryAfterSeconds),
			};
}
