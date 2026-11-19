# Operations

This page is for the operator on duty: how to run a deployment of Agent on Azure day to day. It covers checking a deployment, reading its logs, tuning it live, the persona, the skills, the agent on Foundry, secrets, scale, backups and erasure.

## Check a deployment

Two checks ship, for different moments:

| Check | Run it when | It needs |
| --- | --- | --- |
| [Smoke test](#smoke-test) (`scripts/smoke.sh`, or `smoke.ps1`) | After every `azd up` or `azd deploy`, for a quick answer: the deployment is up, refuses a caller with no session and, in demo mode, answers a chat turn | `azd` and `curl`, or PowerShell 7 |
| [Deployment checker](deployment.md#deployment-checker) (`scripts/verify-deployment.ts`) | Before handing a deployment over or accepting a release: what Azure made for the mode, the app signed out and in, and optionally a live session, an erase and telemetry | Bun, `az` signed in with read access to the resource group |

### Smoke test

```sh
./scripts/smoke.sh        # or ./scripts/smoke.ps1, from the repository root, after azd up
```

It reads `FRONTEND_URL`, `AUTH_MODE` and `SEED_SAMPLE_LIBRARY` from the azd environment and checks that the frontend answers `/health` and the sign-in page, and that an API call without a session is refused with 401. With the demo's `local` sign-in it then signs in as a new person, lists the library, sends one chat turn and reads the streamed answer, and deletes the account it made. Under `entra` it stops after the unauthenticated checks, because a sign-in there is a person at Microsoft's page. It needs `azd` and `curl` (or PowerShell 7). CI never runs it against a deployment; the frontend's end-to-end suite runs both the shell and the PowerShell version against local servers so they stay true to the app.

### Health endpoints

The frontend's `/health` says the replica serves; the backend's `/health` says the process is alive and `/ready` that the agent has started (503 `starting` until the database admits it). The backend has internal ingress only.

### The migrate job's log

A green `postdeploy` prints only that the job's execution started and that it succeeded. Read the migrate job's log from its latest execution, with `--tail`: without it `az` returns only the last ~20 lines, and the `[settings]`, `[index]` and `[agent]` lines come earlier. `MIGRATE_JOB_NAME` and `AZURE_RESOURCE_GROUP` are in `azd env get-values`:

```sh
az containerapp job logs show --subscription <AZURE_SUBSCRIPTION_ID> --name <job> --resource-group <rg> --container migrate --tail 200
```

The same lines are in `ContainerAppConsoleLogs` ([monitoring](#monitoring)).

A failed step prints `[<step>] failed:` and then the error as the runtime prints it, with its stack; the error's message begins with the code, so search the log for the code rather than for a whole line. The `settings` step refuses components that cannot go together ([choose components at deploy time](deployment.md#choose-components-at-deploy-time)), naming the code and what to set:

```text
agent.memory.store_unreachable_private: memory.store is foundry on a private deployment (PRIVATE_NETWORKING), where the Foundry memory store extraction calls the account from public Microsoft addresses and is refused 403; Microsoft documents that VNet integration is not supported for memory stores. Set MEMORY_STORE=own (azd env set MEMORY_STORE own), and memory.store to own in the app/agent document if it exists.
```

`preprovision` prints the same lines, prefixed `preprovision:`, for the azd variables before anything is made; the job prints them for a variable or for a stored document edited since the last deploy. Set the variable it names (`azd env set …`), correct the field in App Configuration if the document holds it, and deploy again. `components.unknown_value` names a variable whose value is not one of its component's. A `[settings] settings.component_differs: …` warning is not a failure: a stored document is the operator's and is kept, and the line says which value the backend runs. The code `agent.memory.store_unreachable_private` in a running backend's log means the document was edited to `foundry` after the deploy: the own store is running, and the document should be corrected ([memory on a private deployment](configuration.md#memory-on-a-private-deployment)).

## Monitoring

Every resource sends its logs and metrics to one Log Analytics workspace (30-day retention). Both apps export traces to a workspace-based Application Insights resource when `APPLICATIONINSIGHTS_CONNECTION_STRING` is set, which the template always sets. Spans are scrubbed before export:

- path segments that look like ids become `:id`;
- query strings are reduced to an allow-list;
- caller-identifying attributes are dropped;
- an error's message and stack, the status message and the span's name lose what can be recognized as a credential or an address. That is a URL's userinfo and query, the value written under a key that names a credential, the rest of an `Authorization` or `Cookie` line, a `Bearer` or `Basic` credential that reads as one, a signed token, and an address. Each is caught in the forms the package's table names and no others ([what is and is not covered](../platform/observability/README.md#what-the-text-scrub-covers)).

Health probes produce no spans. Live Metrics is off for the frontend, where it would read a span before the scrub. The `telemetry.samplingRatio` setting thins the backend's traces live, never its `problem` and `llm_usage` events; the frontend's are recorded whole ([configuration](configuration.md#telemetry)). Ingestion is public on every deployment unless `PRIVATE_TELEMETRY=true` opts in to Azure Monitor's private link ([decisions](decisions.md#29-telemetry-on-a-private-deployment-public-ingestion-by-default-azure-monitors-private-link-by-opt-in)); querying is the same either way.

| Where | What |
| --- | --- |
| `ContainerAppConsoleLogs` | Each container's stdout: start-up lines (`[warmup] done`, `Cosmos DB admits this identity now`), the migrate job's step lines (`[settings]`, `[index]`, `[skills]`, `[agent]`, `[library]`, `[shield]`: one line per file a load described or failed, and a warning naming each file in which Prompt Shields found an attack, whose passage is then never served), warnings such as `[config] "limits" could not be read`, and the two structured lines below. |
| `AppRequests`, `AppDependencies` | One request row per inbound request; outbound calls; the two structured lines as short internal spans named `problem` and `llm_usage`, their facets under `Properties`. |
| `AzureDiagnostics` | Azure OpenAI request logs, the Front Door access and WAF logs, Key Vault audit events. |
| The Foundry project's traces | Only with `AGENT_TRACING=true`: the Agent Service's own spans of each response, sent to the same Application Insights through the project's `insights` connection; the portal's *Tracing* view of the project reads them. Off by default, because they hold each turn's words ([privacy](privacy.md#what-is-stored)). |
| Per-service resource tables and metrics | Redis, Cosmos DB, AI Search, Storage, App Configuration, Container Apps. |

### The two structured lines

Each is one JSON object per line on stdout, written for a query to group by and holding nothing that identifies a person.

**`problem`** — a refusal, as a code from a closed list and typed facets, never a sentence:

```json
{"evt":"problem","ts":"…","problem.code":"metering.call.rate_limited","problem.surface":"chat","problem.status":429,"problem.tier":"base","problem.retry_after_s":12}
```

| Code family | Means |
| --- | --- |
| `backend.caller.unauthenticated`, `backend.caller.forbidden` | A request without a valid [caller assertion](patterns.md#terms). |
| `backend.account.standing` | An account that may no longer spend (`account_deactivated`), one whose row could not be read, which refuses every route (`account_unavailable`), or a session older than its account's erasure (`account_erased`). |
| `backend.chat.rate_limited`, `metering.call.rate_limited`, `agent.turn.rate_limited` | An allowance or burst ran out (`limits` or `agent.turns`). |
| `agent.voice.personalization_trimmed`, `agent.voice.instructions_over_cap` | A live session's instructions over a bound: 16,384 tokens for speech to speech, or 32,000 characters for the structured-inputs header on either engine. The person's blocks were left out to fit (`reason` names them, `limit` the bound), or the fixed parts are too long alone: shorten the persona ([limitations](limitations.md)). |
| `metering.seconds.refused`, `voice.live.*`, `voice.renew.no_seconds` | Live voice refused, failing or ended early; the codes are listed under the table. |
| `backend.knowledge.refused` | A search with no verified caller under enforced access control, or (`reason` `access_unreadable`) any search on a replica that has not yet read the `access` document from its store. |
| `backend.media.refused` | A picture path that does not decode or would climb, one the caller may not see, that does not exist or that is not a picture the job described, or a stored object that is not a raster image. |
| `agent.turn.forbidden_thread`, `agent.turn.duplicate`, `agent.turn.busy`, `agent.turn.invalid`, `agent.turn.ownership_unavailable`, `agent.turn.failed`, `agent.turn.blocked` | A turn on somebody else's conversation, a duplicate, a turn on a thread a live session or another turn holds, a body that is not a run, an ownership lookup that could not answer, a failed turn (reasons under the table), or a turn the content filter stopped. A person's stop reports nothing. |
| `agent.voice.unheard` | A live session whose microphone audio the voice agent is not hearing. |
| `backend.voice_tuning.refused` | A voice tuning save refused: `403` for an account without the `tester` role, `400` for a value that does not hold, the field as the `reason` ([configuration](configuration.md#who-tunes-voice)). |
| `backend.voice_tuning.stale` | A tester's saved tuning that no longer holds when a session opens (the field as the `reason`): the session runs on the documents. |
| `backend.export.incomplete` | An export whose read failed part way: the download ends in an error rather than as a shorter file. |
| `backend.erase.incomplete`, `agent.erase.incomplete` | An erasure that did not finish. The account's document stays shut, and the caller's retry or the person's next sign-in finishes it (its reasons are listed under the table). |
| `agent.history.service_retention`, `agent.history.conversation_expired`, `agent.history.picture_kept` | `history.store` is `foundry`, whose deletes leave the service's own copy until its time to live (a warning from the job's `agent` step and the backend's start, never a failure); a thread's conversation past its sixty days, renewed without its earlier messages; a picture's item or response that could not be deleted from its conversation. |
| `agent.memory.*` | Memory not extracted, not updated, or not forgotten in time; the codes are listed under the table. |
| `agent.title.failed` | A conversation not named: its wait not queued, or the naming failed. It stays untitled until the next turn in it queues it again. |
| `agent.voice.speech_to_speech_unconfigured`, `agent.voice.transcriber_replaced` | The `agent` document asks for a voice engine it does not get: `voice.engine` or `voice.engineByTier` names `speechToSpeech` with no realtime deployment configured, so the [cascade](patterns.md#terms) runs; or [speech-to-speech](patterns.md#terms) runs with a `voice.transcription` documented only beside a cascade, replaced by `mai-transcribe`. Warnings from the job's `agent` step and the backend's start, never a failure. |

**Live voice codes.**

- **Refused**: no seconds left, the shared pool spent, no capacity, a session already open, Redis unavailable, or no voice agent.
- **Refused by the service or the voice agent**: the voice agent refusing the socket; a person's update refused; the session's own settings refused by the service, ending the session `refused` (`voice.live.session_refused`, with the service's code as `reason`); the thread's earlier lines not taken and taken out again (`voice.live.history_refused`).
- **A stage control unanswered in time.** The stage is the visual workspace beside the conversation.
- **`voice.live.input_refused`**: a session ended because its browser sent a minute of audio faster than a microphone makes it. Up to a tenth of a second's worth a second faster is forgiven. `measured` is the bytes not taken in the session.
- **`voice.live.max_steps`**: a turn reaching `foundry.maxSteps`.
- **`voice.live.response_failed`**: a response that failed with nothing said. `reason` is the failure's type, `bucket` its code, `bound` is `retrying`, `gave_up` or `not_retried`, and `measured` is the asks already made.
- **A filtered answer.**
- **`voice.live.orphaned`**: a session that another replica finished after its owner died.
- **`voice.live.unsettled`**: a session's words that could not be written to its thread after three tries. They stay in Redis until their keys expire.

**`agent.turn.failed` reasons.**

- `response` or `stream`: the response or its stream failed.
- `settle`: an answer that streamed and could not be kept.
- `item_too_large`: what could not be kept is one item past the store's bound on a document, which no retry keeps.
- `ended`: a turn that a delete or an erase ended, which may have left its thread behind.

**Erasure reasons.**

- `history_delete_failed`: a delete of a thread's response, item or conversation on the service failed with anything but "gone". The thread's index entry stays for the retry.
- `not_held`: the sweep's hold lapsed and another sweep took the erase over, so this one stopped.
- `cache_unreachable` and `cache_kept`: a cached copy the erase could not drop. They do not stop the erase, and the copy expires on its own.

**`agent.memory.*` codes.**

- `handover_failed`: a turn's thread not queued for extraction.
- `extraction_failed`: an extraction that failed. `extraction_refused`: one the content filter refused twice; what is kept is left as it was.
- `extraction_stalled`: the Foundry store's update not completed in time.
- `store_unreachable_private`: the Foundry store named on a private deployment. `preprovision` and the job's `settings` step refuse it; a running backend reports it and runs the own store ([memory on a private deployment](configuration.md#memory-on-a-private-deployment)).
- `update_untracked`: a hand-over a forget could not wait for.
- `erase_overdue`, `erase_unfinished`: a forget's second delete, late or unfinished.

**`llm_usage`** — one per model call (`kind` one of chat, embedding, transcription, speech, or voice for one response of a live session), with counts and timings, never text: `kind`, `provider`, `model`, `durationMs`, `finishReason`, `inputTokens`, `outputTokens`, `totalTokens`, `reasoningTokens`, `cachedInputTokens`, `ttftMs`, `audioSeconds`, `audioBytes`, `characters`, `embeddedValues`, `surface`, and `turnId`, an id minted per turn (exported to Application Insights only as a tag). An unknown is `null`, never zero. For a live session's response `provider` is `foundry-voice-agent` on a voice agent's version and `voice-live` on the Voice Live API ([voice runtimes](configuration.md#voice-runtimes)), `ttftMs` is the time from the response's start to its first audio, and `turnId` is the session's id.

`PROBLEM_LOG=0` and `LLM_USAGE_LOG=0` switch either line off.

Queries to start from. The `problem` and `llm_usage` rows are recorded whatever `telemetry.samplingRatio` is, so the first two count whole; a query over requests or any other span at a ratio below 1 sums `ItemCount` in place of `count()`.

```kusto
// Refusals by code, last day
AppDependencies
| where TimeGenerated > ago(1d) and Name == "problem"
| summarize count() by code = tostring(Properties["problem.code"]), status = tostring(Properties["problem.status"])
| order by count_ desc

// Tokens per model deployment, per hour
AppDependencies
| where Name == "llm_usage"
| summarize input = sum(toint(Properties["llm.input_tokens"])), cached = sum(toint(Properties["llm.cached_input_tokens"])),
            output = sum(toint(Properties["llm.output_tokens"])) by model = tostring(Properties["llm.model"]), bin(TimeGenerated, 1h)

// How long the voice agent took to begin speaking each response, per hour
AppDependencies
| where Name == "llm_usage" and Properties["llm.kind"] == "voice" and isnotempty(Properties["llm.ttft_ms"])
| summarize p50 = percentile(todouble(Properties["llm.ttft_ms"]), 50), p95 = percentile(todouble(Properties["llm.ttft_ms"]), 95)
    by model = tostring(Properties["llm.model"]), bin(TimeGenerated, 1h)

// The migrate job's last runs
ContainerAppConsoleLogs
| where ContainerName == "migrate"
| project TimeGenerated, Log
| order by TimeGenerated desc
```

The template creates no alert rules. Good first ones: `AppRequests` failure rate on the backend, `problem` rows with `problem.status` 429 or 503 per minute, Azure OpenAI 429s in `AzureDiagnostics`, and Cosmos DB's normalized RU consumption.

### Voice turn timings

A live session writes a third line, `voice_turn`, once per turn: what the turn made the person wait, and never a word of it. It is on stdout only (`ContainerAppConsoleLogs`), not a span, and `LLM_USAGE_LOG=0` switches it off with the usage line. Its fields: `how` (`spoken` or `typed`), `firstAudioMs` (from the end of the person's words to the voice's first audio, a filler's or the answer's), `answerAudioMs` (to the answer's own first audio), `responses`, `toolMs` (each tool's time, by name), `bargedIn`, `outcome` (`answered`, `blocked`, `unanswered`, or `silent` when no answer was spoken), `model`, `surface` and `turnId`, the session's id. The clock starts at the service's `speech_stopped` — after its turn detection has waited out the pause — or at typed words arriving, and stops at the first audio the service sends: the relay's hop to the browser and the browser's playback come after and are not in the number (`platform/voice/src/broker/turn-timing.ts`).

```kusto
// What a live session's turns made people wait, last day: to the voice's first audio, and to the answer's
ContainerAppConsoleLogs
| where TimeGenerated > ago(1d) and Log has "voice_turn"
| extend turn = parse_json(Log)
| where turn.evt == "voice_turn"
| summarize turns = count(), answered = countif(turn.outcome == "answered"),
            first_p50 = percentile(todouble(turn.firstAudioMs), 50), first_p95 = percentile(todouble(turn.firstAudioMs), 95),
            answer_p50 = percentile(todouble(turn.answerAudioMs), 50), answer_p95 = percentile(todouble(turn.answerAudioMs), 95)
    by model = tostring(turn.model), how = tostring(turn.how)
```

The template states no wait of its own to hold these to: measure a deployment's, decide what a spoken answer may take there, and alert on `answer_p95` against it.

## Tuning while it runs

Every run-time limit is a settings document in App Configuration, live on every replica within about 30 seconds; a refused field keeps its default, and only `limits`, `edge` and `appearance` log the refusal, so read the document back after an edit ([configuration](configuration.md#settings-documents)). For example, to halve the daily chat allowance during an incident:

```sh
endpoint=$(azd env get-value APP_CONFIG_ENDPOINT)
az appconfig kv show --endpoint "$endpoint" --auth-mode login --key app/limits --query value -o tsv > limits.json
# edit chat.perDay in limits.json
az appconfig kv set --endpoint "$endpoint" --auth-mode login --key app/limits \
  --content-type application/json --value "$(cat limits.json)" --yes
```

The frontend's look and its name are tuned the same way: `app/appearance` changes the palette, type, spacing, corners, the assistant's name and welcome line, and the logo, live within about a minute ([`appearance`](configuration.md#appearance)).

App Configuration keeps a revision history, so the portal can restore an earlier value. Hardened, the store's public listener is off: do this from inside the network, or open the listener for the edit (`az appconfig update -g <rg> -n <store> --enable-public-network true`, then `false`).

### Metering and premium

Each account is metered on its own surfaces: typed turns (`limits.chat`, and the agent's `turns` bucket), web searches, media, and live voice seconds. A refusal is `429` with `Retry-After` and `{ code: "rate_limited", surface, retryAfterSeconds }`; the frontend renders it in the person's language. Buckets live in Redis; without Redis the bucket fails open and logs `bucket unavailable` once a minute, while live voice fails closed.

An account whose token carries the `premium` app role is not metered by the `limits` document: no daily allowance, no burst, no seconds of its own. It still meets the deployment's shared live-voice pool (`global.realtimeSecondsPerDay`), the concurrent-session cap, one live session at a time, the idle reclaim and `premium.maxSessionSeconds`, and the agent's `turns` bucket. Its live voice speaks with the HD voice (`voice`'s `live.voices.premium`). Assign the role in Entra ([deployment](deployment.md#sign-in-with-microsoft-entra-id)); it takes effect at the person's next sign-in.

## Changing the persona

The persona — who the assistant is and how it works — is the second part of the system prompt, stored as versioned documents of the Cosmos DB container `prompts` under the key `assistant`, exactly one of them active. The migrate job's `settings` step seeds the shipped text in `apps/backend/src/product.ts` as version `v1` on the first deploy, and keeps the shipped text current on every deploy after it: a version the job wrote is marked `source: "shipped"`, and while the latest version is the job's, a change to the text in code is published as the next `v<n>`, active. The first version you publish ends that — the job then leaves the persona alone, and its line says so when the shipped text has moved on (`the persona v2 is the operator's; the shipped text changed and is not published over it`). With no version at all, the shipped text is served.

To publish a new version, as the operator (who holds Built-in Data Contributor on the `app` database), from the repository root:

```sh
export COSMOS_ENDPOINT="$(azd env get-value COSMOS_ENDPOINT)"
bun run --cwd apps/backend persona publish v2 ../../persona.md   # the file's text becomes the active version
bun run --cwd apps/backend persona show                          # which version is active
bun run --cwd apps/backend persona activate v1                   # back to an earlier one
```

Every replica serves the new active version within about 30 seconds. A label is used once per key; publishing switches the previous version off and the new one on in one transactional batch, so two publishes at once cannot both win. Keep the `# CORE IDENTITY` heading: the guardrails name it. The guardrail wording is the `guardrails` settings document, not this. Hardened, Cosmos DB's public listener is off: run it from a machine inside the network that has Bun and a checkout. The jump host is given `az`, `azd` and `git` and no Bun, so install the version in `.bun-version` there first.

## Managing skills

A skill is the procedure behind one kind of question, which the agent reads on the turns that ask it. Skills are versioned documents of the Cosmos DB container `prompts` under the key `skills`, beside the persona: each version holds the skill's description (when to use it), its instructions, the `surfaces` it is offered on (none: all), the `requiresTools` of which any one must be on (none: always) and whether it is enabled, and each skill has exactly one active version. A turn's `readSkill` tool lists the active, enabled skills that fit it and answers their instructions, on typed turns and in live sessions alike ([architecture](architecture.md#skills)). `skills_enabled` in the `tools` document switches every skill off at once ([configuration](configuration.md#tools)).

The product's defaults (`defineSkills` in `apps/backend/src/product.ts`; Agent on Azure ships none) only seed: the migrate job's `skills` step writes a default as the active `v1`, marked `shipped`, where no version of its name is stored, and leaves every skill that has one alone. A default changed in code therefore reaches new deployments and never a running one; `reset` publishes it there. While no skill is stored, or Cosmos DB cannot be read, the defaults are served.

To manage them, as the operator (who holds Built-in Data Contributor on the `app` database), from the repository root:

```sh
export COSMOS_ENDPOINT="$(azd env get-value COSMOS_ENDPOINT)"
bun run --cwd apps/backend skills list                                   # each skill's active version, origin, switch and fit
bun run --cwd apps/backend skills publish house-rules ../../house-rules/SKILL.md --surfaces web,live --activate
bun run --cwd apps/backend skills activate house-rules v1                # an earlier version becomes the active one
bun run --cwd apps/backend skills disable house-rules                    # or enable
bun run --cwd apps/backend skills reset shelf-finder                     # the product's default becomes the active version
```

`publish <name> <file>` reads a `SKILL.md`: its front matter's `name` (which must match) and `description`, and the instructions after it. `--surfaces` and `--requires-tools` take comma-separated lists, `--disabled` publishes it switched off, and `--activate` makes it the active version; a skill's first version is active either way. `enable` and `disable` publish the active version again with the switch flipped, so every change stays a version to go back to. A version the CLI publishes is marked `custom`; `list` shows each skill's origin.

Every replica serves the change within about 30 seconds. Adding, removing, redescribing or switching a skill makes the next typed turn of each kind a new agent version; changing only its instructions does not, since they are read when the tool is called. Hardened, Cosmos DB's public listener is off: run it from a machine inside the network, as for the persona.

## The agent on Foundry

The agent's versions and its memory store live in the Foundry project, and the deploy's job keeps them in step with the code:

- **Versions.** A version holds the guardrails, the persona, the channel instructions ([the per-channel instructions](architecture.md#a-typed-turn) in `apps/backend/src/product/surface.ts`, written for typed turns and spoken for voice), every tool (the skill reader and the skills it lists among them) and the reasoning settings. Editing any of them (the persona, a skill's listing, or the `guardrails`, `tools` or `agent` document) makes a new version on the next turn of each kind. There is one kind per channel, one without web search for accounts that have spent their searches, and, for the voice agent, one per engine in use. A version is found again by the hash of its definition: first in the replica's memory, then in the cache all replicas share in Redis, then in the service's listing of the agent's versions. Since that listing can trail a version just made, the version numbers past the newest listed are then read one by one. The job runs without Redis, so the backend's start finds the job's versions this last way. Two versions of one definition, if two processes ever make them, run the same words and tools, and the job's pruning removes the older. The job's `agent` step keeps the newest `agent.foundry.keepVersions` (10), and each voice engine's current version however old, and deletes the rest; a replica still on a deleted one makes it again. Nothing about a person is in a version.
- **The memory store** (`person-memory`, preview) is made by the job once, while the `agent` document's `memory.store` is `foundry` (the default), with the `small` chat deployment for extraction and the `embedding` deployment. Its own options (`agent.memory.foundry.chatSummary`, `procedural`, `ttlSeconds`) are read only when it is made: to change them, delete the store in the portal — which forgets everything it remembers about everyone — and run the job. Switching `memory.store` is a portal edit and a backend restart; nothing moves between the stores ([configuration](configuration.md#agent)). What the store you leave behind remembered stays in it, unseen. An account's erase forgets it from both stores; for everyone else it is yours to remove, by deleting the `person-memory` store in the portal when leaving `foundry`, or the documents of the `memory` container when leaving `own`.

## Rotating secrets

The session secret and the Entra client secret live in the azd environment and are written to Key Vault by every provision; the apps reference the latest version.

```sh
azd env set AUTH_SECRET "$(openssl rand -hex 32)"      # or AUTH_MICROSOFT_ENTRA_ID_SECRET
azd provision
az containerapp revision restart --subscription <AZURE_SUBSCRIPTION_ID> -g <rg> -n <frontend app> --revision <active revision>
az containerapp revision restart --subscription <AZURE_SUBSCRIPTION_ID> -g <rg> -n <backend app> --revision <active revision>
```

Container Apps picks up a changed Key Vault secret on its own within about 30 minutes; the restarts make it immediate. Rotating `AUTH_SECRET` signs everybody out (the session cookies no longer verify), and between the two restarts requests fail with 401 because the frontend and the backend disagree. If a pipeline deploys, run `azd pipeline config` again so it carries the new value, or the next run writes the old one back.

## Checking what it costs

[Cost](cost.md) gives list prices and a worked estimate. On a deployment, check the figures it assumes:

- **Tokens per typed turn.** Every model call writes an `llm_usage` line with its `kind`, model, and input, cached and output tokens; the query *Tokens per model deployment, per hour* in [monitoring](#monitoring) sums them.
- **Tokens per voice minute.** A live session's line (`kind` voice) carries only each response's total input and output tokens, not the audio, text and cached split the meters bill, so measure voice from the bill. Hold a timed session on a deployment nobody else uses, then read the next day's quantities per meter in Cost Management (or the voice agent's traces, which carry estimated-cost attributes) and divide by the minutes. The same bill shows which Voice Live Speech meter applies.
- **The Agent Service's Cosmos DB throughput.** `az cosmosdb sql container throughput show` on the `enterprise_memory` containers says whether the service set standard or autoscale throughput.
- **Memory meters.** In demo mode, look on the bill for the Foundry Agents memory meters [cost](cost.md#memorys-cost) lists.

## Scaling

The replica floors are azd variables (`azd env set BACKEND_MIN_REPLICAS 2`, then `azd provision`). The other Bicep parameters named here (`backendMaxReplicas`, `frontendMaxReplicas`, `searchSku`, `redisSku`) have none: add an entry for the one you change to `infra/main.parameters.json`, then `azd provision`.

| Knob | Where | Notes |
| --- | --- | --- |
| Backend and frontend replicas | `BACKEND_MIN_REPLICAS`/`backendMaxReplicas`, `FRONTEND_MIN_REPLICAS`/`frontendMaxReplicas` | Each app scales out at 14 concurrent requests per replica. For many people arriving at once, raise the minimum: the scaler reacts in about a minute. Zone redundant, the minimum is at least two. |
| Model throughput | The `capacity` of `chat`, `smallChat` and `embedding` in `infra/main.parameters.json`'s `models`; `REALTIME_CAPACITY`, `REALTIME_ALTERNATE_CAPACITY` and `KNOWLEDGE_BASE_CAPACITY` for the other three, whose `capacity` in the file is overwritten | The usual first ceiling: a 429 from Azure OpenAI is retried per `llm.retry`, then fails the turn. |
| Model calls in flight per replica | `llm.concurrency.*` | Calls over the cap wait. |
| Steps per turn | `agent.foundry.maxSteps` | Each round trip through the backend's tools is one response. |
| Cosmos DB | `ZONE_REDUNDANT`, at creation only | Serverless in the demo; provisioned with autoscale on `app` and the Agent Service's containers when zone redundant. The mode cannot change on an existing account ([deployment](deployment.md#changing-an-existing-environment)). |
| Search | `searchSku`, `SEARCH_REPLICAS` | One partition; one replica, two when zone redundant. Raise `SEARCH_REPLICAS` for query throughput, and to three where indexing must also survive a replica's loss. |
| Redis | `redisSku` | Azure Managed Redis, one unsharded database. Every key carries a TTL; the eviction policy is `VolatileLRU`. A larger SKU is taken in place; the service does not scale down, and replication (`ZONE_REDUNDANT`) once on stays on. |

## Backups and recovery

| Data | Protection |
| --- | --- |
| Cosmos DB | Continuous backup with 7-day point-in-time restore (`az cosmosdb restore`): the accounts, the persona and the skills, and the conversations — their index and their history. Zone-redundant when hardened. |
| Foundry project | No backup of the memory store's statements or the agent versions. The versions are derived: the job makes them again from the code. What the memory store remembers is not; on the own store it is in Cosmos DB's backup above. |
| Blob Storage | Soft delete for blobs and containers, 7 days. ZRS when hardened. |
| AI Search | No backup. The index is derived: its content comes from your libraries (and the sample library in the image). To rebuild a library, `ingest.sh --remove <name>` then load it again. |
| App Configuration | Revision history of every key; soft delete of the store, 1 day. |
| Key Vault | Soft delete, 7 days; purge protection when hardened. |
| Redis | None needed: it holds rate-limit buckets, claims and cached copies, and every use of it names a fallback. Losing it loses live sessions' records and the forget requests still being finished, not people's data. |

Hardened, `CanNotDelete` locks guard the data resources against an accidental delete; `predown` lifts them for `azd down`, and takes the Agent Service's capability hosts down before the account.

## Erasure requests

A person erases their own account from **Settings**; nothing in the deployment erases one on an operator's behalf. Under `entra` that is enough, because the person can always sign back in to do it. Under `local` it is not: nobody can return to a local account once its session ends, and there is no operator path for one account. Agent on Azure has no operator control for erasing an account, and the migrate job cannot run the erase: it has no access to Redis, where the erase verifies every cached copy is gone. A demo deployment's leftover local accounts go only with the deployment, `azd down --purge`. This is one reason never to put real people on `local` ([privacy](privacy.md#known-gaps)).

## Teardown

`azd down --purge`; see [deployment](deployment.md#clean-up).
