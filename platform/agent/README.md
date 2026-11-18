# @platform/agent

This package gives a backend a conversational agent to mount: one interface,
`AgentHost`, that runs turns, keeps threads and what is remembered about each
person, and binds live voice sessions to threads, plus a route that serves it
to the browser over AG-UI. A product supplies its words and tools through one
contract, `AgentProduct`, and nothing else. Read this page to build a product
on the package, to change how a turn runs, or to follow a turn or a live
session step by step.

The implementation runs on **Foundry Agent Service**. The agent is a prompt
agent whose versions hold the fixed parts of the prompt and every tool. A turn
is a series of responses run with `store: false`, given the thread's history
from the deployment's own Cosmos DB. A thread made while `history.store` is
`foundry` is the exception: its responses are stored in the thread's
conversation on the service.

Memory (`memory.store`: the service's memory store or a container of the
deployment's own), retrieval (`retrieval.engine`: the backend's hybrid search
or a Foundry IQ knowledge base), web search and skills each have their choices
and defaults, set out in one table:
[Foundry's or the deployment's own](../../docs/architecture.md#foundrys-or-the-deployments-own).
The thread index and its ownership claims are on Cosmos DB; metering, claims
and caches are on Redis.

Two terms recur below. A **surface** is the channel a turn arrives on: the
typed channel or the live voice. The **channel instructions** are the product's
per-channel instructions (in the reference backend,
`apps/backend/src/product/surface.ts`), in a written register for typed turns
and a spoken one for voice; [architecture](../../docs/architecture.md#a-typed-turn)
describes them.

## Modules

- `contract/`: the types a backend and a product see.
  - `host` is the interface. `startTurn` takes the person's message (or, after
    a call to a control the client runs, only the client's answers to it) and
    returns a stream of typed events the backend forwards. The thread methods
    are `listThreads` (newest first, a page at a time to a null `next`),
    `readThread`, `renameThread` and `deleteThread`. `liveVoiceBinding` and
    `settleLiveVoice` bind a live session to a thread and, when it ends, write
    what it said into the thread once. `readMemory`, `updateMemoryItem` (a
    blank correction removes the statement), `removeMemoryItem` and
    `forgetMemory` cover what is remembered about the person, which they can
    read, correct and clear. Then come `personChanged`, `personalization` (the
    person's prompt blocks for a channel that composes its own prompt, through
    the same reads a turn makes), `eraseResource`, `warmUp`, `start` and
    `stop`.
  - Every method takes the resource id the backend resolved from a verified
    caller: the account id. One account is one person and one memory scope.
    Every refusal is a value with a status.
  - `product` is what the host cannot know: the agent's id and service name;
    the persona and the guardrails (`@platform/prompt`'s `defineGuardrails`
    builds them); the channel instructions; the tools; the controls a client
    runs itself (`clientTools`); the default skills that seed the Foundry project (`SkillSource`); what the
    memory's extractor is told to keep (`memory.userProfileDetails`); and the
    proper nouns. A tool (`productTool`) has a description, Zod parameters the
    host validates the model's arguments against, an `execute` the host runs
    inside the turn's scope, and `sources`, the documents a result named. Each
    tool has a key the operator switches it off by. `WEB_SEARCH` is among those
    keys; it is the service's `web_search` tool rather than one of the
    product's.
  - `messages` is the wire format in both directions, with no SDK type on
    either side. It carries text, reasoning (a new id is a new summary part),
    and tool calls and results, each marked with where the tool ran (`server`,
    `client`, `service`). It also carries `sources`, the library documents the
    reply drew on: of the documents a product tool's result named, the ones the
    reply's text names by title, or all of them when it names none
    (`turn/named-sources.ts`). A turn ends with a `finish` or an `error`:
    `turn.failed`, or `turn.blocked` when the content filter refused, with its
    category logged and never sent.
  - `parity` is the acceptance suite every implementation passes.
  - Nothing the contract, the two stores' interfaces (`memory/interface.ts`,
    `history/interface.ts`) or the turn's shared rules and item types
    (`turn/`) reach is imported from `foundry/`. `memory/select.ts` and
    `history/select.ts`, which choose an implementation, are the only modules
    outside it that import from it (`contract/neutral.test.ts`).
    `LiveVoiceBinding` still carries the first host's types (the voice agent's
    name and version, its structured inputs, a `session.update`), because
    `@platform/voice` opens the session from them.
