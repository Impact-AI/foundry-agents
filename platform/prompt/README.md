# @platform/prompt

This package assembles everything the model is told before the first user message, in one place and in one order.

1. **Guardrails** — what the agent is and what it declines. Code-owned structure around operator-tunable slots: a slot can be retuned, never emptied, and never used to write prompt.
2. **Identity and behavior** — the operator-edited persona, then the channel instructions for the channel this turn is on. Those are the per-channel instructions in `apps/backend/src/product/surface.ts`, in a written register for typed turns and a spoken one for voice ([architecture](../../docs/architecture.md#a-typed-turn)).
3. **Personalization** — the date, who the person is, what they wrote about themselves, what is remembered about them, the language they chose, what is on their screen. It tells the model how to pitch an answer, never what it may answer.

`composeSystemPromptParts` returns the prompt split where a managed agent's version ends: `fixed` (parts one and two) and `personalization` (part three), each with `{{` broken (`escapeTemplate`) so nothing an operator or a person wrote can name a template variable of the service's. `composeSystemPrompt` is the two joined, for a channel that sends the whole prompt itself.

The product supplies the words: the guardrail slot specs and defaults with the frame that renders them, the persona template and budget, the channel list. This package supplies the mechanism and the one scrub every quoted text goes through. The root is pure, with no dependencies, so a web app and a service compose the same prompt.

`@platform/prompt/store` is where the operator's words are read from, for a service:

- `definePrompt` — a versioned prompt in the Cosmos DB container `prompts`, partitioned by its key.
  - Documents sharing a key are versions, and exactly one is active. A read resolves it through one cache. It falls back to the product's default text when no version answers, or the database cannot be read or does not answer within two seconds.
  - A version's id is its label, so a label is used once per key. `seed` writes the default as the first active version, `v1`, where the key has none.
  - `publish` makes a new version the active one, and `activate` makes an earlier one active again. Each runs in one transactional batch that switches the active version off only if it still carries the etag it was read with. So two writes at once cannot both win, and none leaves two versions active or none.
  - `promptContainers` declares the container.
- `defineSkills` — the skills, versioned in the same container under the key `skills`, so every skill's active version is one query of one partition.
  - A version holds a skill's description, instructions (under `prompt`, the field the index leaves out), `surfaces`, `requiresTools`, `enabled`, and its origin: `shipped` when the code wrote it, `custom` when an operator did. Each skill has exactly one active version, switched in one transactional batch as the persona's is; a version's id is `<name>@v<n>`.
  - `read` serves the active, enabled versions through one cache, and the product's defaults while none is stored or the database cannot be read. `seed` writes a default only where no version of its name is stored, so a default changed in code never reaches a running deployment; `reset` publishes it there on purpose.
- `defineGuardrailOverrides` — the `guardrails` document in App Configuration. Every failure resolves to no overrides, which renders the shipped guardrail byte for byte; each slot is validated by the renderer, not here.

The container is the template's, which leaves the text itself out of the index. The tests run on `@platform/cosmos/testing`: in memory, or on the emulator under `COSMOS_TESTS=1`.
