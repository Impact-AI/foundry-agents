# Impact AI add-ons

Agent on Azure runs on its own in your Azure environment, and nothing on this page is required to build, deploy or run it. Impact AI, which creates and maintains Agent on Azure, offers two separately licensed products on top: Impact AI Admin Center, to manage and version the application's prompts, tools and settings from one place, and Impact AI Control Plane, to test, monitor and improve the application. This page covers both, where your data goes when you connect one, and the [license boundaries](#license-boundaries).

## Optional products and integrations

| Option | Purpose | Status |
| --- | --- | --- |
| [Impact AI Admin Center](#impact-ai-admin-center) | Manage prompts, tools, skills, documents and settings from one place, versioned and live without a redeploy | Separately licensed; the controls it covers are agreed for each application |
| [Impact AI Control Plane](#impact-ai-control-plane) | Test, monitor and improve the application: evaluations, traces and comparisons | Its SDK setup plugin for Codex (pre-release) ships in this repository; evaluations and comparisons are not yet available for Agent on Azure |

For either, [contact Impact AI](https://www.impact.ai/).

## Impact AI Admin Center

Everything Admin Center does can also be done by hand, with the Azure portal, the Azure CLI or this repository's scripts:

- Prompts: publish and activate persona versions with the [persona CLI](operations.md#changing-the-persona).
- Guardrail wording, tool switches and runtime settings: edit them in App Configuration ([tuning while it runs](operations.md#tuning-while-it-runs)).
- Skills: publish, activate and switch off skill versions with the [`skills` CLI](operations.md#managing-skills), as with the persona; the repository's defaults only seed them.
- Documents: load them with the [ingest script](documents.md#load-a-library).
- Branding: use the [appearance settings](configuration.md#appearance), uploading a logo before naming it.

Admin Center is one place to do all of this, and Agent on Azure is already set up for it to connect easily: prompts are versioned persona records and settings are validated documents in App Configuration, so it works with what is already there ([extension points](#extension-points-an-integration-uses)). Teams update prompts, tools, skills, documents and settings through forms, every change is versioned, and changes reach the running application without a redeploy. How soon each kind of change takes effect is described in [adapting](adapting.md#what-you-change-and-what-it-costs). New capabilities and integrations are still developer work.

[Contact Impact AI](https://www.impact.ai/) to agree which controls Admin Center covers for your application, and what access, data and retention it needs. Admin Center has its own terms, and support for an adapted application is a separate paid contract ([support](../SUPPORT.md)).

## Impact AI Control Plane

**Status:** Impact AI Control Plane's SDK setup plugin for Codex (pre-release) ships in this repository; evaluations and comparisons are not yet available for Agent on Azure.

The plugin works in Codex, OpenAI's coding agent. It checks your application's stack, helps instrument supported model and tool calls, and guides you to a first trace, keeping the existing telemetry and privacy controls ([the plugin](../plugins/impact-sdk-setup/README.md), [Impact quickstart](https://docs.impact.ai/quickstart)). Choose what content to capture before sending traffic, and keep the ingest key in the application's secret configuration. Connected, the template captures its typed turns' calls to the model through the Impact SDK, content included ([below](#where-your-data-goes)); the SDK has not qualified the Foundry route, and live voice is not captured. For the rest of the Control Plane, [contact Impact AI](https://www.impact.ai/).

Impact AI Control Plane is a product for testing, monitoring and improving an application: running its scenarios as evaluations, investigating a failure from its captured tool calls, settings and traces, comparing results, and checking that a correction fixed it. Beyond the setup plugin, two things for it ship in this repository, and both are off until you connect them: the release workflows, which confirm each release to impact.ai through its release action ([releases](deployment.md#releases)), and the copy of every span to impact.ai, which runs only with the product's endpoint and ingest key set ([the release on every span](configuration.md#the-release-on-every-span)). Nothing is sent to Impact AI unless one of these, or another integration, is set up and switched on. The application works without it.

For evaluation today, use the included checks and Microsoft's tooling on [evaluation](evaluation.md), or an integration of your own.

## Where your data goes

Agent on Azure keeps its data in your Azure subscription. Conversations are in your Cosmos DB, documents in your Blob Storage and Azure AI Search index, and settings in your App Configuration. The application's telemetry is built to carry codes, counts and timings rather than conversation text. Error text from a library or service is logged as thrown and may quote content, and agent tracing, which is opt-in, records turns in full ([privacy](privacy.md#what-is-stored)).

The two Impact AI products differ in what they send:

- **Impact AI Admin Center.** The data it receives and how long it is kept are agreed with Impact AI before it is switched on.
- **The span copy, the content capture and the release confirmation.** Nothing goes until the product's endpoint and ingest key are set for an environment. Then, as for any product connected to impact.ai, both apps send impact.ai, outside your subscription, the Impact SDK's capture of the typed turns' model calls with their content: within the SDK's limits, the instructions and messages, which hold what people wrote and can hold personal data, the answers, and each tool's arguments and results. With it goes a copy of every span the apps export, as the scrub leaves it. Application Insights gets exactly what it got before. To send traces without content, switch the SDK's capture off, by category, where each app starts its telemetry; to send nothing, leave the ingest key unset ([what goes to impact.ai](privacy.md#what-goes-to-impactai)). Deleting a conversation or erasing an account in Agent on Azure does not reach what was sent. Update your privacy notice before you set the key. A release workflow's confirmation, a check run on your repository, names the release, its images and revisions and its test counts, and no data of the application's.
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
