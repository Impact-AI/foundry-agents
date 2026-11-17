# Contributing

Thank you for taking the time. Issues and pull requests are welcome from anyone; Impact AI maintains the repository and decides what is merged. This page explains how a change gets into Agent on Azure: what to read first, how to make and test the change, and who reviews it.

## Before you start

- Open an issue for anything bigger than a fix, so the approach is agreed before the work.
- Read [docs/development.md](docs/development.md) for running Agent on Azure locally and [docs/testing.md](docs/testing.md) for the test layers and how CI runs them.
- Read [docs/extending.md](docs/extending.md) if you are adding a tool, a stage control (the stage is the visual workspace beside the conversation), a settings field or a language. Each has a place, and a test that keeps it there.

## What is in scope

Fixes, documentation, tests, and changes that make Agent on Azure easier to deploy, operate or extend. A feature that only one deployment needs, or a change that widens what the demo shape exposes, is better raised as an issue first: it may belong in your fork rather than here.

## A change

1. Fork the repository and branch from `main`. Contributors outside the maintainers work from a fork; nobody receives write access by contributing.
2. Make the change with its tests. A new setting is a row of [docs/configuration.md](docs/configuration.md), which a test holds equal to the code; a new personal-data field is a row of [docs/privacy.md](docs/privacy.md); a new user-visible string goes in every language catalog.
3. Run the whole suite from the repository root, `bun test`, then `bunx biome ci .` (lint, format and import order) and `bun run typecheck`. All three must pass. CI runs these and more: the Bicep linter, the dead-code, duplication and cycle checks, the end-to-end suite and both image builds. They are listed with their commands in [docs/testing.md](docs/testing.md#ci).
4. Write the commit message as a sentence about what is now true, and why if that is not obvious.
5. Open a pull request against `main` and fill in its template. CI runs once a maintainer approves the workflow run for a first-time contributor.

## Who reviews

Every pull request needs one approval from a maintainer other than its author, passing checks and resolved review conversations; a push after approval asks for review again. Changes to sign-in, sessions and roles, the infrastructure and hooks, the images and the workflows also need approval from their code owners ([.github/CODEOWNERS](.github/CODEOWNERS)). Review is best effort, without a guaranteed response time ([SUPPORT.md](SUPPORT.md)).

## License of contributions

Except the Impact SDK setup plugin (`plugins/impact-sdk-setup`, Apache-2.0, [its license](plugins/impact-sdk-setup/LICENSE)), the code and documentation are MIT licensed, copyright Microsoft Corporation ([license](LICENSE)). What you contribute is offered under the license of the part it changes.

## Updating the Impact SDK setup plugin

The plugin is generated from Impact AI's maintained SDK setup workflow. Refresh `plugins/impact-sdk-setup/` and `.agents/plugins/marketplace.json` together with the SDK's packaging tool, keep its version identity and build hashes, and change the maintained sources rather than the generated bundle. Check that Codex installs it, discovers its skill and removes it in a disposable profile, then run the repository checks above.

## What a reviewer looks for

- The code says what it does and the comments say why, where the why is not obvious.
- Nothing authorizes from a request body, a query string or a cookie: who a person is comes from the verified session or the caller assertion ([docs/security.md](docs/security.md)).
- Anything that stores personal data ships with its export and its erasure.
- The documentation describes the current state; history lives in git.
