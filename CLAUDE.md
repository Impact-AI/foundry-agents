Default to Bun instead of Node.js.

- `bun <file>` instead of `node <file>` or `ts-node <file>`; `bun test` instead of jest
  or vitest; `bun install` instead of npm, yarn or pnpm; `bunx <package>` instead of npx.
- Bun loads `.env` on its own; do not add dotenv.
- `Bun.serve()`, `Bun.file`, `Bun.$`, the built-in `WebSocket` and `fetch` before a
  package that does the same. For the Bun API, read `node_modules/bun-types/docs/**.mdx`.

## Testing

**Run `bun test` from the repository root, and it must exit 0.** There is no tolerated
failure baseline: `.github/workflows/ci.yml` runs `bun test` over the whole tree, with
coverage reported and never gated. A run from an app
directory skips the root `bunfig.toml` preload (`scripts/test-preload.ts`, which gives
Next the `AsyncLocalStorage` its server bootstrap installs) and fakes failures in files
that name nothing to do with it.

A stand-in for a module's export must hand the real module back: `mock.module` registers
process-wide and permanently, and every file runs in one process. Build the factory's
module with `@platform/test-support`'s `standIn` and release it in `afterAll`, never a
factory that returns a fixed object (`docs/testing.md` has the form).

The suites whose subject is Redis skip without a server (`REDIS_URL`); the Cosmos DB
suites run against an in-memory stand-in unless `COSMOS_TESTS=1` names the emulator; the
template's compiled checks skip without a Bicep CLI (`bicep` on `PATH`, `BICEP_CLI`, or
`az bicep`; a `BICEP_CLI` that names no file fails rather than skips). A skipped suite is indistinguishable from a passing one in the log, so CI
provides all three. Single tests also skip without `node`, `dash` or `pwsh`
on `PATH` (`docs/testing.md` names them).

## Dependencies

CI and both Dockerfiles install with `bun install --frozen-lockfile`, so the lockfile, not
the registry, decides what a build gets. Never write `latest`, `next` or `*` as a version, in a dependency, an override, a
resolution or an `npm:` alias (`scripts/dependency-pins.test.ts` fails the build). A bare `bun install` is the upgrade:
run the tests and commit the lockfile with it. `.bun-version` is the one Bun version for
the workflows, the images and the dev container (`pipeline.test.ts` holds them equal).

## One source per fact

Every parameter, variable and settings field is documented in `docs/configuration.md`,
and `docs/configuration.test.ts` fails when the page and the code disagree on a name or
on a default that is a literal (a rule or an effect is prose no test reads, so check it
by hand); every relative link in the pages, the root's Markdown files and the READMEs
resolves (`docs/links.test.ts`); each app's environment is exactly what its
`.env.example` lists (`infra/app-env.test.ts`). When you add one, change all the places
the tests name, in the same change — never a second copy of a list anywhere else.

## Prose

This is a template: the documentation, the READMEs and the comments say what is true
and why, never what happened on a particular deployment. No dated readings, no
environment names as the place something happened, no pointers into an engineering
record; a limit known only from the service's behavior is stated as such, as a general
note. `scripts/template-prose.test.ts` holds the dates and the record pointers to that.

## Layout

`docs/repository.md` is the map: `platform/*` (the packages, `@platform/*`), `apps/backend`
and `apps/frontend`, the azd template at the root (`azure.yaml`, `infra/`, `hooks/`,
`scripts/`), and `docs/`. Packages depend downwards only; nothing in `platform/` imports
an app, and nothing the product needs goes in `platform/`.
