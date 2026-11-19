# @app/backend

This app is Agent on Azure's backend: everything the frontend's server calls,
from a typed turn and a live voice session to the person's settings, export
and erasure. Read this page to make the product yours, to find a route and what
it answers, or to run the backend locally.

It is one Bun process on Hono. It hosts the agent through `@platform/agent` on
Foundry Agent Service, the live voice relay from `@platform/voice`, the
knowledge base's pictures read from its own library container, and the
identity, conversation, erasure and export routes. Every route but the public
ones is behind a caller assertion the frontend's server mints from its verified
session. Nothing here reads a session cookie.

**Replace `src/product.ts` and `src/product/` to make it yours.** That is
where the product lives: the agent's names, its persona, its guardrail wording,
its channel instructions, its tools, the stage's controls and its languages.
The channel instructions are the per-channel instructions in
`src/product/surface.ts`, in a written register for typed turns and a spoken
one for voice ([architecture](../../docs/architecture.md#a-typed-turn)).
The stage is the visual workspace beside the conversation.

The folder also holds the sample records, the routes that serve them and the
library to the stage, and the sample library the migrate job loads. They reach
the app on the product's object (`src/backend-product.ts`): its `routes`, its
`library`, its `surfaces` and `locales`. No file outside the two imports from
`src/product/` (`src/product-boundary.test.ts`), so everything else is true of
any product and composes the packages.

## Layout

- `src/index.ts`: the entry, with the deployment rules, the wiring, the host,
  the server, and the drain on SIGTERM (detail below the list).
- `src/app.ts`: the Hono app from the routes, in one order: keep-alive on every
  answer, the public health route, the caller check, the refusal of a session
  its account's erasure ended, then everything they cover. An unknown path is
  401 before it is 404.
  - The second check (`refuseErasedSession`, `src/auth/standing.ts`) reads the
    caller's row once on every route but the sign-in report and the warm-up.
    It is a point read that the routes that spend share.
  - A session that began before its account was erased is
    `401 account_erased`. A row that cannot be read is
    `503 account_unavailable`, since a guess would let the erased person's
    session read or erase the account made after them.
- `src/wiring.ts`: what the packages leave to the app: the key namespace, the
  fleet-shared cache the `limits` document is read through, the live voice
  broker and the periodic sweep of its ledger (the live-voice seconds ledger in
  Redis), and telemetry.
- `src/containers.ts`: the Cosmos DB containers this process reads, as
  `@platform/identity`, `@platform/prompt/store` and `@platform/agent/foundry`
  declare them: the accounts, the persona's and the skills' versions, the thread index and the
  messages, and what the agent remembers.
- `src/persona.ts`: `bun run persona publish <label> <file> | activate <label> | show`,
  the operator's way to change the persona
  ([operations](../../docs/operations.md#changing-the-persona)).
- `src/skills.ts`: `bun run skills list | publish | activate | enable | disable | reset`,
  the operator's way to manage the skills' versions in Cosmos DB
  ([operations](../../docs/operations.md#managing-skills)).
- `src/job.ts`: the migrate job's entry, `bun run src/job.ts <step>...` (steps
  below the list).
- `src/product/`: the product's body.
  - `surface.ts` is the channel instructions in a written and a spoken register.
  - `stage-tools.ts` holds the controls the interface registers, as data.
  - `library.ts` is the knowledge base as the stage reads it.
  - `tools/` holds one server-side tool per file (`knowledgeSearch`,
    `lookupRecord`, `listRecords`, `metrics`). Each is registered under the key
    the operator's `tools` document switches it off by.
  - Web search is not one of the product's tools. It is the Agent Service's own
    `web_search` tool, which the service runs inside the response. The same
    document's `webSearch` key switches it, and it is metered after the turn on
    the `toolSearch` allowance.
- `src/product/sample/`: a dozen fictional people, projects, customers and
  assets with eight quarters of figures, and the series the chart draws from
  them. The record tools and routes read it; a product replaces it with its own
  store and keeps the same data types. `library.ts` names the sample library
  below and loads it, as the product's `library`.
- `src/product/library-routes.ts` and `src/product/record-routes.ts`: the
  product's own routes, mounted by its `routes` hook behind the caller check:
  the knowledge base's cards and reader, and the records. Each also passes the
  standing check (below).
- `src/product/records/`: where the records come from: the sample records module, or
  a business system over HTTP when `RECORDS_API_URL` names one, asked as the
  person. The adapter (`http.ts`) follows a listing's pages up to 500 records
  and marks a longer one `truncated`; `mapping.ts` turns the system's record
  into the app's, and is the file a team replaces
  ([worked example](../../docs/worked-example.md#mapping-a-real-system)).
- `sample/library/`: the sample documents; see *The sample library*.
- `src/auth/`: the checks. `caller` verifies the assertion and attaches the
  caller and their usage subject. `standing` re-reads the account at the point
  of use (the standing check). One account is one person, so the caller's
  account id is the whole scope (the agent's memory, the threads, the
  allowances), and no route reads a scope off a header or a body.
- `src/routes/`: one file per route family.
  - `identity.ts` is the person: sign-in, `/me`, the edit of their own fields,
    and what the assistant remembers about them.
  - `agent.ts` is the agent's AG-UI run route, `/agent/run`, behind the
    standing and chat-allowance checks.
  - The stage's two families, the library and the records, are the product's
    (`src/product/library-routes.ts`, `src/product/record-routes.ts`).
  - `voice.ts` is the live socket, and `voice-tuning.ts` a voice tester's
    tuning of their own sessions.
- `src/erasure.ts` and `src/export.ts`: the person's rights, in one place each.
- `src/language.ts` and `src/transcript.ts`: the two data types a route and the
  export share. The language is the app's one setting. The frontend resolves
  it against the product's list (`src/product/locales.ts`, which the frontend
  imports): the stated choice in the locale cookie, then the browser's
  `Accept-Language`, then English. It sends its answer as `Accept-Language` on
  every call; a person has no stored language of their own.

**Startup and shutdown (`src/index.ts`).** On SIGTERM the drain runs in
`src/shutdown.ts`:

1. the live sessions' grace and the turns in flight get 20 s of the platform's
   30 s grace;
2. then the host is stopped, with six seconds kept for it whether or not the
   drain finished, and everything it needs still open;
3. then the connections are closed together and the telemetry flushed, each
   inside a share of its own, so one that hangs keeps none of the others from
   running. The shares add up to the grace.

The host starts once the services it reads admit the replica's own identity
(`src/startup.ts`). On a first deploy the app can start before its role
assignments have applied. So a refusal from Cosmos DB, the search index or the
agent service is waited out: a 403, or a 401 that names a missing permission,
which is how some data planes answer a role not yet applied. The replica stays
up, says so once, answers 503 on `/ready` and everything past it, and starts as
soon as it is admitted. A refusal still standing after fifteen minutes fails
the start. So does a Cosmos DB container that is missing or partitioned
differently from how its store addresses it, and a Foundry project that does
not answer.

**The migrate job's steps (`src/job.ts`).** It runs the steps in the order
given, in one execution:

- `settings`: the documents `src/config-documents.ts` builds, written where
  absent or `{}`, and the persona's first version where it has none;
- `index`: AI Search's index, data source, skillset and indexer
  (`ensurePipeline`);
- `skills`: the product's default skills written to Cosmos DB, each only
  where no version of its name is stored;
- `agent`: the memory store made where missing when the `agent` document's
  `memory.store` is `foundry`, the agent version each surface's turns ask for,
  and the oldest versions pruned;
- `library`: the sample library, mirrored into the library container first;
- `library:<name>`: a library uploaded under `<name>/`, described, indexed,
  pruned and shielded by `loadLibrary`;
- `remove-library[:<name>]`;
- `shield`: every chunk Prompt Shields has not read.

A step in which any file failed fails the execution, after the other files
loaded.

## Routes

`GET /health` (live) and `GET /ready` (the host has started; 503 `starting`
until then, as is every other route) are public. So are `GET /appearance`, the
`appearance` document as its reader makes of the store, and
`GET /appearance/logo`, the one picture that document names, read from the
appearance container (`src/routes/appearance.ts`). The sign-in page uses both
before anybody has signed in.

Every other route takes `Authorization: Bearer <caller assertion>` and is
scoped to the caller's own account; a thread another account owns is absent on
a read and refused on a write. A request body over the `edge` document's
`maxRequestBodyBytes` is `413 { code: "body_too_large" }` before any route
reads it.

| Route | Answer |
| --- | --- |
| `POST /identity/sign-in` | `resolveSignIn`'s outcome; the body is `{ claims, user, account }` as the provider gave them |
| `GET /identity/me` | account id, the person's `name`, `about` and `preferences`, access and groups re-resolved from the row, standing; beside them the agent's id, `limits.maxRequestBodyBytes` (the `edge` document's bound) and `stageTools`, the controls the interface registers, so the frontend holds none of them as configuration |
| `PATCH /identity/me` | `{ name?, about?, preferences? }` → `{ name, about, preferences }`: a name of at most 60 characters that is not blank, texts of at most 1000 or `null` to clear; a body with none of them, or one out of bounds, is `400 { code: "invalid_body" }` |
| `GET /identity/me/memory` | `{ items: [{ id, content, updatedAt }] }`: what the assistant remembers about the person, a statement at a time, newest first, from whichever store `memory.store` names (the memory store's scope for the account, or the `memory` container's partition) |
| `PATCH /identity/me/memory/:id` | `{ content }` → the statement as kept: the person's correction, capped at `memory.itemMaxChars`, what later extractions start from. Blank is `400 { code: "invalid_body" }` (`DELETE` removes); a statement that is not theirs is `404 { code: "not_found" }` |
| `DELETE /identity/me/memory/:id` | `204`: the statement forgotten; `404` when it is not theirs or already gone |
| `DELETE /identity/me/memory` | `204`: everything remembered about the person forgotten |
| `GET /conversations`, `GET/PATCH/DELETE /conversations/:id` | the host's threads; what a live session said is written into its thread when it ends, never through a route |
| `POST /agent/run` | one turn over AG-UI (`@platform/agent/agui`): the body is AG-UI's `RunAgentInput`, and the answer is its events as server-sent events. See *The run route* |
| `GET /media/{library}/{path}` | one picture of the knowledge base by its path in the library container, read with the backend's identity and streamed. See *Media and library* |
| `GET /library?query=&tags=` | `{ documents: [{ id, title, summary, tags, thumbnailUrl? }] }`: the knowledge search the agent's tool runs, or with no `query` the catalog. See *Media and library* |
| `GET /library/:id` | `{ id, title, summary, tags, thumbnailUrl?, sections: [{ heading, text }], markdown, media: [{ type, url, title? }] }`: one document for the reader. See *Media and library* |
| `GET /records?kind=&query=` | the sample records grouped by kind, as the agent's `listRecords` answers them; an unknown kind or a query over 120 characters is `400 invalid_query` |
| `GET /records/:kind/:id` | `{ kind, id, name, fields: [{ label, value }], links: [{ kind, id, name }], measures }`, or 404 |
| `GET /records/:kind/:id/metrics/:measure?period=` | the series the agent's `metrics` answers for the chart, by `quarter` (the default) or `year`; an unknown measure is `404 { code: "no_such_measure", measures }` |
| `GET /voice/tuning`, `PUT /voice/tuning` | a voice tester's tuning of their own live sessions: what they saved and what it may name, and the save, checked whole; `403 forbidden` without the app role `tester` |
| `GET /voice/capability` | `{ live }`: `live` when the product has a voice, the project is configured and Redis answers; the only voice there is |
| `GET /voice/live` (WebSocket) | the live session with the voice agent, on one socket this replica then holds both ends of (`@platform/voice`'s `VoiceBroker`). See *The live socket* |
| `DELETE /account` | erasure of everything held under the account, then the row with the person's own words. See *Erasure* |
| `GET /account/export` | `{ format: "personal-data-export/3", exportedAt, account, conversations }`: the account row with the person's fields and `memory`, every statement the assistant remembers, and every conversation, streamed |
| `GET /warm` | pays the first turn's cold-start costs ahead of it |

Errors cross the boundary as `{ code }` with the status; metered refusals use
`@platform/metering`'s format with `Retry-After`.

**The run route.** The events of `POST /agent/run` are the reasoning, the
text, the tool calls and the results of the backend's own tools, the pages
cited, then `RUN_FINISHED`. A failed turn ends with `RUN_ERROR` carrying
`turn.failed` or `turn.blocked` (the content filter) and no cause. The memory
scope is the caller's account id.

- A body that is not a run this route accepts is `400 { code: "turn.invalid" }`.
- The host's refusals keep their status and code: `403 thread.forbidden`,
  `409 turn.duplicate`, `429 turn.rate_limited` with `Retry-After`,
  `503 thread.unavailable`, `400 turn.invalid`.
- The day's chat allowance counts turns. A run the host turns away with 400,
  403 or 409 gets its credit back, so the day's allowance does not bound
  refused attempts. The host's own turn bucket does, for a 403 or a 409; a body
  it cannot read costs a parse and no model call.

**Media and library.**

- `GET /media/{library}/{path}`: a path that does not decode, climbs out of its
  directory or carries a control character is `400 { code: "invalid_path" }`.
  A blob that is absent, is not a picture the job described, or is not this
  caller's to read is one `404 { code: "not_found" }`. `readablePicture`
  decides that against the blob's own metadata, by the rule a search applies.
- `GET /library` with a `query` runs the knowledge search the agent's tool
  runs, as the same caller: one passage and so one card per document, its
  picture a path on the media route (`/api/media/{library}/{path}`). `tags`
  repeats or is comma-separated.
- With no `query`, `GET /library` answers the catalog: one card per document
  the caller may read (clean chunks only, the readers clause under
  enforcement), unranked, at most 50. It answers "what documents do we have",
  which a search's reranker floor would empty.
- A query over 400 characters, more than 8 tags, or a tag over 60 characters or
  holding `|`, is `400 invalid_query`. A search draws on the account's `media`
  allowance and is `429` past it; the catalog asks no model and is not charged.
- `GET /library/:id` reads a Markdown or text file from its blob, paged by its
  headings with its pictures lifted out (`markdown` true: the reader renders
  its text, where any other format is shown as written). Any other format is
  read from its chunks in order. Absent, not yet indexed, and not this
  caller's to read are one `404 { code: "not_found" }`.
- The reader applies the readers clause and not the shield's: what it returns
  is drawn for a person, and the stage tells the model only its title.

**The live socket.** `GET /voice/live` runs as follows:

- `start { threadId, screen? }` goes first, answered by
  `ready { session: { id, maxSessionSeconds, idleSeconds }, language, audio: { sampleRate } }`.
- Then the person's audio (binary PCM16, 24 kHz) goes in and the voice's comes
  out. The voice pane's events go as text (speech, responses, transcript lines,
  stage calls, `error turn.blocked`, `ending { reason }`,
  `ended { reason, written }`), and the browser sends `tool-output`, `screen`
  and `end`.
- A refusal is `{ type: "refused", status, body }`, with the body a route
  would answer, and a close with 4000 + the status. The refusals are the
  ledger's (`429`, `409 busy`, `503 capacity`/`unavailable`, `503 unavailable`
  without Redis), the host's (`403 thread.forbidden`, `409 thread.busy`), and
  `502 handshake_failed`.
- A request that is not an upgrade is `426`.

**Erasure.** `DELETE /account` erases everything held under the account: every
thread's responses, items and conversation on the service, the thread index and
its claims, everything remembered on whichever memory store is in use, and
every cached copy. Then it erases the row with the person's own words.

- A deactivated account's row stays, emptied of everything but its id, the
  deactivation and when it was erased, so an erase is never a way back in. An
  active account's row stays as its id and when it was erased, until no session
  from before can present itself.
- Either way, every session from before the erase is `401 account_erased` from
  then on, on every route.
- The row is shut first, emptied of the person, so nothing is read or made
  under the id while the rest is removed, and finished last.
- An erase that stops part way is `503 erase_incomplete` and leaves the row
  shut. Asked again, by that session or any other from before, it is run again
  and finished, and the person's next sign-in does the same before it is
  admitted.
- A second request while the first is still running starts no second erase: it
  waits a moment for the first and answers as it did, or `503`.
- Asked again after it finished, with nobody signed in under the id since, it
  answers the same 204 and does nothing. The row is only ever shut while it is
  still the asking session's own, and nothing is removed until it is. So the
  account a sign-in made in between is left alone, and that session is
  `401 account_erased`.

## Access

Access is the identity provider's app roles, never an environment variable.
`premium` is the tier. Admission is the app registration's own *assignment
required* switch or, with `AUTH_REQUIRE_ROLE=1`, a token carrying `user` or
`premium`. The token's `groups` claim is kept on the account and answered by
`/identity/me`.

Every spend (a turn, a search, the library, the records, voice, media) passes
`requireStanding` (`src/auth/standing.ts`), which reads the account's row once.
Its standing decides whether the request may spend. The same row, never the
assertion, supplies the tier and the groups that document access is decided
against.

`AUTH_MODE` is the one deployment decision both apps share: `entra`, or
`local` for a demo with no registration, in which every sign-in is a new
`user` account. A hardened deployment (`HARDENED=true`) refuses to start in
`local` mode, as it refuses to start without `AUTH_REQUIRE_ROLE`. The whole
policy, what each role does, and how to create and assign the roles, is in
`platform/identity/README.md`.

Who may read which document is decided from the same claims. The agent route
hands the verified subject and groups to the turn as its `caller`.
`src/product/tools/knowledge-search.ts` passes `currentTurn().caller` to the
library's search (`src/product/library.ts`), which hands it to `retrieve` as
`access`; nothing is read from a request body.

Two switches in the `access` document in App Configuration decide what that
means ([configuration](../../docs/configuration.md#access)). Both have a
compiled-in default. A stored value that is not a boolean takes the closed
side, and a store that has never been read refuses the search as
`access_unreadable`.

- `enforceAccessControl` (default `false`) makes every search carry the
  caller's readers clause, and answers a turn nobody verified with no passages
  and the problem code `backend.knowledge.refused`.
- `globalDocumentAccess` (default `true`) makes a file no `access.json` entry
  names readable by everybody.

A local sign-in has no groups and a subject no manifest can name, so under
enforcement it reads exactly what is `all`. How readers are declared and
indexed is in `platform/knowledge/README.md`.

## The stage

The interface is a workspace: a chat column, a voice pane, and a stage the
agent drives. The stage holds a library, a reader, a media section, a chart, a
record card and a list of records, with suggestion chips under the composer.

The eight controls that fill it (`showLibrary`, `openDocument`,
`presentContent`, `showChart`, `showRecord`, `showRecords`, `clearStage`,
`suggestNext`) run in the browser. This backend owns their definitions as data
in `src/product/stage-tools.ts`, in the live voice API's function format. It
answers them under `stageTools` from `GET /identity/me`, so the interface
registers the same eight under the same names and imports nothing from here.

Three things carry them to the model:

- **The channel instructions** (`src/product/surface.ts`, the product's
  `behaviour(turn)`) describe the eight and whichever server-side tools the
  operator's `tools` document left on, as true of this turn. They come in a
  written register for the typed channel and a spoken one for the live
  session.
- **On the typed channel**, the product declares them as its `clientTools`. The
  interface names the ones it registered in the run's `tools` and puts what is
  on the stage in its `context`. The run route reads the names alone: the model
  gets this backend's own definitions, never the words the interface sent. So a
  call streams back as a tool call the interface runs and answers with a run of
  its own. The host accepts that run's trailing `tool` messages only for the
  calls it left open. The context becomes the turn's `liveContext` lines, which
  the prompt renders as `<live_ui_context>`.
- **On the live channel**, the voice agent holds the `live` surface's prompt
  and every function tool itself. A call reaches the socket the backend holds.
  A server tool runs there as the person, and a stage control goes to the
  browser over the session's socket, with its answer coming back the same way.

## The sample library

The library the stage shows ships with Agent on Azure: nine fictional documents
in `sample/library/`. They cover onboarding, a project plan and a project
brief, customer support and account reviews, depot operations, security basics
and an incident runbook, and the employee handbook.

- Each is a Markdown file whose front matter gives its `title`, `summary` and
  `tags`, and each shows a picture from `pictures/` by relative path. The
  picture is a blob of its own beside the document, which the reader and the
  search show by that path.
- `access.json` beside them gives every document to the group `all`, every
  signed-in person.

A deployment loads it from its migrate job's `library` step
(`loadSampleLibrary`). The directory is mirrored into the library container as
the library `@sample`, uploading only what the blobs do not already hold by
MD5, then loaded like any other. So a redeploy describes nothing, and the
indexer reads nothing that did not change. The local launcher loads the same
directory through the same code into the stand-ins, so both show the same
library.

To bring your own documents, put them in a directory with the same layout: PDF,
Word, Markdown, text and the rest of the formats in `docs/documents.md`,
pictures beside them, and an `access.json` naming who may read what
(`platform/knowledge/README.md`, *Access*). Then run `scripts/ingest.sh <dir>`,
which mirrors it into the library container and has the migrate job load it.
Or replace `sample/library/` and keep the deploy's step.

Every library load is a mirror: a file that has left the container under that
library's prefix loses its chunks, after a run with no failure, and only from
that library. To take the sample library out of a deployment, run
`azd env set SEED_SAMPLE_LIBRARY false` (the template's `seedSampleLibrary`):
the deploy's last step then removes it.

## Running

`bun run dev` runs a checkout whose `.env` names the services. It needs a
Cosmos DB account (the emulator will do) and a Foundry project, and exits
without them; with neither, `src/testing/dev-fake.ts` below is the app on
stand-ins.

- With no `AUTH_SECRET`, outside a deployment and outside the production
  image, the caller check stands open on one local account, and the server
  listens on the loopback address only. A Container Apps replica, or anything
  run with `NODE_ENV=production` (as every Dockerfile sets), never starts
  without it.
- With AI Search configured, the start checks the index the way it checks
  Redis. An index the process cannot read refuses the start. An absent one is
  the migrate job's `index` step to make (the backend's identity only reads the
  index), which the process says before starting anyway, since on a first
  deploy the app starts before the job has run.
- A refusal is another matter: a role assignment still applying (Cosmos DB's,
  the index's, the agent service's) is waited out as not ready, rather than
  crashed on, for fifteen minutes.
- The agent's first version is the job's `agent` step to make; a replica that
  starts first makes it on its first turn.

`.env.example` lists every variable this process reads, one line each. Every
one of them is bootstrap: a resource, a deployment, an identity, an endpoint, a
secret, or a per-replica setting (a pool size, a timeout, a per-replica
concurrency). Everything an operator tunes is a document in App Configuration,
and a fact has one name. A deployment is named by its variable and nowhere
else, and the settings refresh interval is `CONFIG_TTL_MS` (about 30 seconds)
for every document. `infra/app-env.test.ts` fails the build on a variable the
source reads that neither the file nor the template knows.

## Tests

`bun test apps/backend` from the repository root. The pure suites run
everywhere. The end-to-end suite (`src/app.flow.test.ts`) runs everywhere too,
with `REDIS_URL` for the fleet-shared paths. Foundry Agent Service and the
models are replaced by stand-ins at the provider's fetch
(`@platform/agent/testing`, `@platform/llm/testing`), and everything above them
is real. The accounts, the persona and the thread index are on Cosmos DB in
memory, or on the emulator under `COSMOS_TESTS=1`.

To look at the interface without a model or Azure, `src/testing/dev-fake.ts`
starts the real app on a port with the same stand-ins:

- the fake Foundry, and Cosmos DB in memory (or a throwaway database on the
  emulator);
- `AUTH_MODE=local`. With no `AUTH_SECRET`, the caller check stands open on
  its one local member, `local:developer`, whatever name signs in at the
  frontend. Given the frontend's `AUTH_SECRET`, it is closed as on a
  deployment, and every local sign-in is its own person; that is how the
  frontend's end-to-end suite runs it.
- the sample library loaded as a deployment loads it: mirrored into an
  in-memory blob container, described, indexed by a stand-in indexer that runs
  the job's own definitions, and shielded by a stand-in Prompt Shields
  (`standInKnowledge()` from `@platform/knowledge/testing`);
- a stand-in index that applies the readers clause as the service does, with
  the planner off and access control enforced, beside one document
  (`src/testing/restricted-library`) only the group `people-team` may read;
- a scripted model that answers a short paragraph and drives the stage: the
  library on the first turn, a document and a chart on the second, a record and
  a picture on the third, and three suggestions after each. A message
  containing the word "fail" gets a provider error, and one asking for a
  project's "spend by quarter" gets one response with several calls, a tool of
  the backend's beside two of the stage's.
- a titler that answers a short title from the conversation's opening;
- memory (the fake's memory store on the default setting, or the own store's
  extractor) that keeps two short statements after every turn.

It is never for a deployment: it refuses to run on one, or under
`NODE_ENV=production`.

```bash
REDIS_URL=redis://127.0.0.1:6399 PORT=4199 bun apps/backend/src/testing/dev-fake.ts
```
