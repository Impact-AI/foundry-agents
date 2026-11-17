---
name: sdk-setup
description: Connect or repair Impact SDK capture in a JavaScript or Python app, preserve its native clients and telemetry, and verify its first useful Trace in Impact.
---

# Set up Impact SDK capture

Choose the compact [JavaScript](references/javascript.md) or [Python](references/python.md) recipe. They include local first-Trace examples, content controls and lifecycle guidance. [Bundle identity](references/identity.json) records their SDK versions. Use the installed SDK's status for detailed compatibility. When online guidance describes a different version, verify it against the installed API before applying it; if evidence is unavailable, report the gap.

For the application the user selected, inspect the real entry point, runtime, resolved dependencies, native client,
operation and provider route, and existing telemetry. Record the inspected revision or other basis. Check support
for that tuple in `runtime.status().integrationDetails` (JavaScript) or `runtime.status().integration_details`
(Python) when the SDK is installed. A peer range permits installation. Capture depends on the operation, route,
runtime and instrumentation owner. The JavaScript Foundry profile covers standard inference on Node ESM.
Hosted Foundry agent turns on Bun and Azure Voice Live require their own compatibility evidence. If the route
lacks matching support, identify the gap before changing the app or its stack.

## Connect and instrument

- Use the app's dependency resolver and lockfile. Pin the full prerelease for `impact-ai` or `impact` and verify
  the loaded SDK version, including when using a supplied artifact. Consult the public integration guide for
  [JavaScript](https://docs.impact.ai/sdk/javascript/integrations) or [Python](https://docs.impact.ai/sdk/python/integrations)
  when the recipe does not cover the app's integration. Confirm online guidance against the installed version's
  API and support facts before applying it.
- For direct OTLP, use `IMPACT_ENDPOINT` for the intended Product's **OpenTelemetry exporter settings** URL
  ending in `/v1/traces` and `IMPACT_API_KEY` for the raw ingest key. The SDK adds Bearer auth. Keep the key in
  the app's secret configuration and out of chat, patches and diagnostics. Preserve provider credentials.
- Set content controls before sending authorized test data. Available input, output, tools, retrieval and media
  are captured by default within SDK limits. Honor stricter customer and native policies. Disable acquisition
  paths that cannot honor those policies.
- Preserve native behavior, including request guards, tool effects, streaming and cancellation. Initialize before
  constructing clients that require early instrumentation, following any version-specific import or preload order.
  Retain the runtime for status, flush and bounded shutdown at the app's real drain boundary.
- Preserve the app's OpenTelemetry providers, processors, sampling, context and destinations, including Azure
  Monitor. Keep global ownership with the app and pass its `contextApi` where required. Check processor order
  and the data Impact actually receives. Impact can copy shared records before a customer scrubber runs, and
  content category switches do not scrub arbitrary metadata or credentials. Enforce customer policy on the Impact copy.

## Verify a useful Trace

Run a representative native operation within the user's test authorization. Preserve its actual result,
error, consumed stream or cancellation. Verify startup, native capture, delivery and authorized Product readback
for the same execution. Verify native capture with an observed model or tool operation. Use setup probes to
diagnose individual stages. Direct OTLP checks receiver authorization at export. Readback uses a separately
authorized Product session.

In the intended Product's **Traces**, match the fresh execution by service and operation. In **Recorded fields**,
check available input/output, model, expected tool or retrieval work, usage, context and Environment. Report
missing, partial or unverified evidence. Use installed status and authorized remote evidence to isolate the failed
stage. Repeat only the affected test after correcting its cause. Changing live connection settings requires
restart or redeploy. Report the patch, tested tuple, matching Trace or evidence gap, and rollback. If customer
telemetry was touched, verify its delivery and privacy after Impact shuts down.

## Optional routes

Use a supplied, authorized Instrumentation Setup Brief only for its designated route. Report content-free
observations and distinguish applied changes, deployment and verification. Leave Simulation, Protect, presence
and Source off unless requested and separately authorized. For advanced setup and optional capabilities, use
the [JavaScript setup](https://docs.impact.ai/sdk/javascript/setup) or [Python setup](https://docs.impact.ai/sdk/python/setup)
guide that matches the installed SDK. Verify capability readiness separately from the Trace.
