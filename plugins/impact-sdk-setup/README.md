<img src="assets/icon.png" alt="Impact AI" width="48" height="47">

# Impact SDK Setup

Licensed under the Apache License, Version 2.0 ([LICENSE](LICENSE)).

**Understand your AI. Improve with evidence.** Impact SDK Setup helps Codex connect your app to Impact and
verify its first useful Trace. Use it with Agent on Azure or another app with a supported JavaScript or Python integration.
Keep your native clients and existing telemetry.

### Install in Codex

Run these commands at the root of an Agent on Azure checkout that contains the Impact marketplace, or at the root
of an unpacked Impact marketplace:

```sh
codex plugin marketplace add "$PWD"
codex plugin add impact-sdk-setup@impact-ai
```

Keep the registered marketplace folder at a stable path.
In Codex desktop, you can also select **Impact SDK Setup** from the registered `impact-ai` marketplace.

### Connect your app to Impact

Open the app you want to instrument in a new Codex session, type `$`, select `impact-sdk-setup:sdk-setup`, and ask:

```text
Add Impact tracing to this app. Keep its existing clients and telemetry,
then help me find one real request in Impact.
```

In Impact AI Control Plane, ask a workspace owner or admin to open **Ingest keys → Create ingest key**.
Set `IMPACT_ENDPOINT` to the **OpenTelemetry exporter settings** URL ending in `/v1/traces` and
`IMPACT_API_KEY` to the raw key in your app's secret configuration. Tell Codex where that configuration lives.

**Choose what to capture before sending traffic.** Available input, output, tool, retrieval and media content is
captured by default within SDK limits and stricter native settings.
[JavaScript controls](https://docs.impact.ai/sdk/javascript/capture) · [Python controls](https://docs.impact.ai/sdk/python/capture)

### Verify one real request

[Run your app and find the matching Trace](https://docs.impact.ai/quickstart#run-your-app-open-its-trace) in an authorized Impact session.
Your ingest key allows delivery and does not grant read access. Codex reports any capture or verification gaps
for your installed integration.

<a id="remove-the-helper"></a>

### Remove the plugin

```sh
codex plugin remove impact-sdk-setup@impact-ai
codex plugin marketplace remove impact-ai
```

Removing the plugin does not uninstall the SDK or undo application changes.


Offline setup recipes: [JavaScript](skills/sdk-setup/references/javascript.md) · [Python](skills/sdk-setup/references/python.md).

The plugin is Apache-2.0 licensed. The Impact AI name and logo are trademarks, not part of that license grant.
