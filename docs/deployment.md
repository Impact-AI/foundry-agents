# Deployment

This page takes whoever runs `azd up`, an operator or a developer trying Agent on Azure in their own subscription, from an empty subscription to a running deployment in demo or hardened mode. It then covers changing the deployment, reaching its data services, and removing it; what it costs is on [cost](cost.md).

> **Choose demo or hardened mode first.** Some of what hardened mode sets cannot change on an existing environment ([changing an existing environment](#changing-an-existing-environment)).
>
> - **Demo mode** (the default) is for trying Agent on Azure on sample or public data. Public endpoints, a sign-in anyone can use, the lower running cost. Every sign-in is a new account, so the Foundry memory store (at most 100 accounts) fills after about 100 sign-ins, and spend is bounded per account, not per person. Keep the demo's address private, set an Azure budget alert, and `azd down` when you are done ([known gaps](security.md#known-gaps)).
> - **Hardened mode** (`azd env set HARDENED true` before the first `azd up`) is for real users and data. Private networking, Front Door with a WAF, Entra sign-in with a role required, and a higher fixed cost.
>
> [Demo and hardened](#demo-and-hardened) lists every difference, and [cost](cost.md) the prices.

## Prerequisites

| You need | Why |
| --- | --- |
| [Azure Developer CLI](https://learn.microsoft.com/azure/developer/azure-developer-cli/install-azd) (`azd`) | Provisions and deploys. Version 1.37.1 or later: `azure.yaml` requires it, and an older azd refuses to load the project. |
| [Azure CLI](https://learn.microsoft.com/cli/azure/install-azure-cli) (`az`), signed in as the same principal | The hooks and scripts call it. |
| An Azure subscription where you are **Owner**, or **Contributor** plus **User Access Administrator** | The template creates a resource group and role assignments at subscription scope, and Azure Policy assignments on the resource group (`POLICY_AUDIT`), which User Access Administrator covers. |
| Quota for the models in one region | See [Regions and model quota](#regions-and-model-quota). |
| `openssl` and `ssh-keygen`, for the bash hooks | `preprovision` makes the session secret with `openssl rand` and, with `DEVELOPER_ACCESS`, the jump VM's key with `ssh-keygen`; the PowerShell version makes the secret with .NET and the key with `ssh-keygen`. Most macOS and Linux installs have both; the dev container does. |
| For Entra sign-in: the right to create an app registration and assign its roles | `preprovision` makes the registration as you ([sign-in with Microsoft Entra ID](#sign-in-with-microsoft-entra-id)): Application Developer (or the tenant's default user rights) to register; its owner, which you then are, assigns its roles. Without the right it says so and the deployment carries on. |

You need no Docker and no network route to the data services, in either mode. Images are built in the registry, and every write into a data service runs in the migrate job inside the deployment. Bun is needed only for the [deployment checker](#deployment-checker) and the persona and skills CLIs ([changing the persona](operations.md#changing-the-persona), [managing skills](operations.md#managing-skills)). The [dev container](../.devcontainer/devcontainer.json) has everything.

## Deploy

```sh
azd auth login
az login                                      # the hooks call az as you
azd env new my-env --location swedencentral --subscription <subscription id>   # any region with the models' quota; without --subscription azd asks, and --no-prompt has none
azd env set AZURE_SEARCH_LOCATION northeurope # if the region has no AI Search capacity; see below
azd up
```

**AI Search may refuse the region.** Azure AI Search capacity varies by region, and some regions refuse new services ([Choose a region for Azure AI Search](https://learn.microsoft.com/en-us/azure/search/search-region-support), a region's footnote: "This region is in high demand, which prevents the creation of new search services"). The search service then fails within a minute, with `InsufficientResourcesAvailable` at the end of azd's output under a misleading headline ([troubleshooting](#troubleshooting)). The run keeps going until every sibling resource has finished (often twenty minutes) and leaves no search service behind. Then run `azd env set AZURE_SEARCH_LOCATION <another region>` and `azd up` again. Search alone is placed in that region, private endpoint included, and everything else stays where it was ([regions and model quota](#regions-and-model-quota)). Set it before the first `azd up` if you know your region is short; it costs nothing when the region has capacity.

A clean demo `azd up` takes about 30 minutes, much of it the Foundry project's [capability host](patterns.md#terms); a first attempt a region refuses costs about 20 minutes more, and the re-run keeps everything already made. At the end azd prints two `Endpoint:` lines, not `FRONTEND_URL`: the backend's (`…internal…`) and the frontend's. Open the frontend's and sign in with a name (the demo's `local` sign-in); the same address is `FRONTEND_URL` in `azd env get-values`.

### Deployment checker

```sh
bun scripts/verify-deployment.ts                         # what Azure made, and the app signed out and in
bun scripts/verify-deployment.ts --voice --destructive   # also a live session, an erase, and an --open-listener load
```

The deployment checker, [`scripts/verify-deployment.ts`](../scripts/verify-deployment.ts), checks what the template made for this environment's mode, then drives the deployed frontend as a browser does. It reads the azd environment and asks `az`, signed in as an identity that reads the resource group. A run that asks `az` anything refuses to start without `AZURE_SUBSCRIPTION_ID`. It exits 0 only when nothing failed, and writes its report to `verify-report.md` and `verify-report.json`. The [smoke test](operations.md#smoke-test) is the shorter check, with no `az` or Bun; [check a deployment](operations.md#check-a-deployment) says when to run which.

<details>
<summary>The checker's groups, results, cleanup and options</summary>

Its checks come in groups; `--only <group>[,<group>…]` runs some, and `--env <name>` names another azd environment:

- `control`: the resources and their settings. Each app runs the image `SERVICE_*_IMAGE_NAME` names when the environment holds one, and in a private deployment every data service refuses public network access.
- `web`: the frontend signed out and signed in, including the nonce policy, all its directives and the security headers on `/login`, `/privacy`, `/chat` and `/settings`.
- `voice`: a live session.
- `telemetry`: Application Insights received the run's rows. The check asks its query API with a token `az` gives for the environment's tenant, `AZURE_TENANT_ID`, because `az monitor app-insights query` takes the tenant of the CLI's default subscription instead.
- `destructive`: an erase, and an `--open-listener` load.

**Results.** Each check passes, or fails with what it asked and what came back. A check is skipped only where the environment says that what it checks does not exist; a check that could not sign in, reach or read its subject fails as not checked. The run writes `verify-report.md` and `verify-report.json` (`--report <path>` names them) and exits 0 only when nothing failed. The evidence names cookies but never holds their values, and the export's evidence is its size and its keys. Every `az` call and request has a time limit, so a call that hangs fails its check rather than the run.

**Cleanup.** A run takes back what it makes. Its account and its conversations are deleted when the checks end, when one throws, and on Ctrl-C or SIGTERM; anything it could not delete is a failure in the report. A library that `--destructive` loads has a name of the run's own, recorded before the load starts, and the same check removes it.

**Interrupted runs.** On a signal no further check starts. The signal is passed to a running `ingest.sh`, which closes the storage account's public listener, and the run waits up to two minutes for it and its output. It then takes back what it made and reads the storage account again. Its report's result is `INTERRUPTED`, naming the signal, the check it stopped and the checks not run (exit 130 or 143).

**What some checks rest on.**

- Every run checks that the backend's latest revision is healthy, ready and not restarting, so a backend that does not start fails even where nothing signed in can reach it. From outside, the backend must not answer at all, or answer the platform's 404 for an internal app.
- The operator whose data roles are checked is `OPERATOR_PRINCIPAL_ID`, else `AZURE_PRINCIPAL_ID`. For an environment that stores neither, it is the principal given to the environment's latest succeeded subscription deployment.
- The backend mints its own id for each turn and tells the client none. The telemetry check therefore counts the backend's `llm_usage` rows written while one of the run's turns was open (with a minute of clock slack either side), so another caller's turn in those seconds counts too.
- A live session must open with `ready`, raise no error, and end as the client asked (`ending` and `ended` for `client`, the socket closed with 1000).
- In a private deployment the Key Vault check says which secrets the vault holds without reading their values. A placeholder session secret or Entra client secret shows instead as an app that refuses to start (the revision check). A wrong Entra secret that is not the placeholder shows only when someone signs in.

**Options that are refused.** `--allow-http` is for a frontend running on your own machine and is refused for any other. `--only` naming `voice` or `destructive` needs `--voice` or `--destructive` beside it, because a run that would select no check is refused.

**Under `entra`.** A script cannot sign in, so the run checks that sign-in goes to Entra with the registration's client id. To run the signed-in checks, set `VERIFY_SESSION_COOKIE` to a test user's session cookie (`name=value`, as the browser holds it); the run then never erases that account. `--destructive` beside it is refused, because the erase it checks is the run's own account's, which only a local-mode environment gives it. Without the cookie the run refuses to start, unless `--signed-out-only` says it checks nothing signed in; the signed-in checks are then skipped as the operator's choice. `--signed-out-only` cannot go with `--voice` or `--destructive`.

</details>

### A fresh hardened run

Hardened signs in with Entra only, and `preprovision` makes the app registration for it as you, before the template runs ([sign-in with Microsoft Entra ID](#sign-in-with-microsoft-entra-id)). A clean run takes about an hour (the Foundry Agent Service making its capability host in the injected subnet, the replicated Redis and the model deployments queued behind the account), and it needs these set before the first `azd up`, in this order:

```sh
azd env new my-env --location swedencentral --subscription <subscription id>
azd env set HARDENED true                        # the bundle; decide it now, two parts cannot change later
azd env set DEVELOPER_ACCESS true                # optional: Bastion and a jump VM for reaching the data services
azd env set AZURE_SEARCH_LOCATION northeurope    # if the region has no AI Search capacity, as above
azd up
```

> **Open `FRONTEND_URL`, and expect 404s at first.** The address to open is `FRONTEND_URL` in `azd env get-values`, not the frontend `Endpoint:` azd prints last: in hardened mode that is the closed environment's own hostname and answers nothing. For about twenty minutes after Front Door's endpoint is made, it answers its own HTML "Page not found" 404 on every path, `/health` included, edge node by edge node. Opened as `azd up` returns, `FRONTEND_URL` shows propagation, not the app.

What the first provision sets up for sign-in, and what follows `HARDENED`:

- The registration's client id and secret reach Key Vault in that first provision. Its redirect URI is the frontend's address, added by `postprovision` once the provision has made it, and you hold the roles `user` and `tester`.
- If `preprovision` could not make the registration (it says so, with the steps), Key Vault holds placeholders, and an Entra sign-in fails with the registration-values row under [troubleshooting](#troubleshooting). The deployment is otherwise whole: make the registration by hand, set the two values and `azd provision`.
- `PRIVATE_NETWORKING` and `ZONE_REDUNDANT` follow `HARDENED` and cannot change in place ([changing an existing environment](#changing-an-existing-environment)).
- A new hardened deployment enforces document readers from its first deploy ([document readers, hardened](#storage-memory-and-deploying-hardened)).

### What a first deploy does

1. **`preprovision`** checks and prepares before anything is made:
   - it refuses a combination of components that cannot work ([below](#choose-components-at-deploy-time)), and a region that does not offer the realtime model ([regions and model quota](#regions-and-model-quota));
   - it asks Azure Resource Manager which secrets the vault holds and which services already run (`KEY_VAULT_HOLDS`, `SERVICES_RUNNING`);
   - it generates `AUTH_SECRET` into the azd environment when neither that environment nor the vault has one;
   - it registers the resource providers the Agent Service's injection needs (`Microsoft.App`, `Microsoft.ContainerService`) where the subscription has not;
   - it makes the jump host's SSH key when developer access is on, and records whether you are a user or a service principal;
   - for Entra sign-in, it makes the app registration and sets its client id and secret into the environment.
2. **Provision** creates the resource group and everything in [architecture](architecture.md#azure-services-per-mode). The apps start on a placeholder image, which answers on neither health probe's port, so they start with no probes.
3. **`postprovision`** adds the sign-in callback at `FRONTEND_URL` to the registration it made. It deletes any connection of the Foundry project to a knowledge base's MCP endpoint (nothing in the template uses one) and, unless `AGENT_TRACING` is on, the project's `insights` connection to Application Insights. Hardened only, it approves the private-endpoint connection that Front Door's origin asked the environment for, and names any other pending request without approving it.
4. **Deploy** builds both images in the registry (`remoteBuild`) and rolls both apps.
5. **`postdeploy`** gives each app that holds no health probes the template's (the provision's outputs `BACKEND_PROBES` and `FRONTEND_PROBES`), as a new revision, since `azd deploy` changes only an app's image. Then it points the migrate job at the new backend image and runs these steps in one execution:
   - `settings`: the eleven settings documents, and the persona in Cosmos DB (its first version where absent, the next where the shipped text changed and no operator has published one);
   - `index`: AI Search's index, data source, skillset and indexer;
   - `skills`: the product's default skills, written to Cosmos DB where no version of a name is stored (Agent on Azure ships none);
   - `agent`: the memory store when `memory.store` is `foundry`, and the agent version each channel's turns ask for;
   - `library` (the nine sample documents) or `remove-library`.

   A failed step fails `azd up` and prints the job's log. A green execution prints only that it started and that it succeeded; read its log with the command under [the migrate job's log](operations.md#the-migrate-jobs-log).

Until its Cosmos DB role assignment has applied, the backend is live on `/health` and answers 503 on `/ready` and every other route; it logs that it is waiting, and serves as soon as it is admitted. The first sign-in may therefore fail with "starting" for a minute or two after `azd up` returns on a first deploy.

### Redeploys

| Command | What it does |
| --- | --- |
| `azd deploy` | Builds and rolls both apps, then runs the migrate job's steps again. Every step is idempotent: settings documents already stored, an index already current, skills already stored, an agent version already made and documents already loaded are left alone. |
| `azd provision` | Applies the template, keeping the deployed images and the vault's secrets (below). Needed after any `azd env set` of a parameter. |
| `azd up` | Both. |
| `az containerapp job start --subscription <AZURE_SUBSCRIPTION_ID> -g <rg> -n <MIGRATE_JOB_NAME>` | Repeats the deploy's job steps on their own; the job keeps the arguments the last deploy gave it. |

Re-provisioning keeps the deployed images. azd holds their names in the environment on the machine that deployed (`SERVICE_*_IMAGE_NAME`). From a machine without them, a pipeline's fresh runner among them, each app keeps the image it runs (`SERVICE_*_RESOURCE_EXISTS`). A provision keeps the vault's secrets too: a secret it carries no value for is left as the vault holds it.

Settings documents are written only where absent, so an operator's edits survive every deploy, and a new field added to a document's default in code is served at its default until somebody stores a value for it; the persona follows the code until an operator publishes a version, and theirs from then on ([operations](operations.md#changing-the-persona)), and a skill is the code's only until one of its name is stored ([managing skills](operations.md#managing-skills)).

An index this definition cannot update in place is made again by the `index` step of the next deploy, once. That is an index whose vector field is not stored, as an earlier version of the template made it, or one keyed on another field. The step:

1. deletes the template's knowledge base and knowledge source over the index, since the service refuses to delete an index a knowledge source names, or a source a knowledge base names;
2. deletes the index and makes it again, with the knowledge base and source when `retrieval.engine` is `knowledgeBase`;
3. resets the indexer and runs it over every blob, waits for the index to show what the run wrote, and has Prompt Shields read every chunk.

So every library loaded into the index, the sample library and an operator's alike, is back before the step ends. That holds whether or not the deploy loads a library after it (`SEED_SAMPLE_LIBRARY=false` ends in `remove-library`, which runs no indexer). Until then a search finds fewer passages, or none: the step takes as long as an indexer run over the whole library, at most `indexer.waitMinutes`. A run the service does not call a success fails the step, and the deploy with it, after the scan. A file the run failed is named in the job's log and is back at its library's next load.

### The hooks

Every hook has a bash and a PowerShell version, and every one makes control-plane calls only, apart from `hooks/entra`'s Microsoft Graph calls for the sign-in registration. Every Azure Resource Manager call a hook or script makes names the environment's subscription (`--subscription $AZURE_SUBSCRIPTION_ID`, which azd hands to every hook and `azd env get-values` prints for the scripts), and refuses to run without it: az's own default is whichever subscription was selected last on the machine, and a job looked for there "does not exist". Graph takes no subscription and answers for the tenant of az's selected one, so `hooks/entra` first checks that it is the environment's tenant and stops otherwise. The `az` commands these pages give for a person to run mostly leave the subscription out: add `--subscription <AZURE_SUBSCRIPTION_ID>` unless az's selected subscription is the environment's.

| Hook | Runs | Does |
| --- | --- | --- |
| `hooks/preprovision` | before `azd up` and `azd provision` | Checks the variables and prepares secrets, keys and providers before the template runs (below). |
| `hooks/postprovision` | after the template | Runs `hooks/entra redirect`, deletes project connections the template does not use, and approves Front Door's private-endpoint connection (below). |
| `hooks/postdeploy` | after `azd deploy` | Gives an app that holds no health probes the template's; points the migrate job at the new image and runs its steps, waiting for them. |
| `hooks/predown` | before `azd down` | Lifts the resource group's locks, then deletes the Agent Service's capability hosts, every project's before the account's. It takes the group from `AZURE_RESOURCE_GROUP`, or from the environment's name where a provision never got far enough to set it, so it also runs after a provision that never completed, and does nothing where no group was made. |
| `hooks/entra` | run by `preprovision` and `postprovision` | The sign-in app registration ([sign-in with Microsoft Entra ID](#sign-in-with-microsoft-entra-id)). Never fails the hook that runs it. |
| `hooks/job` | sourced by `postdeploy` and `scripts/ingest` | Updates the job's arguments (keeping its environment and identity), starts an execution, waits up to 30 minutes, prints the log's last 200 lines on failure, and one line when the execution starts and one when it succeeds. |
| `hooks/private` | sourced by `scripts/ingest` | When a service's listener is off, says how to run from inside the network or open the listener briefly. |

**`preprovision` in detail.**

- It refuses components that cannot go together, zones without the network, and a region without the realtime model.
- It asks Azure Resource Manager which secrets the vault holds and which services run (`KEY_VAULT_HOLDS`, `SERVICES_RUNNING`), so the template replaces neither a secret nor a running image with a placeholder.
- It generates the session secret when neither the environment nor the vault has one, and makes the jump host's SSH key when developer access is on.
- It registers `Microsoft.App` and `Microsoft.ContainerService`, records the principal's type, and runs `hooks/entra register`.

**`postprovision` in detail.**

- It runs `hooks/entra redirect`.
- It deletes the project's connections to a knowledge base's MCP endpoint (category `RemoteTool`, a target under `/knowledgebases/`). Nothing in Agent on Azure uses one, so a connection made by hand is gone after the next provision.
- Unless `AGENT_TRACING` is `true`, it deletes the project's `insights` connection. The template's condition only stops making the connection, and an incremental deployment never deletes a resource it no longer declares, so a deployment that had tracing on is traced until this runs.
- Behind Front Door, it approves the private-endpoint connection pending on the Container Apps environment that the edge's origin asked for, and names any other without approving it.

## Demo and hardened

One switch, `azd env set HARDENED true`, moves the deployment from demo mode to hardened mode; each part of the bundle can then be overridden on its own with its own variable (`true`/`false`, empty follows `HARDENED`).

| Part | Demo (`HARDENED=false`, default) | Hardened (`HARDENED=true`) | Override |
| --- | --- | --- | --- |
| Network | None. The apps reach every service over its public endpoint, Entra-authenticated. The Agent Service runs on Microsoft's network. | A virtual network, with a private endpoint and private DNS zone for each data service and their public listeners off ([the network](#the-network-hardened)). The Agent Service is injected into the network. | `PRIVATE_NETWORKING` |
| Telemetry | Public ingestion into Application Insights and Log Analytics. | The same. `PRIVATE_TELEMETRY=true` opts in to ingestion through an Azure Monitor private link scope, whose delivery is untested; verify it on your deployment before relying on it ([decision 29](decisions.md#29-telemetry-on-a-private-deployment-public-ingestion-by-default-azure-monitors-private-link-by-opt-in)). | `PRIVATE_TELEMETRY` (opt-in) |
| Edge | The Container Apps ingress. | Front Door Premium with a WAF in Prevention; the environment's public ingress closed; the origin reached over a private link. | `USE_FRONT_DOOR` |
| Locks | None. | `CanNotDelete` on Cosmos DB, Storage, Key Vault, AI Search, App Configuration (and their private endpoints). `predown` lifts them. | `LOCK_DATA_RESOURCES` |
| Key Vault | Purge protection off, so `azd down --purge` frees the name. | Purge protection on. | `KEY_VAULT_PURGE_PROTECTION` |
| Zone redundancy | None; Cosmos DB serverless. | Zone-redundant environment, ZRS storage, replicated Redis, zone-redundant Cosmos DB, and at least two replicas of each app and of AI Search ([zone redundancy](#zone-redundancy-hardened)). | `ZONE_REDUNDANT` |
| Azure Policy (audit) | Local authentication off, on the Foundry account, Cosmos DB, AI Search and Storage. | The same, and their public network access off. | `POLICY_AUDIT` (`false` assigns none) |
| Sign-in | `AUTH_MODE` as set (`local` by default); `AUTH_REQUIRE_ROLE` as set. | `entra` and a role required, whatever those say. The apps refuse to start hardened otherwise. | — |
| Memory | The Foundry memory store (preview). It holds at most 100 accounts, and every `local` sign-in makes a new account, so a pilot past about 100 sign-ins needs `own` ([memory](limitations.md#memory)). | The deployment's own store in Cosmos DB, since the Foundry store cannot run behind private endpoints ([memory, hardened](#storage-memory-and-deploying-hardened)). | `MEMORY_STORE` (`foundry` or `own`; empty follows `PRIVATE_NETWORKING`) |
| Web search | On: the Agent Service's web search sends the search words it chooses to Bing, outside the Azure compliance boundary ([privacy](privacy.md#what-is-stored)). | The same. | Remove `webSearch` from the [`tools`](configuration.md#tools) document's `enabled_tools` |
| Document readers | Recorded, not enforced: the `access` document is seeded with `enforceAccessControl: false`, so everyone signed in can find every document. | Enforced: seeded with `enforceAccessControl: true` and `globalDocumentAccess: true`. A document whose `access.json` names readers is held to them; one open to `all`, like the sample library, stays open to everyone signed in. | The stored `access` document ([below](#storage-memory-and-deploying-hardened)) |

### The network, hardened

The virtual network is `10.0.0.0/16`, with three subnets: `apps` (/23) for the Container Apps environment, `data` (/24) for the private endpoints, and `agent` (/24), delegated to the Agent Service alone. Redis, Key Vault, App Configuration, AI Search, Cosmos DB, Storage and the Foundry account each get a private endpoint and a private DNS zone, with their public listeners off. The Foundry account takes three zones: `openai`, `services.ai` and `cognitiveservices`.

The Agent Service is injected into `agent` and reaches Cosmos DB, Storage and AI Search through the same endpoints. Network security groups sit on `data` (no outbound flow from the endpoints) and, with developer access, on Bastion's and the jump VM's subnets. `apps` carries none, because its ingress is external and never crosses the subnet. The `agent` subnet keeps its default outbound access unless `AGENT_EGRESS=restricted` ([below](#restricting-the-agent-subnets-egress)).

### Zone redundancy, hardened

- The Container Apps environment is zone-redundant and storage is ZRS.
- Azure Managed Redis is replicated across two nodes, which the service spreads over the region's zones.
- Cosmos DB is provisioned and zone-redundant, since serverless has no zone redundancy. Cosmos DB takes this when the account is created and never after.
- Each app runs at least two replicas, and AI Search two, since one replica is in one zone. Two Search replicas meet its SLA for queries, three for queries and indexing together (`SEARCH_REPLICAS`, [scaling](operations.md#scaling)).
- Zones need the network. A zone-redundant Container Apps environment requires a virtual network with an infrastructure subnet ([Create a zone-redundant container app](https://learn.microsoft.com/en-us/azure/container-apps/how-to-zone-redundancy)). So `preprovision` refuses `ZONE_REDUNDANT` without `PRIVATE_NETWORKING` before anything is made (`deployment.zones_need_network`).

### Storage, memory and deploying, hardened

Storage is private with the rest when private networking is on: no browser reads a blob, so nothing outside the network needs it, and `scripts/ingest.sh` uploads a library from inside the network or with the listener on and one firewall rule, for the operator's own address, for the upload (`--open-listener`, [documents](documents.md#load-a-library)). The container registry stays public in both modes, because remote builds push images to it. Shared keys are off on both.

**Memory, hardened.** The Foundry memory store cannot run behind private endpoints: its extraction calls the account from public Microsoft addresses and is answered 403. Microsoft Learn: "Virtual network (VNet) integration isn't supported for memory stores" ([What is memory?](https://learn.microsoft.com/en-us/azure/foundry/agents/concepts/what-is-memory)). So with `PRIVATE_NETWORKING` the memory store defaults to `own`, and `preprovision` refuses `MEMORY_STORE=foundry` before anything is made ([choose components at deploy time](#choose-components-at-deploy-time); [memory on a private deployment](configuration.md#memory-on-a-private-deployment)). The Foundry store is for demo mode, and holds at most 100 accounts there.

**Document readers, hardened.** The job's `settings` step writes the `access` document only where it is absent ([settings documents](configuration.md#settings-documents)). A deployment whose document is already stored keeps what it holds: one first deployed in demo mode and hardened later, one deployed with an earlier version of Agent on Azure, which seeded enforcement off, or one set by hand. To turn enforcement on there, run this from inside the network, or with the store's listener opened for the edit:

```sh
az appconfig kv set --endpoint <APP_CONFIG_ENDPOINT> --auth-mode login --key app/access --content-type application/json --value '{"enforceAccessControl": true, "globalDocumentAccess": true}'
```

Every backend replica reads the new value within `CONFIG_TTL_MS`, with no deploy and no library reload. A library load that records readers while enforcement is off prints `WARNING: READERS NOT ENFORCED` in the job's log, and the ingest scripts repeat it ([documents](documents.md#who-may-read-a-document)).

Hardened deploys from a laptop or a hosted CI runner exactly as the demo does: the hooks make control-plane calls only (and Graph calls for the sign-in registration), and the migrate job runs inside the network. The one thing a hardened deployment changes for you afterward is that editing a settings document, or reaching a data service by hand, happens from inside the network or with the listener opened for the minutes it takes.

### Restricting the agent subnet's egress

With private networking, the Agent Service's `agent` subnet keeps Azure's default outbound access: anything the platform or an agent opens to the internet leaves through an address Azure picks, unfiltered. That is the default because Microsoft's own private-network sample gives the subnet no security group and no egress path of its own, and it is what the capability host is known to finish creating with. `azd env set AGENT_EGRESS restricted` closes it:

- the subnet's default outbound access is off, and a NAT gateway with one static public address (`ng-agent-…`, `pip-agent-…`) is its only way out;
- a network security group (`nsg-agent-…`) admits nothing in, and out only the `data` subnet's private endpoints, the subnet itself, and four service tags on 443: `AzureActiveDirectory` (the managed identities' tokens, which the Agent Service's Learn page names), `MicrosoftContainerRegistry` and `AzureFrontDoor.FirstParty` (the platform's own containers, from Container Apps' rules for a workload-profiles subnet), and `AzureMonitor`. Everything else is refused. Azure DNS is not subject to a security group.

Decide it before the first provision, as `PRIVATE_NETWORKING`: the capability host is made into the subnet as it is then, and whether Azure accepts a change to a delegated subnet's outbound access while the host holds it is untested. On a deployment that is already running, take the capability hosts down first (`azd down`, or the predown hook's order by hand) before switching. After an `azd up` with it, check that `azd up` ended with the capability hosts `Succeeded`, that a typed turn which searches the library and the web answers, and that the agent's traces arrive. If provisioning stops on the capability host, set it back to `open` and provision again, and read [decisions](decisions.md#28-the-agent-subnets-egress-open-by-default-a-nat-gateway-and-a-service-tag-allow-list-by-opt-in) for what the allow list rests on.

### The WAF

Default Rule Set 2.1 in Prevention, every rule of it blocking; Bot Manager 1.0 at its default actions, which are not all Block ([security](security.md#the-waf)); no custom rules. One deliberate exception, because ordinary chat traffic trips it:

- **Request bodies are not inspected** (`requestBodyCheck: Disabled`). Chat bodies carry prose and tool descriptions, which match SQL-injection rules (942200 blocked ordinary conversations). Every route validates and caps its own body, SQL is parameterized, and every API route needs a session.

Rule 920420 (a content type outside the rule set's list) blocks like every other rule. Live voice is one WebSocket: Front Door passes the upgrade (WebSockets are generally available on Standard and Premium) and the WAF inspects its handshake, never its frames.

URI, query string, headers and cookies are still inspected. There is no rate-limit rule at the edge; all rate limits are the app's, after sign-in.

### Changing an existing environment

`azd provision` changes a deployment in place and the apps keep serving throughout, with two things that cannot change in place: the account holds one capability host, made with the network injection or without it and into the agent subnet as it then is, and Cosmos DB's throughput mode and zones are fixed when it is created. So decide the three settings that fix them, `PRIVATE_NETWORKING`, `AGENT_EGRESS` and `ZONE_REDUNDANT`, before the first provision; to change any of them afterward, `azd down --purge` and provision again. A provision adds and updates and never deletes: a resource or a model deployment the template stops declaring stays, billed, until you remove it by hand. An Azure Cache for Redis in the group is one such resource: the template declares Azure Managed Redis, so a provision makes that instance beside the cache and points the backend at it, and the cache (`az redis list -g <resource group>`) is yours to delete. Nothing has to be moved: Redis holds only claims, allowances, queues and caches, each rebuilt or expired on its own. The jump VM is the one resource a provision cannot update when what it is created with differs: Azure refuses a change to a VM's `customData`, so a VM whose welcome text is not the template's is deleted before the provision that makes it again (`az vm delete -g <resource group> -n <JUMP_HOST_NAME> --yes`). That text names no other resource, so nothing else in the template changes it.

## Choose components at deploy time

A **component** is which Azure or Foundry piece does a job: where memory is kept, where history is kept, what answers a search, what answers a live session. Components are chosen at deploy time with azd variables, like any other deployment parameter; **tuning** (bounds, limits, voices, efforts) stays in App Configuration only ([configuration](configuration.md#settings-documents)).

```sh
azd env set MEMORY_STORE own
azd env set RETRIEVAL_ENGINE knowledgeBase
azd up
```

| Variable | Values | Default (unset) | Needs | Refused when | Editable later in App Configuration |
| --- | --- | --- | --- | --- | --- |
| `MEMORY_STORE` | `foundry`, `own` | `foundry`; `own` on a private deployment | nothing: `foundry` is made by the job's `agent` step | `foundry` with private networking (`agent.memory.store_unreachable_private`) | Yes, `agent` → `memory.store`; read once per process, so restart the backend. `foundry` on private is refused again at the next deploy and at run time |
| `HISTORY_STORE` | `own`, `foundry` | `own` | nothing | never | Yes, `agent` → `history.store`; decides only threads made after it |
| `RETRIEVAL_ENGINE` | `hybrid`, `knowledgeBase` | `hybrid` | `knowledgeBase` needs the job's `index` step, which makes the base; a reasoning effort above `minimal` needs `KNOWLEDGE_BASE=true` too, the base's planning deployment, and runs at `minimal` without it (`knowledge_base.planner_unconfigured`) | never | Yes, `knowledge` → `retrieval.engine` |
| `VOICE_ENGINE` | `speechToSpeech`, `cascade` | `speechToSpeech` | `speechToSpeech` runs on the realtime deployment (`models.realtime`) or a managed model | never: with neither, the [cascade](patterns.md#terms) runs, with a warning (`agent.voice.speech_to_speech_unconfigured`) | Yes, `agent` → `voice.engine`, and per tier `voice.engineByTier` |

An unknown value is refused too (`components.unknown_value`), and so is one pair of the bundle's own switches: `ZONE_REDUNDANT` on, set or through `HARDENED`, without `PRIVATE_NETWORKING` (`deployment.zones_need_network`), which `preprovision` alone checks since nothing stored can undo it. Only what the code or Microsoft's documentation says cannot work is refused; a combination the code falls back from on its own is a warning where it happens.

Not variables, because they are not a choice of component: whether the voice versions run on the account's own deployments or a managed model (`voice.managedModel`, which names a model, [decision 25](decisions.md)), and web search, which is the service's own tool with no resource of its own and no deploy-time variable: switch it off by removing `webSearch` from the `tools` document's `enabled_tools` ([`tools`](configuration.md#tools)).

**The variable is the starting value.** The job's `settings` step writes a component's variable into its field when it seeds a document that is absent. Once a document is stored it is the operator's, so components stay editable later: a deploy never overwrites a stored field, and when one differs from its variable the step logs `[settings] settings.component_differs: …`, naming both, and the backend runs the stored value. To make a changed variable take effect on an existing deployment, edit the field in App Configuration as well. The variables also reach the backend, whose compiled-in default for a field is the variable's value, so a replica that cannot read App Configuration runs the deploy's choice.

**Where a combination is refused, and why there.** The rules are one table in code (`apps/backend/src/components.ts`); the hooks carry the same rules and messages, and a test runs every rule through them.

1. **`preprovision`**, before anything is made, refuses the azd variables: an unknown value, or a pair the table refuses. It reads only variables, because on a hardened deployment App Configuration is private and a laptop or CI runner cannot reach it.
2. **The migrate job's `settings` step**, in `postdeploy`, inside the network, refuses the variables again (a deploy started without the hook, or by hand) and then the stored documents: an edit since the last deploy that cannot work here fails this deploy, with the same line in the error printed after `[settings] failed:`.
3. **The backend at run time** covers an edit made after the deploy: a stored `foundry` memory store on a private deployment is reported under `agent.memory.store_unreachable_private` and the own store runs; a stored knowledge base engine under access control answers with the hybrid search.

The refusal prints, word for word:

```text
agent.memory.store_unreachable_private: memory.store is foundry on a private deployment (PRIVATE_NETWORKING), where the Foundry memory store extraction calls the account from public Microsoft addresses and is refused 403; Microsoft documents that VNet integration is not supported for memory stores. Set MEMORY_STORE=own (azd env set MEMORY_STORE own), and memory.store to own in the app/agent document if it exists.
```

## Sign-in with Microsoft Entra ID

The demo's `local` sign-in takes a name and no password; every sign-in is a new person who cannot come back once the session ends. Use `entra` to keep anyone's history. Hardened always uses `entra`.

### What the hooks do

With `AUTH_MODE=entra` (or `HARDENED=true`), signed in to `az` as a person, and no client id in the environment (empty, or the vault's placeholder `unset`), `preprovision` makes the registration through `hooks/entra` as you, before the template runs:

1. **The registration** `<environment name>-sign-in`: single tenant, platform *Web*, redirect URI `<FRONTEND_URL>/api/auth/callback/microsoft-entra-id` once `FRONTEND_URL` exists. A registration of that name you already own is completed rather than duplicated; one somebody else owns is left alone and a new one is made.
2. **Three app roles**, member type *Users/Groups*: `user` ("May sign in"), `premium` ("The premium tier") and `tester` ("Tunes live voice for their own sessions"). With `AUTH_REQUIRE_ROLE` (always on hardened), a token with neither `user` nor `premium` is refused; `tester` shows Settings → Voice tuning ([configuration](configuration.md#who-tunes-voice)) and admits nobody on its own. A role a found registration lacks is added beside the ones it has.
3. **The groups claim**, as ids of the groups assigned to the application, for restricting documents to groups ([documents](documents.md#who-may-read-a-document)).
4. **Its service principal** (the enterprise application) and **a client secret**, with Entra's default expiry of one year. The id and the secret go into the azd environment as `AUTH_MICROSOFT_ENTRA_ID_ID` and `AUTH_MICROSOFT_ENTRA_ID_SECRET`, and the provision that follows writes them to Key Vault through the template, as it writes the session secret; the frontend reads them through references, at its next revision. The issuer is the deploying tenant's, derived by the template.
5. **Your roles**: you are assigned `user` and `tester`.

`postprovision` then adds the callback at the `FRONTEND_URL` the provision made to the registration's redirect URIs, when it is missing — on the registration named `<environment name>-sign-in` and no other.

Once the environment holds a client id, `preprovision` leaves the registration alone: an existing secret is never rotated, and a found registration gets a new secret appended beside its others. A second person provisioning the deployment from an environment of their own, which holds no client id, makes no second registration either. Where the vault already holds a client id and the registration of that name is somebody else's, `preprovision` makes nothing, names the registration it found, and says how to go on. A new registration would replace the first in Key Vault and lock out everyone assigned on it. Setting its client id with `azd env set AUTH_MICROSOFT_ENTRA_ID_ID <appId>` is enough: the vault keeps the secret it holds. A pipeline's identity never makes one; the pipeline carries the values `azd pipeline config` set ([CI/CD](#cicd)). Anything Microsoft Graph refuses — the deployer may not register applications, or az's selected subscription is in another tenant — is printed with the steps to do it by hand, and the deployment carries on without Entra sign-in until they are done. Where somebody else owns the tenant's registrations, `azd env set ENTRA_APP_SETUP false` stops the attempt ([configuration](configuration.md#deployment-parameters)), and the registration's owner hands you its two values.

To give anyone else access: *Enterprise applications* → `<environment name>-sign-in` → *Users and groups* → *Add user/group*: pick a user or group and the role `user` or `premium` (and `tester` beside one of them). Optionally switch *Assignment required* on under *Properties*, so the identity provider itself refuses anyone unassigned.

### By hand

For a registration made by somebody else, or when the hook was refused: register an application (Entra admin center → *App registrations* → *New registration*) as above — single tenant, *Web*, the redirect URI, the three app roles, *Token configuration* → *Add groups claim* → *Groups assigned to the application*, as group ids — create a client secret, and point the deployment at it. `FRONTEND_URL` is in `azd env get-values`; hardened, it is the Front Door address, not the frontend `Endpoint:` azd prints last ([a fresh hardened run](#a-fresh-hardened-run)). With the CLI, given an `approles.json` holding the three roles:

```sh
az ad app create --display-name my-agent --sign-in-audience AzureADMyOrg \
  --web-redirect-uris "$FRONTEND_URL/api/auth/callback/microsoft-entra-id" --app-roles @approles.json
az ad app update --id <appId> --set groupMembershipClaims=ApplicationGroup
az ad sp create --id <appId>
azd env set AUTH_MODE entra
azd env set AUTH_MICROSOFT_ENTRA_ID_ID <appId>
azd env set AUTH_MICROSOFT_ENTRA_ID_SECRET "$(az ad app credential reset --id <appId> --append --query password -o tsv)"
azd provision
```

Then assign roles as above.

Roles and groups are read from the token at sign-in, recorded on the person's account, and re-read from that record wherever something is spent. A change at the identity provider reaches a person at their next sign-in; a session ends eight hours after the sign-in that made it. Until the registration is set, Key Vault holds placeholders and an Entra sign-in fails; the deployment itself is unaffected. When you rotate the client secret, set it again and `azd provision`; the hook never does.

What each role grants is in [`platform/identity`](../platform/identity/README.md#granting-access).

## Regions and model quota

The template deploys four Azure OpenAI deployments, pinned in `infra/main.parameters.json`, and a fifth, `knowledge`, only with `KNOWLEDGE_BASE=true` ([the knowledge base's planning model](configuration.md#the-knowledge-bases-planning-model)):

| Deployment | Model, version | SKU | Capacity |
| --- | --- | --- | --- |
| `chat` | `gpt-5.6-luna` `2026-07-09` | GlobalStandard | 50 |
| `small` | `gpt-5-mini` `2025-08-07` | GlobalStandard | 50 |
| `embedding` | `text-embedding-3-large` `1` | Standard | 50 |
| `realtime` | `gpt-realtime-2.1` `2026-07-07` | GlobalStandard | `REALTIME_CAPACITY`, 1 unless set |

`realtime` is the voice's own: the Foundry voice agent (preview) answers a live session on it, speech to speech ([below](#speech-to-speech-voice)). Without it the voice agent reasons on the `chat` deployment as a cascade, and a spoken turn draws on the chat deployment's quota as a typed one does.

- **Region.** Sweden Central, the example region on this page, offers every one of these at its version and SKU, and Foundry voice agents in the project. In Europe only Sweden Central and France Central offer `gpt-realtime-2.1`; `preprovision` asks the region and refuses one that does not offer it at the parameter file's version and SKU, before anything is made. Check yours before deploying: `az cognitiveservices model list -l <region>` for the four, and that the region offers Foundry voice agents (preview) — a project that refuses them fails the job's `agent` step.
- **AI Search capacity** is per region and can run out (`InsufficientResourcesAvailable`). `azd env set AZURE_SEARCH_LOCATION <region>` places Search alone elsewhere, private endpoint included — for example North Europe beside Sweden Central ([decisions](decisions.md), decision 12).
- **Retirements.** Versions are pinned with auto-upgrade off. `infra/model-deprecations.json` records each version's announced retirement; `infra/model-deprecations.test.ts` fails the build 30 days before one unless an acknowledgement (at most 60 days) says somebody has a plan. Re-pin in both files.

### Speech-to-speech voice

A live session is answered by an Azure OpenAI realtime model hearing the person's audio itself: the `agent` document's `voice.engine` is `speechToSpeech` by default, on the `realtime` deployment above. The version's Azure voice speaks its answer, so the realtime deployment is metered for the audio it hears and the text it answers, and generates no audio of its own (its audio-output meter stays at zero; the speech is the voice agent's, metered as Voice Live audio output, on either engine). It answers sooner than the cascade, which transcribes the person before the model starts, and it costs more: realtime audio tokens are priced well above the chat model's text tokens ([configuration](configuration.md#the-realtime-deployment)). A tier the `voice` document gives an OpenAI voice (`live.openaiVoices`) is spoken in the model's own voice instead, with no fillers; the realtime deployment then generates and meters the audio itself ([configuration](configuration.md#voice)).

- **Another SKU or model.** `DataZoneStandard` keeps the audio in the EU data zone; `gpt-realtime-2.1-mini` and `gpt-realtime-mini` run the same way. Change `realtime` in `infra/main.parameters.json` and `azd provision`. Whatever the SKU, a [speech-to-speech](patterns.md#terms) session's instructions are held to 16,384 tokens. The backend counts the guardrails, the persona, the channel instructions ([the per-channel instructions](architecture.md#a-typed-turn) in `apps/backend/src/product/surface.ts`) and the person's part together. Over the limit, it leaves the person's blocks out whole: what is remembered first, who they are last, never the guardrails (`agent.voice.personalization_trimmed`). The shipped prompt fits whole with a persona as long as the console's lint allows and every block at its cap (`apps/backend/src/product/voice-budget.test.ts`). What reaches the limit is a persona past the lint's budget, or a raised `memory.maxChars` ([limitations](limitations.md)).
- **Capacity.** `REALTIME_CAPACITY` is one unless set, the least a deployment takes, and enough to try voice with one person. Under concurrent sessions a response that follows a tool's answer can fail at once with nothing said, and such failures cluster as sessions are added — observed behavior, not a published limit; the likeliest cause is the deployment's rate limit. The backend asks again (`voice.live.responseRetry`) and logs each as `voice.live.response_failed` with its type and code; retries cover a burst, not a deployment sized too small. Before more than a handful of people talk at once, raise `REALTIME_CAPACITY` to what the quota allows, and treat `voice.live.response_failed` lines carrying a rate-limit code, or `bound` `gave_up`, as the sign it is still short ([operations](operations.md)).
- **The cascade, by choice.** `azd env set VOICE_ENGINE cascade` before the deploy ([choose components at deploy time](#choose-components-at-deploy-time)); on an environment whose `agent` document exists, set `voice.engine` to `cascade` in App Configuration. Or set `voice.engineByTier.base` (or `.premium`) to keep one tier on it ([configuration](configuration.md#agent)). The next session of that tier makes its version; the next deploy makes it ahead of traffic. One model then answers typed and spoken turns, with no quota beyond the chat's.
- **No realtime deployment.** For a region that does not offer the model, or a subscription without its quota, take `realtime` out of `models` in `infra/main.parameters.json` before `azd up`. Every session then runs the cascade, and while the document names `speechToSpeech` the job's `agent` step and the backend's start report `agent.voice.speech_to_speech_unconfigured`; set the engine to `cascade` as well to make it the choice. Take the deployment out of an existing environment the same way, after the engine: a session of a tier still naming it falls back under the same code.

An environment whose `agent` document was stored before keeps the engine it names: the job writes a document only where none is. `voice.transcription` is `mai-transcribe` by default, documented beside both engines; `azure-speech` is documented only beside a cascade, so speech-to-speech's version transcribes with `mai-transcribe` in its place and the job and the backend say so under `agent.voice.transcriber_replaced`. What Agent on Azure assumes about realtime models in a voice agent — tools, fillers, the private endpoint, the capacity unit — is in [limitations](limitations.md).

## Replacing a replica: the drain

A backend replica going away (a new revision, a scale-in) gets SIGTERM and `terminationGracePeriodSeconds` (30 s) before it is killed. Then it drains:

1. It reports not ready at once, so no new request reaches it.
2. It tells each live voice session it holds to reopen. The app offers *Reopen*, and the new session's socket continues the same conversation on another replica.
3. It waits the `voice` document's `live.drainGraceMs` (10 s), then closes the sessions and writes what was said into their conversations within `live.settleWaitMs` (5 s).
4. After 20 s of the grace, spent on all of that and on the turns still streaming, it stops the host, which ends what is left, and closes its connections.

The two settings together stay at 15 s or less. Raising them further means raising the grace in `infra/modules/backend.bicep` and the drain's share of it in `apps/backend/src/shutdown.ts`. A replica killed without a drain loses its sessions' sockets, but nothing of what was said. A periodic sweep of the live-session records, running on another replica, notices the lapsed claim and writes each session into its conversation from the transcript kept in Redis.

A frontend replica going away closes the live sockets it was relaying. The backend sees each close as the person leaving and finishes the session, and the app says the channel closed.

## Using existing resources

The template creates every resource it uses; there are no parameters for pointing it at an existing Cosmos DB account, search service or Foundry account. To use one, replace that module's call in `infra/main.bicep` with an `existing` reference, keep the role assignments the backend and the migrate job need ([architecture](architecture.md#identities-and-roles)), and keep the outputs the apps' environments read. Every app setting that names a resource is an environment variable the template sets, so nothing in the code changes.

## CI/CD

Two workflows ship under `.github/workflows`.

- **`ci.yml`** runs on every pull request and push to `main`, with no Azure credential: lint, typecheck, the Bicep lint, every test with a real Redis and the Cosmos DB emulator, the end-to-end suite, both image builds, and fallow. See [testing](testing.md#ci).
- **`azure-dev.yml`** deploys when run by hand (`workflow_dispatch`): it signs in with a federated credential and runs `azd provision` then `azd deploy`. Runs queue; none is canceled halfway. It is manual because the sign-in needs the identity and the repository variables that `azd pipeline config` creates (below). Once that has been run, add `push: branches: [main]` under the workflow's `on` to deploy every push to `main`. Change the trigger `pipeline.test.ts` expects in the same commit, since the test holds the workflow to the manual trigger. A run provisions and then deploys on a fresh runner, whose environment holds no deployed image name: the provision keeps the image each app runs, and the run's deploy step rolls them to the new one. The pipeline's identity provisions; name the person or group who operates the deployment with `OPERATOR_PRINCIPAL_ID` and `OPERATOR_PRINCIPAL_TYPE`, or the data-plane roles and the jump VM's sign-in are the pipeline's own ([identities and roles](architecture.md#identities-and-roles)).

To connect the deploy workflow, once, from a machine signed in with `azd auth login`, in the environment to deploy:

```sh
azd pipeline config
```

`azd pipeline config` creates an identity for the pipeline (a user-assigned managed identity by default, or an app registration). It gives the identity federated credentials for the repository and assigns it Contributor and User Access Administrator on the subscription. It sets the repository variables `AZURE_CLIENT_ID`, `AZURE_TENANT_ID`, `AZURE_SUBSCRIPTION_ID`, `AZURE_ENV_NAME` and `AZURE_LOCATION`. It also sets every name in `azure.yaml`'s `pipeline.variables` that has a value as a variable, and every name in `pipeline.secrets` as a secret, so a run never regenerates the session secret. You need Owner (or User Access Administrator beside Contributor) on the subscription. Run it again after changing any value the pipeline should see. `pipeline.test.ts` fails when the workflow and the `pipeline` block disagree. `azd pipeline config --provider azdo` connects Azure Pipelines instead.

**Hardened from CI.** GitHub's hosted runners deploy hardened mode too: no self-hosted runner and no route into the network are needed, because every data-plane step runs in the migrate job.

## Developer access

Hardened, every data service is behind a private endpoint with its public listener off. Most of what you need from outside the network does not need a way in:

- **Nothing to set up**: the Azure portal, Log Analytics and Application Insights; `az containerapp logs show` for a replica's console; `az containerapp exec` for a shell inside a running container, which is inside the network; every deploy, whose data-plane work runs in the migrate job.
- **`./scripts/ingest.sh --open-listener`** for a library. The job half runs inside the network and needs nothing, but the upload half is your machine writing to Storage. So the script turns the account's public listener on and lets your machine's public address, and no other, through its firewall for the upload. It takes both back when the upload is over, or when the script exits, and says so loudly if the close fails ([documents](documents.md#load-a-library)).
- **For a person at `redis-cli`**, the switch below.

```sh
azd env set DEVELOPER_ACCESS true    # only with private networking (HARDENED or PRIVATE_NETWORKING)
azd provision
```

It adds what Azure's landing zones use for operator access: **Azure Bastion** (Basic) and a small Ubuntu VM (`Standard_D2as_v5`) in the virtual network, with no public IP and no password. You sign in to the VM with Microsoft Entra ID: the template installs the `AADSSHLoginForLinux` extension and grants the operator — whoever provisions, or the principal `OPERATOR_PRINCIPAL_ID` names — *Virtual Machine Administrator Login* on the VM (and a data access policy on Redis). The VM carries the Azure CLI, azd and `redis-cli`, and its welcome text prints the commands, with the token they need; the cache's host and port are `REDIS_HOST` and `REDIS_PORT` in `azd env get-values`. An operator that is a group signs in to the VM and gets no Redis policy, since the service admits no identity through a group. The private DNS zones are linked to the network, so every service resolves to its private address from there.

The VM's size is `DEVELOPER_VM_SIZE` (`azd env set DEVELOPER_VM_SIZE Standard_D2s_v5`); a provision that fails with `AllocationFailed` means the region is out of that size for now, so set another and provision again.

To connect: the Azure portal → the VM (`JUMP_HOST_NAME` in `azd env get-values`) → **Connect** → **Connect via Bastion** → protocol **SSH**, port 22 → authentication type **Microsoft Entra ID** → **Connect**. The SSH session opens in the browser, and that is all Bastion Basic offers. The portal lists **Microsoft Entra ID** only when every prerequisite holds, and names the one that fails:

- the extension `AADSSHLoginForLinux` (publisher `Microsoft.Azure.ActiveDirectory`) is on the VM with *Provisioning succeeded*. The portal's check needs this exact spelling: it fails for the Verified Module's lowercase type, `AADSSHLoginforLinux`, so the template declares `AADSSHLoginForLinux` itself;
- the VM has a system-assigned identity;
- you hold *Virtual Machine Administrator Login* or *Virtual Machine User Login* on the VM, plus Reader on the VM, its NIC and the Bastion host.

The template grants the login role to the operator alone (whoever provisions, or `OPERATOR_PRINCIPAL_ID`); anyone else needs it added: `az role assignment create --assignee <object id> --role "Virtual Machine Administrator Login" --scope <the VM's id>`. Read the extension back with `az vm extension show -g <rg> --vm-name <JUMP_HOST_NAME> -n AADSSHLoginForLinux --query "{type:typePropertiesType,state:provisioningState}"`: `AADSSHLoginForLinux`, `Succeeded`. A VM whose extension was installed with another spelling keeps it through every later provision, because Azure matches an existing extension's type without regard to case and keeps the first string. Correct it once by hand: `az vm extension delete` for that name, then `az vm extension set --publisher Microsoft.Azure.ActiveDirectory --name AADSSHLoginForLinux`, and read it back.

A desktop tool on your own machine, such as a database client or an editor extension that signs in with Entra ID, needs the Standard SKU's native-client tunneling instead: `az network bastion ssh -g <rg> -n <BASTION_NAME> --target-resource-id <the VM's id> --auth-type AAD -- -L <port>:<private host>:<port>`, then connect to `localhost:<port>` with TLS required. Standard costs more than Basic ([cost](cost.md#optional-extras)); the template stays on Basic.

For Redis on the VM, mint a token on your machine and paste it on the VM; the welcome text shows how:

```sh
az account get-access-token --resource https://redis.azure.com --query accessToken -o tsv   # Redis
```

It is billed while it exists, used or not; [cost](cost.md#optional-extras) itemizes the price. The Developer SKU of Bastion is free but cannot sign in with Entra ID, so it would need a key or a password on the VM. To take it away again, delete the VM and the Bastion host, then switch it off and provision, which removes their subnets:

```sh
az vm delete -g <rg> -n <JUMP_HOST_NAME> --yes
az network bastion delete -g <rg> -n <BASTION_NAME>
az network public-ip delete -g <rg> -n <BASTION_NAME>-pip
azd env set DEVELOPER_ACCESS false && azd provision
```

The alternatives, each a fit for a different team:

- a **point-to-site VPN gateway**, for people who work inside the network every day, with a DNS Private Resolver inbound endpoint so laptops resolve the private zones ([cost](cost.md#optional-extras) prices both);
- **opening one service's listener for the minutes it takes**, for a one-off administrative task.

`scripts/ingest` does this for Storage itself (`--open-listener`) and says so when it meets the closed listener; for App Configuration, Cosmos DB and Redis the commands are the service's own, and nothing here runs them.

## Clean up

```sh
azd down --purge
```

`predown` lifts the hardened locks first, then deletes the Agent Service's capability hosts in the order the service requires (each project's, then the account's). `--purge` permanently deletes soft-deleted Key Vault, App Configuration and Foundry resources so the environment's names can be reused. Hardened, Azure releases the `agent` subnet in the background after the capability host is gone, which can take about twenty minutes: if `azd down` stops on the virtual network, wait and run it again. A hardened vault has purge protection and cannot be purged: its name stays reserved for the soft-delete period (7 days), so redeploy under another environment name or wait. The Entra app registration outlives `azd down`, whether `preprovision` made it or you did, and is yours to delete (*App registrations* → `<environment name>-sign-in` → *Delete*). A later `azd up` of the same environment reuses it while the environment still holds its client id; `preprovision` makes a registration only while that id is empty, so after deleting one, clear both values first (`azd env set AUTH_MICROSOFT_ENTRA_ID_ID ""` and `azd env set AUTH_MICROSOFT_ENTRA_ID_SECRET ""`) or the next `azd up` keeps an id that names nothing and sign-in fails.

## Troubleshooting

| Symptom | Cause and fix |
| --- | --- |
| `InsufficientResourcesAvailable` on the search service, under azd's headline `A resource with this name already exists or is in a conflicting state` | The region has no AI Search capacity. The headline, which you read first, is misleading; the cause is at the very end of azd's output: `InsufficientResourcesAvailable: The region '<region>' is currently out of the resources required to provision new services.` `azd env set AZURE_SEARCH_LOCATION <another region>` and `azd up` again ([deploy](#deploy)). |
| A hardened provision fails at its end, after the better part of an hour, with `Conflict: That resource name isn't available.` under the same `A resource with this name already exists or is in a conflicting state` headline, and azd names no resource | A second hardened deployment in the tenant collides on the Front Door endpoint's host name ([after the table](#front-door-endpoint-name-conflict)). |
| `InsufficientQuota` on a model deployment | Not enough quota in the region. Lower that deployment's capacity — `azd env set REALTIME_CAPACITY <n>` for the realtime one, `capacity` in `infra/main.parameters.json` for the other three — request quota, or deploy in another region. The quota counts every deployment of the model in the region, this environment's own among them. |
| The Foundry account is `Failed`, naming `Microsoft.App` and `Microsoft.ContainerService` | The providers were not registered when the account was injected. `preprovision` registers them; if it could not (it needs the subscription-level register permission Contributor has), run `az provider register -n <namespace> --wait`, then provision again. |
| `409` "cannot create a new Capability Host … for the same ClientId" | The account already has a capability host made the other way: `PRIVATE_NETWORKING` changed on an existing environment. See [changing an existing environment](#changing-an-existing-environment). |
| The provision sits on `agent-service` for half an hour, hardened | Expected the first time: the capability host is made in the injected subnet, which takes 30–35 minutes. |
| `azd down` fails deleting the virtual network (`InUseSubnetCannotBeDeleted`) | The `agent` subnet is still held by the deleted capability host. Wait about twenty minutes and run `azd down --purge` again. |
| `InvalidCorrelationRequestId` when publishing a service (azd 1.20.x) | That azd sends a correlation id the registry refuses. Upgrade to azd 1.37.1 or later ([prerequisites](#prerequisites)). If you cannot, run with `AZURE_DEV_COLLECT_TELEMETRY=no`, which works around it on 1.20.3. |
| `AADSTS700082: The refresh token has expired due to inactivity` though `azd auth login --check-status` says you are signed in | A login idle for 90 days. Run `azd auth login` again, or `azd config set auth.useAzCliAuth true` to use the `az` login. |
| `azd provision --preview` asks for or panics on `authSecret` in a new environment | Preview runs no hooks, so the secrets do not exist yet. Run `azd hooks run preprovision` first. |
| A new revision stays `Activating` after `azd provision`, then `Degraded` with "provisioning timed out after progression deadline", its replica scheduled and never started | Occasional, with the previous revision still serving. `az containerapp revision restart -g <group> -n <app> --revision <revision>` starts it. |
| `postdeploy` fails with the job's log | One of the job's steps failed; the log names it (`[settings]`, `[index]`, `[skills]`, `[agent]`, `[library]`). Fix and run `azd deploy` again, or start the job by hand. |
| The job's `[agent]` step fails with `403` | The job's Foundry User assignment on the project has not applied yet, minutes after a first provision. Run `azd deploy` again. |
| The backend logs "Cosmos DB does not admit this identity yet" and is not ready | Expected on a first deploy while the role assignment applies. If it persists, check the backend identity's Built-in Data Contributor assignment on the `app` database. |
| The backend logs "the search index does not exist yet" | Expected until the job's `index` step has made it. |
| A turn fails and the backend logs a `404` from the Foundry project | The project or its capability host is not ready, or `FOUNDRY_PROJECT_ENDPOINT` names another project. Check the project in the portal; the provision prints its endpoint as `FOUNDRY_PROJECT_ENDPOINT`. |
| Entra sign-in fails right after switching `AUTH_MODE` | The registration values are not set (Key Vault holds `unset`), the redirect URI does not match `FRONTEND_URL`, or the person holds no role while one is required. |
| Right after a hardened `azd up`, `FRONTEND_URL` answers a plain HTML "Page not found" 404 on every path, `/health` included | Front Door's endpoint is propagating: about twenty minutes after creation, edge node by edge node. Wait. The app's own 404 is JSON, and the WAF's refusal is the 403 below. |
| Front Door answers `403` "The request is blocked" | The WAF refused it. Query `AzureDiagnostics` for `Category == "FrontDoorWebApplicationFirewallLog"` and `action_s == "Block"` to see the rule. Policy changes take a few minutes to reach every edge node. |
| `scripts/ingest.sh` stops saying Storage's public listener is off | Private networking is on. Run it again with `--open-listener`, which turns the listener on and lets your address through the firewall for the upload and takes both back after, or run it from inside the network; the refusal prints both ([documents](documents.md#load-a-library)). |
| `azd down` fails on a lock | `predown` did not run (or was interrupted): `az lock list -g <rg>` and `az lock delete --ids <id>`. |
| A new environment fails on the Key Vault name | A purge-protected vault of the same name is soft-deleted. Use another environment name, or wait 7 days. |
| `bun test` fails in `infra/model-deprecations.test.ts` on a model retirement | A pinned version is within 30 days of retirement. Re-pin it in `main.parameters.json` and `model-deprecations.json`. |

The PowerShell versions of the hooks and scripts mirror the bash ones step for step. The tests run each scenario through both the shell and the PowerShell version, the latter under `pwsh` on Linux ([testing](testing.md#layers)). No test covers Windows itself, where paths and the native programs a PowerShell version calls (`curl`, `ssh-keygen`) are the system's own.

### Front Door endpoint name conflict

`az deployment operation group list -g <rg> -n front-door` names the resource: `Microsoft.Cdn/profiles/afdEndpoints`, the Front Door endpoint `frontend`. Azure's default label scope, `TenantReuse`, gives the same endpoint name in the same tenant the same `frontend-<label>.z01.azurefd.net` host. So while one hardened deployment holds it, no second one in that tenant can provision. The template sets `autoGeneratedDomainNameLabelScope: ResourceGroupReuse` on the endpoint, one host per resource group. A deployment provisioned from an earlier version of the template keeps its host, and a second one beside it needs the current version.
