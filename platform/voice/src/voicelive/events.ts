import { z } from "zod";

/**
 * The voice agent's protocol, as far as this deployment speaks it: the
 * events the backend sends on a Foundry voice agent's control socket, and
 * the ones it reads. The SDK's
 * `VoiceAgentClientEvent` and `VoiceAgentServerEvent` in
 * `@azure/ai-projects` 2.10.0 are the reference for every name and field;
 * the schemas are this package's, because the client is, and each one asks
 * only for the fields something here reads. Everything else an event
 * carries is kept, so a log or a later reader sees it whole.
 *
 * A message is read once, at the boundary, into one of three things: an
 * event of a type below with the fields it promises; an `unrecognized`
 * event, of a type nothing here reads (the service sends more than we use,
 * and a new type must never break a session); or a `malformed` one, of a
 * type we read that lacks what we read it for.
 */

const id = z.string().min(1);
/**
 * `previous_item_id` is absent, null, empty, or an item: the first item
 * follows nothing, and a cascaded session (the chat's model behind the voice
 * agent) says so with `""`. Empty reads as null.
 */
const previous = z
	.string()
	.nullish()
	.transform((value) => value || null);
/** Each field absent or null: the voice agent sends `"event_id": null` on every error it raised itself. */
const details = z
	.object({
		type: z.string().nullish(),
		code: z.string().nullish(),
		message: z.string().nullish(),
		param: z.string().nullish(),
		/** The client event this answers, when the service says. */
		event_id: z.string().nullish(),
	})
	.passthrough();

const item = z
	.object({
		id,
		type: z.string(),
		role: z.string().optional(),
		call_id: z.string().optional(),
		name: z.string().optional(),
		status: z.string().optional(),
	})
	.passthrough();

const response = z
	.object({
		id,
		status: z.string().optional(),
		status_details: z.unknown().optional(),
		// Null on `response.created`, as the voice agent sends it; an object on `response.done`.
		usage: z.record(z.unknown()).nullish(),
		metadata: z.record(z.unknown()).nullish(),
	})
	.passthrough();

const event = <T extends string, S extends z.ZodRawShape>(type: T, shape: S) =>
	z.object({ type: z.literal(type), ...shape }).passthrough();

/** The person's final transcript, and its failure: input transcription runs beside the response. */
export const USER_FINAL =
	"conversation.item.input_audio_transcription.completed";
export const USER_FAILED = "conversation.item.input_audio_transcription.failed";
/** The voice's audio, PCM16 at the session's rate in base64: the voice agents' name, and the GA API's. */
export const ASSISTANT_AUDIO = [
	"response.output_audio.delta",
	"response.audio.delta",
] as const;
/** The voice's final transcript: the voice agents' name, and the name agent mode and the GA API use. */
const ASSISTANT_FINALS = [
	"response.output_audio_transcript.done",
	"response.audio_transcript.done",
] as const;

const SERVER_EVENTS = [
	event("session.created", {
		session: z
			.object({
				id,
				// Seconds since the epoch on the wire; the SDK reads it as a Date.
				expires_at: z.union([z.number(), z.string()]).nullish(),
				instructions: z.string().optional(),
			})
			.passthrough(),
		conversation_id: z.string().nullish(),
	}),
	event("session.updated", { session: z.record(z.unknown()) }),
	event("error", { error: details }),
	event("warning", { warning: details }),
	event("input_audio_buffer.speech_started", {
		item_id: z.string().optional(),
	}),
	event("input_audio_buffer.speech_stopped", {
		item_id: z.string().optional(),
	}),
	event("input_audio_buffer.committed", {
		item_id: id,
		previous_item_id: previous,
	}),
	event("conversation.item.added", { item, previous_item_id: previous }),
	event("conversation.item.created", { item, previous_item_id: previous }),
	event("conversation.item.done", { item, previous_item_id: previous }),
	event(USER_FINAL, { item_id: id, transcript: z.string() }),
	event(USER_FAILED, { item_id: id, error: details.optional() }),
	event("response.output_item.added", { response_id: id, item }),
	event("response.output_item.done", { response_id: id, item }),
	event("response.created", { response }),
	event("response.done", { response }),
	...ASSISTANT_FINALS.map((type) =>
		event(type, { response_id: id, item_id: id, transcript: z.string() }),
	),
	event("response.function_call_arguments.done", {
		call_id: id,
		name: z.string().min(1),
		arguments: z.string(),
		item_id: z.string().optional(),
		response_id: z.string().optional(),
	}),
	...ASSISTANT_AUDIO.map((type) =>
		event(type, {
			response_id: z.string().optional(),
			item_id: z.string().optional(),
			delta: z.string(),
		}),
	),
] as const;

