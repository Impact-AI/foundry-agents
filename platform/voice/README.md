# @platform/voice

This package gives a backend what a microphone needs: the live session with a
Foundry voice agent, relayed by the backend on the process's managed identity
and metered in seconds. Read this page to follow a live session from the
browser's socket to the voice agent and back, to see how a spoken turn matches
a typed one, or to tune the `voice` settings.

There is one path and one transport: the browser's WebSocket to the backend
(through the frontend's own origin, under the caller its server verified), and
the backend's WebSocket to the voice agent. The browser never reaches Foundry
and holds no credential for it. So a project closed to the internet (hardened
mode) serves voice exactly as it serves typed turns: only the backend talks to
it. The broker takes a `LiveCaller` the app has already verified (the usage
subject, the tier resolved at the point of use, and the language from the one
resolution order) and never reads any of it from the socket.

## Modules

- `broker/`: the relay (detail in *The broker* below).
- `voicelive/`: the voice agent's protocol (detail in *The voice agent's
  protocol* below).
- `spoken`: the spoken channel's own words for a product's prompt: the spoken
  register and the rule around a tool call.
- `refusal`: codes, never sentences. An allowance refusal is
  `@platform/metering`'s `rate_limited` format with the handshake's `reason`
  beside it. The rest are `{ code: "refused", surface: "realtime", reason }`,
  with `reason` one of `allowance` · `pool` · `capacity` · `busy` ·
  `unavailable` · `unconfigured`, and the status says which kind (429, 409 for
  `busy`, 503 otherwise). A service that would not open the session is
  `502 { code: "handshake_failed" }`; one that refused the session's own
  settings is `502 { code: "settings_refused" }`.

### The broker

**The socket.** `VoiceBroker.upgrade` accepts the browser's socket on
`GET /voice/live`, after the app's caller check and its standing check (the
re-read of the account at the point of use) have run. `websocket` is the
server's handler for it, with its bounds:

- a frame of at most half a second of audio;
- a 4 MiB backpressure limit, past which the server closes a browser that
  stopped reading;
- a 60 s idle timeout (the browser sends audio the whole time it is open).

**Admission.** The browser's first message is `start` (`{ threadId, screen? }`).
The session is admitted in the order of the ledger, the live-voice seconds
ledger in Redis:

1. every refusal that spends nothing, before the seconds are charged;
2. the charge, before the service;
3. the thread, bound by the host (`liveVoiceBinding`), before the socket;
4. the record, after it.

A refusal is sent as `{ type: "refused", status, body }`, with the body an
HTTP route would have answered, and the socket is closed with 4000 + the
status.

**The session.** Then comes `ready`
(`{ session: { id, maxSessionSeconds, idleSeconds }, language, audio: { sampleRate: 24000 } }`),
and from there the socket carries everything:

- the person's audio as binary frames (PCM16, mono, 24 kHz), and the voice's
  back the same way;
- the voice pane's events as text (`speech`, `response`, `line`, `sources`,
  `stage-call`, `stage-call-closed`, `error`, `ending`, `ended`);
- from the browser: a stage call's answer (`tool-output`), the screen, words
  the person typed (`text`) and `end`.

**Input limits (`input-budget.ts`).** How much of each input one session takes
is bounded before any of it is kept or sent on:

- audio: up to a quarter faster than it is spoken, with four seconds at once.
  Anything beyond that is dropped, and after a minute of it the session ends
  `failed` (`voice.live.input_refused`).
- typed messages: six at once, then one every two seconds, and 64 KiB a
  session. A message not taken is reported to the voice pane (`error`,
  `text.too_fast` or `text.session_full`).
- the screen: once a second, keeping the latest.

**The owner (`owner.ts`).** The replica the browser reached owns the session:
both sockets, the transcript, and the calls.

- A tool of the backend's runs here, as the person.
- A control is sent to the browser and answered `not_answered` after the
  timeout.
- `response.create` is sent once every call of a response is answered and no
  other response is open.
- A response that failed with nothing said is asked again within
  `live.responseRetry` and the turn's steps, then admitted once
  (`response-failure.ts`). The admission is a system item, never
  `response.instructions`, which would replace the session's instructions and
  its guardrails for that response.
- The service's `error` frames are sorted in two: one event refused (logged),
  and the session's settings refused (the session ends `refused`).
- The ledger is renewed on evidence that a person is there.

