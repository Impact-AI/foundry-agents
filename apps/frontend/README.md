# frontend

This app is the workspace people use to talk to the assistant: a conversation
beside the **stage**, the visual workspace beside the conversation, which the
assistant drives by typed turn and by voice alike. Read this page to run the
frontend, change its pages, or follow a request from the browser to the backend.

The person asks; the assistant answers in words and puts things in front of
them through tools the browser registers: the library's document cards, a
document open at a page, a picture, a chart, an entity's record. Everything the
assistant can open, the person can also open from the top bar: its Library and
Records buttons put the library and the records on the stage, and its home
button clears it.

It has no database, no Redis and no model call. Every request goes to the
backend through one server-side client that mints a short-lived caller
assertion from the verified session. The browser never calls the backend and
never sees a secret.

The app runs on **:3000**, from `server/main.ts`: Next's own request handler on
a listener of its own, which also answers the app's one WebSocket, the live
voice (below). `bun run build` builds both (Next's standalone output, and
`main.js` beside its `server.js`); the image runs `main.js`. `bun run dev`
runs the same server in development, so the voice works locally too. On a
shutdown signal the server accepts no new connections. It closes each live
voice socket with a close code the voice pane reads as the server leaving, and
gives the answers it is streaming twenty-five seconds to end.

## Pages

| Route | What it is |
| --- | --- |
| `/login` | The sign-in page: the identity provider, or in local mode a name. Public. |
| `/chat` | The workspace: the stage and the conversation's panel (its picker, the thread, and the composer or the voice pane in its place). `?c=<id>` opens a conversation. |
| `/settings` | **You**, then **What the assistant remembers about you**, then the app's language, text size, the account and its tier, a copy of its data, and its deletion. |
| `/privacy` | The plain-words notice. Public. |
| `/health` | Whether this replica is serving. Public; says nothing about anything downstream. |

**The conversation picker** opens, renames, deletes and starts conversations.
An untitled conversation is named on the server a moment after a run in it
ends, and the picker reads the list again until the name is there.

**Settings.** **You** shows the name (and under it, in `entra` mode, that it
came from the Microsoft sign-in), then "About you" and "How to talk to you" as
editable fields. Save and Cancel appear only once a field has changed. **What
the assistant remembers about you** lists the statements it keeps, newest first,
each with when it changed. Edit opens one for a correction, saved as the
person's words or canceled unchanged; Remove forgets one; forgetting all of
them asks for confirmation first.

Settings and the privacy notice each have a back link at the top of the page.
It goes to the conversation `?c=<id>` names (the account menu and the notice's
link carry it), or else to the workspace, which opens the newest conversation.

One account is one person: there is nobody to switch to, and no scope but the
caller's own. Settings opens from the account's avatar at the end of the top
bar, beside sign-out.

