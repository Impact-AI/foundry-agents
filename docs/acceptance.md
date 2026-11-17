# Acceptance

These scenarios give the team accepting an adapted application, and whoever signs it off for a customer, a reusable way to verify it: permissions, tool execution, retrieved evidence, visual actions on the [stage](patterns.md#terms), and voice and text behaving the same.

## Sign-off checklist

A delivery manager can run this with the team, one row per scenario. The detailed scenarios, with the tests behind each, are [further down](#the-detailed-scenarios).

1. **Prepare.** Deploy the release to a test environment that matches production's mode. Rewrite each scenario in the customer's terms. Create the test users and restricted documents P1 to P3 need, and make sure document access enforcement is on: hardened mode turns it on from the first deploy, demo mode doesn't ([who may read a document](documents.md#who-may-read-a-document)).
2. **Run.** For each row, the person assigned runs the check on the live deployment and records the date and the result. The engineering team runs the deployment checker for the scripted rows ([running the deployment checker](#running-the-deployment-checker)).
3. **Record.** Link evidence for every row: a screenshot, a conversation export, a line of the deployment checker's report, or a CI run. Mark a row *waived* only with the customer's written agreement and the reason.
4. **Sign off.** Review the filled table with the customer's owner, and keep it with the release ([recording the result](#recording-the-result)).

Copy this template into the release record:

```markdown
Release: <commit, which the engineering team supplies>    Environment: <name>    Mode: demo / hardened

| #  | Scenario                                                     | Who ran it | Date | Result (pass / fail / waived) | Evidence link |
| -- | ------------------------------------------------------------ | ---------- | ---- | ----------------------------- | ------------- |
| P1 | People never see a document restricted to someone else      |            |      |                               |               |
| P2 | A restricted picture's link is refused to others             |            |      |                               |               |
| P3 | A demo sign-in sees only documents open to everyone (demo)   |            |      |                               |               |
| P4 | A tool answers only for the signed-in person                 |            |      |                               |               |
| P5 | Nothing answers without a session                            |            |      |                               |               |
| T1 | Questions about the business system get its real data       |            |      |                               |               |
| T2 | A malformed tool call never runs                             |            |      |                               |               |
| T3 | A slow or failed system gets an honest "couldn't get it"     |            |      |                               |               |
| T4 | A tool switched off is never used                            |            |      |                               |               |
| E1 | Answers show their source documents, and each one opens      |            |      |                               |               |
| E2 | Questions outside the library get "I don't know"             |            |      |                               |               |
| E3 | A document carrying an attack is never used                  |            |      |                               |               |
| E4 | The library lists what was loaded, and pictures load         |            |      |                               |               |
| V1 | Asking to see something puts it on screen                    |            |      |                               |               |
| V2 | Everything the assistant shows can be opened by hand         |            |      |                               |               |
| V3 | "The second one" and "that chart" are understood             |            |      |                               |               |
| V4 | A tool and a screen change in one answer both complete       |            |      |                               |               |
| C1 | The same question typed and spoken gets the same answer      |            |      |                               |               |
| C2 | A typed question continues a spoken conversation             |            |      |                               |               |
| C3 | Both channels answer in the person's language                |            |      |                               |               |
| C4 | Without Redis, voice is hidden and typing works              |            |      |                               |               |
| C5 | Spoken answers start within the agreed wait                  |            |      |                               |               |
```

**What "accepted" means.** A release is accepted when every row is *pass* or *waived* with the customer's written agreement, on a live deployment of the commit that will go to production. The CI run of that commit passed, and the deployment checker's report shows no failure. Row V4 has no manual check, so its evidence is the CI run. T2's typed path has no automated test; record it as pass (voice path only) or run a manual malformed-argument check. P3 applies only to demo mode, which hardened mode refuses; on a hardened release, record it as waived, not applicable. Acceptance covers these scenarios; the customer's own security and privacy review is separate ([security: known gaps](security.md#known-gaps), [privacy: known gaps](privacy.md#known-gaps)).

## Recording the result

Keep one record per accepted release, in the place the customer's project keeps its release documents (a folder per release in the project's repository or document library works):

- **The filled sign-off table** from the [checklist](#sign-off-checklist), with the release's commit and the environment it ran on.
- **The deployment checker's report** for this release, kept apart from every other release's ([running the deployment checker](#running-the-deployment-checker)).
- **The evidence for each manual check.** For each, the question asked, who asked it, and what came back: a screenshot or the conversation's export.
- **The CI run** of the commit that was deployed, by link.
- **The sign-off.** Who accepted the release for the customer, and when, with any waived rows and their reasons.

The [worked example](worked-example.md#verification) shows such a record, with the automated checks apart from the live ones. For evaluation beyond these checks, [evaluation](evaluation.md) covers Microsoft's tooling and the optional [Impact AI Control Plane](impact-ai.md#impact-ai-control-plane).

## The detailed scenarios

This part is for the engineers who run the checks. Each scenario is checked in two places, and neither replaces the other.

- **With stand-ins.** These are automated tests in `bun test` and the end-to-end suite. They run on every change in CI, with the models, Microsoft Foundry and Azure's data services stood in for at their boundaries ([testing: layers](testing.md#layers)). They prove that the code does what it should *given* how the services behave.
- **On a live deployment.** These prove the services really behave that way: the real model choosing the tool, the real index filtering, the real voice agent. Some are scripted in the [deployment checker](deployment.md#deployment-checker). The rest are short manual checks, listed with each scenario.

Rewrite the *Given* and *Then* in your customer's terms (their documents, their groups, their system's records) and keep the Given/When/Then structure.

### Running the deployment checker

The scripted rows run in one pass of the deployment checker, from the repository root, after `azd up`:

```sh
bun scripts/verify-deployment.ts --voice --destructive --report verify-<release>
```

The run writes a Markdown and a JSON report, `verify-report.md` and `verify-report.json` by default; `--report` names them, so each release keeps its own pair for its record. The [deployment checker](deployment.md#deployment-checker) section has every option and what each check proves. P1 to P3 need document access enforcement on, the `access.enforceAccessControl` setting ([who may read a document](documents.md#who-may-read-a-document)).

### Permissions

| # | Scenario | With stand-ins | Live |
| --- | --- | --- | --- |
| P1 | **Given** two people in different Entra groups and a document restricted to each group, with `enforceAccessControl` on. **When** each one asks about the other's document. **Then** neither one's answer, sources, library or reader shows it. | [`readers.library.test.ts`](../platform/knowledge/src/query/readers.library.test.ts) (search, by id, by picture); [`access.e2e.ts`](../apps/frontend/e2e/access.e2e.ts) (the library, a picture) | Manual: two test users, one restricted document each ([what only a deployment proves](testing.md#what-only-a-deployment-proves); the steps, hardened: [check readers on a hardened deployment](documents.md#check-readers-on-a-hardened-deployment)) |
| P2 | **Given** a picture inside a restricted document, with `enforceAccessControl` on. **When** someone outside its readers requests its URL directly. **Then** it is refused. | `access.e2e.ts` | Manual, with P1's users |
| P3 | **Given** a person signed in with the demo's local sign-in, with `enforceAccessControl` on. **Then** they see only documents open to `all`. | `readers.library.test.ts` | Manual on a demo deployment |
| P4 | **Given** a tool that reaches your system. **When** the model passes another person's id in the tool's arguments. **Then** the tool still answers only as the caller, because it reads who is calling from `currentTurn()` and never from its input. | Your tool's unit test, with two callers (the [worked example](worked-example.md) has one) | Manual: ask, as a user who lacks access, for a record they may not see |
| P5 | **Given** no session, or a session from another origin. **Then** every API route is refused. | [`same-origin.test.ts`](../apps/frontend/src/same-origin.test.ts); the backend's route-table test in [`erase.flow.test.ts`](../apps/backend/src/erase.flow.test.ts) | `the API refuses a caller with no session`, `a write from another origin is refused` |

### Correct tool execution

| # | Scenario | With stand-ins | Live |
| --- | --- | --- | --- |
| T1 | **When** the person asks something only your system can answer (for the sample data, "who works on project X?"). **Then** the model calls your tool with valid arguments, the backend runs it as the person, and the answer uses what it returned. | [Parity suite](patterns.md#terms): *a tool of the backend's runs inside the turn* ([`parity.ts`](../platform/agent/src/contract/parity.ts)); your tool's own test ([`sample-tools.test.ts`](../apps/backend/src/product/tools/sample-tools.test.ts) for the sample) | Manual: three to five questions per tool, answers checked against the system |
| T2 | **When** the model's arguments break the tool's schema. **Then** the tool never runs and the model is told why. | The host validates arguments before `execute` runs ([`loop.ts`](../platform/agent/src/foundry/turn/loop.ts)). The live-session path is tested in [`voice.test.ts`](../platform/agent/src/foundry/voice.test.ts); the typed path has no automated test | Manual, optional: a malformed-argument check on the typed path; otherwise record pass (voice path only) |
| T3 | **When** your system is slow or down. **Then** the call ends within its deadline and the assistant says it couldn't get the answer, with no error page and no invented answer. | Your tool's test with the system stood in for as failing or slow | Manual: point the tool at an address that doesn't answer, on a test environment |
| T4 | **When** a tool is switched off in the `tools` document. **Then** the model isn't offered it and never calls it, on either channel. | [`surface.test.ts`](../apps/backend/src/product/surface.test.ts) | Manual: switch it off, wait 30 seconds, ask |

### Retrieved evidence

| # | Scenario | With stand-ins | Live |
| --- | --- | --- | --- |
| E1 | **When** an answer draws on documents. **Then** the documents it names appear as sources under the reply, and each one opens in the reader. | [`named-sources.test.ts`](../platform/agent/src/turn/named-sources.test.ts); [`chat.e2e.ts`](../apps/frontend/e2e/chat.e2e.ts) | Manual: the README's depot-checklist question, or one per library in your customer's terms |
| E2 | **When** nothing in the library answers. **Then** the assistant says so rather than answering from nowhere. | None: it rests on the persona and guardrail wording | Manual, with questions just outside the library |
| E3 | **Given** a document carrying an injected instruction. **Then** its chunks are never served. | Prompt Shields' stand-in flags a planted string ([testing](testing.md#layers), Knowledge) | Manual: load a document containing a known attack string, and ask about it |
| E4 | **Then** the library lists what was loaded, and a picture is served and revalidated. | [`library.e2e.ts`](../apps/frontend/e2e/library.e2e.ts) | `the library lists its documents`, `a picture is served and revalidated` |

### Visual actions

| # | Scenario | With stand-ins | Live |
| --- | --- | --- | --- |
| V1 | **When** the person asks to see something (a document, a chart of a figure over time, a record). **Then** the assistant puts it on the stage with the right control, and the answer refers to what is on screen. | [`stage.e2e.ts`](../apps/frontend/e2e/stage.e2e.ts); [`tools.test.ts`](../apps/frontend/src/stage/tools.test.ts) | Manual: one request per control your product uses |
| V2 | **Then** everything the assistant can place, a person can open by hand (top bar, chips), and gets the same view. | `stage.e2e.ts`, plus the routes in [`record-routes.ts`](../apps/backend/src/product/record-routes.ts) | Manual |
| V3 | **When** the person refers to what is on screen ("the second one", "that chart"). **Then** the assistant resolves it from the screen's context. | [`live-context.test.ts`](../apps/frontend/src/stage/live-context.test.ts); parity: *a second turn … carries … what is on the screen* | Manual |
| V4 | **When** the model calls a server tool and a stage control in one response. **Then** the tool's result waits for the browser's answer, and the turn continues once. | Parity: *a response that calls a tool of the backend's and a control of the client's at once* | n/a |

### Voice and text behave the same

| # | Scenario | With stand-ins | Live |
| --- | --- | --- | --- |
| C1 | **When** the same question is asked typed and spoken. **Then** the same tools run as the same person, the stage is driven the same way, and the documents drawn on reach the pane as sources. | Parity: *a live session's calls are answered as a typed turn's*; [`voice.e2e.ts`](../apps/frontend/e2e/voice.e2e.ts) | `a live session opens, is sent silence and ends cleanly` (the opening only: it says nothing, so no tool runs and nothing is written); the rest manual, one spoken question per tool you ship |
| C2 | **When** a live session ends. **Then** what was said is in the conversation, and a typed turn after it continues from it. | `voice.e2e.ts`; [`transcript.test.ts`](../platform/voice/src/voicelive/transcript.test.ts) | Manual: speak a turn, close the channel, read the lines in the conversation, then type a question that depends on them. The scripted session is sent silence and writes nothing |
| C3 | **Given** a person's stated language. **Then** both channels answer in it. | The language directive in [`prompt.test.ts`](../platform/prompt/src/prompt.test.ts); the session's language in [`voice-definition.test.ts`](../platform/agent/src/foundry/voice-definition.test.ts) | Manual, one session per language you ship |
| C4 | **When** Redis isn't configured. **Then** voice is not offered and typed chat works. | The voice capability route in [`app.flow.test.ts`](../apps/backend/src/app.flow.test.ts) | None; CI only |
| C5 | **When** a person speaks a turn. **Then** the voice is heard, and the answer begins, within the waits you have set for each. | The turn's timings in [`turn-timing.test.ts`](../platform/voice/src/broker/turn-timing.test.ts); *each turn writes what it made the person wait* in `broker.redis.test.ts` | Manual: a dozen turns on each engine you ship, some of them calling a tool, then the `voice_turn` query in [operations](operations.md#voice-turn-timings): `first_p95` and `answer_p95` against your waits. The numbers stop at the service's first audio; listen for what the browser adds |