**One end.** A session has one end, however it comes: from the ledger, from
the voice pane, or from the socket closing. The person's last words are waited
for while the socket is still open. Then the socket is closed and the thread
written; a failed write is tried again when the store fails, and the transcript
is left in Redis under `voice.live.unsettled` when it still cannot be written.
Finally the browser is told and closed.

**Diagnostics.**

- Each end logs one line of what the session heard (`hearing.ts`): the frames
  and bytes the browser sent, their peak level, and how often the service
  heard speech begin. So a session that answered nothing says whether the
  browser sent nothing, sent silence, or sent sound the service did not take
  for speech.
- Each turn writes one `voice_turn` line of what it made the person wait
  (`turn-timing.ts`). It runs from the end of their words (the service's
  `speech_stopped`, or typed words arriving) to the voice's first audio and to
  the answer's own. It records each tool's time by name, the responses asked
  for, whether the person spoke over it, and how it ended.
- Each response's usage line carries the time to its first audio as `ttftMs`.

**Redis and other replicas.** Redis holds only what another replica needs: the
owner's claim, who the session is for, the transcript so far, and the end the
sweeper leaves for the owner (`store.ts`). The sweeper is the periodic sweep
of the ledger, which can end a session from any replica. Redis also carries the
`in` channel, which delivers the same end at once.

- The channel delivers at most once, so the owner's heartbeat also reads the
  end left for it: a cutoff reaches an owner whose subscriber connection was
  down.
- Redis is required; without it a start is refused `unavailable`.
- A killed owner's browser loses its socket with it. The sweeper's hangup
  reads the owner's claim and, finding it lapsed, closes the session and writes
  it from the transcript it kept. It never does so for a session whose claim is
  still held.
- A claim still held says only that its owner lived within the claim's
  lifetime, and the ledger asks once. So the replica that asked looks again
  once that lifetime has passed, and again a bounded number of times while the
  claim is held and the session is not ended. An owner killed just before its
  cutoff is handled then.
- A replica that drains gives those looks up, each reported as
  `voice.live.unsettled`: its host is stopping, and a thread is not written on
  one.
- The owner keeps its claim until its end has written the thread. Once the end
  is told, it answers no call: no tool runs, and the stage is sent nothing.

### The voice agent's protocol

**`client`** is the session socket on Bun's `WebSocket`:

- the project's voice endpoint with the version pinned, `store=false` and
  `transport=websocket`;
- the person's structured inputs in a header (escaped past ASCII, since a
  header carries Latin-1), never the URL;
- a connect bounded until the service announces the session, which hears
  everything from the first event (`observe`);
- a send queue with a bound for the session's events;
- the person's audio written now or dropped and counted (`append`), never
  queued;
- every end named (`client`, `expired`, `server`, `dropped`, `overflow`);
- a close the client asks for that a silent peer cannot hold open: after two
  seconds the socket is torn down.

**`events`** reads each message once into an event the backend reads, an
`unrecognized` one or a `malformed` one; it never throws.

**`exchange`** is the opening as one call, `openSession`:

1. the socket;
2. the service's own `session.updated` waited for (it sends one as it applies
   the version);
3. the person's `session.update` and its echo: the next `session.updated`,
   never the first after sending;
4. the thread so far (`giveHistory`).

The thread so far is the binding's lines: what a typed turn on the thread would
be given, within the `agent` document's `history` bound. Each line is a
`conversation.item.create`: the person's words as `input_text` and the agent's
as `output_text`, under the client's own ids, `hist_<n>`. The echo of the last
is waited for, and it is all or nothing: an `error` in that window takes every
line out again by its id (`conversation.item.delete`). A line that never landed
answers `item_delete_invalid_item_id`, which nobody logs.

- A spoken turn therefore continues the typed conversation, as a typed turn
  reads the spoken one.
- Only words are given (a tool call, its output and a picture are not), and the
  transcript excludes those ids, so the final write holds only what was said in
  the session.
- A line refused is `voice.live.history_refused`, and the session runs without
  the thread; the open does not fail.
- An update not echoed in time opens the session all the same, and the thread
  goes without a wait for its acknowledgements. So a service that echoes
  nothing on the socket costs one timeout, not three.

**`refusals`** is the one list of the service's `error` codes that refuse the
session's own settings (`speech_frontend_not_available`,
`invalid_input_audio_transcription_model`, `invalid_value` on the noise
suppression). In answer to the update, `openSession` throws
`SessionSettingsRefused` and the browser is refused `settings_refused`; after
the open, the owner ends the session `refused`.

