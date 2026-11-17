/**
 * A Foundry voice agent's session socket, stood in for at its protocol
 * boundary on `Bun.serve` port 0. It is
 * strict about what the backend must get right and refuses the upgrade,
 * logging why, on any of: a path for another agent, `api-version` not
 * `v1`, a version it was not told of, `store` other than `false`, a
 * transport other than `websocket`, no `agent_session_id`, no bearer, no
 * preview opt-in, and structured inputs that do not fit the version's
 * declared ones (a required one missing, one undeclared, a value outside
 * its list).
 *
 * Once open it behaves as the service does: it
 * announces the session, sends a `session.updated` of its own straight
 * after — the version applied, which is not the answer to anybody's update
 * — and then answers each `session.update` with the session as it now holds
 * it. It counts the audio the backend appends.
 *
 * Turns are played when a test says, or on their own once the session has
 * its update and its first audio (`autoplay`), as the service would after
 * the person spoke. Each announces its items with the item they follow, so
 * the chain the backend orders by is the service's, speaks its answer as
 * audio deltas, and can do what makes a session hard to relay or write
 * down: a person's final that arrives after the answer's, a transcription
 * that fails, tool calls that wait for the backend's outputs and then for
 * its `response.create`, an answer the person speaks over (speech started
 * mid-answer and the response cancelled, its item left whole), an answer
 * the filter stops, a follow-up after the calls that fails with nothing
 * said, and `response.done` with usage. A session can be made to expire,
 * and is then closed by the service; its update, or one line of the thread,
 * can be refused as the service refuses them; and a test can send any event
 * on the open session (`emit`).
 *
 * Written from the SDK's event types and the events the service sends: it proves
 * the backend's logic, not the service.
 *
 * With `voiceLive` it stands in for the Voice Live API itself instead, on
 * a model it hosts: the upgrade is then refused for any path but
 * `/voice-live/realtime`, an `api-version` other than the client's, another
 * model, no bearer, or a preview opt-in or structured inputs sent at all —
 * nothing of a voice agent reaches it. The session behaves the same.
 */

import { VOICE_LIVE_API_VERSION } from "../client";

type Json = Record<string, unknown>;

export interface DeclaredInput {
	required: boolean;
	/** The values the version's schema allows, when it lists them. */
	enum?: readonly string[];
}

export interface FakeVoiceAgentOptions {
	agent: string;
	/** The versions the agent has: a session may pin only one of these. A function for versions made elsewhere (a stand-in Foundry's). */
	versions: readonly string[] | ((version: string) => boolean);
	/** Turns played on their own once the session has its update and its first audio. For a stand-in with nobody to say `play`. */
	autoplay?: readonly FakeTurn[];
	/** The structured inputs the version declares. */
	inputs: Readonly<Record<string, DeclaredInput>>;
	/** Stand in for the Voice Live API on this model in place of the voice agent: `agent`, `versions` and `inputs` are then not read. */
	voiceLive?: { model: string };
	/** Answer the upgrade, then send this error and close, before any session. */
	failSession?: { code: string; message: string };
	/** Open the socket and never announce the session. */
	silent?: boolean;
	/** The session's `expires_at`, this far ahead; the service closes it then. */
	expiresInMs?: number;
	/** Take no `session.update`: echo the session as the version made it. */
	ignoreUpdates?: boolean;
	/** Bytes of audio each answer is spoken as, in deltas of at most 4800 (100 ms at 24 kHz). */
	answerAudioBytes?: number;
	/** Answer the person's `session.update` with this error, as the service refuses settings it cannot run. */
	refuseUpdate?: { code: string; message: string; param?: string };
	/** Refuse the thread's line at this index (from 0) as the service refuses an item, and create the rest. */
	refuseHistoryLine?: number;
	/** Echo nothing on the socket: no `session.updated` of its own or for an update, no item acknowledged. */
	echoNothing?: boolean;
	/** An error right after the session is announced, as the service refuses a version's own settings or rendered instructions. */
	refuseOnOpen?: { code: string; message: string; param?: string };
}

/** One turn as the service would play it after the person stopped speaking. */
export interface FakeTurn {
	/** What the person said, or why the transcription failed. */
	heard: string | { failed: string };
	/** Deliver the person's final after the answer's: input transcription is asynchronous. */
	heardLate?: boolean;
	/** Tools the voice calls before it answers; each waits for the backend's output, then the response waits for `response.create`. */
	calls?: readonly { name: string; arguments: Json }[];
	answer: string;
	/** The person speaks over the answer: the response is cancelled, its item left whole. */
	bargeIn?: boolean;
	/** The content filter stops the answer. */
	filtered?: boolean;
	/** The response after the calls fails with nothing said, this many times, each waiting for the next `response.create`. */
	failFollowUp?: { times: number; details?: Json };
}

