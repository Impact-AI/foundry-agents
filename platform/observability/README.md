# @platform/observability

This package decides what a process may say about itself in logs and telemetry, and how it says it. Read it to know what reaches Application Insights, what is scrubbed first, and what is not.

- `scrub` — pure and synchronous functions:
  - a path with every segment that looks like a value collapsed to `:id`;
  - a URL reduced to scheme, host, route and an allowlisted query;
  - the attributes that identify a caller, dropped;
  - free text (an error's message, a stack, a status message, a span's name) scrubbed of whatever can be recognized for what it is ([below](#what-the-text-scrub-covers));
  - the probe list, and a stable tag for a value that must not be logged.
- `pipeline` — the scrub applied to every span and log record, whoever produced them. It also holds a sampler that refuses to create a probe span, and a sampler whose ratio is the operator's stored setting, read live. When two producers open a SERVER span for one inbound request, it demotes one so the request keeps one request row.
- `events` — two structured lines, one JSON object on stdout each: a refusal (`problem`, a code from the product's closed list and typed facets, never a sentence) and a model call (`llm_usage`, counts and timings, never text).
  - The usage line's turn scope lives here too. `runInUsageScope` around a turn stamps an id minted for that turn, never an identifier of a person, onto every call the turn makes.
  - `emitUsage` takes numbers a caller has already read out of its SDK, so `@platform/llm`'s middleware and a voice path write the one line through the one writer.
  - Once a provider is installed, each line is also a short span of its own. The samplers here keep it whatever the ratio, at a sample rate of 100, so it is exported whether or not the request's span survives sampling, and is counted once.
- `settings` — the connection string, which is bootstrap and the on/off switch, and the sampling ratio, which is a key in the store under `telemetry`.
- `release` — the resource every span carries: the service and its version, and, as the app hands them in, the release it runs as (`impact.release.id`, `impact.release.version`, `deployment.environment.name`), the Container Apps revision serving it (`impact.release.revision`) and, on Container Apps, `cloud.provider` and `cloud.platform`. The version is the release's while one is set, else the image's tag ([the release on every span](../../docs/configuration.md#the-release-on-every-span)).
- `impact` — a copy of every span to impact.ai through the Impact SDK (`impact-ai`, pinned), on the provider this package builds, when the app hands in the product's endpoint and ingest key. It copies the spans as the scrub left them and adds none: the SDK's integrations and content categories are off. Without both values the SDK is not loaded.
- `bun` — the pipeline for a server on `Bun.serve`: the exporter, one span per request from `withRequestSpan`, and `stopTelemetry` for the signal handler.
- `next` — the Azure Monitor distro from a Next server's `register()` hook, with the same scrub, the probe filter installed on the distro's sampler, and the log instrumentations and Live Metrics off: Live Metrics reads each span ahead of the scrub.

Telemetry is off unless `APPLICATIONINSIGHTS_CONNECTION_STRING` is set: nothing is built, nothing is exported, nothing complains. `PROBLEM_LOG=0` and `LLM_USAGE_LOG=0` switch the two lines off (unset or blank leaves them on). The ratio refreshes once per settings refresh interval (`CONFIG_TTL_MS`, 30 s).

The root entry pulls in no exporter and no distro, only the OpenTelemetry API and the trace SDK's types; `./bun`, `./next` and `./settings` bring the rest.

## What the text scrub covers

`scrubText` runs over an error's message and stack, a span's status message and its name; a log record's body is not put through it. Prose cannot be made safe the way an attribute can, so each rule takes out one thing it can recognize and leaves the rest. Every row of the three lists below is a row of `src/scrub/text.test.ts`, and nothing is claimed here that the test does not hold.

A text longer than 65,536 characters is read that far, cut where a word ended, and closed with ` [truncated]`. Within that, the time a reading takes grows with the text and no faster. The test builds a text out of every word and mark the rules know, repeated with every separator they stop at. It holds 65,536 characters of each to at most six times what 16,384 characters took, and to a fifth of a second.

| In the text | Recorded as |
| --- | --- |
| A URL of any network scheme (`https`, `wss`, `rediss`, `amqps`, `sb`, …) | Scheme, host and port, the path with segments that look like values as `:id`, the allow-listed query (details below the table) |
| A path that begins with `/` and carries a query (`/api/media/12?sig=…`), after a space, a quote, a bracket or a `:` (`redirect:/cb?…`) | The same path and query scrub |
| A path after an HTTP method (`GET /api/threads/9f3c2a11`) | Segments that look like values, as `:id` |
| `key=value` where the key ends in a credential's word, hyphens, underscores and case aside, wherever the key begins (`_authToken`, `$_password`, `x._token`, `2fa_secret`) and however long it is (a key past 64 characters is read by its last 64): `token`, `secret`, `password`, `passwd`, `passphrase`, `pwd`, `apikey`, `subscriptionkey`, `accountkey`, `accesskey`, `instrumentationkey`, `sharedaccesssignature`, `privatekey` | `key=[redacted]`, the value bare (to whitespace, `&`, `;`, `,` or a bracket), in single or double quotes, or in `<…>` |
| The same keys before a `:` | The value in quotes, always; a bare value when it reads as a credential (six characters or more, and not letters alone unless sixteen or more), or whatever it is under `api-key`, `x-api-key` and `Ocp-Apim-Subscription-Key` |
| The same keys quoted, as JSON writes them, the quotes escaped once or several times, or inside `[…]` as code indexes by them (`env["API_TOKEN"]=…`) | The string, the number, or the whole array or object under the key, on one line or over several, the value on the key's line or the next. A value escaped more than fifteen times takes the rest of its line with it |
| The same keys as a command's flag (`--password value`, `--token value`) | The next word, or what stands in quotes after it, or the word an unclosed quote opens |
| `-u` and `--user` in a `curl` command, on its line or on a line it continues to with a trailing `\`, `` ` `` or `^` | The next word, or what stands in quotes after it |
| `Authorization`, `Proxy-Authorization`, `Cookie` and `Set-Cookie`, before `:` or `=` | The rest of the line, whatever scheme word leads it; inside a quoted string, the rest of the string |
| `sig=` in any case and, in a text that holds one, `se=`, `sv=`, `sp=`, `sr=`, `st=` | `key=[redacted]` |
| `Bearer` or `Basic` on its own, followed (bare, in quotes or in `<…>`) by eight characters or more holding a digit, `+`, `/` or `=`, or two capitals after small letters, or by sixteen or more | `Bearer [redacted]` |
| A signed token: `eyJ…` and two more base64url parts of eight characters or more, also where it is glued to the word before it (`_eyJ…`) | `[token]` |
| An address (`name@host.tld`, a host such as `163.com` included) | `[email]` |

**URLs in detail.** The userinfo is removed whatever it holds (a quote, a bracket, a `;`) and however long it is, up to the last `@` before the path. Every other query value is removed up to the whitespace that ends it, past a quote, a bracket or a full stop inside it. A quote or a bracket ends the query only when whitespace or the text's end follows it, past any more of them and any closing punctuation.

Left as written, on purpose:

- a file path and its position in a stack frame;
- the path of a URL whose scheme names code (`file`, `node`, `bun`, `webpack`, `webpack-internal`, `turbopack`, `rsc`, `app`). Such a URL loses only a userinfo, and the rules above still read inside it, so `?token=…` in one is removed;
- `package@version`, and `user@host:path`, which names a remote;
- `PWD=/a/path`, and `se=` and its kin where no signature is;
- a word after `Bearer` or `Basic`, `password: required`, and a flag with no value after it;
- the punctuation that closes a sentence after a URL.

Not covered, because nothing in the text says what it is:

- a person's name or an id written into a sentence;
- a request path with neither a method before it nor a query on a path that begins with `/` (`./callback?code=…`, `host.tld/path?code=…`), unless a key in it is one the list names; `code` is not one, and is taken out only where the whole query goes, in a URL or a `/`-path;
- a secret under a key the list does not name (`code`, `key`, `jsessionid`), or with no key at all: a private key's block, a provider's key known only by its prefix;
- a bare word of letters after `password:`, and a bare value's remainder past a `;`, `&` or `,` it contains;
- a credential of fewer than eight characters after a bare `Bearer`, one that is cut by a `,` (`Bearer abcd,…`), and a signed token whose third part is shorter than eight;
- a flag's value that begins with `-` (`--password -…`), which reads as the next flag;
- a `sig` written with a `:` and no quotes;
- a value that begins with the text `[redacted]`, which is taken for one already scrubbed;
- anything past the 65,536 characters read.

A caller that knows it holds such a value keeps it out of the message.
