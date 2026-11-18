# Extending

This page shows a team building its assistant on Agent on Azure where each kind of change goes: the product file and folder, tools, stage controls, skills, settings, languages, another agent host and other document types. The stage is the visual workspace beside the conversation.

## Make it yours

The backend's part of the assistant lives in [`apps/backend/src/product.ts`](../apps/backend/src/product.ts) and `apps/backend/src/product/`. A customer's product usually reaches further:

- a new panel adds frontend code and strings ([a stage tool](#a-stage-tool));
- a language adds a catalog ([a language](#a-language));
- branding is mostly the [`appearance`](configuration.md#appearance) settings document, over shipped defaults in [`apps/frontend`](../apps/frontend/README.md) code (see below);
- a business system can add environment variables and infrastructure ([the worked example](worked-example.md)).

| In `product.ts` | What it is |
| --- | --- |
| `AGENT_ID`, `SERVICE_NAME` | The agent's id on the wire, and the name the service reports in telemetry and prefixes its Redis keys with. |
| `locales` | The product's languages, from `product/locales.ts`: the one list both apps read (see [A language](#a-language)). |
| `prompt` | The persona's default text: the first version the migrate job seeds, and the fallback when the `prompts` container has no active version for `assistant`. |
| `guardrails` | The guardrail slots (`scope`, `declines`), their defaults and the frame around them. |
| `TOOLS` | Every server-side tool, by the key the `tools` document switches it off by. `WEB_SEARCH` is beside them in `toolKeys`: the service's own web search tool. |
| `skills` | The active skills from the skills' store (`defineSkills`), which Agent on Azure seeds with none; see [A skill](#a-skill). |

The rest of the folder:

- `product/surface.ts` holds the channel instructions: the per-channel instructions that describe the stage and the tools to the model, in a written register for typed turns and a spoken one for voice ([architecture](architecture.md#a-typed-turn)).
- `product/stage-tools.ts` defines the stage's controls, and `product/library.ts` renders the knowledge base for the stage.
- `product/surfaces.ts` names the surfaces a turn comes from, `product/voice.ts` holds the live voice's phrases and `product/locales.ts` the languages.
- `product/sample/` holds the fictional records the record tools read and the sample library the job loads.
- `product/library-routes.ts` and `product/record-routes.ts` hold the routes the stage reads directly.

Replace them and keep their interfaces. Nothing outside `product.ts` and the folder imports from it. The app reads the routes, the library the job's `library` step loads, the surfaces and the languages off the product's object (`src/backend-product.ts`), and `src/product-boundary.test.ts` holds that.

The brand can be settings or code. As settings, the [`appearance`](configuration.md#appearance) document changes the color scheme, the palette, the font, the type scale, the spacing, the corners, the assistant's name and welcome line per language, and the logo. An operator edits it in App Configuration or Impact AI Admin Center, with no deploy, and the edit is live within about a minute. A palette that would make text unreadable is refused. As code, the frontend's token sheet (`apps/frontend/app/globals.css`) and its catalogs (`apps/frontend/messages/`) are the shipped look and words that the document is drawn over. To change a token, change it there in both schemes and the shipped value in `platform/appearance/src/palette.ts` or `tokens.ts` with it (`apps/frontend/app/appearance.test.ts` holds the two equal). To change the name and heading, change them in every catalog.

## A server-side tool

A tool the agent calls on the server, such as a lookup in your own system. The [worked example](worked-example.md) builds one end to end: the record tools reading a business system over HTTP, as the person asking.

1. **Write it** in `apps/backend/src/product/tools/<name>.ts` with `productTool` from `@platform/agent`: a description that says when to reach for it, Zod `parameters` with bounds on every field, and an `execute` that returns data, never prose for the person. Export its key as a constant. The host validates the model's arguments against `parameters` before `execute` sees them, and nothing in the tool names the service. `lookup-record.ts` is the pattern.
2. **Ask who is calling** with `currentTurn()` from `@platform/agent` — the account id, the surface, the language, and the verified caller (`oid`, `groups`, `tier`) — never from the tool's input. A tool that spends money meters itself (`meterCall` from `@platform/metering`) and every outbound call is bounded by a deadline and, for a model, the `llm` concurrency caps.
3. **Register it** in `TOOLS` in `product.ts` under its key. The product's `toolKeys`, which a new deployment's `tools` document switches on, are read off that registry, so this is the one place a tool is added. Two lists name every key on purpose and fail until they name the new one: the expectation in `apps/backend/src/product.test.ts`, and the `enabled_tools` default in [configuration](configuration.md#tools), which `docs/configuration.test.ts` holds to the code.
4. **Tell the model** when to use it: add a line to `SERVER_TOOLS` in `product/surface.ts`. The channel instructions mention a tool only on a turn that has it.
5. **Switch it on in deployments that already exist.** The `tools` document is seeded once; a stored `enabled_tools` list does not gain new keys. Add the key to `app/tools` → `enabled_tools`, or the tool stays off there. New deployments get it on.
6. **Test** the tool's own logic as a unit, and its wiring in `apps/backend/src/app.flow.test.ts` or `product.test.ts`, with the service stood in for at its fetch.

The tool's definition is part of the agent version, so the first turn after a deploy that adds it makes a new version (or the job's `agent` step does, before traffic). A tool runs in the backend: the service's response ends with its call, the backend runs it in the turn's scope, and its output is the next response's input.

A live voice session reaches the same tools. The voice agent's version carries every function tool of the `live` surface. Its calls reach the replica that holds the session's socket, which runs a server tool in the person's scope exactly as a typed turn does. The tool needs no second definition for voice. A tool left out of the `live` surface is not offered there, and what a realtime model supports is in [limitations](limitations.md); check the tool by voice as well as typed ([acceptance](acceptance.md#voice-and-text-behave-the-same)).

## A stage tool

A control the assistant drives in the browser: it puts something on screen and answers with a status line. Whatever the agent can place, a person can also open by hand. So a new control that places something gets a way in from the interface (a mark on the bar, a chip on a card) that calls the same handler. The server side it reads gets a route the interface can reach, as the tool's function does. For example, `product/record-routes.ts` wraps `listRecords` and `metrics` for the Records mark and a card's figure chips, mounted by the product's `routes`.

1. **Define it** in `apps/backend/src/product/stage-tools.ts`: a name constant and an entry in `STAGE_TOOLS` with a description and a JSON schema (`additionalProperties: false`). The backend serves the list on `GET /identity/me` and offers it as the product's `clientTools`, the only controls a typed turn may name. It offers them on typed turns and on the voice agent's version, whose calls the backend passes to the person's browser. The channel instructions describe every entry, so nothing else on the server changes.
2. **Accept it in the browser**: add the name to `STAGE_TOOL_NAMES` in `apps/frontend/src/stage/tool-briefs.ts`. The browser registers exactly the briefs the backend sends whose names it knows.
3. **Handle it**: add a handler to `stageToolHandlers` in `apps/frontend/src/stage/tools.ts` (the type makes it required). Read the arguments defensively, dispatch a stage action, and return a short status ending with `withFollowUp`. Add the action and any new section to `src/stage/stage.ts`, and the tile under `app/(app)/stage/`.
4. **Describe what is on screen**: if the new section matters to the next turn, add its line to `src/stage/live-context.ts`.
5. **Strings** go in every catalog in `apps/frontend/messages/`.
6. **Test**: `tools.test.ts` and `tool-briefs.test.ts` for the handler and the brief, an end-to-end test in `apps/frontend/e2e/stage.e2e.ts`, and a scripted turn in `apps/backend/src/testing/dev-fake.ts` if you want to see it without a model.

## A skill

A procedure behind one kind of question, which the agent loads only on the turns that ask it — not a fact true of every turn (that is the persona), nor how to make a call (that is a tool's description).

Skills are versioned in Cosmos DB beside the persona; the code holds only defaults that seed them. There are two ways to add one:

1. **On a running deployment,** with no deploy: write a `SKILL.md` (front matter with `name` and a `description` that says when to use it, then the instructions) and publish it with the [`skills` CLI](operations.md#managing-skills), naming the `--surfaces` it is for and the `--requires-tools` of which any one must be on for a turn to carry it.
2. **As a default in code,** for a skill every new deployment should start with: an entry in `defineSkills([...])` in `apps/backend/src/product.ts`, with a `name`, a `description`, the `instructions`, and optionally `surfaces` and `requiresTools`. The job's `skills` step writes it where no version of that name is stored. A change to it later reaches new deployments only; on a running one, `skills reset <name>` publishes it.

Both channels read a skill the same way: the backend's `readSkill` function tool, whose description lists the skills that fit the turn (enabled, on its surface, with a required tool on), and which answers a skill's instructions. A typed turn has it as a server tool and a live session as one of the voice agent's functions (`platform/agent/src/skills/skills.ts`). Leave `live` out of a skill's `surfaces` only when the procedure should not run in voice; a skill written in the typed tool vocabulary needs no second copy for voice.

`skills_enabled` in the `tools` document switches every skill off on both channels.

## A settings field

A number or switch an operator should be able to change while the service runs.

1. **Add it to the owning package's default** — for example `DEFAULT_AGENT_SETTINGS` in `platform/agent/src/settings.ts` — and to its type. The merge walks the default's structure, so the field is readable from the store with no other wiring.
2. **Give it a rule** if the default kind's is wrong: a number is accepted only when finite and positive (whole, in most documents); name `nonNegativeInteger`, `integerBetween`, `numberBetween`, `oneOf` or `stringList` from `@platform/config` in that document's `accept` table. No rule may let a stored value remove a bound.
3. **Read it** through the document's reader (`agentSettings()`, `knowledgeSettings()`, `getLimits()`…) at the point of use, never once at start-up, so an edit is live within about 30 seconds.
4. **Document it**: a row in [configuration](configuration.md#settings-documents) with its default. `docs/configuration.test.ts` fails until the row exists.
5. Existing deployments serve the default until someone stores a value; the settings step never rewrites a stored document.

**A new settings document**: define it with `defineConfigKey({ key, defaultValue, parse })`, parsing with `mergeOverDefault` from `@platform/config`; add it to `configDocuments()` in `apps/backend/src/config-documents.ts` so the migrate job seeds it; add a `` ### `name` `` section to configuration.md.

**A new environment variable** is for bootstrap only (a resource, a deployment, an identity, an endpoint, a secret, or the sizing of one replica): add it to the app's `.env.example`, to the template's env list in `infra/modules/<app>.bicep`, and to configuration.md. `infra/app-env.test.ts` and `docs/configuration.test.ts` hold the three together.

## A language

The frontend ships English, Italian, Spanish, French and German.

1. **The list:** add `{ code, label, languageName, accent }` to `locales` in `apps/backend/src/product/locales.ts` — a bare lowercase subtag (`de`, not `de-DE`), the language's own name for the switcher, its English name for the model, and the accent (`de-DE`) the live voice speaks it with. It is the one list. The frontend imports it (its image copies that file alone, so keep its only import `@platform/i18n`). It resolves each request's language against the list: the stated choice, then `Accept-Language`, then the default. It sends the answer to the backend as `Accept-Language` on every call, and that is the language the model, the transcriber and the live voice are given.
2. **Catalog:** add `apps/frontend/messages/<code>.json` with every key `en.json` has. `catalogue-parity.test.ts` fails on a missing key, on a catalog the list does not name, or on a code with no catalog.
3. Update the privacy notice's sentences in the new catalog with the same care as the English: they are a description of what is kept, not marketing copy.

The model is told the language by its English name, after everything else in the prompt; transcription is pinned to the code, not detected.

## A second agent host

The backend talks to the agent through one interface, `AgentHost` (`platform/agent/src/contract/host.ts`); the Foundry Agent Service implementation (`platform/agent/src/foundry/`) is the one Agent on Azure runs. Another goes like this:

1. **Implement `AgentHost`** in a sibling folder of `platform/agent/src/foundry/`, constructed from the same `AgentProduct`. Build it on the shared core beside the contract — the admission and its guards (`turn/admit`, `coordination/`), what a turn may carry (`turn/input`), the person's reads (`person/`) and the prompt's assembly (`instructions`, which composes through `@platform/prompt`) — so every host guards, refuses and says the same things about a person.
2. **Pass the [parity suite](patterns.md#terms).** Write a `ParityFactory` (how to create a host, a person, script the service's answers, and read what it was sent) and register it with `describeAgentHostParity` from `@platform/agent/parity`. The suite is written against the interface alone. It checks:
   - the three guards in order, and refusals as values;
   - streams that end with `finish` or a cause-free `error`;
   - a backend tool's call and result, a client control's call ending the run and its answer continuing it, and a response that calls both;
   - reasoning before text, a picture sent once, and a blocked turn;
   - ownership on every read and write;
   - what is remembered: read into the next turn, corrected, removed, forgotten;
   - erasure that reports clean on a retry.

   `platform/agent/src/foundry/testing/parity-factory.ts` is the Foundry one.
3. **Prove what the interface cannot show** in the implementation's own suite, as `foundry/host.test.ts` does: what it sends and never sends, its caches, its fallbacks, and what an erase reaches.
4. **Swap it in** where `apps/backend/src/index.ts` calls `createFoundryAgentHost`, and change the job's `agent` step to make what the new host needs before traffic. The typed channel's protocol does not change: the backend serves [AG-UI](patterns.md#terms) over `startTurn` (`@platform/agent/agui`), and the frontend's runtime reaches it with `HttpAgent` whichever host answers. What does change is outside the interface. One part is the infrastructure in `infra/` that makes the Foundry account and project. The other is live voice, whose binding speaks the Voice Live protocol in `platform/voice` and has no alternative shipped ([which choices are flexible](adapting.md#flexible-and-azure-specific-choices)).

## A new document type

AI Search's indexer cracks the files: PDF, Word, PowerPoint, Excel, HTML, Markdown, text and CSV, and PNG, JPEG and GIF pictures by OCR ([documents](documents.md#a-library)).

- **A format the indexer cracks:** add its extension to `DOCUMENTS` or `PICTURES` in `platform/knowledge/src/library/formats.ts` with the content type it is stored under; the indexer's `indexedFileNameExtensions` follow from those lists. Check one file end to end on a deployment: the stand-in indexer does not crack binaries.
- **A format it does not:** convert first (Azure AI Document Intelligence's layout model produces Markdown with headings and tables), keep its pictures beside it, and load the directory. A custom skill in the skillset (`skillsetDefinition` in `platform/knowledge/src/pipeline/definitions.ts`) is the in-pipeline route, at the cost of a Web API you host.
- **A picture found by what it shows,** not only by its text, needs a description: say it in the alt text of a document that shows it, or in `catalog.json`. A vision-captioning skill is the in-pipeline route and a cost on every picture.
