# @platform/http

This package prepares requests and responses to cross infrastructure the process does not own: proxies that buffer, edges that limit body size, and bodies built to exhaust a parser.

- `streaming` — a response ready for a proxy it knows nothing about: the no-buffering header on every response, and on `text/event-stream` an SSE comment frame whenever the stream has been silent for `SSE_HEARTBEAT_MS` (default 15 s, `0` off). The frame is injected only between blocks and never ahead of the consumer.
- `edge-limits` — the edge's request-body limit as the stored document `edge`, read through a cached, fail-soft key: a value outside the believable window is ignored, and nothing reads as "no limit". In demo mode nothing stands in front of the Container Apps ingress and this bound is the only one. Behind Front Door's web application firewall, which inspects bodies up to a limit of its own, set the document to that limit.
- `request-limit` — a body held to a byte ceiling before it is parsed. `overDeclaredLimit` refuses a declared length on the header alone, a request's or an upstream answer's, and `cappedRequest` counts a streamed body and errors it at the byte past the limit.
  - Parsed, a body is held to a count as well: `overElementLimit` refuses one with more than `MAX_BODY_ELEMENTS` array elements and object keys in all, before a schema reads it.
  - The reason: a validator that keeps an issue for every element it refuses turns a megabyte of body into hundreds of megabytes of heap, and one that walks every key walks a megabyte of them.

`./streaming` and `./request-limit` are separate entry points because a web app on Node, type-checked against the DOM lib, relays and bounds requests through them; they import nothing but `@platform/config/env`. The root entry reads configuration through `@platform/config`.
