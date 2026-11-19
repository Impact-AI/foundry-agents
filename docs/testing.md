# Testing

This page tells a developer changing the code, and the reviewer of the change, what the test suites cover, how each layer runs and what CI gates.

Every test runs with `bun test` from the **repository root** (the root's `bunfig.toml` preloads what the suites need), and the whole run must pass. Suites whose subject is a server (Redis, the Bicep compiler) skip when it is absent and run when it is there. The Cosmos DB suites run in memory without the emulator and on it when it is there. CI runs all of them, on every server.

A few single tests skip without a program on `PATH`:

- the voice relay's (`apps/frontend/server/relay.test.ts`) without `node`;
- the POSIX shell check (`hooks/shell.test.ts`) without `dash`;
- the PowerShell half of every hook and script test (`hooks/*.test.ts`, `scripts/ingest.test.ts`, `scripts/smoke.test.ts`, and the end-to-end smoke run in `apps/frontend/e2e/smoke.e2e.ts`) without `pwsh`.

The PowerShell versions of the scripts run on Linux locally and in CI, so a rule, rather than a run, covers what a Windows command line does to an argument. No argument a PowerShell version hands `az` or `azd` may hold a double quote, or an ampersand outside a quoted text, because `az.cmd` would lose either (`hooks/windows-arguments.test.ts`).

## Layers

| Layer | What it proves | Files | Needs |
| --- | --- | --- | --- |
| Unit | Pure modules: parsers, the settings merge, prompt composition, the stage reducer, the voice state machine… | `*.test.ts`, `*.test.tsx` | nothing |
| Cosmos DB | What the stores rely on the service to do, then the accounts and the persona's and the skills' versions through their own functions ([details](#cosmos-db)). | `platform/cosmos`, `platform/identity`, `platform/prompt` | nothing: in memory. With `COSMOS_TESTS=1`, `COSMOS_ENDPOINT` and `COSMOS_KEY`, the same suites on the emulator, each in a database of its own |
| Knowledge | A library loaded through the job's own steps, then searched through the real query code ([details](#knowledge)). | `platform/knowledge/src/**` | nothing |
| Redis | Buckets, the live-voice seconds count, claims, the cache shared across replicas (`sharedMemo`), the fallbacks when Redis vanishes | `*.redis.test.ts` | `REDIS_URL` |
| The agent on Foundry | The host against the fake Foundry, a strict stand-in for the service at its HTTP boundary, with both SDKs running above it ([details](#the-agent-on-foundry)). | `platform/agent/src/foundry/**` | `REDIS_URL` |
| Agent parity | The `AgentHost` contract, written against the interface alone, run against the Foundry implementation on the fake, once per memory store | `platform/agent/src/contract/parity.test.ts` | `REDIS_URL` |
| The backend app | Every route of the real app, on Redis, Cosmos DB as above and the fake Foundry, the models stood in for at the provider's fetch | `apps/backend/src/app.flow.test.ts` | `REDIS_URL` for the paths shared across replicas |
| Template | `infra/main.bicep` compiled and read as data; the hooks and scripts run against stand-ins, through both the shell and the PowerShell version ([details](#template)). | `infra/*.test.ts`, `hooks/*.test.ts`, `scripts/*.test.ts`, `build-context.test.ts`, `pipeline.test.ts` | the Bicep CLI on `PATH`, in `BICEP_CLI`, or `az bicep`; compiled checks skip without one, and fail on a `BICEP_CLI` that names no file. `pwsh` for the PowerShell half of the hook and script tests |
| Documentation | Every parameter, variable and settings field named in [configuration](configuration.md) and nothing more, with the defaults that are literals in the template or the code; every relative link in these pages, the root's Markdown files and the READMEs | `docs/*.test.ts` | nothing |
| End to end | The frontend's production build, served as its image serves it, against the backend's `dev-fake` launcher, driven through Chromium ([details](#end-to-end)). | `apps/frontend/e2e/*.e2e.ts` | Redis, Chromium; the Cosmos DB emulator when `COSMOS_ENDPOINT` and `COSMOS_KEY` name one, in memory otherwise |
| Smoke | A deployed environment answers and refuses what it should | `scripts/smoke.sh`, `smoke.ps1` | a deployment; CI runs the two scripts against stand-ins (the Template and End to end rows), never against a deployment |
| Deployment check | A deployed environment as the template meant it ([details](#deployment-check)). | `scripts/verify-deployment.ts` | a deployment, `az` and `AZURE_SUBSCRIPTION_ID` (and `VERIFY_SESSION_COOKIE` or `--signed-out-only` under `entra`); CI runs it against stand-ins, never against a deployment |

### Cosmos DB

The shared suite asserts against the container surface alone (`platform/cosmos/src/testing/contract.ts`) that:

- a document is read in its own partition only, and an id is unique within one;
- a patch is refused on a stale etag or a false condition;
- a batch is all or nothing;
- a query runs in one partition, ordered and paged by a keyset;
- a container that is missing or partitioned otherwise is refused at start.

Then it tests the accounts and the persona's and the skills' versions through their own functions.

### Knowledge

A library is loaded through the job's own steps: described into blob metadata, indexed by a stand-in indexer that runs the job's data source, skillset and field mappings, pruned and shielded. It is then searched through the real query code against an index that applies `$filter` as the service does. The suites cover:

- the two-person test (`query/readers.library.test.ts`): two people in different groups each find their own document and never the other's, by search, by id and by picture;
- a local account seeing only `all`;
- prune after a clean run only;
- the 100-reader and 8 KiB metadata caps;
- an unshielded or flagged chunk never served;
- the base64 metadata round trip.

### The agent on Foundry

The fake Foundry stands in for agents and versions, conversations and their items, streamed responses, and memory stores and their long-running update. It is strict, refusing what the service refuses. The suites cover:

- the version a turn runs on and what it holds;
- the requests sent and never sent;
- the tool loop with the browser's controls and a mixed response, and the step limit;
- web search and its charge;
- pictures deleted, and the skill reader in the version a turn runs on;
- the job's steps, and everything an erase reaches.

### Template

`infra/main.bicep` is compiled and read as data. The checks cover diagnostics on every resource, locks, names within Azure's limits, both modes and each override, and each app's environment equal to its `.env.example`. They also cover secrets as Key Vault references, role assignments, the job's steps, the Foundry account's guardrail and the Agent Service's setup, and Cosmos DB's throughput and containers.

The hooks and scripts run against stand-ins for `az`, `azd` and `curl`. Each scenario runs through both the shell and the PowerShell version: the bash script, and the `.ps1` under `pwsh`, which runs it on Linux and macOS as on Windows. Each is expected to make the same calls, print the same words and exit with the same code (`eachTwin` in `hooks/twins.ts`). The smoke script runs against a frontend stood in for by a server in the test. The layer also checks model retirements and the pipeline's variables.

### End to end

The browser tests cover sign-in and the disclosures, a streamed turn and its reasoning, the conversation picker, the stage's tiles, settings and what the assistant remembers, and language and text size. They also cover export and deletion, the voice panel, a restricted document and its picture staying hidden, an accessibility check of each page, and both smoke scripts.

### Deployment check

The check reads a deployed environment's resources and their settings for its mode, the frontend signed out and in, a live session, an erase, and telemetry arriving ([deployment checker](deployment.md#deployment-checker)). CI runs its Azure checks against a stand-in `az` (`scripts/verify-deployment.test.ts`), and its frontend, voice and erase checks against the built app (`apps/frontend/e2e/verify-deployment.e2e.ts`).

### Stand-ins and isolation

Stand-ins sit only at an SDK's or a provider's boundary, and everything above them runs for real:

- the models and Foundry Agent Service at their HTTP fetch;
- the search, indexer and blob SDKs at their clients (`@platform/knowledge/testing`, `@platform/storage/testing`'s `fakeBlob`);
- Prompt Shields at its client (a planted attack string it flags);
- Cosmos DB at the container surface every store is written against, held to the emulator by the shared suite.

The search stand-in evaluates the OData this code writes and throws on anything else, so a filter the service would read differently fails here rather than passing quietly. What the stand-ins cannot prove is checked on a deployment ([below](#what-only-a-deployment-proves)). Tests share nothing: each Cosmos DB suite on the emulator works in a database of its own, each Redis suite sweeps its own throwaway key prefix, and every end-to-end test signs in as a new person, so they run in parallel. No test retries.

**`mock.module` is process-wide and permanent** in `bun test`, which runs every file in one process: a factory that returns a fixed object answers for every later file too, overrides included. A stand-in for a module's export therefore goes through `@platform/test-support`'s `standIn`, which answers with the overrides while the file that made it runs and with the real exports after `release()`. Prefer a stand-in at the SDK's boundary (a package's `./testing` entry) where one exists; no suite in the repository needs a module stand-in.

```ts
import { afterAll, mock } from "bun:test";
import { standIn } from "@platform/test-support";

const real = await import("@platform/llm");
const llm = standIn(real, { smallChatModel: () => fakeModel });
mock.module("@platform/llm", () => llm.module);
afterAll(llm.release);
```

## Commands

```sh
bun install --frozen-lockfile

# everything, with the servers (see development.md for the docker runs)
REDIS_URL=redis://localhost:6379 BICEP_CLI=$(command -v bicep) \
COSMOS_TESTS=1 COSMOS_ENDPOINT=http://localhost:8081 COSMOS_KEY=<the emulator's key> \
  bun test

bun test platform/knowledge                     # one package
bun test infra hooks scripts docs               # the template, its hooks and scripts, these docs
bun test --coverage                             # with a coverage table

bun run typecheck                               # every workspace; delete apps/frontend/.next first if it is stale
bunx biome ci .                                 # lint and format check
bicep lint infra/main.bicep

bunx fallow@3.35.0 dead-code --fail-on-issues   # unused exports, files, dependencies
bunx fallow@3.35.0 dupes --fail-on-issues       # copy-paste
bunx fallow@3.35.0 architecture --cycles --fail-on-issues

# end to end
bunx playwright install --with-deps chromium    # once, in apps/frontend
bun run --cwd apps/frontend e2e:build
REDIS_URL=redis://localhost:6379 bun run --cwd apps/frontend e2e
```


Coverage is reported, never gated: Bun counts only files some test imports, so the figure is the coverage of the code the tests reach, not of the tree.

## What only a deployment proves

The ingestion is Azure's, and the stand-in indexer runs the template's definitions, not the service. After a change to `platform/knowledge/src/pipeline/` or `index/definition.ts`, check on a demo deployment:

- The deploy's `index` step makes the index, `chunks-library`, `chunks-skillset` and `chunks-indexer`, and a second deploy changes nothing.
- A PDF and a Word file load (`ingest.sh`), are found by a phrase from their body, and open in the reader, page by page.
- A picture with text in it is found by that text; a picture with none yields no chunk and no failure.
- On a chunk in the portal's search explorer: `oids`, `groups`, `title`, `summary` and `tags` decoded from the blob's metadata, and `injection: false` after the load.
- Two people in different Entra groups, with `enforceAccessControl` on, each find their own restricted document and not the other's; a `local` sign-in finds only `all`.
- A file deleted from the directory loses its chunks at the next load; an unchanged directory uploads nothing and the indexer reads nothing.
- In hardened mode, the indexer reaches the private storage account (the trusted-service path) and the Foundry account.

The agent is the service's too, and the fake Foundry was written from the SDKs' types and the service's documentation rather than from recorded traffic. It cannot prove the stream's real event names, what the service refuses, how the memory store extracts and erases, or what reaches `enterprise_memory`. Check those on a deployment: a typed turn and a live session answered, nothing of a conversation written to `enterprise_memory`, a thread erased and gone, and what is remembered appearing in Settings and gone after a forget.

## CI

`.github/workflows/ci.yml` runs on every pull request and every push to `main`, with read-only repository access and no Azure credential, every job under a time limit:

| Job | Steps |
| --- | --- |
| Lint, typecheck, test | Lint, typecheck, script checks, then `bun test --coverage` beside Redis and the Cosmos DB emulator (details below) |
| End to end | Chromium, `e2e:build`, `e2e` beside Redis and the Cosmos DB emulator; the Playwright report as an artifact on failure |
| Image (backend, frontend) | `docker build` of each image from the repository root; the frontend's build stage is its `next build`. Then a pinned Trivy over the image's operating-system packages, failing on a high or critical advisory that has a fixed release |
| Dead code, duplication, cycles | fallow, pinned, failing on any finding |

**Lint, typecheck, test** runs `bunx biome ci .` and `bun run typecheck`, has PowerShell parse every `.ps1`, and runs a pinned shellcheck over the bash scripts at warnings and above. It runs a pinned Bicep CLI and `bicep lint`, then `bun test --coverage` beside a Redis and the Cosmos DB emulator (pinned by tag and digest, `COSMOS_TESTS=1`). The coverage summary goes on the run's page and `lcov.info` is kept as an artifact.

`.github/workflows/audit.yml` checks known advisories against the versions the two lockfiles pin, the root's and the site's. It runs on every pull request and push to `main`, and once a week, because an advisory can be published without the repository changing. `bun scripts/dependency-audit.ts` is the whole of it, and runs the same from a checkout. A high or critical advisory fails the run unless `scripts/dependency-audit.accepted.json` accepts it. Each entry there says why what it names is not reached in this code or is bounded another way. An entry the audit no longer reports fails the run until it is taken out. Moderate and low advisories are printed, not gated. The image job's scan reads only what no lockfile pins, so an advisory is accepted in one place.

Dependabot proposes the updates (`.github/dependabot.yml`): the actions, the images' bases, and both lockfiles. In the lockfiles it groups what the apps run on apart from what only builds them, and patches apart from minors. It opens no security updates for Bun, which is why the audit is a job.

Four protections are repository settings rather than files, and a repository made from this template starts without them (Settings → Advanced Security): Dependabot alerts; secret scanning with push protection; private vulnerability reporting, which [security policy](../SECURITY.md) sends a reporter to; and code scanning's default setup (CodeQL) for `javascript-typescript` and `actions`.

There is no `what-if` in CI: it needs a credential on the subscription, which a pull request's code should not hold. `azd provision --preview` shows the plan from a signed-in machine of your own. Deploying is `azure-dev.yml`'s ([deployment](deployment.md#cicd)).
