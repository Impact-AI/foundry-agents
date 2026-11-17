# Is it a fit?

**Choose Agent on Azure when you need a custom Azure-hosted assistant with voice, document retrieval and business-system views, and your team can take responsibility for its implementation and operations, subject to the applicable licenses.** It provides an application foundation; your team implements customer integrations, authorization mappings, domain behaviour and production acceptance.

| Decision | When it applies |
| --- | --- |
| Good fit | A signed-in assistant on Azure, with a custom visual workspace and a team that can develop and operate it. |
| Substantial extra work | A different agent runtime, external or anonymous audiences, unattended automation, end-user uploads, or strict residency requirements beyond the selected services. |
| Choose another starting point | Hosting outside Azure, or a finished managed product when your team does not intend to maintain application code. |

The sections below explain the reusable components, three customer use cases, delivery responsibilities, production conditions and running costs. Detailed implementation choices are in [adapting](adapting.md).

## What would your team build?

**Your customer's application on an assembled foundation: the business logic, integrations and UX, without rebuilding sign-in, agent integration, deployment and telemetry.**

| Starting point | Already provided | Your team builds |
| --- | --- | --- |
| Ready-made agent | A finished product for a defined job, maintained by its vendor | Configuration and integrations within the product's supported options; product changes are requested from the vendor |
| Copilot Studio | Managed agent execution, visual authoring, channels and connectors | Instructions, knowledge, workflows and actions, plus custom connectors or code where needed; the application stays built around Copilot Studio |
| Agent on Azure | Source for a working application: agent patterns, interface, identity, deployment and telemetry ([patterns](patterns.md#the-assembled-patterns)) | Business logic, domain tools, integrations and UX; adapting or replacing supplied components; deploying and maintaining it |
| Build from scratch | The models, frameworks and cloud services you select | The application and its foundation (interface, agent integration, identity, deployment, telemetry, tests); maintaining the architecture |

## Does your use case fit?

**It fits an assistant on Azure that people sign in to with Microsoft Entra ID and then type or speak to, answering from their documents and business systems.**

### Where it fits

Agent on Azure is an assistant that people sign in to and then type or speak to. It answers from the documents they are allowed to read, looks things up in business systems on the person's behalf, passing on who is asking, so the business system can apply that person's permissions (the backend calls as itself) (the sample records are open to everyone), and shows what it finds on the **stage**, the visual workspace beside the conversation. It suits projects where people need answers from their documents and business systems, by text or voice, with the results in front of them. Three examples:

#### Field service and operations

A technician on site asks, hands-free, how to reset a unit. The assistant answers from the manuals and procedures that technician may read, puts the asset's record on the stage, and opens the procedure in the reader so the steps stay in view.

- **Reused:** live voice, retrieval with the per-document access filter, on by default for a fresh hardened deployment (check the access setting on an existing one; [permission-aware retrieval](patterns.md#permission-aware-retrieval)), the reader and its source chips, the record panel ([conversation-driven UI](patterns.md#conversation-driven-ui)).
- **The team builds:** the adapter to the asset or maintenance system ([the worked example](worked-example.md) is the pattern), the manuals loaded with their readers, and any panel the asset data needs beyond the record card.

#### Internal service desk

Staff ask about HR, IT or finance policies in their own words and their own language. Retrieval can be restricted to policies their Entra groups may read, with source documents they can open, and a customer integration can look up the status of a case or ticket. For a policy-only assistant, disable web search, configure the persona to answer from the approved material and decline unsupported questions, then test grounded answers and refusals. Disabling web search alone does not enforce policy-only answers.

- **Reused:** permission-aware retrieval, on by default for a fresh hardened deployment (check the access setting on an existing one), and the source chips ([a library](documents.md#a-library)), Entra sign-in, five interface languages with locale-aware voice configuration ([a language](extending.md#a-language)), tools that run as the verified caller.
- **The team builds:** the policy library with its reader lists mapped to the customer's groups ([who may read a document](documents.md#who-may-read-a-document)), the ticketing adapter, the persona and the guardrail wording.

#### Account and project briefing

A manager asks how a project or a customer account is going. The assistant charts its figures by quarter, shows the people working on it, and opens the latest brief. This is what the sample data demonstrates, so it can be shown to a customer on the day Agent on Azure is deployed.

- **Reused:** the stage's chart, record and list panels, the records tools, document retrieval, and the connection to a business system. That connection reads long lists page by page, gives up on a slow system in time, and says when a list is too long to show in full.
- **The team builds:** the translation from the customer's CRM or ERP records to the ones the assistant shows, often a small service in front of that system ([mapping a real system](worked-example.md#mapping-a-real-system)), and the documents behind the briefings.

All three are for people the customer signs in through Microsoft Entra ID; hardened mode requires Entra sign-in and an app role ([demo and hardened](deployment.md#demo-and-hardened)). What Agent on Azure is not built for is listed next.

### What needs extra work

**Hosting outside Azure is a poor fit.** Only the agent sits behind an interface (the agent host, with its [parity suite](patterns.md#terms)). Search, ingestion, documents, conversations, settings and identity use Azure AI Search, Blob Storage, Cosmos DB, App Configuration and Microsoft Entra ID directly, and the infrastructure is Bicep for Azure. Moving to another cloud means rewriting the infrastructure and replacing most of the platform packages ([flexible and Azure-specific choices](adapting.md#flexible-and-azure-specific-choices)), so choose another starting point.

Other requirements go beyond what Agent on Azure ships but can be built on top of it. The table says what stands in the way and what adding each takes.

| Requirement | What stands in the way | What it takes |
| --- | --- | --- |
| A different agent framework or runtime, such as Mastra | The agent runs on Foundry Agent Service behind the agent host interface, which is designed to be replaced. Its contract is broad: turns with tool calls, conversation history, memory, erasure and live voice, with web search and skills supplied by Foundry. | A new agent host implementation that passes the parity suite, including a live-voice binding and its own web search and memory: a substantial project, not a setting. The browser side changes little ([a second agent host](extending.md#a-second-agent-host), [where the agent plugs in](architecture.md#the-agent-integration-point)). |
| Back-office automation with no person in the loop | Every turn runs for a signed-in person, tools act in that person's scope, and a turn is bounded by a step limit. | A separate entry point, such as a scheduled job, that calls the same business tools under a service identity with its own authorization, and shows its results to people through the stage or the library ([a typed turn](architecture.md#a-typed-turn), [the agent settings](configuration.md#agent)). |
| Public or anonymous users | Hardened mode signs in with Microsoft Entra ID and requires an app role; demo sign-in is never for real data. | Add an identity provider to the frontend's sign-in (for example Microsoft Entra External ID for customers, or another OpenID Connect provider), map its users to accounts and roles, and set usage limits and Front Door WAF rate limits for open traffic ([sign-in](security.md#sign-in), [usage limits](configuration.md#limits)). |
| Strict data residency for every part of a conversation | The default model deployments may process in any Azure region, the realtime model is offered in few regions, Voice Live's speech has processing scopes of its own, and web search sends its terms to Bing. | Assess every processing path: the model deployments, transcription, synthesis, filler responses, telemetry and optional integrations. Select services and regions that meet the required boundary and disable paths that do not. Cascade still uses speech services with their own processing scopes, and an EU data zone does not establish single-country residency. Disabling web search removes the Bing path but does not settle the other paths ([choose components at deploy time](deployment.md#choose-components-at-deploy-time), [the realtime deployment](configuration.md#the-realtime-deployment), [where voice is processed](limitations.md#where-voice-is-processed), [what reaches the model](privacy.md#what-reaches-the-model)). |
| End users uploading files, or reading rendered PDF pages | In this repository, documents enter only through the ingest script, and the reader shows the text the indexer extracted. | An upload endpoint that writes to the library's Blob container with reader metadata and runs the same load. (Impact AI Admin Center lets operators upload documents from a form; it does not add end-user upload.) For rendered pages, a stage panel that shows the stored file ([load a library](documents.md#load-a-library), [a stage tool](extending.md#a-stage-tool), [Admin Center](impact-ai.md#impact-ai-admin-center)). |
| A demo-mode pilot with more than about 100 sign-ins | Demo mode keeps memory in the Foundry memory store, which holds memories for at most 100 accounts. Every demo sign-in is a new account, so the store is full after about 100 sign-ins, however few people made them. | Choose the app's own memory store before deploying, which has no such limit. With the Foundry store, Entra sign-in lets up to 100 people come back to the same account ([memory](limitations.md#memory), [choose components at deploy time](deployment.md#choose-components-at-deploy-time)). |

### Known limits

Beyond the requirements above, a few limits come from the Azure services themselves and are worth knowing before promising a behavior to a customer:

- **Live voice has fewer choices than text.** There is one multilingual voice per tier, with its accent set by language, and a [speech-to-speech](patterns.md#terms) model may not support every feature the cascade engine does.
- **Speech can be processed outside the deployment's region.** Voice Live's speech recognition and synthesis have processing scopes of their own, independent of where the models run.
- **Azure AI Search capacity varies by region.** Some regions refuse new search services, so the search service may need a second region.
- **Some behavior is observed, not published.** Where a limit is known only from how a service behaved, it is marked as such; verify it on the customer's deployment before relying on it.

[Limitations](limitations.md) lists every known limit by area, with the evidence and what Agent on Azure does about each.

## Can your team deliver it?

**The team needs TypeScript integration skills, React/Next.js for the interface, Entra authorization and Azure deployment/operations experience, plus capacity for testing and ongoing maintenance.** The scope depends on the customer's integrations and changes; the stack table below lists the technologies involved.

### Work still required

Agent on Azure leaves these to your team. Each is described once, on the page linked here.

- **Business integration.** The tools that reach the customer's systems, with their mapping, paging and failure handling. The connection is not delegated access: the backend calls as itself and passes on who is asking, so each system's API must check the backend and enforce that person's access ([the worked example](worked-example.md#what-changes-and-what-does-not), [a server-side tool](extending.md#a-server-side-tool)).
- **Authorization mapping.** Who may read each document ([who may read a document](documents.md#who-may-read-a-document)), the app roles ([sign-in with Microsoft Entra ID](deployment.md#sign-in-with-microsoft-entra-id)), and what each business system lets the caller see.
- **Domain behavior.** The persona, the guardrail wording, skills and the enabled tools ([what you change, and what it costs](adapting.md#what-you-change-and-what-it-costs)).
- **Custom views and languages.** Stage panels and message catalogs beyond the shipped ones ([built in, and yours to build](adapting.md#built-in-and-yours-to-build)).
- **Capacity for the expected load.** How many people can talk to it at once depends on capacity. Live voice runs on the realtime deployment, whose capacity (one unit by default, enough to try it) comes from the subscription's model quota in the region, as the typed models' does ([the realtime deployment](configuration.md#the-realtime-deployment), [regions and model quota](deployment.md#regions-and-model-quota)). Request the quota, set the capacity, and load-test at the expected peak before launch.
- **Alerts.** The template creates no alert rules. Set them up on the signals [monitoring](operations.md#monitoring) names, and decide who is paged.
- **Acceptance.** Scenarios rewritten in the customer's terms and run on a live deployment ([acceptance](acceptance.md)), plus the customer's own security and privacy review ([security: known gaps](security.md#known-gaps), [privacy: known gaps](privacy.md#known-gaps)).

### Stack and skills

Agent on Azure is one TypeScript code base, deployed to Azure by the Azure Developer CLI. A team that adopts it works in these:

| Layer | What it is built on | What the team needs to know |
| --- | --- | --- |
| Language and runtime | TypeScript 5 on Bun 1.4, in Bun workspaces, with one pinned Bun version | Modern TypeScript and Bun's test runner, package manager and APIs |
| Backend | Hono 4 on Bun, with Zod for every input | HTTP APIs, streaming, async error handling |
| Frontend | Next.js 16 and React 19, Auth.js for sign-in, CopilotKit over the [AG-UI](patterns.md#terms) protocol; its image runs on Node.js | React and the Next.js App Router |
| Agent and voice | Foundry Agent Service through the Azure AI Projects and OpenAI SDKs, and Foundry voice agents over Voice Live | Prompting, function tools, and the Foundry portal |
| Infrastructure | Bicep with Azure Verified Modules, deployed by the Azure Developer CLI, with bash and PowerShell hooks | Bicep, azd, Entra ID, Azure networking and RBAC |
| Azure services | Container Apps, Azure OpenAI, AI Search, Cosmos DB, Managed Redis, App Configuration, Blob Storage, Key Vault, Azure Monitor, Front Door | Running and paying for each, as [architecture](architecture.md) and [cost](cost.md) describe |
| Tests and checks | Bun's test runner, Playwright with axe, Biome | Writing tests the [testing guide](testing.md) holds to |

The exact versions are pinned in the repository's lockfile, which every build installs from. A team without Azure networking or Entra experience can still run demo mode; hardened mode is where those skills are needed.

## Can the customer run it in production?

**It can form the basis of a production application after deployment-specific acceptance, security/privacy review, capacity testing and support arrangements.** Hardened mode is a configuration, not production acceptance. Typed chat and default hybrid retrieval use generally available services; live voice uses a preview Foundry voice agent by default. An alternative runtime uses the Voice Live API, with different capabilities and processing scopes ([voice runtimes](configuration.md#voice-runtimes)). Review the selected features and service terms; changing one runtime does not establish that every selected feature is generally available.

### Preview dependencies

A production commitment on Agent on Azure rests in part on services Microsoft marks preview. Preview services come under Microsoft's preview terms, and their behavior can change before general availability ([security: known gaps](security.md#known-gaps)). For each: what is preview, whether the default deployment uses it, and how to do without it.

- **Foundry voice agents.** Live voice runs on a Foundry voice agent by default, in both modes: Microsoft's recommended way to join Agent Service and Voice Live, and in preview ([Microsoft Learn](https://learn.microsoft.com/en-us/azure/foundry/agents/how-to/migrate-from-voice-live)). A customer that cannot accept preview terms can run live voice on the generally available Voice Live API instead, with the same prompt, tools and voices, giving up the deployment's own content filter, the accent per language and a reasoning effort ([voice runtimes](configuration.md#voice-runtimes)). The application includes that runtime, but a production acceptance record must identify the tested commit, environment, spoken tasks, tool and stage results, and who checked them. Run those tasks in the selected mode; an implementation description or a session-opening check is not evidence of spoken-task success. In hardened mode it runs on a data-zone model Voice Live hosts; speech recognition and synthesis keep processing scopes of their own ([where voice is processed](limitations.md#where-voice-is-processed)). Typed chat uses no voice service.
- **The Foundry memory store.** In preview ([Microsoft Learn](https://learn.microsoft.com/en-us/azure/foundry/agents/concepts/what-is-memory)). Demo mode uses it by default. Public deployments can choose either store; the supplied private configuration uses the application's own store because Foundry memory stores do not support VNet integration ([choose components at deploy time](deployment.md#choose-components-at-deploy-time)).
- **Foundry skills.** In preview ([Microsoft Learn](https://learn.microsoft.com/en-us/azure/foundry/agents/how-to/tools/skills)). Agent on Azure ships none, so they are used only if a team adds one; without them, the same method can go into the persona ([a skill](extending.md#a-skill)).
- **Foundry IQ knowledge bases.** Their planning and multi-turn retrieval are in preview ([Microsoft Learn](https://learn.microsoft.com/en-us/azure/search/agentic-retrieval-overview)). They are off by default in both modes, which use generally available hybrid search; a knowledge base is an optional retrieval engine ([retrieval through a knowledge base](documents.md#retrieval-through-a-knowledge-base)).

After an upgrade of any of these, check them on a deployment ([what only a deployment proves](testing.md#what-only-a-deployment-proves)).

### Who supports what

| Part | Terms | Who stands behind it |
| --- | --- | --- |
| Agent on Azure's code and documentation | The [MIT License](../LICENSE), copyright Microsoft Corporation, provided "as is", without warranty; the Impact SDK setup plugin is Apache-2.0 instead | Impact AI creates and maintains it in the open, without a service level ([support](../SUPPORT.md)). Bugs and questions go to the repository's issues. A team that adopts it controls and maintains its fork, subject to the applicable licenses. |
| The Azure services it deploys | The customer's agreement with Microsoft | Microsoft, under that agreement, including preview terms for the preview services above. Problems with an Azure service go to an Azure support request. |
| Implementation, support and optional products | A separate contract with Impact AI | Impact AI, for the scope and any service levels agreed in that paid contract. Impact AI offers maintenance of an adapted application: fixing application bugs, applying dependency and security updates, upgrading to new versions of Agent on Azure, and changing customer-specific code; the contract sets which of these apply. Impact AI Admin Center and Impact AI Control Plane are optional, with their own terms ([optional products](impact-ai.md#optional-products-and-integrations)). |

- **Versions.** There are no tagged releases. A team forks or copies the repository, tracks the main branch, and merges upstream changes when it chooses ([taking upstream fixes](adapting.md#taking-upstream-fixes)).
- **Security.** The [security policy](../SECURITY.md) asks for vulnerabilities through the repository's private vulnerability reporting, never a public issue. Maintainers assess and respond on a best-effort basis, with no guaranteed response, fix or delivery date. Support for a deployed or customized application requires a separate paid contract.

## What does it cost to run?

**The always-on services are most of the bill, and usage comes on top.**

| Configuration | About, a month |
| --- | --- |
| Demo mode, apps idle, before usage | $160 |
| Hardened mode, apps idle, before usage | $1,120–1,190 |
| Hardened mode, 200 people with 200 typed turns and 10 voice minutes each ([worked example](cost.md#a-worked-example)) | $1,490–1,580 |

Those are list prices for Sweden Central. The worked example's tokens per turn and per voice minute are assumptions to replace with your own, and usage grows linearly with people, turns and voice minutes; [usage limits](configuration.md#limits) bound what each account can spend. Implementation and support are priced separately.

[Cost](cost.md) has the price of each service, the optional extras, the usage formula and [what the estimate leaves out](cost.md#what-the-estimate-leaves-out).
