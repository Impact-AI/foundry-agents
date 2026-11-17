
# Development

Read this page when you change the code. It shows how to run Agent on Azure on your own machine, with no Azure at all or against a deployment's services, and the loop and conventions every change goes through.

## Setup

- **Bun**, the version in [`.bun-version`](../.bun-version) — the same one CI, both images and the dev container use.
- **Node.js 26**, the version the frontend's image runs on: the frontend's own server (`bun run dev` in `apps/frontend`, the end-to-end run and the voice relay's tests) is started with `node`.
- Optionally **Redis 7**, and, to run the backend itself rather than `dev-fake`, the **Cosmos DB emulator** (the Linux vNext image, at the tag CI pins; CI also pins its digest). With Docker:

  ```sh
  docker run -d --name agent-redis -p 6379:6379 redis:7-alpine
  docker run -d --name agent-cosmos -p 8081:8081 -p 8080:8080 -e ENABLE_TELEMETRY=false \
    mcr.microsoft.com/cosmosdb/linux/azure-cosmos-emulator:vnext-EN20261008
  ```

- From the repository root: `bun install --frozen-lockfile`. A bare `bun install` re-resolves versions and rewrites `bun.lock`; do that only to upgrade, on purpose. Either install also points your clone's `core.hooksPath` at [`.githooks/`](../.githooks/pre-commit) (the root package's `prepare` script), whose pre-commit hook runs Biome on the staged files; skip it once with `git commit --no-verify`.

Or open the repository in the [dev container](../.devcontainer/devcontainer.json): Ubuntu with `az`, `azd`, Docker and the pinned Bun, dependencies installed, ports 3000 and 4111 forwarded. It installs no Node.js; add it there to run the frontend.

## Run it with no Azure at all

The backend's `dev-fake` launcher runs the real backend app with Foundry Agent Service and the models replaced by stand-ins at the provider's fetch; both of the service's SDKs run for real above it. The launcher:

- keeps the accounts, the persona and the conversation index in memory, or on the Cosmos DB emulator in a throwaway database when `COSMOS_ENDPOINT` and `COSMOS_KEY` name one, as CI's end-to-end job does;
- uses Redis when `REDIS_URL` names one;
- loads the sample library into an in-memory search index that applies the access filter as AI Search does, and adds one document only the group `people-team` may read;
- scripts the service's answers.

The scripted answers drive the stage, the visual workspace beside the conversation: the library on the first turn, a document and a chart on the second, a record and a picture on the third. Each answer is followed by three suggestions. Any message containing "fail" gets a service error. A message asking for a project's "spend by quarter" gets one response that calls a tool of the backend's and two of the stage's at once. After every turn, the memory (the fake's store, or the own store's extractor) keeps two statements.

```sh
# terminal 1: the backend on :4199
REDIS_URL=redis://127.0.0.1:6379 PORT=4199 bun apps/backend/src/testing/dev-fake.ts

# terminal 2: the frontend on :3000, against it
cd apps/frontend
BACKEND_URL=http://localhost:4199 AUTH_SECRET=dev-only-secret AUTH_MODE=local COPILOTKIT_TELEMETRY_DISABLED=1 bun run dev
```