- `settings`: the `agent` document in App Configuration (below). It is merged
  field by field over the defaults; nothing stored can remove a bound.
- `skills/`: the check that decides which of a product's skills a turn may
  carry, given its surface and tools (the surfaces a skill names, and any one
  of the tools it requires). It also has a renderer that writes the fitting
  skills into a session's instructions within a character budget, for a
  channel that cannot load a skill on demand. The Foundry host does not use it
  for a live voice session: that session reads a skill through the backend's
  `readSkill` function (`foundry/voice-tools.ts`).
- `tool-gating`: the `tools` document, which says which of the product's tool
  keys are on, and `skills_enabled`, the kill switch for skills on both
  channels. A store that cannot be read serves every shipped tool on.
- `keys`: every key under the product's service name, the fleet-shared cache in
  Redis that the per-person caches go through, and the closed list of problems
  the package reports.
- `turn/`: what a turn is before any service sees it.
  - `admit` runs the three guards in one order.
  - `input` says what a turn may carry: the person's messages or only answers,
    never a mix; controls the product defines; and answers that match exactly
    the calls left open. Anything else is refused as `turn.invalid`.
  - `blocked` reads the content filter's refusal off a failed call.
  - The turn scope carries whose turn it is to the product's tools on the async
    context. `currentTurn()` is what a product tool may ask of it: the resource
    id, the surface, the language, the caller.
- `coordination/`: how replicas share the work of turns and threads.
  - The thread-owner lookup has three layers: this replica, the fleet-shared
    cache, the store. Only hits are cached, and a store failure is typed,
    never a pass.
  - The turn claim fails open, is renewed while its turn runs, and is released
    on a turn that did not finish or could not be kept.
  - The per-resource turn bucket runs on `@platform/metering`.
  - `thread-ends` tells the turns running on a deleted or erased thread, on any
    replica, that the thread has ended. Each running turn is a member of its
    person's set in Redis, under its thread and its run, counted from before
    its thread is opened. So nothing a thread id alone names is ever ended: a
    delete asked for under another person finds no turn.
  - The replica ending the thread (or, for an erase, every thread the person
    has) leaves each turn a note under its run id and publishes the person and
    the thread. A turn stops at once when its replica hears the message.
    Otherwise it finds the note before its next step, before each tool it would
    run, and before it writes.
  - The end waits five seconds in all, this replica's turns included, for the
    turns to be over. A turn that outlasts the wait writes nothing and removes
    what it left as it ends, streamed or not. After an erase, that is whatever
    thread it opened; after a delete, a thread it made under the id the delete
    answered was gone.
  - One thread's end never overwrites an erase's note. Each time a turn joins
    a set, the set is cleared of members past their time. Without Redis, a
    replica stops its own turns, which is all of them.
  - `due-queue` is the queue a thread's after-turn work goes through: the own
    memory's extraction and the thread's name. It is a Redis sorted set scored
    by when each thread is due, worked through by a sweeper (a periodic
    background job) on one replica at a time. Each thread is taken by the
    replica whose remove wins and run there, counted until it ends.
  - A process runs at most eight such jobs at once, however the work came to
    it. A sweep takes no more than there is room for, and work asked for at
    once waits its turn without holding up the turn that asked. Without Redis,
    the queue is this process's timer.
  - A stop runs this process's own timers and waits five seconds for its runs.
    Past that nothing more starts, an item it had taken from Redis and not run
    goes back there, and what waits in Redis is another replica's.
