# Limitations

This page lists what Agent on Azure cannot do, or does on purpose, with the evidence for each. Read it before you plan a deployment, promise a behavior to a customer, or report a problem to Microsoft.

The limitations are grouped by area: [memory](#memory), [conversation history](#conversation-history), [retrieval and knowledge bases](#retrieval-and-knowledge-bases), [documents and the library](#documents-and-the-library), [the voice agent and its tools](#the-voice-agent-and-its-tools), [speech, voices and turn detection](#speech-voices-and-turn-detection), [where voice is processed](#where-voice-is-processed), [the agent and its model](#the-agent-and-its-model), and [deployment and operations](#deployment-and-operations).

Each limitation says where it comes from: the service as Microsoft Learn describes it, the service as observed, or Agent on Azure's design. The evidence is a Microsoft Learn line quoted or, for observed behavior, what the service did. Observed behavior isn't a published limit, so verify it on your deployment before relying on it. The last line says what Agent on Azure does about it. Where the evidence or the answer runs long, it links to a section at the end of the page ([Details](#details)).

## Memory

What the Foundry memory store and the deployment's own memory store can and cannot do.

**No private network for the Foundry memory store.** The Foundry memory store extracts on Microsoft's side of the network and reaches the account's model over its public endpoint: no VNet, so it cannot run behind private endpoints.

- *Whose:* The service, as Microsoft Learn describes it.
- *Evidence:* [What is memory?](https://learn.microsoft.com/en-us/azure/foundry/agents/concepts/what-is-memory), Limitations: "Virtual network (VNet) integration isn't supported for memory stores." The extraction calls come from a public Microsoft address, so an account with public network access disabled answers every one 403 `Public access is disabled. Please configure private endpoint.`, even with the account's `networkAcls.bypass` set to `AzureServices` ([models.bicep](../infra/modules/models.bicep)).
- *What Agent on Azure does:* The Foundry store runs on public (demo mode) deployments only. Under `PRIVATE_NETWORKING`, `memory.store` defaults to `own`, and `foundry` is refused at deploy time and at run time ([Details](#the-memory-store-on-a-private-deployment)).

**At most 100 accounts per Foundry memory store.** A memory store holds at most 100 scopes, and Agent on Azure keeps one scope per account, so one store serves at most 100 accounts.

- *Whose:* The service, as Microsoft Learn describes it.
- *Evidence:* [What is memory?](https://learn.microsoft.com/en-us/azure/foundry/agents/concepts/what-is-memory), Limits: *Maximum scopes per memory store: 100*, with one scope per user recommended. Agent on Azure assumes nothing about the 101st scope; keep below 100.
- *What Agent on Azure does:* `memory.store: own` (the deployment's own Cosmos container) has no such cap ([configuration](configuration.md#agent)).

**The Foundry store decides what it keeps.** The Foundry memory store's extraction is the service's: what it keeps is steered only by the store's `user_profile_details`, which is set once, when the store is made, so it may keep an instruction a person gave for one conversation as a fact about them.

- *Whose:* The service, partly as Microsoft Learn describes it and partly as observed.
- *Evidence:* [What is memory?](https://learn.microsoft.com/en-us/azure/foundry/agents/concepts/what-is-memory) describes user-profile memory as extracted by the store's chat model, guided by `user_profile_details`; the store's options are given at creation. Agent on Azure assumes the extraction may keep an instruction addressed to the assistant as a fact.
- *What Agent on Azure does:* The product's details (`memory.userProfileDetails`) tell the store never to keep one, and whatever either store keeps reaches the prompt only as information about the person ([Details](#what-the-memory-store-keeps)).

**A stalled extraction cannot be canceled.** A memory extraction update the service cannot complete stays `in_progress` forever and cannot be canceled through any API the SDK exposes.

- *Whose:* The service, as observed.
- *Evidence:* Observed behavior: an update whose extraction calls are all refused reads `in_progress` on every read, never the `Failed` status that [Use memory](https://learn.microsoft.com/en-us/azure/foundry/agents/how-to/memory-usage) describes ([Details](#a-stalled-memory-update)).
- *What Agent on Azure does:* An update not completed within `updateDelaySeconds` plus fifteen minutes is reported once as `agent.memory.extraction_stalled` ([configuration](configuration.md#agent)).

**The content filter screens the own store's extraction.** The content filter screens the own memory store's extraction call like any other: a conversation holding a line it takes for a jailbreak is refused whole, the person's real statements with it.

- *Whose:* The service, as Microsoft Learn describes it.
- *Evidence:* [Prompt Shields](https://learn.microsoft.com/en-us/azure/ai-services/content-safety/concepts/jailbreak-detection) screen the user prompt of every call on a deployment whose content filter enables them, and the extraction sends the conversation as its prompt.
- *What Agent on Azure does:* A turn the filter blocked, typed or spoken, is left out of what is extracted (its messages are named on the thread's index entry). A refused extraction is retried once without the person's newest message and what followed it, then left (`agent.memory.extraction_refused`) ([configuration](configuration.md#agent)).

## Conversation history

Where a conversation is kept, and what happens to a turn in flight.

**Conversations kept on the service expire.** With `history.store: foundry`, a thread's conversation expires 60 days after it was made, whatever its activity, and the item documents an API delete leaves stay in the run-state container until its time to live.

- *Whose:* The service, as observed.
- *Evidence:* Observed behavior, not a published limit. The [FAQ](https://learn.microsoft.com/en-us/azure/foundry/agents/faq) says "Data persists unless you explicitly delete it", so verify retention on your deployment ([Details](#conversations-kept-on-the-service)).
- *What Agent on Azure does:* `history.store` is `own` by default: the history lives in the deployment's own Cosmos container, and every response runs with `store: false`. On `foundry`, the job and the backend warn, and an erasure calls every delete ([Details](#conversations-kept-on-the-service)).

**A live session keeps its own conversation.** The voice agent cannot write a live session into a thread's conversation: its own store keeps a separate conversation, with the audio.

- *Whose:* The service, as Microsoft Learn describes it, and Agent on Azure, by design.
- *Evidence:* The voice agent's `store: true` keeps a `voice.conversation`, with the transcript, the event timeline and the raw audio, which is not the thread's conversation ([decisions](decisions.md), decision 15).
- *What Agent on Azure does:* It is not used: the socket stays `store=false`. On `history.store: foundry` the backend writes the spoken lines into the thread's conversation as text when the session ends, as it writes them into the `messages` container on `own` ([architecture](architecture.md#voice)).

**A picture enters the service's conversation.** With `history.store: foundry`, a picture enters the service's conversation with its turn.

- *Whose:* Agent on Azure, by design.
- *Evidence:* The response that reads it is stored in the conversation; only the API's delete can take it out of what the conversation answers.
- *What Agent on Azure does:* Its item and the response it went to are deleted when the turn finishes, as a best effort (`agent.history.picture_kept` when that fails); the run-state copy stays as above.

**The history bound stops applying on the service.** With `history.store: foundry`, the `history` bound no longer limits what a typed turn is given.

- *Whose:* Agent on Azure, by design.
- *Evidence:* The conversation holds the history and the response is asked with `truncation: "auto"`: the service decides what fits.
- *What Agent on Azure does:* `history.maxItems` and `history.maxChars` bound only what a live session is seeded with ([configuration](configuration.md#agent)).

**A reloaded page stops its turn.** A turn still being answered when its page is reloaded or closed is stopped, and the page that opens next shows the person's message with nothing under it.

- *Whose:* Agent on Azure, by design.
- *Evidence:* The frontend's chat runtime keeps no conversation (`apps/frontend/app/api/copilotkit/caller-runner.ts`). A page that goes away stops the run it was reading; a run is held only while it streams, for the account that started it; a stage control runs only in the page that asked. No copy of a half-said answer is left for the next page.
- *What Agent on Azure does:* The earlier turns are read from the backend ([architecture](architecture.md#a-typed-turn)); asking again is answered, and a call the stopped turn left open is closed as unanswered.

## Retrieval and knowledge bases

How Azure AI Search and Foundry IQ knowledge bases choose, filter and bill what the agent reads.

**Knowledge-base reasoning needs a preview API version.** A knowledge base takes a model, and a reasoning effort above `minimal`, only on a preview API version, and refuses an effort above `minimal` without a model.

- *Whose:* The service, as Microsoft Learn describes it.
- *Evidence:* [Create a knowledge base](https://learn.microsoft.com/en-us/azure/search/agentic-retrieval-how-to-create-knowledge-base) lists "configurable reasoning effort" among what the GA version (`2026-04-01`) does not support; [Set the retrieval reasoning effort](https://learn.microsoft.com/en-us/azure/search/agentic-retrieval-how-to-set-retrieval-reasoning-effort) sets the effort on the base or per `retrieve` request; the service answers 400 `A Knowledge Base model must be specified to use any reasoning effort other than 'Minimal'`.
- *What Agent on Azure does:* The job PUTs the one base by REST on `2026-08-01-preview`, with the planning model whenever there is one, and `knowledgeSearch` carries the effort on each `retrieve` call. Without the planning deployment every search runs at `minimal` (`knowledge_base.planner_unconfigured`) ([documents](documents.md#retrieval-through-a-knowledge-base)).

**`medium` effort in select regions only.** `medium` reasoning effort is offered in select regions only, and whether the service refuses it elsewhere is not stated.

- *Whose:* The service, partly as Microsoft Learn describes it and partly as observed.
- *Evidence:* [Set the retrieval reasoning effort: Region support for medium retrieval](https://learn.microsoft.com/en-us/azure/search/agentic-retrieval-how-to-set-retrieval-reasoning-effort#region-support-for-medium-retrieval).
- *What Agent on Azure does:* Choose `low` in a search region the list does not name: a search the service refuses fails as a slow index does.

**No private planning model on the Basic tier.** Learn shows a knowledge base's planning model over a private network only through a shared private link, which the Basic tier cannot hold to a Foundry resource.

- *Whose:* The service, partly as Microsoft Learn describes it and partly as observed.
- *Evidence:* [Make outbound connections through a shared private link](https://learn.microsoft.com/en-us/azure/search/search-indexer-howto-access-private) lists "Knowledge base connections to Azure OpenAI"; [service limits: Shared private link resource limits](https://learn.microsoft.com/en-us/azure/search/search-limits-quotas-capacity#shared-private-link-resource-limits), refuses one to a Foundry resource on Basic; Foundry IQ's private tutorials run their bases at `minimal`.
- *What Agent on Azure does:* The planning call takes the vectorizer's route: the account admits AI Search as a trusted service, as the search service's own identity ([configuration](configuration.md#the-knowledge-bases-planning-model)).

**A knowledge base holds no filter of its own.** A knowledge base source keeps no served filter or readers clause; a persisted `baseFilter` is `2026-05-01-preview` only and not in `@azure/search-documents` 13.0.0. So the backend sends both on each `retrieve` call, as the source's `filterAddOn`.

- *Whose:* Agent on Azure, by design.
- *Evidence:* A call without the filter retrieves over the index as it is, so it can choose a chunk the served filter hides or the caller may not read.
- *What Agent on Azure does:* `knowledgeSearch` puts the served filter, and under `access.enforceAccessControl` the readers clause, on every call. It reads the chunks the base chose back under the same filter, as defense in depth; a dropped chunk is reported as `knowledge.cited_unserved` ([documents](documents.md#retrieval-through-a-knowledge-base)).

**A knowledge base cannot apply Prompt Shields' verdict.** Prompt Shields' verdict cannot be applied inside a knowledge base: the GA version persists no filter on a source.

- *Whose:* Agent on Azure, by design.
- *Evidence:* The base retrieves over the index as it is, chunks with no verdict included.
- *What Agent on Azure does:* `knowledgeSearch` reads the chunks the base chose back under `injection eq false`, so the agent's model is handed none without a clean verdict; above `minimal` effort the base's own planning model still works over what the base retrieved. The hybrid engine, the default, never retrieves one ([documents](documents.md#retrieval-through-a-knowledge-base)).

**The knowledge-retrieval billing plan is not in the template.** A knowledge base bills retrieval tokens on the search service, and the template cannot set the `knowledgeRetrieval` plan: AVM `search-service` 0.13.0 has no such property.

- *Whose:* The service, as Microsoft Learn describes it.
- *Evidence:* [Enable or disable agentic retrieval](https://learn.microsoft.com/en-us/azure/search/agentic-retrieval-how-to-enable-disable) (no line quoted).
- *What Agent on Azure does:* Moving to the standard plan is the `az rest --method patch` command after provisioning ([documents](documents.md#retrieval-through-a-knowledge-base)).

**Knowledge sources per base, by tier.** How many knowledge sources a base may hold, by service tier.

- *Whose:* The service, as Microsoft Learn describes it.
- *Evidence:* No Learn line is recorded here; check the limit for your tier in [service limits](https://learn.microsoft.com/en-us/azure/search/search-limits-quotas-capacity).
- *What Agent on Azure does:* One search-index knowledge source per base, `<index>-source`, wrapping the index as it is ([documents](documents.md#retrieval-through-a-knowledge-base)).

**A picture is found only by its words.** A picture with no text in it and no document showing it cannot be found: the index sees words, not pixels.

- *Whose:* Agent on Azure, by design.
- *Evidence:* [documents](documents.md#a-library), the Pictures row.
- *What Agent on Azure does:* OCR reads a picture's own text; a Markdown document's alt text makes the picture it shows findable.

**Sources chips are library documents only.** The Sources chips under a reply are the documents the reply names by title, else everything consulted; a web page is never a chip.

- *Whose:* Agent on Azure, by design.
- *Evidence:* [documents](documents.md#a-library), the Sources row; [named-sources.ts](../platform/agent/src/turn/named-sources.ts).
- *What Agent on Azure does:* A source is always a library document, each chip opening it in the reader. The chips show which documents the reply named or was handed, not that each claim in it is supported by them.

## Documents and the library

How documents enter a library and how the reader shows them.

**No upload UI.** There is no upload UI. In this repository, documents enter only through the ingest script. Impact AI Admin Center is a separate product that makes ingestion easier ([Admin Center](impact-ai.md#impact-ai-admin-center)).

- *Whose:* Agent on Azure, by design.
- *Evidence:* [documents](documents.md#load-a-library).
- *What Agent on Azure does:* `scripts/ingest.sh` mirrors a folder into the library container and starts the job.

**The reader shows extracted text, not rendered pages.** The reader shows a PDF or an Office file as the text the indexer extracted, one page per chunk, with no rendered pages; the raw file is never served.

- *Whose:* Agent on Azure, by design.
- *Evidence:* [documents](documents.md#a-library), The reader row.
- *What Agent on Azure does:* Only the pictures a library holds are served, by path on the media route to a signed-in reader.

**A described blob is indexed again.** A blob the ingest describes is read again by the next indexer run, which writes its chunks again: the description is Agent on Azure's own metadata write, and it changes the blob.

- *Whose:* Agent on Azure, by design.
- *Evidence:* [Set Blob Metadata](https://learn.microsoft.com/en-us/rest/api/storageservices/set-blob-metadata): "Any write operation on the blob (including updates on the blob's metadata or properties) changes the last modified time of the blob."
- *What Agent on Azure does:* The scan after every run reads the whole index, whatever became of a rewritten chunk's verdict: [security](security.md#model-safety).

**A hardened load from the jump VM needs your own sign-in.** In hardened mode the jump VM's identity holds no role on Storage, so a load from inside the network is an interactive sign-in of your own.

- *Whose:* Agent on Azure, by design.
- *Evidence:* [documents](documents.md#load-a-library).
- *What Agent on Azure does:* `--open-listener` turns the account's public listener on and lets the operator's own address through its firewall for the upload window alone, and takes both back from an exit trap ([documents](documents.md#load-a-library)).

## The voice agent and its tools

What a Foundry voice agent's tools, model and capacity allow.

**Tools or a toolbox, never both.** A voice agent has individual tools or one toolbox, never both, and server-side tools (web search, Azure AI Search, OpenAPI) come only through a toolbox.

- *Whose:* The service, as Microsoft Learn describes it.
- *Evidence:* [Configure a voice agent](https://learn.microsoft.com/en-us/azure/foundry/agents/how-to/configure-voice-agent): "Attach server-side tools such as web search, Azure AI Search, and OpenAPI tools through a toolbox rather than declaring them directly" and "a voice-based agent can have individual tools or one toolbox, but not both. Attaching a toolbox replaces the agent's individual tools list"; [Toolbox](https://learn.microsoft.com/en-us/azure/foundry/agents/how-to/tools/toolbox) (no line quoted); `VoiceAgentDefinition` has no `skills` field in `@azure/ai-projects` 2.10.0.
- *What Agent on Azure does:* The [stage](patterns.md#terms) controls, web search and the skills stay the backend's own function tools on the voice agent — [decisions](decisions.md), decisions 6 and 22.

**The voice agent's `mcp` tool fails on a private account.** A voice agent's own `mcp` tool reaches no MCP server on an account with public network access off; on one with it on, it does.

- *Whose:* The service, as observed.
- *Evidence:* Microsoft Learn's pages on private networking and a toolbox's network isolation describe other agents. For a voice agent, this is observed behavior: Voice Live lists the tool's server from Microsoft's public addresses, and the private account answers `403` ([Details](#a-voice-agents-mcp-tool-on-a-private-account)).
- *What Agent on Azure does:* Not used, on either channel, by choice: the backend's `knowledgeSearch` asks the knowledge base's `retrieve` route itself, over the search private endpoint, on every deployment ([Details](#a-voice-agents-mcp-tool-on-a-private-account)).

**A voice tool's latency is the conversation's.** A voice tool's latency is the conversation's: a live session's search waits at most `retrieval.voiceDeadlineMs` (8 s by default), while a knowledge base's `maxRuntimeInSeconds` defaults to 90 s and planning above `minimal` adds seconds to a search.

- *Whose:* Agent on Azure, by design.
- *Evidence:* A search can miss the time limit, hybrid or on the base; the backend then reports that it `did not answer within` the bound and the turn goes on without it. [Azure AI Search limits: Retrieve request runtime](https://learn.microsoft.com/en-us/azure/search/search-limits-quotas-capacity#retrieve-request-runtime), gives the base's.
- *What Agent on Azure does:* The time limit is a setting, beside the efforts it is weighed against (a typed turn's is `retrieval.deadlineMs`); the spoken fillers, in the person's language, cover a search in progress — [configuration](configuration.md#knowledge), [architecture](architecture.md#voice).

**A realtime model may not support every [cascade](patterns.md#terms) feature.** A realtime model in a voice agent may not support everything the cascade does: tools, fillers while a tool runs, the voices, the advanced speech settings.

- *Whose:* The service; Microsoft Learn says it varies by model.
- *Evidence:* [Configure a voice agent](https://learn.microsoft.com/en-us/azure/foundry/agents/how-to/configure-voice-agent): "Changing the model can change: Which voices are compatible. Whether a separate User transcript model appears. Which advanced speech and conversation settings are available. Whether interim responses are available. Whether the model supports tools." Agent on Azure assumes none of these per model; verify a session after changing it.
- *What Agent on Azure does:* `voice.engine` is `speechToSpeech` by default, and keeps the cascade's Azure voices, tools and fillers in its version. Try a session after changing the realtime model ([Details](#what-a-realtime-model-supports)).

**A private realtime deployment for voice is observed behavior.** A voice agent reaching a realtime deployment behind the account's private endpoint is observed behavior, not a published configuration.

- *Whose:* The service, as observed.
- *Evidence:* [Configure a voice agent](https://learn.microsoft.com/en-us/azure/foundry/agents/how-to/configure-voice-agent) says a self-deployed model in the project's own Foundry resource is connected and authenticated by Foundry. Network isolation for it is observed behavior: both engines' sessions open on an account whose public access is off, the realtime deployment reached the way the chat's is.
- *What Agent on Azure does:* Nothing more is assumed: on a private deployment, try a session after a deploy; `voice.engine` `cascade` is the way back ([deployment](deployment.md#speech-to-speech-voice)).

**Instruction and header size in a voice session.** A [speech-to-speech](patterns.md#terms) session's rendered instructions are held to 16,384 tokens ("Instructions cannot be longer than 16384 tokens"), and a session past it answers without them; the person's part reaches the service in a header that takes a few tens of kilobytes.

- *Whose:* The service, as observed.
- *Evidence:* Observed behavior, not a published limit, on a `GlobalStandard` realtime deployment. Untested on a `DataZoneStandard` deployment; verify before relying on the same cap ([Details](#instruction-and-header-size-in-a-voice-session)).
- *What Agent on Azure does:* The backend counts a speech-to-speech session's rendered instructions and holds them to 16,384 tokens, and holds the person's part on either engine to 32,000 characters ([Details](#instruction-and-header-size-in-a-voice-session)).

**Not every control socket echoes an update.** An update's echo and an item's acknowledgement are not sent on every Voice Live control socket: Voice Live's own cascade answers a `session.update` with no `session.updated` there.

- *Whose:* The service, as observed.
- *Evidence:* Observed behavior, not a published limit, on Voice Live's own WebSocket. A voice agent does echo, on both engines: its own `session.updated` as it applies the version, then the person's, then `conversation.item.created` for each line of the thread, the whole opening within a second on either engine.
- *What Agent on Azure does:* The opening depends on neither. It waits for the service's own `session.updated` at most 3 s and for the person's echo at most `voice.live.updateTimeoutMs` (5 s), then opens the session anyway and gives the thread without waiting for acknowledgements. A later refusal of the session's settings still ends it by name (`voice.live.session_refused`) ([configuration](configuration.md#voice)).

**What a realtime capacity unit buys.** What one unit of `capacity` buys on a realtime deployment.

- *Whose:* The service, as observed.
- *Evidence:* The [quota page](https://learn.microsoft.com/en-us/azure/foundry/openai/quotas-limits) states realtime limits in requests and tokens per minute. Agent on Azure assumes no mapping from a deployment's capacity unit to either, or to concurrent sessions; a load test shows it.
- *What Agent on Azure does:* `REALTIME_CAPACITY` defaults to one, the least a deployment takes; size it against the subscription's granted quota and what a load test shows ([configuration](configuration.md#the-realtime-deployment)).

## Speech, voices and turn detection

How a session hears the person and speaks back.

**Fillers are written by the service's model.** A voice's fillers are written by the service's model, not by a deployment of the account's, so verify them with a session on the realtime model you deploy.

- *Whose:* The service, partly as Microsoft Learn describes it and partly as observed.
- *Evidence:* The filler type and its default model are documented, and that model "might change without a new API version". Whether the generated filler runs on both engines and in hardened mode is untested; try a session on each before relying on it ([Details](#voice-fillers)).
- *What Agent on Azure does:* The version names no filler model, so the service's default writes it; the instructions (`INTERIM_INSTRUCTIONS` in [voice-definition.ts](../platform/agent/src/foundry/voice-definition.ts)) keep it short, in the conversation's language and free of any claimed result — [decisions](decisions.md), decision 6.

**One multilingual voice per tier.** One multilingual voice per tier, its accent set per session by locale (`voice_locale`); no voice per language.

- *Whose:* Agent on Azure, by design.
- *Evidence:* [decisions](decisions.md), decision 14.
- *What Agent on Azure does:* `live.voices.base`, `live.voices.premium` and `live.language` in the `voice` document ([configuration](configuration.md#voice)).

**Personal noise suppression enrolls the speaker.** The personal noise suppression enrolls the speaker automatically, from their voice, and Agent on Azure assumes that speaker data may outlive the session; its `detection_input` cannot be set, and whether it enrolled a speaker cannot be seen.

- *Whose:* The service, as observed.
- *Evidence:* The voice-agent REST specification says the type "personalizes detection after automatic speaker enrollment"; how long the enrollment is kept isn't stated there, so treat it as speaker data ([Details](#personal-noise-suppression)).
- *What Agent on Azure does:* `voice.noiseReduction` sends the type only, the headset type by default, which enrolls nobody. `azure_personal_noise_suppression` is taken by the service on both engines and echoed in the session, which says nothing of a speaker enrolled — [configuration](configuration.md#agent), [privacy](privacy.md#known-gaps).

**An unknown noise-suppression type drops the version.** A voice-agent version is made with any noise-suppression type, but a session on a version whose type the service does not know runs on the service's defaults, without the version's instructions (its guardrails included) or its tools.

- *Whose:* The service, as observed.
- *Evidence:* Observed behavior, not a published limit: the session answers `invalid_value` naming the types it takes, then runs with none of the version's instructions or tools ([Details](#an-unknown-noise-suppression-type)).
- *What Agent on Azure does:* `voice.noiseReduction` takes only the three types the service documents for Voice Live, so no version Agent on Azure makes carries an unknown type. A session refused so all the same is ended by the backend ([Details](#an-unknown-noise-suppression-type)).

**Noise suppression beside `semantic_vad` is refused.** Beside a realtime model's own turn detection (`semantic_vad`), the headset and personal noise suppressions are refused; the plain deep model is taken.

- *Whose:* The service, as observed.
- *Evidence:* Observed behavior, not a published limit: the session is sent `speech_frontend_not_available` as it opens, then carries on without the noise suppression it asked for ([Details](#noise-suppression-beside-semantic_vad)).
- *What Agent on Azure does:* The version's own turn detection (`azure_semantic_vad_multilingual`) runs every type, so no default reaches it. A voice tester's `semantic_vad` is offered only beside `azure_deep_noise_suppression` ([Details](#noise-suppression-beside-semantic_vad)).

**A session update cannot change how a session hears.** A session update cannot change how a voice agent's session hears the person: the turn detection's type or the noise suppression's speech front end.

- *Whose:* The service, as observed.
- *Evidence:* Observed behavior, not a published limit: a `session.update` that changes either is refused whole, with `turn_detection_type_change_not_allowed` ("Cannot change turn detection type during session") or `change_in_speech_frontend_not_allowed` ("Cannot change the speech frontend during a session", the headset model to the plain or personal one), and the session runs on its version, still answering.
- *What Agent on Azure does:* A voice tester's turn detection and noise suppression are part of the tester's voice-agent version, not the session's update (`versionHearing`, `platform/agent/src/foundry/voice-tuning.ts`). So the update that carries the tier's voice and the person's language is never refused for them; each such tuning is a version of its own, made at its first session.

**Multilingual turn detection needs a language list.** `azure_semantic_vad_multilingual` turn detection takes an explicit list of languages to detect among.

- *Whose:* The service, as Microsoft Learn describes it.
- *Evidence:* No Learn line is recorded here; check the [Voice Live how-to](https://learn.microsoft.com/en-us/azure/ai-services/speech-service/voice-live-how-to) for the API version you use.
- *What Agent on Azure does:* Every session passes the product's locale codes as `turn_detection.languages` ([voice-definition.ts](../platform/agent/src/foundry/voice-definition.ts)).

**Transcribers are documented per transcriber.** Which transcribers a realtime voice agent takes is documented per transcriber, not per voice-agent version.

- *Whose:* The service, partly as Microsoft Learn describes it and partly as observed.
- *Evidence:* The [Voice Live how-to](https://learn.microsoft.com/en-us/azure/ai-services/speech-service/voice-live-how-to) lists the transcribers per model family. Any other transcriber is observed behavior only ([Details](#transcribers-on-a-realtime-voice-agent)).
- *What Agent on Azure does:* Speech-to-speech keeps to what is documented and never sends `azure-speech`: its version takes `mai-transcribe` in its place (`agent.voice.transcriber_replaced`) ([configuration](configuration.md#agent)).

**The `gpt-4o-transcribe` family needs a named deployment.** On a realtime voice agent, the `gpt-4o-transcribe` family (`gpt-4o-transcribe`, `gpt-4o-mini-transcribe`, `gpt-4o-transcribe-diarize`) transcribes only through a deployment on the account named after the transcriber; Microsoft Learn says both that the value is a model name and that it is a deployment name.

- *Whose:* The service; Microsoft Learn describes it two ways, and Agent on Azure follows the one the service matches.
- *Evidence:* One Learn page calls the value a model name, another a deployment name, and the service behaves as the second says ([Details](#the-gpt-4o-transcribe-family)).
- *What Agent on Azure does:* The template deploys no transcriber: the default `mai-transcribe` and the cascade's `azure-speech` need none. An operator choosing the family for speech-to-speech adds a deployment named after it ([configuration](configuration.md#agent)).

**OpenAI voices only without fillers.** A realtime voice agent speaks in the model's own voice (an OpenAI voice such as `marin`) only with no fillers, and then without `voice_locale`, the Azure voices' style settings or word timestamps; a cascade refuses one.

- *Whose:* The service, partly as Microsoft Learn describes it and partly as observed.
- *Evidence:* The voice-agent REST specification gives an `openai` voice only `voice` and `speed`. That fillers need an Azure voice, and that a cascade refuses an OpenAI voice, are observed behavior ([Details](#openai-voices)).
- *What Agent on Azure does:* Offered on speech-to-speech alone (`live.openaiVoices` in the `voice` document, or a voice tester's tuning), never on the cascade. Every other session speaks in the tier's Azure voice, which keeps the fillers and the accent ([Details](#openai-voices)).

**`auto_truncate` is documented two ways.** `auto_truncate` in a voice agent's turn detection is documented as two different things.

- *Whose:* The service; Microsoft Learn describes it two ways, and Agent on Azure follows the one the service matches.
- *Evidence:* One Learn page describes it as truncating the input buffer when speech stops, two others as truncating on interruption, default off. The service behaves as the second ([Details](#auto_truncate)).
- *What Agent on Azure does:* The version states it off on both engines. The line the thread keeps is the whole reply the model generated, marked interrupted, not what the person heard ([architecture](architecture.md#voice)).

**Transcription `keywords` are ignored.** Voice Live accepts a transcription's `keywords` without an error and applies none of them; a transcription `prompt` ("Expected terminology: …") does steer a `gpt-4o-transcribe`-family transcriber, and `phrase_list` is the field for `azure-speech` and `mai-transcribe`.

- *Whose:* The service, partly as Microsoft Learn describes it and partly as observed.
- *Evidence:* The [Voice Live how-to](https://learn.microsoft.com/en-us/azure/ai-services/speech-service/voice-live-how-to) documents `prompt` beside the `gpt-4o-transcribe` family and `phrase_list` beside `azure-speech` and `mai-transcribe`, and no `keywords`. That `keywords` is accepted and changes nothing is observed behavior: names the keywords spelled were still misheard, where the same words as a `prompt` were heard.
- *What Agent on Azure does:* Agent on Azure sends no transcription vocabulary. A product that adds one sends `phrase_list` with the voice agent's default `mai-transcribe` (or `azure-speech`), `prompt` with a `gpt-4o-transcribe`-family transcriber, and never `keywords`; the update's echo carrying the field is no proof it applied.

## Where voice is processed

Which voice components process outside the account's region or data zone.

**Managed voice models process where the service decides.** A managed voice-agent model (`model_type: managed`) processes where the service decides: the plain names at Global scope, and only the `-datazone` names in the data zone.

- *Whose:* The service, partly as Microsoft Learn describes it; a voice agent's managed-model scope is not stated there.
- *Evidence:* Voice Live's region table gives each managed model's inference scope; no voice-agent page states which processing region a managed model uses, and a version or a session names none ([Details](#managed-voice-models)).
- *What Agent on Azure does:* The voice agent is `self_deployed` on the account's own deployments, whose SKU states where they process, unless an operator or a voice tester opts into a managed model ([Details](#managed-voice-models)).

**Speech has processing scopes of its own.** Voice Live's speech recognition and HD speech synthesis have processing scopes of their own, independent of the model's, so speech can be processed outside the account's region even on the account's own deployments.

- *Whose:* The service, as Microsoft Learn describes it.
- *Evidence:* [Speech regions, Voice Live](https://learn.microsoft.com/en-us/azure/ai-services/speech-service/regions?tabs=voice-live): "Processing can occur outside your resource region." ([Details](#speech-processing-scopes)).
- *What Agent on Azure does:* The premium tier's HD voice is Regional; speech-to-speech transcribes with `mai-transcribe`, Data zone. [privacy](privacy.md#what-reaches-the-model) says so.

**Realtime mini models have no data zone.** The realtime mini models have no data-zone option, and only `gpt-realtime-2.1-mini` takes a reasoning effort.

- *Whose:* The service, partly as Microsoft Learn describes it and partly as observed.
- *Evidence:* `gpt-realtime-2.1-mini` and `gpt-realtime-mini` are offered as `GlobalStandard` and in no Data Zone Standard table. `gpt-realtime-mini` is observed to refuse an effort ([Details](#the-realtime-mini-models)).
- *What Agent on Azure does:* `models.realtime` takes either mini with no code change, and the session sends an effort only to a reasoning model. A mini is processed at Global scope, never within the data zone ([Details](#the-realtime-mini-models)).

## Voice Live without a voice agent

Live voice can opt into the generally available Voice Live API in place of a Foundry voice agent ([decisions](decisions.md), decision 31). What that gives up:

**A fixed content filter.** Voice Live applies its own built-in content filter, and the deployment's `default-indirect` policy does not reach the session.

- *Whose:* The service, as Microsoft Learn describes it.
- *Evidence:* The [Voice Live FAQ](https://learn.microsoft.com/en-us/azure/ai-services/speech-service/voice-live-faq) says its filter cannot be changed.
- *What Agent on Azure does:* Keeps the voice agent as the default; a deployment that needs its own filter policy for voice stays on it ([voice runtimes](configuration.md#voice-runtimes)).

**No accent per language and no reasoning effort.** Neither has a field the Voice Live session documents.

- *Whose:* The service, as Microsoft Learn describes it.
- *Evidence:* The [Voice Live how-to](https://learn.microsoft.com/en-us/azure/ai-services/speech-service/voice-live-how-to) documents neither.
- *What Agent on Azure does:* Sends neither on Voice Live; the voice agent keeps both.

**A quota of its own.** Voice Live meters its hosted models against a tokens-per-minute quota on the resource, not a deployment's capacity.

- *Whose:* The service.
- *Evidence:* The hosted models run on no deployment of the account's, so the capacity the template sizes neither bounds nor meters them.
- *What Agent on Azure does:* Nothing beyond the session limits; load-test at the expected peak.

**A slower start.** A session takes about a second longer to open than on a voice agent.

- *Whose:* The service, as observed.
- *Evidence:* Observed on a demo-mode deployment.
- *What Agent on Azure does:* What the person says while the session opens is held and sent once it is ready.

## The agent and its model

Behavior of the model, the agent's versions and its tools.

**Web search sends search words to Bing.** `web_search` sends the search words the model chooses to Microsoft Bing, outside the deployment's Azure compliance boundary.

- *Whose:* Agent on Azure, by design.
- *Evidence:* [privacy](privacy.md#what-is-stored), [security](security.md#model-safety); [Web tools overview](https://learn.microsoft.com/en-us/azure/foundry/agents/how-to/tools/web-overview) (no line quoted).
- *What Agent on Azure does:* Bounded by `limits.toolSearch` and switched off by removing `webSearch` from the `tools` document's `enabled_tools` ([configuration](configuration.md#tools)).

**A turn of stage controls only can repeat itself.** Asked to continue after a response that wrote words and called only stage controls, the model can restate the whole reply, which would stream and be kept twice; told only "error" for a control the client does not have, it can retry that control until the step limit.

- *Whose:* The model, as observed.
- *Evidence:* Observed model behavior.
- *What Agent on Azure does:* A response that wrote words and called nothing but controls ends the turn, and a step that could end wordless is followed by one step with `tool_choice: "none"` ([Details](#a-turn-that-calls-only-stage-controls)).

**A new agent version can be missing from the listing.** The service's listing of an agent's versions can leave out a version made minutes before, while reading that version by its number returns it.

- *Whose:* The service, as observed.
- *Evidence:* Observed behavior, not a published limit: `listVersions` in descending order did not return newly made voice-agent versions for minutes, while `getVersion` did.
- *What Agent on Azure does:* A version is found by its definition's hash in the listing, then in the version numbers past the newest listed ([Details](#a-version-missing-from-the-listing)).

**A persona version shadows the shipped text.** The persona's versioned row shadows the shipped text: once a version exists, a change to the text in code is not what a deployment serves.

- *Whose:* Agent on Azure, by design.
- *Evidence:* [operations](operations.md#changing-the-persona).
- *What Agent on Azure does:* A version the job writes carries `source: "shipped"`. While the latest version is the job's, the job publishes the changed text as the next `v<n>`, and an operator's version is never written over ([operations](operations.md#changing-the-persona)).

## Deployment and operations

What affects provisioning, scripts and telemetry.

**AI Search capacity varies by region.** Azure AI Search capacity varies by region, and some regions refuse new services.

- *Whose:* The service, as Microsoft Learn describes it.
- *Evidence:* [Choose a region for Azure AI Search](https://learn.microsoft.com/en-us/azure/search/search-region-support), a region's footnote: "This region is in high demand, which prevents the creation of new search services. Please choose a different region." Provisioning then fails with `InsufficientResourcesAvailable: The region '<region>' is currently out of the resources required to provision new services.`
- *What Agent on Azure does:* `azd env set AZURE_SEARCH_LOCATION <region>` places Search alone in another region ([deployment](deployment.md#regions-and-model-quota)).

**Scripts need `AZURE_SUBSCRIPTION_ID`.** The hooks and the ingest script need `AZURE_SUBSCRIPTION_ID`: `az` answers in whichever subscription was selected last on your machine.

- *Whose:* The template, by design.
- *Evidence:* Against another subscription `az` cannot find the deployment's resources, for example `The containerapps job ... does not exist`.
- *What Agent on Azure does:* Every `az` call carries `--subscription $AZURE_SUBSCRIPTION_ID` and stops with a plain line when it is unset.

**AI Search answers a retried write with 409.** AI Search answers a second PUT of a definition it is still applying with 409 when the HTTP pipeline re-sends a write whose response was lost.

- *Whose:* The service, as observed.
- *Evidence:* Observed behavior: the retried PUT is answered 409 `There was a conflicting update. No change was made to the resource from this request.`
- *What Agent on Azure does:* A 409 on any of the four `createOrUpdate*` writes of the `index` step counts as the write already applied; every other error still fails the step.

**Agent Service traces are all or nothing.** The Agent Service's server-side traces hold each turn's words, and are all or nothing: a project connected to Application Insights is traced, every agent in it, with no setting of Agent on Azure's between.

- *Whose:* The service, as Microsoft Learn describes it.
- *Evidence:* [Set up tracing](https://learn.microsoft.com/en-us/azure/foundry/observability/how-to/trace-agent-setup): "Foundry enables it automatically after you connect an Application Insights resource to your project"; its *Security and privacy* section says a trace can capture user inputs, model outputs, and tool arguments and results.
- *What Agent on Azure does:* The connection is made only with `AGENT_TRACING=true` ([configuration](configuration.md#deployment-parameters)). On, the traces are in the workspace for its retention, outside the apps' scrubbing and out of reach of a delete or an erase, and the shipped notice's line about logs says an organization may switch it on ([privacy](privacy.md#what-is-stored)).

## Details

### The memory store on a private deployment

Under `PRIVATE_NETWORKING`, `memory.store` defaults to `own`. `preprovision` refuses `MEMORY_STORE=foundry` before anything is made. The job's `settings` step refuses it too, and a stored document edited to it, both under `agent.memory.store_unreachable_private`, telling you to set `own`. An edit to `foundry` after the deploy is reported under the same code, and the own store runs. See [configuration](configuration.md#memory-on-a-private-deployment).

### Conversations kept on the service

**Evidence.** This is observed behavior, not a published limit:

- The run-state container in the project's `enterprise_memory` database carries a 60-day default time to live.
- A conversation's own document is not rewritten as it is used, so it expires 60 days after it was made.
- An API delete of an item or a conversation removes it from what the API answers but not from the container. Every document stays there, marked not deleted, with the message text, the reasoning items and the input images, until the time to live expires it.

This contradicts the [FAQ](https://learn.microsoft.com/en-us/azure/foundry/agents/faq): "Data persists unless you explicitly delete it". Nor can the documents be removed by hand: the [recovery guide](https://learn.microsoft.com/en-us/azure/foundry/how-to/agent-service-operator-disaster-recovery) says "Direct manipulation of data (such as trying to recreate the thread's records) in your `enterprise_memory` database isn't a supported action."

**What Agent on Azure does.** `history.store` is `own` by default, where the history lives in the deployment's own Cosmos container and every response runs with `store: false`. On `foundry`:

- the job and the backend warn (`agent.history.service_retention`);
- a 404 renews the thread's conversation, and the turn goes on without the earlier messages (`agent.history.conversation_expired`);
- an erasure calls every delete;
- the privacy notice says what the service keeps.

See [configuration](configuration.md#agent) and [decisions](decisions.md), decision 3.

### A voice agent's MCP tool on a private account

**What Microsoft Learn says.** [Configure a voice agent](https://learn.microsoft.com/en-us/azure/foundry/agents/how-to/configure-voice-agent) lists `mcp` and `toolbox` among a voice agent's tool kinds, both "Executed by" the service. The [Agent Service overview](https://learn.microsoft.com/en-us/azure/foundry/agents/overview) says "Private networking is available for prompt agents". [Network isolation for a toolbox](https://learn.microsoft.com/en-us/azure/foundry/agents/how-to/tools/toolbox-network-isolation) says "agents reach the toolbox MCP endpoint through the project's private endpoint". Neither page covers a voice agent, so what follows is observed behavior.

**How the service behaves on a private account.** The service turns a voice agent's `mcp` tool into a toolbox of its own; the session reports it as `foundry_toolbox`, with the server URL and authorization redacted. Voice Live lists that toolbox's tools by calling the project's `/toolboxes/{name}/versions/{version}/mcp` endpoint from Microsoft's public addresses, not through the account's private endpoint. The account answers `403` "Public access is disabled. Please configure private endpoint."; the account's request log has the call, from a public address, with that answer's length. The session reports `mcp_list_tools.failed` with no error detail, then answers with no search.

**The payload is ruled out.** Three payloads all fail the same way: the knowledge base's tool under its project connection, a public MCP server that needs no authentication (with and without `allowed_tools`), and a `toolbox` tool whose entry the service builds itself. The same toolbox listed from inside the network answers with the base's tool.

**On an account with public access on.** The same three reach their servers. The session reports the Learn server as `mcp` and the base as `foundry_iq_mcp`, lists their tools and calls them. The base's tool answers in Learn's documented `[{ref_id, title, content}]` format, rather than the `{"documents": […]}` a typed turn's `mcp_call` carries. So the failure is the private account's, not the payload's, and a public deployment's voice agent could carry the base as the service's tool. Agent on Azure doesn't use a voice agent's `mcp` tool, so it relies on no per-user `x-ms-query-source-authorization` header there.

**What Agent on Azure does.** The backend's `knowledgeSearch` asks the knowledge base's `retrieve` route itself, over the search private endpoint, on every deployment. It carries the effort on each call, and applies the served filter and the readers clause to what it returns. The service's `mcp` tool takes no per-call effort, and its result reaches the model past both filters ([decisions](decisions.md), decision 27).

### Voice fillers

`llm_interim_response` is a type of `VoiceAgentDefinition`'s `interim_response` in `@azure/ai-projects` 2.10.0 and of [Configure a voice agent](https://learn.microsoft.com/en-us/azure/foundry/agents/how-to/configure-voice-agent) ("a model authors the filler from `instructions`"). The [Voice Live API reference, version `2026-07-15`](https://learn.microsoft.com/en-us/azure/ai-services/speech-service/voice-live-api-reference-2026-07-15) gives its `model` as "Default is `gpt-4.1-mini`. The default model might change without a new API version." Configure a voice agent says changing the model can change "Whether interim responses are available", per model, and lists none. Whether the generated filler runs on both engines and in hardened mode is untested; try a session on each before relying on it.

### Personal noise suppression

The voice-agent REST specification ([`azure-rest-api-specs`](https://github.com/Azure/azure-rest-api-specs), `specification/ai-foundry/data-plane/Foundry/src/voice-agents/agents.tsp`) describes `azure_personal_noise_suppression` as one that "personalizes detection after automatic speaker enrollment". No API enrolls a speaker or names a profile, and Agent on Azure assumes the enrollment may outlive the session. The [Voice Live how-to](https://learn.microsoft.com/en-us/azure/ai-services/speech-service/voice-live-how-to): "The `session.updated` event confirms your requested configuration, not whether personalization is active. Speaker targeting isn't an identity-verification mechanism."

Agent on Azure doesn't send `detection_input`, which isn't among the documented fields, and `@azure/ai-projects`' `voiceAgentNoiseReductionSerializer` writes `{ type }` alone. Microsoft's sample [`samples/foundry_voice_webrtc/README.md`](https://github.com/microsoft/voice-agent/blob/main/samples/foundry_voice_webrtc/README.md) says: "end-to-end support for those fields is not established".

### An unknown noise-suppression type

**Evidence.** Observed behavior, not a published limit: the version is made, and the session answers `invalid_value` naming the types it takes (the three of the setting, `near_field` and `far_field`). It then goes on with the service's own turn detection, none of the version's instructions and none of its tools. On both engines the model then calls itself the model's vendor's assistant and says it has no search.

**What Agent on Azure does.** `voice.noiseReduction` takes only the three types the service documents for Voice Live. Any other stored value is refused by the settings' validation and keeps the default, so no version Agent on Azure makes carries an unknown type ([configuration](configuration.md#agent)). Should a session still be answered so, the backend ends it rather than let it run without its instructions. `invalid_value` naming the noise suppression is one of the codes that refuse a session's settings (`platform/voice/src/voicelive/refusals.ts`). The browser is refused `settings_refused` before the session is ready, or the session ends `refused` after (`voice.live.session_refused`).

### Noise suppression beside `semantic_vad`

**Evidence.** Beside a realtime model's own turn detection (`semantic_vad`), the session has no speech front end. Observed behavior, not a published limit: a voice-agent version on a realtime deployment with `semantic_vad` and either `azure_deep_noise_suppression_headset` or `azure_personal_noise_suppression` is made. Its session is sent `speech_frontend_not_available` on `session.input_audio_noise_reduction` as it opens ("Noise reduction 'azure_deep_noise_suppression_headset' is not available for this session: upstream_vad_owned."), and then carries on without the noise suppression it was refused. With `azure_deep_noise_suppression` the same version opens clean.

**What Agent on Azure does.** The version's own turn detection (`azure_semantic_vad_multilingual`) runs every type, so no default reaches the problem. A voice tester's `semantic_vad` is offered and accepted only beside `azure_deep_noise_suppression`, which replaces the documents' type in the tester's version, and the panel says so (`platform/agent/src/foundry/voice-tuning.ts`). Should a session be refused so all the same, the backend refuses the open as `settings_refused` rather than run it on settings it did not ask for (`voice.live.session_refused`).

### A turn that calls only stage controls

A response that wrote words and called nothing but controls ends the turn. The `not_available` answer says the control is not on this client and to reply in words. The model can call it again regardless, so one more step with `tool_choice: "none"` follows either of these:

- a step that wrote nothing and called a control the client lacks;
- a wordless step at the step limit.

So a typed turn never ends with no words while nobody still has a call to answer. Whether the service accepts `tool_choice` beside an agent reference is untested against the service (the test stand-in accepts it); verify it on your deployment.

### What the memory store keeps

The product's details (`memory.userProfileDetails`, or `DEFAULT_MEMORY_DETAILS` when it says nothing) tell the store never to keep an instruction as a fact. A store made before a change to them keeps the old text until it is made again ([operations](operations.md)). Whatever either store keeps reaches the prompt only in the personalization part, framed as information about the person and never as instructions, and the person can see and remove each statement. `memory.foundry.procedural`, off by default, has the store keep how the person wants things done as procedures.

### A stalled memory update

An update whose extraction calls are all refused (the 403 of the [first memory limitation](#memory)) reads `in_progress` on every read. [Use memory](https://learn.microsoft.com/en-us/azure/foundry/agents/how-to/memory-usage) treats a failed update as status `Failed` with `ErrorDetails`, which such an update does not reach. The store's `update_delay` defaults to 300 s (the memory REST reference; the same page's sample: "300 (5 minutes, default)"), and Agent on Azure sets its own, `memory.updateDelaySeconds`.

### A version missing from the listing

A version is found by its definition's hash in the listing, and then in the version numbers past the newest listed, read one by one until one is not there. So a process without a cached copy of the version (the job, or a restarted or new replica) finds a version just made instead of making it again. A duplicate would be harmless, and the prune deletes only versions the listing shows ([operations](operations.md)).

### What a realtime model supports

The service does not check a version's voices, tools and fillers when it makes the version: a model that refuses one refuses it when a session opens, so try a session after changing the realtime model. Fillers need an Azure voice: with an OpenAI voice the service refuses them (`interim_response_requires_azure_voice`), so a session with one runs without them. See [deployment](deployment.md#speech-to-speech-voice).

### Transcribers on a realtime voice agent

**What is documented.** The [Voice Live how-to](https://learn.microsoft.com/en-us/azure/ai-services/speech-service/voice-live-how-to) lists `azure-speech` for non-multimodal models and agents, and `mai-transcribe` for gpt-realtime, gpt-realtime-mini and the cascades. The SDK says `azure-speech-streaming` is "not supported with realtime speech-to-speech models".

**Observed behavior.** It makes a version with any transcriber, `azure-speech` on a realtime model included, and a realtime session then transcribes with `azure-speech`. It does so after a non-fatal `invalid_request_error` at the session's opening: "When using azure-speech as InputAudioTranscription, turn_detection must be of type AzureSemanticVAD or AzureMultilingualSemanticVAD." That error is raised against the session's default turn detection, before the version's applies. A cascade takes only the `azure-speech` and `mai-transcribe` families, and refuses any other when the session opens.

### The `gpt-4o-transcribe` family

[Configure a voice agent](https://learn.microsoft.com/en-us/azure/foundry/agents/how-to/configure-voice-agent): "This value is a model name, not a Foundry deployment name." The [Azure OpenAI Realtime API reference](https://learn.microsoft.com/en-us/azure/foundry/openai/realtime-audio-reference): "Azure OpenAI requires the name of the existing model deployment for the field, like `my-gpt-4o-transcribe-deployment`."

The service behaves as the second says, with the transcriber's own name as the deployment's. Without such a deployment every transcription of the session fails (`DeploymentNotFound`) and the session goes on; with one, the transcription is metered on it. `whisper-1`, `gpt-realtime-whisper`, `gpt-transcribe` and `gpt-live-transcribe` transcribe with no deployment of the account's.

### OpenAI voices

**Evidence.** The voice-agent REST specification ([`azure-rest-api-specs`](https://github.com/Azure/azure-rest-api-specs), `voice-agents/agents.tsp`) gives an `openai` voice only `voice` and `speed`. `voice_locale`, the lexicon, `prefer_locales`, `style`, `pitch` and `volume` apply to the Azure voice types. Two things are observed behavior: that fillers need an Azure voice (`interim_response_requires_azure_voice`), and that a cascade refuses an OpenAI voice (`invalid_voice: Only Azure voice is supported`). With an OpenAI voice the realtime deployment generates and meters the audio itself. The Voice Live how-to documents word timestamps (`output_audio_timestamp_types`) for Azure voices only.

**What Agent on Azure does.** A session with an OpenAI voice runs with no fillers and states no accent; the language directive in the instructions sets the language it speaks. Nothing asks for word timestamps, since a barge-in leaves the answer whole (`auto_truncate` off). See [configuration](configuration.md#voice).

### `auto_truncate`

[Configure a voice agent](https://learn.microsoft.com/en-us/azure/foundry/agents/how-to/configure-voice-agent): "Set `auto_truncate` to `True` to truncate the input audio buffer automatically when speech stops." The [Voice Live how-to](https://learn.microsoft.com/en-us/azure/ai-services/speech-service/voice-live-how-to) and the [Voice Live API reference, version `2026-07-15`](https://learn.microsoft.com/en-us/azure/ai-services/speech-service/voice-live-api-reference-2026-07-15): "Auto-truncate on interruption (default: false)".

This is observed behavior: turned on, the person speaking over the voice makes the service cut the answer's item to what was played, on both engines. Turned off, the response is canceled and no truncation is sent. With it off, a realtime model can still quote the reply's last generated sentence later in the session, while on the cascade the chat model answers as if the reply had never been given.

Agent on Azure states it off on both engines. Every typed turn after the session is given the whole reply; within the session, only a speech-to-speech model has it in its context.

### Managed voice models

**What Microsoft Learn says.** [Configure a voice agent](https://learn.microsoft.com/en-us/azure/foundry/agents/how-to/configure-voice-agent): "`managed`: the service hosts the model." [Pricing for voice-based agents](https://learn.microsoft.com/en-us/azure/foundry/agents/concepts/voice-agent-pricing): "Usage is billed as part of the voice agent", with no deployment of the account's. The [Agent Service overview](https://learn.microsoft.com/en-us/azure/foundry/agents/overview) calls it "A fully managed Voice Live model".

**Voice Live's region table.** [Speech regions, Voice Live](https://learn.microsoft.com/en-us/azure/ai-services/speech-service/regions?tabs=voice-live) gives those models' inference scope by resource region:

- In Sweden Central, `gpt-realtime-2.1`, `gpt-realtime-2.1-mini`, `gpt-realtime-mini` and `azure-realtime` are Global.
- Among the 2.1 models, only `gpt-realtime-2.1-datazone` stays in the data zone ("Prompts and responses are processed only within the data zone associated with your resource's region").
- France Central offers no `gpt-realtime-2.1-datazone`, and no managed realtime model is Regional in either region.

No voice-agent page states which processing region a managed model uses, and a version or a session names none.

**What Agent on Azure does.** The tuning panel shows each managed model's scope, and the `-datazone` names are the ones that stay in the data zone. See [decisions](decisions.md), decision 25, and [managed voice models](configuration.md#managed-voice-models).

### Speech processing scopes

[Speech regions, Voice Live](https://learn.microsoft.com/en-us/azure/ai-services/speech-service/regions?tabs=voice-live): "Voice Live is an exception: speech recognition, HD voice synthesis, and LLM inference have separate processing scopes. Processing can occur outside your resource region." In Sweden Central and France Central the HD voices are Regional, and `mai-transcribe` is Data zone (the alias "uses the same availability and processing scope as `mai-transcribe-2`"). The table gives no scope for `azure-speech` or the standard voices inside Voice Live. Agent on Azure assumes the table governs a voice agent's speech pipeline; verify it for your region before relying on it.

### The realtime mini models

**Evidence.** [Region availability for Foundry Models sold by Azure](https://learn.microsoft.com/en-us/azure/foundry/foundry-models/concepts/models-sold-directly-by-azure-region-availability): `gpt-realtime-2.1-mini` and `gpt-realtime-mini` are offered as `GlobalStandard` in Sweden Central and France Central, and in no Data Zone Standard table. As managed models both are Global ([Speech regions, Voice Live](https://learn.microsoft.com/en-us/azure/ai-services/speech-service/regions?tabs=voice-live)). The [model catalog](https://ai.azure.com/catalog/models/gpt-realtime-2.1-mini) gives `gpt-realtime-2.1-mini` a `reasoning.effort` of `minimal`, `low`, `medium` or `high`, and the service takes `xhigh` too. `gpt-realtime-mini` is observed to refuse an effort (`invalid_value`) and answer without one.

**What Agent on Azure does.** `AZURE_OPENAI_REALTIME_MODEL` follows the deployment's model, and the session sends an effort only to a reasoning model. A pin in `main.parameters.json` needs its own entry in `infra/model-deprecations.json`. See [configuration](configuration.md#the-realtime-deployment).

### Instruction and header size in a voice session

**Evidence.** Observed behavior, not a published limit:

- The realtime deployment (`gpt-realtime-2.1`, `GlobalStandard`) refuses a `session.update` with 16,500 or 66,000 tokens of instructions, the same cap as the realtime API itself.
- A voice-agent version on it whose rendered instructions came to 16,813 tokens was sent `invalid_value` on `session.instructions` as it opened, and went on answering without them.
- The cascade's chat model took 17,000 tokens and more.
- The structured-inputs header opened a session at 32,061 characters and was refused at the handshake at 48,063, on either engine.

A `DataZoneStandard` deployment's cap is untested; verify it before relying on the same number.

**What Agent on Azure does.** The backend renders a speech-to-speech session's instructions (the version's guardrails, persona and channel instructions, with the person's part) and counts them in `o200k_base`. The channel instructions are the per-channel instructions in `apps/backend/src/product/surface.ts` ([A typed turn](architecture.md#a-typed-turn)). It holds the instructions to 16,384 tokens, and holds the person's part on either engine to 32,000 characters as the header carries them, each character past ASCII counted as its six-character escape. It leaves the person's blocks out whole, in a fixed order, and never the guardrails, the date or the language directive. `agent.voice.personalization_trimmed` names what went, and `agent.voice.instructions_over_cap` a fixed part too long on its own (`platform/agent/src/foundry/voice-budget.ts`). The refusal itself is one the backend ends a session on (`settings_refused`).