**`transcript`** reads a session's transcript off the socket for the host's
`settleLiveVoice`.

**`testing/fake-voice-agent`** stands in for the service on `Bun.serve`. It is
strict about the upgrade, sends its own `session.updated` first (as the service
does), and counts the audio appended. It plays scripted turns with audio, tool
calls, barge-ins, filtered answers and follow-ups that fail. It can refuse the
update or a line of the thread, echo nothing, and send any event a test names.

## What a spoken turn has of a typed one

The voice agent is a Foundry voice agent built from the same prompt parts,
function tools and guardrail as the typed agent. It runs on one of two engines,
each a version of its own, which the client asks for with
`x-agent-version-override`:

- speech to speech on the realtime deployment (`model_type: self_deployed`, or
  `managed` where the `agent` document's `voice.managedModel` or a voice tester
  names a managed model);
- a cascade on the chat's own deployment, where the `agent` document's
  `voice.engine` chooses the cascade for the person's tier or no realtime
  deployment is configured.

Four things a typed turn has need a way across to a spoken one. Each is read
against Microsoft's documentation and the SDK (`@azure/ai-projects` 2.10.0).

| A typed turn has | What the platform says | How a spoken turn gets it |
| --- | --- | --- |
| The thread so far | Not a limit. `conversation.item.create` "can be used both to populate a 'history' of the conversation and to add new items mid-stream" (`RealtimeClientEventConversationItemCreate`, SDK 2.10.0; [Voice Live API reference](https://learn.microsoft.com/en-us/azure/ai-services/speech-service/voice-live-api-reference-2026-06-01-preview)); the service echoes each item under the backend's id, and the voice answers from them | The binding's `history` (what a typed turn would be given, within the `agent` document's `history` bound) added as items after the update, words only; see `exchange` above |
| Web search | A limit: server-side tools such as web search attach only through a toolbox, and a toolbox replaces the agent's individual tools ([Configure a voice agent](https://learn.microsoft.com/en-us/azure/foundry/agents/how-to/configure-voice-agent)). See *Web search* below | `webSearch`, a function of the backend's (`@platform/agent`'s `foundry/voice-tools.ts`). See *Web search* below |
| Skills | Not a limit: skills are the backend's on both channels, never the service's | `readSkill`, the same function of the backend's a typed turn has, whose description lists the skills that fit the session and whose result is a skill's active instructions ([architecture](../../docs/architecture.md#skills)) |
| The knowledge base (`retrieval.engine: knowledgeBase`) | A limit on a private account: the service's own `mcp` tool reaches a server from a voice agent only with the account's public access on. Voice Live calls it over the account's public endpoint, which a hardened account refuses ([limitations](../../docs/limitations.md)) | Not used on either channel, by choice ([decisions](../../docs/decisions.md), decision 27): the backend's `knowledgeSearch` asks the base's `retrieve` route itself, at `retrieval.voiceReasoningEffort`, bounded by `retrieval.voiceDeadlineMs`, as a typed turn's asks at `retrieval.reasoningEffort` |
| The documents an answer drew on | Not a limit | A `sources` event to the voice pane once the answer's response is done: what the session's calls retrieved since the person last spoke, decided as a typed turn's chips (`namedSources`). Never under a filler (the cascade's `interim_` items, speech-to-speech's unplaced ones, as observed) or a response that itself retrieved |
| The step limit | Not a limit | `foundry.maxSteps` responses a turn, counted from the person's words: past it the calls are answered and no `response.create` follows (`voice.live.max_steps`) |
| The reasoning effort | Half a limit. `VoiceAgentDefinition` has no reasoning field; `VoiceAgentSessionUpdateConfig` has `reasoning: { effort }` ("for compatible realtime models"), and the chat's model behind a cascade takes it: the echo carries the effort sent | On the cascade, the `agent` document's `reasoningEffort` in every session's `session.update`; on speech-to-speech, `voice.realtimeReasoningEffort`, sent only to a realtime model that reasons (`gpt-realtime-2`, `gpt-realtime-2.1`). The summary setting has no place on the voice side and nothing to show |

**Web search.** Microsoft's documentation says to attach server-side tools such
as web search, Azure AI Search and OpenAPI tools through a toolbox rather than
declaring them directly. It also says a voice-based agent can have individual
tools or one toolbox, not both, and that attaching a toolbox replaces the
agent's individual tools list. A toolbox would therefore cost every control and
every server tool. Instead, `webSearch` is a function of the backend's:

- a response on the chat's deployment with the typed turns' own `web_search`
  definition, the tool required and the answer short;
- read by the typed turns' reader, answering with the grounded text and the
  pages;
- bounded by the chat deployment's concurrency cap and the client's deadline;
- charged to the `toolSearch` bucket and withheld from a session while it is
  empty, as a typed turn's search is.

What remains different is the platform's. The service runs a typed turn's web
search inside the response, and a spoken turn's is a function call
away. So a spoken answer that searches waits for the search before it speaks:
expect its first audio several seconds later than an answer from the thread,
which the spoken fillers cover.

## Capacity

Each session is two WebSockets on one backend replica (the browser's and the
voice agent's), with the audio of both directions through that process. That
is 48,000 bytes a second of PCM each way (24 kHz, 16-bit), a third more as base64 on the voice agent's side,
and about thirty small JSON messages a second.

- Reading the voice's deltas and encoding the person's frames costs about
  0.05 ms of CPU per second of session (a microbenchmark of `readServerEvent`
  and the base64). The sockets' own I/O on top of that is not measured.
- Nothing is buffered without bound. The person's frames are dropped when the
  voice agent's socket holds more than about four seconds of them, the voice's
  frames when the browser's holds more than five, and a browser past 4 MiB is
  closed.

A backend replica (1 vCPU, 2 GiB) is therefore not the first ceiling. **Plan
on 50 sessions per replica** as a working bound; it is not measured, so run a
load test on your deployment before relying on it. The bound that is enforced
is the ledger's `realtime.concurrentSessions`, deployment-wide.

Container Apps counts each open socket as a concurrent request against the
HTTP scaler's target of 14 on both apps, so live sessions scale the replicas
out as they arrive. On the frontend each session is one relayed connection,
piped byte for byte.

## Settings

Everything is the `voice` document in App Configuration, read through
`@platform/config` and live within the settings refresh interval
(`CONFIG_TTL_MS`, about 30 seconds), with these defaults:

| Field | Default | Meaning |
| --- | --- | --- |
| `live.voices.base` / `live.voices.premium` | `en-US-AvaMultilingualNeural` / `en-US-Ava:DragonHDLatestNeural` | The voice agent's Azure voice per tier: one multilingual voice each, never blank and never an OpenAI one. |
| `live.openaiVoices.base` / `live.openaiVoices.premium` | empty / empty | A realtime model's own voice per tier, spoken in its place when the tier runs speech-to-speech, with no fillers; empty, or one the Voice Live reference lists. |
| `live.language` | `stated` | How a session takes the person's language: `stated`, or `detected`, the fallback. |
| `live.stageCallTimeoutMs` | 8000 | How long the browser has to answer a stage call before `not_answered`. |
| `live.drainGraceMs` | 10000 | How long a draining replica gives its sessions after `restart`. |
| `live.settleWaitMs` | 5000 | How long an end waits for the person's last transcripts. |
| `live.connectTimeoutMs` | 15000 | How long the socket has to open and announce the session. |
| `live.updateTimeoutMs` | 5000 | How long the person's update's echo may take before the session opens without it. |
| `live.responseRetry` | 2 attempts, 1000 ms doubling, 500 ms jitter | How a response that failed with nothing said is asked again, before the voice is told to say it could not answer. |

A stored copy of any other key is ignored. The metering bounds (bursts, the
day, the seconds, the concurrent-session cap) are `@platform/metering`'s
`limits` document.

## Tests

`bun test platform/voice`. The broker runs against a real Redis when
`REDIS_URL` is set (`broker/broker.redis.test.ts`). A browser's socket
(`broker/testing/browser.ts`) connects to a backend serving the broker, with
stand-ins for the voice agent at its socket and for the host at its two
methods. The suite covers:

- the round trip with audio both ways, and the echo of the person's update;
- a barge-in, the tools answered and the voice let go on;
- an ask owed to an open response, and a failed follow-up asked again and then
  admitted;
- settings the service refuses, and the thread taken out whole;
- either end closing the other, and the refusals on the socket;
- the sweeper's end from another replica;
- a killed owner in a child process the test kills.

The client, the opening and the transcript run against
`voicelive/testing/fake-voice-agent.ts` on a local port.
