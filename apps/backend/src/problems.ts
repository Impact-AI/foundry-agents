import { defineProblemCodes } from "@platform/observability";

/** Every refusal this app answers on its own, as a closed list; the packages' refusals are reported by the packages. */
export const problems = defineProblemCodes([
	"backend.caller.unauthenticated",
	"backend.caller.forbidden",
	"backend.account.standing",
	"backend.chat.rate_limited",
	"backend.knowledge.refused",
	"backend.media.refused",
	"backend.erase.incomplete",
	"backend.export.incomplete",
	"backend.voice_tuning.refused",
	"backend.voice_tuning.stale",
] as const);
