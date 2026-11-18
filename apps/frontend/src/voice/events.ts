import { z } from "zod";
import { SESSION_ENDINGS, type VoiceEvent } from "./machine";

/**
 * What the live session's socket says, as text, read once at the boundary:
 * the session's answer to `start` — `ready`, or `refused` in the shape a
 * route's refusal has — then what the pane draws, never the voice agent's
 * protocol beneath. A message of a shape this does not know is dropped, so
 * a newer backend never breaks an older pane.
 */

const event = z.discriminatedUnion("type", [
	z.object({
		type: z.literal("speech"),
		state: z.enum(["started", "stopped"]),
	}),
	z.object({
		type: z.literal("response"),
		state: z.enum(["started", "done"]),
	}),
	z.object({
		type: z.literal("line"),
		role: z.enum(["user", "assistant"]),
		text: z.string(),
	}),
	/** The documents the answer just spoken drew on, each read by `readSources`. */
	z.object({ type: z.literal("sources"), sources: z.array(z.unknown()) }),
	z.object({
		type: z.literal("stage-call"),
		callId: z.string().min(1),
		name: z.string().min(1),
		args: z.record(z.string(), z.unknown()),
	}),
	z.object({ type: z.literal("stage-call-closed"), callId: z.string() }),
	z.object({ type: z.literal("error"), code: z.string() }),
	z.object({ type: z.literal("ending"), reason: z.enum(SESSION_ENDINGS) }),
	z.object({
		type: z.literal("ended"),
		reason: z.enum(SESSION_ENDINGS),
		written: z.number(),
	}),
]);

export type LiveEvent = z.infer<typeof event>;

const answer = z.discriminatedUnion("type", [
	z.object({
		type: z.literal("ready"),
		session: z.object({
			id: z.string().min(1),
			maxSessionSeconds: z.number(),
			idleSeconds: z.number(),
		}),
		language: z.string(),
		audio: z.object({ sampleRate: z.number().positive() }),
	}),
	z.object({
		type: z.literal("refused"),
		status: z.number(),
		body: z.unknown(),
	}),
]);

/** The session's answer to `start`. */
export type SessionAnswer = z.infer<typeof answer>;

/** One text message, read; null for anything that is not one this pane knows. */
export function readServerMessage(
	data: string,
): SessionAnswer | LiveEvent | null {
	try {
		const json: unknown = JSON.parse(data);
		const known = answer.safeParse(json);
		if (known.success) return known.data;
		const live = event.safeParse(json);
		return live.success ? live.data : null;
	} catch {
		return null;
	}
}

/** What an event means to the pane's machine; null for one it does not draw. */
export function machineEvent(live: LiveEvent): VoiceEvent | null {
	switch (live.type) {
		case "speech":
			return {
				type: live.state === "started" ? "speech_started" : "speech_stopped",
			};
		case "response":
			return {
				type: live.state === "started" ? "response_started" : "response_done",
			};
		case "error":
			switch (live.code) {
				case "turn.blocked":
					return { type: "blocked" };
				case "turn.unanswered":
					return { type: "unanswered" };
				case "text.too_fast":
					return { type: "typed_refused", why: "fast" };
				case "text.session_full":
					return { type: "typed_refused", why: "full" };
				default:
					return null;
			}
		case "ending":
		case "ended":
			return { type: "ended", reason: live.reason };
		default:
			return null;
	}
}
