import {
	envInt,
	envString,
	processSingleton,
	withDeadline,
} from "@platform/config";
import {
	claimOnce,
	extendClaim,
	type KeyNamespace,
	releaseClaim,
} from "@platform/redis";

/**
 * One turn, one answer, however many replicas: the first to see a turn
 * claims it and runs, a retry that lands elsewhere meets the claim. Fails
 * open by design — a Redis blink must never become a chat outage — and the
 * claim is held only on a turn that finished: a turn that failed or was
 * abandoned releases it, so the retry the person is about to make meets an
 * answer rather than a refusal. A turn can run for longer than the claim
 * lives, so the run keeps it alive while it works (`keep`): a retry that
 * arrives mid-turn meets the claim however long the turn has been going.
 */
export type ClaimOutcome = "claimed" | "held" | "unavailable";

export interface TurnClaim {
	outcome: ClaimOutcome;
	/** Give the turn back, for a run that did not finish. Never throws. */
	release(): Promise<void>;
	/** Hold the claim for as long as the run takes; the answer stops the holding. Never throws. */
	keep(): () => void;
}

const NOTHING_TO_RELEASE = async () => {};
const NOTHING_TO_KEEP = () => () => {};

/** Minted once per process, on the first claim; a retry recognises its own replica's claim and nothing else's. */
function replica(): string {
	return processSingleton(
		"agent:replica-name",
		() => `${envString("HOSTNAME") ?? "agent"}-${process.pid}`,
	);
}

/**
 * The last message of any role, not the last user message: a continuation
 * carrying a tool result back is a new step of the same user turn, and
 * keying on the user message refused it as a duplicate. A retry resends the
 * same array, so its last id is unchanged and still deduplicates. Under the
 * resource and the thread either way: an explicit key is the client's to
 * choose, and a key chosen to match somebody else's must refuse nobody else.
 */
export function deriveTurnKey(input: {
	resourceId: string;
	threadId: string;
	messages: readonly { id?: string }[];
	turnKey?: string;
}): string | null {
	const key = input.turnKey || input.messages.at(-1)?.id;
	if (!key) return null;
	return `${input.resourceId}:${input.threadId}:${key}`;
}

/**
 * How long to wait on the claim before answering uncoordinated. A rejected
 * command is not the only failure: during a managed failover commands queue
 * rather than reject, and every turn would block here before its first
 * token.
 */
function claimDeadlineMs(): number {
	return envInt("TURN_CLAIM_DEADLINE_MS", 300, { min: 1 });
}

function claimTtlMs(): number {
	return envInt("TURN_CLAIM_TTL_SECONDS", 120, { min: 1 }) * 1000;
}

export async function claimTurn(
	keys: KeyNamespace,
	turnKey: string | null,
): Promise<TurnClaim> {
	if (!turnKey)
		return {
			outcome: "unavailable",
			release: NOTHING_TO_RELEASE,
			keep: NOTHING_TO_KEEP,
		};
	const key = keys.key("turn", turnKey);
	let outcome: ClaimOutcome;
	try {
		const claim = await withDeadline(
			() => claimOnce(key, replica(), claimTtlMs()),
			claimDeadlineMs(),
			() => new Error("claim timed out"),
		);
		outcome = claim.outcome;
	} catch {
		console.warn(
			`[agent] turn claim did not answer within ${claimDeadlineMs()}ms — answering uncoordinated`,
		);
		outcome = "unavailable";
	}
	return {
		outcome,
		release:
			outcome === "claimed"
				? async () => {
						await releaseClaim(key, replica()).catch(() => {});
					}
				: NOTHING_TO_RELEASE,
		keep:
			outcome === "claimed"
				? () => {
						// Three chances to renew within one life of the claim.
						const timer = setInterval(
							() => {
								void extendClaim(key, replica(), claimTtlMs()).catch(() => {});
							},
							Math.max(Math.floor(claimTtlMs() / 3), 1),
						);
						timer.unref?.();
						return () => clearInterval(timer);
					}
				: NOTHING_TO_KEEP,
	};
}
