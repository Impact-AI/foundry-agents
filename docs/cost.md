# Cost

| Configuration | About, a month |
| --- | --- |
| Demo mode, apps idle, before usage | $160 |
| Hardened mode, apps idle, before usage | $1,120–1,190 |
| Hardened mode, 200 people with 200 typed turns and 10 voice minutes each ([worked example](#a-worked-example)) | $1,490–1,580 |

List prices for Sweden Central, in US dollars. The always-on services are most of the bill; on hardened, the largest are Cosmos DB's provisioned throughput, Front Door and AI Search. Usage grows linearly with people, typed turns and voice minutes, and a voice minute costs about nine times a typed turn.

This page gives the fixed monthly price of each service, the optional extras, the usage-based costs with a formula to estimate them, the worked example, and what the estimate leaves out.

## Fixed monthly costs

Monthly list prices in US dollars for Sweden Central, the example region of [deployment](deployment.md), before model usage. Each comes from the meter's pay-as-you-go retail price in the [Azure Retail Prices API](https://learn.microsoft.com/rest/api/cost-management/retail-prices/azure-retail-prices), in US dollars for the Sweden Central region, taken over 730 hours a month; Container Apps' per-second rates are the [pricing calculator](https://azure.microsoft.com/pricing/calculator/)'s. They are list prices for that region: another region, another currency, an agreement or a reservation changes them, and they change over time. Check your own in the calculator, and on the bill in Cost Management by meter.

| Resource | Demo | Hardened | What drives it |
| --- | --- | --- | --- |
| Azure AI Search, Basic | ~$74 | ~$147 | $0.101 an hour per search unit (replicas × partitions): one replica on demo, two when zonal. The semantic ranker is free for the first 1,000 requests a month, then $1 per 1,000 ([Search pricing](https://azure.microsoft.com/pricing/details/search/)); only a semantic query with a non-empty search string counts ([semantic ranker](https://learn.microsoft.com/azure/search/semantic-search-overview#availability-and-pricing)). |
| Cosmos DB for NoSQL | a few dollars (serverless) | ~$374–453 | Serverless: $0.305 per million RUs and $0.25 per GB a month. Hardened is provisioned and zone-redundant: the Agent Service's five containers and the app's database ([Cosmos DB, hardened](#cosmos-db-hardened)). Seven-day point-in-time restore is free. |
| App Configuration, Standard | ~$37 | ~$37 | $1.20 a day per store. |
| Azure Managed Redis, Balanced B0 | ~$12 | ~$25 | The retail meter ("B0 Cache Instance", $0.017 an hour) is the pricing page's one-node column; its two-node (high availability) column is twice that ([Managed Redis pricing](https://azure.microsoft.com/pricing/details/managed-redis/)), and Microsoft Learn says turning high availability off "halves the cost" ([migrate to Managed Redis](https://learn.microsoft.com/azure/redis/migrate/migrate-basic-standard-premium-understand#additional-considerations)). One node on demo, two when zonal. |
| Container Apps, Consumption | ~$34 idle, ~$113 active | ~$69 idle, ~$231 active | The backend (1 vCPU, 2 GiB) and the frontend (0.5 vCPU, 1 GiB), one replica each on demo, two when zonal, less the monthly free grant of 180,000 vCPU-seconds and 360,000 GiB-seconds per subscription. Idle or active billing is explained [after the table](#container-apps-idle-and-active). |
| Container Apps private endpoint | — | ~$73 | Front Door reaches the environment over a private link, and a private endpoint on an environment is billed as a "Dedicated Plan Management" charge on the Consumption plan as well ([private endpoints](https://learn.microsoft.com/azure/container-apps/private-endpoints-with-dns#billing)): $0.10 an hour. |
| Container Registry, Basic | ~$5 | ~$5 | $0.1666 a day, plus build minutes per deploy past the first 6,000 seconds of task time. |
| Front Door Premium + WAF | — | ~$330 | A base fee of $330 a month, plus requests and data transfer. "WAF and Private Link pricing is included in Azure Front Door Premium" ([Front Door pricing](https://azure.microsoft.com/pricing/details/frontdoor/)). |
| Private endpoints (7) and DNS zones (9) | — | ~$56 | $0.01 an hour per endpoint (~$7.30 a month) plus $0.01 per GB processed each way, and $0.50 a month per private DNS zone. Private telemetry adds more ([optional extras](#optional-extras)). |
| Storage, Key Vault, Log Analytics | a few dollars | a few dollars | Data stored, Key Vault operations ($0.03 per 10,000), and logs ingested past the free allowance ([a worked example](#a-worked-example) prices ingestion). |
| **Total of the priced rows, before usage** | **about $160** (apps idle) | **about $1,120–1,190** (apps idle) | The [optional extras](#optional-extras) aside, active apps among them. |

For scale: with a handful of conversations a day, model usage is cents. Live voice is the most expensive thing a person can do; [usage limits](configuration.md#limits) bound it per account and per deployment.

### Cosmos DB, hardened

The Agent Service makes three containers when its [capability host](patterns.md#terms) is made, and two more when the project's first agent is called through the Responses API, as this template's are. Microsoft Learn says they are "each requiring 1000 RU/s" ([use your own resources](https://learn.microsoft.com/azure/foundry/agents/how-to/use-your-own-resources)). At the standard rate, $0.008 per 100 RU/s an hour, multiplied by 1.25 for zone redundancy ([Cosmos DB pricing](https://azure.microsoft.com/pricing/details/cosmos-db/autoscale-provisioned/)), that is ~$73 each, ~$365 for five. This assumes standard throughput; if the service sets autoscale, the price differs ([check it on a deployment](operations.md#checking-what-it-costs)). The app's database autoscales from 100 to 1,000 RU/s at $0.012 per 100 RU/s an hour, with no zone surcharge on autoscale: $9–88.

### Memory's cost

Memory spends tokens of the small chat model after each turn, and of the embedding model too on the Foundry memory store (preview), which also recalls. Microsoft Learn says memory is billed as "usage of the underlying chat and embedding models" ([what is memory](https://learn.microsoft.com/azure/foundry/agents/concepts/what-is-memory#pricing)). The Retail Prices API also lists Foundry Agents memory meters: short-term events stored at $0.275 per 1,000, retrievals at $0.55 per 1,000, and long-term memories at $0.275 per 1,000 a month. In demo mode, where the Foundry memory store is the default, they may appear on the bill.

### Container Apps, idle and active

A replica at its minimum count is billed at the idle rate only while it uses under 0.01 vCPU, serves no request and receives under 1,000 bytes a second ([billing](https://learn.microsoft.com/azure/container-apps/billing)); otherwise it is billed at the active rate. Cost Management shows which rate applies. Extra replicas under load are active.

## Optional extras

Each adds to the fixed costs while it applies. All but the active rate are settings, off by default.

| Extra | Demo | Hardened | What drives it |
| --- | --- | --- | --- |
| Apps billed at the active rate | about +$80 | about +$160 | Replicas that serve traffic are billed at the active rate rather than idle ([Container Apps, idle and active](#container-apps-idle-and-active)). |
| Private telemetry | — | ~$9 | One more private endpoint and four more private DNS zones. |
| Restricted agent egress | — | ~$37 | A NAT gateway ($0.045 an hour, plus $0.045 per GB it carries) and its static public address ($0.005 an hour), only when the agent's outbound traffic is restricted. An Azure Firewall in its place, as the Foundry baseline uses, is $0.395 an hour on its Basic tier, about $288 a month before its public addresses and $0.065 per GB processed ([decisions](decisions.md#28-the-agent-subnets-egress-open-by-default-a-nat-gateway-and-a-service-tag-allow-list-by-opt-in)). |
| Developer access (jump host and Bastion) | — | ~$210 | Bastion Basic at $0.19 an hour (about $139 a month) plus its public IP ($0.005 an hour, about $4), the VM at $0.092 an hour (about $67), and its 32 GiB Standard SSD at about $2. Billed while developer access is on, used or not ([developer access](deployment.md#developer-access) sets it up). |

Two alternatives to developer access, which the template does not deploy:

- **Bastion Standard**, for a desktop tool's native-client tunneling, costs about $212 a month against Basic's $139.
- **A point-to-site VPN gateway** is VpnGw1 at $0.19 an hour (about $139 a month), plus $0.01 an hour per connected client, and a DNS Private Resolver inbound endpoint at $180 a month so laptops resolve the private zones: about $320 a month in all.

## Usage-based costs

Usage is billed per use, with no fixed charge: model tokens, voice, web search, Prompt Shields at ingest, the semantic ranker past its free requests and telemetry ingestion. The table lists the meters, the formula below adds them up, and [a worked example](#a-worked-example) works one case with its assumptions stated. The result is an estimate for planning, not a quote. The prices are list prices from the same source as the [fixed costs](#fixed-monthly-costs), with the billing rules from the pages linked beside them; check them for your case in the calculator and on the bill.

| Meter | Demo | Hardened | What drives it |
| --- | --- | --- | --- |
| Foundry project and Agent Service | — | — | No charge for an agent of its own: its turns are model tokens on the deployments, and its conversations live in the Cosmos DB of the [fixed costs](#fixed-monthly-costs). Memory spends model tokens, and may have meters of its own ([memory's cost](#memorys-cost)). |
| Web search | per use | per use | Billed per search, on top of the tokens, once the agent searches the web; nothing while it does not. The tool is the Agent Service's own web search, listed on the [Agent Service pricing page](https://azure.microsoft.com/pricing/details/foundry-agent-service/) at $14 per 1,000 transactions, the rate of [Grounding with Bing](https://www.microsoft.com/bing/apis/grounding-pricing). Bounded per account by [usage limits](configuration.md#limits). |
| Azure OpenAI | per use | per use | Tokens on the deployments; no fixed charge for them. The rates the template's deployments bill at are in [a worked example](#a-worked-example). |
| Foundry voice agent | per use | per use | Per session, no fixed charge: the realtime deployment's tokens, and Voice Live's speech recognition and voice on top ([the usage formula](#the-usage-formula) has the rule, and [a worked example](#a-worked-example) the rates). On the [cascade](patterns.md#terms), the chat deployment's text tokens in place of the realtime ones. |
| Prompt Shields at ingest | per load | per load | The library's chunks are scanned once each at load, billed as Content Safety text records: $0.375 per 1,000 records of up to 1,000 characters each ([Content Safety pricing](https://azure.microsoft.com/pricing/details/cognitive-services/content-safety/)). |

### The usage formula

A month's estimate adds up six parts:

1. **The fixed costs** of the mode, demo or hardened: the total of the [fixed costs](#fixed-monthly-costs), Redis included.
2. **Typed turns**: people × turns each × the price of a turn. A turn's price is the sum, over the model deployments it uses, of its input, cached-input and output tokens, each at its own price.
3. **Voice minutes**: people × minutes each × the price of a minute. A minute's price is the realtime deployment's tokens at their prices, plus Voice Live's audio in and out at theirs.
4. **The semantic ranker**: the searches past the first 1,000 a month, at the ranker's price.
5. **Telemetry**: the gigabytes ingested past what is left of the billing account's free 5 GB once its other workspaces have taken theirs, at the price per GB.
6. **Web search**: the searches made, at the price per search; zero while web search is not used.

**How a voice minute is billed.** Live voice is a Foundry voice agent on this deployment's own realtime deployment. Microsoft Learn states that such models "are billed through your own Foundry model deployment", with speech and other voice-agent features adding to the cost ([pricing for voice-based agents](https://learn.microsoft.com/azure/foundry/agents/concepts/voice-agent-pricing)). So a minute is the realtime deployment's tokens plus Voice Live's speech. The speech bills on the *Voice Live BYO* Standard audio meters, input and output; the realtime deployment adds its own audio-input and text tokens, and no audio-output tokens, because the Azure voice speaks.

**How many tokens a minute is.** Microsoft Learn's [Voice Live overview](https://learn.microsoft.com/azure/ai-services/speech-service/voice-live#token-usage-and-cost-estimation) gives about 10 tokens a second of input audio and about 20 a second of output audio for Azure OpenAI models. It also says cached audio and text inputs, "including the prompt and the context of the conversations", are charged too. How much context is cached and resent per response depends on the conversation, so measure it on your own deployment ([checking what it costs](operations.md#checking-what-it-costs)).

## A worked example

**Assumptions.** These are illustrative, not measured on a deployment. Replace each with your own figure.

- Hardened mode, because demo mode is never for real data.
- 200 people, each with 200 typed turns a month (about ten a working day) and 10 minutes of live voice a month: 40,000 typed turns and 2,000 voice minutes.
- **A typed turn** is two responses on `chat` (one calls a tool, one answers), each with 8,000 input tokens of instructions, tool schemas, history and retrieved passages. It writes 600 output tokens in all, reasoning included. On `small` it uses 4,000 input and 350 output tokens for the query plan and memory extraction, and on `embedding` 100 tokens for the query. No cached-input discount is assumed.
- **A voice minute** is speech to speech on `gpt-realtime-2.1`: 30 seconds of the person, 30 of the voice, three responses. Realtime: 300 new audio input tokens (30 seconds at Microsoft Learn's 10 a second), 4,500 cached audio tokens, 3,000 new and 12,000 cached text input tokens, 300 text output tokens; the cached and text counts are assumptions. Voice Live: 300 audio input tokens and 600 audio output tokens (30 seconds at 20 a second), at the BYO rate.
- One semantic-ranked search per typed turn and per voice minute: 42,000 requests.
- 3 GB a month of platform logs and metrics, plus 50 KB of telemetry per typed turn and per voice minute: about 5 GB.
- No web search.

**Unit prices used** (list, Sweden Central, USD, Retail Prices API):

| Meter | Price |
| --- | --- |
| `chat` (`gpt-5.6-luna`, Global Standard, short context): input, cached input, output | $0.20, $0.02, $1.20 per 1M tokens |
| `small` (`gpt-5-mini`, Global Standard): input, cached input, output | $0.25, $0.025, $2.00 per 1M tokens |
| `embedding` (`text-embedding-3-large`, Standard) | $0.000158 per 1,000 tokens |
| `realtime` (`gpt-realtime-2.1`, Global Standard): audio input, cached audio or text input, text input, text output | $32, $0.40, $4, $24 per 1M tokens |
| Voice Live BYO, Standard speech audio: input, output | $0.0125, $0.023 per 1,000 tokens |
| Log Analytics, Analytics Logs ingestion (pay-as-you-go, the workspace's per-GB pricing tier) | $2.99 per GB; "the first 5 GB/month per billing account" free ([Azure Monitor pricing](https://azure.microsoft.com/pricing/details/monitor/)). Application Insights is workspace-based, so its data bills here ([cost-logs](https://learn.microsoft.com/azure/azure-monitor/logs/cost-logs#application-insights-billing)); the 30-day retention is inside the 31 days ingestion includes. |
| Semantic ranker | $1 per 1,000 requests past the free 1,000 ([fixed costs](#fixed-monthly-costs)) |

`gpt-5.6-luna` has short- and long-context rates (long: $0.40 input, $1.80 output); the pricing page names both without stating where one ends, and an 8,000-token request is taken at the short rate. The `realtime` audio-output meter ($64 per 1M) stays out: the Azure voice speaks, not the model ([speech-to-speech voice](deployment.md#speech-to-speech-voice)).

**Per unit:**

- A typed turn: `chat` $0.00320 input + $0.00072 output; `small` $0.00100 + $0.00070; embedding $0.00002. In all, about **$0.0056**.
- A voice minute: realtime $0.00960 (audio in) + $0.00180 (cached audio) + $0.01200 (text in) + $0.00480 (cached text) + $0.00720 (text out). Voice Live $0.00375 (audio in) + $0.01380 (audio out). In all, about **$0.053**.

**Per month:**

| Part | Kind | Estimate |
| --- | --- | --- |
| Hardened services before usage, two Redis nodes included, apps idle | Recurring infrastructure | about $1,120–1,190 ([fixed costs](#fixed-monthly-costs)) |
| Typed turns: 40,000 × $0.0056 | Usage | about $225 |
| Voice: 2,000 minutes × $0.053 | Usage | about $106 |
| Semantic ranker: 41,000 billed requests | Usage | about $41 |
| Telemetry: about 5 GB | Usage | $0 to $15, depending on what else uses the billing account's free 5 GB |
| **Total** | | **about $1,490–1,580** |

At this workload the always-on services are about three quarters of the total, and apps billed at the active rate rather than idle add about $160. Usage grows linearly with people, turns and minutes. A voice minute costs about nine times what a typed turn does. On the cascade engine the realtime rows are replaced by text tokens on `chat`, which cost less ([the realtime deployment](configuration.md#the-realtime-deployment)). [Usage limits](configuration.md#limits) bound what each account can spend.

## What the estimate leaves out

Implementation and support are effort, not infrastructure, and they are priced separately: the [work still required](is-it-a-fit.md#work-still-required) of your team, the customer's acceptance, and any [contract with Impact AI](is-it-a-fit.md#who-supports-what). Also left out: the [optional extras](#optional-extras), a knowledge base above minimal reasoning effort ([the knowledge base's planning model](configuration.md#the-knowledge-bases-planning-model)), loading the library once (its embedding at the price above, its OCR, and Prompt Shields per chunk, in the [usage-based costs](#usage-based-costs)), Front Door's requests and data transfer, and data transfer generally.
