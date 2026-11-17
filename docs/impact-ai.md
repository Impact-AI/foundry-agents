# Impact AI add-ons

Agent on Azure runs on its own in your Azure environment, and nothing on this page is required to build, deploy or run it. Impact AI, which creates and maintains Agent on Azure, offers two separately licensed products on top: Impact AI Admin Center, to change supported behavior without editing code, and Impact AI Control Plane, to test, monitor and improve the application. This page covers both, where your data goes when you connect one, and the [license boundaries](#license-boundaries).

## Optional products and integrations

The application does not need an Impact AI account, SDK or product. Each product is a separate choice:

| Option | Purpose | Status |
| --- | --- | --- |
| [Impact AI Admin Center](#impact-ai-admin-center) | Make maintaining the application easier: prompts, guardrail wording, tool switches, documents and supported runtime settings through forms instead of code | A separate product; connection scope and supported controls must be agreed and verified for the customer deployment |
| [Impact AI Control Plane](#impact-ai-control-plane) | Test, monitor and improve the application: evaluations, traces and comparisons | Its SDK setup plugin for Codex (pre-release) ships in this repository; evaluations and comparisons are not yet available for Agent on Azure |

For either, [contact Impact AI](https://www.impact.ai/).

## Impact AI Admin Center

Impact AI Admin Center is a separate product, not included in this repository and not needed to use it. It gives application and business teams forms for changing supported prompts, guardrail wording, tool switches, documents and runtime settings without editing code. Developers still implement new capabilities and integrations.

### What teams can do from it

The controls offered for a customer application depend on the integration agreed with Impact AI. Confirm and demonstrate each supported control on that application before including it in the delivery scope. The existence of this repository's settings and extension points does not establish Admin Center compatibility.

Runtime configuration is distinct from changing the application: a supported setting can take effect after a refresh, a voice change may apply to the next session, and a new model deployment or capability may require a deployment. The application-specific timing and restart requirements are in [adapting](adapting.md#what-can-change-easily).

### Without Admin Center

The application runs fully without it:

- Load documents and their reader mappings through the [ingest script](documents.md#load-a-library).
- Publish and activate persona versions through the [persona CLI](operations.md#changing-the-persona).
- Edit guardrail wording, tool switches and supported runtime settings in App Configuration ([tuning while it runs](operations.md#tuning-while-it-runs)).
- Configure branding through the [appearance settings](configuration.md#appearance), uploading a logo before naming it in the settings.

### Getting it

[Contact Impact AI](https://www.impact.ai/) to agree the customer application's controls and integration scope. Before activation, agree the required access, data flows, retention, operator responsibilities and disconnection procedure. No particular connector topology or installation procedure is established by this repository.

Admin Center has separate terms. Support for an adapted customer application, including integration work and maintenance, requires a separate paid contract. Repository maintenance remains best effort ([support](../SUPPORT.md)).

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
