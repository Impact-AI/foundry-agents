/**
 * How the service's `error` frames are read, in one place. The ones that end
 * a session are one list: everything
 * else the service says in an `error` is a refusal of one event the backend
 * sent, and the session carries on. Known from how the service behaves, not
 * documented: each of these is the service refusing the session's own
 * settings, after which it opens nothing that answers.
 *
 *   - `speech_frontend_not_available`: a noise suppression the session's turn
 *     detection has no speech front end for — the headset and personal models
 *     beside a realtime model's own `semantic_vad` ("upstream_vad_owned");
 *   - `invalid_input_audio_transcription_model`: a transcriber the model does
 *     not take;
 *   - `invalid_value` on the noise suppression: a type the service does not
 *     know, after which the session runs on the service's defaults, without
 *     the version's instructions or tools;
 *   - `invalid_value` on the instructions: rendered past the realtime
 *     model's cap ("Instructions cannot be longer than 16384 tokens"), sent
 *     as the session opens, after which the session answers without its
 *     instructions — the guardrails among them.
 *
 * What a session update may not change — the turn detection's type
 * (`turn_detection_type_change_not_allowed`) or the noise suppression's
 * speech front end (`change_in_speech_frontend_not_allowed`) — refuses that
 * update and nothing else: the session runs on its version.
 */

const FATAL_CODES: ReadonlySet<string> = new Set([
	"speech_frontend_not_available",
	"invalid_input_audio_transcription_model",
]);

/** A code that is fatal only on the noise suppression or the instructions. */
const FATAL_ON_FIELD = "invalid_value";

/** Where a refusal names one of those: its `param`, or its words when it names none. */
const FIELD = /noise_reduction|noise_suppression|instructions/i;

/** The parts of an `error` frame the decision reads: its code, and what it names. */
export interface ErrorFrame {
	code?: string | null;
	param?: string | null;
	message?: string | null;
}

/** Whether an `error` frame ends the session rather than refusing one event. */
export function isFatalError(error: ErrorFrame): boolean {
	const code = error.code ?? "";
	if (FATAL_CODES.has(code)) return true;
	return (
		code === FATAL_ON_FIELD &&
		FIELD.test(`${error.param ?? ""} ${error.message ?? ""}`)
	);
}

/**
 * The answer to deleting an item the conversation does not hold: what the
 * thread's rollback is told for each line that never landed
 * (`giveHistory`), and nothing anybody needs to hear about.
 */
const NO_SUCH_ITEM = "item_delete_invalid_item_id";

/** Whether an `error` frame is only the rollback deleting a line that never landed. */
export function isRollbackEcho(error: ErrorFrame): boolean {
	return error.code === NO_SUCH_ITEM;
}
