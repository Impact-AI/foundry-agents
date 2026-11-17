import type { LiveHistoryLine } from "@platform/agent";
import {
	type ConnectOptions,
	connectVoiceAgent,
	type SessionTarget,
	type VoiceAgentConnection,
	VoiceAgentTimeout,
} from "./client";
import type { ClientEvent, HistoryMessageItem, ServerEvent } from "./events";
import { isFatalError, isRollbackEcho } from "./refusals";

/**
 * The opening of a session, as one call: the
 * socket, the session's announcement, the person's audio settings sent
 * as their own `session.update` and read back from its echo, then the
 * thread so far given to the session as items, so the voice continues the
 * conversation the person typed. The answer is a value: what took, or what
 * the service refused and why.
 *
 * The echo is the subtle part. The service sends a `session.updated` of its
 * own right after `session.created` — the version's definition applied —
 * and nothing in an echo says which update it answers. Taking the first
 * `session.updated` after sending read the version's defaults as the
 * person's settings. So the update goes
 * only once the service's own has come (or a short wait for it has passed),
 * and the echo is the next one.
 *
 * Nothing waits on an echo that may never come for longer than its bound:
 * an update unechoed in time is an outcome, the session opens all the same,
 * and the thread is then given without waiting for acknowledgements either.
 * The voice agent echoes on both engines (the cascade's echo carries the
 * chat's reasoning effort back); Voice Live's own cascade, outside a voice
 * agent, is known to echo nothing on its control socket, which is the case
 * this guards.
 */

type SessionPayload = Extract<
	ClientEvent,
	{ type: "session.update" }
>["session"];

export type SessionUpdateOutcome =
	/** `session.updated`: the session as the service now holds it, for the log. */
	| { kind: "updated"; session: Record<string, unknown> }
	/** An `error` answering the update: the service's own code, the field it named, and its words. */
	| {
			kind: "refused";
			code: string | null;
			param?: string | null;
			message: string;
	  }
	/** Neither in time: the update was sent, and what took is not known. */
	| { kind: "unanswered"; message: string };

/**
 * The service refused the session's own settings (`refusals.ts`): it would
 * open and answer nothing, so the session is closed rather than handed to
 * the browser as ready.
 */
export class SessionSettingsRefused extends Error {
	constructor(readonly code: string) {
		super(`the service refused the session's settings (${code})`);
		this.name = "SessionSettingsRefused";
	}
}

/** How long the service's own `session.updated` is waited for before the person's update goes anyway. */
const OWN_UPDATE_WAIT_MS = 3_000;

/** Send the update and read its echo; the echo, not the request, says what took. */
function updateSession(
	connection: VoiceAgentConnection,
	session: SessionPayload,
	timeoutMs: number,
): Promise<SessionUpdateOutcome> {
	const eventId = `update_${crypto.randomUUID()}`;
	const answer = connection.next<SessionUpdateOutcome>(
		(event) => {
			if (event.type === "session.updated")
				return { kind: "updated", session: event.session };
			// An error names the event it answers when it can (the voice agent sends null); one that names another is not this one's.
			if (
				event.type === "error" &&
				(event.error.event_id == null || event.error.event_id === eventId)
			)
				return {
					kind: "refused",
					code: event.error.code ?? null,
					param: event.error.param ?? null,
					message: event.error.message ?? "the update was refused",
				};
			return undefined;
		},
		{ timeoutMs, what: "session.updated" },
	);
	sendOrAbandon(
		connection,
		{ type: "session.update", event_id: eventId, session },
		answer,
	);
	return answer;
}

/**
 * Send, and when the session has already ended — the send throws — take the
 * wait's rejection here: it would otherwise reject with nobody waiting, and
 * an unhandled rejection ends the process and every session it holds.
 */
function sendOrAbandon(
	connection: VoiceAgentConnection,
	event: ClientEvent,
	wait: Promise<unknown> | null,
): void {
	try {
		connection.send(event);
	} catch (err) {
		wait?.catch(() => {});
		throw err;
	}
}

export type HistoryOutcome =
	/** Every line created, the last one echoed by `conversation.item.created`. */
	| { kind: "given"; lines: number }
	/**
	 * Every line sent and no answer either way in time: nothing refused one,
	 * so they stand. A session whose update went unechoed is given its lines
	 * without a wait at all, since a service that echoes nothing on this
	 * socket would only make every open wait out the bound.
	 */
	| { kind: "unacknowledged"; lines: number }
	/**
	 * An `error` while the lines were being created: every line deleted
	 * again, so the session holds all of the thread or none of it. Codes
	 * only: a refusal's words can quote the line.
	 */
	| {
			kind: "refused";
			code: string | null;
			param: string | null;
			fatal: boolean;
			/** Lines asked to be deleted again: every one sent. */
			rolledBack: number;
	  };

type HistoryAnswer =
	| { kind: "given" }
	| { kind: "refused"; code: string | null; param: string | null };

/** A line of the thread as the item that carries it. */
function historyItem(line: LiveHistoryLine): HistoryMessageItem {
	return line.role === "user"
		? {
				id: line.id,
				type: "message",
				role: "user",
				content: [{ type: "input_text", text: line.text }],
			}
		: {
				id: line.id,
				type: "message",
				role: "assistant",
				content: [{ type: "output_text", text: line.text }],
			};
}

