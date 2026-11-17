
# Documents

This page is for whoever owns the documents and whoever loads them. It shows how to give the assistant your own documents to answer from, decide who may read each one, and keep them up to date. It covers the library format, who may read what, loading and removing libraries, the reader, the two retrieval engines and the sources under a reply.

You load documents as **libraries**: a directory on your machine, mirrored into the deployment by one command. The assistant answers from a knowledge base: one Azure AI Search index that **Azure's own indexer** fills from Blob Storage. The indexer cracks each file, reads its pictures by OCR, splits it into chunks and embeds them (integrated vectorization). Who may read each file, and what it is, travel in its blob's metadata. The index is built from that metadata, and there is no other catalog.

## A library

```
handbook/
  access.json
  catalog.json
  onboarding.md
  policies/expenses.pdf
  pictures/desk.png
```

A Markdown document:

```markdown
---
title: Onboarding handbook
summary: What a new colleague does in the first week.
tags: [onboarding, people]
---

## Day one

![A desk with a laptop and a welcome card](pictures/desk.png)

Collect your badge at reception…
```

| Rule | Detail |
| --- | --- |
| Formats | Documents: PDF, Word (`.docx`, `.doc`), PowerPoint (`.pptx`, `.ppt`), Excel (`.xlsx`, `.xls`), HTML, Markdown, plain text and CSV. Pictures: PNG, JPEG and GIF. Anything else — JSON included — the ingest script names and does not upload, and the job skips with the reason in the log. |
| What a file is | A Markdown file says it in its front matter: `title`, `summary` and `tags`, nothing else, read strictly. Any other file in `catalog.json` (below). A file nobody described is titled with its name, with no summary and no tags. A blob no load described at all — one placed in the container by hand — is indexed and never served. |
| Tags | The one field that is both searchable and filterable, so the only hard constraint the search planner can apply. Reuse the tags your library already has; a tag nobody else uses filters to nothing. A tag may not hold `\|`, which the filter uses to separate tags: the file that carries one fails to describe. |
| Pictures | A picture's own text is read by OCR, and a picture inside a PDF or an Office file is read the same way into its document's text. A Markdown document can show a picture beside its text; see **Pictures** after the table. |
| Chunks | The indexer splits each file's text into pages of about 2000 characters, each repeating the end of the one before, and embeds each (`knowledge.indexer` in [configuration](configuration.md#knowledge)). |
| Cards | The library tile draws one card per document: its title, summary and tags, and a thumbnail — a picture is its own; a document's is the first picture its first chunk shows (a search's card shows the first picture of the passage it found). A document whose first chunk shows no picture gets a placeholder glyph. |
| The reader | A Markdown or plain-text document is read whole from its file, paged by its headings, its pictures shown beside the text. A PDF or an Office file is shown as extracted text; see **The reader** after the table. |
| Sources | Under a reply that drew on the library, a chip per document (the title, with its thumbnail), each opening that document in the reader, on both retrieval engines. See **Sources** after the table. |
| Skipped | Hidden files, everything under a hidden directory, symbolic links (so nothing outside the directory is sent), and anything not in the list above. `access.json` and `catalog.json` are read by the job, never indexed. |

**Pictures.** A Markdown document shows a picture on a line of its own by relative path (`![what it shows](pictures/x.png)`). The reader and the search show it beside the passage. The alt text is what makes it findable, because the index sees words, not pixels. A picture with no text in it and no document showing it cannot be found.

**The reader.** A PDF or an Office file is shown as the text the indexer extracted, one page per chunk in order, with no rendered pages and no download. The raw file is never served. Only the pictures the library holds are served, by path on the media route, to a signed-in reader.

**Sources.** The chips show provenance; they do not prove the reply:

- **Which documents get a chip.** Of the documents retrieved, the ones whose title the reply's text names, matched case-insensitively and reading past Markdown emphasis. The persona asks the assistant to name the document it drew on in plain words. When the reply names none, all of them get a chip, so a reply that drew on the library never has an empty row.
- **What a chip says.** It says which documents the reply named or was handed. Nothing checks each claim in the reply against them.
- **When they are decided.** Once, as the turn ends, on both engines. In a live session they go under the answer the voice spoke, from what the session's calls retrieved since the person last spoke, drawn under that line of the voice panel's transcript.
- **How the candidates are found** differs by engine. On the hybrid engine the `knowledgeSearch` tool names the documents its result handed the model. On the knowledge base the backend reads the `knowledge_base_retrieve` call's own output, where each reference names its chunk by the index's document URL. It resolves the keys under the caller's readers clause and the served filter (`documentsByChunk`). A `url_citation` annotation from the service takes the same path; it is also read, but is not always there.
- **Web pages.** A web page the assistant cited is not a chip: a source is always a library document.