To read the records from a business system rather than the sample records module, start its stand-in and give the backend `RECORDS_API_URL` ([worked example](worked-example.md#run-it-locally)).

Open <http://localhost:3000> and sign in with any name. A local frontend listens on your machine alone, as `localhost`; set `HOSTNAME` to have it listen elsewhere, and `AUTH_URL` to the origin it is then reached at. Without `AUTH_SECRET` on the backend, the backend verifies no caller and every sign-in lands on one local account. Give both processes the same `AUTH_SECRET` and every sign-in is its own person, as on a deployment. To see the voice panel without a microphone, build the frontend with `NEXT_PUBLIC_VOICE_PREVIEW=1` ([`apps/frontend`](../apps/frontend/README.md#check)).

## Run it against Azure services

Point a local backend at a deployed demo mode environment's Foundry project, models, search and storage, keeping Redis and Cosmos DB local (the emulator). You need `az login` as the principal that ran `azd up`, which holds the data-plane roles: Foundry User on the project, Cognitive Services OpenAI User, Search Service Contributor and Search Index Data Contributor, Storage Blob Data Contributor, App Configuration Data Owner. (A hardened deployment's services answer only inside its network.) The local backend runs the deployment's agent: a persona or tool you change locally makes a version of its own beside the deployment's, and the next deploy's job prunes the oldest; with `memory.store` at `foundry` it reads and writes the deployment's memory store under the local accounts' ids.

`apps/backend/.env` (Bun loads it from the app's directory), with values from `azd env get-values`:

```sh
REDIS_URL=redis://127.0.0.1:6379
COSMOS_ENDPOINT=http://localhost:8081
COSMOS_KEY=C2y6yDjf5/R+ob0N8A7Cgv30VRDJIWEHLM+4QDU5DE2nQ9nDuVTqobD4b8mGGyPMbIZnqyMsEcaGQy67XIw/Jw==   # the emulator's well-known key
AUTH_MODE=local
FOUNDRY_PROJECT_ENDPOINT=<FOUNDRY_PROJECT_ENDPOINT>
FOUNDRY_RAI_POLICY=<FOUNDRY_RAI_POLICY>
APP_CONFIG_ENDPOINT=<APP_CONFIG_ENDPOINT>               # or leave unset for the compiled-in defaults
AZURE_OPENAI_RESOURCE_NAME=<AZURE_OPENAI_RESOURCE_NAME>
AZURE_OPENAI_CHAT_DEPLOYMENT=chat
AZURE_OPENAI_SMALL_CHAT_DEPLOYMENT=small
AZURE_OPENAI_EMBEDDING_DEPLOYMENT=embedding
AZURE_SEARCH_ENDPOINT=<AZURE_SEARCH_ENDPOINT>
AZURE_SEARCH_INDEX=<AZURE_SEARCH_INDEX>                 # the deployment's own index, read-only from here
AZURE_STORAGE_ACCOUNT=<AZURE_STORAGE_ACCOUNT>
```

Web search is the project's own tool, so it runs locally against a real project too, and is billed there: take `webSearch` out of the `tools` document's `enabled_tools` list if you would rather it did not ([configuration](configuration.md#tools)).

```sh
cd apps/backend
bun run emulator                        # the emulator's database and containers
bun run dev                             # :4111, reloading on change
```

Then the frontend as above with `BACKEND_URL=http://localhost:4111`. The local backend searches the deployment's own index and reads its pictures from the deployment's `library` container: a library is those two and nothing else, so your local emulator needs none of it. Load and remove documents with `ingest.sh` as for the deployment ([documents](documents.md#load-a-library)); the job does the loading, inside Azure. An index of your own would need the job's `index` and `library` steps run from your shell. It would also need the Cognitive Services User role on the model account for the shield step, which the template gives the job and not the operator. Without `AUTH_SECRET` (and outside `NODE_ENV=production`) the backend verifies no caller; that is a development convenience the deployment guard makes impossible in a deployed replica.

## The documentation site

These pages are also a site: [`site/`](../site/index.md) holds its landing page and its VitePress configuration, and renders the pages of `docs/` where they are, so a page is written once, here. A link from a page to code (`../apps/…`) opens that file on GitHub; a link to another page stays on the site, and a dead one fails the build. The site is its own package, outside the root's workspaces:

```sh
bun install --cwd site --frozen-lockfile
bun run --cwd site dev     # http://localhost:5173/foundry-agents/
bun run --cwd site build   # site/dist, as published
```

[`.github/workflows/pages.yml`](../.github/workflows/pages.yml) builds it on a pull request that touches `docs/` or `site/`, and on `main` publishes it to GitHub Pages, which the repository's settings must have on with GitHub Actions as the source. A public repository's site is at `https://<owner>.github.io/foundry-agents/`; a private one's is at an address of its own that only the organization's members can open, and the workflow builds for whichever path Pages names. The landing page shows each maker's logo from `site/public/logos/` (`impact-ai.svg`, `microsoft.svg`), and its name as text while the file is absent.

## Conventions the build holds you to

- **Bootstrap or setting.** A new value that names a resource or configures one replica is an environment variable in the app's `.env.example` and the template; anything an operator might tune is a field of a settings document with a compiled-in default ([configuration](configuration.md)).
- **Codes, not sentences, across a boundary.** The backend answers `{ code }`; the frontend's message catalogs (`apps/frontend/messages/`) hold the sentences, in every language.
- **No product vocabulary in `platform/`.** A package says "the agent", "the person", "the product".
- **Stand-ins only at an SDK's boundary**, and a module stand-in goes through `@platform/test-support`'s `standIn`, never a bare `mock.module` factory. Details in [testing](testing.md).
- **Pinned versions.** Never `latest`, `next` or `*`.
- **Formatting and lint** are Biome: `bunx biome check --write <path>`.
