import { envString } from "@platform/config";
import { defineProblemCodes } from "@platform/observability";
import {
	type KeyNamespace,
	keyNamespace,
	type SharedMemo,
	sharedMemo,
} from "@platform/redis";

/**
 * Every key this package writes sits under the product's service name, so
 * replicas of one deployment coordinate and two products on one instance do
 * not. `AGENT_KEY_PREFIX` overrides it for a test run that must sweep its own
 * keys and nothing else's.
 */
export interface AgentKeys {
	namespace: KeyNamespace;
	/** The fleet-shared memo every per-person cache here goes through. */
	memo: SharedMemo;
}

export function agentKeys(serviceName: string): AgentKeys {
	const namespace = keyNamespace(envString("AGENT_KEY_PREFIX") ?? serviceName);
	return { namespace, memo: sharedMemo(namespace) };
}

/** The refusals this package reports, as a closed list. */
export const problems = defineProblemCodes([
	"agent.turn.forbidden_thread",
	"agent.turn.duplicate",
	"agent.turn.busy",
	"agent.voice.unheard",
	"agent.voice.speech_to_speech_unconfigured",
	"agent.voice.transcriber_replaced",
	"agent.voice.personalization_trimmed",
	"agent.voice.instructions_over_cap",
	"agent.turn.rate_limited",
	"agent.turn.ownership_unavailable",
	"agent.turn.invalid",
	"agent.turn.failed",
	"agent.turn.blocked",
	"agent.erase.incomplete",
	"agent.history.service_retention",
	"agent.history.conversation_expired",
	"agent.history.picture_kept",
	"agent.memory.handover_failed",
	"agent.memory.extraction_failed",
	"agent.memory.extraction_refused",
	"agent.memory.extraction_stalled",
	"agent.memory.store_unreachable_private",
	"agent.memory.update_untracked",
	"agent.memory.erase_overdue",
	"agent.memory.erase_unfinished",
	"agent.title.failed",
] as const);
