# Impact AI add-ons

Agent on Azure runs on its own in your Azure environment, and nothing on this page is required to build, deploy or run it. Impact AI, which creates and maintains Agent on Azure, offers two separately licensed products on top: Impact AI Admin Center, to change supported behavior without editing code, and Impact AI Control Plane, to test, monitor and improve the application. This page covers both, where your data goes when you connect one, and the [license boundaries](#license-boundaries).

## Optional products and integrations

The application does not need an Impact AI account, SDK or product. Each product is a separate choice:

| Option | Purpose | Status |
| --- | --- | --- |
| [Impact AI Admin Center](#impact-ai-admin-center) | Make maintaining the application easier: prompts, guardrail wording, tool switches, documents and supported runtime settings through forms instead of code | A separate product, not included in this repository and not needed to use it; Impact AI connects it to your deployment |
| [Impact AI Control Plane](#impact-ai-control-plane) | Test, monitor and improve the application: evaluations, traces and comparisons | Its SDK setup plugin for Codex (pre-release) ships in this repository; evaluations and comparisons are not yet available for Agent on Azure |

For either, [contact Impact AI](https://www.impact.ai/).

## Impact AI Admin Center

Impact AI Admin Center is a separate product, not included in this repository and not needed to use it. It makes maintaining agent-based applications easier: teams change prompts, guardrail wording, tool switches, documents and supported settings through forms instead of code. Developers still build new capabilities and integrations in code. Which controls are available depends on what Impact AI connects for your deployment, and the descriptions below are Impact AI's.

In this repository, a document enters a library only through the [ingest script](documents.md#load-a-library). Admin Center makes ingestion easier: a team uploads documents from a form, and they go through the same pipeline the script feeds. It adds no second way for end users to upload files.

### What teams can do from it

Impact AI describes Admin Center's controls as follows.

- **Keep the library current.** Upload documents into the ingestion pipeline, set who may read each one, and preview what a search finds.
- **Change how the assistant behaves.** Edit and publish persona versions and roll back to an earlier one, adjust the guardrail wording, and switch existing tools on or off.
- **Tune supported runtime settings.** The chat model's reasoning effort, the voices, usage limits and retrieval settings. These take effect on a running deployment within about 30 seconds, and voice changes apply to the next session. Choosing another memory store needs a backend restart, and changing a model deployment needs a deployment ([what can change easily](adapting.md#what-can-change-easily)).
- **Set the branding.** A form over the [branding settings](configuration.md#appearance): the palette, the type, spacing, corners, the assistant's name and welcome line in each language, and the logo. The form writes the settings document and uploads the logo in one step.
- **Manage operators and accounts.** Roles for each operator, account deactivation, and backup and restore.

Skills are code in Agent on Azure ([what you change, and what it costs](adapting.md#what-you-change-and-what-it-costs)), so Admin Center does not edit them.

### Without Admin Center

The application runs fully without it. These changes have an equivalent in this repository:

- Documents and who may read them, through the [ingest script](documents.md#load-a-library).
- Persona versions, through the [persona CLI](operations.md#changing-the-persona).
- Guardrail wording, tool switches and runtime settings, by editing the settings documents in App Configuration ([tuning while it runs](operations.md#tuning-while-it-runs)).
- Branding, in two steps by hand: for a logo, upload the image to the deployment's storage account first, then edit the branding settings in App Configuration to name it ([branding settings](configuration.md#appearance), [the logo](configuration.md#the-logo)).

Search preview, operator roles and account deactivation have no equivalent tool here. Backup and restore rely on the Azure services' own features, described in [backups and recovery](operations.md#backups-and-recovery).

### Getting it

Admin Center is not part of this repository and is not covered by its MIT License. Impact AI connects it to your deployment; [contact Impact AI](https://www.impact.ai/) to discuss it.

How Impact AI's connector works, as Impact AI describes it, for your security review:

- **What is installed.** Impact AI's connector is installed in your own Azure resource group, with roles limited to the resources it manages there. It makes outgoing connections only; nothing in your network is opened to Impact AI.
- **What it reads and writes.** The connector reads and writes the settings, documents, prompts and branding that Admin Center's controls change, in your deployment's own stores. Which data is shared with Impact AI, and for how long, is agreed before it is switched on.
- **Disconnecting.** Remove the connector and its role assignments. The application keeps running, with the settings Admin Center last wrote, and you manage them as before through App Configuration and the ingestion scripts.

## Impact AI Control Plane

**Status:** Impact AI Control Plane's SDK setup plugin for Codex (pre-release) ships in this repository; evaluations and comparisons are not yet available for Agent on Azure.

The plugin works in Codex, OpenAI's coding agent. It checks your application's stack, helps instrument supported model and tool calls, and guides you to a first trace, keeping the existing telemetry and privacy controls ([the plugin](../plugins/impact-sdk-setup/README.md), [Impact quickstart](https://docs.impact.ai/quickstart)). Choose what content to capture before sending traffic, and keep the ingest key in the application's secret configuration. Capture of Agent on Azure's own typed turns on Foundry and of its live voice is not yet verified. For the rest of the Control Plane, [contact Impact AI](https://www.impact.ai/).

Impact AI Control Plane is a product for testing, monitoring and improving an application: running its scenarios as evaluations, investigating a failure from its captured tool calls, settings and traces, comparing results, and checking that a correction fixed it. Beyond the setup plugin, nothing for it ships in this repository, and nothing is sent to Impact AI unless an integration is installed and switched on. The application works without it.

For evaluation today, use the included checks and Microsoft's tooling on [evaluation](evaluation.md), or an integration of your own.

## Where your data goes

Agent on Azure keeps its data in your Azure subscription. Conversations are in your Cosmos DB, documents in your Blob Storage and Azure AI Search index, and settings in your App Configuration. The application's telemetry is built to carry codes, counts and timings rather than conversation text. Error text from a library or service is logged as thrown and may quote content, and agent tracing, which is opt-in, records turns in full ([privacy](privacy.md#what-is-stored)).

The two Impact AI products differ in what they send:

- **Impact AI Admin Center.** The data it receives and how long it is kept are agreed with Impact AI before it is switched on.
- **The Impact SDK setup plugin.** It is self-serve: once installed and switched on, the instrumented application sends traces to Impact AI's endpoint, outside your subscription. By default those traces hold inputs, outputs and tool results, which can hold personal data. Choose what to capture before sending traffic. Deleting a conversation or erasing an account in Agent on Azure does not reach those traces. Update your privacy notice before you switch it on.

Web search, which is on by default and can be switched off in the [tools settings](configuration.md#tools), sends search terms to Bing, outside the Azure compliance boundary. [Privacy](privacy.md) has the full account, including where voice is processed.

## License boundaries

Except the Impact SDK setup plugin, which is Apache-2.0 licensed ([its license](../plugins/impact-sdk-setup/LICENSE)), the code and documentation in this repository are [MIT licensed](../LICENSE), copyright Microsoft Corporation. Impact AI's attribution as creator and maintainer does not change that ownership.

Impact AI Admin Center, Impact AI Control Plane and Impact AI's commercial services are governed by their own Impact AI terms. No proprietary code of either product is in this repository, and a link to a commercial product grants no license to it.

## Extension points an integration uses

| Extension point | What Agent on Azure provides |
| --- | --- |
| Product behavior | The product definition, server tools and browser controls ([extending](extending.md)) |
| Runtime configuration | Validated settings in App Configuration and versioned persona text in Cosmos DB ([tuning while it runs](operations.md#tuning-while-it-runs)) |
| Telemetry | OpenTelemetry to Application Insights, plus structured usage and problem events ([monitoring](operations.md#monitoring)) |
| Acceptance | Scenarios and deployment checks teams can adapt ([acceptance](acceptance.md)) |

An external product connects through these points with an adapter of its own; their presence does not mean one is already connected.
