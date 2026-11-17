# Decisions

This page explains why Agent on Azure is built the way it is. Read it when you want the reasoning behind a choice, what was set aside and what remains unverified, before you change that choice or adapt around it.

Each section gives the decision in one line, the why, what was rejected where it matters, and what limits it or what to check on your deployment. A Microsoft Learn page is cited inline wherever the decision rests on one. Where a decision rests on observed behavior instead, the section says so and states what Agent on Azure assumes; verify it on your deployment before relying on it.

## 1. Voice is a separate Foundry voice agent, not Voice Live agent mode on the chat agent

**A live session talks to a Foundry voice agent (`kind: "voice"`, preview) that holds the prompt and the function tools itself. It is a second agent definition written from the same prompt parts as the typed agent, and it consults no other agent. Which engine answers is a setting, the `agent` document's `voice.engine` (per tier, `voice.engineByTier`). `speechToSpeech`, the default, names the Azure OpenAI realtime deployment the template makes from `models.realtime`; `cascade` reasons on the `chat` deployment, with the person transcribed and the answer spoken. Each engine is a version of the one voice agent, and a session asks for its engine's version.** See [Voice](architecture.md#voice) and [the voice package](../platform/voice/README.md).

**Why.** A voice agent consulting the chat agent as a sub-agent does not work here: the person's structured inputs do not reach the sub-agent, and no backend tool is called inside a consultation, since every call is a forward to the sub-agent. Agent mode (Voice Live in front of the text agent) answers `401 PermissionDenied` to a backend principal that holds Foundry User on the project only. That reads as a missing role, not a limit of the service. Microsoft documents connecting Voice Live to an existing text agent ([Compare and migrate to Foundry voice agents](https://learn.microsoft.com/en-us/azure/foundry/agents/how-to/migrate-from-voice-live), [How to build a voice agent](https://learn.microsoft.com/en-us/azure/ai-services/speech-service/how-to-voice-agent-integration)), and the how-to says to assign the Foundry User role without stating the scope. Agent on Azure makes no assumption about whether agent mode needs the role at account scope, because it doesn't use agent mode. A voice agent version with the product's own function tools and `{{personalization}}` as a structured input carries both the inputs and the calls with no consultation.

**Rejected, and what still stands against agent mode.** Agent mode has no structured inputs, and "The `instructions` property isn't supported when you're using a custom agent" ([Voice Live how-to](https://learn.microsoft.com/en-us/azure/ai-services/speech-service/voice-live-how-to)). So the person's part could only go in as a developer item written into a service-side conversation, which decision 3 avoids, and the docs say nothing about whether such an item reaches the agent's model. A fourth option not taken: Voice Live in model mode with a `foundry_agent` tool, the "chat-supervisor" pattern of the [Voice Live API reference, version `2026-07-15`](https://learn.microsoft.com/en-us/azure/ai-services/speech-service/voice-live-api-reference-2026-07-15).

**Why [speech-to-speech](patterns.md#terms) is the default.** A spoken conversation is judged first by how soon it answers. The [cascade](patterns.md#terms) transcribes the person before the model starts, which a person hears as a pause on every turn. Speech-to-speech is the service's own architecture for a realtime model ("Native speech-to-speech", [Configure a voice agent](https://learn.microsoft.com/en-us/azure/foundry/agents/how-to/configure-voice-agent)): the model hears the audio itself. It costs a second model, which answers spoken turns differently from typed ones, a deployment in one of the regions that offer it, its own quota, and more per minute, since realtime audio tokens are priced above text. The cascade stays a setting, and the fallback: one model for typed and spoken turns, with no deployment, quota or region of its own. `preprovision` refuses a region that does not offer the realtime model rather than letting the provision fail late; without the deployment, the cascade runs and the job and the backend say so.

**What is known.** Both engines work in hardened mode: a session opens on the backend's Foundry User role on the project alone, with the account's public access off. Agent on Azure assumes the realtime deployment is reached behind the private endpoint; this is observed behavior, so verify it on your deployment ([limitations](limitations.md)). Nothing in Agent on Azure depends on agent mode's role scope.

## 2. One voice path: the browser's WebSocket to the backend, the backend's to the voice agent

**The browser opens one socket to the frontend's origin, relayed to the backend under the caller's assertion; the backend opens the voice agent's socket with its managed identity and relays the audio both ways. Only the backend talks to Foundry.**

**Why.** A hardened account with public access off cannot be reached by a browser at all. A browser socket cannot carry an `Authorization` header either, so a browser talking to the service directly would hold a token; Microsoft's guidance for that case is a backend that brokers the session ([Q&A](https://learn.microsoft.com/en-us/answers/questions/5974825/what-is-the-secure-way-to-use-azure-voice-live-ser)). The WebSocket transport carries the `session.update` the backend needs to state the person's language and voice. Over WebRTC from the browser that update is refused, possibly because of how the client opens the session rather than the service; the decision does not rest on it.

**Rejected.** WebRTC from the browser with its offer-first opening and SDP routes; a hold-to-talk relay engine on separate transcription and speech deployments; the browser or the backend speaking to an Azure OpenAI realtime deployment directly, in place of the voice agent (the voice agent's default engine does run on one, decision 1). The path decision stands on the credential and the hardened network alone.

**What to check.** After any change to the voice protocol, run the voice checks in [Acceptance scenarios](acceptance.md#voice-and-text-behave-the-same) end to end in a browser.

## 3. Conversation history: a setting, `history.store` — the deployment's own Cosmos container by default, the Agent Service's conversations as an opt-in

**By default (`own`) the backend keeps each thread's messages in its own `messages` container, bounded by the `agent` document's `history`. It gives every response that history as input with `store: false` and no service-side conversation, and account erasure deletes every document. With `foundry`, a new thread is made on a conversation of the service's, each response is stored in it, and a delete calls every delete the API has. Each thread records the store it was made in, so the setting decides only where new threads go.** See [Conversation history](architecture.md#conversation-history) and [configuration](configuration.md#agent).

**Why.** With conversations on the service, a conversation deleted through the documented API (every item, then the responses, then the conversation, each answered success) still leaves data behind. Every `item` document and its `item2conversation` edge stay in the service's run-state container, with the person's words and a picture's base64 in them. The API then answers 400 for the conversation, so the documented route cannot remove what is left. Those documents carry no `ttl` of their own; the container's `defaultTtl` is 60 days, so each expires 60 days after its own write. The retention is the container's, not a purge triggered by delete. A conversation expires `defaultTtl` after its creation, not after its last activity, because its header document is never rewritten, so a live conversation ends 60 days after it was made.

This is observed behavior, not a published limit. The Agent Service [FAQ](https://learn.microsoft.com/en-us/azure/foundry/agents/faq) says "Data persists unless you explicitly delete it", and [standard agent setup](https://learn.microsoft.com/en-us/azure/foundry/agents/concepts/standard-agent-setup) lists the containers without a retention period, so check the time to live on your deployment. The only published 60-day figure is for stored voice conversations and audio ([limits, quotas and regions](https://learn.microsoft.com/en-us/azure/foundry/agents/concepts/limits-quotas-regions)), a different store. A 60-day erasure window is not "without undue delay", and a 60-day life for a live conversation is a second reason not to keep the history there.

**Why `foundry` is still offered.** It is the service's own model of a conversation: the context is truncated by the service, and nothing is re-sent each step. A deployment whose notice can say what the service keeps may prefer it. It is opt-in and never the default because of the above. The job and the backend report `agent.history.service_retention` while it is chosen, the shipped privacy notice says it by the same setting, and an erasure on it is complete in what the API answers, not in the container ([limitations](limitations.md)). A thread records its store, rather than the process holding one as `memory.store` does. So a switch strands no thread and needs no restart, and every replica reads and erases a thread where it is.

**Rejected.** Granting the backend a data role on the service's container and deleting the orphans itself. That depends on the container's internal schema, and the [recovery guide](https://learn.microsoft.com/en-us/azure/foundry/how-to/agent-service-operator-disaster-recovery) says "Direct manipulation of data (such as trying to recreate the thread's records) in your `enterprise_memory` database isn't a supported action." Also rejected: making the service's conversations the default and deleting at erase, since the delete is the thing that does not work.

**What to verify.** Agent on Azure treats the 60-day time to live as observed behavior that may change, and doesn't change the container's `defaultTtl` on your Cosmos account; don't rely on changing it either.

## 4. Memory: a setting, `memory.store` — the Foundry memory store by default on a public deployment, the deployment's own store behind private endpoints

**The `agent` document's `memory.store` decides where what is remembered about a person is kept. The backend reads it at its first use of memory and holds it for the life of the process. `foundry` is the Agent Service's memory store (preview): one store, one scope per account, an update after each turn, and a forget that waits for every pending update to finish before deleting the scope again. `own` is a `memory` container in the deployment's own Cosmos DB database, one fact a document, extracted by one `small`-model call per thread once its turn has finished. Both implement one interface and feed the same `<person_memory>` block; Settings, export and erasure are the same routes.** See [Memory](architecture.md#memory) and [`agent`](configuration.md#agent).

**Why the Foundry store is the default.** It is the platform's built-in capability, and the design rule is to prefer Foundry's own. Its limits are real but bounded. [What is memory?](https://learn.microsoft.com/en-us/azure/foundry/agents/concepts/what-is-memory) sets *Maximum scopes per memory store: 100* with one scope per user recommended, so one store serves at most 100 accounts. Agent on Azure uses one store per project and assumes nothing about the 101st scope. `update_delay` is a documented debounce ([BetaMemoryStoresOperations](https://learn.microsoft.com/en-us/python/api/azure-ai-projects/azure.ai.projects.operations.betamemorystoresoperations), default 300); Agent on Azure assumes a pending update can still run after `delete_scope`. A pending update can write into the emptied scope; the backend closes that gap by tracking pending updates and deleting the scope again once they finish. The store can keep a fact its instructions exclude (where a person lives, for instance); that is the service's extraction, not Agent on Azure's.

**Why the own store is the alternative.** It removes the scope cap, the preview dependency and the delete-after-pending-update question. The cost is an extraction prompt of Agent on Azure's own and one small-model call per finished thread. Nothing migrates between the two stores.

**Why the default depends on the network.** In hardened mode the Foundry store remembers nothing, and nothing fails visibly. The account's diagnostic log holds the cause: the store's extraction calls the account's OpenAI data plane from a public Microsoft address. An account with `publicNetworkAccess: Disabled` answers that with 403, `Public access is disabled. Please configure private endpoint.`, and no other status. Microsoft Learn says so in one line under *Limitations* of [What is memory?](https://learn.microsoft.com/en-us/azure/foundry/agents/concepts/what-is-memory): "Virtual network (VNet) integration isn't supported for memory stores." Microsoft publishes no service tag or address list for the extraction, so the only setting known to work is the account's public access on, which private networking exists to avoid. So the template tells the backend and the job which network they are in (`PRIVATE_NETWORKING`):

- The compiled-in default and the seeded `agent` document say `own` on a private deployment and `foundry` elsewhere.
- On a private deployment, `preprovision` refuses `MEMORY_STORE=foundry` before anything is made, and a stored document naming it fails the job's `settings` step. Both report `agent.memory.store_unreachable_private` and say to set `own`. A refusal at deploy time is seen by the person who can fix it, while a run-time substitute is seen by nobody ([decision 26](#26-components-are-chosen-at-deploy-time-tuning-at-run-time)).
- A portal edit made after the deploy is still refused at run time under the same code, and the own store runs, because App Configuration is editable after any deploy.
- The backend's periodic purge check reports `agent.memory.extraction_stalled` for an update the service has not completed.

**Rejected.**

- Sharding across N stores by account hash: Agent on Azure assumes no store count per project beyond one, and re-sharding moves people.
- One store per account: the same unknown cap, and a store created on the sign-in path.
- A coarser scope shared between people: it breaks isolation.
- Disabling memory past 100 accounts.
- A fixed-template profile document rewritten each time: the Settings interface is statement-based, so facts are the one form.
- Removing the Foundry store outright: showing the platform's capability is what Agent on Azure is for.

**Limits.** Microsoft documents neither what happens past the scope cap nor what `delete_scope` does to a pending update. Both bear on the default's limits, not on the design.

## 5. Web search is the Agent Service's `web_search` tool; there is no Bing resource

**The typed agent's version carries `{ type: "web_search", search_context_size }`, the context size from the `agent` document's `webSearch.contextSize`. The tool is Microsoft-managed: the template declares no Bing resource and the project no `bing` connection, so the deployment holds no key at all. Citation markers are stripped from the text and the history. The channel instructions tell the model to answer in the step that searched, because the stored output of the call is always empty.** The channel instructions are the per-channel instructions in `apps/backend/src/product/surface.ts`, in a written register for typed turns and a spoken one for voice ([A typed turn](architecture.md#a-typed-turn)).

**Why.** Microsoft's [web tools overview](https://learn.microsoft.com/en-us/azure/foundry/agents/how-to/tools/web-overview) recommends `web_search` over Grounding with Bing. It takes `filters.allowed_domains`, the allow-list an operator wants, without a resource of the deployment's own, and the price is the same.

**Rejected.** `bing_grounding` on a Bing resource and an `ApiKey` project connection. If you adapt an environment that had them, a provision removes neither (Bicep's incremental mode deletes nothing), so delete them by hand.

**What is known.** The job's `agent` step publishes a version carrying `web_search` on the `chat` deployment, where a refused definition would fail the step. Whether the citations arrive as `url_citation` annotations, in demo or hardened mode, is untested; check it on your deployment before you rely on them.

## 6. Voice tools: web search and skills as the backend's own functions

**The voice agent's definition carries every function tool of the `live` channel, plus two of the backend's own. `webSearch` is a response on the `chat` deployment with the typed turns' `web_search` tool and `tool_choice: "required"`, capped by `webSearch.maxOutputTokens` and charged to the same bucket. `readSkill` returns the skill version a typed turn would pin.** See [Tools in a voice session](architecture.md#tools-in-a-voice-session).

**Why.** [Configure a voice agent](https://learn.microsoft.com/en-us/azure/foundry/agents/how-to/configure-voice-agent): server-side tools come through a toolbox, and "a voice-based agent can have individual tools or one toolbox, but not both". A toolbox would replace the [stage](patterns.md#terms) controls and the server tools. `VoiceAgentDefinition` in `@azure/ai-projects` 2.10.0 has no `skills` field.

**Rejected.** A toolbox (loses every function tool); no web search in voice.

**Cost.** A spoken answer that searches waits for a second model call: expect its first audio several seconds later than an answer from the thread.

**Mitigation.** The voice version carries `interim_response` with type `llm_interim_response` and trigger `tool`, the field meant for exactly this wait. The service's model writes one short line from the conversation (`INTERIM_INSTRUCTIONS` in `platform/agent/src/foundry/voice-definition.ts`), so it is in the person's language, varies from turn to turn and never claims a result. [Configure a voice agent](https://learn.microsoft.com/en-us/azure/foundry/agents/how-to/configure-voice-agent) documents both modes: `static_interim_response` picks from a list, and with `llm_interim_response` "a model authors the filler from `instructions`". The [Voice Live API reference, version `2026-07-15`](https://learn.microsoft.com/en-us/azure/ai-services/speech-service/voice-live-api-reference-2026-07-15) gives the generated one's model as `gpt-4.1-mini` by default, run by the service, and 50 tokens. A fixed list repeats itself across a session and speaks one language; the generated line costs a short model call the service makes before the search runs. A session's update carries none. A tier given an OpenAI voice, beside which the service refuses fillers, and a tester who switched them off run on a version without them.

**Alternative.** [Decision 22](#22-not-supported-every-voice-tool-in-one-foundry-toolbox) explains why putting every voice tool in one toolbox is not supported.

## 7. Reasoning effort and the thread so far reach a voice session through the protocol

**A session's reasoning effort goes in its `session.update`, which `VoiceAgentSessionUpdateConfig` carries and the definition does not. On the cascade that is the `agent` document's `reasoningEffort`. On speech-to-speech, the default engine, it is `voice.realtimeReasoningEffort`, sent only for a realtime model that reasons and never as `none`. The thread's history (words only, within the `history` bound) is added as `conversation.item.create` items under the backend's ids after the update, before the person speaks.**

**Why.** The SDK documents `conversation.item.create` as populating a history ([Voice Live API reference](https://learn.microsoft.com/en-us/azure/ai-services/speech-service/voice-live-api-reference-2026-06-01-preview)). The service echoes the items under the backend's ids and the voice answers from them, and the update's echo carries the effort sent. Which effort each engine is sent is in [architecture](architecture.md#voice).

**Rejected.** Reading the thread through a bound service-side conversation (decision 3 avoids them); a reasoning summary on the voice side (nothing to show it in).

**Known behavior.** The thread is given all or nothing. If the service refuses a line, the backend takes every line out again (`conversation.item.delete` by the backend's ids), logs `voice.live.history_refused`, and the session runs without the thread.

## 8. Pictures are served by the backend from private storage, never by a URL into storage

**The browser asks for `/api/media/{library}/{path}`, the picture's path inside its library at whatever depth. The backend reads that blob from its own account with its identity and streams it to a caller the picture's own readers admit. No SAS and no storage URL reach a browser; Storage is private behind a blob private endpoint when private networking is on.** See [Pictures](security.md#pictures).

**Why.** A query-string form carrying a blob URL trips the WAF's `RFI-931130` on the `url` argument, and carries a signed URL to the browser. Through Front Door the path form answers `401` from the frontend to an unauthenticated caller, where the query-string form is refused `403` by the WAF.

**Rejected.** SAS URLs with a stamp through an SSRF-pinned proxy; WAF exclusions for the `url` argument.

**What to check.** No automated test covers a picture drawn in a signed-in browser through Front Door. Check one by hand after a deploy.

## 9. Developer access is Bastion Basic plus an Entra-signed jump VM, opt-in

**`DEVELOPER_ACCESS=true` adds Azure Bastion (Basic) and a small Ubuntu VM in the network, with no public IP and no password. You sign in with Entra ID through the `AADSSHLoginForLinux` extension and *Virtual Machine Administrator Login*. It is billed while it exists ([cost](cost.md#optional-extras)).**

**Why.** Hardened mode closes every data-plane listener, so an operator needs a host inside the network; Bastion and a jump VM are what Azure's landing zones use. The Developer SKU is free but cannot sign in with Entra ID.

**Rejected.** A point-to-site VPN gateway with a DNS Private Resolver, which costs more than developer access ([cost](cost.md#optional-extras)) and needs a client on every laptop, set aside for a public sample. Opening one listener for the minutes a task takes, which the scripts still print as the one-off alternative. B-series VM sizes, which some regions cannot allocate.

**Limits.** Bastion Basic offers browser SSH only; a desktop tool needs the Standard SKU's tunneling. No automated test covers a sign-in through the portal's Bastion connection; try one after you turn developer access on.

## 10. The WAF inspects no request bodies, and every rule blocks

**The Front Door WAF policy runs Default Rule Set 2.1 in prevention with the bot manager, inspects the URI, query, headers and cookies, has no custom rules and no rule override, and sets `requestBodyCheck: Disabled`.** See [The WAF](security.md#the-waf).

**Why.** `942200` reads ordinary prose in a chat body (", by the record's" inside a tool description) as SQL injection and blocks the turn. Every route validates and caps its own body, SQL is parameterized, no raw HTML is rendered and every API route needs a session. No rule is relaxed. The one that would need it, `920420`, refuses a content type outside the rule set's list, and live voice is one WebSocket that sends no such body (decision 2).

**Rejected.** Excluding the prose-carrying JSON arguments one by one (breaks on the next tool description); the AVM module's default custom rule `ApplyGeoFilter`, which blocks every visitor; `920420` overridden to `Log`, which only an SDP offer needed.

**Limits.** The WAF has no rate-limit rule, so every rate limit is the app's own, applied once a request has a session.

## 11. Every data-plane deploy step runs in the migrate job; settings are seeded with the code's defaults

**`postdeploy` runs the job's `settings index skills agent library` steps as one job execution with its own identity inside the apps' network. `postprovision` keeps only control-plane calls: the sign-in callback on the Entra registration, the removal of project connections nothing uses or the deployment did not ask for, and the Front Door approval ([the hooks](deployment.md#the-hooks)). Each App Configuration document is written with the code's own default when it is absent or `{}`, and never overwritten. The code's default stays the answer when the store cannot be read or a field is refused.** See [Settings documents](configuration.md#settings-documents).

**Why.** A hardened deploy needs no opened listener and no host in the network, so `azd up` works from a laptop or a hosted runner with `azd` and `az` alone, with every listener closed. Seeded documents let an operator see and edit the live numbers in the portal.

**Rejected.** `postprovision` hooks that need `bun` and a data-plane client on the deployer's machine and an opened listener; seeding `{}`.

**Cost.** A seeded document pins the defaults of the deploy that wrote it: a later change to a default in code reaches a deployment only through a key nobody has written.

## 12. AI Search may sit in a second region

**`AZURE_SEARCH_LOCATION` places Search; empty, Search follows `location`.** See [Regions and model quota](deployment.md#regions-and-model-quota).

**Why.** Azure AI Search capacity varies by region, and some regions refuse new services ([Choose a region for Azure AI Search](https://learn.microsoft.com/en-us/azure/search/search-region-support): "This region is in high demand, which prevents the creation of new search services"). The deployment cannot always move as a whole, because the region that holds the models' quota is fixed. In hardened mode the indexer reaches private Storage and the Foundry account across regions with no shared private link.

**Risk.** The Agent Service [FAQ](https://learn.microsoft.com/en-us/azure/foundry/agents/faq) says all resources must be in the same region as the Foundry resource for network isolation; Search is a capability-host `vectorStoreConnection` in another region. It works, and it is outside the documented envelope.

**Rejected.** Moving the whole deployment to a region with Search capacity, when that region has no model quota.

**What to do.** Leave `AZURE_SEARCH_LOCATION` empty and try Search in the one region first, moving it only if the region refuses. Agent on Azure assumes the cross-region connection works; verify it on your deployment before relying on it.

## 13. Model pins carry their retirement dates in a file; capacities are template parameters

**`infra/model-deprecations.json` lists every model version `main.parameters.json` pins, with the inference-deprecation date Azure has announced and the date it was read. A test refuses an unlisted pin. It fails the build from thirty days before a listed date unless an acknowledgement, at most sixty days long, says somebody has a plan. Each deployment's capacity is in the `models` object of `main.parameters.json`. Three are parameters of their own so a quota can be met without editing the file: `REALTIME_CAPACITY`, `REALTIME_ALTERNATE_CAPACITY` and `KNOWLEDGE_BASE_CAPACITY`.**

**Why.** Deployments are `NoAutoUpgrade`, so a retired version stops answering on its date; `small` (titles and memory extraction) is the first to go. A build that fails thirty days early is the reminder.

**Also.** The default voice engine, speech-to-speech (decision 1), runs on the `realtime` role of the same `models` object, which `main.parameters.json` sets and the register holds like the other pins. A test holds that it is one more deployment under the same guardrail, and that taking it out leaves no voice deployment, with the cascade running on `chat`.

## 14. Premium is one HD multilingual voice and a longer session, on the same agent

**One voice agent for everyone; the tier's voice and the session's length are set per session. By default one model and one version too: speech-to-speech on `realtime`. The engine is a setting a tier may override (`voice.engineByTier`), so a deployment can keep base on the cascade and give premium speech-to-speech. That is two versions of the one voice agent, one per engine.**

**Why.** One engine for everyone keeps one version and one quota to watch. A voice per tier costs nothing to provision. An operator who wants to spend less on live voice can put one tier on the cascade without a code change.

**Rejected.** An HD voice per locale (one multilingual voice covers every locale); a separate model for premium by default.

## 15. A voice session keeps nothing on the service; the backend writes the spoken turns to the thread

**The voice agent's socket is opened with `store=false`, so Foundry keeps no transcript and no audio. The person's part goes in as structured inputs in a header, never a URL. At the end the backend writes the final transcripts into the thread's history in the items' order, with a barge-in kept as the whole generated reply, marked. It writes them wherever the thread keeps its history: its own container, or, for a thread on `history.store: foundry`, its conversation, as message items whose times the thread's index entry keeps.** Whichever store holds the thread, the session is seeded from it, within the `history` bound.

**Why.** The service's `store: true` keeps the transcript, event timeline and raw audio as a `voice.conversation` that is not the thread; decision 3's reasons apply to it too. With `store=false` the service lists no voice conversation and holds no document from the session.

## 16. Agent versions are pinned by content hash

**One agent version per definition, with `metadata.hash` of 32 hex characters, for the typed and the voice agent alike. The job publishes a version when the hash moves and prunes old ones; every session and every response names its version.**

**Why.** Two agents written from one source drift apart otherwise; a session pinned to a version survives a deploy mid-session.

**Known behavior.** A voice version's tool schemas are written without `$schema`, because the service accepts a version carrying it and never applies it. This is observed behavior, not a published limit.

## 17. One account is one person

**No profiles, roster, header or cookie: the account id is the agent's memory scope and the history's partition. The person's `name`, `about` and `preferences` are fields of their `accounts` document; the language is the app's one setting.**

**Why.** A second scope per person doubles every erasure and every privacy sentence.

## 18. Two modes of one template

**`hardened=false` is public endpoints, Container Apps ingress and no locks. `hardened=true` is VNet, private endpoints, Front Door Premium with the WAF, locks and purge protection. Both come from the same `main.bicep` on Azure Verified Modules.** See [Demo and hardened](deployment.md#demo-and-hardened).

**Why.** A reader deploys demo mode in minutes and hardened mode when it matters, from one set of files.

**Rejected.** Two templates; Front Door in demo mode.

## 19. Art. 50: the visible notice stays, there is no spoken introduction, the audio is not marked

**The AI notice stays wherever voice is offered; nothing is spoken by way of introduction. The audio passes through the backend, which could mark it, and does not.** See [Telling people it is an AI](privacy.md#telling-people-it-is-an-ai) and [What the service generates](privacy.md#what-the-service-generates).

**Why.** Art. 50(1) is met at the interface. Art. 50(2) is not addressed: Agent on Azure assumes the synthesized speech carries no watermark at source, and adds none.

**What to decide.** If your deployment must mark generated audio, choose a browser-side or a backend-side mark, and check Microsoft's current guidance on watermarking first.

## 20. The spoken language is stated in the update; the service applies the accent, not the transcription's language

**A session's `session.update` carries the stated transcription language, the tier's voice and its `voice_locale`. On the defaults, with `live.language` at `detected`, it carries the product's languages to choose among and no single `language`, and an OpenAI voice takes no `voice_locale`. The echo takes the voice and locale and returns no transcription `language`. The person is transcribed in the language they speak, and answered in the language the directive states.**

**Why.** The service does not apply a session's transcription language on either engine: audio in one language is transcribed in that language whichever language the update states, with `azure-speech` and with `mai-transcribe`. This is observed behavior; Agent on Azure assumes the transcript follows the audio. The accent does take, and what the answer is spoken in is the language directive's. So the product's rule (stated, not detected) holds for what the person hears; only the transcript follows what they said. See `live.language` in [configuration](configuration.md#voice).

## 21. Noise suppression is a setting, `voice.noiseReduction`, the headset type by default

**The voice agent's version sets `audio.input.noise_reduction` from the `agent` document's `voice.noiseReduction`: one of `azure_deep_noise_suppression`, `azure_deep_noise_suppression_headset` (the default) and `azure_personal_noise_suppression`. Only the type is sent. A change is a new voice version at the next deploy.** See [`voice`](configuration.md#voice).

**Why.** Microsoft recommends the headset type, or the personal type with `detection_input: "mas_dns"`. The two newer types are documented for Voice Live ([Voice Live how-to](https://learn.microsoft.com/en-us/azure/ai-services/speech-service/voice-live-how-to)). The voice-agent page ([How to build a voice agent](https://learn.microsoft.com/en-us/azure/ai-services/speech-service/how-to-voice-agent-integration)) lists only `near_field`, `far_field` and `azure_deep_noise_suppression`, and Agent on Azure doesn't send `detection_input: "mas_dns"`, which isn't among the documented fields. Microsoft's own `foundry_voice_webrtc` sample sends the headset type on a `kind: "voice"` agent, and says of the extra noise-suppression fields that "end-to-end support for those fields is not established" ([`samples/foundry_voice_webrtc/README.md`](https://github.com/microsoft/voice-agent/blob/main/samples/foundry_voice_webrtc/README.md)). `detection_input` is not sent: versions are created through `@azure/ai-projects`, whose `voiceAgentNoiseReductionSerializer` writes `{ type }` alone.

The personal type keeps one speaker best, but it is not the default. It personalizes after an automatic speaker enrollment, speaker data derived from the person's voice, and Agent on Azure assumes that data may outlive the session ([limitations](limitations.md), [privacy](privacy.md#known-gaps)). The headset type enrolls nobody.

**Rejected.** A fixed type in the definition.

**Known behavior.** The service takes all three types on both engines and echoes the type in the session; nothing in a session says whether the personal type enrolled a speaker. It checks the type when a session opens, not when the version is made. A session on a version with a type it does not know runs without the version's instructions, which is why the setting accepts only the three ([limitations](limitations.md)).

## 22. Not supported: every voice tool in one Foundry toolbox

**Not supported: one toolbox on the voice agent (MCP or the service's own server-side tools) holding web search, the skills and the stage controls. It would let a spoken web search run inside the service's own turn rather than through decision 6's second model call, but two things stand in the way.**

**Why.** The stage controls round-trip to one person's browser, over the socket the backend holds for that session (decision 2). A server-side tool runs in the service, which has no socket to that browser, so a toolbox would need its own route from the service back to the right replica and the right person. Nothing documented provides one. And a hardened project with public access off cannot reach a toolbox: Voice Live lists a voice agent's toolbox through the project's toolbox endpoint over the account's public endpoint, which refuses it, so the session's tool listing fails ([limitations](limitations.md)). [Configure a voice agent](https://learn.microsoft.com/en-us/azure/foundry/agents/how-to/configure-voice-agent) says a voice agent has individual tools or one toolbox, never both, so the move is all or nothing.

**What stands instead.** The function adapters of decision 6, with the filler covering the search's wait. A toolbox on a demo-mode voice version, whose MCP server the backend runs and through which the right browser answers a stage control, is untested. Hardened mode keeps the function adapters whatever such a test shows.

## 23. Retrieval through a Foundry IQ knowledge base is an opt-in engine over the same index; the hybrid search stays the default

**The `knowledge` document's `retrieval.engine` is `hybrid` by default, or `knowledgeBase`. Set to `knowledgeBase`, the job's `index` step makes one search-index knowledge source wrapping the chunks index as it is, and one knowledge base holding it (extractive retrieval, no answer synthesis). The backend's `knowledgeSearch` asks the base's `retrieve` route itself, for a typed turn and a live session alike. Each call carries the served filter as the source's `filterAddOn`, and while `access.enforceAccessControl` is on, the caller's readers clause beside it. It then reads the chunks the base chose back under the served filter and the readers clause. How hard the base works is the reasoning effort each call carries: `retrieval.reasoningEffort` for a typed turn, `retrieval.voiceReasoningEffort` for a live session, `minimal` by default. Above `minimal` the base plans with a deployment of its own, `models.knowledgeBase`, made with `KNOWLEDGE_BASE=true`.** See [Retrieval through a knowledge base](documents.md#retrieval-through-a-knowledge-base) and [`knowledge`](configuration.md#knowledge). How the backend reaches the base, rather than the agent, is decision 27.

**Why.** The knowledge base is the same retrieval (hybrid plus semantic ranker over the same index) run by the service, with a query planner of its own above `minimal`: it splits a question into sub-queries searched in parallel, and at `medium` it may search again. Offering it as an option costs one setting, two data-plane objects and one model deployment. It touches neither the index, the indexer, the shield, the access clause nor the tools the agent sees. Adopting it as the default would give up what the backend's query carries into the search itself:

- the reranker floor and the unmatched query terms.

The served filter and the readers clause go on each call, and the read-back applies them again, so a flagged or unreadable chunk never reaches the model. Everything that makes the engine agentic (a model on the base, the reasoning effort, answer synthesis) is preview with no SLA.

**Why one base, with the effort on the call.** The `retrieve` route takes `retrievalReasoningEffort` per request, overriding the base's own ([Set the retrieval reasoning effort](https://learn.microsoft.com/en-us/azure/search/agentic-retrieval-how-to-set-retrieval-reasoning-effort)). So one base that holds the planning model serves every effort, and a change of the setting applies from the next search with nothing rewritten; the backend, which only queries, could not rewrite a base anyway. The service refuses an effort above `minimal` on a base with no model ("A Knowledge Base model must be specified to use any reasoning effort other than 'Minimal'"). Without the planning deployment every search runs at `minimal` and says so (`knowledge_base.planner_unconfigured`). Output is extractive at every effort: the agent writes the answer, under one persona and one guardrail.

**Why voice has its own time limit.** A spoken search is a silence a person hears. Planning adds seconds to a search, so how long a live session waits is a setting an operator weighs against the effort: `retrieval.voiceDeadlineMs`, eight seconds by default, a whole number from one second to a minute. A typed turn's is `retrieval.deadlineMs`, beside it, with the same default and range.

**Rejected.** A blob knowledge source, which generates its own data source, skillset, index and indexer with a schema the template does not own. Replacing the hybrid search outright. The service's answer synthesis: a second voice and a second guardrail on what a person reads. The `auto` effort: the service choosing the cost of each question, with no bound an operator set.

**Evidence.** [Create a search index knowledge source](https://learn.microsoft.com/en-us/azure/search/agentic-knowledge-source-how-to-search-index) and [Create a knowledge base](https://learn.microsoft.com/en-us/azure/search/agentic-retrieval-how-to-create-knowledge-base) (the bodies; the models a base may plan with; a model and a reasoning effort among what `2026-04-01` does not support); [Set the retrieval reasoning effort](https://learn.microsoft.com/en-us/azure/search/agentic-retrieval-how-to-set-retrieval-reasoning-effort) (the efforts, the per-request override, `medium` in select regions); [Connect using Azure roles](https://learn.microsoft.com/en-us/azure/search/search-security-rbac) (Search Index Data Reader retrieves). AVM `search-service` has no `knowledgeRetrieval` through 0.13.0, so the billing plan is a documented patch, not a parameter.

**Limits.** The base's `maxRuntimeInSeconds` defaults to 90 s, far past either time limit; a search the limit cuts fails as a slow index does. Agentic retrieval is not available in every region, and a region that offers it may refuse new search services for capacity (decision 12).

## 24. Everything the agent can put on the stage, a person can reach by hand

**What the agent can place on the stage, a person can open by hand. Every stage section can be opened from the interface, through the same browser handler the agent's control runs and the same backend function the agent's tool runs.** The bar's Library button is `showLibrary` with no query. The bar's Records button is `showRecords` with no query over `GET /records?kind=&query=`, which wraps `listRecords`. A chip in the records tile and a link chip on a card are `showRecord`. A card's figure chips read `GET /records/:kind/:id/metrics/:measure?period=`, which wraps `metrics`, into the `showChart` handler. `showRecords` is the eighth control, so the agent can place the listing the person can open, on both channels. See [A stage tool](extending.md#a-stage-tool).

**Why.** A control with no way to open it by hand makes the conversation the only way into part of the product. A route the interface reads that is not the tool's own function is a second implementation that drifts. One handler and one function per thing keeps the two equal by construction.

**What stays agent-only.** `presentContent`: it takes a media URL a search returned on the turn, so there is no listing to open by hand, and the pictures reach a person through the reader's media and the library's cards. `openDocument` at a page and `clearStage` can already be done by hand: a library card, a tile's close button and the way home. `suggestNext` is the agent's own words and has no manual counterpart by nature.

## 25. The voice agent runs on the account's own deployments (`self_deployed`) by default; a managed model is opt-in

**Every voice version the template makes unasked is `model_type: "self_deployed"`: the cascade on the `chat` deployment, speech-to-speech on the realtime deployment `models.realtime` makes. A managed model (`model_type: "managed"`, the service hosting the model and billing it as part of the voice agent) is an opt-in, per engine. It is set by the `agent` document's `voice.managedModel`, empty by default, or by a voice tester's own tuning. The models offered are one table (`MANAGED_VOICE_MODELS`, `platform/agent/src/voice-models.ts`), and every value is checked against it.** See [Voice](architecture.md#voice) and [managed voice models](configuration.md#managed-voice-models).

**Why self-deployed is the default.** A deployment's SKU says where its model processes, and the template states it ([configuration](configuration.md#the-realtime-deployment)); a managed model's scope is the voice service's. [Configure a voice agent](https://learn.microsoft.com/en-us/azure/foundry/agents/how-to/configure-voice-agent) defines `managed` as "the service hosts the model", and no voice-agent page states which region processes it. Voice Live's own table ([Speech regions, Voice Live](https://learn.microsoft.com/en-us/azure/ai-services/speech-service/regions?tabs=voice-live)) puts the plain realtime names at Global scope, with only the `-datazone` names in the data zone; reading one product's table as another's is an inference ([limitations](limitations.md)). A managed model also runs on no deployment of the account's: it is priced at its Voice Live tier rather than as the deployment's tokens, and the capacity the template sizes neither bounds nor meters it.

**Why managed is offered at all.** It needs no deployment, no realtime quota and no region that offers the realtime model, so speech-to-speech can run, or be tried, where none of those exists. A voice tester can also compare models without a provision. Opt-in keeps the default's residency claim true: nothing processes on a managed model unless an operator writes one into the `agent` document or a tester chooses one for their own sessions. The tuning panel names each model's processing scope beside it.

**Why one table.** A value the service does not take can open a session without the version's instructions, guardrails and tools. So the names, each model's engine, its scope, the efforts it takes, its voices and its transcribers live in one place that validation, the panel and the definition builder all read. `azure-realtime` is left out: it speaks only `azure-realtime-native` voices, a family no `voice` document setting names.

**Rejected.** Managed as the default, or as the only speech-to-speech: it would make a Global processing scope the deployment's unless an operator noticed. Accepting any model name and letting the service refuse it: the service does not always refuse, and can drop the version's instructions instead.

**When to revisit.** If a voice-agent page states a managed model's processing scope, or the service adds or retires a managed name.

## 26. Components are chosen at deploy time, tuning at run time

**A component (which Azure or Foundry piece does a job) is an azd variable: `MEMORY_STORE`, `HISTORY_STORE`, `RETRIEVAL_ENGINE`, `VOICE_ENGINE`. It is the starting value of its settings field, which the migrate job seeds into an absent document; the document then stays the operator's to edit. Tuning lives in App Configuration only. Combinations that cannot work are refused from one table (`apps/backend/src/components.ts`) by `preprovision`, the job's `settings` step and the backend's run-time guards.**

**Why at deploy time.** A deployer chooses pieces before anything exists, and some pieces only work with others: the Foundry memory store cannot run on a private deployment. Chosen as variables, a refusal comes before provisioning, from the hook, rather than after it from a document nobody had a chance to write.

**Why still editable later.** The settings documents are where an operator changes a running deployment, and a component is sometimes what changes. So the variable seeds only an absent document and never overwrites a stored one. A stored field that differs is a warning (`settings.component_differs`), not a correction, because overwriting would undo every operator edit at the next deploy.

**Why three checks.** `preprovision` can read only the azd variables: in hardened mode App Configuration is private. The job runs inside the network and reads the stored documents, so an edit since the last deploy fails the next one. An edit after the deploy reaches the backend without any deploy at all, so the run-time guards stay as defense in depth.

**Why only these four.** Each names a piece and changes where data lives or which service answers. A managed voice model names a model rather than a piece, and web search has no resource and no switch; both stay settings.

**Rejected.** Overwriting a stored field with its variable at every deploy: it makes the variable the only way to change a component and silently reverts a portal edit. Components as App Configuration settings only: nothing could refuse an incompatible choice before provisioning. A bun script called from the hooks to share the table: the hooks run with only `az` and `azd` installed, so the rules are carried in shell and held equal to the table by a test.

## 27. Foundry IQ is called through the backend, not as an MCP tool

**A knowledge base is asked on one route, on both channels: the backend's `knowledgeSearch` calls the base's `retrieve` route with the effort on the call, and reads the chunks it chose back under the served filter and the readers clause (decision 23). Neither the typed agent's version nor the voice agent's carries the base as the service's `mcp` tool, in any mode, and no setting makes one.**

**Why.**

- A voice agent's own `mcp` tool fails on a private account: Voice Live lists the tool's server from Microsoft's public addresses, and an account with public access off answers 403. On a public account it works ([limitations](limitations.md)). A route that works in one mode and not the other is two code paths, and the private one is the one hardened mode depends on.
- The MCP tool takes no reasoning effort per call (its input is `query_variants` alone), so carrying an effort through it needs one base, and one project connection, per effort. `retrieve` takes the effort on the call, against one base.
- The tool's result reaches the model straight from the service, so neither the Prompt Shields filter nor the readers clause applies to it. Both are filters on the chunks the backend serves, and the backend never sees an MCP call's chunks before the model does.
- It depends on two more previews: the `RemoteTool` project connection (an authentication type and an `audience` the published schema does not list) and the `/mcp` route, which exists on `2026-08-01-preview` only.
- Measured on the same questions, the two routes found the same facts at comparable latency.

**What it gives up.** The native "knowledge base as a tool" integration Microsoft's documentation shows ([Connect agents to Foundry IQ knowledge bases](https://learn.microsoft.com/en-us/azure/foundry/agents/how-to/foundry-iq-connect)): the service calling the base inside the response, one MCP server any agent in the project can share, and no search crossing the backend.

**Rejected.** The `mcp` tool on typed turns with the function on voice, as an opt-in beside this route: the two channels would search through different filters, at efforts carried two different ways, for a gain the measurements did not show.

**What would change this.** Voice agents reaching an MCP server through the project's private endpoint, so the service's tool works on a private account. And the MCP tool taking a per-call reasoning effort and a filter the backend can set, so the shield and the readers clause apply to what it returns.

## 28. The agent subnet's egress: open by default, a NAT gateway and a service-tag allow list by opt-in

**With private networking the Agent Service's `agent` subnet keeps Azure's default outbound access, with no security group (`AGENT_EGRESS=open`, the default). `AGENT_EGRESS=restricted` turns the default access off and gives the subnet a NAT gateway as its one way out. It also puts a network security group on the subnet that admits nothing in and lets out only the `data` subnet's private endpoints, the subnet itself, and `AzureActiveDirectory`, `MicrosoftContainerRegistry`, `AzureFrontDoor.FirstParty` and `AzureMonitor` on 443.** See [Restricting the agent subnet's egress](deployment.md#restricting-the-agent-subnets-egress).

**The risk of the open default.** When open, anything running in the subnet (the platform's containers and the agents' compute) reaches any address on the internet on any port, from an address Azure picks, and nothing logs where it went. The agents reach the deployment's own data through the private endpoints either way, and the data services' public listeners are off, so the open path cannot reach them from outside. The exposure is exfiltration by something running in the subnet, to a destination of its choosing. The platform runs that compute, not the template, so the exposure is to the service's own code and to what a tool call makes it fetch.

**Why open is the default.** Microsoft's own private-network sample ([foundry-samples `15-private-network-standard-agent-setup`](https://github.com/microsoft-foundry/foundry-samples/tree/main/infrastructure/infrastructure-setup-bicep/15-private-network-standard-agent-setup)) gives the agent subnet no security group and no egress path of its own. Its README warns that a subnet with a route, a security group or no default outbound access can "fail without a clear error because required platform traffic is blocked". The [capability host](patterns.md#terms) is known to finish creating on an open subnet. Whether it does on a restricted one is untested, and a default should be the configuration known to work.

**What restricted allows, and why exactly that.** [Set up private networking for Foundry Agent Service: Limitations](https://learn.microsoft.com/en-us/azure/foundry/agents/how-to/virtual-networks#limitations): a firewall in front of the subnet must allow `control-{region}.identity.azure.net`, `{region}.login.microsoft.com` and `login.microsoftonline.com`, "or add the AzureActiveDirectory service tag". A security group on the subnet needs "matching outbound allow rules for required dependencies, including the AzureActiveDirectory service tag". The subnet is delegated to Container Apps, so Container Apps' own outbound rules for a workload-profiles subnet apply too ([Securing a virtual network in Azure Container Apps: Outbound](https://learn.microsoft.com/en-us/azure/container-apps/firewall-integration#outbound)):

- `MicrosoftContainerRegistry` and `AzureFrontDoor.FirstParty` for the platform's containers;
- the subnet to itself;
- `AzureActiveDirectory` for a managed identity;
- `AzureMonitor` when Azure Monitor is used.

Azure DNS is outside any security group. The template's agents reach their model, Cosmos DB, Storage and AI Search through the private endpoints, so the `data` subnet is the one internal destination. The rest of Container Apps' list (a container registry, `Storage.<region>`) is for images of the customer's own, which a prompt agent does not run. The inbound side follows the Foundry baseline reference architecture ([microsoft-foundry-baseline](https://github.com/Azure-Samples/microsoft-foundry-baseline), `network.bicep`), whose agent subnet denies every inbound flow.

**Why a NAT gateway and not Azure Firewall.** The baseline routes the subnet through Azure Firewall (Basic) with an application rule for the agents that, as shipped, allows every host on 443 and leaves narrowing it as a "production readiness change". A firewall adds FQDN rules and a log of each refused connection; a NAT gateway and a security group filter by service tag only and log nothing per flow. The template takes the smaller one. A firewall is two more subnets, two public addresses, a policy, a route table and several times the NAT gateway's monthly price on Basic before traffic ([cost](cost.md#optional-extras)), and everything Learn requires of the subnet is expressible as service tags. A deployment that must filter by host name, or already has a hub firewall, points the subnet's route at that firewall instead and allows the hosts above.

**Security groups elsewhere.** These follow the baseline, subnet by subnet:

- `data` refuses every outbound flow (a private endpoint answers; it never calls) and has private-endpoint network policies on, so the group applies to the endpoints' traffic, with the default inbound rules admitting the network.
- Bastion's subnet carries the rule set [Bastion requires](https://learn.microsoft.com/en-us/azure/bastion/bastion-nsg).
- The jump VM's subnet admits SSH from Bastion alone.
- `apps` carries none. Its environment's ingress is external, and Container Apps says that for an external workload-profiles environment "inbound traffic to Container Apps routes through the public IP that exists in the managed resource group rather than through your subnet", so an inbound rule there filters nothing. Its outbound is the apps' own, which reach the public registry, Entra ID and the providers they call.

**Rejected.** Restricted as the default: a default that might stop the capability host from creating, for a filter the platform's own sample does not apply. Azure Firewall, above. The baseline's open `Internet:443` rule on the agent subnet, which assumes a firewall behind it.

**Untested.** The capability host creating, and the agents running, on a restricted subnet is untested; verify it on your deployment before relying on it. Agent on Azure assumes the service-side `web_search` tool, and the rest of an agent's turn, open no connection from the subnet to a destination the allow list refuses. If a turn that searched the web fails only when restricted, look there first.

## 29. Telemetry on a private deployment: public ingestion by default, Azure Monitor's private link by opt-in

**Application Insights and its Log Analytics workspace take public ingestion on every deployment. `PRIVATE_TELEMETRY=true`, with private networking, opts in to the private path: both set `publicNetworkAccessForIngestion: Disabled`, and an Azure Monitor private link scope holding both (`ingestionAccessMode: PrivateOnly`, `queryAccessMode: Open`) takes the telemetry through one private endpoint on the `data` subnet. The endpoint is registered in `privatelink.monitor.azure.com`, `privatelink.oms.opinsights.azure.com`, `privatelink.ods.opinsights.azure.com` and `privatelink.agentsvc.azure-automation.net`.** See [Demo and hardened](deployment.md#demo-and-hardened).

**Why the private path exists.** Every other data path of a private deployment is private. Telemetry carries request paths, problem lines and token counts, and an ingestion endpoint open to the internet accepts anything sent with a connection string, which is not a secret ([architecture](architecture.md#identities-and-roles)). The design is that of Microsoft's own private-network Agent Service sample ([foundry-samples `15-private-network-standard-agent-setup`](https://github.com/microsoft-foundry/foundry-samples/tree/main/infrastructure/infrastructure-setup-bicep/15-private-network-standard-agent-setup), `monitor-private-link-scope.bicep`). That sample leaves out the blob zone because it serves only the monitoring agents' solution packs, and it describes the scope as what lets hosted agents export telemetry; Agent on Azure runs prompt agents.

**Why it is not the default.** This is observed behavior, not a published limit: the scope, the endpoint and the zones can all be in place, with the regional ingestion host resolving inside the network to the scope's endpoint, the component listing the scope among its private link scoped resources, and the endpoint's connection approved. Even then, an item the backend posts to `v2.1/track` is answered `403` "Component private link id does not match incoming link and has publicNetworkAccessForIngestion=Disabled". The refusal persists: it is not a short propagation delay. Agent on Azure assumes it can last most of an hour. No App Insights row arrives from the apps, nor from the Agent Service's server-side tracing. The platform's own tables (`ContainerAppConsoleLogs`, `ContainerAppSystemLogs`, `ContainerAppHTTPLogs`, every diagnostic setting) keep arriving, because diagnostic settings travel on a channel the switch does not govern. A default that silently drops the apps' traces is worse than a public ingestion endpoint that only accepts writes, so the private path stays opt-in.

**Query is open** in the private path too. Agent on Azure leaves it open, and the portal, Log Analytics queries and, where `AGENT_TRACING` is on, the project's *Tracing* view all run from outside the network.

**What to verify.** Agent on Azure assumes the refusal can recur, and that the Agent Service's own spans may arrive from outside the network, where public ingestion off refuses them; check both on your deployment before turning the switch on. Foundry emits those spans once the project has an Application Insights connection ([Set up tracing](https://learn.microsoft.com/en-us/azure/foundry/observability/how-to/trace-agent-setup)). The effect of `PrivateOnly` on anything else in the network that sends to an Azure Monitor resource outside the scope is untested.

**How to check it on your deployment.** With `PRIVATE_TELEMETRY=true`, a typed turn's requests should appear in `AppRequests` and, with `AGENT_TRACING=true`, its spans in the project's *Tracing* view. If they don't, turn the private path off as below.

**Turning it off on an existing environment.** The switch sets ingestion public again, but a provision deletes nothing. The private link scope, its private endpoint and the four zones (`privatelink.monitor.azure.com`, `privatelink.oms.opinsights.azure.com`, `privatelink.ods.opinsights.azure.com`, `privatelink.agentsvc.azure-automation.net`) stay, and while they do the network still resolves the ingestion hosts to the scope's endpoint. Remove them by hand, in this order: the scope's scoped resources, the private endpoint, the scope, each zone's virtual network links, then the zones. Keep `privatelink.blob.core.windows.net`, which storage's own endpoint uses. Then restart both apps, so each exporter resolves the public ingestion host again.

**Rejected.** Query closed (above). An `Open` ingestion mode, which would let the network send to resources outside the scope.

## 30. Azure Policy in Audit at the resource group: local authentication in both modes, public access with private networking

**`POLICY_AUDIT`, on by default, assigns eight built-in definitions to the resource group with `effect: Audit`:**

- **key access or local authentication disabled, in both modes, on the Foundry account (`71ef260a-8f18-47b7-abcb-62d0673d94dc`), Cosmos DB (`5450f5bd-9c72-4390-a9c4-a7aba4edfdd2`), AI Search (`6300012e-e9a4-4649-b41f-a85f5c43be91`) and Storage (`8c6a50c6-9ffd-4ae7-986f-5fa6111f9a54`);**
- **with private networking only, network access restricted on the Foundry account (`037eea7a-bd0a-46c5-9a66-03aea78705d3`), and public network access disabled on Cosmos DB (`797b37f7-06b8-444c-b1ad-fc62867f335a`), AI Search (`ee980b6d-0eca-4501-8d54-f6290fd512c3`) and Storage (`b2982f36-99f2-4db5-8eff-283140c09693`).**

See [Policy](security.md#policy).

**Why.** The template turns each of these off itself; an audit is what notices when somebody turns one back on. The set and the effect are the Foundry baseline reference architecture's ([microsoft-foundry-baseline](https://github.com/Azure-Samples/microsoft-foundry-baseline), `azure-policies.bicep`), which leaves them in Audit "in case you need to troubleshoot". Every id is a built-in definition taking `Audit` as its `effect`.

**Both modes, with mode-appropriate assignments.** Local authentication is off in demo mode as in hardened mode, so its audits mean the same thing in both. Public access is on in demo mode by design, so a public-access audit there would be non-compliant from the first minute and report nothing; it is assigned where the network makes it true.

**Why on by default.** Assigning policy at a resource group is `Microsoft.Authorization/policyAssignments/write`. The role the template already requires holds it (Owner, or User Access Administrator, whose actions are `Microsoft.Authorization/*`, beside Contributor), so it raises nothing. `POLICY_AUDIT=false` is there for a subscription whose policy is governed above the resource group.

**Rejected.** `Deny`: a refused write during a provision or an incident is worse than a report. The baseline's zone-redundancy audits: zone redundancy is its own switch (`ZONE_REDUNDANT`), and AI Search's needs replicas the template does not make. The custom `deny-key-auth-connections` definition from [foundry-samples `05-custom-policy-definitions`](https://github.com/microsoft-foundry/foundry-samples/tree/main/infrastructure/infrastructure-setup-bicep/05-custom-policy-definitions). The project's one key-authenticated connection is Application Insights', which carries an ingestion connection string by design (decision 29, [architecture](architecture.md#identities-and-roles)), so that audit would report the one known connection forever. A custom definition is also written at subscription scope, which a resource-group deployment's role need not reach.

**Timing.** Compliance results appear in the portal's *Policy* view some minutes after the first provision; the first evaluation runs on Azure's schedule, not the deployment's.

## 31. Live voice runs on a Foundry voice agent by default; the Voice Live API directly is the generally available opt-in

**`voice.runtime` is `agent` in both modes: each engine is a version of the Foundry voice agent. `voiceLive` opens the Voice Live API directly on a model it hosts, sending the prompt, the tools and the audio settings in the session's first update. On it, demo mode runs on `gpt-realtime-2.1` and, on the cascade, `gpt-5.4`; hardened mode on `gpt-realtime-2.1-datazone` and `gpt-5-mini`; `voice.managedModel` overrides either.** See [voice runtimes](configuration.md#voice-runtimes) and [Voice](architecture.md#voice).

**Why the voice agent is the default.** It is Microsoft's recommended integration of Agent Service and Voice Live ([Migrate from Voice Live with Foundry Agent Service to Microsoft Foundry voice agents](https://learn.microsoft.com/en-us/azure/foundry/agents/how-to/migrate-from-voice-live)), and it matches the rest of the template, whose typed agent, conversations and memory store are on Agent Service: a versioned definition, the deployment's own content-filter policy, tracing, and one model across channels.

**Why Voice Live is offered.** Voice agents are preview, and some customers cannot accept preview terms. Voice Live is generally available and needs no version, no realtime deployment and no preview opt-in. Its hosted models are chosen per mode from [Voice Live region support](https://learn.microsoft.com/en-us/azure/ai-services/speech-service/regions?tabs=voice-live#regions), whose `-datazone` models are processed "only within the data zone associated with your resource's region". No text model has a `-datazone` name; `gpt-5-mini` is Data zone in Sweden Central and France Central where `gpt-5.4` is Global, so hardened mode's cascade uses it.

**Trade-offs of the opt-in.** Voice Live's built-in content filter, which cannot be changed, in place of the deployment's policy; no accent per language; no reasoning effort; Voice Live's own tokens-per-minute quota in place of the realtime deployment's capacity; and a session start about a second longer, which holding the person's early speech covers ([limitations](limitations.md#voice-live-without-a-voice-agent)). The job still makes the voice agent's versions and `models.realtime` is still deployed, so a switch either way is a settings change with no deploy.

**Verification.** Both runtimes are verified with a spoken task in both modes, hardened mode behind its private endpoints; the opt-in ran on the data-zone model there.

**When to revisit.** When Foundry voice agents are generally available, or Voice Live documents a content-filter policy, an accent or a reasoning effort per session.