/**
 * The thread's lines, created in order at the end of the session's
 * conversation, and the echo of the last one waited for: items are created
 * in the order they are sent, so the last one's echo means every one before
 * it took. An `error` meanwhile — the voice agent names no event in its
 * errors, so the window is the attribution — says the lines did not all
 * take, and then every line is deleted again: a thread given in part is a
 * conversation with holes the voice would reason over as whole. The ids are
 * the client's, and the service handles events in the order they are sent, so the
 * deletes come after every create and remove exactly the lines that landed;
 * a line that never did answers `item_delete_invalid_item_id`, which the
 * owner does not log (`refusals.ts`). The service echoes an `output_text`
 * line as `text`, which is why only the item's id is read. Nothing is
 * created for an empty thread.
 */
export async function giveHistory(
	connection: VoiceAgentConnection,
	lines: readonly LiveHistoryLine[],
	timeoutMs: number,
): Promise<HistoryOutcome> {
	const last = lines.at(-1);
	if (!last) return { kind: "given", lines: 0 };
	const answer =
		timeoutMs > 0
			? connection.next<HistoryAnswer>(
					(event) => {
						if (
							event.type === "conversation.item.created" &&
							event.item.id === last.id
						)
							return { kind: "given" };
						if (event.type === "error" && !isRollbackEcho(event.error))
							return {
								kind: "refused",
								code: event.error.code ?? null,
								param: event.error.param ?? null,
							};
						return undefined;
					},
					{ timeoutMs, what: "conversation.item.created" },
				)
			: null;
	for (const line of lines)
		sendOrAbandon(
			connection,
			{
				type: "conversation.item.create",
				event_id: `history_${line.id}`,
				item: historyItem(line),
			},
			answer,
		);
	let answered: HistoryAnswer;
	try {
		if (!answer) return { kind: "unacknowledged", lines: lines.length };
		answered = await answer;
	} catch (err) {
		if (!(err instanceof VoiceAgentTimeout)) throw err;
		return { kind: "unacknowledged", lines: lines.length };
	}
	if (answered.kind === "given") return { kind: "given", lines: lines.length };
	for (const line of lines)
		connection.send({
			type: "conversation.item.delete",
			event_id: `history_delete_${line.id}`,
			item_id: line.id,
		});
	return {
		kind: "refused",
		code: answered.code,
		param: answered.param,
		fatal: isFatalError(answered),
		rolledBack: lines.length,
	};
}

export interface OpenedSession {
	connection: VoiceAgentConnection;
	/** What the person's update did: its echo, or why it did not take. */
	update: SessionUpdateOutcome;
	/** Whether the thread so far reached the session. */
	history: HistoryOutcome;
}

/**
 * A session opened and fitted to one person: the socket, the service's own
 * `session.updated` waited for, then the person's `session.update` and its
 * echo, then the thread so far. An update the service refused or never
 * echoed is an outcome, not a failure — the session runs on the version's
 * defaults, and the caller logs the echo — and so is a thread that did not
 * all take: the session runs without it. A refusal of the session's own
 * settings (`refusals.ts`), to the update or while the thread is given, is
 * {@link SessionSettingsRefused}: the service would answer nothing. That and
 * anything else that goes wrong closes the socket and throws.
 */
export async function openSession(input: {
	target: SessionTarget;
	connect: ConnectOptions;
	session: SessionPayload;
	/** The thread so far, oldest first; none for a new thread. */
	history?: readonly LiveHistoryLine[];
	timeouts: { updateMs: number; ownUpdateMs?: number };
}): Promise<OpenedSession> {
	// Heard from the first event, so the service's own echo is not missed while the connect resolves.
	let own = false;
	const ownUpdate = Promise.withResolvers<void>();
	const connection = await connectVoiceAgent(input.target, {
		...input.connect,
		observe: (event: ServerEvent) => {
			input.connect.observe?.(event);
			if (!own && event.type === "session.updated") {
				own = true;
				ownUpdate.resolve();
			}
		},
	});
	try {
		await Promise.race([
			ownUpdate.promise,
			Bun.sleep(input.timeouts.ownUpdateMs ?? OWN_UPDATE_WAIT_MS),
			connection.closed,
		]);
		const update = await fitted(
			connection,
			input.session,
			input.timeouts.updateMs,
		);
		if (update.kind === "refused" && isFatalError(update))
			throw new SessionSettingsRefused(update.code ?? "refused");
		const history = await giveHistory(
			connection,
			input.history ?? [],
			// A service that answered the update answers the thread's lines too; one that did not is not waited for again.
			update.kind === "unanswered" ? 0 : input.timeouts.updateMs,
		);
		if (history.kind === "refused" && history.fatal)
			throw new SessionSettingsRefused(history.code ?? "refused");
		return { connection, update, history };
	} catch (err) {
		await connection.close("the session did not open");
		throw err;
	}
}

/** The update's outcome; a session that ended meanwhile is the only failure. */
async function fitted(
	connection: VoiceAgentConnection,
	session: SessionPayload,
	timeoutMs: number,
): Promise<SessionUpdateOutcome> {
	try {
		return await updateSession(connection, session, timeoutMs);
	} catch (err) {
		if (!(err instanceof VoiceAgentTimeout)) throw err;
		return { kind: "unanswered", message: err.message };
	}
}
