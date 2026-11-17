# @platform/redis

This package gives the process its one Redis connection, and Redis is never required: with no `REDIS_URL`, every module here takes a fallback it names, and the product boots and serves.

One check runs at startup. A Redis that is configured and was never reachable is misconfiguration rather than an outage, so `assertRedisReachable()` refuses to let the process serve on fallbacks, with a typed error naming the host and the credential form. The fallbacks are for a Redis that goes away later.

- `client` — `getRedis()` answers a client with a deadline on every command, or `null` when Redis is not configured, not reachable or not connected right now. A command that never answers rejects at the deadline and drops the connection, because the client matches replies by arrival order and a reply nobody consumed would shift every later one. A failed dial or a lost socket is redialed after a cooldown. The deadline only rejects; the caller decides what a rejection means for it.
- `client/auth` — how the process authenticates, read off `REDIS_URL`.
  - `rediss://<objectId>@<host>:10000`, a user and no password, is the Entra form. The client dials as the identity's object id, with an access token for `https://redis.azure.com/.default` as the password, minted per dial because it expires.
  - Before the token expires, a planned redial with a fresh token replaces the connection. There is no cooldown and no fallback; the old socket is closed once its commands in flight have had their deadline. A redial that fails is tried again, sooner each time, while the token lasts.
  - A URL with a password is dialed as given.
- `keys` — one scheme under an app-supplied prefix: `<prefix>:<part>…`, and `<prefix>:{<tenant>}:<part>…` for keys that must share a cluster slot.
- `memo` — the cache shared by the whole fleet, under each replica's in-process cache, and the `SharedCache` a `@platform/config` key takes. Reads fail soft, only a value the origin answered is written, every key expires with the caller's own TTL and a value over budget is refused rather than written.
- `claim` — a key one owner holds for a TTL: the first caller claims, later ones learn who holds it, and only the holder releases it. Without Redis the answer is `unavailable`, and the caller decides what uncoordinated means for it.
- `pubsub` — `publish` and `subscribe`: a message on a channel reaches every replica listening to it, which is how a request on one replica reaches state another holds.
  - Delivery is at most once, by design: `publish` says how many heard it, and a caller sends over it only what has a fallback.
  - Subscribers share one connection of their own per process (a subscribed connection runs nothing else). When it drops, it is redialed after the cooldown and subscribed again. It is replaced before an Entra token expires; a replacement that cannot be made is tried again, sooner each time, while the token has time left. During that replacement both connections hear a channel, so a message can arrive twice.
  - A `SUBSCRIBE` is held to the command deadline like any command: a connection that does not answer one is dropped, and `subscribe` answers null. A channel the server refuses ends the same way, since the client resolves a `SUBSCRIBE` only when it is confirmed. So the identity's access must cover every channel the process listens on.
- `claim` also renews: `extendClaim` gives the holder more time and nobody else any. It is the heartbeat of an owner whose death is known by its claim lapsing.
- `lock` — `withLock` runs a function on at most one replica at a time while Redis answers, built on a claim with a random token; the caller says whether a process whose claim got no answer runs or skips. `run` is the choice of a caller whose work is safe to do twice: a claim Redis refused is always `held`, but one whose answer never came may run beside a holder.

Environment variables are the bootstrap this client cannot read from the store it sits under: `REDIS_URL`, `REDIS_COMMAND_TIMEOUT_MS` (no opt-out), `REDIS_CONNECT_TIMEOUT_MS`, `REDIS_RETRY_COOLDOWN_MS`.

Tests that need a server run when `REDIS_URL` is set and sweep their own throwaway prefix; the failure modes run against a fake that speaks just enough of the protocol to connect.

A sibling package tests its own fallbacks against the same fake and the same throwaway prefix through `@platform/redis/testing`.
