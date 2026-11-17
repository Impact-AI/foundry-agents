# First Product Trace with JavaScript

## Install alongside your app

```sh
npm install --save-exact impact-ai@0.4.0-rc.10
```

Use ESM on Node.js 22.23.5 or 24.22.3, or a later security patch in either line.
[Installation and compatibility](https://docs.impact.ai/sdk/javascript/setup).

The standalone [OpenAI Responses profile](https://docs.impact.ai/sdk/javascript/integrations#first-trace-profiles) uses Node.js ESM
and the public OpenAI API. Bun and hosted Foundry Agent Service require separate qualification. The
[Foundry inference entry](https://docs.impact.ai/sdk/javascript/integrations#microsoft-foundry) covers application-owned clients that
call an explicit Foundry endpoint. Verify hosted agent execution separately.

Use `runtime.status().integrationDetails` to check the installed client, operation, capture owner and
limitations. See [integration setup](https://docs.impact.ai/sdk/javascript/integrations) for framework preload and bridge recipes.

## Connect your Impact product

In your product, open **Ingest keys → Create ingest key** as a workspace owner or admin.
Add these values to your app's secret configuration:

```dotenv
IMPACT_ENDPOINT=<exporter URL ending in /v1/traces>
IMPACT_API_KEY=<raw ingest key>
IMPACT_SERVICE_NAME=my-app
```

Copy the endpoint from **OpenTelemetry exporter settings**. Keep the raw key private; Impact supplies the
Bearer header. Your existing model-provider credentials stay as they are.

<a id="loading-these-settings-locally"></a>

### Loading these settings locally

Use your app's existing environment loader or secret manager. If using a local env file, exclude it from source
control and load it before SDK startup. Node can load it with `--env-file`; Python does not load env files automatically.

## Initialize and shut down

Ordinary imports are passive. Retain the handle returned by `await impact.init()`, then construct your native
clients. The OpenAI and Anthropic packages may be statically imported before `init()`. Google Gen AI also
requires post-initialization client construction. Google ADK gets its tracer during module evaluation, so follow
the [ADK startup recipe](https://docs.impact.ai/sdk/javascript/integrations#google-adk).

Managed sampling supports `{ mode: 'all' }` (the default), `{ mode: 'none' }`, and
`{ mode: 'ratio', ratio: 0.1 }`. Ratios must be finite and between 0 and 1. Sampling applies to whole
operations through parent-aware sampling, except `none` disables sampling. Your provider controls sampling
when you supply a tracer or tracer provider.

At the application's completion boundary, drain application work, then call `await runtime.shutdown()`.
Use `await runtime.flush()` to attempt delivery of completed records without stopping capture. If shutdown
reports incomplete cleanup, retry it to continue the unfinished phases. Review local delivery and confirm
the matching [Product Trace](https://docs.impact.ai/sdk/javascript/troubleshooting).

## Keep your OpenTelemetry provider

Managed mode uses `endpoint` and `apiKey`. Impact owns the private provider, processors, exporters and queues it
creates. It becomes the process-global OpenTelemetry owner only when no provider exists. Shutdown never closes a
customer provider, but replacing managed global telemetry in the same process requires a restart.

External mode accepts a customer `TracerProvider` or `Tracer` and never owns or flushes its provider:

```ts
const runtime = await impact.init({
  serviceName: 'support-agent',
  tracerProvider: customerTracerProvider,
});
```

Maintained owners use the supplied tracer/provider. Native framework spans that independently obtain the
process-global provider, such as ADK's own spans, still follow that customer route. Verify its destination separately.

To send a customer provider's spans to a direct Impact OTLP route, use `createOtlpDestination({ endpoint, apiKey })`
with the traces URL and raw ingest key. Add `destination.spanProcessor` to the application's provider configuration
and pass the destination to `init`. Check the outgoing Impact copy against the application's scrubber policy. A later
processor can scrub the customer record after Impact has copied it.
[Destination and log setup](https://docs.impact.ai/sdk/javascript/setup#attach-a-destination-managed-by-impact).

## Choose what Impact captures

Content capture is on by default. Set `content` on your existing initialization call to omit selected categories
from Impact telemetry before sending traffic.

```ts
await impact.init({
  content: { input: false, output: false, tools: false, retrieval: false, media: false },
});
```

Every omitted setting defaults to `true`. `input` includes instructions and requested schemas. `tools` covers
arguments and results on tool carriers, `retrieval` includes memory content, and `media` controls observed bytes.
The SDK validates and snapshots configuration before activation. Mixed native blocks retain permitted content.
If the SDK can't redact the affected Impact record safely, it drops that record and reports the reason.
The root span or log records the effective policy and omission markers.

If the app returns a tool result as its own request output, that copy follows the output policy. Restrict output too
if it can contain data you want omitted. Vercel AI SDK provider metadata can mix several categories in one opaque
value. Impact captures that value only when all five categories permit capture and the native telemetry settings
permit outputs. Native per-call `recordOutputs: false` or disabled telemetry takes precedence.

Only the Impact copy is projected. Existing customer records, processors and destinations remain untouched. Under a
restriction, unclassified correlated log bodies, error text and free-form feedback are omitted because they can
quote any content category. Numeric feedback and operation identity remain available. Simulation invocation and
Protect inference are separately authorized application work. Their telemetry copies obey this policy.

## Verify one real request

Make one ordinary request using your app's existing interface.

1. Open **Traces** in the same Impact product.
2. Find your service and the request you just ran.
3. Inspect the model call, available usage and captured input and output.

<a id="no-trace-yet"></a>

### No Trace yet?

Check the endpoint and key, initialization order, supported integration and `runtime.status()`.
A successful startup or shutdown alone does not confirm delivery. Use a signed-in Impact session to view the
result; an ingest key does not grant read access.
[JavaScript troubleshooting](https://docs.impact.ai/sdk/javascript/troubleshooting) · [Python troubleshooting](https://docs.impact.ai/sdk/python/troubleshooting)

## Run the standalone example

These standalone examples make one billable OpenAI Responses call. Use an OpenAI project key separately from
your Impact ingest key. Set `OPENAI_MODEL` to a model your project can use and adjust the model-specific options
if needed. Imports are passive; initialize Impact before constructing the client.

Use a new directory with `npm init -y`, then install the exact prerelease and the example's client:

```sh
npm install --save-exact impact-ai@0.4.0-rc.10 openai@7.53.0
```

Use Node.js 22.23.5 or 24.22.3, or a later security patch in either line, with ESM. The documented npm version is
11.21.2. Keep an existing application's compatible clients and lockfile instead of replacing them for this example.

Add `.env.impact-quickstart` to `.gitignore` before creating it with your values:

```dotenv
IMPACT_ENDPOINT=<copied OTLP traces URL ending in /v1/traces>
IMPACT_API_KEY=<raw Impact ingest secret>
IMPACT_SERVICE_NAME=impact-quickstart
OPENAI_API_KEY=<your OpenAI project API key>
```

Save this as `quickstart.mjs`:

```js
import OpenAI from 'openai';
import * as impact from 'impact-ai';

const runtime = await impact.init({ startup: 'strict' });
try {
  const { artifact, runtimeId } = runtime.status();
  console.log('Impact SDK', artifact.version, 'runtime', runtimeId);

  const client = new OpenAI({ maxRetries: 0 });
  const result = await client.responses.create({
    model: process.env.OPENAI_MODEL ?? 'gpt-6.1-sol',
    input: 'Say hello in one sentence.',
    max_output_tokens: 512,
    reasoning: { effort: 'low' },
  });
  console.log(result.output_text);
} finally {
  const result = await runtime.shutdown();
  console.log('Impact exported spans', runtime.status().exportedSpans);
  if (!result.completed) console.warn('Impact shutdown incomplete', result.message);
}
```

```sh
node --env-file=.env.impact-quickstart quickstart.mjs
```

If the environment variables are already set, run `node quickstart.mjs`. In the same Impact product, find
`impact-quickstart` and match the printed runtime ID to `impact.runtime.id`. Check **Recorded fields** for the
model and available usage, then compare the prompt and printed reply when your product retains content.
Confirm the selected SDK version in the output. See [installation](https://docs.impact.ai/sdk/javascript/setup) for supplied archives
and [troubleshooting](https://docs.impact.ai/sdk/javascript/troubleshooting) for zero exported spans or missing Traces.
