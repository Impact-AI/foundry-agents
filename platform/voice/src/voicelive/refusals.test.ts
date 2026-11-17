import { expect, test } from "bun:test";
import { isFatalError, isRollbackEcho } from "./refusals";

test("an error that refuses the session's own settings ends it; a refusal of one event does not", () => {
	expect(
		isFatalError({
			code: "speech_frontend_not_available",
			message:
				"Noise reduction 'azure_deep_noise_suppression_headset' is not available for this session: upstream_vad_owned.",
		}),
	).toBe(true);
	expect(
		isFatalError({ code: "invalid_input_audio_transcription_model" }),
	).toBe(true);
	expect(
		isFatalError({
			code: "invalid_value",
			param: "session.audio.input.noise_reduction.type",
		}),
	).toBe(true);
	expect(
		isFatalError({
			code: "invalid_value",
			message: "Unknown noise_reduction type",
		}),
	).toBe(true);
	expect(
		isFatalError({
			code: "invalid_value",
			param: "session.instructions",
			message:
				"Instructions cannot be longer than 16384 tokens, you have provided 16813 tokens.",
		}),
	).toBe(true);
	// What a session may not change refuses that update alone: the session runs on its version.
	expect(
		isFatalError({
			code: "turn_detection_type_change_not_allowed",
			param: "session.turn_detection",
		}),
	).toBe(false);
	expect(
		isFatalError({
			code: "change_in_speech_frontend_not_allowed",
			param: "session.input_audio_noise_reduction",
		}),
	).toBe(false);
	// The same code on anything else is one event refused.
	expect(
		isFatalError({ code: "invalid_value", param: "item.content.0.type" }),
	).toBe(false);
	expect(
		isFatalError({ code: "conversation_already_has_active_response" }),
	).toBe(false);
	expect(isFatalError({})).toBe(false);
});

test("deleting a line that never landed is the rollback's own echo", () => {
	expect(isRollbackEcho({ code: "item_delete_invalid_item_id" })).toBe(true);
	expect(isRollbackEcho({ code: "invalid_value" })).toBe(false);
});
