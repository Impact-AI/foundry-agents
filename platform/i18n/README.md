# @platform/i18n

This package decides which language a person gets, on every channel they can use. It imports nothing, so a page, a route handler, a worker and a voice session share one answer.

- `registry` — `defineLocales` validates the product's list once: bare lowercase subtags (so every code is also what speech-to-text takes as its `language`), an endonym for people and an English name for models, a default among them, the cookie name. With no argument it is English only; the list is always the product's.
- `cookie` — the stated choice, or **null when none was stated**. Null is not the same answer as the default: it decides whether the browser gets a say. A value that is not a supported locale, or is not valid percent-encoding, counts as no choice stated.
- `accept-language` — the browser's preference, q-weighted, region stripped, `*` ignored.
- `resolve` — the one order: stated choice → `Accept-Language` → the default. Never resolve a locale any other way.
- `client-value` — a locale a client sent, narrowed to a supported one. It lands in a prompt above the operator's words, so it is an injection boundary.

Every function takes the registry first. Translation catalogs and their parity are the product's. What a model is told about the language is `languageDirective` in `@platform/prompt`, given `registry.languageName(locale)`.