interface UpgradeRequest {
	url: URL;
	headers: Headers;
}

interface Connection {
	/** The session's newest item: what the next one follows. */
	last: string | null;
	turn: number;
	/** Whether `session.created` has gone. */
	announced: boolean;
	/** Whether a `session.update` has been taken. */
	updated: boolean;
	/** Bytes of the person's audio appended, decoded. */
	audioBytes: number;
	/** Whether the autoplayed turns have begun. */
	played: boolean;
	/** Messages the backend added: the thread's lines among them. */
	items: Set<string>;
	/** Messages added so far, for {@link FakeVoiceAgentOptions.refuseHistoryLine}. */
	messages: number;
}

type Socket = Bun.ServerWebSocket<Connection>;

const PREVIEW = "VoiceAgents=V1Preview";
const OUTPUT_WAIT_MS = 5_000;
const DELTA_BYTES = 4_800;

export function fakeVoiceAgent(options: FakeVoiceAgentOptions) {
	const upgrades: UpgradeRequest[] = [];
	const refusals: { status: number; why: string }[] = [];
	/** Every client event but the audio, in order. */
	const received: Json[] = [];
	const open = new Set<Socket>();
	const waiting = new Set<{ match(e: Json): boolean; settle(): void }>();
	let sessions = 0;
	let appended = 0;

	function refuse(status: number, why: string): Response {
		refusals.push({ status, why });
		return Response.json({ error: { message: why } }, { status });
	}

	/** Why the upgrade is refused, or null to accept it. */
	function check(url: URL, headers: Headers): [number, string] | null {
		if (options.voiceLive) return checkVoiceLive(url, headers);
		const path = `/agents/${options.agent}/endpoint/protocols/voice`;
		if (!url.pathname.endsWith(path)) return [404, "no such agent"];
		const query = url.searchParams;
		if (query.get("api-version") !== "v1") return [400, "api-version=v1"];
		const version = query.get("x-agent-version-override") ?? "";
		if (
			typeof options.versions === "function"
				? !options.versions(version)
				: !options.versions.includes(version)
		)
			return [404, "no such version"];
		if (query.get("store") !== "false") return [400, "store must be false"];
		if (query.get("transport") !== "websocket") return [400, "transport"];
		if (!query.get("agent_session_id")) return [400, "agent_session_id"];
		for (const header of ["structured_input", "structured_inputs"])
			if (query.has(header)) return [400, "structured inputs in the URL"];
		if (!/^Bearer \S+$/.test(headers.get("authorization") ?? ""))
			return [401, "a bearer token"];
		if (headers.get("foundry-features") !== PREVIEW)
			return [403, `foundry-features ${PREVIEW}`];
		return checkInputs(headers.get("x-ms-voice-structured-inputs"));
	}

	function checkVoiceLive(url: URL, headers: Headers): [number, string] | null {
		if (url.pathname !== "/voice-live/realtime") return [404, "no such route"];
		const query = url.searchParams;
		if (query.get("api-version") !== VOICE_LIVE_API_VERSION)
			return [400, `api-version=${VOICE_LIVE_API_VERSION}`];
		if (query.get("model") !== options.voiceLive?.model)
			return [400, "no such model"];
		if (!/^Bearer \S+$/.test(headers.get("authorization") ?? ""))
			return [401, "a bearer token"];
		if (headers.has("foundry-features"))
			return [400, "a preview opt-in on Voice Live"];
		if (headers.has("x-ms-voice-structured-inputs"))
			return [400, "structured inputs on Voice Live"];
		return null;
	}

	function checkInputs(header: string | null): [number, string] | null {
		let inputs: unknown;
		try {
			inputs = JSON.parse(header ?? "");
		} catch {
			return [400, "structured inputs are JSON"];
		}
		if (!inputs || typeof inputs !== "object" || Array.isArray(inputs))
			return [400, "structured inputs are an object"];
		const given = inputs as Json;
		for (const [name, value] of Object.entries(given)) {
			const declared = options.inputs[name];
			if (!declared) return [400, `undeclared input ${name}`];
			if (typeof value !== "string") return [400, `input ${name} is a string`];
			if (declared.enum && !declared.enum.includes(value))
				return [400, `input ${name} is one of ${declared.enum.join(", ")}`];
		}
		for (const [name, declared] of Object.entries(options.inputs))
			if (declared.required && !(name in given))
				return [400, `required input ${name}`];
		return null;
	}

	const ECHOES = new Set(["session.updated", "conversation.item.created"]);
	const emit = (ws: Socket, event: Json): void => {
		if (ws.readyState !== 1) return;
		if (options.echoNothing && ECHOES.has(String(event.type))) return;
		ws.send(
			JSON.stringify({ event_id: `evt_${crypto.randomUUID()}`, ...event }),
		);
	};

	/** Announce an item after the session's newest, and make it the newest. */
	function place(ws: Socket, item: Json): void {
		emit(ws, {
			type: "conversation.item.added",
			previous_item_id: ws.data.last,
			item,
		});
		ws.data.last = String(item.id);
	}

	function waitFor(match: (e: Json) => boolean, what: string): Promise<void> {
		return new Promise((resolve, reject) => {
			const timer = setTimeout(() => {
				waiting.delete(waiter);
				reject(new Error(`no ${what}`));
			}, OUTPUT_WAIT_MS);
			const waiter = {
				match,
				settle: () => {
					clearTimeout(timer);
					resolve();
				},
			};
			waiting.add(waiter);
		});
	}

	/** A response the voice speaks: its item, its audio, its transcript, its end. */
	function speak(
		ws: Socket,
		id: string,
		transcript: string,
		end: { status?: string; details?: Json; bargeIn?: boolean } = {},
	): void {
		const item = `item_${id}`;
		emit(ws, {
			type: "response.created",
			// As the service sends it: no usage yet, and null rather than absent.
			response: {
				id,
				object: "realtime.response",
				status: "in_progress",
				usage: null,
			},
		});
		place(ws, { id: item, type: "message", role: "assistant" });
		const bytes = options.answerAudioBytes ?? DELTA_BYTES;
		for (let sent = 0; sent < bytes; sent += DELTA_BYTES)
			emit(ws, {
				type: "response.output_audio.delta",
				response_id: id,
				item_id: item,
				output_index: 0,
				content_index: 0,
				delta: Buffer.alloc(Math.min(DELTA_BYTES, bytes - sent), 1).toString(
					"base64",
				),
			});
		if (end.bargeIn)
			emit(ws, { type: "input_audio_buffer.speech_started", item_id: "next" });
		// The transcript is whole even when the answer was spoken over or stopped.
		emit(ws, {
			type: "response.output_audio_transcript.done",
			response_id: id,
			item_id: item,
			output_index: 0,
			content_index: 0,
			transcript,
		});
		emit(ws, {
			type: "response.done",
			response: {
				id,
				status: end.bargeIn ? "cancelled" : (end.status ?? "completed"),
				...(end.details ? { status_details: end.details } : {}),
				usage: { total_tokens: 30, input_tokens: 20, output_tokens: 10 },
			},
		});
	}

	function hear(ws: Socket, itemId: string, heard: FakeTurn["heard"]): void {
		emit(
			ws,
			typeof heard === "string"
				? {
						type: "conversation.item.input_audio_transcription.completed",
						item_id: itemId,
						content_index: 0,
						transcript: heard,
					}
				: {
						type: "conversation.item.input_audio_transcription.failed",
						item_id: itemId,
						content_index: 0,
						error: { type: "transcription_error", message: heard.failed },
					},
		);
	}

	/** The voice's calls, in one response: each placed, each waited on, then the backend's `response.create`. */
	async function call(
		ws: Socket,
		n: number,
		calls: NonNullable<FakeTurn["calls"]>,
	): Promise<void> {
		const response = `resp_${n}_calls`;
		emit(ws, {
			type: "response.created",
			response: { id: response, object: "realtime.response", usage: null },
		});
		const answered: Promise<void>[] = [];
		for (const [i, { name, arguments: args }] of calls.entries()) {
			const callId = `call_${n}_${i}`;
			answered.push(
				waitFor(
					(e) =>
						e.type === "conversation.item.create" &&
						(e.item as Json | undefined)?.call_id === callId,
					`output for ${callId}`,
				),
			);
			place(ws, {
				id: `fc_${n}_${i}`,
				type: "function_call",
				call_id: callId,
				name,
			});
			emit(ws, {
				type: "response.function_call_arguments.done",
				response_id: response,
				item_id: `fc_${n}_${i}`,
				output_index: i,
				call_id: callId,
				name,
				arguments: JSON.stringify(args),
			});
		}
		const created = waitFor(
			(e) => e.type === "response.create",
			"response.create",
		);
		emit(ws, {
			type: "response.done",
			response: { id: response, status: "completed" },
		});
		await Promise.all(answered);
		for (const [i] of calls.entries())
			place(ws, {
				id: `fco_${n}_${i}`,
				type: "function_call_output",
				call_id: `call_${n}_${i}`,
			});
		await created;
	}

	async function play(ws: Socket, turn: FakeTurn): Promise<void> {
		const n = ++ws.data.turn;
		const said = `in_${n}`;
		emit(ws, { type: "input_audio_buffer.speech_started", item_id: said });
		emit(ws, { type: "input_audio_buffer.speech_stopped", item_id: said });
		emit(ws, {
			type: "input_audio_buffer.committed",
			previous_item_id: ws.data.last,
			item_id: said,
		});
		place(ws, { id: said, type: "message", role: "user" });
		if (!turn.heardLate) hear(ws, said, turn.heard);
		if (turn.calls?.length) await call(ws, n, turn.calls);
		for (let i = 0; i < (turn.failFollowUp?.times ?? 0); i++) {
			const id = `resp_${n}_failed_${i}`;
			const asked = waitFor(
				(e) => e.type === "response.create",
				"response.create after a failure",
			);
			emit(ws, {
				type: "response.created",
				response: { id, object: "realtime.response", usage: null },
			});
			emit(ws, {
				type: "response.done",
				response: {
					id,
					status: "failed",
					...(turn.failFollowUp?.details
						? { status_details: turn.failFollowUp.details }
						: {}),
					output: [],
				},
			});
			await asked;
		}
		speak(ws, `resp_${n}`, turn.answer, {
			bargeIn: turn.bargeIn,
			...(turn.filtered
				? {
						status: "incomplete",
						details: { type: "incomplete", reason: "content_filter" },
					}
				: {}),
		});
		if (turn.heardLate) hear(ws, said, turn.heard);
	}

	/** The session as the version made it: what the service's own `session.updated` says. */
	const versionSession = (): Json => ({
		type: "realtime",
		object: "realtime.session",
		audio: {
			input: { transcription: { model: "fake-transcribe" } },
			output: { voice: "the-version's-voice" },
		},
	});

	function answer(ws: Socket, event: Json): void {
		if (event.type === "session.update") {
			const session = event.session as Json | undefined;
			emit(
				ws,
				options.refuseUpdate
					? {
							type: "error",
							error: {
								type: "invalid_request_error",
								param: null,
								...options.refuseUpdate,
								event_id: null,
							},
						}
					: // Voice Live on a model it hosts takes the flat shape, which names no type; a voice agent's update must.
						!options.voiceLive && session?.type !== "realtime"
						? {
								type: "error",
								error: {
									type: "invalid_request_error",
									code: "invalid_value",
									message: "session.type is realtime",
									param: "session.type",
									// As the voice agent sends it: null, never the update's own id.
									event_id: null,
								},
							}
						: {
								type: "session.updated",
								session: options.ignoreUpdates
									? versionSession()
									: { ...session, object: "realtime.session" },
							},
			);
			ws.data.updated = true;
			autoplay(ws);
		} else if (
			event.type === "conversation.item.create" &&
			(event.item as Json | undefined)?.type === "message"
		) {
			created(ws, event.item as Json);
		} else if (event.type === "conversation.item.delete") {
			const id = String(event.item_id ?? "");
			emit(
				ws,
				ws.data.items.delete(id)
					? { type: "conversation.item.deleted", item_id: id }
					: {
							type: "error",
							error: {
								type: "invalid_request_error",
								code: "item_delete_invalid_item_id",
								message: `no item ${id}`,
								param: "item_id",
								event_id: null,
							},
						},
			);
		} else if (event.type === "input_audio_buffer.append") {
			const bytes = Buffer.from(String(event.audio ?? ""), "base64").length;
			ws.data.audioBytes += bytes;
			appended += bytes;
			autoplay(ws);
		}
	}

	/**
	 * A message the backend added, as the service echoes one: the
	 * person's words as `input_text`, the voice's as `output_text`, under the
	 * id the backend gave it; anything else is refused with the service's
	 * null `event_id`.
	 */
	function created(ws: Socket, item: Json): void {
		const parts = (Array.isArray(item.content) ? item.content : []) as Json[];
		if (
			item.role !== "system" &&
			ws.data.messages++ === options.refuseHistoryLine
		) {
			emit(ws, {
				type: "error",
				error: {
					type: "invalid_request_error",
					code: "invalid_value",
					message: "the line was refused",
					param: "item.content.0.type",
					event_id: null,
				},
			});
			return;
		}
		const kind = { user: "input_text", assistant: "output_text" }[
			String(item.role)
		];
		if (
			kind &&
			parts.length > 0 &&
			parts.every((part) => part.type === kind && typeof part.text === "string")
		) {
			const id =
				typeof item.id === "string" ? item.id : `item_${crypto.randomUUID()}`;
			emit(ws, {
				type: "conversation.item.created",
				previous_item_id: ws.data.last,
				item: { ...item, id, status: "completed", object: "realtime.item" },
			});
			ws.data.last = id;
			ws.data.items.add(id);
			return;
		}
		if (item.role === "system") return;
		emit(ws, {
			type: "error",
			error: {
				type: "invalid_request_error",
				code: "invalid_value",
				message: `a ${String(item.role)} message's content is ${kind ?? "not accepted"}`,
				param: "item.content",
				event_id: null,
			},
		});
	}

	/** `session.created` and the service's own `session.updated`, once per session. */
	function announce(ws: Socket): void {
		if (ws.data.announced || ws.readyState !== 1 || options.silent) return;
		ws.data.announced = true;
		const id = `sess_${++sessions}`;
		const expiresAt = options.expiresInMs
			? Math.floor((Date.now() + options.expiresInMs) / 1000)
			: undefined;
		emit(ws, {
			type: "session.created",
			conversation_id: `voiceconv_${sessions}`,
			session: {
				type: "realtime",
				object: "realtime.session",
				id,
				model: "fake",
				...(expiresAt ? { expires_at: expiresAt } : {}),
			},
		});
		emit(ws, { type: "session.updated", session: versionSession() });
		if (options.refuseOnOpen)
			emit(ws, {
				type: "error",
				error: {
					type: "invalid_request_error",
					param: null,
					...options.refuseOnOpen,
					event_id: null,
				},
			});
		if (expiresAt)
			setTimeout(
				() => ws.readyState === 1 && ws.close(1000, "session expired"),
				Math.max(expiresAt * 1000 - Date.now(), 0),
			);
	}

	/** The scripted turns, once the session is fitted and the person's audio has begun. */
	function autoplay(ws: Socket): void {
		const { data } = ws;
		if (!options.autoplay?.length || data.played) return;
		if (!data.updated || data.audioBytes === 0) return;
		data.played = true;
		void (async () => {
			for (const turn of options.autoplay ?? []) {
				if (ws.readyState !== 1) return;
				await play(ws, turn).catch(() => {});
			}
		})();
	}

	const server = Bun.serve({
		port: 0,
		fetch(req, srv) {
			const url = new URL(req.url);
			const refused = check(url, req.headers);
			if (refused) return refuse(...refused);
			upgrades.push({ url, headers: req.headers });
			if (
				srv.upgrade(req, {
					data: {
						last: null,
						turn: 0,
						announced: false,
						updated: false,
						audioBytes: 0,
						played: false,
						items: new Set<string>(),
						messages: 0,
					},
					headers: { "Sec-WebSocket-Protocol": "realtime" },
				})
			)
				return;
			return refuse(426, "a WebSocket upgrade");
		},
		websocket: {
			data: {} as Connection,
			open(ws) {
				open.add(ws);
				if (options.failSession) {
					emit(ws, {
						type: "error",
						error: { type: "invalid_request_error", ...options.failSession },
					});
					ws.close(1008, options.failSession.code);
					return;
				}
				announce(ws);
			},
			message(ws, raw) {
				const event = JSON.parse(String(raw)) as Json;
				if (event.type !== "input_audio_buffer.append") received.push(event);
				for (const waiter of [...waiting])
					if (waiter.match(event)) {
						waiting.delete(waiter);
						waiter.settle();
					}
				answer(ws, event);
			},
			close(ws) {
				open.delete(ws);
			},
		},
	});

	/** The newest session still open: the one a test plays to. */
	const current = (): Socket => {
		const ws = [...open].at(-1);
		if (!ws) throw new Error("no voice session is open");
		return ws;
	};

	return {
		/** A project endpoint whose voice socket is this server. */
		endpoint: `http://127.0.0.1:${server.port}/api/projects/fake`,
		upgrades,
		refusals,
		received,
		/** Bytes of the person's audio appended, decoded, over every session. */
		appended: () => appended,
		/** Sessions open now. */
		openSessions: () => open.size,
		/** Play one turn on the newest open session; resolves once it has all been sent. */
		play: (turn: FakeTurn) => play(current(), turn),
		/** Any event, on the newest open session, as the service would send it. */
		emit: (event: Json) => emit(current(), event),
		/** The messages the newest open session holds that the backend added, by id. */
		items: () => [...current().data.items],
		/** Close the newest session from the service's side. */
		hangUp(code: number, reason: string): void {
			current().close(code, reason);
		},
		/** Drop the newest session with no close frame. */
		drop(): void {
			current().terminate();
		},
		stop: () => server.stop(true),
	};
}
