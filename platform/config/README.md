# @platform/config

This package is how a process reads its configuration on Azure: environment variables for bootstrap, and the operator's settings documents in Azure App Configuration for everything else.

- `env` — typed reads of environment variables that can never yield `NaN` or switch a bound off: `envInt`, `envString`, `envFlag` (unset or blank is the reader's default, only `0`/`false`/`no`/`off` is off; `isOn` is the same read of a value already in hand), and `configTtlMs`, the one settings refresh interval.
- `app-configuration` — the operator's settings in Azure App Configuration, read keylessly with the process's managed identity. `seedConfigDocuments` writes documents only where a key is absent or holds `{}`, conditionally, so an operator's edit is never overwritten. Secrets are not here; the platform injects them as Key Vault references on the container.
- `config-key` — one cached, fail-soft reader for a stored document. Its rules:
  - It serves the compiled-in default until the store first answers, the last good value over a failed refresh, and refreshes on a bounded deadline.
  - A refresh that failed while a last good value is held is not repeated for five seconds, so a store that goes down costs one caller its deadline. With nothing held yet, that wait is a fifth of a second.
  - Callers that arrive together share the one read and its one warning.
  - An `invalidate` lets a read already in flight answer its caller, but that read changes nothing held, in the in-process cache or the shared cache.
  - A checkout with no `APP_CONFIG_ENDPOINT` and no injected client reads as "nothing stored" and warns nothing.
  - The cache belongs to the definition, not the store key, so two readers of one key never serve each other's parsed value. A reader defined per call holds its definition on `singleton`.
  - Every cached value is served for `CONFIG_TTL_MS` (30 s). A definition pins `ttlMs` in code only when its document changes at a different speed, and nothing else may change its interval.
- `merge` — `mergeOverDefault`, the one parser every settings document is written with: a stored document merged over its default leaf by leaf, keeping a leaf only when it passes the rule for its path. That rule is the default's kind, or the rule `accept` names for that path (a zero allowed, a whole number, a window, a closed list). Nothing stored can remove a bound; what was refused is reported back for the caller to say once.
- `azure-errors` — how every Azure SDK says "not found", "forbidden" and "precondition failed", so no package reads a status code of its own.
- `singleton` — one instance per process, keyed by name, which a development server's module re-evaluation reuses rather than rebuilds. Every per-process registry in the tree goes through it.
- `report` — the one format of a failure line, `[scope] what: reason`, and a throttled variant for a failure that happens per request.
- `deployment-guard` — refuses to start a process that serves people if its environment is unsafe. That covers a Container Apps replica, or the production image (`NODE_ENV=production`) wherever else it runs. It names each offending variable and never what it holds: a toggle is said to be on, a named thing to be set, and only a rule's own refused value is printed. Dependency-free, so it runs in an edge runtime.

Environment variables carry only bootstrap: `APP_CONFIG_ENDPOINT`, `APP_CONFIG_KEY_PREFIX` (default `app/`), `APP_CONFIG_TIMEOUT_MS` (2000), `CONFIG_TTL_MS` (30000) and the identity `DefaultAzureCredential` resolves. Everything an operator tunes is a key in the store.

`./env`, `./merge`, `./singleton` and `./deployment-guard` are separate entry points because they are dependency-free; the root entry pulls in the Azure SDKs. `./testing` installs a store client for a test.
