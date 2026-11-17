# @platform/knowledge

This package gives the agent retrieval-augmented generation over documents, and nothing else. **Azure ingests; this package queries.**

A library is files in one Blob container, each described in its blob's metadata. Azure AI Search's own indexer cracks, OCRs, splits and embeds them into one index (integrated vectorization), copying that description onto every chunk. Prompt Shields reads every chunk once, and a planned hybrid query carries the generally available security filter. The index sees words, and only four fields of them: `title`, `summary`, `chunk` and `tags`. A path, a kind and an id are payload or filter, never a description. `tags` is the one field that is both searchable and filterable, and so the only hard constraint a query can express.

- `library` — a library as files and their descriptions.
  - `formats` is what a library takes (PDF, Word, PowerPoint, Excel, HTML, Markdown, text, CSV; PNG, JPEG, GIF) and the type each is stored under.
  - `readers` resolves `access.json`, and `catalog` resolves `catalog.json` and a Markdown file's strict front matter (`markdown`). Both follow the manifests' one rule (`manifest`: exact path, then the first matching glob, then `*`).
  - `metadata` encodes a description as blob metadata: the path, the title and the summary as base64, the tags and the readers as ASCII JSON arrays. It refuses one past 8 KiB or naming more than 100 readers.
  - `load` is the job's `library` step. It describes every file (rewriting only what changed), runs the indexer and waits, prunes the chunks of files the library no longer holds after a clean run, and shields. Shielding covers every chunk in the index whose text Prompt Shields has not read. The one indexer may have rewritten another library's chunks, and whether a rewritten chunk keeps its verdict is up to the service.
  - An `access.json` entry that names a path (not a pattern) and matches no file fails the load before any file is described. A run the service did not call a success fails the load whichever files it names, after the scan, because a run that stopped short still rewrote what it reached.
  - A file's text is read without the byte-order mark an editor may have put at its head, so a manifest or front matter saved with one reads as written.
  - A step's read of the `access` document is retried a few times before the load fails. `removeLibrary` deletes a library's blobs and chunks.
  - `mirror` makes a directory the container's copy under a library's name, uploading only what the blobs do not already hold, for a library that ships with an app.
- `pipeline` — Azure's ingestion as definitions the job makes through the service's API (Search objects are not ARM resources):
  - the blob data source (by resource id, keyless, soft-delete deletion detection);
  - the skillset (OCR and merge, text split, Azure OpenAI embedding, OCR billed to the Foundry account by identity, index projections of one chunk per page);
  - the on-demand indexer, whose field mappings decode the metadata.

  `FIELD_MAPPINGS` and `PROJECTION_MAPPINGS` are exported data, so the stand-in indexer runs exactly these. `ensurePipeline` makes all four. It deletes and remakes an index keyed on another field, or whose vector field is not stored (resetting the indexer). The reason: the shield's merge onto a chunk erases a vector the index does not store, without an error, and with it the vector arm of every search. `runIndexer` starts a run and waits for that run, telling it from the last by the service's own start time, and returns each failed file by its path.
- `index` — the index and its clients:
  - the index definition (HNSW, int8 quantization with rescoring, a semantic configuration, and an Azure OpenAI vectorizer on the deployment the skillset embeds with);
  - the three keyless SDK clients, and the keyless REST writer for what the SDK does not carry;
  - the keyset walk over a filter (`walkChunks`), because a `$skip` past 100,000 is refused and a walk must not stop there;
  - the two writes that are not the indexer's: deleting a removed file's chunks, and merging Prompt Shields' verdicts;
  - `checkChunkIndex`, a process's startup check: a configured service that cannot be read throws, and an absent index is the job's to make.
- `shield` — Prompt Shields at load. The library's passages reach the model as a function tool's output, which Foundry's guardrail does not scan.
  - So `shieldChunks` sends every chunk with no verdict, or whose text no longer matches the hash its verdict was about, to `text:shieldPrompt` on the Foundry account as documents, packed to the request's limits. It merges back `injection` and `shieldedHash`.
  - The index holds no hash of a chunk's current text, so the scan reads every chunk's text, a page at a time, to find the ones that need it. Its cost grows with the index, not with the load that ran it.
  - A verdict is written only over the text it was given about. A chunk rewritten while Prompt Shields read it has its verdict withdrawn, and one deleted is left gone.
  - Under a load, Prompt Shields failing on another library's chunks withdraws their verdicts and is reported (`withheld`). Failing on the load's own chunks fails the load.
  - The client goes through `@platform/llm`'s token, fetch and retry.