- `person/` and `instructions`: the person's reads, each cached in the shared
  cache with a TTL (the account's name and what they wrote; what is
  remembered; when they last talked). `instructions` is the one place the
  prompt is assembled, through `composeSystemPromptParts`, split where an
  agent version ends: the guardrails, the persona and the channel instructions
  belong to the version, and the personalization to the turn.
- `agui/`: `@platform/agent/agui`, the typed channel's wire format.
  `serveAgentRun` takes AG-UI's `RunAgentInput` (validated strictly with
  `@ag-ui/core`) and answers with `EventEncoder` server-sent events over
  `startTurn`. It reads the thread id; the history's tail (the person's new
  message, a picture as inline data, or the trailing `tool` messages); the
  controls by name; and the screen's lines, bounded. The rest of the history
  is ignored, because the host holds the conversation. Any of these is
  `400 { code: "turn.invalid" }`: a field the protocol does not define, shared
  state, forwarded props, a resumption, a picture by URL, a control's answer in
  parts, or a tail of another role. The host's refusals keep their status and
  code, with `Retry-After` on a 429.
- `title/`: `titleFrom`, the one-line name a message gives a conversation, and
  `generateTitle`, the model-written one. `generateTitle` is declined under a
  fleet bucket and a per-replica cap, and then `titleFrom` of the first of the
  person's lines stands in for it. The host names a thread itself, off the
  request path, once a turn or a live session in it ends and is written
  (`foundry/host.ts`). It uses the thread's lines without the ones its
  `blocked` list names, and writes only while the thread has no name, on the
  document's etag, so a rename the person made meanwhile stands. A thread with
  no unblocked line stays untitled.
