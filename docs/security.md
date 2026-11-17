
# Security

This page sets out, layer by layer, what Agent on Azure does to keep people, data and spend safe, and what it leaves open. Read it before you put real users or real data on a deployment. Treat demo mode as a demo: public endpoints, a sign-in anyone can use, no locks. Before real users, deploy in hardened mode, with Entra sign-in and a role required, and read [Known gaps](#known-gaps).

## Sign-in

| Mode | Who gets in | Limits |
| --- | --- | --- |
| `entra` | Whoever Microsoft Entra ID authenticates for your app registration in your tenant. With `AUTH_REQUIRE_ROLE` (always on in hardened mode) the token must carry the app role `user` or `premium`; with the enterprise application's *Assignment required*, Entra refuses anyone unassigned before the app sees them. | Roles and groups are read from the token at sign-in. A token that carries no object id is refused: there is no stable account to give it. |
| `local` | Anyone who types a name. | For trying Agent on Azure only. A name proves nobody, so each sign-in mints a random account: nobody can become somebody else by typing their name, and nobody, the person included, can return to an account once its session ends. Every local account is a base-tier `user` with no groups. Hardened mode refuses to start with it. |

Sessions are Auth.js JWT cookies signed with `AUTH_SECRET`. A session ends eight hours after the sign-in that made it, however active it is. A session is not revoked server-side: signing out clears the cookie in the browser that asked, and a copy of it elsewhere verifies until it expires.

Erasing the account ends every session that began before the erase:

- The [caller assertion](patterns.md#terms) carries when its session was signed in.
- The account's document keeps when it was erased, for as long as a caller from before the erase could present itself: a session's eight hours, the ten minutes of its last assertion, and a minute for clock skew.
- The backend refuses the older session on every route but the sign-in report and the warm-up (`401 account_erased`). It fails closed: a request whose account cannot be read is `503 account_unavailable` on every one of those routes.

The erase's first write shuts the account's document. While what is held under the id is being swept, no session is admitted on it and no sign-in makes an account of it. An erase a session asks for shuts only the account that is still that session's own, and sweeps only once it has. An account that was erased and signed in under again since is left alone, with its conversations, and the session is refused.

Whose the account is comes before whether it is deactivated. A session from before an erase is refused on the account made since, even after that account is deactivated, and has none of a deactivated person's rights over it. A deactivation that lands while an erase runs is kept. What the erase of a deactivated account leaves ends that account's sessions too and takes no write, and the next sign-in under its id stays refused.

The session lifetime is what bounds a removed role or group, because the next sign-in records the change. A deactivation is read from the account's row at every spend, so it holds at once.

## Gates

Every request passes these gates in order, from the browser to the data it reads.

1. **The frontend's proxy** sends a page request without a session to the sign-in page and answers an API call without one with 401. Besides sign-in itself, the health check and the privacy notice, one route answers without a session: `/api/vitals`, which takes a page's web-vitals reading (4 KiB at most, a fixed set of fields) and writes it to the replica's log, behind no limit of its own.
2. **The frontend's routes** read the caller from the verified session alone and mint a **caller assertion**: an HMAC token under `AUTH_SECRET`, valid 10 minutes, naming the subject, email, roles, groups and tier. The browser never calls the backend and never sees a secret. The provider's tokens stay on the frontend's server: a sign-in is reported to the backend as the provider's name, its roles and groups are the assertion's, and no refresh token is asked for.
3. **The backend's gate**, the assertion check, runs before any routing. Every route needs a valid assertion except `/health`, `/ready`, `/appearance` and `/appearance/logo` (the deployment's look and its logo, which the sign-in page uses), so an unknown path is 401 before it is 404. The backend has internal ingress only.
4. **At the point of use**, every spend re-reads the account row: whether it may still spend, its tier and its groups come from the row, never from the assertion or the session's snapshot.
5. **Scope comes from the caller**, never the request: the account id is the agent's memory scope; a conversation another account owns is absent on a read and refused on a write; the document filter uses the verified object id and the row's groups.

**The deployment guard.** A process that serves people (a Container Apps replica, or anything run with `NODE_ENV=production`, as every image sets) refuses to start:

- without `AUTH_SECRET`, with one shorter than 32 characters, or with the vault's placeholder for an empty secret;
- with an `AUTH_MODE` that names no mode;
- when `HARDENED` is set, with `local` sign-in or without `AUTH_REQUIRE_ROLE`.

A crash-looping revision leaves traffic on the previous one. On a local checkout with no `AUTH_SECRET`, the backend's gate stands open on one local account, for development only.

## Identities and keys

No service the apps reach has a key enabled: Redis (access keys off), AI Search, the Foundry account, Cosmos DB, Storage (shared keys off) and App Configuration all authenticate managed identities. Web search is the Agent Service's own tool, so the deployment holds no key for it. The one keyed thing is telemetry: Application Insights' connection string, an ingestion key that reads nothing, is a plain value in each container's environment and on the project's connection to it.

Each running thing has its own user-assigned identity with only the roles it needs ([architecture](architecture.md#identities-and-roles)). Foundry User is scoped to the project. The model roles (Cognitive Services OpenAI User for the backend and the job, Cognitive Services User for the job's shield step, the search service, and the backend's live sessions on Voice Live itself) are the account's, since deployments belong to the account. Nothing signs a blob URL: the backend reads a picture with its own identity and streams it.

The application secrets, `AUTH_SECRET` and the Entra client secret, are generated by `preprovision` (or set by you), stored in the azd environment and Key Vault, read by the containers as Key Vault references, and carried to CI as GitHub secrets. Rotation is in [operations](operations.md#rotating-secrets).

## Policy

Built-in Azure Policy definitions are assigned to the resource group in Audit (`POLICY_AUDIT`, on by default): local authentication disabled on the Foundry account, Cosmos DB, AI Search and Storage in both modes, and, with private networking, their public network access disabled. Audit reports a resource out of compliance in the portal's *Policy* view and blocks nothing. So a drift, such as a key re-enabled by hand or a listener opened for an upload and left open, shows up there rather than being refused ([decisions](decisions.md#30-azure-policy-in-audit-at-the-resource-group-local-authentication-in-both-modes-public-access-with-private-networking)). If you need refusal, assign the same definitions with `Deny` at a scope you govern.

## Network

| | Demo | Hardened |
| --- | --- | --- |
| Data services | Public endpoints, Entra-authenticated. | Private endpoints and private DNS in a virtual network; public listeners off on Redis, Key Vault, App Configuration, AI Search, the Foundry account, Cosmos DB and Storage; the Foundry Agent Service injected into a subnet of its own. |
| Edge | The Container Apps ingress, TLS. | Front Door Premium with WAF; the environment's public ingress closed, reached only over a private link. HTTP redirects to HTTPS. |
| Backend | Internal ingress, inside the environment. | The same. |
| Storage | Public, keyless. | Private endpoint (blob), public access off; the ingest script uploads from inside the network, or, with `--open-listener`, turns the listener on and lets only the operator's address through the account's firewall, for the upload alone ([documents](documents.md#load-a-library)). |
| Container Registry | Public, keyless. | Public, keyless: remote builds push to it. |
| Agent Service egress | Microsoft's network. | The `agent` subnet's default outbound access, unfiltered (`AGENT_EGRESS=open`, the default); `restricted` gives it a NAT gateway and a security group that lets out only the private endpoints and Entra ID, the artifact registry, its Front Door and Azure Monitor ([decisions](decisions.md#28-the-agent-subnets-egress-open-by-default-a-nat-gateway-and-a-service-tag-allow-list-by-opt-in)). |
| Telemetry | Public ingestion, keyed by the connection string. Queries go to the public endpoint, Entra-authenticated. | The same by default, queries included; `PRIVATE_TELEMETRY=true` opts in to ingestion through Azure Monitor's private link alone. Delivery over that path is untested; verify it before relying on it ([decisions](decisions.md#29-telemetry-on-a-private-deployment-public-ingestion-by-default-azure-monitors-private-link-by-opt-in)). |
| Security groups | None (no network). | `data` refuses every outbound flow; Bastion's and the jump VM's subnets carry the baseline's groups; `agent` carries one when restricted; `apps` none, its ingress being external. |

## The WAF

Front Door's WAF runs Microsoft's Default Rule Set 2.1 in Prevention and the Bot Manager rule set 1.0, inspecting URI, query string, headers and cookies. Request bodies are not inspected, because ordinary chat bodies tripped the SQL-injection rules; the reasons are in [deployment](deployment.md#the-waf). Every rule of the Default Rule Set blocks, 920420 among them. The Bot Manager rule set runs at its default actions (Azure's defaults for 1.0): *BadBots* blocked, *GoodBots* allowed, *UnknownBots* logged and served. That is why a plain `curl` appears in the WAF log without being refused. Live voice is one WebSocket, whose handshake the WAF inspects like any request and whose frames it does not see. Every route bounds and validates its own body instead:

- Every backend request body is held to the `edge` document's `maxRequestBodyBytes` (1 MiB) before a route reads it (`413 body_too_large`). A live voice socket's frames are bounded by the backend's WebSocket server: half a second of audio, or 16 KiB of text.
- The frontend bounds every route that takes a body, counted as the body arrives, before forwarding: the chat route at the same `maxRequestBodyBytes`, every other at 64 KiB. It refuses a state-changing request whose `Origin` (scheme, host and port, each compared) or `Sec-Fetch-Site` is not the deployment's own, the vitals beacon's included. A caller that is not a browser sends neither header and is held by the session alone.

## The run body

This section says what a browser may send for a typed turn and what the backend does with it. A typed turn is an [AG-UI](patterns.md#terms) run (`POST /agent/run`), and the backend forwards nothing of it to a model as it came. Whose turn it is comes from the caller assertion alone: the run has no field that names an account.

Of the run, the backend reads:

- the conversation's id;
- the newest message: the person's words with any picture as inline data, or the answers to the controls the browser ran;
- the names of those controls;
- the lines describing the screen.

The rest of the history is ignored, because the agent holds the conversation, and a system message a client wrote never reaches the model. These are answered `400 turn.invalid` before the model is reached: a field AG-UI's run does not define (`instructions`, `model`, a scope), shared state, forwarded properties, a resumption, a picture by URL, a control the backend does not define, and an answer to a call the agent did not leave open for the browser.

The control definitions the model sees are the backend's own, never the words the browser sent. What is on the screen reaches the model as at most a bounded number of short lines, quoted. The frontend sets the backend's headers where it sends the run, so none of the browser's own reach the backend. Of the forwarded properties, it removes only the request id its chat client adds to every run, so any other still reaches the backend and is refused.

A turn the content filter refuses ends with `turn.blocked`, and the person is told only that the assistant cannot help with it; the category is in the backend's log and the trace, never on the wire.

## Live voice

- **Only the backend talks to Foundry.** The browser's one WebSocket goes to the frontend's own origin; the frontend's server relays it to the backend under the caller's assertion; the backend opens the voice agent's socket with its own managed identity (a token for `https://ai.azure.com`). No bearer, key, project endpoint or session handle of the service reaches the browser. That is also why voice works on a hardened deployment: the project's public access is off, and nothing but the backend, inside the network, has to reach it.
- **A socket from another site is refused.** A cookie rides on a WebSocket from any page, so the frontend's relay checks the `Origin` against the deployment's own (`AUTH_URL`; where a checkout sets none, the host the request named) before it reads the session (`403`). The session is read by the same code every route reads it with; the backend's gate and the account's standing then run on the upgrade, before the socket is accepted.
- **What a browser may send** is its audio, the answer to a stage control the session called and has not yet closed (`tool-output`, ignored otherwise), the lines describing its screen, words the person typed (`text`), and `end`. Each is read strictly and bounded in size. How much of each one session takes is bounded too, before any of it is kept or sent on (`platform/voice/src/broker/input-budget.ts`):
  - audio: up to a quarter faster than it is spoken, four seconds of it at once; the rest is dropped, and the session ends after a minute of that;
  - typed messages: six at once and one every two seconds after, 64 KiB of them a session; a message not taken is reported to the voice pane;
  - the screen: once a second, the latest.

  The browser cannot send `session.update`, instructions, tools or audio settings: the session's instructions, voice and language are set by the backend from the verified caller and the voice agent's version.
- **Every tool runs where a typed turn's does.** A server tool runs in the backend as the person, under the same reads and the same access filter; a stage control round-trips to that person's browser and nobody else's.
- **Whose session it is** is the socket's: the replica that accepted the person's socket holds the session, and nothing names a session from outside it. Redis keeps a ledger of live sessions and the seconds they spend, and a periodic sweep over it can end a session from any replica; nothing else can.
- **The session keeps nothing at the service** (`store=false`). It ends at the ceiling the ledger records, whoever holds it: the owner replica, or, when that is gone, whichever replica notices.

## Generated content

**Machine-readable marking of live voice is not implemented by this application.** The assistant's voice is synthesized by Azure and relayed to the browser by the backend, which passes it on unaltered and adds no machine-readable marking. Whether the selected Azure service provides marking at source has not been verified. The interface discloses that the assistant and its voice are AI-generated; that disclosure does not establish that machine-readable marking requirements are met. Assess the obligations applicable to the deployed product, including AI Act Art. 50, and verify the selected services and any additional implementation before making a compliance claim.

## Browser-facing headers

Every page carries a Content Security Policy: `default-src 'self'`, no frames, no objects, `connect-src 'self'`, and a `script-src` of the request's own nonce with `'strict-dynamic'`. Under it a browser runs only the scripts carrying that nonce and what they load, so an inline script written into a page by anything but the server does not run. Pages also carry HSTS, `nosniff`, `X-Frame-Options: DENY`, the referrer policy `strict-origin-when-cross-origin`, and a permissions policy that keeps the camera and microphone to this origin and switches geolocation off. Nothing loads from another origin: pictures come through `/api/media/`, and the live voice's one WebSocket goes to the same origin.

## Pictures

A picture is served by its path, the way Microsoft's own retrieval samples serve a document. The browser asks the frontend for `/api/media/{library}/{path}`, the frontend relays to the backend's `/media/{library}/{path}`, and the backend reads that blob from the library container with its managed identity and streams it back. So:

- **no URL into storage, and no SAS, ever reaches a browser**, and no other host is ever fetched: there is nothing to forge and no query argument a WAF would read as a remote file include;
- **only a picture the migrate job described** is servable: a blob of a picture format whose metadata the job wrote, never a document, a manifest, or a blob nobody described. A path that does not decode or hides a separator is refused (`400 invalid_path`);
- **the picture's own readers decide who**, read from its blob's metadata by the same rule the search's filter applies (`readablePicture`, `@platform/knowledge`). Under `access.enforceAccessControl` a person sees a picture only if their object id or groups may read that file, and absent and not theirs are one `404`;
- only raster images leave (SVG refused). Every answer carries a `Content-Security-Policy` of `default-src 'none'` and `sandbox` (the browser's copy also admits the picture itself and inline style), `nosniff`, and `private, no-cache`, so a browser asks again, as whoever is signed in, before it shows a copy. It names the copy it holds by the content's `ETag`, and is answered `304` with no bytes while the content is exactly that copy and the caller may still see it; `*` names no copy and earns none;
- it is metered per account (`limits.media`).

The deployment's **logo** is the one picture served without a session, because the sign-in page draws it: `/api/appearance/logo` on the frontend, relayed from the backend's public `GET /appearance/logo`.

- Neither takes a key or a path from the request, and the relay hands the backend no cookie or other credential, so it reaches that one address and no other.
- The backend opens the single object the stored [`appearance` document](configuration.md#appearance) names, in the storage account's `appearance` container (apart from the library, so no search reaches it). The document's reader accepts only a key of the form `appearance/logo/<sha256>.<png|jpg|webp|gif>`.
- It is served only when the stored object is the raster type its key says and at most 512 KiB (the relay holds a body to the same bound, declared or not). It is served inert (`default-src 'none'; sandbox`, `nosniff`) and cached publicly against the hash in its key.
- Since a shared cache keeps it, it carries no cookie: the proxy's matcher passes it by, as it does `/health`, because Auth.js writes its own cookies onto whatever it answers.
- A key is named for its bytes, so the backend holds the last logo it served in memory against its key (one, at most 512 KiB), and a repeat anonymous request reads nothing from the store. Only a logo that passed every check is held.

The rest of the `appearance` document, which an operator edits in App Configuration or the Impact AI Admin Center, reaches the page as a `<style>` built from colors re-serialized as `#rrggbb`, whole numbers, and names from closed lists. It is refused whole if it could close its element. The name and the welcome line are text React escapes.

## Who may read a document

A library's `access.json` names each file's readers ([documents](documents.md#who-may-read-a-document)). The migrate job writes them into the file's blob metadata, and AI Search's indexer copies them onto every chunk of the file as two filterable fields, `oids` and `groups`. The search is the backend's own: the `knowledgeSearch` tool and the stage's library run Azure AI Search's **generally available security-filter pattern**, the one Microsoft's own retrieval sample used until it moved to the preview below:

- every query carries `oids/any(t: t eq '<object id>') or groups/any(t: search.in(t, '<group>|…|all', '|'))` (`all` only while `access.globalDocumentAccess` is on). It is built in one module (`query/access.ts`) from the person's **account row** (the verified subject and the groups recorded at their last sign-in), and never from anything a request body, a model or a client says;
- it is a clause beside the plan, outside the reach of the relaxation ladder that drops a plan's constraints to find rows, so no empty result can widen it;
- every query also carries `injection eq false and documentId ne null`: only a chunk Prompt Shields has read and found clean, of a file a load described, is ever handed to the agent's model (below), though the reader shows a person a flagged passage of a document they may read, marked;
- the query runs under the backend's managed identity, which holds Search Index Data Reader. **The people who use the product hold no Azure roles** and never reach Search, Storage or Foundry with their own tokens (the operator does: [privacy](privacy.md#what-is-stored)), so nobody can query the index around the filter or the metering;
- a reader opened by id runs the same clause. Where it shows a file's own text, it holds the blob's description to the same rule as well, so a file replaced since it was indexed is not shown to the readers it had before. A picture is held to its blob's own metadata under that rule. Absent and not yours are one answer everywhere;
- with `access.enforceAccessControl` off, the clause is only that served filter: the readers a library names are recorded on its blobs and chunks and enforced by nothing. Off is demo mode's default. Hardened mode is seeded with it on, and a deployment whose `access` document is already stored keeps its value ([documents](documents.md#who-may-read-a-document)). A load that finds readers short of everybody while it is off says how many files that is, in a line starting `WARNING: READERS NOT ENFORCED`: in the job's log, in the step's result and on the ingest script's screen.

A **local sign-in** has no Microsoft identity: no groups, and a `local:` subject no `access.json` can name. Its clause therefore admits exactly the documents open to everyone (`all`), with no special case, and none at all with `access.globalDocumentAccess` off.

### Why not Foundry's search tool

The built-in `azure_ai_search` tool of the Foundry Agent Service cannot carry the person asking. Its filter is fixed when the agent version is made, and it does not pass `x-ms-query-source-authorization` ([azure-sdk-for-python #44454](https://github.com/Azure/azure-sdk-for-python/issues/44454), where a maintainer recommends a custom function tool calling Search directly, which is what `knowledgeSearch` is). A Foundry IQ knowledge base reaches the person only when the person calls the agent with their own token and holds roles on Foundry and Search, which does not fit a middle tier calling with its own identity. And Search's own document-level trimming (`permissionFilter` fields, the person's token in `x-ms-query-source-authorization`) is **preview**. So the security boundary uses no preview feature.

### If you need Search to trim by the person's token

If your deployment must let Search itself decide who reads a document, from the person's own token, these are the pieces to change:

| Piece | How Agent on Azure does it | What to change it to |
| --- | --- | --- |
| Readers in the index | `oids`, `groups`: filterable collections | the same fields marked `permissionFilter: userIds` / `groupIds`, the index's `permissionFilterOption: enabled` |
| Filling them | blob metadata through the indexer's field mappings | the same mappings, if Search accepts a permission field as a mapping target; otherwise ADLS Gen2 ACLs or the push API |
| Who decides | the backend's OData clause from the account row | Search, from the person's token |
| The agent's tool | `knowledgeSearch` (a function tool) | the built-in `azure_ai_search` tool passing the person's token, or a knowledge base through `UserEntraToken` |
| Injection scan | the job's Prompt Shields step | the guardrail's tool-response scan, which covers `azure_ai_search` |
| Identity | the backend's managed identity; people hold no Azure roles | the person's token reaches Search: a delegated `user_impersonation` permission with admin consent, forwarded by the frontend |

The change touches:

- the index definition (the permission fields);
- the frontend, which acquires and forwards a token for Search;
- the backend, which verifies and passes it;
- the agent definition, which swaps `knowledgeSearch` for the built-in tool;
- the `shield` step and `query/access.ts`, which are removed;
- the app registration, which gains the delegated permission.

Before you rely on it, check that #44454 has shipped in `@azure/ai-projects` and that native trimming is generally available in a REST version without `-preview`. Then run the two-person test through the built-in tool: two people in different groups must each find only their own group's document.

## Model safety

- **Guardrails first.** The system prompt has three parts in one fixed order: the guardrails, the persona with the channel instructions, then the person. The channel instructions are the per-channel instructions in `apps/backend/src/product/surface.ts`, in a written register for typed turns and a spoken one for voice ([architecture](architecture.md#a-typed-turn)). The guardrails come first and say, by name, that they outrank everything after them. Their wording is tunable in the `guardrails` document, but each slot is validated and an invalid one falls back to the shipped wording, so no edit renders an empty guardrail.
- **The person is quoted, not obeyed.** Everything the person wrote about themselves, what is remembered about them, and what is on the screen reach the prompt as quoted, bounded blocks under the guardrails. A language from the client is validated against the supported list before it reaches the prompt.
- **What a person wrote never becomes the agent's.** The agent version holds the guardrails, the persona and the channel instructions; the person's part travels with each response as a structured input the service substitutes for `{{personalization}}`. Both halves have `{{` broken before they are sent, so neither an operator's persona nor a person's words can name a template variable. A version is the same for everyone and is found by the hash of its definition, so nothing about a person is in one.
- **One guardrail on every deployment and every agent version.** Each model deployment carries the content filter policy `default-indirect`. So does each agent version, through its `rai_config`, wherever `FOUNDRY_RAI_POLICY` names the policy, as the template always does. The policy is Microsoft's `DefaultV2` (the harm categories at medium on prompts and completions, Prompt Shields for jailbreaks, protected material), written out in full, plus Prompt Shields for indirect attacks, which `DefaultV2` leaves off. Indirect-attack detection acts on text a request marks as a document. A deployment that opts live voice into the Voice Live API directly is filtered by Voice Live's built-in content filter instead, which cannot be changed ([voice runtimes](configuration.md#voice-runtimes)).
- **The library's text is read by Prompt Shields once, at load.** A document's passages reach the model as a function tool's output, which no deployment filter treats as a document and the agent guardrail's tool-response scan does not cover. So after each indexer run, the migrate job sends every chunk it has not read, or whose text changed, to Prompt Shields (`text:shieldPrompt` on the Foundry account, as `documents`). It writes the verdict and the hash of the text onto the chunk. Every search asks for `injection eq false`: a chunk not yet read has no verdict and is never served; a flagged one is logged with its file and never served. Whether a chunk the indexer writes again keeps its verdict is up to the service, and the scan depends on neither answer: it reads the whole index and shields every chunk with no verdict, or whose text is not the text its verdict was given on, whichever library it is in. One window remains. Where the service keeps the verdict, a file edited so that a clean chunk gains an attack is served under its old, clean verdict from the indexer's run until the job's scan a few minutes later in the same execution.
- **Web search** is the Agent Service's own `web_search` tool (Microsoft-managed Bing, no resource or key of the deployment's), which the service runs inside the response and which the guardrail scans. Agent on Azure searches the open web, with no location and no domain list. The search words leave the deployment's Azure compliance boundary for Bing ([privacy](privacy.md#what-is-stored)). A turn whose account has spent its `toolSearch` allowance runs without it.
- **Pictures leave the service once answered.** On `history.store: own`, the default, no response is stored and there is nothing to delete. On `foundry`, the conversation item that carried one and the response it was input to are deleted as the turn ends, once and best effort. A delete that fails is reported as `agent.history.picture_kept`, and the item stays until the conversation is deleted or expires.

## Known gaps

| Gap | Note |
| --- | --- |
| CSP allows `'unsafe-inline'` styles, and `data:` and `blob:` images and media | Scripts run by a per-request nonce (`apps/frontend/src/csp.ts`); styles keep `'unsafe-inline'` because React writes `style` attributes, which a nonce cannot carry, so the policy does not stop an injected style. What model-written text can load is bounded by `connect-src`, `img-src` and the Markdown renderer. |
| No rate limit at the edge | Every limit is the app's, after sign-in, and `/api/vitals` has neither. A Front Door rate-limit rule is the recommended addition. |
| WAF body inspection off | By design (above); bodies are validated by the routes. |
| Sessions are not revocable | A removed role or group takes effect at the next sign-in, within eight hours. |
| `local` sign-in | Anyone can sign in. Never put real data in a demo deployment. |
| Demo spend is unbounded per person | Allowances are per account, and every `local` sign-in is a new account with its own allowance, so one person can spend again by signing in again. Only live voice (`global.realtimeSecondsPerDay`) and conversation titles have a deployment-wide cap. Keep a demo's address private, set an Azure budget alert, and `azd down` when you are done. |
| Live voice audio is not marked as synthetic | AI Act Art. 50(2), [above](#generated-content). The audio crosses the backend's relay on its way to the browser, unaltered, so a mark could be applied there. |
| Document access control is off in demo mode until it is switched on | `access.enforceAccessControl` is `false` on a new demo deployment, and on any deployment whose stored `access` document says so. Until an operator sets it, every signed-in person can find and read every document, whatever `access.json` says ([above](#who-may-read-a-document)). A fresh hardened deployment is seeded with it on; an existing one keeps its stored value. The library load reports the files it concerns. |
| The readers filter is the backend's own | The GA security-filter pattern, in one module, proved by the two-person test; Search's native trimming is preview ([above](#why-not-foundrys-search-tool)). |
| A library's text is shielded at load, not at answer time | A chunk edited into an attack keeps its clean verdict for the minutes between the indexer's run and the job's scan. No groundedness checks are configured. |
| The backend may make agent versions | A turn makes the version it needs when no deploy made it, so the backend's identity holds Foundry User on the project, which also reaches the project's other agents. Agent on Azure offers no narrower role. |
| The memory store (the default `memory.store`), skills and the voice agent are preview | Their behavior, and what an erase reaches, can change before general availability; check them on a deployment after an upgrade ([testing](testing.md#what-only-a-deployment-proves)). |
| The memory store cannot run behind the private endpoints | Its extraction calls the account's model from outside the network, which a private account refuses. A private deployment defaults to, and is held to, the deployment's own store. Details after the table. |
| The agent subnet's egress is open by default | With private networking, compute in the `agent` subnet reaches any internet address on any port, unlogged; the data services' listeners are off, so the path leads out, not in. `AGENT_EGRESS=restricted` narrows it to service tags; filtering by host name needs a firewall the template does not make ([decisions](decisions.md#28-the-agent-subnets-egress-open-by-default-a-nat-gateway-and-a-service-tag-allow-list-by-opt-in)). |
| The PowerShell versions of the hooks are not run on Windows | The tests run both the shell and the PowerShell version of every hook and script through the same scenarios, the PowerShell ones under `pwsh` on Linux. Nothing runs them on Windows, where paths and the native programs they call are the system's own. |

**The memory store behind private endpoints.** Microsoft Learn: "Virtual network (VNet) integration isn't supported for memory stores." On a private deployment, `preprovision` and the deploy refuse `foundry`, and an edit after the deploy is refused at run time (`PRIVATE_NETWORKING`, `agent.memory.store_unreachable_private`). Choosing the Foundry store there would mean opening the account's public endpoint, which no published service tag or address list can narrow.
