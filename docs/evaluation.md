# Evaluation

Agent on Azure includes the checks to test an adapted application, and Microsoft Foundry adds tracing and evaluations. This page says what each establishes and where it stops.

## Included engineering checks

| Included | What it establishes | Boundary |
| --- | --- | --- |
| Automated tests | Application logic and contracts under the test services' behavior | Stand-ins do not establish the real model's answer quality |
| Deployment checks | Resource configuration, selected API behavior, a streamed typed answer and an optional voice-session lifecycle check | The voice check sends silence; it does not test a spoken task, spoken answer or voice tool use |
| Acceptance scenarios | A starting set of permission, tool, evidence, UI and channel checks | Teams adapt and run the live scenarios for their customer's application |
| OpenTelemetry and structured events | Request investigation, model usage and selected failure information | Counts and timings alone do not show why an answer or visual result was wrong |

The pages behind them are [testing](testing.md), [acceptance](acceptance.md), [the deployment checker](deployment.md#deployment-checker) and [monitoring](operations.md#monitoring). Next, record which checks ran for a release, and which did not, as [recording the result](acceptance.md#recording-the-result) describes.

## Microsoft tooling

- **Microsoft Foundry tracing and Application Insights.** Inspect execution and investigate behavior. Agent on Azure sends its telemetry to Application Insights; [Microsoft's tracing guide](https://learn.microsoft.com/en-us/azure/foundry/observability/how-to/trace-agent-setup) covers the Foundry side.
- **Microsoft Foundry evaluations.** Evaluate outputs, agents and supported production traces through Microsoft's portal and programmatic tools ([Evaluation in Microsoft Foundry](https://learn.microsoft.com/en-us/azure/foundry/concepts/evaluation-overview)).

Agent on Azure does not set up these evaluations for you. Check each tool's supported runtime, permissions, data requirements and feature status before relying on it.
