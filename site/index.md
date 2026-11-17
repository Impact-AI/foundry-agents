---
layout: home
title: Agent on Azure
titleTemplate: A voice and chat assistant on Microsoft Foundry

hero:
  name: Agent on Azure
  text: A deployable voice and chat assistant on Microsoft Foundry
  tagline: "It answers from business systems and from the documents each person may read (enforced in hardened mode), and shows what it finds on a visual stage beside the conversation. Start from assembled application patterns: sign-in, voice, retrieval and the Azure deployment are already connected, and your team writes the customer's integrations."
  actions:
    - theme: brand
      text: Is it a fit?
      link: /is-it-a-fit
    - theme: alt
      text: Explore the patterns
      link: /patterns
    - theme: alt
      text: GitHub
      link: https://github.com/Impact-AI/foundry-agents

heroShot:
  src: /screenshots/workspace.png
  alt: "The workspace: a document in the reader, a person's record, and the conversation that put them there"

video:
  src: /screenshots/voice.mp4
  poster: /screenshots/voice-poster.png
  captions: /screenshots/voice.vtt
  caption: A spoken question puts a chart on the stage. Captioned. Sound on to hear the question and the assistant's answer.

features:
  - title: Chat, voice and the stage
    details: People type or speak. The assistant opens documents, pictures, charts and records on the stage, the visual workspace beside the conversation, and people can open the library, a document, a record or its chart there themselves.
    link: /architecture
    linkText: How a turn runs
  - title: Answers from your documents
    details: Reuse document ingestion and retrieval, then load your customer's material on a hardened deployment. With access enforcement on, as it is in hardened mode, retrieval and document reads check the caller's permissions.
    link: /documents
    linkText: Load a library
  - title: Deploy in your Azure environment
    details: Reuse the deployment template for a demo or hardened configuration, with documented identity, network and service choices. Your team operates and adapts the application.
    link: /deployment
    linkText: Demo and hardened
  - title: Reuse what is assembled. Adapt the product.
    details: Change documents, persona and supported settings without rebuilding. Add customer tools and views in code, while reusing identity, conversation, voice and the deployment.
    link: /adapting
    linkText: Adapt it

cards:
  start:
    - title: Evaluating
      details: Systems integrators and decision-makers weighing a customer project. Where it fits, the work it leaves to you, who supports what, and the running cost.
      links:
        - text: Is it a fit?
          link: /is-it-a-fit
    - title: Building
      details: Application and platform teams adapting it for a customer. What comes assembled, and where each change goes.
      links:
        - text: Patterns
          link: /patterns
        - text: Adapting
          link: /adapting
    - title: Deploying
      details: Operations engineers putting it in an Azure subscription. Demo and hardened, Entra sign-in, regions, cost and clean-up.
      links:
        - text: Deployment
          link: /deployment
        - text: Cost
          link: /cost
    - title: Accepting
      details: Delivery managers and customers signing off. Scenarios to run before handover, and a record of their results.
      links:
        - text: Acceptance
          link: /acceptance
  build:
    - title: Patterns
      details: Conversation-driven UI, shared voice and text tools, permission-aware retrieval, product separated from platform.
      link: /patterns
    - title: Adapting
      details: Where to change the documents, a business system, the assistant's behavior and a panel, and which changes need a deploy.
      link: /adapting
    - title: Worked example
      details: A different data source connected end to end, its results on the stage, and what stayed as it was.
      link: /worked-example
  reference:
    - title: Architecture
      details: Topology in each mode, a typed and a spoken turn, identities, data stores.
      link: /architecture
    - title: Configuration
      details: Every parameter, environment variable and settings document, with defaults.
      link: /configuration
    - title: Impact AI add-ons
      details: Impact AI Admin Center, Impact AI Control Plane and its SDK setup plugin, where your data goes, and the license boundaries.
      link: /impact-ai
---

<div class="home-section">

## What it is

People sign in, type or speak, and get answers from a document library and from business records. The assistant looks records up on the person's behalf, passing on who is asking, so the business system can apply that person's permissions (the backend calls as itself) (the sample records are open to everyone). Each answer comes with what it draws on, shown on the stage, the visual workspace beside the conversation. Sign-in, conversation storage, voice, retrieval and the Azure deployment are already connected, so your team adapts them for a customer instead of assembling each part.

Agent on Azure is open source with no service level. Impact AI maintains it; Microsoft supports the Azure services it deploys, not this code ([who supports what](/is-it-a-fit#who-supports-what)).

In the screenshot above, asked what a project brief is meant to achieve, the assistant answers from the document, lists it as a source and opens it in the reader on the stage. Asked who works on a project, it puts that person's record beside it. These are typed turns over sample content on a demo deployment.

Voice works the same way. Asked aloud to chart a project's spend by quarter, it writes down what it heard, puts the chart on the stage and answers aloud.

<HomeVideo />

Impact AI's [Hera space companion](https://hera.esa.int) uses the same patterns: voice, conversation and a visual stage over mission data.

</div>

<div class="home-section">

## From the repository to your own assistant

<ol class="steps">
<li>

**Get your own copy.** Fork or clone the [repository](https://github.com/Impact-AI/foundry-agents), whichever suits how your team will work. A fork keeps upstream fixes a merge away ([taking upstream fixes](/adapting#taking-upstream-fixes)).

</li>
<li>

**Deploy.** With an Azure subscription, the Azure Developer CLI and the Azure CLI, the template provisions and deploys everything in demo mode in about 30 minutes ([deploy](/deployment#deploy)). Open the frontend address it prints and sign in with any name. Demo mode is for sample and public data, never for real data.

</li>
<li>

**Load your documents.** On the demo deployment, load only sample or public documents: anyone can sign in with a name there, and who may read a document is not enforced. Put the customer's documents, with who may read each one, on a hardened deployment ([load a library](/documents#load-a-library), [demo and hardened](/deployment#demo-and-hardened)).

</li>
<li>

**Make it yours.** Adapt backend behavior and business tools in the product layer. Reuse the existing views or add customer-specific frontend panels. The [adaptation guide](/adapting) separates settings, data, code and deployment changes.

</li>
<li>

**Check the deployment.** The smoke test checks that the deployment answers, refuses a caller with no session and, in demo mode, streams a chat turn; the deployment checker goes further ([check a deployment](/operations#check-a-deployment)). Then complete the live [acceptance scenarios](/acceptance) for your customer's tasks.

</li>
</ol>

## Build on it

<DocCards group="build" />

## Impact AI add-ons (optional)

Agent on Azure runs on its own. Impact AI offers two separately licensed products on top ([Impact AI add-ons](/impact-ai), [contact Impact AI](https://www.impact.ai/)):

- **Impact AI Admin Center** is a separate product, not included in this repository and not needed to use it. It makes maintaining agent-based applications easier: teams change prompts, guardrail wording, tool switches, documents and supported settings through forms instead of code.
- **Impact AI Control Plane** is a separate product for testing, monitoring and improving an application through evaluations, traces and comparisons; it is not needed to use Agent on Azure. Its SDK setup plugin for Codex (pre-release) ships in this repository. Evaluations and comparisons are not yet available for Agent on Azure, and capture of its Foundry turns and live voice is not yet verified.

## Reference

<DocCards group="reference" />

Except the Impact SDK setup plugin (Apache-2.0), Agent on Azure's code and documentation are MIT licensed, copyright Microsoft Corporation; Impact AI is its creator and maintainer. Impact AI Admin Center, Impact AI Control Plane and Impact AI's commercial services have their own terms.

</div>
