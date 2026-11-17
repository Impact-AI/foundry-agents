# @platform/llm

This package holds what every call to a model deployment shares, using the process's managed identity and no API key anywhere. That is the token, the one fetch, the settings, the roles and their deployments, the bounds, and the small model that writes a title or a search plan, through the AI SDK's Azure provider.

The chat model belongs to the agent, on Foundry Agent Service (`@platform/agent`), which takes the chat role's deployment, its cap and the retry budget from here. AI Search calls the embedding model itself, so nothing here embeds.

- `azure-auth` — the Entra token for the Cognitive Services scope, cached and shared by every call, and the provider that presents it on every request.
- `provider-fetch` — the one fetch every provider request goes through, whichever client assembles it. It is also where a test stands in for the provider.
- `config` — every setting, as one document: compiled-in defaults, with the `llm` key in App Configuration merged over them field by field, refusing anything that would remove a bound. The deployments the environment names sit beside them, read once per process.
- `model-roles` — `defineModelRoles`, the one way a package names its roles: a variable per role, and `ModelNotConfiguredError`. An unnamed role is a typed refusal before any bytes leave; the package never guesses and never uses another role's deployment. A sibling package with roles of its own makes a second table.
- `deployment` — this package's three roles, as one call of it.
- `bounds/` — what every model carries: `limiter` (a process-wide cap read live from the settings), `retry` (a budget with full jitter, `retry-after` honored up to a cap, ended by the request's own abort signal), and `concurrency` (the cap as middleware, held for the whole of a stream).
- `usage` — the AI SDK's usage block read into the numbers `@platform/observability`'s usage line carries, and the middleware that times each call and emits one line through it. The line, its turn scope and its `LLM_USAGE_LOG` switch are that package's; nothing here knows how a line is written.
- `models/` — `smallChatModel` on the Responses API, wrapped in one fixed order: retries outermost so a backoff holds no slot, then the cap, then the usage line so a wait is never counted as latency. `roleLimiter(role)` is the cap a caller outside the AI SDK holds itself (the agent, for the chat role). `reasoningOptions(effort)` is the reasoning cap as the provider reads it, written in one place. A role whose spec says `reasoning: true` is told so on every call, since the provider would otherwise guess from the deployment's name.

## Settings

Bootstrap comes from the environment, the only place a deployment is named. A deployment name is a fact about one account, and one fact has one source:

| Variable | What it names |
| --- | --- |
| `AZURE_OPENAI_RESOURCE_NAME` | The account every deployment is on. |
| `AZURE_OPENAI_CHAT_DEPLOYMENT` | The chat model. |
| `AZURE_OPENAI_SMALL_CHAT_DEPLOYMENT` | The model for work the chat model is a waste on. Its own slot, not an alias. |
| `AZURE_OPENAI_EMBEDDING_DEPLOYMENT` | The embedding model, which AI Search's skillset and vectorizer call. |
| `AZURE_OPENAI_EMBEDDING_DIMENSIONS` | Its vector width (default 3072). It must equal the search index's vector field, which cannot be resized, so it is the environment's and never the store's: a stored `embeddings.dimensions` is ignored. |

Everything else is the `llm` document in App Configuration, read through `@platform/config`'s cached reader (refreshed once per settings refresh interval, `CONFIG_TTL_MS`, 30 s), with these defaults:

| Field | Default | Meaning |
| --- | --- | --- |
| `retry.maxRetries` | 3 | Further attempts per call after the first. |
| `retry.initialDelayMs` | 2000 | Wait before the first retry, jittered over its window. |
| `retry.backoffFactor` | 2 | Multiplier per retry. |
| `retry.maxHonouredDelayMs` | 60000 | The longest a provider's `retry-after` is obeyed for. |
| `concurrency.chat` | 16 | Calls in flight at once per process, per role. |
| `concurrency.smallChat` | 8 | |

A field of the wrong type keeps its default. Without a store, the defaults and the environment are the answer.

## Tests

`bun test platform/llm`. A stand-in replaces the provider at its one boundary, the fetch it makes requests through, so the token, the bounds, the usage line and the request the provider assembles all run for real. The stand-in, the recorded requests and the canned answers are exported as `@platform/llm/testing`, so a package built on these calls tests at the same boundary.
