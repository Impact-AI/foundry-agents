# Adapting

This page shows the team planning a customer's assistant what it can change, what each change costs (data, settings, code, or a decision made before the first deploy), and which choices are flexible and which tie you to Azure or Microsoft Foundry. The patterns being adapted are in [patterns](patterns.md), and the step-by-step instructions for each change are in [extending](extending.md).

## What you reuse, and what you still build

Reuse sign-in, conversations, voice, retrieval, the [stage](patterns.md#terms) and the deployment template, and keep the application in your Azure environment. Whether Agent on Azure fits a customer's project at all, and what it costs to run, is in [Is it a fit?](is-it-a-fit.md). The MIT license lets you adapt and redistribute the code under its terms; it does not remove the need to configure Azure access, choose compatible components or implement your customer's business integrations. [Patterns](patterns.md) maps the reusable designs to the Microsoft services and code that implement them.

## What can change easily

- **Without a build:** documents and who may read them, the persona, refusal wording, enabled tools, limits, voices and branding, as data or settings on the running deployment.
- **With code and a deploy:** business systems, panels and languages; components such as the memory store are chosen at deploy time and editable later with the constraints the table gives.
- **Before the first deploy, or substantial engineering:** the mode, network, zones and sign-in; replacing Microsoft Foundry, AI Search or Cosmos DB.

[What you change, and what it costs](#what-you-change-and-what-it-costs) has every change with its mechanism. The optional [Impact AI Admin Center](impact-ai.md#impact-ai-admin-center) and [Impact AI Control Plane](impact-ai.md#impact-ai-control-plane) are separate from adopting Agent on Azure.

## Built in, and yours to build

**Already built and tested:**

- Sign-in (Entra, or a name-only demo mode).
- Per-person conversations, memory, export and erasure.
- Typed chat streamed over [AG-UI](patterns.md#terms).
- Live voice through a Foundry voice agent.
- The stage and its controls.
- Retrieval with document-level access control and Prompt Shields.
- Metering and allowances.
- Telemetry with scrubbing.
- Keyless access to every Azure service.
- The azd template in two modes (demo and hardened), its hooks, and a deployment check.

**Still yours to build:**

- The persona and the guardrail wording.
- The tools that reach your customer's systems.
- Any stage panels your data needs that the existing ones (document, picture, chart, record card, record list) don't cover.
- The document library and who may read each file.
- The languages beyond the five shipped.
- Acceptance scenarios written for your customer's domain ([acceptance](acceptance.md)).

## What you change, and what it costs

**Kinds of change:**

- **Data**: a load or a publish against a running deployment. No build.
- **Settings**: a value edited in App Configuration. Most refresh within about 30 seconds; memory-store selection needs a restart, and voice changes apply to new sessions.
- **Code**: a change in the repository, shipped with `azd deploy`.
- **Deploy**: an azd variable applied with `azd provision`.
- **Before first deploy**: an azd variable that shapes resources and can't be changed in place later.

| Change | Kind | Where | How |
| --- | --- | --- | --- |
| **Replace the documents** | Data | Your directory, plus `access.json` at its root | `./scripts/ingest.sh <dir>` ([load a library](documents.md#load-a-library)). Turn off the sample library with `azd env set SEED_SAMPLE_LIBRARY false` (applies on the next deploy, [the sample library](documents.md#the-sample-library)). |
| **Restrict who reads which document** | Data + Settings | `access.json`; the `access` document's `enforceAccessControl` | [Who may read a document](documents.md#who-may-read-a-document). Enforcement is on by default for a fresh hardened deployment; on an existing one, check the [access setting](configuration.md#access); on a demo, turn enforcement on *before* loading anything restricted. Group-based access needs Entra sign-in. |
| **Change the persona** (who the assistant is, how it works) | Data | Cosmos DB `prompts` container, versioned | `persona publish` ([changing the persona](operations.md#changing-the-persona)). The shipped default is `prompt` in `apps/backend/src/product.ts` (Code). |
| **Change what it refuses** | Settings | The `guardrails` document (`scope`, `declines`) | [`guardrails`](configuration.md#guardrails). The frame around those lines is code. |
| **Turn a tool off or on** | Settings | The `tools` document's `enabled_tools` | [`tools`](configuration.md#tools). A tool added in code later must be added to an existing deployment's stored list. |
| **Tune limits, allowances, voices, efforts** | Settings | The settings documents | [Tuning while it runs](operations.md#tuning-while-it-runs), [settings documents](configuration.md#settings-documents). Voice changes apply to the next session, subject to the model deployments and the voices available. |
| **Change the branding** | Settings | The [`appearance`](configuration.md#appearance) document, and the logo in storage | The palette, type, spacing, corners, the assistant's name and welcome line, and the logo, live within about a minute. The layout is fixed. |
| **Connect a business system** | Code | A server tool in `apps/backend/src/product/tools/` | [A server-side tool](extending.md#a-server-side-tool). The [worked example](worked-example.md) replaces the sample's records with an HTTP system end to end. |
| **Add a visual panel** | Code | Backend `product/stage-tools.ts`; frontend `src/stage/` and a tile under `app/(app)/stage/` | [A stage tool](extending.md#a-stage-tool). Needs strings in every message catalog and an end-to-end test. |
| **Add a procedure for one kind of question** | Code | The product's `skills` | [A skill](extending.md#a-skill). Typed turns, and live sessions through the backend's `readSkill` function unless its `surfaces` leave out `live`. |
| **Add a language** | Code | `product/locales.ts` and a message catalog in `apps/frontend/messages/` | [A language](extending.md#a-language). |
| **Rename the product, its agent and its telemetry name** | Code | `AGENT_ID`, `SERVICE_NAME` in `product.ts` | [Make it yours](extending.md#make-it-yours). |
| **Choose memory, history, retrieval and voice components** | Deploy-time defaults, then Settings | `MEMORY_STORE`, `HISTORY_STORE`, `RETRIEVAL_ENGINE`, `VOICE_ENGINE` | [Choose components at deploy time](deployment.md#choose-components-at-deploy-time). A memory-store change needs a backend restart, and existing memories do not move between stores; a history-store change applies to new conversations; under access enforcement both retrieval engines carry the caller's readers clause. |
| **Change a model deployment** | Deploy | The `models` parameter ([the models parameter](configuration.md#the-models-parameter)) | Not a live setting. Changing the embedding model's dimensions also means a new index. |
| **Choose demo or hardened, the network, zones, egress** | Before first deploy (fixed after) | `HARDENED`, `PRIVATE_NETWORKING`, `ZONE_REDUNDANT`, `AGENT_EGRESS` | [Demo and hardened](deployment.md#demo-and-hardened), [changing an existing environment](deployment.md#changing-an-existing-environment). |
| **Sign-in** | Before first deploy | `AUTH_MODE` (`local` or `entra`); the app registration | [Sign-in with Microsoft Entra ID](deployment.md#sign-in-with-microsoft-entra-id). |
| **Use a different agent service** | Code (large) | An `AgentHost` implementation next to `platform/agent/src/foundry/` | [A second agent host](extending.md#a-second-agent-host). It must pass the [parity suite](patterns.md#terms). |
| **Replace AI Search or Cosmos DB** | Code (large) | `platform/knowledge`, `platform/cosmos` | No supported alternative implementation ships ([flexible and Azure-specific choices](#flexible-and-azure-specific-choices)). |

Backend product behavior belongs in `apps/backend/src/product.ts` and `apps/backend/src/product/`. New panels and languages also touch the frontend. Reuse the platform packages where possible; a business integration that needs a new endpoint, identity permission or environment variable may also require infrastructure configuration, as the worked example shows.

<a id="which-choices-are-flexible-and-which-are-azure-or-foundry-specific"></a>

## Flexible and Azure-specific choices

| Layer | In Agent on Azure | Flexible within it | Tied to | Replacing it |
| --- | --- | --- | --- | --- |
| Hosting | Azure Container Apps, two apps and a job | Replicas, CPU and memory, zones ([scaling](operations.md#scaling)) | The Bicep in `infra/` | The apps are plain container images. Another host needs new infrastructure, not new application code. |
| Agent runtime | Foundry Agent Service | Models, reasoning effort, history and memory store | `platform/agent/src/foundry/` | An `AgentHost` implementation that passes the parity suite ([where the agent plugs in](architecture.md#the-agent-integration-point)): a large code change, and live voice binds separately. |
| Models | Azure OpenAI deployments on the Foundry account | Which model each deployment runs ([deployment parameters](configuration.md#deployment-parameters)) | The Foundry account | Through the agent runtime, as above. |
| Voice | Foundry voice agent (preview) | `speechToSpeech` or `cascade`, voices, a managed model ([voice](architecture.md#voice)) | The Voice Live protocol in `platform/voice` | No supported alternative today. |
| Retrieval | Azure AI Search, hybrid query with semantic ranking | `hybrid` or a Foundry IQ `knowledgeBase` over the same index ([retrieval](architecture.md#retrieval)) | `platform/knowledge` (index, indexer, skillset, query) | No supported alternative today. A business system's search is better reached as a tool. |
| Conversations, accounts, memory | Cosmos DB for NoSQL | `own` or `foundry` stores ([Foundry's or the deployment's own](architecture.md#foundrys-or-the-deployments-own)) | The container surface in `platform/cosmos` | Another store would implement that surface and pass its contract suite. Not supported today. |
| Fleet-shared state | Azure Managed Redis (Entra) | Any Redis for local development | `platform/redis` | Optional: without it typed chat runs and live voice is off. |
| Settings | Azure App Configuration | Every document, live | `platform/config` | Without a store, every document is its compiled-in default. |
| Sign-in | Auth.js with Microsoft Entra ID, or the demo's local sign-in | Role required, groups emitted ([security](security.md#sign-in)) | `apps/frontend/src/auth-providers.ts`, the `groups` claim | Another identity provider is code, and document access by group needs its groups claim. |
| Telemetry | OpenTelemetry to Application Insights | Sampling, on or off | `platform/observability` | Unset the connection string and telemetry is off. |

**Combinations that are refused**, before anything is made where possible: zone redundancy without the private network, the Foundry memory store on a private deployment, and an unknown component value. The rules live in one table in code, and the hooks and the deploy's job apply them ([where a combination is refused](deployment.md#choose-components-at-deploy-time)).

**Where the application falls back to a different component than the one selected.** Each fallback logs a named warning, so a deployment never runs something other than what was asked for without saying so:

| Selected | What runs instead | When | Warning |
| --- | --- | --- | --- |
| `voice.engine: speechToSpeech` | The [cascade](patterns.md#terms), on the `chat` deployment | No realtime deployment and no managed realtime model | `agent.voice.speech_to_speech_unconfigured` |
| A transcriber documented only beside a cascade | `mai-transcribe` | Under [speech-to-speech](patterns.md#terms) | `agent.voice.transcriber_replaced` |
| A knowledge base reasoning effort above `minimal` | `minimal` | No planning deployment (`KNOWLEDGE_BASE=true`) | `knowledge_base.planner_unconfigured` |
| `memory.store: foundry` stored on a private deployment | The own store | Always: the Foundry store can't reach a private account | `agent.memory.store_unreachable_private` |
| Live voice | Typed chat only | No Redis configured | The voice pane says no voice |

The records in the [worked example](worked-example.md) are a default, not a fallback. With `RECORDS_API_URL` unset, the tools read the sample's in-memory records. With it set, a failing system is reported as unavailable, and the tools never switch to the sample.

## Taking upstream fixes

A team that adopts Agent on Azure forks the repository and controls and maintains its fork, subject to the applicable licenses: it decides what runs, and nothing reaches it on its own. The maintainers' fixes and additions arrive when the team merges them from upstream:

```sh
git remote add upstream https://github.com/Impact-AI/foundry-agents.git
git fetch upstream
git merge upstream/main
```

The merge stays small when the customer's changes stay in the product layer: `apps/backend/src/product.ts` and `apps/backend/src/product/` on the backend, and the stage's panels (`apps/frontend/app/(app)/stage/`) and the message catalogs (`apps/frontend/messages/`) on the frontend. A change to `platform/`, `infra/` or the hooks is one the team carries through every merge. After merging, run `bun test` from the repository root, as [testing](testing.md) describes, before deploying.