const known = z.discriminatedUnion(
	"type",
	SERVER_EVENTS as unknown as [
		(typeof SERVER_EVENTS)[number],
		...(typeof SERVER_EVENTS)[number][],
	],
);

/** An event of a type this module reads, with the fields it reads it for. */
export type KnownServerEvent = z.infer<(typeof SERVER_EVENTS)[number]>;

/** An event of a type nothing here reads, kept whole. */
export interface UnrecognizedEvent {
	type: "unrecognized";
	name: string;
	event: Record<string, unknown>;
}

/** An event of a type we read that lacks what we read it for. */
export interface MalformedEvent {
	type: "malformed";
	name: string;
	problem: string;
	event: unknown;
}

export type ServerEvent = KnownServerEvent | UnrecognizedEvent | MalformedEvent;

const READ = new Set<string>(SERVER_EVENTS.map((s) => s.shape.type.value));

/** One message off the socket, read once: never throws. */
export function readServerEvent(data: string): ServerEvent {
	let parsed: unknown;
	try {
		parsed = JSON.parse(data);
	} catch {
		return {
			type: "malformed",
			name: "",
			problem: "not JSON",
			event: data.slice(0, 200),
		};
	}
	const name =
		parsed && typeof parsed === "object" && "type" in parsed
			? String((parsed as { type: unknown }).type)
			: "";
	if (!READ.has(name)) {
		if (parsed && typeof parsed === "object" && !Array.isArray(parsed))
			return {
				type: "unrecognized",
				name,
				event: parsed as Record<string, unknown>,
			};
		return { type: "malformed", name, problem: "not an object", event: parsed };
	}
	const result = known.safeParse(parsed);
	if (result.success) return result.data;
	const [issue] = result.error.issues;
	return {
		type: "malformed",
		name,
		problem: issue ? `${issue.path.join(".")}: ${issue.message}` : "invalid",
		event: parsed,
	};
}

/** An output of a call the voice session made: a server tool's, or a stage control's, as the browser answered it. */
export interface FunctionCallOutputItem {
	type: "function_call_output";
	call_id: string;
	output: string;
}

/** A short note to the session, from the backend: what changed on the person's screen. Not stored (`store: false`). */
export interface SystemNoteItem {
	type: "message";
	role: "system";
	content: { type: "input_text"; text: string }[];
}

/**
 * A line of the thread, given to the session before the person speaks
 * (`conversation.item.create`, which the SDK says "can be used both to
 * populate a 'history' of the conversation and to add new items
 * mid-stream"): the person's words as input text, the agent's as output
 * text, each under an id of the client's.
 */
export type HistoryMessageItem =
	| {
			id: string;
			type: "message";
			role: "user";
			content: { type: "input_text"; text: string }[];
	  }
	| {
			id: string;
			type: "message";
			role: "assistant";
			content: { type: "output_text"; text: string }[];
	  };

/**
 * What the backend sends. `session` is the voice agents' session-update
 * payload (`VoiceAgentSessionUpdateConfig`), whose content the agent
 * package decides. `input_audio_buffer.append` carries the person's audio,
 * PCM16 at the session's rate, in base64.
 */
export type ClientEvent =
	| {
			type: "session.update";
			/** The client's, so the `error` that answers it can say so. */
			event_id?: string;
			session: { [field: string]: unknown };
	  }
	| { type: "input_audio_buffer.append"; audio: string }
	| {
			type: "conversation.item.create";
			event_id?: string;
			item: FunctionCallOutputItem | SystemNoteItem | HistoryMessageItem;
			previous_item_id?: string;
	  }
	| { type: "response.create" }
	/** A line of the thread taken out again, by the id we gave it. */
	| { type: "conversation.item.delete"; event_id?: string; item_id: string };