- `query` — the question, planned and run.
  - A quick check that calls no model (`planner.gate`) decides whether a question holds anything a filter could act on: a selective tag, an entity's alias, a request for pictures.
  - A small model drafts a plan, which the code validates against the live tag vocabulary and the real kinds.
  - The hybrid search is one request: the lexical arm over the four fields, and the vector arm as text the index's vectorizer embeds. The service fuses and reranks the results; they are then held to a score floor and capped per document.
  - The relaxation ladder loosens a plan that was right about the question and wrong about the library, tags first, then the kind, and names every constraint it gave up.
  - `unmatchedQueryTerms` comes with every result: a search that missed still answers, and this field says so.
  - `documents` is the reader and the picture check the media route runs. The reader shows a text file from its blob, Markdown paged by its headings with its pictures lifted out, and any other format from its chunks in order, with the split's overlap taken off.
- `knowledge-base` — the other engine, off unless `retrieval.engine` names it: one knowledge source over the index and one knowledge base, made by the job. A search asks the base to choose chunks at the channel's reasoning effort, and reads them back under the served filter and the spec, both requests under the search's deadline. While access control is enforced the hybrid search answers instead, because the base chooses without the readers clause.
- `config` — the `knowledge` document (retrieval, the planner, the indexer, the scan) and the `access` switches, from App Configuration.
- `models` — the one model call this package makes, the planner's draft, behind `QueryDrafter`; the default is `@platform/llm`'s small chat model. Embedding is the service's.

## Access

Who may read a document is decided from the caller's verified claims (the identity provider's object id and the group ids the account's row holds), and from nothing a request body said. A library's `access.json` names each file's readers. The job writes them into the blob's metadata as `oids` and `groups`, and the indexer's field mappings copy them onto every chunk as two filterable collections the index never searches. The value `all` in `groups` marks a document every signed-in person may read; a file no entry names gets the settings' default.

Two switches live in the `access` document in App Configuration (`config/access.ts`). Both are compiled in, and both are read toward the closed side: a switch stored as anything but a boolean enforces (`enforceAccessControl`) or withholds (`globalDocumentAccess`). While a configured store has never answered, the settings are an error and not the defaults. Every search, listing and read is refused (`retrieve` names `access_unreadable` in `refused`), a picture admits nobody and a load fails. Once the store has answered, the last good value stands over a failed refresh. A checkout with no store reads the defaults.

- `enforceAccessControl` (default `false`; `true` where `HARDENED` is on, `defaultAccessSettings`). On, every search carries the caller's clause, `oids/any(t: t eq '<oid>') or groups/any(t: search.in(t, '<g1>|<g2>|all', '|'))`, each literal quoted by `index/odata.ts`. A search with no caller returns no rows: `retrieve` names it in `refused` for the app to report, and nothing widens. Off, no clause, whoever is asking.
- `globalDocumentAccess` (default `true`). On, a file no entry names is described with `groups: ["all"]`, and `all` is in every caller's clause. Off, such a file admits nobody, and `all` leaves the clause, so every document already loaded as global is hidden at once.

Every search, and every tag count the planner is shown, carries `injection eq false and documentId ne null` beside the clause (`servedFilter`):

- A chunk Prompt Shields has not read has no verdict, and `null` is not `false`.
- A blob in the container that no load described has no metadata for the indexer to copy. Its chunks are taken to carry no id and no readers, and are never served. The stand-in assumes the service leaves a field with no source null rather than refusing it; this is observed behavior, and no test here can show it.

The clause is not part of the query's spec, so the relaxation ladder never drops it. A reader opened by id runs the same clause. Where the reader shows a text file's own bytes (Markdown, plain text, CSV), it also holds the blob's description, read with those bytes, to the same rule (`readerAdmits`). So a file replaced since it was last indexed, whose readers a load has narrowed or not yet described, is shown as the index holds it, which is what a search serves. A picture is checked against its own blob's metadata by that rule too, because a picture with no text has no chunk. A local sign-in has no groups and a subject nobody can name, so it reads exactly what is `all`.

This is Azure AI Search's GA security-filter pattern. Why it is not Foundry's search tool or Search's native trimming (preview), and what switching to them takes, is in `docs/security.md`.

## Settings

Bootstrap comes from the environment, read where it is used:

