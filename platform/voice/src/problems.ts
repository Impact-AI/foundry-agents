import { defineProblemCodes } from "@platform/observability";

/** Every refusal and fault of live voice, as a closed list a query can group by. */
export const voiceProblems = defineProblemCodes([
	"voice.live.unconfigured",
	"voice.live.busy",
	"voice.live.capacity",
	"voice.live.provider_capacity",
	"voice.live.no_seconds",
	"voice.live.unavailable",
	"voice.live.handshake_failed",
	"voice.live.not_recorded",
	"voice.live.update_refused",
	"voice.live.history_refused",
	"voice.live.stage_timeout",
	"voice.live.max_steps",
	"voice.live.blocked",
	"voice.live.response_failed",
	"voice.live.session_refused",
	"voice.live.input_refused",
	"voice.live.orphaned",
	"voice.live.unsettled",
	"voice.renew.no_seconds",
] as const);
