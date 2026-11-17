# @platform/metering

This package holds the cost bounds: how much each account may spend on calls and on live voice, and the checks that enforce it. A credit is one call or one second of realtime, never a model token. What a subject may spend is a number in the store, and the only thing that lifts a bound is a tier.

- `subject` — the `UsageSubject` brand: a bucket is keyed on a verified account id and on nothing a caller sent, and only `usageSubject` mints one.
- `tier` — `isUnmetered`: a premium account is bounded by nothing here. Every check asks it first and admits without touching a bucket. There is no "unlimited" number anywhere for a store edit to produce.
- `limits` — the document an operator tunes (`limits`), read through `@platform/config`'s cached key, refreshed every 30 s (`CONFIG_TTL_MS`), optionally over the fleet's shared cache (`sharedMemo` from `@platform/redis`). `DEFAULT_LIMITS` is written once and the `Limits` type derives from it. One generic walker merges a stored document over it and keeps a leaf only when it has the default's kind. A number must also be finite and positive, and whole for the seconds and session counts that reach Redis as an `EX` or `HINCRBY`. A missing or broken store serves the default, never zero and never unlimited. A voice allowance (`realtime.secondsPerDay`, `global.realtimeSecondsPerDay`) below `realtime.idleSeconds` is kept and said: it admits no live session.
- `credits` — the one bucket: continuous refill on the server's clock, atomic in Lua, with spend, refund, peek and a bounded wait. Fails open by default and closed on request; a refund is never refused; a peek writes nothing.
- `surfaces` — `meterCall(subject, surface, tier)`: burst first, then the rolling day, for whichever bounds the surface's section carries. The refusal is a value — `{ code: "rate_limited", surface, retryAfterSeconds, pool? }` — and `rateLimitedResponse` renders it as a 429 with `Retry-After`. The wording comes from the client's catalog.
- `live` — the seconds ledger: the record of seconds charged to each realtime session.
  - A session is charged its first idle window upfront, against the subject's day and the deployment's shared pool. It is recorded under a one-live-session lock, in the same script that sets its deadline.
  - It is renewed on evidence a person is there, buying exactly the seconds the deadline moves.
  - It is closed out when the browser ends it, or when the sweeper (the periodic job that hangs up sessions past their deadline) reaches its deadline. The sweeper hangs it up through a provider function the app supplies, and closes out the charge whether or not that function answers.
  - What is due is decided on the Redis server's clock; a session's start and deadline are stamped by the replica that recorded it.
  - An allowance smaller than the window asked for refuses the charge, and is never drawn down to what it holds, so closing a session cannot hand back more than was taken. A refund puts back only what the charge took: the record carries whether its latest window drew on the subject's own day, so an unmetered session refunds the pool alone.
  - `liveCapacity` counts the live sessions (the set of session deadlines) against the configured concurrent-session cap, before anything is spent.
  - The charge fails open; the record fails closed, so a handshake is refused `unavailable` before a mint when Redis does not answer.
- `problems` — every refusal, on `@platform/observability`'s problem channel: `metering.call.rate_limited` and `metering.seconds.refused`, each with the surface, the bound and the wait, never the subject.
- `report` — what else this package logs: a sweep's cutoff, and the bucket being unavailable. The second goes through `@platform/config`'s `throttledReport`, one line per `METERING_UNAVAILABLE_LOG_SECONDS` carrying the count it suppressed.

Keys sit under `metering` (or the prefix an app sets with `setMeteringKeyPrefix`), hash-tagged per subject and, for the ledger, on one shared tag so its scripts run on a cluster; every key expires. Environment variables carry only what cannot be a store key: `METERING_UNAVAILABLE_LOG_SECONDS` and `METERING_SWEEP_INTERVAL_MS`.

Deliberately not here: a degrade-to-relay floor (one voice engine), model deployment names (the llm package's), and any request type — the app resolves the subject and the tier and decides what is billable.

Tests that need a server run when `REDIS_URL` is set and sweep their own throwaway prefix (`@platform/metering/testing`: the suite hooks, a subject nobody has spent, the toy limits); the fallback behavior runs without one, against the fake server that speaks just enough of the protocol to connect.
