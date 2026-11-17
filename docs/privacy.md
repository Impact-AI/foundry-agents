
# Privacy

This page tells the organization that deploys Agent on Azure what the software stores about a person, where and for how long, and how a person gets a copy or has it erased, so it can write its own notice. The organization is the controller. The app ships a plain-words notice at `/privacy` (`apps/frontend/app/privacy`, text in the frontend's message catalogs) that says the same things; keep the two in step when you change what is kept.

## What is stored

| Data | Where | Kept until |
| --- | --- | --- |
| The account: the sign-in's object id (random for `local`), email, display name, app roles, groups, whether it may still be used, sign-in times, and for a voice tester the voice tuning they saved ([configuration](configuration.md#who-tunes-voice)) | Cosmos DB, container `accounts` | The account is erased; its document is then emptied and removes itself eight hours and eleven minutes later (see **The account after an erase** below) |
| What the person wrote about themselves: the name the assistant calls them, "about you", "how to talk to you" | Cosmos DB, on the account's document | They clear it, or the account is deleted |
| Conversations: typed messages, what was said in a live voice session as text (the person's words as the service transcribed them and the assistant's spoken answers, written when the session ends), the model's tool calls and their results, and its reasoning (summaries, and the encrypted reasoning the model is given back) | Cosmos DB, in the deployment's own `app` database (`own`, the default) or the Agent Service's `enterprise_memory` database (`foundry`); see **Where conversations are kept** below | The conversation or the account is deleted. On `foundry`, the service keeps its own copy for up to 60 days (see below) |
| The index of a person's conversations: each one's title, when they last spoke in it and where its messages are kept | Cosmos DB, containers `threads` and `threadIds` | The conversation or the account is deleted |
| What the assistant remembers: short statements a model picks out of the person's conversations, about a minute after they talk | Foundry Agent Service's memory store (`foundry`, the default) or Cosmos DB (`own`); see **Where memories are kept** below | The person removes one or forgets them all, or the account is deleted (see below) |
| Cached copies, rate-limit counters, queues and live-session state keyed by account id (see **What Redis holds** below) | Redis, every key with a TTL | The TTL, from seconds to seven days (a minute for most caches, an hour for a thread's owner, seven days for the queues); the caches also go when the account is deleted |
| Pictures the person attaches | Sent to the model as input to that one turn; a copy stays in the browser (see **Pictures** below) | Not kept by the app. On `foundry`, the service's own copy stays until its time to live ([limitations](limitations.md)). The browser copy: see below |
| Web searches (on by default; switched off in the [`tools`](configuration.md#tools) document) | **Not stored by the app.** The Agent Service's web search tool sends the search words it chooses (which can carry what the person asked about) to Microsoft Bing, outside the deployment's Azure compliance boundary, under Grounding with Bing's own terms. The pages cited are part of the answer, and so of the conversation. | Bing's terms |
| Voice audio | **Not stored, anywhere.** The backend relays it in memory, and every session is opened with `store=false` (see **Voice audio** below). The words are kept as conversation text (above). | — |
| A live voice session while it runs: who it is for, which conversation, and what has been said so far, as text | Redis, under the session's keys | Written into the conversation when the session ends, then deleted; the rest of the session's keys expire within minutes. Every key carries a TTL of at most the session's ceiling plus ten minutes, so nothing outlives a session that was never ended |
| Operational logs and traces, and each Azure resource's own diagnostic logs, which record requests' metadata as the service defines it. For Cosmos DB that can include a request's partition key, which for a person's containers is the account id | Log Analytics, Application Insights | 30 days |
| Only with `AGENT_TRACING=true` ([configuration](configuration.md#deployment-parameters)): the Agent Service's own traces of each typed turn, which hold what the person asked, what the model answered, and each tool's arguments and results | Application Insights and its Log Analytics workspace | The workspace's retention, 30 days as deployed. Neither deleting a conversation nor erasing the account removes them |
| Only if the organization installs and switches on the [Impact SDK setup plugin](impact-ai.md#impact-ai-control-plane): traces of the instrumented calls, by default with their inputs, outputs and tool results | Impact AI's service, outside the subscription | Impact AI's terms. Neither deleting a conversation nor erasing the account reaches them |
| Behind Front Door (hardened mode, or `USE_FRONT_DOOR=true`): Front Door's access log and its WAF log, each request's client IP, URL, user agent and outcome | Log Analytics | 30 days |

**The account after an erase.** The account's document is emptied of everything but the id and when it was erased. It removes itself eight hours and eleven minutes later (Cosmos DB's per-item time to live): the longest a session lasts, the life of the last assertion such a session can mint, and a minute for the clocks. Until then, it is what refuses a session that began before the erase.

- A sign-in under the same id before then makes a new account of it. That account keeps the time of the erase, and of that sign-in, for the same eight hours and eleven minutes and no longer.
- A deactivated account that is erased leaves its document behind for good, emptied of everything but the id, the deactivation and when it was erased, so that erasing cannot hand a deactivated person their access back. Nothing is written onto it afterward, by the person's own session or by a sign-in.
- The container must keep lifetimes for its documents for the emptied document to remove itself. The backend checks that at its start, and the template sets it. A document left past its time all the same is ignored by every read.

**Where conversations are kept.** The `agent` document's `history.store` ([configuration](configuration.md#agent)) decides, as it was when the conversation was started:

- `own`, the default: Cosmos DB, container `messages`, one document per message, in this deployment's own `app` database. Nothing is kept in the Agent Service: every response runs with `store: false`.
- `foundry`: the Agent Service's conversation, one per thread, in the project's `enterprise_memory` database on this deployment's Cosmos DB account. The time of each shown message and the id of each response are kept on the thread's index entry. When a conversation is deleted, the service's own copy of what the delete removes stays, marked not deleted, until the run-state container's 60-day time to live. A conversation expires 60 days after it was started ([limitations](limitations.md)).

**Where memories are kept.** The `agent` document's `memory.store` ([configuration](configuration.md#agent)) decides:

- `foundry`, the default: Foundry Agent Service's memory store (preview), scoped to the account id, in this deployment's project, where Microsoft's service extracts them. `memory.foundry.ttlSeconds` can also expire them.
- `own`: Cosmos DB, the `memory` container, one fact per document in the account's partition. A removal or a forget is final for what was already said. It leaves one document in the person's partition holding the account id and when it happened, nothing said before then is read again, and the document goes when the account is deleted.

**What Redis holds.** Every key has a TTL:

- cached copies of the person's fields and of what is remembered;
- rate-limit buckets and the live-voice seconds count, keyed by account id;
- the account id beside a thread id: in the queues of conversations waiting for memory extraction, a title or a forget's second delete; in turn claims; and in the cached record of who owns a thread;
- for a live voice session, who it is for and its transcript so far, which stay until their keys expire when the words could not be written to the thread;
- a five-minute mark after an account is erased.

The TTL is an hour for the record of who owns a thread, and up to seven days for the queues. The caches also go when the account is deleted (one the erase cannot reach expires within its TTL). The rest is not reached by an erase and expires.

**Pictures.** A picture is sent to the model as input to that one turn.

- On `history.store: own` it is written nowhere: the service keeps nothing (`store: false`), and the history keeps a marker in the picture's place.
- On `foundry` it enters the conversation with its turn. Once the turn has answered, its item and the response it went to are deleted through the API, as a best effort (`agent.history.picture_kept` when that fails). The conversation keeps the marker.
- A copy stays in the browser's IndexedDB so the conversation can show it again there. It goes when the conversation is deleted, the person signs out, or site data is cleared. A session that ends by expiring, or an account erased from another device, leaves that browser's copies until one of those.

**Voice audio.** Live audio goes from the browser through the frontend and the backend to the Foundry voice agent in Azure. The frontend and backend relay it in memory and never write it down, and the assistant's voice comes back the same way.

- Azure transcribes the person and synthesizes the assistant's voice through the Foundry account, within the processing scope Voice Live gives each, which can be outside the account's region ([below](#what-reaches-the-model)).
- On the [speech-to-speech](patterns.md#terms) engine (`voice.engine`, the default), the realtime model deployed in that account also hears the audio itself. Where a managed model is chosen ([below](#what-reaches-the-model)), the voice service's own model hears it instead, at its processing scope.
- Every session is opened with `store=false`, so the voice agent keeps neither the audio nor a conversation of its own.

Library documents may contain personal or confidential data; the deploying organization must assess their contents and permitted processing. Document and picture access is configured through `access.json` ([documents](documents.md)).

**Who else can read it.** The operator holds data-plane roles on everything above. The operator is the principal `OPERATOR_PRINCIPAL_ID` names, or else the one that provisioned. It can read and write the `app` database, read the Agent Service's `enterprise_memory`, and read the library's blobs and the index ([architecture](architecture.md#identities-and-roles)). The template gives nobody a role on the logs: whoever holds a reading role on the resource group or the workspace through the subscription's own assignments reads them. The product's own access rules bind the people who use it, not the operator. Who holds these roles is the organization's to decide and to tell its people.

**Logs are built to keep personal data out, with the exceptions below.** The rules here hold for what the apps write. Once `AGENT_TRACING` is on, the Agent Service also traces every turn with its words, on Microsoft's side of the apps, where nothing below applies ([limitations](limitations.md)).

- The `problem` and `llm_usage` lines carry codes, counts and timings only.
- Spans are scrubbed of path segments that look like ids, query strings beyond an allow-list, and caller attributes.
- A turn is correlated by an id minted for it, never by an account or thread id. An unhandled error is logged under its route, never its path.
- On a span, an error's message and stack lose their URLs' queries and userinfo, the values written under keys that name a credential, the rest of an `Authorization` or `Cookie` line, and addresses and tokens, in the forms the package's table names. A scrub cannot recognize a name or an id written into a sentence ([what is and is not covered](../platform/observability/README.md#what-the-text-scrub-covers)).
- Two things are not scrubbed: the text of an error a library or the service threw as a log line, which is logged as thrown (a log record's body is never put through the text scrub), and the browser's user agent, which the web-vitals line (`/api/vitals`) records beside each reading. The shipped notice's logs line names both, the diagnostic logs' account id, that the organization may switch on `AGENT_TRACING`, and that it may also send the logs to a monitoring provider it names in its own notice.

The larger exception is the edge. Front Door's access and WAF logs (`FrontDoorAccessLog`, `FrontDoorWebApplicationFirewallLog`) record every request's client IP address, URL and user agent, and the workspace keeps them for its 30 days. Azure offers no setting that leaves the client address out of either, and the WAF's log is what an attack is investigated from. So Agent on Azure keeps them, and the shipped notice says so. Its logs line names what Front Door records and for how long, in every deployment, because the frontend cannot tell whether Front Door stands in front of it.

**Why Agent on Azure keeps conversations itself by default.** The Agent Service writes a conversation's items into the deployment's Cosmos DB account (the `enterprise_memory` database, the project's run-state container). An API delete, of an item or of the conversation, removes it from what the API answers but not from that container. There it stays until the container's 60-day time to live, every document marked not deleted, with the message text, the reasoning items and a picture's base64 ([limitations](limitations.md), [decisions](decisions.md), decision 3). Microsoft's recovery guide does not support removing them by hand. So `history.store` is `own` unless an operator chooses otherwise: Agent on Azure keeps each conversation itself, where a delete and an erasure reach every word, and runs every response with `store: false`. An operator who sets `foundry` accepts that copy for the conversations started after the change. The job and the backend say so on every deploy and start (`agent.history.service_retention`), and the shipped notice says so too, by the same setting.

## What reaches the model

**A typed turn.** Each typed turn sends the following to Foundry Agent Service, in this deployment's own project, and through it to the model:

- the guardrails, the persona and the channel instructions (the per-channel instructions in `apps/backend/src/product/surface.ts`, see [architecture](architecture.md#a-typed-turn)), held in the agent's version and the same for everyone;
- the date;
- the person's name, "about you" and "how to talk to you";
- what is remembered about them, and when they last talked;
- one-line descriptions of what is on their screen, and the language;
- the conversation so far: on `history.store: own` from this deployment's own database, within the `agent` document's `history` bound, and on `foundry` from the service's own conversation, which the service truncates;
- passages retrieved from the library.

Where the chat's model processes them depends on its deployment's SKU ([configuration](configuration.md#the-models-parameter)): anywhere for `GlobalStandard`, the template's default, and within the data zone for `DataZoneStandard`. The shipped notice says that, as set up by default, Microsoft may process it in any of its regions.

On the knowledge base engine above `minimal` effort (`retrieval.reasoningEffort`), the words a search is asked with also reach the knowledge base's planning model, and they can carry what the person asked about. That model is a deployment in the same account ([configuration](configuration.md#the-knowledge-bases-planning-model)), which the search service calls to split the words into sub-queries. Where it processes them depends on its deployment's SKU, as for the chat's model.

**A live voice session.** A live voice session is given the same blocks. They are the structured inputs of the voice agent's session, sent from the backend and never through the browser. Every answer it speaks is the agent's, on its `live` version.

- On the default speech-to-speech engine, the realtime model deployed in the same account hears the person's words as audio, and receives the same blocks.
- When an operator chooses the [cascade](patterns.md#terms), the person's words go to the chat's model as text, as the service transcribed them.
- Where the realtime model processes the audio depends on its deployment's SKU, as for the chat's: anywhere for `GlobalStandard`, within the EU data zone for `DataZoneStandard` ([configuration](configuration.md#the-realtime-deployment)).

Speech is processed apart from either model, on both engines. Voice Live gives speech recognition and HD speech synthesis processing scopes of their own, and "Processing can occur outside your resource region" ([Speech regions, Voice Live](https://learn.microsoft.com/en-us/azure/ai-services/speech-service/regions?tabs=voice-live)). In Sweden Central and France Central the premium tier's HD voice is Regional, and `mai-transcribe`, the default transcriber on both engines, is Data zone. The region table gives no scope for `azure-speech` (a cascade's alternative) or the standard voice, so Agent on Azure treats them as possibly processed outside the region ([limitations](limitations.md)).

By default the voice agent runs on the account's own deployments. A managed voice-agent model is opt-in ([decisions](decisions.md), decision 25): an operator may name one per engine in the `agent` document (`voice.managedModel`), and a voice tester may choose one for their own sessions. Then the model that hears or reads the person's words is the voice service's rather than one deployed in this account. It processes them at the scope Voice Live gives that model in the resource's region ([configuration](configuration.md#managed-voice-models)):

- Global for the plain realtime names, which can be outside the account's region and outside the EU;
- the data zone for the `-datazone` names;
- by region for the text models.

No voice-agent page states the scope for a voice agent's version.

A deployment that opts into the Voice Live API directly runs on a model Voice Live hosts: in demo mode `gpt-realtime-2.1` or, on the cascade, `gpt-5.4`, both Global; in hardened mode `gpt-realtime-2.1-datazone` or `gpt-5-mini`, both within the data zone in Sweden Central ([configuration](configuration.md#voice-runtimes)).

**After the turn.** Its words (what the person said and what the assistant answered, never a picture) go to whichever memory store `memory.store` names:

- the Foundry memory store, whose model (the small one) picks out what to remember after `memory.updateDelaySeconds`; or
- the own store: after that delay, the words are read back from this deployment's database with what is already remembered, and sent once to the small model, which answers the list of facts to keep. Only what it attributes to the person, as a fact about them or a lasting preference, is kept, never an instruction they gave for one conversation.

A turn the content filter blocked reaches neither store, typed or spoken (in a live session, the person's lines that led to an answer the filter stopped). It stays in the conversation, and no extraction reads it. What is remembered reaches the model in the personalization part, framed as information about the person and never as instructions. Titles are written by the small model from the conversation's lines, typed and spoken, never from one the content filter blocked.

How the service and the models handle that data, including abuse monitoring, is Microsoft's: see [Data, privacy, and security for Azure OpenAI](https://learn.microsoft.com/legal/cognitive-services/openai/data-privacy) and the Foundry Agent Service documentation.

## A person's rights

Settings provides the self-service controls below. They do not cover every store or every data-rights request; the deploying organization must also provide the request process described after the table.

| Right | How | What happens |
| --- | --- | --- |
| Access and portability | "Download a copy" (`GET /account/export`) | One JSON file (`personal-data-export/3`), streamed: the account with the person's fields and the memories in the active memory store, and every conversation with its messages as the person saw them (the words, and a marker for each picture). The tool calls, their results and the model's reasoning, which the history also stores, are not in the file. |
| Rectification | Edit the fields; correct, remove or forget what is remembered, a statement at a time | A corrected statement is the person's words, and what later extractions start from. |
| Erasure | Delete the account (`DELETE /account`), after a confirmation | The account is shut at once, then the application-managed data is swept in order, subject to the retention and service exceptions below (see **Erasure** and **Known gaps**). |

### Requests beyond the self-service controls

The deploying organization must publish a contact and assign an operator to handle requests that the download, correction and deletion controls do not cover. This is an organizational process to establish before launch, not an additional workflow implemented by this repository.

1. Verify the requester and the relevant account without disclosing another person's data. Identify which history and memory stores, logging destinations and optional integrations have been used, including any earlier memory store.
2. For an access request, check relevant personal data outside the standard download: stored tool calls and results, logs, external traces and memories in a previous store. Assess what must be supplied and protect other people's data and confidential information; the download is not a complete response by itself.
3. For correction, forgetting or erasure, handle the relevant stores and providers under their supported procedures and the organization's applicable retention obligations. The account-deletion process is designed to clear both memory stores; the settings controls for individual memories and the standard export read only the active store. Do not claim that deleting an account removes external traces, backups or service-retained copies immediately.
4. Record what was handled, any remaining retention and its reason, and the response sent to the requester. Keep the deployment's notice aligned with the actual services and periods. Verify deletion and access behavior on the deployed release separately from this written procedure.

**Erasure.** Deleting the account runs these steps in order:

1. The account's document in Cosmos DB is emptied of the person's words and everything else but the id, and shut, in one write that lands whole or not at all. From that write, no session is admitted under the id, no sign-in makes an account of it and no edit lands on it, so nothing is made under it while the rest is swept.
2. Every conversation: every message of its history, then its index entry and its claim. On `foundry`, every response the index entry recorded, then each item, the conversation and any conversation it replaced are each deleted through the API. A failure other than "already gone" stops the erase before the index entry goes.
3. Everything remembered under the account, on whichever store holds it.
4. Every cached copy, dropped and read back.
5. The document's last write, which leaves the id and the time (see [What is stored](#what-is-stored)).

If an erase fails or stops part way:

- Each step is idempotent, and a failure is reported (`backend.erase.incomplete`). An erase that stopped part way leaves the document shut. Asked again, by the session that asked or any other from before, it is swept again and finished. The person's next sign-in does the same before it is admitted, so an erase is never left half done behind a new account.
- The web app's settings page, opened on a session whose account an erase has shut, shows nothing of the person and offers the delete again in place of the settings. So a person who reloads or comes back after an erase that stopped part way finishes it from there. The page says so, and the failed delete's own message says that part may already be gone.
- One request sweeps at a time, renewing its hold while it does. A second request while the first is sweeping waits for it and starts no sweep of its own. An erase whose process stopped renewing is taken up five minutes after its last renewal. A sweep that lost its hold, because its process was frozen that long, stops at its next step.
- An erase whose sweep keeps failing leaves the id shut, so the person cannot sign in under it, for as long as the failure lasts. A cached copy that cannot be dropped does not stop the erase, and expires within its time to live (a minute, or five for the newest conversation).
- Asked again after it finished, the session gets the same answer and nothing is done a second time, until somebody signs in under the id. From then on the request is refused. The account that sign-in made is never reached by a session from before it, neither its document nor a sweep, even one whose request was already under way.

What happens to sessions and the browser:

- The browser's picture copies go at sign-out. The erase signs out the browser that asked and ends no other session.
- A turn on a thread, streaming or still being put together, is ended before the thread is deleted, on whichever replica it runs. It is told through Redis and waited for, five seconds at most. A turn that outlasts the wait writes nothing, and a turn on a replica that cannot reach Redis is not told.
- Every message under the account is swept whether or not a thread still names it.
- A session that began before the erase is over, for a deactivated account as much as an active one, and also on an account made since and then deactivated. Every later request under it (a typed turn, a live voice start, a read or an edit) is refused `401 account_erased`.
- So is a request admitted before the erase whose body arrives after it. Every request that may write is read again once its body has arrived, before any route runs, and refused unless the account is still the one it was admitted on. So no edit, forget, rename or delete from a session that began before the erase reaches the account a sign-in made since.
- A turn or a live session checks again once it is counted as running, and before each write it makes. What it wrote after its thread went, or after the account was erased, is taken out again, with the thread it made.
- The web app signs that browser out. A request whose account cannot be read is refused rather than let through (`503 account_unavailable`).
- A session that began within a minute before a sign-in that immediately followed the erase is admitted with that sign-in's own, because the two clocks cannot tell them apart.
- A live voice session already open when the erase runs is not cut off, but nothing it says is kept. The final write that saves what was said when the session ends finds the account erased or its thread gone, and writes nothing. A final write already under way as the erase ran takes out again what it wrote.

**Deleting and forgetting.** Deleting one conversation removes every message of its history, from whichever store holds it, then its index entry. Removing a statement, or forgetting all of them, removes it from the store in use. After an operator has changed `memory.store`, what the other store remembered before the change stays in it. There the person can neither see nor forget it, and no export carries it; deleting the account removes it, from both stores.

Forgetting is final although both stores extract after a delay, each in its own way:

- **On the Foundry store**, an update still waiting when the person forgets would write its statements back into the emptied scope. So each update the backend hands over is kept in Redis until it must have settled, and a forget looks every one up. When one has not settled, the scope is deleted at once and nothing remembered is shown. A background purge then deletes the scope again once every update queued before the forget has settled (`agent.memory.erase_overdue` if one has not within an hour). Anything said in those minutes is forgotten with it. Without Redis (a bare checkout), nothing is kept to wait for and the race is open.
- **On the own store**, a forget drops every wait queued for the person and moves a floor: a document in the person's own partition holding when they last forgot or removed a statement. An extraction reads nothing said before the floor, so a later turn in the same conversation does not bring a forgotten statement back. It writes only while the floor it began under is still the one there. It checks before it writes and again after, so one that landed in between deletes what it wrote. The floor is in Cosmos DB, so it holds on every replica with or without Redis.

## Cookies and browser storage

Everything stored is strictly necessary or chosen by the person, so there is no consent banner:

- the Auth.js session cookie, and Auth.js's own short-lived cookies for a sign-in in progress (its CSRF token, the page to return to, and the state of an Entra sign-in);
- a cookie for the language and one for the text size;
- IndexedDB `sent-images` for the person's own pictures;
- `workspace.guideSeen` in local storage, so the tour does not start again.

There is no analytics or advertising storage. Adding any would change that.

## Telling people it is an AI

The interface says so in four places, because a first interaction can start at any of them: the sign-in page, the conversation's first line, under the composer, and on the voice panel (the `ai` block of each catalog). `apps/frontend/ai-disclosure.test.ts` fails if one of them loses its disclosure. The guardrails tell the model to say it is an AI when asked and never to pretend to be a person. The voice has no spoken introduction: the notice is the interface's, wherever voice is offered.

## What the service generates

The assistant's typed answers are text the model wrote, shown as the assistant's. Its spoken answers are audio Azure synthesizes.

**Machine-readable marking of live voice is not implemented by this application.** The assistant's voice is synthesized by Azure and relayed to the browser by the backend, which passes it on unaltered and adds no machine-readable marking. Whether the selected Azure service provides marking at source has not been verified. The interface discloses that the assistant and its voice are AI-generated; that disclosure does not establish that machine-readable marking requirements are met. Assess the obligations applicable to the deployed product, including AI Act Art. 50, and verify the selected services and any additional implementation before making a compliance claim.

## Known gaps

| Gap | Note |
| --- | --- |
| Backups outlive an erasure | Cosmos DB's continuous backup (the account, and the conversations: their index and their history, and what is remembered on the own store) keeps erased data for up to 7 days. Say so in your notice. |
| The Foundry memory store is a preview service | With `memory.store: "foundry"` (the default), its extraction, its correction semantics and how it erases a scope are the service's, and can change before it is generally available; one store serves at most 100 accounts ([configuration](configuration.md#agent)). Check on a deployment that an erase leaves nothing behind ([testing](testing.md#what-only-a-deployment-proves)). |
| `local` accounts cannot be erased by their owner after the session ends | Nobody can sign back in to a local account, and no operator can erase one; see **Local accounts** below. Use `local` only for trying Agent on Azure, never with real people's data. |
| A conversation on the Agent Service outlives its delete in the service's storage | With `history.store: "foundry"`, what an API delete removes stays in the project's run-state container for up to 60 days (see **Agent Service storage** below). Keep `own` for real people's data unless your notice says this. |
| Speech can be processed outside the account's region | Voice Live's speech recognition and HD synthesis have processing scopes of their own: Data zone for `mai-transcribe`, Regional for the HD voices, and not stated in the region table for `azure-speech` and the standard voices ([above](#what-reaches-the-model), [limitations](limitations.md)). Say so in your notice if it promises a region. |
| A managed voice model processes outside this deployment's models | Off by default; with one, the person's speech reaches a model the voice service runs (see **Managed voice models** below). |
| A voice's fillers are written by a model the voice service runs | While a tool call runs, the conversation reaches a model outside this deployment's own deployments (see **Voice fillers** below). |
| Personal noise suppression would enroll the person's voice | Not the default; an operator who chooses it needs a legal basis and a DPIA (see **Personal noise suppression** below). |
| What is remembered outlives a deleted conversation | A statement picked out of a conversation stays until the person removes it or forgets them all. |
| No retention limit | Conversations are kept until the person deletes them. Add a retention job if your policy needs one. |
| Live voice audio is not marked as synthetic | AI Act Art. 50(2): not built, [above](#what-the-service-generates). |
| The voice agent is a preview service | Its transcription, its handling of `store=false` and its regions are the service's, and can change before general availability; check on a deployment that a session leaves nothing on the service ([testing](testing.md#what-only-a-deployment-proves)). |

**Local accounts.** Nobody can sign back in to a local account, so its owner can delete what was said under it only before the session ends. The notice says so under `local`, and the sign-out page does too. **There is no operator path for one account**: Agent on Azure offers no operator action to erase one, and the migrate job cannot run the erase, because it holds no access to Redis, where the erase verifies the caches are gone. What stays is cleared only with the deployment (`azd down --purge`).

**Agent Service storage.** With `history.store: "foundry"`, what an API delete removes stays in the project's run-state container, marked not deleted: the message text, the reasoning and any input image. It stays until the container's 60-day time to live, and Microsoft's recovery guide does not support removing it by hand ([limitations](limitations.md)). Erasure is complete in what the API answers, but not in that container.

**Managed voice models.** `voice.managedModel` is empty, and no version names a managed model unless an operator writes one or a voice tester chooses one for their own sessions. With one, the person's speech reaches a model the voice service runs, at Global scope for the plain realtime names ([above](#what-reaches-the-model)). The shipped notice says a managed model may process speech in any of Microsoft's regions. An operator who adopts one for everybody, or who promises a region, says which in their own notice.

**Voice fillers.** While a tool call runs, the voice says a short line that the service's own model writes from the conversation so far (`llm_interim_response`, [decisions](decisions.md), decision 6). So the conversation reaches a model outside this deployment's own deployments: `gpt-4.1-mini` by default per the [Voice Live API reference](https://learn.microsoft.com/en-us/azure/ai-services/speech-service/voice-live-api-reference-2026-07-15). Agent on Azure assumes it can process outside the region, so the shipped notice says it may process the conversation in any of Microsoft's regions. A tier given an OpenAI voice, and a tester who switched the fillers off, send it nothing.

**Personal noise suppression.** `voice.noiseReduction` is `azure_deep_noise_suppression_headset` by default, which keeps the close speaker over background noise and enrolls nobody. `azure_personal_noise_suppression` personalizes after an automatic speaker enrollment, which derives speaker data from the person's voice. Agent on Azure assumes that data may outlive the session ([limitations](limitations.md)).

- Speaker data derived from a voice to single out one person is likely biometric data. GDPR Art. 4(14) defines biometric data as personal data from specific technical processing of a person's physical or behavioral characteristics that allows or confirms their unique identification.
- Art. 9(1) makes it special-category data when processed to uniquely identify somebody, which a model that keeps one speaker's voice over every other's arguably does. The AI Act's own definition (Art. 3(34)) is the same in substance.
- Processing it systematically, through a new technology, meets the criteria under which a data protection impact assessment is expected (Art. 35; the EDPB's criteria list sensitive data and innovative technology).

That is why it is not the default. An operator who chooses it needs an Art. 9(2) condition (in practice, explicit consent) and a DPIA before it reaches anybody, and adds it to the notice. The shipped notice does not mention it.