Every page uses the deployment's look: the `appearance` settings document
([configuration](../../docs/configuration.md#appearance)), which an operator
edits in App Configuration or in the Impact AI Admin Center. The frontend reads
it from the backend's public `GET /appearance` with no session, since the
sign-in page uses it too (`src/backend/appearance.ts`).

- The root layout writes its palette, type, spacing and corners into the page
  on the server as custom properties over the token sheet's, so the shipped
  look never flashes first.
- Its name and welcome line replace the catalog's app name, title and
  workspace heading in their language (`src/i18n/brand.ts`).
- Its logo, when it names one, is drawn in the top bar and on the sign-in page
  from `/api/appearance/logo`, a public relay of the backend's
  `GET /appearance/logo`.

With nothing stored, the page is exactly the shipped one. The backend and the
frontend each hold the document for the settings refresh interval
(`CONFIG_TTL_MS`, about 30 seconds), so an edit is live within about a minute.

Every route under `app/api/*` is thin: session, then client, then response.
Error codes cross the boundary, and the catalog renders them (`src/errors.ts`).
The checks every route needs live in one place, `src/route.ts`:

- a request that changes something is accepted only from a page of this app
  (`Origin` and `Sec-Fetch-Site`, comparing the whole origin: scheme, host and
  port);
- its body is read under a byte limit before it is parsed;
- an answer that sets no caching of its own is `no-store`.

The vitals beacon needs no session, so it is outside that handler and applies
the same three checks itself.

## The stage contract

The backend lists the stage tools under `stageTools` on `GET /identity/me`.
The browser registers exactly that list through CopilotKit frontend tools for
the typed channel, and never a tool of its own. A live voice session calls the
same controls from the backend, which sends each call to the voice pane over
the session's socket. Each handler (`src/stage/tools.ts`) changes the stage and
answers with a status ending in the follow-up cue from `@platform/prompt`.

The assistant is told what is on the stage on every typed turn, as
`stage.<section>: <one line>` readables (`src/stage/live-context.ts`). The live
session gets the same lines whenever the stage changes.

## The live voice

The voice pane takes the composer's place while the channel is open: voice or
chat, never both. The session is one WebSocket to this app's own origin,
`/api/voice/live`, which `server/relay.ts` carries byte for byte to the
backend's `/voice/live` after three checks:

1. the page's `Origin` is this app's (a browser sends the cookie on a socket
   opened from any site);
2. the session is valid, read by this app's own `/api/voice/relay-caller` over
   loopback with a key only the server process holds, so the read is the same
   as every route's and the route answers nobody else;
3. the backend's own admission check.

The relay puts the caller's assertion on the backend's upgrade request; none of
it, and nothing of Foundry, reaches the browser. A refusal arrives as a message
on the socket, which the voice pane reads like any route's error. Next's route
handlers cannot take an upgrade, which is why this lives in the server.

On the socket, `start` with the thread and the screen goes first. Then the
microphone (`getUserMedia` with echo cancellation and noise suppression) runs
through `public/voice/capture-worklet.js`, which makes 50 ms frames of PCM16 at
24 kHz, and the voice's frames play through `public/voice/playback-worklet.js`.
When the person speaks over the voice (`speech` started), whatever has not been
played yet is cleared. The microphone's frames are dropped, not queued, while
the socket holds more than about two seconds of them.

Each line said is written under the trace (the voice pane's live waveform) as
it is heard. The backend writes the lines into the thread when the session
ends, and the voice pane reads the thread again once the backend says so, so
the chat shows them without a reload. A session that ended because a replica
restarted reopens on the same thread with one press. `app/(app)/voice/live-link.ts`
holds the transport, and `src/voice/` the messages and the pure state machine.

The stage's reads go through this app's own routes: `/api/library`,
`/api/library/[id]`, `/api/records/[kind]/[id]`.

## The typed channel

The browser's CopilotKit client talks to `/api/copilotkit` alone. That route
builds a fresh runtime per request with one agent: an `HttpAgent` from
`@ag-ui/client` (`src/backend/agent.ts`) that posts AG-UI's `RunAgentInput` to
the backend's `/agent/run` and reads its events back. The backend serves the
protocol itself over its agent host, so nothing here knows which host that is.

The request carries the caller assertion and the language this request
resolved to, set where the request is sent. The runtime would otherwise copy
the browser's `authorization` and `x-` headers onto the agent's own, and the
backend must see none of them.

The chat client marks each run with a request id of its own among the run's
forwarded properties. The backend accepts no request id there and refuses a run
that carries one, so the agent removes that one mark and passes on anything
else a browser put there, to be refused. A run the backend refuses before it
starts arrives as its status and code. A run that ends with `turn.blocked`
(the content filter) says only that the assistant cannot help with it.

## Layout

```
auth.config.ts     edge-safe Auth.js config: providers, callbacks, the public paths
auth.ts            the Node instance; sign-in reported to the backend, access baked on the token
proxy.ts           the gate (below); and each request's Content Security Policy (src/csp.ts)
instrumentation.ts the deployment guard and telemetry
messages/          en, it, es, fr, de .json — every user-visible string, in every language
src/i18n/          the product's locale registry (imported from the backend), the one resolution order, the switcher's action
src/backend/       the one client, the typed calls, the agent factory, the stage's reads
src/session.ts     the verified caller, read from the session alone
src/person.ts      the person's three fields as a form holds them: bounds, draft, what a draft changes
src/chat/          sent-image markers, the browser's picture store, downscaling
src/stage/         the stage as pure data: reducer, live context, tool handlers and briefs,
                   suggestions, the flip and pager arithmetic, the guide's placement
src/voice/         the live session's events, read once, and the voice pane's pure state machine
app/globals.css    the one token sheet — color, space, type, shape, shadow, motion — and the shell
app/components/controls/  the control primitives every screen is built from: Button, IconButton,
                   TextField/TextArea/SelectField, Chip/Tag, Popover and the Menu on it, Dialog,
                   StatusLine, the glyphs, Card, and the one sheet that styles them
app/components/markdown/  the markdown renderer behind `import()`, a person's Markdown drawn with
                   no HTML, and the one sheet for rendered Markdown, the chat's included
app/components/    the field under every screen, the bar, the frame loop and render tier,
                   the contexts the bar and the workspace share
app/(app)/workspace  the workspace root: the stage's state, the registered tools, the context
app/(app)/stage/   the stage: panel, tiles, motion, the phone's pager strip, the overlay
app/(app)/chat/    the conversation's panel: its picker, the frontend's view over the runtime (ChatView), the
                   composer, chips, the wait, the model's reasoning (one disclosure per turn),
                   the notices, the cards in the thread
app/(app)/voice/   the voice pane: the live link, the trace, the transcript
app/(app)/guide/   the first-visit tour
app/(app)/settings/ You and what the assistant remembers, the app's settings, the account's rights
```

`proxy.ts` is the gate in front of every request:

- a page without a session is sent to the sign-in page, and an API call
  without one gets 401;
- each request gets its Content Security Policy, whose nonce is the only thing
  that lets an inline script run (`src/csp.ts`);
- a path that names a file is answered without its session being read, so a
  file under `public/` carries no cookie, and the matcher passes `/health` and
  `/api/appearance/logo` by, so neither carries one either;
- a path under `/api` that no route answers is a JSON 404
  (`app/api/[...missing]`), never the not-found page.

## Develop

```bash
cp apps/frontend/.env.example apps/frontend/.env.local   # then fill it in
bun run --filter @app/frontend dev
```

`BACKEND_URL` names the backend. `AUTH_SECRET` must match the backend's, since
it signs the assertions the backend verifies. Every line of `.env.example` is
bootstrap: a resource, an endpoint, a secret, or a setting for one replica's
server. Nothing in it is a fact the backend owns. The agent's id, the stage
tools and every byte limit come from the backend's own answer,
`GET /identity/me`, read once per process and cached for the settings refresh
interval (`CONFIG_TTL_MS`, about 30 seconds; `src/backend/facts.ts`). Whether
the deployment has live voice is asked of `GET /voice/capability` each time a
page needs it (`src/backend/voice.ts`).

## Access

The identity provider decides who gets in and what they get; no variable here
does. `AUTH_MODE` picks the one provider the sign-in page registers:

- `entra`: Microsoft Entra ID. The tier is the app role `premium` on the
  app registration. Admission is the registration's *assignment required*
  switch, or `AUTH_REQUIRE_ROLE=1` for a token that must carry `user` or
  `premium`. The token's `groups` claim is recorded on the account at sign-in,
  for access control at the level of a document. What each role does and how
  to set the registration up is in `platform/identity/README.md`.
- `local`: for trying Agent on Azure with no app registration yet. It asks for
  a name and no password, and every sign-in is a new person. The name is only
  what the assistant calls you. The account behind it is random, so nobody can
  type somebody else's name and become them, and nobody, its maker included,
  can get back to an account once its session ends. Every local account is
  `user`, a member on the base tier. To keep your history, use Entra. A
  hardened deployment (`HARDENED=true`) refuses to start in this mode.

The session carries a snapshot taken at sign-in; the backend re-resolves from
the account's row at every point of use. A session ends eight hours after the
sign-in that made it, however active it is (`SESSION_MAX_AGE_SECONDS` in
`auth.config.ts`), because the next sign-in is what records a role or group
the provider took away. One predicate, `holdsSession`, decides whether a
session is valid for the proxy, the sign-in page and every page alike.

## Check

```bash
bun test apps/frontend          # from the repository root
bun run --filter @app/frontend typecheck
bunx biome ci apps/frontend
bun run --filter @app/frontend build
```

Among the tests:

- `app/tokens.test.ts` holds every text/ground pair of the token sheet to AA
  contrast in both color schemes;
- `app/components/controls/controls.test.tsx` renders each control primitive
  and asserts it names itself for assistive technology;
- `app/card-spacing.test.ts` holds every card and panel to the token sheet's
  one card spacing (head, body, actions; no heading spaces itself);
- `chat/composer-row.test.ts` lays the composer's row out from its sheet and
  holds every control to the field's last line;
- the two phone tests read the sheets for the rules a phone needs.

The runtime's own stylesheet is never imported. The chat view, the composer,
the messages and the attachment queue are the frontend's own, built on the
runtime's hooks and slots, so one sheet styles the whole interface.

`e2e/` is the end-to-end suite. Playwright drives Chromium through this app's
production build, served as the image serves it, against the real backend: the
backend's `dev-fake` launcher, its own app on real Redis with Foundry Agent
Service and the models replaced by stand-ins. It asserts what a person sees:

- the sign-in page and the disclosures;
- a streamed turn and its reasoning, and the picker;
- the stage's five tiles;
- settings, what the assistant remembers, language and text size;
- the export and the account's deletion;
- the voice pane;
- a document only a group may read staying unlisted;
- an axe check of each page at rest.

Every local sign-in is a new person, so the tests share nothing and run in
parallel; no test retries and none waits on a clock.

```bash
bun run --cwd apps/frontend e2e:build      # next build, laid out as the image's
REDIS_URL=redis://127.0.0.1:6379 \
  bun run --cwd apps/frontend e2e          # starts both servers, runs, stops them
```

To look at the interface with no model and no Azure, run the backend's
`dev-fake` launcher (its README, *Tests*) and this app against it with
`NEXT_PUBLIC_VOICE_PREVIEW=1`. That flag compiles in a test-only hook
(`app/(app)/voice/testing/voice-preview.ts`): a page may set
`window.__voicePreview` to a phase and dispatch `voice-preview` to draw the
voice pane in that phase with no microphone and no session. A build without
the flag carries no such switch.

## Loading

No first-load chunk carries a renderer. The markdown renderer is fetched
behind `import()` the first time something draws Markdown
(`app/components/markdown/streamdown-lazy.tsx`): CopilotKit's assistant turn,
through the alias in `next.config.ts`. The text stays plain until it loads.
The media overlay and the guide's tour are fetched behind their own `import()`.
A start-of-session prefetch (`warm-panels.ts`) fetches those chunks at the first
idle moment, at most 9 s after the session starts, never on a metered connection or a phone (`render-tier.ts`). The
background field's drift and the voice trace paint only while on screen
(`frame-loop.ts`), at a capped rate, and stand still under reduced motion. A
loading failure names itself in production: `reportLoadFailure` writes a
console line and is sent with the vitals beacon.