- `foundry/`: `@platform/agent/foundry`, the implementation, and the one place
  the service's SDKs (`@azure/ai-projects` and `openai`, both pinned exactly)
  are reached from.
  - `client`: the two clients, both on the managed identity, both with the
    `llm` document's retries, and both sending through `@platform/llm`'s
    provider fetch, the integration point where a test puts its stand-in for
    the service. A streamed response holds a slot of the chat deployment's
    concurrency cap until it ends. The `openai` client is built here rather
    than through `getOpenAIClient()`, which in 2.10.0 drops a custom fetch.
  - `definition` and `versions`: the agent version a turn needs for its
    surface, tools and skills. It holds parts one and two of the prompt with
    `{{personalization}}` after them (the person's part is a structured input
    of each response); every client control and server tool; the service's web
    search when it is on (with the `agent` document's context size); the
    fitting skills, pinned by version; the reasoning settings; and the
    guardrail. Versions are found by a hash of the definition in their
    metadata, made under a fleet lock, and cached for a day. A version pruned
    under a running replica is made again on the 404.
  - `voice-definition`: the voice agent (preview, `kind: "voice"`) a live
    session talks to. It holds parts one and two of the product's own prompt
    for its voice surface, in the spoken register, with `{{personalization}}`
    after them and a `language` input listing the product's codes. It holds
    every function the voice surface has: the controls and the server tools,
    each schema without its `$schema` keyword, which the service accepts in a
    version and then never applies. It has a multilingual voice, multilingual
    turn detection, a transcriber and no locale anywhere (one version for every
    language), and `store: false`.
  - The voice agent consults no other agent: its calls reach the backend's
    socket, and the person's part is rendered into its own instructions. Its
    versions go through `versions` like the agent's, with the preview opt-in
    on every call that touches the voice agent.
  - `voiceSessionUpdate` is the one place a session's language is decided.
    `stated` states the transcription's language and the voice's accent; the
    accent takes effect, while the service transcribes the language it hears
    whatever the update says. `detected` (the fallback) leaves both to the
    service. The update also carries the typed turns' reasoning effort, which a
    version cannot, and the product's fillers in the person's language
    (`ProductVoice.interimResponses`), in place of the version's English ones.
  - `voice-tools`, `web-search`: what a typed turn has from the service that a
    voice agent cannot hold beside its function tools (a toolbox would replace
    them). `webSearch` is a response on the chat's deployment with the typed
    turns' `web_search` definition: the tool required, the answer capped, and
    the reasoning set by the `agent` document's `webSearch` settings. The typed
    turns' reader (`turn/events`) reads it, and it is charged to the
    `toolSearch` bucket. `readSkill` is the pinned skill version read from the
    service (`skills.readSkillVersion`). `@platform/voice`'s README has the
    documentation behind each.
  - `history`, `conversations` and `threads`: a thread's messages and its index
    entry (detail below the list).
  - `turn/`: the tool loop (detail below the list).
  - `memory`: the Foundry memory store (`memory.store: "foundry"`, the default
    on a public deployment). The job makes it (`ensureMemoryStore`). It is read
    into every turn (statements newest first, capped, and cached in the shared
    cache only when there is something to cache). Each finished turn's words
    are handed to it once the turn's events are sent. Statements are corrected,
    removed and forgotten per person, with the scope checked before every
    write.
  - A forget is final. Every hand-over's update id is kept in Redis until it
    must have finished. A forget that finds one still pending deletes the scope
    at once and answers every read empty. The purge sweeper makes the scope's
    second delete once that update (through whatever superseded it) has
    finished.
  - `purge`: a forget the memory store could not finish in the request,
    finished by a sweeper that works through a Redis set every minute.
  - `skills` and `zip`: the skills in the Foundry project, listed once a
    minute per replica, each gated by its default version's metadata
    (`surfaces`, `requires-tools`, `enabled`, `origin`), which is read from
    the version's zipped folder, once per version, as its `SKILL.md` front
    matter. Each fitting skill's default version is pinned into the agent
    versions it fits. The catalog in code only seeds the project
    (`publishSkills`): a default is published where the project lacks it or
    its default is a shipped version made from other words, never over an
    operator's; it is also what a turn carries when the project's skills
    cannot be listed. The functions the backend's `skills` CLI runs are here.
  - `web-search-meter`: web search runs inside a response, so nothing of the
    backend's stands in front of one search. Each search a turn ran is charged
    to the account's `toolSearch` bucket after the turn, and a turn starts
    without web search while that bucket is empty.
  - `spoken`: a live session's record, from the items the broker read off the
    voice agent's socket. They are written in the order of the chain the
    session announced rather than the order their finals arrived. Only the said
    lines are kept (no call, no failed transcription); a line the person spoke
    over is marked with a dash; each item appears once; and each line is
    bounded and stamped with when it was said.
  - `erase`, `spoken` and `host`: the erase (every thread's history from its
    own store, the index and the claim, every fact remembered, and every cached
    copy verified gone), the spoken turn written into the thread, and the class
    that composes them.
- `history/`: `interface` is what the host asks of whichever store keeps a
  thread's messages. `select` answers with the store a thread records (`own`
  when it names none) and, for a new thread, the one `history.store` names,
  read through the settings cache. A change decides only new threads and needs
  no restart.
- `memory/`: `interface` is what the host asks of whichever store remembers a
  person. `select` chooses the implementation from `memory.store` at the first
  use of memory and holds it for the life of the process (a change needs a
  restart). `store` is the own store (detail below the list).
- `testing/`: `@platform/agent/testing`.
  - The fake Foundry stands in for the service at its HTTP boundary: agents and
    versions; streamed responses that keep nothing, or are kept in a
    conversation (a request that mixes the two is refused); conversations with
    their items and deletes, with what a delete removes kept in
    `state.retained`, as the service's run state keeps it; memory stores with
    their long-running update; and skills and their zipped content.
  - It is strict, refusing what the service refuses, so both SDKs above it run
    for real.
  - `standInExtractor` stands in for the memory's model call at the same fetch.

### Thread storage

`history` is the own store (`history.store: "own"`, the default): `messages`
on Cosmos DB in the deployment's own database. There is one document per
message, tool call, output or reasoning, partitioned on the resource and read
by thread in order.

