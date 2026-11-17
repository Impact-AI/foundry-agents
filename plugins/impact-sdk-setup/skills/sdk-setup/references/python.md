# First Product Trace with Python

## Install alongside your app

```sh
python -m pip install 'impact==1.2.0rc10'
```

Use Python 3.11 or later and your application's virtual environment.
[Installation and compatibility](https://docs.impact.ai/sdk/python/setup).

The base package includes capture machinery. Keep your compatible native clients and frameworks. Extras are
convenience sets for a new environment. The [integration catalogue](https://docs.impact.ai/sdk/python/integrations) identifies the
native versions and operation boundaries independently of dependency resolution. Use
`runtime.status().integration_details` to check the installed client, operation, capture owner and limitations.

The SDK uses the GenAI instrumentation `1.3b0` family and Anthropic's native `2.6.0` tracing. It requires
OpenTelemetry `>=1.45.2,<1.46` with the corresponding `0.66b2` or later instrumentation family. A project
pinned to OpenTelemetry SDK 1.39.1 and FastAPI instrumentation 0.60b1 needs a coordinated telemetry upgrade.
Resolve the complete application together to avoid leaving older middleware incompatible or using unpatched
propagation dependencies.

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

Importing `impact` is passive. Initialize Impact before constructing the native clients and retain the
returned runtime for status, flush and shutdown. The [`init()` reference](https://docs.impact.ai/sdk/python/api#runtime-api)
describes the entry points and [privacy settings](https://docs.impact.ai/sdk/python/capture) cover content capture.

In synchronous applications, call `runtime = impact.init()` at startup and `runtime.shutdown()` after
draining requests. In async applications, await `impact.init_async()` inside the running event loop and
await `runtime.shutdown()` after draining requests. In a script, put shutdown in `finally`. Retry an incomplete
shutdown to join pending cleanup. Use `flush()` to attempt delivery of completed records while capture continues.

## Keep your OpenTelemetry provider

Pass the application's existing tracer provider and optional logger provider. Supply both Impact route values
explicitly to add a destination. The application in this example has already configured both providers.

```python
import os

import impact

runtime = impact.init(
    service_name="support-agent",
    tracer_provider=customer_tracer_provider,
    logger_provider=customer_logger_provider,
    endpoint=os.environ["IMPACT_ENDPOINT"],
    api_key=os.environ["IMPACT_API_KEY"],
)
```

Impact exports detached copies and keeps the customer records and samplers intact. A conflicting `sampling=`
value raises before activation. Omitting both route options selects customer-routed delivery even when
managed-mode variables are present. For a Product Trace, that exporter must already send to Impact. In this
mode correlated content logs require an explicit `LoggerProvider`.

`shutdown()` closes SDK-owned resources. Impact processors on customer providers remain installed but inactive
after shutdown because Python OpenTelemetry exposes no public removal API. To configure capture again after
shutdown, start a new process.

## Choose what Impact captures

Set `content` on your existing initialization call before sending traffic. This example closes all five
content categories for the Impact route.

```python
runtime = impact.init(
    content={
        "input": False,
        "output": False,
        "tools": False,
        "retrieval": False,
        "media": False,
    },
)
```

The five optional Boolean fields default to `True`. Omitting `content` keeps the defaults. `tools` controls
tool arguments and results, `retrieval` includes memory content, `input` includes instructions, and `media`
controls observed image/audio/video/file bytes. Configuration is validated and snapshotted before activation.
Impact applies it to detached Impact span and log copies before serialization, size accounting and queueing,
while customer records and independently configured destinations remain unchanged.

`tools=False` closes tool arguments and results on tool carriers. If the app returns the same value as its own
request output, that copy follows the output policy. Restrict output too if it can carry data you want
omitted.

`OTEL_INSTRUMENTATION_GENAI_CAPTURE_CONTENT` selects `NO_CONTENT`, `SPAN_ONLY`, `EVENT_ONLY`, or
`SPAN_AND_EVENT` (case insensitive). Impact snapshots it before activation and applies it to semantic GenAI
records from every capture owner on its own destination. The same setting closes input/output on Impact-owned
manual AI operations (`impact.span` and `impact.operation`). Unrelated customer telemetry keeps its own
content policy. Span attributes and span events use their respective signal modes. Metadata, identifiers and
usage remain. Invalid or empty explicit values use `NO_CONTENT`. An unset value preserves Impact's
unrestricted capture default. Customer providers and destinations keep their original records.

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

Use Python 3.11 or later. These commands use a POSIX shell:

```sh
python3 -m venv .venv
. .venv/bin/activate
python -m pip install 'impact==1.2.0rc10' 'openai==3.46.0'
```

Set `IMPACT_ENDPOINT`, `IMPACT_API_KEY`, `IMPACT_SERVICE_NAME=impact-quickstart` and `OPENAI_API_KEY` through
your application's secret configuration as described above. Keep the complete prerelease pin. In an existing
uv project, use `uv add 'impact==1.2.0rc10'` alongside its compatible clients. See
[installation](https://docs.impact.ai/sdk/python/setup) for supplied wheels and existing OpenTelemetry.

Save this as `quickstart.py`:

```python
import os

import impact

runtime = impact.init(startup="strict")
try:
    from openai import OpenAI

    status = runtime.status()
    print("Impact SDK", status.artifact["version"], "runtime", status.runtime_id)
    with OpenAI(max_retries=0) as client:
        response = client.responses.create(
            model=os.getenv("OPENAI_MODEL", "gpt-6.1-sol"),
            max_output_tokens=512,
            reasoning={"effort": "low"},
            input="Say hello in one sentence.",
        )
        print(response.output_text)
finally:
    shutdown = runtime.shutdown()
    status = runtime.status()
    print("Impact local delivery", shutdown.delivery)
    print("Impact exported traces", status.traces.exported if status.traces else None)
    if status.cause not in (None, "none"):
        print("Impact diagnosis", status.cause, status.action)
    if not shutdown.completed:
        print("Impact shutdown incomplete", shutdown.message)
```

```sh
python quickstart.py
```

In the same Impact product, find `impact-quickstart` and match its `impact.runtime.id` to the printed runtime ID.
Check the model and available usage in **Recorded fields**, then match the prompt and printed reply when your
product retains content. Verify the selected SDK version. Cleanup, local export and a visible Trace are separate
checks; see [delivery diagnosis](https://docs.impact.ai/sdk/python/troubleshooting#read-shutdown-and-delivery-status) for `unknown`,
`incomplete` or `exported-not-readback` status. Zero exported traces leaves capture unverified.
