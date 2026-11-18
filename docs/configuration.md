
# Configuration

This page lists every setting of Agent on Azure in one place, each with its default: the template's parameters, the apps' environment variables and the settings documents an operator edits live. Read it when you provision a deployment or tune one that is running.

Agent on Azure has three kinds of setting, and each lives in one place:

| Kind | Where | Changed by | Takes effect |
| --- | --- | --- | --- |
| [Deployment parameters](#deployment-parameters) | azd environment → `infra/main.parameters.json` → `infra/main.bicep` | `azd env set NAME value`, then `azd provision` | On the next provision |
| [Environment variables](#environment-variables) | Each container's environment, set by the template | The template (`infra/modules/backend.bicep`, `frontend.bicep`) | On the next revision |
| [Settings documents](#settings-documents) | Azure App Configuration, one JSON document per key under `app/` | The portal, `az appconfig kv set`, or any App Configuration client | Within about 30 s (`CONFIG_TTL_MS`) on every backend replica; [`appearance`](#appearance) within about a minute |

The rule that decides which is which: an environment variable **names** something (a resource, a deployment, an identity, an endpoint, a secret) or **configures one replica's process** (a pool size, a timeout, a per-replica concurrency). Anything an operator tunes while the service runs (an allowance, a model setting, a feature switch) is a settings document.

`configuration.test.ts`, beside this page, fails the build when a parameter, an environment variable or a settings field exists in the code and not here, or here and not in the code, and when a default the source spells as a literal differs from the one here. The rules and effects below are prose no test reads.

## Deployment parameters

Set with `azd env set NAME value`. azd substitutes each into `infra/main.parameters.json`; a parameter with no azd variable takes its default from `infra/main.bicep`, and you change it by adding it to `main.parameters.json`. "Hardened" in the defaults below means hardened mode, `HARDENED=true`; the bundle is described in [deployment](deployment.md#demo-and-hardened).

| azd variable | Parameter | Default | What it decides |
| --- | --- | --- | --- |
| `AZURE_ENV_NAME` | `environmentName` | set by azd | The resource group (`rg-<name>`) and the `azd-env-name` tag; every resource name derives from it and the subscription. |
| `AZURE_LOCATION` | `location` | set by azd | The region of every resource, except AI Search when `AZURE_SEARCH_LOCATION` is set. |
| `AZURE_PRINCIPAL_ID` | `principalId` | set by azd | Who runs `azd up`. Also the operator, who gets the data-plane roles a person works with (see [architecture](architecture.md#identities-and-roles)), unless `OPERATOR_PRINCIPAL_ID` names one. Nobody else gets an Azure role: people who sign in hold none. |
| `AZURE_PRINCIPAL_TYPE` | `principalType` | `User`, set by `preprovision` | `User` or `ServicePrincipal`, from `az account show`. The template also accepts `Group`, which the hook never sets. |
| — | `models` | in `main.parameters.json` | One model deployment per role on the Foundry account: `chat`, `smallChat`, `embedding`, `realtime`, `knowledgeBase` ([details](#the-models-parameter)). |
| `REALTIME_CAPACITY` | `realtimeCapacity` | `1` | The capacity of the realtime deployment (`models.realtime`), set per environment because the subscription's quota decides what it may be: a provision asking for more than the region has free fails with `InsufficientQuota`. One is enough to try live voice; size it for load with a load test ([limitations](limitations.md)). Ignored while `realtime` is taken out. |
| `REALTIME_ALTERNATE_CAPACITY` | `realtimeAlternateCapacity` | `1` | The capacity of the second realtime deployment (`models.realtimeAlternate`), when the parameter file names one. |
| `KNOWLEDGE_BASE_CAPACITY` | `knowledgeBaseCapacity` | `10` | The capacity of the knowledge base's planning deployment (`models.knowledgeBase`), made only with `KNOWLEDGE_BASE=true` ([below](#the-knowledge-bases-planning-model)). Ten is room for a few planned searches a minute; raise it before real traffic runs above `minimal`. |
| `HARDENED` | `hardened` | `false` | Hardened mode, a bundle: network (the Agent Service injected into it), Front Door and WAF, locks, purge protection, zone redundancy, Entra-only sign-in with a role required, and document readers enforced on a fresh deployment (a stored [`access`](#access) document keeps its value). |
| `PRIVATE_NETWORKING` | `privateNetworking` | empty: as `HARDENED` | `true`/`false` overrides one part of the bundle: the virtual network, private endpoints, public listeners off on the data services, and the Foundry Agent Service injected into the `agent` subnet. Decide it before the first provision ([details](#private-networking)). |
| `USE_FRONT_DOOR` | `useFrontDoor` | empty: as `HARDENED` | Front Door Premium with a WAF, the Container Apps environment's public ingress closed. |
| `LOCK_DATA_RESOURCES` | `lockDataResources` | empty: as `HARDENED` | `CanNotDelete` locks on Cosmos DB, Storage, Key Vault, AI Search and App Configuration. |
| `KEY_VAULT_PURGE_PROTECTION` | `keyVaultPurgeProtection` | empty: as `HARDENED` | Key Vault purge protection. On, a deleted vault's name is held for the soft-delete period. |
| `ZONE_REDUNDANT` | `zoneRedundant` | empty: as `HARDENED` | A zone-redundant Container Apps environment with at least two replicas of each app, two AI Search replicas, ZRS storage, a replicated Azure Managed Redis, and Cosmos DB provisioned and zone-redundant instead of serverless. Cosmos DB takes it once, when the account is created. Only with private networking: `preprovision` refuses it without (`deployment.zones_need_network`). |
| `DEVELOPER_ACCESS` | `developerAccess` | `false` | Azure Bastion (Basic) and a small Linux VM in the network, signed in to with Microsoft Entra ID, for inspecting the private data services. Only with private networking ([developer access](deployment.md#developer-access)). |
| `DEVELOPER_ACCESS_SSH_KEY` | `developerAccessSshKey` | generated by `preprovision` when `DEVELOPER_ACCESS` is on | The public key the VM requires to exist; its private half is never kept, because sign-in is Entra's. |
| `DEVELOPER_VM_SIZE` | `developerVmSize` | `Standard_D2as_v5` | The jump VM's size, regional rather than zone-pinned. `AllocationFailed` on a provision means the region is out of that size for now: set another (`Standard_D2s_v5`) and provision again. |
| `AGENT_EGRESS` | `agentEgress` | `open` | The Agent Service subnet's way out, with private networking: `open` (or empty) or `restricted` ([details](#agent-egress)). Decide it before the first provision. Ignored without the network. |
| `PRIVATE_TELEMETRY` | `privateTelemetry` | empty: off | Opt-in, with private networking: telemetry ingestion through an Azure Monitor private link scope instead of public ingestion ([details](#private-telemetry)). Ignored without the network. |
| `AGENT_TRACING` | `agentTracing` | `false` | Opt-in: connect the Foundry project to Application Insights (its `insights` connection), which turns on the Agent Service's own traces. A trace holds the turn's words; read [agent tracing](#agent-tracing) before turning it on. |
| `POLICY_AUDIT` | `policyAudit` | `true` | Assign built-in Azure Policy definitions to the resource group, in Audit: local authentication off on the Foundry account, Cosmos DB, AI Search and Storage, and, with private networking, their public network access off. Audit reports and changes nothing. `false` assigns none ([decisions](decisions.md#30-azure-policy-in-audit-at-the-resource-group-local-authentication-in-both-modes-public-access-with-private-networking)). |
| `PUBLIC_ORIGIN` | `publicOrigin` | empty: derived | The frontend's public origin, for a custom domain only. Derived otherwise: the Front Door endpoint, else the Container Apps ingress. The provision prints the result as `FRONTEND_URL`. |
| — | `redisSku` | `Balanced_B0` | The Azure Managed Redis SKU name. Zone redundancy replicates whichever size this names across two nodes; the size can grow in place and cannot shrink. |
| — | `searchSku` | `basic` | AI Search tier: `basic`, `standard`, `standard2` or `standard3`. |
| `SEARCH_REPLICAS` | `searchReplicas` | `1` | AI Search's replicas, 1 to 12, as a floor: zone redundant, the service runs at least two. Three is the most the `basic` tier runs ([details](#search-replicas)). Each replica is billed as the first is. |
| `AZURE_SEARCH_LOCATION` | `searchLocation` | empty: `AZURE_LOCATION` | AI Search's region alone, for a region with the models' quota and no Search capacity. |
| `BACKEND_MIN_REPLICAS` | `backendMinReplicas` | `1` | The backend's floor. For a burst of simultaneous arrivals the floor is the capacity: the scaler reacts in about a minute. Zone redundant, the app runs at least two whatever this says, since one replica is in one zone; a floor above the ceiling raises the ceiling with it. |
| — | `backendMaxReplicas` | `3` | The backend's ceiling. Scales at 14 concurrent requests per replica. |
| `FRONTEND_MIN_REPLICAS` | `frontendMinReplicas` | `1` | The frontend's floor, raised to two when zone redundant as the backend's is. |
| — | `frontendMaxReplicas` | `3` | The frontend's ceiling. |
| `SERVICE_BACKEND_IMAGE_NAME` | `backendImage` | set by azd | The image deployed last, which azd keeps in the environment on the machine that deployed. Empty on the first provision, and on a provision from a machine whose environment holds no deployed image (a fresh pipeline runner). The app then keeps the image it runs; it takes a placeholder until `azd deploy` only when it does not exist yet. |
| `SERVICE_FRONTEND_IMAGE_NAME` | `frontendImage` | set by azd | The same, for the frontend. |
| `SERVICE_BACKEND_RESOURCE_EXISTS` | `backendExists` | `false`, set by azd | Whether the backend's container app exists, which azd answers at each provision. It is what lets a provision with no image name keep the running image; the migrate job carries the backend's. `SERVICES_RUNNING` answers the same question from the resource group, and either one saying the app exists is enough. |
| `SERVICE_FRONTEND_RESOURCE_EXISTS` | `frontendExists` | `false`, set by azd | The same, for the frontend. |
| `SERVICES_RUNNING` | `servicesRunning` | set by `preprovision` | The services whose container app the resource group already holds, comma-separated (`backend`, `frontend`), or `none`: `preprovision` asks Azure Resource Manager at every provision and stops when a group that exists will not answer. An app named here keeps the image it runs whatever azd answered, so a lookup of azd's that failed does not put the placeholder over it. |
| `KEY_VAULT_HOLDS` | `vaultHolds` | set by `preprovision` | The names of the secrets the vault already holds, comma-separated, or `none`, asked of Azure Resource Manager at every provision. A secret this provision has no value for is written as the placeholder `unset` only while the vault lacks it, so no provision replaces a working secret. A value the provision carries is always written. |
| `OPERATOR_PRINCIPAL_ID` | `operatorPrincipalId` | empty: whoever provisions | The operator's object id, when the operator is not the principal that provisions (a pipeline's identity, for example). The operator then gets every data-plane role and the provisioning principal gets none ([details](#operator-principal)). |
| `OPERATOR_PRINCIPAL_TYPE` | `operatorPrincipalType` | `User` | The operator's kind, `User`, `Group` or `ServicePrincipal`; read only with `OPERATOR_PRINCIPAL_ID`. A `Group` holds the roles and signs in to the jump VM, but gets no Redis data policy ([details](#operator-principal)). |
| `AUTH_SECRET` | `authSecret` | generated by `preprovision` | Signs session cookies and caller assertions. Written to Key Vault; both apps hold a reference. Generated once, when neither the azd environment nor the vault has one ([details](#the-session-secret)). A process that serves people refuses to start on one shorter than 32 characters. |
| `AUTH_MICROSOFT_ENTRA_ID_ID` | `entraClientId` | set by `preprovision` for Entra sign-in | The sign-in app registration's application (client) id. Empty, `preprovision` makes the registration and sets it ([deployment](deployment.md#sign-in-with-microsoft-entra-id)); set, the registration is left alone. |
| `AUTH_MICROSOFT_ENTRA_ID_SECRET` | `entraClientSecret` | set by `preprovision` with the id | Its client secret. Until both are set the vault holds placeholders, and under `entra` the frontend refuses to start on a placeholder, an empty value or a client id that is not a GUID, naming the variable and never its value. A provision whose environment carries neither leaves the vault's as they are (`KEY_VAULT_HOLDS`). |
| — | `entraIssuer` | `https://login.microsoftonline.com/<tenant>/v2.0` | The issuer the frontend trusts: the deploying tenant's. |
| — | `searchIndex` | `chunks` | The one AI Search index, the code's own default. |
| `MEMORY_STORE` | `memoryStore` | empty | Where what is remembered is kept: `foundry` or `own`; empty is `foundry`, `own` on a private deployment. A component: the starting value of the `agent` document's `memory.store` ([choose components at deploy time](deployment.md#choose-components-at-deploy-time)). |
| `HISTORY_STORE` | `historyStore` | empty | Where a new thread's messages are kept: `own` or `foundry`; empty is `own`. The starting value of `history.store`. |
| `RETRIEVAL_ENGINE` | `retrievalEngine` | empty | What answers a search, typed or spoken: `hybrid` or `knowledgeBase`; empty is `hybrid`. The starting value of the `knowledge` document's `retrieval.engine`. |
| `VOICE_ENGINE` | `voiceEngine` | empty | What answers a live session: `speechToSpeech` or `cascade`; empty is `speechToSpeech`. The starting value of `voice.engine`. |
| `RECORDS_API_URL` | `recordsApiUrl` | empty | The base URL of the business system the record tools and the stage's record routes read, given to the backend as `RECORDS_API_URL` ([the records system](#the-records-system)). Empty: the sample records, in memory. |
| `RECORDS_API_SCOPE` | `recordsApiScope` | empty | The `.default` scope of that system's app registration, which the backend's managed identity requests a token for on every call. Empty: no token is sent. |
| `KNOWLEDGE_BASE` | `knowledgeBase` | `false` | Make the knowledge base's planning deployment (`models.knowledgeBase`, [below](#the-knowledge-bases-planning-model)), which a search above `minimal` reasoning effort needs. The base itself is the migrate job's, made beside the index while the `knowledge` document's `retrieval.engine` is `knowledgeBase`, with or without it ([documents](documents.md#retrieval-through-a-knowledge-base)). |
| `SEED_SAMPLE_LIBRARY` | `seedSampleLibrary` | `true` | Load the sample library's documents on every deploy. `false` removes them on the next deploy ([documents](documents.md#the-sample-library)). |
| `AUTH_MODE` | `authMode` | `local` | `local`: a name and no password, every sign-in a new person. `entra`: Microsoft Entra ID. Hardened mode always runs `entra`. |
| `AUTH_REQUIRE_ROLE` | `authRequireRole` | `false` | Refuse a sign-in whose token carries neither app role `user` nor `premium`. Hardened mode always requires one. |

**`ENTRA_APP_SETUP`** is read by the hooks, not the parameter file: `true` by default, and `false` stops `preprovision` making the sign-in app registration and `postprovision` adding its redirect URI, for a tenant where somebody else owns registrations. Set `AUTH_MICROSOFT_ENTRA_ID_ID` and `AUTH_MICROSOFT_ENTRA_ID_SECRET` by hand then ([deployment](deployment.md#by-hand)).

### The `models` parameter

`models` has one deployment per role, each with a name, model, version, SKU and, for `chat`, `smallChat` and `embedding`, a capacity. The realtime roles and `knowledgeBase` take their capacity from the variables in the table, and `knowledgeBase` is made only with `KNOWLEDGE_BASE=true`. Every deployment carries the guardrail `default-indirect`, and so does every agent version. Versions are held by `infra/model-deprecations.json` and its test.

`realtime` is the Azure OpenAI realtime model the [speech-to-speech](patterns.md#terms) voice agent runs on, the default engine ([below](#the-realtime-deployment)). Taken out, there is no voice deployment and the voice agent reasons on `chat`, run by the service as a [cascade](patterns.md#terms) (transcribed, answered in text, spoken).

### Private networking

`PRIVATE_NETWORKING` puts private endpoints in front of Redis, Key Vault, App Configuration, AI Search, the Foundry account, Cosmos DB and Storage, and turns their public listeners off. Decide it before the first provision: the account holds one [capability host](patterns.md#terms), made with the Agent Service injection or without it. Switching later means taking the capability hosts down first ([deployment](deployment.md#changing-an-existing-environment)).

### Agent egress

With `AGENT_EGRESS` at `open` (or empty), the Agent Service subnet keeps its default outbound access, unfiltered. `restricted` closes it and gives the subnet a NAT gateway (a static public address) as its one way out. A network security group then admits only the private endpoints, the subnet itself, and Microsoft Entra ID, Microsoft Artifact Registry, its Front Door and Azure Monitor on 443. See [decisions](decisions.md#28-the-agent-subnets-egress-open-by-default-a-nat-gateway-and-a-service-tag-allow-list-by-opt-in) and [deployment](deployment.md#restricting-the-agent-subnets-egress).

### Private telemetry

With `PRIVATE_TELEMETRY` on, Application Insights and its Log Analytics workspace refuse public ingestion. They take telemetry through an Azure Monitor private link scope (ingestion private only, query open), with a private endpoint on `data` and Azure Monitor's four private DNS zones. Off, ingestion is public on every deployment. It is not the default: Agent on Azure assumes the private path can refuse the apps' own telemetry, which is observed behavior; verify it on your deployment ([decisions](decisions.md#29-telemetry-on-a-private-deployment-public-ingestion-by-default-azure-monitors-private-link-by-opt-in)). Turn it on only to test that.

### Agent tracing

The `insights` connection is the switch for the Agent Service's own traces of every agent in the project, which the portal's *Traces* view reads. Microsoft's [Set up tracing](https://learn.microsoft.com/en-us/azure/foundry/observability/how-to/trace-agent-setup) page says Foundry enables tracing once an Application Insights resource is connected to the project.

- **What a trace holds.** The turn's words: the same page names user inputs, model outputs, and tool arguments and results. They pass through none of the apps' scrubbing and stay in the workspace for its retention. Neither a conversation's delete nor an account's erase reaches them.
- **Off.** The template makes no such connection, and `postprovision` deletes one the project already has, because an incremental deployment never deletes a resource whose condition turned false. The service traces nothing after the provision.
- **The privacy notice.** The shipped notice's line about logs says the organization may switch Microsoft's tracing on, which then puts what a person asks and what the assistant answers into the logs, out of reach of a delete. An organization that turns it on says so in its own notice ([privacy](privacy.md#what-is-stored)).

### Search replicas

Zone redundant, AI Search runs at least two replicas, spreads them over availability zones and meets its SLA for queries. Three is what the SLA asks for queries and indexing together ([Reliability in Azure AI Search](https://learn.microsoft.com/en-us/azure/reliability/reliability-ai-search)). Three is also the most the `basic` tier runs: a larger number on that tier is refused as the template is read, before anything is made.

### Operator principal

With `OPERATOR_PRINCIPAL_ID` set, the operator gets every data-plane role. With the jump host (`DEVELOPER_ACCESS` on a private deployment) it also gets the Redis data policy and the jump VM's sign-in. The provisioning principal gets none of them.

A provision adds role assignments and removes none. If you name an operator on an environment someone else provisioned before, that principal's earlier roles stay in place; remove them by hand.

A `Group` operator gets no Redis data policy because Azure Managed Redis signs in a user, a service principal or a managed identity under its own object id. It does not admit a group's members through the group ([Use Microsoft Entra for cache authentication](https://learn.microsoft.com/en-us/azure/redis/entra-for-authentication)).

### The session secret

`preprovision` generates `AUTH_SECRET` only when neither the azd environment nor the vault has one. A machine whose environment carries none provisions without it, and the vault's value stays as it is (`KEY_VAULT_HOLDS`). If neither the provision nor the vault has one, the template refuses the provision and names the secret: the session secret has no placeholder.

### The realtime deployment

`models.realtime` is the deployment the speech-to-speech voice agent runs on, and `main.parameters.json` makes it: `gpt-realtime-2.1` beside the other three, at the capacity `REALTIME_CAPACITY` gives it (one unless set). Raise it with `azd env set REALTIME_CAPACITY <n>` and `azd provision` once the subscription's quota for the model in the region allows it; the portal's *Quotas* page, or `az cognitiveservices usage list -l <region>`, shows what is free.

`GlobalStandard` lets Azure process the audio in any region; `DataZoneStandard` keeps it in the data zone, which for an EU account is "European Union (data processed within any EU member nation)" ([Region availability for Foundry Models sold by Azure: Data Zone Standard](https://learn.microsoft.com/en-us/azure/foundry/foundry-models/concepts/models-sold-directly-by-azure-region-availability#data-zone-standard)). In Europe that page's Global Standard and Data Zone Standard tables both mark `gpt-realtime-2.1` `2026-07-07` under `francecentral` and `swedencentral` and under no other region, so the account must be in Sweden Central or France Central for either SKU; the template puts the account in `AZURE_LOCATION`. `preprovision` asks the region whether it offers the parameter file's model at its version and SKU (`az cognitiveservices model list`), and refuses one that does not before anything is made, naming the two ways through: another region, or no realtime deployment. A region `az` cannot be asked about is reported and left to the provision. Agent on Azure assumes no fixed number of sessions per unit of `capacity` on a realtime model; a load test shows it ([limitations](limitations.md)). The version is held by `infra/model-deprecations.json` like the other three. The backend is told the deployment's name and model (`AZURE_OPENAI_REALTIME_DEPLOYMENT`, `AZURE_OPENAI_REALTIME_MODEL`), both empty while it is absent.

**Without it.** Take `realtime` out of `models` for a region that does not offer the model, or a subscription without its quota: there is no realtime deployment, quota or cost, and every live session runs the cascade on `chat` unless the `agent` document names a managed realtime model (`voice.managedModel.speechToSpeech`). While the `agent` document names `speechToSpeech` with neither, the job's `agent` step and the backend's start report `agent.voice.speech_to_speech_unconfigured`; set `voice.engine` to `cascade` to make it the choice rather than the fallback ([agent](#agent)).

**A second realtime model.** `models.realtimeAlternate`, absent from the parameter file, is a second realtime deployment a voice tester may switch their own sessions to ([who tunes voice](#who-tunes-voice)). Add it beside `realtime` with the same fields and its capacity `REALTIME_ALTERNATE_CAPACITY`; `gpt-realtime-2.1-mini`, for example, needs its own entry in `infra/model-deprecations.json`. The template deploys it under the same guardrail and tells the backend its name and model (`AZURE_OPENAI_REALTIME_ALTERNATE_DEPLOYMENT`, `AZURE_OPENAI_REALTIME_ALTERNATE_MODEL`). The backend offers it only when both are set and both differ from the primary's: a tester chooses by model, so a second deployment of the same model is not offered. Absent, the tuning offers the one model there is. `preprovision` checks only `realtime`'s region.

**Cost.** The two engines are metered differently. Speech-to-speech bills the person's audio as realtime audio input tokens on this deployment, and its text answer as realtime output tokens; on the cascade the person is transcribed by the voice agent and answered in text tokens on `chat`. Realtime audio tokens are priced well above text tokens, so a minute of conversation costs more on speech-to-speech: compare the two on the [Azure OpenAI pricing page](https://azure.microsoft.com/pricing/details/cognitive-services/openai-service/) for your region. Voice Live meters the spoken answer the same way on both engines.

### The knowledge base's planning model

`models.knowledgeBase` is the deployment a knowledge base above `minimal` effort plans with: `gpt-5-mini`, one of the models AI Search lists for a knowledge base ([Create a knowledge base: Supported models](https://learn.microsoft.com/en-us/azure/search/agentic-retrieval-how-to-create-knowledge-base#supported-models)), at the capacity `KNOWLEDGE_BASE_CAPACITY` gives it. It is made only with `KNOWLEDGE_BASE=true`, as a deployment of its own so the base's planning never draws on `smallChat`'s quota, under the same guardrail and held by `infra/model-deprecations.json` like the rest. Another listed model is a change of `model` and `version` here; one the service does not list is refused when the job writes the base.

The search service calls it, rather than the backend: the base names the account's `openai.azure.com` host, the deployment and the model, with no key, and the service reaches it as its own system identity, which holds Cognitive Services User on the account for its vectorizer already. On a private deployment that call takes the same route as the vectorizer's: the account admits AI Search as a trusted Azure service (`networkAcls.bypass: AzureServices`), which authenticates with the service's managed identity ([Configure Azure AI services virtual networks: Grant access to trusted Azure services](https://learn.microsoft.com/en-us/azure/ai-services/cognitive-services-virtual-networks#grant-access-to-trusted-azure-services-for-azure-openai)). Learn documents a shared private link from AI Search to the account as the other route for a knowledge base's model. The template does not make one: on the Basic tier the service cannot hold a private connection to a Foundry resource ([service limits: Shared private link resource limits](https://learn.microsoft.com/en-us/azure/search/search-limits-quotas-capacity#shared-private-link-resource-limits)).

**Cost.** Above `minimal`, every search is a planning call on this deployment, billed as Azure OpenAI input and output tokens, and AI Search bills its agentic retrieval tokens at a rate that rises with the effort ([Agentic retrieval: Billing](https://learn.microsoft.com/en-us/azure/search/agentic-retrieval-overview#billing)). `medium` may search twice. The effort is a setting per channel, `retrieval.reasoningEffort` and `retrieval.voiceReasoningEffort` ([knowledge](#knowledge)); the deployment costs nothing while no search plans.

Nothing else reaches the template: who is premium, who may read which document and every run-time limit are decided elsewhere.

### The records system

`RECORDS_API_URL` and `RECORDS_API_SCOPE` point the backend at a business system instead of the sample records ([worked example](worked-example.md#point-a-deployment-at-your-system)). The backend's managed identity requests a token for the scope from Microsoft Entra ID and needs no role on this side: the system's own app registration decides whether to accept it, usually through an app role assigned to the identity `AZURE_CLIENT_ID` names.

The backend calls the system from the Container Apps environment, whose outbound traffic is open in both modes. `AGENT_EGRESS` filters only the Agent Service's `agent` subnet; the `apps` subnet carries no security group, route table or NAT gateway (`infra/modules/network.bicep`). So:

- **A system on the internet** is reached with no change here. Its callers' addresses are the platform's outbound addresses, which the template does not fix, so let the system admit the backend by its token rather than by address.
- **A system on a private network** is reached only with private networking, through the virtual network (`10.0.0.0/16`) and whatever is peered or connected to it, with its name resolvable there. A demo deployment's environment joins no network.
- **A container app in the same environment** is reached in either mode at its own name (`http://<app name>`), or at `<app name>.internal.<environment domain>` with internal ingress.

## Environment variables

Each app's environment is exactly what its `.env.example` lists ([backend](../apps/backend/.env.example), [frontend](../apps/frontend/.env.example)), plus one variable the template adds; `infra/app-env.test.ts` checks that the template, the examples and every variable the apps' sources read (the frontend's own server included) agree. A count or a duration the apps read through `@platform/config` is read as decimal digits: anything else, `0x10` and `1e3` included, falls back to the default with a warning. **Template** below is what a deployment sets; empty means the code's default, given beside it. **Key Vault** marks a secret reference: the container reads it from the vault through its own identity, and no value is in the template.

### Backend

| Variable | Template | What it is |
| --- | --- | --- |
| `AZURE_CLIENT_ID` | the backend identity's client id | Picks the user-assigned identity `DefaultAzureCredential` signs in as. Template only. |
| `PORT` | `4111` | The port the server binds. |
| `IMAGE_TAG` | the image's tag | Reported as the service version in telemetry. |
| `APP_CONFIG_ENDPOINT` | the App Configuration endpoint | Unset on a checkout: every settings document is its compiled-in default. |
| `APP_CONFIG_KEY_PREFIX` | empty: `app/` | The key prefix of every settings document. |
| `APP_CONFIG_TIMEOUT_MS` | empty: `2000` | One read of the store. |
| `CONFIG_TTL_MS` | empty: `30000` | The settings refresh interval: how long a settings document is served from memory before it is read again. |
| `AUTH_SECRET` | Key Vault `auth-secret` | Verifies the caller assertions the frontend mints. Unset on a checkout (not deployed, `NODE_ENV` not `production`), the backend verifies no caller and serves every request as one local account. |
| `AUTH_MODE` | `local` or `entra` | Must match the frontend's. |
| `AUTH_REQUIRE_ROLE` | `1` or empty | `1` refuses a sign-in whose token carries neither `user` nor `premium`. A toggle, as every on-or-off variable here is: unset or blank is its default, `0`, `false`, `no` and `off` are off, and any other value is on. |
| `HARDENED` | `true` or `false` | On a hardened deployment, `AUTH_MODE=local` or no `AUTH_REQUIRE_ROLE` refuses to start, and the [`access`](#access) document's `enforceAccessControl` defaults to `true`. |
| `PRIVATE_NETWORKING` | `true` or `false` | Whether the data services sit behind private endpoints with their public listeners off (the `privateNetworking` switch, as `HARDENED` resolves it). The `agent` document's `memory.store` then defaults to `own`, and `foundry` is refused: the Foundry memory store cannot reach the account's model from outside the network ([memory on a private deployment](#memory-on-a-private-deployment)). |
| `MEMORY_STORE` | `MEMORY_STORE`, or empty | The component the deploy chose for `memory.store`: the field's value in the `agent` document the job seeds, and its default while that document is unreadable. Empty is the default. [Choose components at deploy time](deployment.md#choose-components-at-deploy-time). |
| `HISTORY_STORE` | `HISTORY_STORE`, or empty | The same for `history.store`. |
| `RETRIEVAL_ENGINE` | `RETRIEVAL_ENGINE`, or empty | The same for the `knowledge` document's `retrieval.engine`. |
| `VOICE_ENGINE` | `VOICE_ENGINE`, or empty | The same for `voice.engine`. |
| `COSMOS_ENDPOINT` | the Cosmos DB account's endpoint | Where the accounts, the persona's versions and the thread index live, reached as the backend's identity (Cosmos DB Built-in Data Contributor on the database). Unset, nothing that reads an account can run. |
| `COSMOS_DATABASE` | `app` | The database on that account. |
| `REDIS_URL` | `rediss://<objectId>@<host>:10000` | The Entra form: dials as the identity's object id with a token as the password. Unset runs without the cache and coordination shared across replicas; set and unreachable refuses the start. |
| `REDIS_COMMAND_TIMEOUT_MS` | empty: `1000` | Deadline on every command. |
| `REDIS_CONNECT_TIMEOUT_MS` | empty: `5000` | Deadline on a dial. |
| `REDIS_RETRY_COOLDOWN_MS` | empty: `10000` | Wait before redialing after a failure; `0` redials at once. |
| `FOUNDRY_PROJECT_ENDPOINT` | the Foundry project's endpoint | `https://<account>.services.ai.azure.com/api/projects/agent`: the agent's versions, its conversations and responses, the memory store and the skills, reached as the backend's identity (Foundry User on the project). Unset, no turn can run. |
| `FOUNDRY_RAI_POLICY` | the `default-indirect` guardrail's resource id | The guardrail every agent version names in its `rai_config`, by resource id: the service refuses a bare name. Unset, a version names none and the deployment's own applies. |
| `FOUNDRY_MEMORY_STORE` | empty: `person-memory` | The memory store (preview) the job makes and every turn reads and writes while the `agent` document's `memory.store` is `foundry`; nothing reads it while it is `own`. |
| `FOUNDRY_REQUEST_DEADLINE_MS` | empty: `30000` | One request to the project: its whole answer, or a streamed response's headers. A stream that has begun is held to 300 seconds of silence between its events, a constant. |
| `AZURE_OPENAI_RESOURCE_NAME` | the Azure OpenAI account | Every model call goes to this account with an Entra token. |
| `AZURE_OPENAI_CHAT_DEPLOYMENT` | `chat` | The agent's model, which every agent version names. |
| `AZURE_OPENAI_SMALL_CHAT_DEPLOYMENT` | `small` | Titles, the search planner, and the memory's extraction on either store. |
| `AZURE_OPENAI_EMBEDDING_DEPLOYMENT` | `embedding` | The deployment AI Search's skillset embeds every chunk with and its vectorizer every query, and the Foundry memory store's embeddings. |
| `AZURE_OPENAI_EMBEDDING_DIMENSIONS` | empty: `3072` | The vector width the search index is built at. Changing it means rebuilding the index. |
| `AZURE_OPENAI_EMBEDDING_MODEL` | `text-embedding-3-large` | The model behind the embedding deployment, which the skillset and the vectorizer name beside it. |
| `AZURE_OPENAI_REALTIME_DEPLOYMENT` | `models.realtime`'s name; empty when it is taken out | The realtime deployment a speech-to-speech voice agent's version names. Empty, every session runs the cascade unless the `agent` document names a managed model (`voice.managedModel.speechToSpeech`), and while it names `speechToSpeech` with neither the job's `agent` step and the backend's start report `agent.voice.speech_to_speech_unconfigured`. |
| `AZURE_OPENAI_REALTIME_MODEL` | `models.realtime`'s model; empty when it is taken out | The model behind it: a session's update carries a reasoning effort only for a reasoning realtime model ([`voice.realtimeReasoningEffort`](#agent) lists them). |
| `AZURE_OPENAI_REALTIME_ALTERNATE_DEPLOYMENT` | `models.realtimeAlternate`'s name; empty while it is absent | A second realtime deployment a voice tester may switch their own sessions to. Offered only beside `AZURE_OPENAI_REALTIME_DEPLOYMENT`, with its model named, and only when deployment and model both differ from the primary's. |
| `AZURE_OPENAI_REALTIME_ALTERNATE_MODEL` | `models.realtimeAlternate`'s model; empty while it is absent | The model behind it, which is how a tester chooses it and whether a session is given a reasoning effort. |
| `AZURE_OPENAI_KNOWLEDGE_BASE_DEPLOYMENT` | `models.knowledgeBase`'s name with `KNOWLEDGE_BASE=true`; empty otherwise | The knowledge base's planning deployment, which the job writes into the one base it makes. Empty, the base carries no model, and `retrieval.reasoningEffort` above `minimal` runs at `minimal` with `knowledge_base.planner_unconfigured` on stderr. |
| `AZURE_OPENAI_KNOWLEDGE_BASE_MODEL` | `models.knowledgeBase`'s model with `KNOWLEDGE_BASE=true`; empty otherwise | The model behind it, which a knowledge base names beside the deployment. |
| `AZURE_SEARCH_ENDPOINT` | the AI Search endpoint | Unset: no knowledge search. |
| `AZURE_SEARCH_INDEX` | `chunks` | The one index. |
| `KNOWLEDGE_PLANNER_DEADLINE_MS` | empty: `8000` | One query plan, model call included. |
| `KNOWLEDGE_PLANNER_INFLIGHT` | empty: `6` | Plans in flight on a replica; over it the plain search runs. |
| `AZURE_STORAGE_ACCOUNT` | the storage account | Blob storage, keyless. |
| `AZURE_STORAGE_ENDPOINT` | empty | Overrides the blob origin, for an emulator. |
| `AZURE_STORAGE_CONTAINER` | `library` | The library container: every library under its name, each file's description in its metadata. |
| `AZURE_STORAGE_APPEARANCE_CONTAINER` | `appearance` | The container the deployment's logo is read from ([`appearance`](#appearance)'s `brand.logo`), apart from the library so the indexer never reads it. Unset is `appearance`. |
| `AZURE_STORAGE_RESOURCE_ID` | empty | Migrate job only. |
| `RECORDS_API_URL` | `RECORDS_API_URL`, or empty | The business system the record tools and the record routes of the [stage](patterns.md#terms) read ([worked example](worked-example.md)). Empty: the sample records, in memory. |
| `RECORDS_API_SCOPE` | `RECORDS_API_SCOPE`, or empty | The `.default` scope of that system's app registration, which the backend's managed identity requests a token for on every call. Empty: no token is sent, as for a stand-in running locally. |
| `MEMORY_CACHE_TTL_SECONDS` | empty: `60` | How long what is remembered about a person is cached across replicas. A correction drops it at once. |
| `PERSON_CACHE_TTL_SECONDS` | empty: `60` | How long a person's account fields are cached. |
| `LAST_CONVERSATION_CACHE_TTL_SECONDS` | empty: `300` | How long "when you last talked" is cached. |
| `THREAD_OWNER_CACHE_TTL_SECONDS` | empty: `3600` | How long a conversation's owner is cached. |
| `TURN_CLAIM_TTL_SECONDS` | empty: `120` | How long a turn's claim against a duplicate outlives its last renewal: the replica answering renews it while the turn runs, so it is what a replica that died leaves held, not a cap on a turn. |
| `TURN_CLAIM_DEADLINE_MS` | empty: `300` | Wait on the claim before answering uncoordinated. |
| `WARMUP_TTL_MS` | empty: `60000` | How long one warm-up of the first turn's cold costs counts as fresh; `0` warms on every ask. |
| `TITLE_MAX_INFLIGHT` | empty: `4` | Conversation titles written at once on a replica. |
| `TITLE_DEADLINE_MS` | empty: `25000` | One title. |
| `METERING_SWEEP_INTERVAL_MS` | empty: `5000` | How often the backend checks for live voice sessions past their time limit and hangs them up. A value under `250` is refused with a warning and the default stands. |
| `METERING_UNAVAILABLE_LOG_SECONDS` | empty: `60` | One "bucket unavailable" line per this many seconds; `0` logs every one. |
| `SSE_HEARTBEAT_MS` | `15000` | Keep-alive comment frames on streamed answers; `0` switches them off. |
| `APPLICATIONINSIGHTS_CONNECTION_STRING` | the Application Insights resource | Unset: no telemetry at all. |
| `PROBLEM_LOG` | empty: on | `0` switches the `problem` line off. |
| `LLM_USAGE_LOG` | empty: on | `0` switches the `llm_usage` line off. |

### Migrate job

The migrate job runs the backend's image with the backend's environment, except for these:

| Variable | Job's value | Why |
| --- | --- | --- |
| `AZURE_CLIENT_ID` | the migrate identity's client id | Its own identity, which writes what the backend only reads: the settings documents, the search pipeline, the library's blobs. |
| `AZURE_STORAGE_RESOURCE_ID` | the storage account's resource id | AI Search's data source names the account by it, and reads it with the service's own identity. |
| `REDIS_URL` | empty | No cache: the backend's URL dials as the backend's object id, which the job's identity is not. |

### Frontend

| Variable | Template | What it is |
| --- | --- | --- |
| `IMAGE_TAG` | the image's tag | Reported as the service version. |
| `AUTH_URL` | the public origin | Auth.js's own: the origin written into the sign-in redirect, which behind Front Door is not the host the replica sees, and the origin a write must come from. Template only. Without it a write's origin is held to the host the proxy forwards (`X-Forwarded-Host`) under the scheme it forwards (`X-Forwarded-Proto`), or `https` when it names a host and no scheme. |
| `BACKEND_URL` | the backend's internal URL | Server-side only; the browser never calls the backend. |
| `AUTH_SECRET` | Key Vault `auth-secret` | Signs the session cookie and the caller assertions; must equal the backend's. |
| `AUTH_MODE` | `local` or `entra` | Which provider the sign-in page registers. |
| `AUTH_MICROSOFT_ENTRA_ID_ID` | Key Vault `entra-client-id` | The app registration's client id. |
| `AUTH_MICROSOFT_ENTRA_ID_SECRET` | Key Vault `entra-client-secret` | Its client secret. |
| `AUTH_MICROSOFT_ENTRA_ID_ISSUER` | Key Vault `entra-issuer` | `https://login.microsoftonline.com/<tenant-id>/v2.0`. |
| `AUTH_REQUIRE_ROLE` | `1` or empty | As the backend's. |
| `HARDENED` | `true` or `false` | As the backend's. |
| `SSE_HEARTBEAT_MS` | `15000` | Keep-alive frames on relayed streams; `0` switches them off. |
| `APPLICATIONINSIGHTS_CONNECTION_STRING` | the Application Insights resource | Unset: no telemetry. |

The frontend holds no fact the backend owns: the agent's id, the stage's tools and every byte bound come from the backend's `GET /identity/me` and `GET /voice/capability`.

### Set by the images

Each Dockerfile sets `NODE_ENV=production` (which arms the deployment guard) and `PORT`. The frontend's also sets `HOSTNAME=0.0.0.0`, the address its server binds, and switches off its framework's anonymous telemetry, `COPILOTKIT_TELEMETRY_DISABLED=1`: set it yourself when you run the frontend outside its image. Both images run as a non-root user.

### Read outside a deployment

Never set by the template; each is read by a tool, a test or a launcher.

| Variable | Read by | What it does |
| --- | --- | --- |
| `AGENT_KEY_PREFIX` | the agent's Redis keys; set by tests | Replaces the namespace every Redis key of the agent is written under, so a suite has a throwaway prefix it can clear. The running backend reads it too and nothing refuses it there: leave it unset on a deployment. |
| `KEEP_ALIVE_TIMEOUT` | the frontend's server | Milliseconds an idle HTTP connection is kept, read by the server itself as the digits the value starts with (`1e3` is 1), with no warning. Unset or not a number, Node's own default stands; raise it above the idle timeout of a proxy that reuses connections to the replica. |
| `E2E_BACKEND_PORT`, `E2E_FRONTEND_PORT`, `CI` | the end-to-end configuration (`apps/frontend/e2e/playwright.config.ts`) | The two ports the suite starts its servers on, and CI's own marker, under which a focused test is refused and the worker count is fixed. |
| `NEXT_PUBLIC_VOICE_PREVIEW` | the frontend build | `1` compiles in a hook that draws the voice panel in any phase without a microphone. Never in a deployed build. |
| `COSMOS_TESTS` | tests | `1` runs the Cosmos DB suites on the emulator named by `COSMOS_ENDPOINT` and `COSMOS_KEY`, rather than in memory. |
| `COSMOS_KEY` | the Cosmos DB client, `dev-fake.ts` | The emulator's key: with it, the client signs requests with the key instead of the identity. A deployed replica, or the job, refuses to start with it set. |
| `BICEP_CLI` | the template's tests | Path to the Bicep CLI the template tests compile with. |
| `VERIFY_SESSION_COOKIE` | the deployment check (`scripts/verify-deployment.ts`) | A test user's session cookie as the browser holds it (`name=value`): under `entra`, where a script cannot sign in, it runs the signed-in checks as that user, whose account the run never erases. Without it an `entra` run refuses to start unless `--signed-out-only` is given. The report names the cookie, never its value. |

The platform also sets `CONTAINER_APP_NAME` and `HOSTNAME` on every replica; the deployment guard reads the first, the turn claim the second (in the frontend's container the image's own `HOSTNAME` is the one its server reads).

## Settings documents

Everything an operator tunes is a JSON document in App Configuration under `app/<name>` (no label, content type `application/json`). The migrate job's `settings` step writes each one with the code's defaults where the key is absent or holds `{}`, and never overwrites one that exists, so edits survive every deploy.

How a replica reads them:

- **Live.** Each backend replica reads a document again once its cached copy is older than `CONFIG_TTL_MS` (30 s); `limits` is also shared through Redis. An edit reaches every backend replica within about 30 seconds, without a restart.
- **A failed read.** When a read of the store fails while a last value is held, the store is not asked again for 5 seconds, and that value serves meanwhile. With no value held yet, the default serves and the store is asked again a fifth of a second later. A failed read warns once, however many requests waited on it.
- **The frontend.** It is given no App Configuration store. The one document it reads itself, [`telemetry`](#telemetry), stays at its compiled-in default there. Every other value it needs is the backend's answer. [`appearance`](#appearance) comes from the backend's public `GET /appearance` and the frontend caches it for another `CONFIG_TTL_MS`, so an appearance edit is live within about a minute.
- **Merged over the default.** The stored document is merged over the compiled-in default leaf by leaf. A missing field takes the default; a key the default does not have is ignored.
- **Refused fields fall back.** A field of the wrong type, out of its range, or (unless the rule says otherwise) not a finite positive number keeps its default. The `limits`, `edge` and `appearance` documents log what they ignored; the others fall back without a line, so read a document back against its table after an edit. No edit can remove a bound, produce "unlimited", or switch a limit to zero.
- **An unreadable store** serves the last good value, or the default before the first read.

To edit: Azure portal → the App Configuration store → *Configuration explorer* → `app/<name>` → *Edit*, or `az appconfig kv set --endpoint <APP_CONFIG_ENDPOINT> --auth-mode login --key app/limits --content-type application/json --value '<json>'`. The operator holds App Configuration Data Owner. In hardened mode the store's public listener is off: edit from inside the network, or open the listener for the edit and close it again.

Rules used below: **positive** is a finite number above zero; **whole** a positive integer; **≥ 0** an integer from zero.

### `limits`

The cost bounds on each metered feature, per account. `perDay` is a rolling daily allowance that refills continuously (a 1440th a minute, nothing resets at midnight); `burst` and `refillPerMinute` are a per-minute bucket. An account with the `premium` app role is not metered by this document at all, except where noted. An allowance or a burst below 1 admits one request each time its bucket is full.

| Field | Default | Rule | Effect |
| --- | --- | --- | --- |
| `chat.perDay` | `200` | positive | Typed turns an account may start in a rolling day. Words typed into an open live session belong to the session and draw nothing here: its seconds (`realtime.*`) bound how long it is open, and the session bounds what it takes while open: six messages at once and one every two seconds after, 64 KiB of them in all (`platform/voice/src/broker/input-budget.ts`). |
| `tts.perDay` | `400` | positive | Unused: no route synthesizes speech, so it has no effect. |
| `tts.burst` | `30` | positive | Unused, as `tts.perDay`. |
| `tts.refillPerMinute` | `60` | positive | Unused, as `tts.perDay`. |
| `stt.perDay` | `400` | positive | Unused: no route transcribes an upload, so it has no effect. |
| `stt.burst` | `12` | positive | Unused, as `stt.perDay`. |
| `stt.refillPerMinute` | `30` | positive | Unused, as `stt.perDay`. |
| `toolSearch.burst` | `6` | positive | Web searches in a burst, on both channels. A typed turn's search is charged after its turn, and a turn starts without web search while the bucket is empty. A live session's search (the backend's `webSearch` function) answers `rate_limited` while the bucket is empty, and searches again once it refills. |
| `toolSearch.refillPerMinute` | `12` | positive | The burst's refill. |
| `media.perDay` | `2000` | positive | Pictures the media route serves an account a day, and the library searches it runs from the stage; each search draws one, since it plans, embeds and queries. Listing the library draws nothing ([details](#media-allowance)). |
| `transcript.perDay` | `3000` | positive | Unused, so it has no effect: a live session's words reach its conversation when the session ends, bounded by its seconds and by what a session takes from its browser (`platform/voice/src/broker/input-budget.ts`), never through a route of their own. |
| `transcript.burst` | `30` | positive | Unused, as `transcript.perDay`. |
| `transcript.refillPerMinute` | `60` | positive | Unused, as `transcript.perDay`. |
| `realtime.burst` | `30` | positive | Credits for starting live voice sessions. |
| `realtime.refillPerMinute` | `30` | positive | Their refill. |
| `realtime.mintCost` | `10` | positive | Credits one live session start costs. |
| `realtime.maxSessionSeconds` | `1800` | whole | The absolute ceiling on one live session for a base account. |
| `realtime.idleSeconds` | `120` | whole | Silence before a live session is reclaimed, and the seconds each renewal buys, held to the tier's `maxSessionSeconds` when that is smaller. Applies to premium too. |
| `realtime.secondsPerDay` | `1800` | whole | Live seconds a base account may talk in a rolling day. A session is charged one `realtime.idleSeconds` window upfront, so a value below it admits no live session; the replica logs it. |
| `realtime.concurrentSessions` | `10` | whole | Live sessions open at once across the deployment; set it to the voice agent's own concurrent-session limit for the project. Applies to premium too. |
| `premium.maxSessionSeconds` | `3600` | whole | The ceiling on one live session for a premium account. |
| `global.realtimeSecondsPerDay` | `72000` | whole | Live seconds the whole deployment may use in a rolling day. Premium sessions draw on it too. Below `realtime.idleSeconds` it admits no live session, as `realtime.secondsPerDay`. |

The agent's own per-account turn bucket (`agent.turns`) applies to every account, premium included.

#### Media allowance

A picture the browser already holds draws nothing from `media.perDay`. The browser asks whether its copy still stands, and the route answers `304` without touching the allowance, so a picture already held still shows once the allowance is spent. Those questions have a bound of their own, fixed in the route (`apps/backend/src/routes/media.ts`): ten a second for an account. Past that, a question is treated as a request for the picture and draws on the allowance.

### `llm`

Every bound on the model calls. The deployments are environment variables; a stored `deployments` section is ignored.

| Field | Default | Rule | Effect |
| --- | --- | --- | --- |
| `retry.maxRetries` | `3` | an integer from 0 to 10 | Retries of a model error the provider SDK marks retryable, such as throttling. If the provider asks for a wait longer than `retry.maxHonouredDelayMs`, the call ends instead of retrying sooner. The Foundry project's own calls (threads, memory, agent versions) take the same schedule for a `429` that names no wait, which the SDK would not retry. |
| `retry.initialDelayMs` | `2000` | whole | First retry delay, jittered. |
| `retry.backoffFactor` | `2` | a number ≥ 1 | Multiplier between retries. |
| `retry.maxHonouredDelayMs` | `60000` | whole | Longest `Retry-After` the provider can ask for and get; a longer one ends the call. |
| `concurrency.chat` | `16` | whole | Agent responses streaming at once per replica. |
| `concurrency.smallChat` | `8` | whole | Small-model calls (titles, search plans) in flight per replica. |
| `embeddings.dimensions` | `3072` | ignored when stored | Shown for completeness: the width is `AZURE_OPENAI_EMBEDDING_DIMENSIONS`, because it must equal the index's vector field. The job seeds the compiled-in `3072` whatever the variable says, so on a deployment that overrides the variable the stored number is not the one in force. |

### `voice`

The live voice: the session the backend relays with the Foundry voice agent. The voice agent's own model and transcriber are `agent`'s `voice.*`, in its version; the metering bounds are in `limits`. A stored key this table does not list is ignored.

| Field | Default | Rule | Effect |
| --- | --- | --- | --- |
| `live.voices.base` | `"en-US-AvaMultilingualNeural"` | text, not blank, not an OpenAI voice | The live voice for the base tier: one multilingual Azure voice, which speaks every language, so no locale is part of it. Set per session, and the voice agent's version starts from it. |
| `live.voices.premium` | `"en-US-Ava:DragonHDLatestNeural"` | text, not blank, not an OpenAI voice | The live voice for premium: one HD multilingual voice, set per session. |
| `live.openaiVoices.base` | `""` | empty, or one of `alloy`, `ash`, `ballad`, `coral`, `echo`, `sage`, `shimmer`, `verse`, `marin`, `cedar` | The realtime model's own voice for the base tier, as the [Voice Live API reference](https://learn.microsoft.com/en-us/azure/ai-services/speech-service/voice-live-api-reference-2026-07-15) lists them (`RealtimeOpenAIVoice`), used only on speech-to-speech ([details](#openai-voices)). Empty: the Azure voice. |
| `live.openaiVoices.premium` | `""` | as `live.openaiVoices.base` | The same for premium. |
| `live.language` | `"stated"` | `stated` or `detected` | How a live session takes the person's language: `stated` gives the service the language they chose, `detected` leaves it to the service over the product's languages ([details](#session-language)). |
| `live.stageCallTimeoutMs` | `8000` | positive | How long the person's browser has to answer a stage control that a live session called; then the session is told `not_answered`. |
| `live.drainGraceMs` | `10000` | positive | How long a replica that is shutting down gives its live sessions, after telling them to reopen, before it closes them and writes their transcripts. Keep it at 15 s or less with `live.settleWaitMs` ([details](#draining-a-replica)). |
| `live.settleWaitMs` | `5000` | positive | How long a session's end waits for the person's last transcripts before the thread is written. |
| `live.connectTimeoutMs` | `15000` | positive | How long the voice agent has to open its socket and announce a session. |
| `live.updateTimeoutMs` | `5000` | positive | How long the service has to echo the person's update, or refuse it. Past it, the session opens anyway, the log says the update went unanswered, and the thread so far is given without waiting for acknowledgements. The echo usually comes within a second. An update the service refuses outright (`voice.live.session_refused`, [operations](operations.md)) refuses the open. |
| `live.responseRetry.attempts` | `2` | whole, 1 to 5 | How many times a response that failed with nothing said is asked for again. After that, the voice is told, once, to say it could not get the answer, and the voice panel says so in the person's language ([details](#response-retries)). |
| `live.responseRetry.backoffMs` | `1000` | from 1 to 10000 | The wait before the first ask, doubled for each one after. An ask is withdrawn when the person speaks, another response opens, or the session ends. |
| `live.responseRetry.jitterMs` | `500` | 0 to 5000 | Up to this much is added at random to each wait, so sessions refused together do not ask again together. |

#### OpenAI voices

An OpenAI voice (`live.openaiVoices.base` or `.premium`) is spoken in place of the tier's Azure voice only while the tier runs speech-to-speech. The cascade refuses an OpenAI voice, so on the cascade the Azure voice stands. With an OpenAI voice, the session speaks with no fillers, which the service refuses beside it, on a voice version of its own that the job's `agent` step makes. No accent is stated, and the language directive alone decides the language it speaks.

#### Session language

`stated` gives the language the person chose as the transcription's language and the voice's accent. `detected` leaves both to the service over the product's languages, and is the fallback if the service ignores a session's update.

The accent takes effect. The transcription's language does not: on both engines the service's echo carries none (`azure-speech`, `mai-transcribe`), and the person is transcribed in the language they speak either way. In both modes, the answer is spoken in the language the language directive names, which is the language the person chose.

#### Draining a replica

The backend gives its drain 20 s of its `terminationGracePeriodSeconds` (30 s, `infra/modules/backend.bicep`). Together with `live.settleWaitMs`, keep `live.drainGraceMs` at 15 s or less. A session whose transcripts are still being written when the drain ends is closed and finished by another replica's periodic cleanup.

#### Response retries

Only a rate limit, a fault of the service's, or a failure with no details is asked again. A refused request, a content filter or a response cut short are logged and nothing more. Each ask is a step of the turn's `agent` `foundry.maxSteps`. Every failure is logged as `voice.live.response_failed` with its type and code.

### `agent`

The reasoning settings are part of the agent version a turn runs on: a change makes a new version on the next turn, and the job's `agent` step prunes the old ones. Every number in this document whose rule is **whole** is at most 1000000, so no stored value removes one of those bounds. The rows that are tighter say so, and `memory.foundry.ttlSeconds`, whose rule is ≥ 0, has no ceiling.

`memory.store` names where what is remembered about a person is kept. It is a component: `MEMORY_STORE` chooses it at deploy time ([choose components at deploy time](deployment.md#choose-components-at-deploy-time)). Unset, its default depends on the deployment: `foundry` on a public deployment, `own` when `PRIVATE_NETWORKING` is set. The job's `settings` step seeds whichever applies into an absent document.

It is the one field of the document a running replica does not follow. The backend reads it at its first use of memory and runs that store until it stops, because the two stores keep their facts in different places: a replica that switched halfway would read from one and write to the other. Change it, then restart the backend (a new revision, or `az containerapp revision restart`); the migrate job reads it afresh on every deploy.

The `memory.foundry.*` fields are the Foundry store's own options, set when the job's `agent` step first makes the store. A change to them reaches a deployment whose store already exists only by deleting the store (and everything it remembers). The own store reads none of them. `updateDelaySeconds`, `maxChars` and `itemMaxChars` apply to both.

- **`foundry`** (the default): the Agent Service's memory store (preview). The backend hands it each answered turn's words, never a turn the content filter blocked, nor a spoken line whose answer the filter stopped. Microsoft's service extracts the statements after `updateDelaySeconds` and keeps them under one scope per account, in the project.
  - *Limits.* Preview. [What is memory?](https://learn.microsoft.com/en-us/azure/foundry/agents/concepts/what-is-memory) sets 100 scopes per memory store, with the recommended one scope per user, so one store serves at most 100 accounts. It also sets 10,000 memories per scope and 1,000 requests a minute.
  - **Not behind private endpoints.** The store's extraction runs on Microsoft's side of the network and calls the account's chat and embedding deployments over the account's public endpoint. With `PRIVATE_NETWORKING`, the account answers `403 Public access is disabled` to every one of those calls, the update stays `in_progress` forever, and nothing is ever remembered. [What is memory?](https://learn.microsoft.com/en-us/azure/foundry/agents/concepts/what-is-memory) lists it under *Limitations*: "Virtual network (VNet) integration isn't supported for memory stores." So the Foundry store runs only on a public (demo mode) deployment, and a private one is held to `own` at three points ([memory on a private deployment](#memory-on-a-private-deployment)).
  - **Stalled and pending updates.** On any deployment, an update the service has not completed within `updateDelaySeconds` plus fifteen minutes is reported once as `agent.memory.extraction_stalled`. `update_delay` is a debounce: a new update cancels the pending one and restarts the wait. Agent on Azure assumes the service can extract such an update afterward and write into the emptied scope. So the backend keeps every update's id until it must have finished, and deletes the scope again once each has (`agent.memory.erase_overdue` if one has not within an hour).
- **`own`**: the `memory` container in this deployment's own Cosmos DB, one fact a document in the account's partition. After `updateDelaySeconds`, the thread's latest messages are read back with what is kept and sent once to the `small` deployment, which answers the whole list to keep. Each statement is labeled with who said it and whether it is a fact about the person, a lasting preference, or an instruction for the conversation at hand. Only a fact or a preference the person stated is written, never an instruction such as "reply with OK only": an instruction kept as a fact would script every later turn. A turn the content filter blocked is left out of what is read: the conversation still shows it, and its messages are named on the thread's index entry (`blocked`) so that no extraction reads them. A live session's spoken lines are named there too when the filter stopped the answer they led to: every line the person said since the voice last spoke. When the filter refuses the extraction call itself, the thread is read once more without the person's newest message and what followed it; refused again, what is kept stays as it was and `agent.memory.extraction_refused` is reported.
  - *Limits.* No scope cap: it scales with the database. Lives where the conversations do, behind the same private endpoint in hardened mode. A forget is final: it moves a cutoff point kept in the person's own partition, an extraction reads nothing said before it, and writes only while the cutoff it began under is unchanged. One small-model call per finished thread.

`history.store` names where a new thread's messages are kept. Each thread records the store it was made in, and every read, turn, live session, delete and erasure of it goes there, so the setting decides only where the next new thread is made: a change needs no restart, strands no thread, and two replicas that read it a moment apart make threads in two places without either losing one. On either store a live session's spoken turns are written into the thread as text, once, when the session ends: never during it, and never as audio ([architecture](architecture.md#voice)).

- **`own`** (the default, on every deployment): the `messages` container in this deployment's Cosmos DB, one document per message, call or output in the account's partition. Every response runs with `store: false`, and a turn is given the thread's history within `history.maxItems` and `history.maxChars`. A delete or an erasure removes every document. A picture is input to its own turn only and is written nowhere.
- **`foundry`**: the Agent Service's conversations, one per thread, each response stored in it (`store: true`) and the context truncated by the service (`truncation: "auto"`). The service keeps no time on an item, so the thread document keeps each shown message's time, and the ids of the responses written, for a delete to reach. A picture enters the conversation with its turn; its item and the response it was input to are deleted when the turn finishes, as a best effort (`agent.history.picture_kept` when that fails). *Limits.* What an API delete removes stays in the service's own storage until its time to live, and a conversation expires 60 days after it was made, whatever its activity — the next turn renews it without the earlier messages (`agent.history.conversation_expired`); both are in [limitations](limitations.md). The job's `agent` step and the backend's start report `agent.history.service_retention` while it is chosen, and the privacy notice says what the service keeps.

| Field | Default | Rule | Effect |
| --- | --- | --- | --- |
| `reasoningEffort` | `"low"` | one of `none`, `minimal`, `low`, `medium`, `high` | The chat model's reasoning effort, in the agent version. |
| `reasoningSummary` | `"auto"` | one of `auto`, `concise`, `detailed` | How much of its reasoning the model summarizes into the stream, in the agent version. |
| `webSearch.contextSize` | `"medium"` | one of `low`, `medium`, `high` | How much of the context window the service's web search may fill (`search_context_size`), in the agent version and in a voice session's search call. The tool's documented default. |
| `webSearch.maxOutputTokens` | `300` | whole | The longest answer a voice session's search call may write (`max_output_tokens`): a few terse sentences with their sources, spoken by the voice. The typed agent's responses are not capped. |
| `webSearch.reasoningEffort` | `"low"` | one of `none`, `minimal`, `low`, `medium`, `high` | The reasoning effort of a voice session's search call alone, which searches (`tool_choice: "required"`) rather than deliberating; the typed agent reasons with `reasoningEffort`. |
| `turns.burst` | `10` | whole | Turns one account may start in a burst. |
| `turns.refillPerMinute` | `30` | whole | Their refill. |
| `titles.burst` | `8` | whole | Conversation titles the whole deployment may write in a burst. |
| `titles.refillPerMinute` | `30` | whole | Their refill. |
| `titlesPerResource.burst` | `3` | whole | Of those, titles one account may have written. |
| `titlesPerResource.refillPerMinute` | `6` | whole | Their refill. |
| `foundry.maxSteps` | `6` | whole, 1 to 50 | Responses one turn may ask for: each round trip through the backend's tools is one. The last step's calls are answered all the same. A live session's turn — from the person's words to the voice's answer — is bounded by the same number: past it the calls are answered and no further response is asked for (`voice.live.max_steps`). |
| `foundry.keepVersions` | `10` | whole | Agent versions the job's `agent` step keeps; older ones are deleted. |
| `foundry.maxItemsRead` | `1000` | whole | The most items one read of a conversation takes, newest first: the browser shows that page, its newest messages. The export reads every page, so it is never cut short. |
| `history.store` | `"own"` | one of `own`, `foundry` | Where a new thread's messages are kept, as the list above describes; anything else is the default. Each thread records its own, so a change decides only the threads made after it, and needs no restart. |
| `history.maxItems` | `200` | whole | The most items of a thread a turn is given, newest first, from the conversation's history in Cosmos DB; it starts at a message of the person's, so no tool output goes without its call. On a `foundry` thread it bounds only what a live session is seeded with: the service truncates a typed turn's context itself. |
| `history.maxChars` | `200000` | whole | The same bound in characters of the items as JSON; the person's latest message is given whatever its size. |
| `memory.store` | `"foundry"`; `"own"` with `PRIVATE_NETWORKING` | one of `foundry`, `own` | Where what is remembered is kept, as the list above describes; anything else is the default. `foundry` with `PRIVATE_NETWORKING` fails the deploy, and an edit to it after the deploy runs `own` under `agent.memory.store_unreachable_private`. Read once per process: a change needs a backend restart. |
| `memory.updateDelaySeconds` | `60` | an integer from 0 to 86400 | How long the store waits for more of a conversation before it extracts; each new turn restarts the wait. Both stores. |
| `memory.maxChars` | `4000` | whole | What a turn carries of the remembered statements, in characters, newest first. Both stores. |
| `memory.itemMaxChars` | `500` | whole | The longest statement a person may write when they correct one, and on the own store the longest the extractor may keep. Both stores. |
| `memory.foundry.chatSummary` | `false` | boolean | At the job, `foundry` only: whether the store also keeps a summary of each conversation, which turns then read beside the statements. |
| `memory.foundry.procedural` | `false` | boolean | At the job, `foundry` only: whether the store keeps how the person wants things done as procedures. |
| `memory.foundry.ttlSeconds` | `0` | ≥ 0 | At the job, `foundry` only: how long a statement lives; `0` keeps it until the person, or an erase, removes it. |
| `voice.runtime` | `"agent"` | one of `agent`, `voiceLive` | What a live session's socket is opened on: a Foundry voice agent's version (preview), or the Voice Live API itself on a model it hosts (generally available). Read at each session's start, with no deploy ([details](#voice-runtimes)). |
| `voice.engine` | `"speechToSpeech"` | one of `cascade`, `speechToSpeech` | How a live session is answered, for every tier `engineByTier` leaves to it: the realtime model hearing the audio itself, or the person transcribed and answered in text by the chat's deployment ([details](#voice-engines)). |
| `voice.engineByTier.base` | `null` | `null`, or one of `cascade`, `speechToSpeech` | The engine for a `base` session, in place of `voice.engine`; `null` is `voice.engine`. |
| `voice.engineByTier.premium` | `null` | `null`, or one of `cascade`, `speechToSpeech` | The same for a `premium` session: the tier is read at the point of use, and the session asks for its engine's version. |
| `voice.managedModel.speechToSpeech` | `""` | empty, or one of `gpt-realtime-2.1`, `gpt-realtime-2.1-datazone`, `gpt-realtime-2.1-mini`, `gpt-realtime-1.5`, `gpt-realtime-1.5-datazone`, `gpt-realtime-mini` | A managed realtime model the speech-to-speech version names (`model_type: "managed"`) in place of the realtime deployment; empty, the default: the deployment (`self_deployed`). With one, speech-to-speech runs with no realtime deployment at all. The service then processes the person's speech where the model runs, not on this deployment's own model — see [managed voice models](#managed-voice-models) before setting it. |
| `voice.managedModel.cascade` | `""` | empty, or one of `gpt-5.4`, `gpt-5-mini`, `gpt-5-nano` | The same for the cascade's version, in place of the `chat` deployment: spoken turns are then answered by another model than typed ones. |
| `voice.transcription` | `"mai-transcribe"` | one of `whisper-1`, `gpt-realtime-whisper`, `gpt-4o-transcribe`, `gpt-4o-mini-transcribe`, `gpt-4o-transcribe-diarize`, `gpt-transcribe`, `gpt-live-transcribe`, `mai-transcribe`, `azure-speech` | Transcribes the person, in the version and in each session's update. Try a session after changing it ([details](#transcription)). |
| `voice.realtimeReasoningEffort` | `"low"` | one of `none`, `minimal`, `low`, `medium`, `high`, `xhigh` | The effort a speech-to-speech session's update gives a reasoning realtime model (`gpt-realtime-2`, `gpt-realtime-2.1`, `gpt-realtime-2.1-mini`, as `AZURE_OPENAI_REALTIME_MODEL` names it). Any other model, and `none`, is sent no effort: `gpt-realtime-mini` refuses one (`invalid_value`) and runs on without it. The cascade's sessions carry `reasoningEffort`, as a typed turn does. Neither engine is sent a `temperature`. |
| `voice.noiseReduction` | `"azure_deep_noise_suppression_headset"` | one of `azure_deep_noise_suppression`, `azure_deep_noise_suppression_headset`, `azure_personal_noise_suppression` | What the service takes out of the person's audio before it listens, in the version (a change is a new voice version at the next deploy). `headset` keeps the close speaker over background speech and noise; `personal` keeps one target speaker ([details](#noise-reduction)). |

#### Voice runtimes

- **`agent`**, the default and the recommended path. Each engine is a version of the Foundry voice agent, which holds the spoken prompt, the tools and the audio defaults; a session pins its version and is sent the person's part and language. Foundry voice agents are preview ([Migrate from Voice Live with Foundry Agent Service to Microsoft Foundry voice agents](https://learn.microsoft.com/en-us/azure/foundry/agents/how-to/migrate-from-voice-live)), and that page is Microsoft's recommended way to join Agent Service and Voice Live: a versioned definition, the deployment's own content-filter policy, tracing, and the same models as typed turns.
- **`voiceLive`**, the generally available opt-in, for a deployment that cannot accept preview terms. No version is made. The backend opens the Voice Live API on the account's own host (`/voice-live/realtime`, a generally available API version, its managed identity's bearer) on a model Voice Live hosts, and the session's first update carries what a version would: the prompt with the person's part rendered, every function tool, the voice, the transcriber, turn detection, noise suppression, echo cancellation and the fillers ([How to use the Voice Live API](https://learn.microsoft.com/en-us/azure/ai-services/speech-service/voice-live-how-to)). The model is `voice.managedModel`'s for the engine, or else the mode's default below; speech-to-speech always has a model, since Voice Live hosts it. The deployment's own realtime model is never used: through Voice Live it would be bring-your-own-model, which is preview ([Voice Live FAQ](https://learn.microsoft.com/en-us/azure/ai-services/speech-service/voice-live-faq)). The broker, the tools, the stage, the history given to the session and the record are the same code on both runtimes, and the browser is unchanged.

**The model on `voiceLive`.** Chosen by processing scope from [Voice Live region support](https://learn.microsoft.com/en-us/azure/ai-services/speech-service/regions?tabs=voice-live#regions) when `voice.managedModel` names none:

| Mode | Speech-to-speech | Cascade |
| --- | --- | --- |
| Demo | `gpt-realtime-2.1`, Global | `gpt-5.4`, Global in Sweden Central and France Central |
| Hardened | `gpt-realtime-2.1-datazone`, Data zone | `gpt-5-mini`, Data zone in Sweden Central and France Central |

Microsoft Learn says of the `-datazone` models that "Prompts and responses are processed only within the data zone associated with your resource's region". No text model is offered with a `-datazone` name; the table gives each text model's scope per region, and in Sweden Central and France Central `gpt-5-mini` is Data zone where `gpt-5.4` is Global, so hardened mode's cascade answers on the smaller model. The table offers `gpt-realtime-2.1-datazone` in Sweden Central but not France Central, which has `gpt-realtime-1.5-datazone`: a hardened deployment in France Central names that one in `voice.managedModel.speechToSpeech`. The job's `agent` step makes the voice agent's versions on either runtime, so a switch back to `agent` needs no deploy.

What `voiceLive` does without: Voice Live's built-in content filter applies in place of the deployment's policy, and the FAQ says it cannot be changed; the voice's accent per language and a reasoning effort, which have no field the Voice Live session documents; the voice agent's version history and tracing. Voice Live meters its hosted models against its own tokens-per-minute quota rather than the realtime deployment's capacity, and a session takes about a second longer to open than on a voice agent, as observed; what the person says while it opens is held and sent once it is ready. The backend holds Cognitive Services User on the account, the role Learn names for Voice Live with Microsoft Entra. Speech is processed where the hosted model runs ([managed voice models](#managed-voice-models)). The backend's side is proved against a stand-in of the API, and the runtime has been verified on a demo-mode deployment: typed chat is unaffected, and spoken tasks with tools and the stage work. It is also verified on a hardened deployment, behind private endpoints, where speech-to-speech ran on the data-zone model.

#### Voice engines

- **`speechToSpeech`.** The realtime deployment (`models.realtime`) hears the person's audio itself and answers. The version's Azure voice speaks the answer, or the model's own voice for a tier the `voice` document gives an OpenAI voice (`live.openaiVoices`). An OpenAI voice runs with no fillers, since the service refuses them beside one (`interim_response_requires_azure_voice`). It answers sooner, with no transcription before the model starts, and costs more ([the realtime deployment](#the-realtime-deployment)).
- **`cascade`.** The person is transcribed, the chat's deployment answers in text, and the text is spoken: one model for typed and spoken turns, and no deployment or quota beyond the chat's.

Each engine is a voice version of its own, and the job's `agent` step makes one for each engine some tier is answered by. If `speechToSpeech` is chosen with neither a realtime deployment nor a managed model (`voice.managedModel.speechToSpeech`) configured, the cascade runs. The job's `agent` step and the backend's start then report `agent.voice.speech_to_speech_unconfigured`.

#### Transcription

On the cascade, the transcriber runs before the chat's model reads what the person said; the cascade is documented with `azure-speech` and `mai-transcribe`. On speech-to-speech, it runs beside the realtime model's own hearing, for the readable transcript.

The default, `mai-transcribe`, is documented for gpt-realtime, gpt-realtime-mini and the cascades alike ([Voice Live how-to](https://learn.microsoft.com/en-us/azure/ai-services/speech-service/voice-live-how-to)). So it holds on either engine and on the fallback to the cascade. `azure-speech` is documented only beside a cascade, so speech-to-speech's version transcribes with `mai-transcribe` in its place, and the job and the backend report `agent.voice.transcriber_replaced`.

The service checks none of them when it makes a version:

- A cascade refuses a transcriber it does not take when a session opens (`invalid_input_audio_transcription_model`, naming the ones it does).
- A transcriber that runs on a deployment of its own, such as `gpt-4o-transcribe`, `gpt-4o-mini-transcribe` or `gpt-4o-transcribe-diarize`, fails every transcription of the session (`DeploymentNotFound`) while the session goes on. That lasts until the account has a deployment named after the transcriber.

#### Noise reduction

`headset` is what Microsoft's own voice-agent sample sends. The service takes all three types on both engines and echoes the type in the session; nothing in a session says whether `personal` enrolled a speaker.

The service checks the type when a session opens, not when the version is made. It answers a type outside its list (which also names `near_field` and `far_field`) with an `invalid_value` error, and the session does not close. Instead it runs on the service's defaults, without the version's instructions (guardrails included), its tools or its turn detection. That is why the setting accepts only the three types above.

Only the type is sent: the SDK's serializer writes `{ type }` alone, and `detection_input`, which isn't among the documented fields, is never sent. The two newer types are documented for Voice Live ([how-to](https://learn.microsoft.com/en-us/azure/ai-services/speech-service/voice-live-how-to)), not on the voice-agent page ([limitations](limitations.md)).

#### Memory on a private deployment

The Foundry memory store works only on a public (demo mode) deployment. Its extraction runs on Microsoft's side of the network and calls the account's `small` and `embedding` deployments from public Microsoft addresses; with `PRIVATE_NETWORKING` the account's public access is off, so every call is answered `403 Public access is disabled`, and nothing is ever remembered while nothing visibly fails. Learn lists it under *Limitations* of [What is memory?](https://learn.microsoft.com/en-us/azure/foundry/agents/concepts/what-is-memory): "Virtual network (VNet) integration isn't supported for memory stores." Even on a public deployment the store is preview and holds 100 scopes, one per account, so at most 100 people.

The memory store is a component, chosen at deploy time with `MEMORY_STORE` ([choose components at deploy time](deployment.md#choose-components-at-deploy-time)), and a private deployment is held to `own` at three points:

- **Before provisioning.** `preprovision` refuses `MEMORY_STORE=foundry` while the deployment is private (`PRIVATE_NETWORKING`, or `HARDENED` when that is unset), before anything is made:

  ```text
  agent.memory.store_unreachable_private: memory.store is foundry on a private deployment (PRIVATE_NETWORKING), where the Foundry memory store extraction calls the account from public Microsoft addresses and is refused 403; Microsoft documents that VNet integration is not supported for memory stores. Set MEMORY_STORE=own (azd env set MEMORY_STORE own), and memory.store to own in the app/agent document if it exists.
  ```

- **In the deploy, for the stored document.** On a hardened deployment App Configuration is private, so a hook on a laptop or CI runner cannot read it; the migrate job, inside the network, can. Its `settings` step refuses the same variable again, and also a stored `app/agent` document whose `memory.store` was edited to `foundry` since the last deploy, with the same line after `[settings] failed: Error:`. To fix that one, set `memory.store` to `"own"` in the document (from inside the network, or with App Configuration's listener opened for the edit) and run `azd deploy` again.
- **At run time, for an edit after the deploy.** App Configuration stays editable once the deploy has passed. A backend that reads `foundry` on a private deployment reports `agent.memory.store_unreachable_private`, logs it, and runs the own store, so memory keeps working until the document is corrected.

### `tools`

Which server-side tools the agent has, read once per turn. The stored keys are snake_case.

| Field | Default | Rule | Effect |
| --- | --- | --- | --- |
| `enabled_tools` | `["knowledgeSearch","webSearch","lookupRecord","listRecords","metrics"]` | a list of tool keys | The tools exposed; a key the product does not ship is ignored. `webSearch` is the service's own web search tool, run inside the response. A tool added to the code later is **not** in a stored list: add its key here. |
| `skills_enabled` | `true` | boolean | The kill switch for skills: off, no turn carries any skill in the Foundry project, whatever each skill's own `enabled`. |

### `guardrails`

The operator's wording for the two slots of the guardrail block, which is always the first part of the system prompt. The frame around them is code: the assistant says it is an AI when asked, and nothing later in the prompt overrides these lines. Each slot is checked on its own; an invalid one renders the shipped wording for that slot.

| Field | Default | Rule | Effect |
| --- | --- | --- | --- |
| `scope` | `"You are an assistant for the people who signed in to this service."` | non-empty text, at most 300 characters | One sentence on what the assistant is for. |
| `declines` | `["anything illegal, dangerous or hateful","medical, legal or financial advice beyond pointing at a professional","pretending to be a person when asked whether you are an AI"]` | 1–12 lines, each at most 160 characters | What it refuses, one line each. |

### `telemetry`

| Field | Default | Rule | Effect |
| --- | --- | --- | --- |
| `samplingRatio` | `1` | above 0, at most 1 | Fraction of the backend's traces recorded, applied live. The `problem` and `llm_usage` events are recorded whatever it is, so refusals and token counts stay whole. The frontend has no App Configuration store, so its traces are recorded at the compiled-in default whatever is stored here. To record nothing, unset `APPLICATIONINSIGHTS_CONNECTION_STRING`. |

### `edge`

| Field | Default | Rule | Effect |
| --- | --- | --- | --- |
| `maxRequestBodyBytes` | `1048576` | whole, 16384 to 134217728 | Largest request body the backend reads (`413 body_too_large` above it), and the bound the frontend applies before forwarding. |

### `access`

Who may read which document; see [documents](documents.md#who-may-read-a-document).

| Field | Default | Rule | Effect |
| --- | --- | --- | --- |
| `enforceAccessControl` | `false`; `true` on a hardened deployment (`HARDENED`) | boolean | On, every search carries the caller's readers filter, and a search with no verified caller returns nothing. Off, everyone signed in can find every document. The job seeds the default only where the document is absent, so a deployment that already stores one keeps its value: turn it on there with the command in [deployment](deployment.md#storage-memory-and-deploying-hardened). Stored as anything but a boolean, it is on ([an unreadable store](#an-unreadable-access-document)). |
| `globalDocumentAccess` | `true`, in both modes | boolean | On, a document loaded with no declared readers is everybody's (the group `all`), and `all` is in every caller's filter. So the sample library, whose `access.json` opens it to `all`, stays open to everyone signed in under enforcement. Off, such a document admits nobody under enforcement, and documents already loaded as `all` are hidden at once. Stored as anything but a boolean, it is off. |

#### An unreadable access document

A replica that has never read this document, because the store has been unreachable since its start, refuses every search, listing and read (`backend.knowledge.refused`, reason `access_unreadable`). The default here is the open one, and an outage must not open the library. Once the document has been read, the last good value stands.

### `knowledge`

What a search returns, what the indexer cuts, and how Prompt Shields is asked.

| Field | Default | Rule | Effect |
| --- | --- | --- | --- |
| `retrieval.engine` | `"hybrid"` | one of `hybrid`, `knowledgeBase` | What answers a search, typed or spoken: `hybrid`, the backend's own query over the index, or `knowledgeBase`, the service's knowledge base over the same index ([details](#retrieval-engines)). |
| `retrieval.reasoningEffort` | `"minimal"` | one of `minimal`, `low`, `medium` | How hard the knowledge base works on a typed turn's search, and on a live session's unless `retrieval.voiceReasoningEffort` names one, while `retrieval.engine` is `knowledgeBase` ([details](#retrieval-reasoning-effort)). |
| `retrieval.voiceReasoningEffort` | `null` | `null`, or one of `minimal`, `low`, `medium` | A live session's effort, in place of `retrieval.reasoningEffort`; `null` is `retrieval.reasoningEffort`. A spoken search is a silence a person hears: weigh it against `retrieval.voiceDeadlineMs`. |
| `retrieval.deadlineMs` | `8000` | whole, 1000 to 60000 | How long one search request of a typed turn's waits, on either engine, and the tag vocabulary's facet query, before it fails and the turn goes on without it. Planning above `minimal` adds seconds. |
| `retrieval.voiceDeadlineMs` | `8000` | whole, 1000 to 60000 | How long a live session's search waits, on either engine, before it fails as a slow index does and the answer goes on without it. Planning above `minimal` adds seconds. A typed turn's search waits `retrieval.deadlineMs`. |
| `retrieval.candidateMultiplier` | `10` | whole | Candidates pulled per result asked for, before flooring and diversifying, and never more than 50 in all, the most the service reranks per query: with six results asked for, a multiplier above 8 changes nothing. |
| `retrieval.rerankerFloor` | `1.9` | 0 to 4 | The minimum semantic reranker score a result needs. |
| `retrieval.maxPerDocument` | `3` | whole | Results one document may hold. |
| `retrieval.vectorWeight` | `1` | positive | The vector search's weight against the keyword search's fixed 1. |
| `retrieval.semanticRanker` | `true` | boolean | Whether the service's semantic reranker runs; off, there is no score to floor on. |
| `retrieval.tagVocabularyMax` | `300` | whole | Tags the planner is told exist, commonest first. |
| `planner.enabled` | `true` | boolean | Off, every question runs the plain hybrid search. |
| `planner.gate` | `true` | boolean | Off, every question is planned, whether or not it holds anything a filter could act on. |
| `planner.tagsShown` | `120` | whole | Tags shown to the planning model. |
| `planner.tagSelectivity` | `0.5` | above 0, at most 1 | How common a tag may be, as a fraction of the commonest, and still count as a filter. Where that would leave no tag at all — a library whose tags are used about evenly — every tag counts. |
| `planner.subjectTags` | `[]` | a list of text | Tags that name the whole corpus and so filter nothing. |
| `indexer.chunkChars` | `2000` | whole, 300 to 8000 | The text split skill's page, in characters, and so the size of one passage: `knowledgeSearch` hands the model each chunk whole, never cut. Read when the job's `index` step makes the skillset; a change reaches a file when it is next indexed (reset the indexer to cut every file again). |
| `indexer.overlapChars` | `200` | ≥ 0, below `indexer.chunkChars` | Characters each page repeats from the end of the one before. A stored pair whose overlap is not below the page keeps both defaults. |
| `indexer.ocr` | `true` | boolean | Whether pictures, and pictures inside documents, are read by OCR, billed per image through the Foundry account. |
| `indexer.waitMinutes` | `25` | whole, 1 to 120 | How long the job waits for one indexer run before it fails the step. |
| `shield.batchChars` | `10000` | whole, 1000 to 10000 | Characters of chunk text in one Prompt Shields request. |
| `shield.batchDocuments` | `5` | whole, 1 to 5 | Chunks in one Prompt Shields request. |

#### Retrieval engines

Both channels run a search through the backend's `knowledgeSearch`.

- **`hybrid`**: the backend's own query over the index, with every row of the table above.
- **`knowledgeBase`**: the service's knowledge base over the same index. The backend asks it on its `retrieve` route and reads the chosen chunks back under the served filter and the readers clause. The reranker floor, the unmatched terms and the backend's planner do not apply.

`knowledgeBase` asks the base with the served filter, and while `access.enforceAccessControl` is on, the caller's readers clause ([documents](documents.md#retrieval-through-a-knowledge-base)). It needs a run of the job's `index` step, which every deploy runs; see [documents](documents.md#retrieval-through-a-knowledge-base). It is never the agent's own `mcp` tool ([decisions](decisions.md), decision 27).

#### Retrieval reasoning effort

See Microsoft's [Set the retrieval reasoning effort](https://learn.microsoft.com/en-us/azure/search/agentic-retrieval-how-to-set-retrieval-reasoning-effort).

- **`minimal`**: the question is searched as it is.
- **`low`**: the base's planning model ([above](#the-knowledge-bases-planning-model)) rewrites it into sub-queries searched in parallel, in one pass.
- **`medium`**: `low` plus a semantic classifier and, when the first pass looks insufficient, one more pass. Learn offers it in select regions only.

Output stays extractive on every effort: the base returns passages and the agent answers. The effort is carried on each `retrieve` call, so a change applies from the next search. Above `minimal` with no planning deployment (`KNOWLEDGE_BASE=true` makes one), the search runs at `minimal` and `knowledge_base.planner_unconfigured` is on stderr.

### `appearance`

How the frontend looks: the color scheme, the palette, the type, the spacing, the corners, the assistant's name and welcome line, and the logo. A deployment can carry its own brand without a change to the code: edit this document in App Configuration, as any other (a logo also needs its image uploaded, as [the logo](#the-logo) describes), or in [Impact AI Admin Center](impact-ai.md#impact-ai-admin-center).

The defaults are the shipped look exactly, and the shipped look injects nothing: with nothing stored, the page renders from `apps/frontend/app/globals.css` alone, as built. Each group changes the page only once it differs from its default. It is applied as custom properties over the sheet's own tokens (`--bg`, `--accent`, `--font-sans`, `--space-*`, `--radius*`…) in a `<style>` the root layout writes into the page on the server, so no page draws the shipped look first.

The frontend reads the document through the backend's public `GET /appearance`, and each side caches it for `CONFIG_TTL_MS` (30 s), so an edit is live within about a minute. An unreadable document serves the last good value, or the shipped look.

The document's fields and formats are the ones Admin Center uses when it writes `appearance`, so one document reads the same wherever it was written. This frontend draws the fields below and silently ignores the rest: `layout.key` and `layout.split` (this workspace has one arrangement), `preview.origins` (it has no preview page), and any field it does not know. A preset is not a field: an editor that offers one writes its values into the fields below.

The palette is six primitives per color scheme. Change any one and the page derives every surface, wash and status color of that scheme from the six with `color-mix()`.

**A palette must be readable.** Every pair of text and its background must reach WCAG AA, 4.5:1, or that scheme's whole palette is refused back to its shipped colors. The pairs are text, muted text, the accent, and the danger and success colors, on the page, a panel and their washes, plus the ink on the primary. Six colors that only work together are kept or dropped together, so nobody is shown a page they cannot read. A refused field or palette keeps its default and the backend logs it (`[appearance] ignoring stored …`).

| Field | Default | Rule | Effect |
| --- | --- | --- | --- |
| `scheme` | `"system"` | `system`, `dark` or `light` | `system` follows the device's preference; the others pin one scheme. |
| `palette.dark.surface` | `"#0b0f17"` | `#rrggbb` | The page; panels, the band and the scrim are cut from it (`--bg`). |
| `palette.dark.ambient` | `"#be96ff"` | `#rrggbb` | The glow behind the panels (`--field-tint-3`). Decoration only. |
| `palette.dark.primary` | `"#7fb2ff"` | `#rrggbb` | Buttons, links, focus and selection (`--accent`); the ink on it is the darker or lighter of two, whichever reads. |
| `palette.dark.warning` | `"#ff8a7a"` | `#rrggbb` | Errors and warnings (`--danger`). |
| `palette.dark.success` | `"#6fd9a3"` | `#rrggbb` | Done and saved (`--success`). Status only. |
| `palette.dark.aux` | `"#8aadf3"` | `#rrggbb` | The chart anchor: the six series colors (`--chan-0` to `--chan-5`) are a fan of cool hues derived from it, each checked against the page. |
| `palette.light.surface` | `"#f4f6fa"` | `#rrggbb` | The same, under the light scheme. |
| `palette.light.ambient` | `"#8c5adc"` | `#rrggbb` | The same, under the light scheme. |
| `palette.light.primary` | `"#2457c5"` | `#rrggbb` | The same, under the light scheme. |
| `palette.light.warning` | `"#b3261e"` | `#rrggbb` | The same, under the light scheme. |
| `palette.light.success` | `"#1b6e46"` | `#rrggbb` | The same, under the light scheme. |
| `palette.light.aux` | `"#8aadf3"` | `#rrggbb` | The same, under the light scheme. |
| `type.font` | `"system"` | `system`, `humanist`, `rounded`, `serif`, `condensed` or `mono` | The text's font stack. Every stack names fonts a device already has, so nothing is downloaded. |
| `type.size` | `16` | whole, 14 to 20 | Pixels in one rem at the person's 100% text size; the text-size setting still scales it. |
| `type.steps` | `"standard"` | `standard`, `tight` or `wide` | The type scale: the sheet's own steps, or a geometric scale of ratio 1.125 or 1.25. |
| `space.density` | `"comfortable"` | `compact`, `comfortable` or `spacious` | Every spacing step and the gutter, ×0.75, ×1 or ×1.25. |
| `shape.radius` | `12` | whole, 0 to 24 | The card radius in pixels; the small, large and extra-large radii follow it. |
| `brand.name.en` | `""` | at most 60 characters, one line, no surrounding spaces | The app's name in English: the bar, the sign-in page's tab and every page's title (`common.appName`, `metadata.title`). Empty is the catalog's. |
| `brand.name.it` | `""` | as `brand.name.en` | In Italian. |
| `brand.name.es` | `""` | as `brand.name.en` | In Spanish. |
| `brand.name.fr` | `""` | as `brand.name.en` | In French. |
| `brand.name.de` | `""` | as `brand.name.en` | In German. |
| `brand.welcome.en` | `""` | at most 160 characters, one line, no surrounding spaces | The assistant's welcome line in English: the workspace's heading before anything is on the stage (`landing.heading`). Empty is the catalog's. |
| `brand.welcome.it` | `""` | as `brand.welcome.en` | In Italian. |
| `brand.welcome.es` | `""` | as `brand.welcome.en` | In Spanish. |
| `brand.welcome.fr` | `""` | as `brand.welcome.en` | In French. |
| `brand.welcome.de` | `""` | as `brand.welcome.en` | In German. |
| `brand.logo` | `""` | empty, or a key `appearance/logo/<sha256>.<png\|jpg\|webp\|gif>` | The logo, drawn before the name in the bar and above the heading on the sign-in page. The key names an object in the storage account's `appearance` container (`AZURE_STORAGE_APPEARANCE_CONTAINER`), which whoever writes the document uploads first ([details](#the-logo)). SVG is never a logo. |

#### The logo

The `appearance` container is kept apart from the library, so the indexer never reads the logo. The logo is served only through the backend's public `GET /appearance/logo`, relayed by the frontend's `/api/appearance/logo`. These open the one key `brand.logo` names and nothing else, and only when the stored object is:

- the type its key's extension says;
- at most 512 KiB;
- inert.

It is cached against the hash in its key.

### Managed voice models

A voice version names one of two kinds of model:

- **One of this deployment's own models** (`model_type: "self_deployed"`): the `chat` deployment for the cascade, the realtime deployment for speech-to-speech. This is the default, and what every version the job makes runs on unless a managed model is set.
- **A managed model**, which the voice service runs itself (`model_type: "managed"`, [Configure a voice agent](https://learn.microsoft.com/en-us/azure/foundry/agents/how-to/configure-voice-agent)): no deployment of this account's, none of its quota, and the service derives the engine from the model.

The names offered are the ones `MANAGED_VOICE_MODELS` in `platform/agent/src/voice-models.ts` lists: the portal's list on that page and the data-zone variants of the [Voice Live overview](https://learn.microsoft.com/en-us/azure/ai-services/speech-service/voice-live#supported-models-and-regions). For each model it records the engine, the processing scope, the efforts it takes, whether it speaks the OpenAI voices and the transcribers it is documented with. `azure-realtime` is not offered: it speaks only its own `azure-realtime-native` voices, which no setting here names. Every value the `agent` document or a voice tester gives is checked against that table, because a value the service does not take can open a session without the version's instructions, guardrails and tools.

- **Where it processes.** Not on this deployment's model, and not necessarily in its region. [Voice Live region support](https://learn.microsoft.com/en-us/azure/ai-services/speech-service/regions?tabs=voice-live#regions) gives each model's inference scope per resource region: the plain realtime names are Global wherever they are offered, the `-datazone` names stay in the data zone of the resource's region, and the text models' scope differs by region. The tuning panel says which next to each model. Speech recognition and synthesis keep their own scopes either way.
- **What it costs.** A managed model is billed as part of the voice agent at the Voice Live tier of the model (Pro, Standard or Lite, [Voice Live pricing](https://learn.microsoft.com/en-us/azure/ai-services/speech-service/voice-live#pricing)), not as tokens on a deployment of this account's, so the capacity the template sizes neither bounds nor meters it.
- **What it takes.** The gpt-realtime-2.1 family reasons (`minimal` to `xhigh`); gpt-realtime-1.5 and gpt-realtime-mini take no effort and are sent none. A managed cascade takes `mai-transcribe` or `azure-speech`, no OpenAI voice, and an effort from its own scale, sent only when it is on it. A transcriber outside a model's list is replaced by `mai-transcribe` in its version.

A deployment that adopts one for everybody adds it to its privacy notice ([privacy](privacy.md#what-reaches-the-model)); the shipped notice says a managed model may process speech outside the organization's account.

### Who tunes voice

A person whose account holds the app role `tester` sees **Settings → Voice tuning** and may change how their own live sessions run. They can set:

- the engine;
- the model source: this deployment's own model, or a managed one the service runs ([managed voice models](#managed-voice-models)), each shown with its processing scope;
- the model: a realtime one of the deployments above, or a managed model of the engine's;
- the voice, the turn detection and its timers, the noise suppression, the transcriber, the reasoning effort and the fillers.

The tuning is kept on their account in Cosmos DB, never in the `agent` or `voice` document, and reaches nobody else's session. The backend re-reads the role from the account's row on every save and every session's open, so a role taken away ends the tuning at the next session. A change applies from the next voice session.

**Version or update.** A session cannot change the engine, the model, an OpenAI voice, the fillers, the turn detection or the noise suppression. So each of these makes the tester's own voice-agent version, created at the first session that asks for it. The job's prune keeps such a version while a session is marked as running on it. The voice, the transcriber and the effort go in the session's opening update.

**Checks.** Every value is checked against the lists the fields above are checked against, and against what the deployment has:

- a realtime model only with its deployment;
- a managed model only of the engine's architecture, and only from its own list;
- a transcriber only for an engine that takes it;
- an effort only for a model that reasons, from that model's own scale;
- a noise type only from the three above, and beside the realtime model's own `semantic_vad` only the plain deep one, which the documents' type gives way to there ([limitations](limitations.md));
- an OpenAI voice (the list under `live.openaiVoices`) only on speech-to-speech.

A value that fails is refused (`invalid_body`, naming the field). A saved tuning that no longer holds is reported as `backend.voice_tuning.stale`, and the session runs on the documents.

An OpenAI voice turns the fillers off whatever the tuning says, and the panel shows them off and fixed. Speech-to-speech is offered on a deployment with no realtime deployment, on a managed model alone. The role is assigned like `premium` ([deployment](deployment.md#sign-in-with-microsoft-entra-id)); the `local` sign-in of demo mode never holds it.

### Not in App Configuration

- **The persona**, the second part of the system prompt, is a versioned document of the `prompts` container in Cosmos DB (key `assistant`). The migrate job's `settings` step seeds it with the code's shipped text (`apps/backend/src/product.ts`), and every deploy keeps it up to that text until an operator publishes a version of their own. With no version, that text is served. See [operations](operations.md#changing-the-persona).
- **Skills** are the Foundry project's, versioned there: every skill in the project whose default version is enabled and fits the turn's surface and tools is pinned into its agent version, and the live voice reads the same version. That metadata (`surfaces`, `requires-tools`, `enabled`, `origin`) rides in each version's `SKILL.md` front matter. The product's `skills` in code (Agent on Azure ships none) are only defaults: the job's `skills` step publishes one where the project lacks it or its default is still a shipped version made from other words, and never over an operator's. A turn falls back to the code's defaults only when the project's skills cannot be listed. See [operations](operations.md#managing-skills).
- **Who is premium, who may sign in and who tunes voice** are app roles on the Entra app registration ([deployment](deployment.md#sign-in-with-microsoft-entra-id)); **who may read a document** is `access.json` in its library ([documents](documents.md#who-may-read-a-document)).