- `AZURE_SEARCH_ENDPOINT` and `AZURE_SEARCH_INDEX` (default `chunks`) name the index.
- `AZURE_STORAGE_RESOURCE_ID` names the account the data source reads (the job only).
- `AZURE_OPENAI_EMBEDDING_MODEL` names the model behind `AZURE_OPENAI_EMBEDDING_DEPLOYMENT`, which the skill and the vectorizer name beside it.
- The planner's deadline and its in-flight cap size one replica: `KNOWLEDGE_PLANNER_DEADLINE_MS` (8000), `KNOWLEDGE_PLANNER_INFLIGHT` (6).
- The knowledge base's planning model: `AZURE_OPENAI_KNOWLEDGE_BASE_DEPLOYMENT` and `AZURE_OPENAI_KNOWLEDGE_BASE_MODEL` (the job writes it into the base).

Everything an operator tunes is the `knowledge` document in App Configuration. It is read through `@platform/config`'s cached reader, refreshed once per settings refresh interval (`CONFIG_TTL_MS`, 30 s), and merged leaf by leaf over these defaults, so a portal edit can retune a bound and never remove one:

| Field | Default | Meaning |
| --- | --- | --- |
| `retrieval.engine` | `hybrid` | `hybrid` or `knowledgeBase`; the deploy's `RETRIEVAL_ENGINE` is the default when it is set. |
| `retrieval.reasoningEffort` | `minimal` | The effort a typed turn's knowledge-base search asks for: `minimal`, `low` or `medium`. |
| `retrieval.voiceReasoningEffort` | none | The same for a live session; unset, the typed one. |
| `retrieval.deadlineMs` | 8000 | The bound on one search request of a typed turn, and on the tag vocabulary's facet query, a second to a minute. |
| `retrieval.voiceDeadlineMs` | 8000 | The bound on one search request of a live session, a second to a minute. |
| `retrieval.candidateMultiplier` | 10 | Candidates pulled before flooring and diversifying, per result asked for; the service reranks at most fifty. |
| `retrieval.rerankerFloor` | 1.9 | The relevance floor on the reranker's 0–4 score. |
| `retrieval.maxPerDocument` | 3 | Results one document may hold. |
| `retrieval.vectorWeight` | 1 | The vector arm's weight against the text arm's fixed 1. |
| `retrieval.semanticRanker` | true | Whether the service's reranker runs; off, there is no score to floor on. |
| `retrieval.tagVocabularyMax` | 300 | Tags the planner is told exist, commonest first. |
| `planner.enabled` | true | Off, every question is the fallback plan, the search that preceded the planner. |
| `planner.gate` | true | Off, every question is planned, whether or not it holds anything a filter could act on. |
| `planner.tagsShown` | 120 | Tags shown to the model. |
| `planner.tagSelectivity` | 0.5 | How common a tag may be, as a fraction of the commonest, and still count as signal; when that would leave none, every tag counts. |
| `planner.subjectTags` | `[]` | Tags that name the corpus itself, beside the product's own. |
| `indexer.chunkChars` | 2000 | The split skill's page, read when the job makes the skillset. |
| `indexer.overlapChars` | 200 | Characters each page repeats from the one before; shorter than the page, or the stored pair is refused. |
| `indexer.ocr` | true | Whether pictures are read by OCR. |
| `indexer.waitMinutes` | 25 | How long the job waits for one indexer run. |
| `shield.batchChars` | 10000 | Characters of chunk text in one Prompt Shields request. |
| `shield.batchDocuments` | 5 | Chunks in one Prompt Shields request. |

Every Azure client takes `azureCredential()` from `@platform/config`. The per-process state (clients, cached settings, in-flight counts) lives in `processSingleton`, so a development server's reloads reuse it.

## Tests

No test reaches Azure. `@platform/knowledge/testing` stands in at the SDK boundaries and nowhere else:

- an index (`fakeSearchClient`) that holds chunk documents and applies a `$filter` the way the service does (`testing/odata.ts` evaluates the OData this code writes and throws on anything else);
- an indexer (`fakeIndexer`) that runs the job's own data source, skillset and field mappings over `@platform/storage`'s blob stand-in, so `access.json` → metadata → `oids`/`groups` is tested end to end;
- a Prompt Shields (`plantedShield`) that flags a planted string.

`standInKnowledge()` wires all four. The two-person test (`query/readers.library.test.ts`) loads a library through the pipeline and searches it through the real query code. Some behavior only a real deployment answers: the indexer's mappings onto projected chunks, deletion detection through projections, the trusted-service path in hardened mode, and Prompt Shields' host. `docs/testing.md` lists these under *What only a deployment proves*.