`catalog.json` describes files that cannot describe themselves, with the same path and glob rules as `access.json`:

```json
{
  "policies/expenses.pdf": { "title": "Expense policy", "summary": "What is paid back, and how fast.", "tags": ["finance"] },
  "policies/*.pdf": { "tags": ["policies"] }
}
```

## Who may read a document

`access.json` at the library's root names readers per file, as Entra **group object ids** and **user object ids**:

```json
{
  "*": { "groups": ["all"] },
  "people/**": { "groups": ["<people team group id>"] },
  "people/pay-review.md": { "groups": ["<people team group id>"], "oids": ["<a user's object id>"] }
}
```

- For each file, an exact path wins, then the first glob in the file's order that matches, then `*`, then the deployment's default.
- Entries are per file: a directory is not an entry and nothing inherits from one. `people/` admits nothing; `people/**` is how to say "everything under it".
- `all` means everybody signed in.
- A file names at most 100 readers across `oids` and `groups`, because they travel in its blob's metadata, which holds 8 KiB in all. More fails that file, naming it: give the readers a group, and name the group.
- A manifest that does not parse fails the load before anything is described. So does an `access.json` entry that names a path, not a pattern, and matches no file: otherwise a mistyped name would leave its file to the default, open to everybody.
- Readers are read from `access.json` at load time and nowhere else. To change who may read a file, edit `access.json` and run the load again (`./scripts/ingest.sh <dir>`, or the next deploy for the product's own library). No separate re-index is needed. The load rewrites the metadata of each file whose readers changed, runs the indexer and waits until a search sees what it wrote; the indexer has no schedule and runs only when a load starts it. Opening a document or picture by id follows the new readers as soon as the load has described the file, and search and the library follow when the indexer run ends. So the change is complete when the load succeeds, and nothing changes until a load runs.

Two switches in the `access` settings document decide what readers mean ([configuration](configuration.md#access)):

| `enforceAccessControl` | `globalDocumentAccess` | Result |
| --- | --- | --- |
| `false` (a demo's default) | any | Readers are recorded but not applied: everybody signed in finds every document. |
| `true` (a hardened deployment's default) | `true` (default) | Each search is filtered to documents whose readers include the person's object id, one of their groups, or `all`. A file no entry names is `all`. |
| `true` | `false` | As above, but a file no entry names admits nobody, and documents already loaded as `all` are hidden at once. |

Hardened mode enforces readers from the first deploy: the job seeds the `access` document with `enforceAccessControl` on. Demo mode leaves it off, so turn it on there before loading restricted documents. The job never overwrites a stored document, so a deployment that already holds one keeps its value: one made with an earlier version of Agent on Azure, which seeded enforcement off, or one first deployed in demo mode and hardened later. Turn enforcement on there with the command in [deployment](deployment.md#storage-memory-and-deploying-hardened). A load that records readers short of everybody while enforcement is off doesn't fail. It counts those files in a line starting `WARNING: READERS NOT ENFORCED` in the job's log, and the ingest script repeats the line on screen. How the filter works, and why it is the backend's own rather than Foundry's search tool, is in [security](security.md#who-may-read-a-document).

**How groups reach a person.** Group ids come from the `groups` claim of the person's Entra token, recorded on their account at every sign-in (set the registration to emit them: [deployment](deployment.md#sign-in-with-microsoft-entra-id)). Agent on Azure doesn't sync Entra groups: `access.json` names group ids, and membership is read from the token. The backend reads the groups from the account's row on every request, uncached, and the row changes only at sign-in. So a change in Entra, including a person removed from a group, reaches document access at the person's next sign-in. That is within eight hours, the longest a session lasts (`SESSION_MAX_AGE_SECONDS`). Only groups assigned to the application are emitted; a token whose groups overflow Entra's limit records none, and Agent on Azure never calls Microsoft Graph to fetch them.

**Local sign-in sees only `all`.** Demo mode's `local` sign-in has no Microsoft identity and no groups, and its subject is `local:<uuid>`, minted anew at every sign-in. Enforcement compares that subject with `oids` like any other. So an `access.json` that names one admits that session once the library is loaded again. That is enough for a test and useless beyond it, since the next sign-in is a new id. In practice, under enforcement a local person finds exactly the documents open to everyone.

### Check readers on a hardened deployment

The stand-in tests cover this rule ([acceptance](acceptance.md#permissions), P1 to P3); these steps check it against the real index and Entra. They need two Entra users who hold the `user` role, Ann and Bob, and a group that Ann is in and Bob is not, assigned to the application so its id is in the token.

1. Confirm `app/access` holds `"enforceAccessControl": true`.
2. Make a library with two Markdown files on a subject nothing else in the library covers: `restricted.md`, with a picture of its own, and `open.md`. Its `access.json` is `{"restricted.md": {"groups": ["<the group's id>"]}, "pictures/**": {"groups": ["<the group's id>"]}, "*": {"groups": ["all"]}}`. Load it with `./scripts/ingest.sh`; it must not print `WARNING: READERS NOT ENFORCED`.
3. Sign in as Ann: the library lists both documents, a question about `restricted.md` is answered from it with its source chip, and the reader opens it with its picture. Note the document's id and the picture's `/api/media/...` path.
4. Sign in as Bob in another browser profile. Expected: the same question gets no answer from `restricted.md` and no source for it; the library does not list it, and a search there does not find it; `open.md` is listed and answered as for Ann.
5. As Bob, request the document by id (`/api/library/<id>`) and the picture's path directly. Expected: `404 not_found` for both, the same answer as for an id that does not exist.
6. Remove Ann from the group in Entra. Her access ends at her next sign-in: sign her out and in again, and she sees what Bob sees.

## Load a library

From the repository root, after `azd up`:

```sh
./scripts/ingest.sh ~/handbook             # the library "handbook", from ~/handbook
./scripts/ingest.sh ~/exports/hr policies  # a library name other than the directory's
./scripts/ingest.sh --dry-run ~/handbook   # names what would be uploaded and deleted; changes nothing
./scripts/ingest.sh --remove handbook      # take the whole library out
```

`./scripts/ingest.ps1` is the PowerShell version (`-DryRun`, `-Remove`). The script needs `azd`, `az` and `openssl` only, and `curl` where `--open-listener` is left to ask for your address.

What it does:

1. Mirrors the directory to the storage account's `library` container under `<name>/`, as you (`az storage blob` with `--auth-mode login`; your Storage Blob Data Contributor role allows it). It uploads every file of a format a library takes whose bytes its blob does not already hold (compared by the MD5 the service keeps). It deletes every blob under `<name>/` that the directory no longer has. A file of any other format is named (`skipping …, not a format a library takes`) and never sent; the script's list of formats is held to the job's by its test.
2. Points the migrate job at `library:<name>` and runs it. Inside the deployment's network the job:
   - **describes** each file in its blob's metadata — its readers from `access.json`, its title, summary and tags from its front matter or `catalog.json`, its kind — rewriting only what changed;
   - **runs AI Search's indexer** and waits for it: the indexer reads every blob changed since its last run, cracks it, reads its pictures, splits and embeds it, and copies the metadata onto every chunk;
   - **prunes** the chunks of every file the library no longer holds;
   - **shields**: Prompt Shields reads every chunk in the index it has not read or whose text changed since it did, whichever library it belongs to. A chunk is served only once it has been read and found clean ([security](security.md#model-safety)). One indexer covers the whole container and reads what it decides has changed, so a run started for one library can write another's chunks again. For that reason the scan after every run covers the whole index. It also follows a run that failed the load, since that run still wrote what it reached. Telling a changed chunk from an unchanged one means reading its text, so the scan's read grows with the index, while Prompt Shields is asked only about the chunks that need it.
3. Puts the job's deploy steps back.

Library names are letters, digits, `.`, `_` and `-`, starting with a letter or digit. Do not run it while a deploy is running: both drive the one job.

**With private networking on** (hardened mode), Storage has no public listener. The mirror (step 1 above, your machine's `az storage blob` calls) cannot reach the account from outside the network, while step 2, the job, runs inside it and needs nothing. The script reads the account's `publicNetworkAccess` first. When it is `Disabled`, the script refuses before any blob call and prints the two ways through:

```sh
./scripts/ingest.sh --open-listener ~/handbook   # the listener on for the mirror, off again after it
```

`--open-listener` (`-OpenListener` in PowerShell) works like this:

- **What it opens.** It sets the account's `--public-network-access Enabled` and adds one rule to its firewall, for your machine's public IPv4 address. Then it runs the listing, the uploads and the deletes.
- **When it closes.** It takes the rule out and turns the listener off again before the job is started. It does the same on the way out of a run that fails, or that a closed terminal or a termination ends, and of a `--dry-run`, which only lists but has to open the account to list. Each of the two is taken back whatever became of the other. One that the service keeps refusing is named, alone, with the command that takes it back by hand.
- **The tag.** Before it opens anything, the script records what it is about to open on the account itself, in a tag (`ingestListener`: the run, the address, whether the rule is its own, and when). It takes the tag off once the account is closed. So a run that was killed outright is seen by every machine and by the pipeline, not only the one it ran on.
- **A run that finds a tag** touches nothing of another run's. While the tag is younger than an hour it refuses, since that run may still be uploading. When the tag is older, it closes what the tag names if the address is its own machine's, and otherwise refuses.
- **`--close-leftover`** (`-CloseLeftover`) closes what the tag names whatever its age, for a run you know has ended. Given alone, it does only that. Closing takes out the rule the tag names, and turns the listener off only where the firewall still denies by default, so an account made public since is left public. A tag the script did not write is never acted on, only taken off when you say so.
- **Permissions.** Opening the account and tagging it are control-plane writes (`Microsoft.Storage/storageAccounts/write`, `Microsoft.Resources/tags/write`), which Contributor on the resource group holds. A tag that cannot be written stops the run before anything is opened.
- **Who gets in.** The firewall's default action stays `Deny`, so the open listener admits that one address and nobody else, and only a caller Entra ID has signed in and Storage's roles allow.
- **The address.** It is the one `--ip <address>` (`-Ip`) names. Without it, the script asks `https://api.ipify.org` what address its request came from; that is the one request it makes outside Azure. Name the address yourself where that request is not wanted, or where the answer is not the one Storage sees (a proxy, a split tunnel). Either way it must be a public address, the only kind a storage firewall rule admits. A private network's address, a carrier's shared range or a loopback is refused before the listener is touched. A rule the account already held for the address is left as it was.
- **Storage's own limits.** A firewall rule takes an IPv4 address, and [a rule does not admit a caller in the account's own Azure region](https://learn.microsoft.com/en-us/azure/storage/common/storage-network-security), whose requests arrive from a private address. From a machine in that region, run the script inside the network.
- **How long it is open.** The window is open for the mirror alone: seconds for a listing, as long as the uploads take for a load. The account's private endpoint and the apps' identities are untouched by it.

Without the flag the refusal stands. The other way through is to run the script from a host inside the virtual network, signed in to `az` and `azd` there. That host is the jump VM that `DEVELOPER_ACCESS=true` adds ([deployment](deployment.md#developer-access)). Its identity holds no role on Storage, so the sign-in there is yours and interactive.

**Your directory is the library.** Every run makes the knowledge base match it:

| You | The next run |
| --- | --- |
| Add or edit a file | Uploads it; the indexer reads it, and its chunks are replaced. An unchanged file is not uploaded, so the indexer does not read it again. |
| Delete a file | Deletes its blob, and the job deletes its chunks (`pruned` in the log). |
| Edit `access.json` or `catalog.json` | Rewrites the metadata of the files it covers; the indexer reads those files again. |
| `--remove <name>` | Deletes the prefix and every chunk of that library. Other libraries and the sample library are untouched. |

**After a failure**, run the same command again; every step is rerunnable. A file that cannot be described (a front matter it cannot read, too many readers) or that the indexer failed is named in the log and fails the job, and the other files load. A run in which any file failed prunes nothing, so a broken run never takes old chunks with it, and an empty directory is refused rather than read as "remove everything".

## Retrieval through a knowledge base

By default `knowledgeSearch` is the backend's own hybrid query over the index. Vector and keyword search are fused and reranked by the service, floored on the reranker score, capped per document and filtered to the chunks Prompt Shields found clean. Under access control they are also filtered to the caller's readers. The query tells the model which words of the question none of the passages held. A passage is its chunk whole, so the one bound on what a search hands the model is the indexer's page, `indexer.chunkChars` ([configuration](configuration.md#knowledge)), times the passages a call returns (six). The passage itself carries no second cap: one would cut a chunk short of text the index holds, and no further search could reach what the tool never sends. The same index can instead be searched by Azure AI Search's own retrieval engine, a *knowledge base* ([Foundry IQ](https://learn.microsoft.com/en-us/azure/foundry/agents/concepts/what-is-foundry-iq)), which can plan a search with a model of its own. It is opt-in. The backend asks it, for a typed turn and a live session alike, through the same `knowledgeSearch` function: the base chooses the chunks, and the backend reads them back under the filters every search in Agent on Azure carries. The agent never calls the base itself — the service's `mcp` tool is not used, by choice ([decisions](decisions.md), decision 27).

To turn it on:

1. Choose the engine: `azd env set RETRIEVAL_ENGINE knowledgeBase` before the deploy ([choose components at deploy time](deployment.md#choose-components-at-deploy-time)), which seeds `retrieval.engine` when the `knowledge` document is absent; on a deployment whose document exists, set `retrieval.engine` to `knowledgeBase` in it ([configuration](configuration.md#knowledge)).
2. For a reasoning effort above `minimal`, `azd env set KNOWLEDGE_BASE true` and `azd provision`: the template makes the base's planning deployment, `models.knowledgeBase` ([configuration](configuration.md#the-knowledge-bases-planning-model)). The search service's own identity already holds Cognitive Services User on the account, which calls it; no further role. Without it the base runs at `minimal` only.
3. Start the job's `index` step (`az containerapp job start ... --args src/job.ts index`; every deploy runs it): beside the index it makes one search-index knowledge source, `<index>-source`, wrapping the index as it is — nothing is indexed again — and one knowledge base holding that source, `<index>-kb`: extractive retrieval, never the service's answer synthesis, carrying the planning model whenever the deployment has one. The source is made on the generally available API version (`2026-04-01`); the base is written, and asked, on `2026-08-01-preview` (`KNOWLEDGE_BASE_PREVIEW_API_VERSION`), since the GA version takes neither a model on a base nor a reasoning effort, and `@azure/search-documents` serializes neither, so the job PUTs the base by REST. The step also deletes the bases named `<index>-kb-low` and `<index>-kb-medium` wherever it finds them, since it makes one base and a provision never deletes, and `postprovision` deletes any project connection to a base's MCP endpoint, which Agent on Azure does not use. The step is rerunnable, and makes no base while the engine is `hybrid`.

How hard the base works is the effort each search carries ([Set the retrieval reasoning effort](https://learn.microsoft.com/en-us/azure/search/agentic-retrieval-how-to-set-retrieval-reasoning-effort)): `retrieval.reasoningEffort` for a typed turn, and `retrieval.voiceReasoningEffort` for a live session, which is the typed one unless it names its own ([configuration](configuration.md#knowledge)). `minimal`, the default, searches the question as it is; `low` has the base's planning model rewrite it into sub-queries searched in parallel; `medium` adds a semantic classifier and, when the first pass looks insufficient, a second. The effort is on the `retrieve` call, which overrides the base's own query by query, so a change applies from the next search, with no run of the job and no role on the search service for the backend, which only queries. A live session's search waits at most `retrieval.voiceDeadlineMs` (eight seconds unless set), a typed turn's `retrieval.deadlineMs` (the same unless set); planning adds seconds to a search, so weigh the effort against the bound.

`knowledgeSearch` asks the base's `retrieve` route with the backend's own identity, over the search private endpoint it already queries — Search Index Data Reader retrieves — sending the question as a semantic intent at `minimal`, where the service refuses messages, and as a user message above it. Above `minimal` the service plans an intent too, although the route's description calls intents queries "to execute without model query planning". It then reads the chunks the base chose back by key, in the base's order, under the served filter and the readers clause (`knowledgeBaseSearch`, `platform/knowledge/src/knowledge-base/search.ts`). A chunk the base chose that the filter does not admit is left out and said once (`knowledge.cited_unserved`). So a search on the base, typed or spoken, gets the base's choice as passages with their document ids and media paths, never a chunk the shield flagged, and the sources under the reply are the documents those passages came from, as on the hybrid query.

What the knowledge base does not carry, and what follows from it:

| Not carried | What follows |
| --- | --- |
| The caller's readers clause (`oids`, `groups`) | While `access.enforceAccessControl` is on, every `retrieve` call carries it in the source's `filterAddOn`, beside the served filter, and the read-back applies both again (see **Readers** after the table). |
| The `injection eq false` filter | Prompt Shields' verdict is a field on each chunk; the base can choose a chunk the shield has flagged, or not yet read, and the read-back drops it, so the model never reads one, at the cost of a passage fewer. A persisted `baseFilter` on the source is the `2026-05-01-preview` API's, which `@azure/search-documents` 13.0.0 does not carry. |
| The unmatched query terms, the reranker floor, the per-document cap, the backend's own planner | The base's own ranking stands, with its order, and `knowledgeSearch`'s per-document cap; there is no word on which terms missed, and the backend's planner does not run, since the base plans its own. |

**Readers.** Each `retrieve` call carries the served filter: clean chunks of described files only. While `access.enforceAccessControl` is on, the caller's readers clause goes beside it, as `(<served>) and (<readers>)`. The filter goes in `knowledgeSourceParams` as the search-index source's `filterAddOn`, an OData filter the service applies to the index ([Retrieve data using a knowledge base](https://learn.microsoft.com/en-us/azure/search/agentic-retrieval-how-to-retrieve)). It is the filter the hybrid query carries, built from the caller's verified account row. The model never sees it or sets it. So the base chooses only among the chunks the hybrid query could find. The read-back applies the same filter again, as defense in depth. Pictures and document reads go through the same read-back, so they are covered as before. Document-level permissions on a knowledge base are a preview of the service's own, over a different index schema, and Agent on Azure does not adopt them.

Billing: a knowledge base bills retrieval **tokens** on the search service, not queries. The free plan, the default on every tier, gives a monthly allowance and then answers a payment-required error; the standard plan bills past it. The template's search module (AVM `search-service` 0.13.0, API `2025-05-01`) predates the `knowledgeRetrieval` property, so moving to the standard plan is a patch on the service after provisioning: `az rest --method patch --url "https://management.azure.com/subscriptions/<sub>/resourceGroups/<rg>/providers/Microsoft.Search/searchServices/<name>?api-version=2026-11-01" --body '{"properties":{"knowledgeRetrieval":"standard"}}'` ([enable or disable agentic retrieval](https://learn.microsoft.com/en-us/azure/search/agentic-retrieval-how-to-enable-disable)). The `semanticSearch: standard` consent the template sets does not carry over to it.

## What you may do in Azure directly

| In Azure | Do it? |
| --- | --- |
| Upload or delete blobs in the `library` container | No. The container is the script's copy of your directory, and nothing is described or indexed until the job runs. The next run puts the prefix back as your directory has it. Change the directory instead. |
| Run the indexer from the portal | It reads what changed, and nothing it cuts is served until Prompt Shields has read it: run the job's `shield` step afterward (`az containerapp job start` with `--args src/job.ts shield`). |
| Reset the indexer | Possible: its next run reads every blob again (and pays for the embeddings and OCR again). |
| Delete documents from the search index | No. The indexer does not put back a chunk of a file that did not change. Use `--remove`, then load the library again. |
| Restore a soft-deleted blob | Possible for 7 days, but it brings nothing back until the file is in your directory again. |
| Edit the `access` or `knowledge` settings documents | Yes; live within about 30 seconds. `knowledge.indexer` reaches the skillset at the next deploy's `index` step. |
| Assign groups and roles in Entra | Yes; reaches a person at their next sign-in. |

## The sample library

Nine fictional documents ship in `apps/backend/sample/library/` (onboarding, a project plan and brief, customer support, account reviews, depot operations, security basics, an incident runbook, the employee handbook), each with one picture, all readable by `all`. The documents and pictures were made for this repository and are covered by its license. Every deploy mirrors them into the container as the library `@sample` and loads them like yours.

To deploy without them:

```sh
azd env set SEED_SAMPLE_LIBRARY false
azd deploy
```

The deploy's last step then removes the sample library (and does nothing once it is gone). Set it back to `true` to load it again.

The deploy's `library` step does nothing to your libraries but shield them again. It describes and prunes under `@sample/` alone. The one indexer it runs reads every blob whose last-modified time moved since its last run, and that can include a blob of yours it read before. Describing a file writes its metadata, and any write to a blob, metadata included, changes its last-modified time ([Set Blob Metadata](https://learn.microsoft.com/en-us/rest/api/storageservices/set-blob-metadata)), so the indexer writes that blob's chunks again. The scan that follows reads the whole index and shields every chunk that needs it, whichever library it is in ([security](security.md#model-safety)), so a deploy cannot leave your documents out of the library and the search. The knowledge base engine chooses its chunks without that filter, and the backend reads them back under it: a chunk with no clean verdict is left out of what the agent's model is handed and said on stdout as `knowledge.cited_unserved` ([above](#retrieval-through-a-knowledge-base), [limitations](limitations.md)).

The retrieval internals — the index definition, the pipeline's definitions, the planner, the scan — are in [`platform/knowledge`](../platform/knowledge/README.md).