- A turn's items are written as one transactional batch, all or none. Past the
  service's bounds on a batch's operations and bytes they go in several
  batches, and one that fails takes itself and the earlier ones out again. So
  a write that fails leaves no exchange cut short.
- An item past the bound on a document is refused by name (`agent.turn.failed`,
  reason `item_too_large`).
- Once the items are kept, a failure of what follows (the thread's move, a
  blocked mark) is reported and the turn stands, since a turn told it failed is
  sent again.

The service keeps no conversation for an own-store thread: every response runs
with `store: false` and is given the history as input, because the service's
deletes do not erase the items it writes to the deployment's Cosmos DB
([architecture](../../docs/architecture.md#conversation-history)).
`boundHistory` bounds what a turn is given by the `agent` document's `history`
and starts it at a message of the person's. A picture is never written, only
its marker.

`conversations` is the service's store (`history.store: "foundry"`):

- one conversation per thread, each response stored in it and given only what
  is new;
- a run's last outputs appended before `finish`;
- a picture's item and response deleted once the turn ends and is written;
- a conversation past its time to live renewed;
- a delete that calls every delete.

`threads` holds the index (`threads`, partitioned on the resource) and
`threadIds` (the claim that makes an id one resource's). The index records each
thread's store and, on `foundry`, its conversation, the shown messages' times
and the responses' ids. `containers` lists what the index and the own history
need.

### The tool loop

In `foundry/turn/`, each step is one streamed response. The backend's tools
run here, and their outputs are the next step's input.

- A call to a control this client runs ends the run. A control it did not
  register is answered `{"error":"not_available"}`, and a response that wrote
  words and called only controls ends the turn.
- A response that calls both kinds has the outputs in hand held by the thread's
  store before `finish` (`TurnShape`: in the history, or appended to the
  conversation).
- A step limit ends a turn that keeps calling, its last calls answered.
- A step that said nothing and called a control the client did not register,
  or a wordless turn at the limit, is followed by one step with
  `tool_choice: "none"`. So a turn that nobody is left to answer always ends in
  words.
- A person who speaks while a control is still open closes it
  `{"error":"not_answered"}`.

`events` reads the stream: text, reasoning by summary part, calls, the web
search's calls and citations, and the ends a response can have.

### The own memory store

`memory/store` is the own store (`memory.store: "own"`): this deployment's own
Cosmos DB (`memory` container, one fact per document in the person's
partition). It reads the facts into every turn (newest first, capped, and
cached in the shared cache only when there is something to cache), and lets
the person correct, remove and forget them.

It writes facts off the request path. A finished turn hands its thread over.
After `memory.updateDelaySeconds` (a Redis sorted set a sweeper works through,
or this process's timer without Redis; a new turn for the thread restarts the
wait), `extract` runs:

1. It reads the thread's latest messages through the host's history, from
   whichever store holds the thread, together with what is already kept.
2. It asks the small chat model once for the whole list to keep, as JSON, with
   every fact marked with who said it.
3. It keeps only the person's facts.

A forget is final, and so is removing one fact. Either leaves a floor: a
document in the person's partition holding when it happened. An extraction
reads only what was said after the floor (the host's history is asked for the
items after that instant), so the words that taught a fact do not teach it
again. Neither do words said before the floor that had not been extracted yet,
since the store cannot tell which earlier words taught the fact.

- An extraction in flight reads the floor when it begins and after it has
  written. A forget in between deletes everything, and a removal in between
  deletes what that run added. Only a run whose additions stand deletes what
  its answer left out.
- A forget and a removal both raise the floor before and after their delete,
  and a removal's floor names the fact removed. An extraction that finds that
  fact gone writes nothing. A fact another extraction superseded meanwhile
  (another thread's, another replica's) is no removal, and the answer stands
  beside it.
- An extraction that finds the account erased within the last five minutes is
  dropped and reported (`agent.memory.extraction_failed`, reason `erased`).
- An answer of no facts at all, and a fact the person corrected while the model
  was answering, change nothing.
- An erased account keeps no floor.

## A turn, in order

1. The spend bound: `spendCredits` on the resource's bucket. Open without Redis.
2. Ownership: the thread named is this resource's, or nobody's yet. Another resource's is a 403; a store that cannot answer is a 503, never a pass.
3. The claim: the first replica to see a turn key answers it; a duplicate is a 409. Unavailable without Redis, and the turn proceeds.
4. The thread: its index entry, or a claim and a new one in the store `history.store` names; then its history, within the `history` bound. On a conversation thread only what is new is read, since the service holds the rest.
5. The prompt, through `composeSystemPromptParts`. The product's guardrails, its persona and its channel instructions belong to the version. This turn's structured input holds the date, who the person is and what they wrote, what is remembered about them, when they last talked, what is on their screen, and the language directive last. Web search is left out of a turn whose account has no searches left.
6. The version: found or made for the turn's surface, tools and skills.
7. The responses, streamed and translated: reasoning, text, tool calls and results, the documents drawn on, then `finish`; or `error` with no cause, after which the claim is released.
8. After the last response, what the turn said and wrote is kept in the thread's store, the index moves, the searches are charged, the thread is handed to memory to extract from after the delay, and a thread with no name is queued to be named. A call to a client's control ends the run. The client's answer is a turn of its own, accepted only for the calls left open, after the same guards.

## A live session, in order

1. `liveVoiceBinding` prepares the session:
   - the locale is checked against the product's languages, and ownership as a turn's is;
   - the thread is held for the session (a Redis claim owned by the session's id, for its hard limit and a grace period), so a typed turn on it, or a second session, is `thread.busy`;
   - the thread is made when new, and the calls a typed turn left open are closed `not_answered`;
   - the thread's words a typed turn would be given are gathered (`history`, as `LiveHistoryLine`s);
   - the voice version is found or made. It holds every function tool of the voice surface and, in place of what a voice agent cannot hold beside them, `webSearch` and `readSkill` as the backend's functions (`foundry/voice-tools.ts`);
   - the person's part is built, with the screen and the language directive last;
   - the session's `session.update` is built for their language and tier, with the engine's reasoning effort;
   - the engine, and so the version, is chosen from the tier.
2. The session runs on the voice agent's socket (`@platform/voice`'s `voicelive/`), which reads its transcript.
3. `settleLiveVoice` writes the session's record once (`spoken`), hands it to memory, queues the thread to be named if it has no name, and releases the hold however the write ends. A repeated call for the same session writes nothing.

The backend's `webSearch` function is a response on the chat's deployment carrying the typed turns' `web_search` tool with the `agent` document's `search_context_size` and `tool_choice: required` (`web-search.ts`). It is charged to the `toolSearch` bucket and withheld while that bucket is empty, as a typed turn's search is. `readSkill` reads from the service the skill version a typed turn would pin.

## Settings

Bootstrap comes from the environment, read where it is used:

- `FOUNDRY_PROJECT_ENDPOINT` (the project, keyless);
- `FOUNDRY_RAI_POLICY` (the guardrail every version names);
- `FOUNDRY_MEMORY_STORE` (`person-memory`, read while `memory.store` is `foundry`);
- `FOUNDRY_REQUEST_DEADLINE_MS` (30000: one request to the project, or a streamed response's headers; a stream that has begun is held to 300 s of silence between events);
- `COSMOS_ENDPOINT` (`@platform/cosmos`) and `REDIS_URL` (`@platform/redis`);
- the `AZURE_OPENAI_*` deployments (`@platform/llm`; the chat deployment is the one every version names);
- the cache TTLs: `THREAD_OWNER_CACHE_TTL_SECONDS` 3600, `MEMORY_CACHE_TTL_SECONDS` 60, `PERSON_CACHE_TTL_SECONDS` 60, `LAST_CONVERSATION_CACHE_TTL_SECONDS` 300;
- the claim: `TURN_CLAIM_TTL_SECONDS` 120, `TURN_CLAIM_DEADLINE_MS` 300;
- `WARMUP_TTL_MS` (60000), `TITLE_MAX_INFLIGHT` (4) and `TITLE_DEADLINE_MS` (25000).

`HOSTNAME`, which the platform sets on every replica, names the replica in its turn claims.

Everything an operator tunes is the `agent` document, read through `@platform/config` and live within the settings refresh interval (`CONFIG_TTL_MS`, about 30 seconds). Every number is a whole one from 1 to a million unless its row says otherwise; one outside its window keeps the default:

| Field | Default | Meaning |
| --- | --- | --- |
| `reasoningEffort` | `low` | The model's reasoning effort, in the agent version. |
| `reasoningSummary` | `auto` | How much of its reasoning the model summarizes into the stream, in the agent version. |
| `webSearch.contextSize` | `medium` | How much the service's web search reads, in the typed agent's version and in the backend's own search call for a voice session. |
| `webSearch.maxOutputTokens` / `webSearch.reasoningEffort` | 300 / `low` | The backend's search call for a voice session alone: its longest answer and the effort it reasons with. |
| `turns.burst` / `turns.refillPerMinute` | 10 / 30 | Turns one resource may start. |
| `titles.burst` / `titles.refillPerMinute` | 8 / 30 | Conversation titles the fleet may write. |
| `titlesPerResource.burst` / `titlesPerResource.refillPerMinute` | 3 / 6 | Of those, the titles one resource may have written. |
| `foundry.maxSteps` | 6 | Responses one turn may ask for; at most 50. |
| `foundry.keepVersions` | 10 | Agent versions the job keeps. |
| `foundry.maxItemsRead` | 1000 | The most items one read of a thread takes, newest first. The export reads every page. |
| `history.store` | `own` | Where a new thread's messages are kept: the deployment's own `messages` container, or `foundry`, the service's conversations. Each thread keeps the store it was made in. A component: `HISTORY_STORE` seeds it at deploy time. |
| `history.maxItems` / `history.maxChars` | 200 / 200000 | How much of a thread a turn is given: the newest items, at most this many and this many characters of them as JSON, starting at a message of the person's. On a `foundry` thread, only what a live session is seeded with. |
| `memory.store` | `foundry`; `own` on a private deployment | Where what is remembered is kept: the service's memory store, or `own`. Read once per process. A component: `MEMORY_STORE` seeds it at deploy time, and `foundry` is refused on a private deployment. |
| `memory.updateDelaySeconds` | 60 | How long the store waits for more of a conversation before it extracts; a new turn restarts the wait. Zero to a day. Both stores. |
| `memory.maxChars` | 4000 | What a turn carries of the remembered statements. Both stores. |
| `memory.itemMaxChars` | 500 | The longest one fact, written by the extractor or by the person in a correction. Both stores. |
| `memory.foundry.chatSummary` / `procedural` / `ttlSeconds` | false / false / 0 | The Foundry store's own options, set when the job makes it; the own store reads none. |
| `voice.runtime` | `agent` | What a live session opens on: the voice agent's version (`agent`), or the Voice Live API on a model it hosts (`voiceLive`), told the prompt and tools in the session's update (`voiceLiveSession`, `foundry/voice-definition.ts`). |
| `voice.engine` | `speechToSpeech` | Which engine answers a live session: `speechToSpeech` on the realtime deployment (`AZURE_OPENAI_REALTIME_DEPLOYMENT`), which falls back to the cascade while none is configured (`foundry/voice-engine.ts`), or the `chat` deployment run as a cascade. Each engine is a voice version of its own. A component: `VOICE_ENGINE` seeds it at deploy time. |
| `voice.engineByTier` | `{ base: null, premium: null }` | Per tier, an engine in place of `voice.engine`. |
| `voice.managedModel` | `{ cascade: "", speechToSpeech: "" }` | Per engine, a managed model the version names (`model_type: managed`) in place of this deployment's; empty: this deployment's. The names and what each takes are `MANAGED_VOICE_MODELS` (`src/voice-models.ts`). |
| `voice.transcription` | `mai-transcribe` | The voice agent's transcriber, in its version, documented beside both engines; speech-to-speech takes `mai-transcribe` in place of one documented only beside a cascade (`azure-speech`). The engine's deployment is the model (`model_type: self_deployed`), unless `voice.managedModel` names a managed one for it, whose own transcribers then bound this (`voice-models.ts`). |
| `voice.noiseReduction` | `azure_deep_noise_suppression_headset` | What the service takes out of the person's audio before it listens, in the voice version. |
| `voice.realtimeReasoningEffort` | `low` | A reasoning realtime model's effort on speech-to-speech; the cascade carries `reasoningEffort`. |

The `tools` document (`tool-gating`) switches the product's tool keys off and skills on or off. The host reads it once per turn and exposes the reader as `toolGating`, so a route that briefs another channel reads the same answer. The persona is the product's prompt document (`@platform/prompt/store`).

## The job's part

A deploy runs three steps of this package before traffic arrives, in this order:

1. `publishSkills`: the catalog's defaults, seeded as skill versions where the project lacks them or holds an older shipped one.
2. `ensureMemoryStore`: the memory store, made once with the small chat and embedding deployments, only while `memory.store` is `foundry`.
3. `FoundryAgentHost.prime(surfaces)`:
   - the version each typed surface's turns will ask for;
   - for a product with a live voice, the voice agent's version for its surface, for each engine some tier is answered by (`voice.engine`, `voice.engineByTier`; speech-to-speech only with a realtime deployment or a managed realtime model). The voice surface has no prompt-agent version of its own;
   - then all but the newest `keepVersions` of each agent are pruned. Each engine's current voice version is kept, and so is any voice version a live session is marked as running on, such as a voice tester's own (`foundry/voice-tuning.ts`).

A turn makes whatever is missing all the same, so a replica that starts first is never stuck: it pays for the first version itself.

## The parity suite

The parity suite is the acceptance bar for any implementation: pass a factory to `describeAgentHostParity` (`@platform/agent/parity`), and the same file runs against it. The suite is written against the interface and the product contract alone, with no SDK type, no store read and no key. It takes from the factory what the interface cannot show: what the service received (the turn's instructions and conversation, what memory was handed), and a way to script what it answers (words after a reasoning summary, calls, the content filter's refusal). The Foundry factory is `foundry/testing/parity-factory.ts`, taking the memory store to run on; `contract/parity.test.ts` registers it once per store.

## Tests

`bun test platform/agent`. The pure modules run everywhere. The suites on the fake Foundry (the parity suite and `foundry/host.test.ts`) run when `REDIS_URL` is set, because their bar includes the duplicate turn refused across a fleet. They put the fleet's keys under a throwaway prefix and sweep it, and keep the thread index on `@platform/cosmos/testing` (in memory, or the emulator under `COSMOS_TESTS=1`).

`foundry/host.test.ts` proves what the interface cannot express:

- the version a turn runs on and what it holds;
- the requests sent and never sent;
- the controls answered here, and the write a mixed response holds before `finish`;
- the step limit, web search and its charge;
- the pictures deleted (and swept after a failed delete);
- the skills pinned, and the job's steps idempotent;
- everything an erase reaches where the service keeps it.

`agui/agui.test.ts` holds the route without a host. What the fake cannot prove (the service's real event names, refusals and timings) needs a check on a deployment ([testing](../../docs/testing.md#what-only-a-deployment-proves)).

`AGENT_KEY_PREFIX` is a test-only variable: a suite sets it to a throwaway prefix so the fleet's keys land where it can sweep them. Nothing deployed sets it, because every key of a deployment sits under the product's service name.
