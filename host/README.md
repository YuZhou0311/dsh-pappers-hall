# Pappers-Hall Host half

Host-side domain service behind the Pappers-Hall paper center: a plugin-owned
SQLite library, PDF ingestion through poppler, joint keyword/figure search, a
persistent background queue, the `/pappers-hall/` same-origin HTTP API and the
eight `papers_*` Agent tools.

Everything here is plain ESM with **no npm dependencies** (only `node:` builtins
and the poppler CLI). The root plugin entry (`../index.js`) owns the Loader row;
this package owns the whole Host domain and can be exercised without DSH through
`node host/selftest.mjs`.

## Modules

| File | Role |
| --- | --- |
| `apply.js` | `applyHost(ctx, config)` assembly: data dir, DB, services, queue, routes, tools, idempotent `dispose()` |
| `paths.js` | Data-directory resolution, owned path layout, atomic writes, hashing, LIKE/CJK helpers |
| `db.js` | `node:sqlite` connection (WAL), `user_version` migration, FTS5 probe, transactions, settings |
| `pdf.js` | Poppler facade (`pdfinfo`/`pdftotext`/`pdftoppm`), bbox-layout parsing, region crops, dHash, minimal PNG decoder |
| `layout.js` | Real page structure (v0.2): paragraph blocks with role/column/bbox, XY-cut reading order, two-column flag, word/line layer, outline and abstract/fallback extraction |
| `store.js` | Domain store: papers/versions/pages/figures/annotations/notes/tags/sources/bundles/settings/events + the contract §2.1 read/write methods |
| `search.js` | Joint search (`search.query`) and figure search (`figures.search`), FTS index maintenance |
| `jobs.js` | Persistent job queue: lease, retry/backoff, pause/resume/cancel/retry, checkpoints, stale recovery |
| `ingest.js` | PDF and bibliography import pipeline, caption detection, figure crop/hash, per-paper state machine |
| `api.js` | JSON API dispatch (`/pappers-hall/api`) and binary asset routes (page/figure/thumb/pdf) |
| `ai.js` | Direct LLM channel (v0.2): `ai.status`/`ai.ask`/`translate.blocks|title|text`/query expansion/rerank, sessionId, timeout, concurrency, SQLite cache, hashed event log |
| `tools.js` | `papers_*` Agent tool definitions (real ImageBlock through `ctx.attachments`) |
| `selftest.mjs` | Standalone end-to-end selftest with a fake Cordis context |

## Mounting

```js
import { applyHost } from './host/apply.js'

const service = await applyHost(ctx, { dataDir: '/custom/path' }) // optional
ctx.effect(() => () => service.dispose(), 'pappers-hall: host lifetime')
```

- `applyHost` returns after initialization (`await`-able) and only then reports
  the service; all registrations live inside one `ctx.effect`.
- `service.dispose()` is idempotent: an HMR unload may dispose first, then the
  row's own effect disposes again — the second call is a no-op.
- A second `applyHost` in the same process disposes the previous installation
  first, so tools/routes/timers are never duplicated on reload.
- Optional services are resolved, not required: `webServer`, `attachments`,
  `translator`, `subprocess` each degrade to a documented state instead of
  failing the mount.

### Config keys

| Key | Default | Meaning |
| --- | --- | --- |
| `dataDir` | `$DSH_HOME/pappers-hall` | plugin-owned data directory (absolute or cwd-relative) |
| `fixtureDir` | `../../pappers_hall_devkit_lite` | developer manifest/bibliography source, optional |
| `pdfTools` | `{}` | executable overrides, e.g. `{ pdftotext: '/opt/homebrew/bin/pdftotext' }` |
| `testMode` | `false` | reserved marker for test libraries |
| `workerPollMs` | `1000` | job worker poll interval |
| `leaseMs` | `60000` | job lease (recovered when stale) |
| `maxFiguresPerPaper` | `80` | cap on detected figures per paper |
| `figureDpi` | `120` | native figure crop resolution |
| `figureSearchMaxDistance` | `10` | dHash Hamming threshold for near-duplicates (0–64) |
| `bodyLimitBytes` | 110 MB | JSON request body cap |
| `commandTimeoutMs` | 120000 | per poppler command timeout |
| `aiTimeoutMs` | 25000 | deadline for one auxiliary LLM call |
| `aiMaxConcurrency` | 2 | concurrent model calls (shared semaphore) |
| `aiMaxInputChars` | 6000 | prompt context cap for `ai.ask`/translation |
| `aiMaxOutputTokens` | 1600 | per-call output cap |
| `aiCacheTtlHours` | 72 | TTL of the SQLite `ai_cache` |
| `aiRerank` | `true` | allow LLM re-rank of the top-20 search hits |
| `aiRerankTimeoutMs` | 8000 | rerank deadline (search keeps keyword order when it expires) |
| `aiProvider` / `aiModel` | unset | override the Agent default model for this channel |

## Data and consistency

- SQLite (`node:sqlite` `DatabaseSync`) in WAL mode with monotonic
  `PRAGMA user_version` migrations; the current schema is version `1`.
- Tables: `papers`, `paper_versions`, `paper_pages`, `figures`, `annotations`,
  `notes`, `tags`, `paper_tags`, `sources`, `jobs`, `job_steps`, `bundles`,
  `bundle_items`, `settings`, `events`; FTS5: `papers_fts`, `pages_fts`,
  `figures_fts`, `annotations_fts`, `notes_fts`.
- File content is content-addressed (`data/files/<sha256>.pdf`); page renders
  and figure resizes are cached under `data/cache/**`, figure crops under
  `data/figures/`. All writes are atomic (temporary file + rename).
- Lifecycle: deletion is a soft delete (`state='trash'`, `epoch++`) and every
  search/tool read filters `state='active'`; restore assigns a fresh epoch, so a
  late job that captured the old epoch can never publish into restored content.
- The FTS tables are derived: trashed rows are filtered by joining the base
  table, and `rebuildAll()` can recreate the whole index from the truth in SQL.
- `operationId` writes are idempotent through a `settings` row keyed
  `operation:<method>:<id>`; a retried Client request returns the first result.

## HTTP surface

Registered on the composed web server as prefix `/pappers-hall` (no trailing
slash — the web server matches a prefix only as `pathname === prefix` or
`pathname.startsWith(prefix + '/')`, so `/pappers-hall/` as a prefix would never
match `/pappers-hall/api`). Public URLs remain `/pappers-hall/*`:

- `POST /pappers-hall/api` — `{method, params}` → `{ok:true,data}` or
  `{ok:false,error:{code,message}}`; body cap 110 MB (413 above it).
- `GET /pappers-hall/page/<paperId>/<page>.png?width=1400`
- `GET /pappers-hall/figure/<figureId>.png?width=900`
- `GET /pappers-hall/thumb/<paperId>.png`
- `GET /pappers-hall/pdf/<paperId>`
- `HEAD` is supported on every asset route. Assets are `Cache-Control:
  private, max-age=3600`. All identifiers are pattern-validated; no request
  string ever becomes a filesystem path.

### API methods implemented (contract §2.1)

Read-only (v0.4 additions): `translate.providers`, `translate.settings` (GET),
`translate.detect`, `discover.feed`, `annotations.feed`, `library.tiles`.

Read-only (v0.3 additions): `operations.recent`, `library.duplicates`,
`citation.key`, `saved_searches.list`, `ai.quickTranslate` (write-like but read-safe),
`metrics.refresh` (explicit network only).

Read-only: `status`, `library.list`, `library.get`, `search.query`,
`reader.open`, `reader.page`, `reader.layer`, `reader.pageText`, `reader.outline`,
`annotations.list`, `figures.list`, `figures.search`, `jobs.list`,
`library.collections.list`, `tags.list`, `ai.status`,
`export.bibtex`, `export.csl`, `export.notes`, `export.locations`, `diagnostics`.

Writes: `library.import` (optional `collectionId`/`tags`), `library.update`
(`addTags`/`removeTags`/`read`), `library.delete`, `library.restore`,
`library.purge`, `library.collections.create|update|delete|assign`,
`tags.rename|delete`, `annotations.create|update|delete` (v2 `kind`/`rects`/`comment`/`color`),
`notes.create`, `notes.delete`, `ai.ask`, `translate.title|text|blocks`,
`references.commit`, `references.resolve`, `jobs.pause|resume|retry|cancel`,
`metrics.update`, `metrics.refresh`, `operations.undo`, `library.merge`,
`citation.format`, `export.annotations`, `saved_searches.create|update|delete`,
`translate.settings` (SET `provider`/`fallback`).

Additions beyond the contract (Client convenience, safe to ignore):
`library.setRead` (mark read/unread), `library.tags` (tag list with counts),
`figures.search {figureId}` (similar-figure search, see below).

`references.commit` returns both a UI `display` string and a chat `token` of the
form `⟦Pappers-Hall 2 篇论文 + 1 张图 · bundle=bn-ab12cd34ef56⟧` (≤120 chars). The
token is what the Client inserts into the draft; it is the only bundle identity
the model sees, and `bundle=bn-…` is the parseable contract with the tools.

`figures.search` accepts `q`, `imageBase64` and `figureId`:
`figureId` reuses that figure's stored dHash and returns other figures within the
`figureSearchMaxDistance` Hamming threshold, with reason
`visual_near_duplicate` and an explicit channel note. It never returns the source
figure itself and never reports an embedding-style percentage.

### v0.2 additions

- **Reader v2**: `reader.page` returns paragraph `blocks[]`
  (`id/role/column/fullWidth/bbox/text/lines`) in reading order — header first,
  page-1 title, content sorted by `(column, y)`, footer last. `reader.layer`
  returns the raw `words[{t,x,y,w,h}]`/`lines[{x,y,w,h}]` layer in PDF points
  (2-decimal); `reader.outline` returns `items[{title,page,level}]` with 1-based
  page numbers. Structures are generated lazily: a v0.1 paper with no layout (or
  an older `layoutVersion`) schedules an idempotent `structure` job and the page
  reports `structureState='pending'` + `jobId`; a mount-time backfill regenerates
  stale layouts and fills missing abstracts in the background.
- **Annotations v2**: `kind` (`highlight|area|note`), normalized `rects` (0–1),
  `comment`, `color`, `origin`, `revision`; legacy `rect`/`text` fields are still
  returned. Stale `expectedRevision` conflicts are `conflict` errors and comments
  are searchable (`annotation_match` hits carry page/rects).
- **Collections & tags**: five field collections are derived from `papers.field`
  (never deletable); custom collections are CRUD + assign capable. `library.get`
  exposes `abstract/abstractSource/fileInfo/tags/collections/annotationCount/read`;
  `library.list` filters by `collectionId`/`tag`/`tags` and sorts
  `recent|added|title|year|authors`.
- **AI channel**: the plugin calls the Agent-default LLM directly
  (`ctx.get('agentDefaultModel')` + `ctx.get('llm')`) and passes a real
  `sessionId` (explicit request value → any live session → fixed fallback).
  `translate.blocks` translates ≤6 paragraphs per call (concurrency ≤2, one
  retry per batch, per-block `unavailable` + `reason`), `ai.ask` can attach the
  real rendered page/figure image, `search.query ai:'auto'` expands queries and
  re-ranks the top-20 (channels `ai_expand`/`ai_rerank` report `ok|degraded|off`
  with the model and reason). Successes are cached in `ai_cache`; every call is
  logged to `ai_events` with hashes/status/timing only (never user text).
- **Abstract/outline**: `abstractSource` is `pdf` (real "Abstract" heading),
  `pdf-heuristic` (largest first-page body paragraph, truncated to 1200 chars) or
  `metadata`; outlines skip the page-1 title and OCR/figure heading noise.

### v0.3 additions (research workflow)

- **Journal metrics, honestly labelled**: `papers` gains `citation_count`,
  `citation_updated_at`, `keywords_json`, `metrics_json`, `journal_key`;
  `papers_journal` caches one row per normalized venue. `library.get` returns
  `metrics{impactFactor, impactFactorYear, fiveYearImpactFactor, quartile, issn,
  publisher, journalName, citationCount, twoYearMeanCitedness, hIndex, i10Index,
  source, updatedAt, stale, canRefresh}`, `keywords`, `citationKey` and
  `readingProgress`. `metrics.refresh` is the **only** network path and requires
  `allowNetwork:true`: DOI → OpenAlex works (`cited_by_count`) → OpenAlex sources
  (`summary_stats.2yr_mean_citedness`, h_index, i10_index, 7-day journal cache)
  → Crossref (ISSN/publisher/volume/issue/pages). OpenAlex 2yr mean citedness is
  stored as `twoYearMeanCitedness` and never written to `impactFactor`; JCR IF is
  only shown when manual/real data exists. Per-paper failures return
  `{status:'failed', reason:'no-doi'|'openalex_http-404'|...}` and nothing is faked.
  `metrics.update` writes manual fields with `source:'manual'`.
- **Undo journal**: `operations` table records reversible writes
  (`annotation.create/update/delete`, `library.setRead`, `library.update`,
  `library.collections.assign`, `library.delete/restore`, `library.merge`,
  non-reversible `library.purge`). Reversible methods return an `operationId`;
  `operations.recent` lists them and `operations.undo` executes the journaled
  inverse idempotently (`already_undone`), while purge returns `not_undoable`.
- **Duplicates / merge**: `library.duplicates` groups by `sha256` and normalized
  title; `library.merge` moves tags/collections/read/annotations/notes to the
  primary and sends the duplicates to the recycle bin, fully reversible through
  the operation journal.
- **Citation / export**: `citation.format` (bibtex, apa, gbt7714, ris, csljson),
  `citation.key` (readable `authoryear` keys), `export.annotations`
  (markdown/json with page, color, quote, comment, time); `export.bibtex`/`export.csl`
  stay compatible.
- **Saved searches**: `saved_searches.list/create/update/delete` store a named
  JSON query object.
- **AI fast mode**: `translate.text|title|blocks` and `ai.ask` accept
  `fast:true` (`ai.ask` also `mode:'fast'`). Fast calls use
  `llm.prepareCall(config, signal, (controls, modelInfo) => ...)` to select the
  lowest reasoning effort the model declares (`none` → `minimal` → `low`; models
  without reasoning metadata are left untouched), cap translation output at 700
  tokens / answers at 800 tokens and the deadline at 12s, and return
  `fast:true` + the actual `reasoningEffort`. `ai_cache` keys include the fast/deep
  mode so the two never collide. `ai.quickTranslate` is the fast alias of
  `translate.text`.

### v0.4 additions (free translation engines + discovery feed)

- **Translation engine chain** (`host/translate.js`): real public engines with no
  API keys. `google` uses the **unofficial free gtx endpoint**
  (`translate_a/single`, engine metadata `unofficial:true, free:true`, disclaimer
  shown in `translate.providers`); `mymemory` uses the free public API (per-request
  ≤450 chars, sentence-preserving chunking); `llm` delegates to the existing AI
  channel (quality fallback, never presented as free); `libretranslate` only when
  `config.libreUrl` is set. `auto` = google → mymemory → llm (configurable via
  `translate.settings`). Each call: browser UA, 6s timeout, one retry for
  network/5xx, network concurrency ≤2, per-provider result cache in `mt_cache`
  (key = provider + source + target + text hash), event log in `mt_events`
  (time/provider/chars/elapsed/status/reason — never the text). Inputs are
  whitespace-normalized before MT (multi-line quotes become one sentence stream;
  `translate.blocks` keeps paragraph boundaries by translating each block), chunks
  are cut on sentence boundaries (`.!?;。！？；`) with word-safe overflow, and a
  quality gate rejects empty/too-short English-leak output (`low_quality_fallback`)
  so the chain tries the next engine instead of showing word-by-word garbage;
  suspicious results are never cached. Failures return `status:'unavailable'` with
  per-provider reasons (and a successful fallback reports `fallbacks[]`);
  translations are never fabricated and engine provenance
  (`engine.free/unofficial`) is always explicit.
- **Translation API**: `translate.providers` → `{preferred, fallback:[chain],
  fallbackEnabled, items[{id,label,free,unofficial,configured,available,
  lastLatencyMs,lastError}], disclaimer}`; `translate.settings` GET/SET →
  `{provider, fallback:boolean, providers}`; `translate.text` → `{status,
  translation, provider, engine, latencyMs, cached, chunks, reason?, failures?}`
  (plus v0.3 `provenance/elapsedMs/fast`); `translate.title`/`translate.blocks`
  use the same chain (per-block `provider/status/translation/reason/cached`);
  `translate.detect` returns `{language:'zh'|'en'|'unknown', han, latin, ratio}` so
  Chinese source is skipped instead of re-translated. `diagnostics.translation`
  adds engine status/cache/event counts.
- **Discovery feed** (`discover.feed`): one round-trip for the sidebar with
  `stats{papers,unread,reading,read,annotations,figures,notes,trash,tags,collections}`,
  `continueReading` (recent `last_read_at`), `unread`, `annotated`, `collections`,
  `tags`, `recentAnnotations`, `recentFigures`. `PaperTile` exposes exactly
  `id,title,titleZh,authors,year,venue,tags,read,readingProgress,annotationCount,
  figureCount,lastReadAt,addedAt,citationCount,impactFactor,hasPdf`.
  `annotations.feed` is a cross-paper stream with `paperId/colors/kinds/query`
  filters and `before` (createdAt) paging; `library.tiles` batches PaperTiles.
  `reader.open`/`reader.page` update `last_read_at` so "continue reading" is real.
- **Migration**: `user_version=4`; new `mt_cache`/`mt_events` tables and
  `papers.last_read_at`, applied idempotently next to the v0.2/v0.3 upgrades.
- **Config**: `translationProvider`, `translationFallback`,
  `translationTimeoutMs`, `translationMaxConcurrency`,
  `translationCacheTtlHours`, `libreUrl`/`libreApiKey`; `translationForcedFailures`
  (test hook used by the selftest to exercise the degradation chain offline).

### v0.5-A additions (nested folders + single favorite + filters)

- **Migration `user_version=5`**: `papers.favorite INTEGER NOT NULL DEFAULT 0`,
  `collections.parent_id TEXT`, `kind` now `'folder'|'field'` (existing custom
  collections become nested `folder` rows; the five derived field collections stay
  `kind='field'` and read-only), `collections(parent_id)` + name indexes. Public
  `library.collections.*` keeps reporting `kind:'custom'` for compatibility.
- **Folders**: `library.folders.tree` returns `{items:[{id,name,color,kind,
  count,directCount,depth,children}],total,folderCount,fieldCount}` (count is the
  number of UNIQUE papers in the folder plus all descendants, matching
  `library.list folderId`; `directCount` stays the direct membership count); `library.collections.create/update/delete` support nesting
  (parent must be a folder, depth ≤6, no moves into self/descendants, rename/color/
  move); delete removes only the folder, promotes its children to the parent and
  keeps papers; membership stays many-to-many via `library.collections.assign`.
  Every create/update/delete is journaled and undoable.
- **Single favorite**: `library.setFavorite {ids,favorite}` (undoable);
  `library.list`/`library.get` expose `favorite`; `library.list` filters
  `favorite`, `folderId` (includes descendant folders), `tags` (AND) and accepts
  `collectionId` as a folderId alias; `sort:'favorite'`.
- **Search/feed filters**: `search.query filters:{folderId,tags,favorite,field}`
  (top-level aliases accepted) resolves one allowed-paper set and applies it to
  every channel before fusion; `discover.feed` adds `stats.favorite`, section
  `favorite`, `folders` tree and flattened `folderCounts`; `annotations.feed`
  supports `folderId`/`tags`. `status.index.vectorInfo` placeholder is present for
  the v0.5-B semantic chips.

### v0.5-B additions (real local vector search)

- **Optional local embedding component**: `host/embedding.js` spawns
  `host/embedding_worker.py` with the venv python from
  `config.embeddingPython` (default `~/.dsh/pappers-hall/embedding/venv/bin/python`),
  model `sentence-transformers/paraphrase-multilingual-MiniLM-L12-v2` (384-d
  multilingual, CPU, text never leaves the machine), cache dir
  `~/.dsh/pappers-hall/models`. The Host never installs packages itself; when the
  component is missing, `scripts/setup-embedding.sh` (optional, ~1.2GB) is
  suggested and every vector surface degrades honestly.
- **Lifecycle**: lazy spawn, `ready` line + 25s startup timeout, 60s request
  timeout, one serialized embedding pipeline, crash restarts ≤2, `close()` sends
  `shutdown` on dispose.
- **Index**: table `embeddings(id,kind,ref_id,chunk_index,paper_id,page,text,
  vector BLOB,model,dims,updated_at)` with unique `(kind,ref_id,chunk_index,model)`.
  Documents: paper (title + titleZh + abstract + keywords + venue), page blocks
  (body/heading/caption, 600–800 char chunks with ~80 overlap), figure
  (caption+label+title), annotation (quote+comment+title). `embedding.index
  {force?}` enqueues the persistent `embedding.index` job (batches of 16,
  serial, idempotent upsert, stale chunks removed, per-kind progress); on mount a
  stale/missing `embedding.indexVersion` is enqueued automatically.
- **API**: `embedding.status` → `{available,configured,pythonPath,model,dims,
  indexVersion,expectedIndexVersion,indexReady,building,job,counts,lastError,
  lastEmbedLatencyMs,worker:{state,loadMs,restarts},indexBuiltAt,setupScript,note}`;
  `embedding.index`; `diagnostics.embedding`; `status.index.channels.vector` is
  `ready` only when a real index exists, and `status.index.vectorInfo`
  (`{model,dims,latencyMs,reason}`) feeds the client semantic chips.
- **Pure-keyword baseline switch**: `search.query {vector:false}` (alias:
  `channels:['fts']`) skips the semantic channel entirely (no embedding call), and
  the `vector` channel is reported as `status:'off'`; use it for FTS-only
  comparisons of semantic queries. Default is on.
- **Search**: `search.query` embeds the query (Chinese queries work directly
  through the multilingual model) and enables a real `vector` channel
  (`status:'ok'`, `model`, `latencyMs`, `k`) that is fused with the FTS/LIKE/AI
  channels by **RRF**; hits carry `reasons:['vector_similarity']` plus a relative
  `score`/`vectorScore`. Scopes `papers`/`pages`/`figures`/`annotations` are
  supported and the v0.5 folder/tag/favorite filters apply to candidates before
  fusion. Worker/index unavailable → vector channel `unavailable`/`degraded` with
  the honest reason; no semantic scores are ever fabricated.
- **Privacy/limits**: embeddings are computed locally on CPU from local text; no
  network upload. First query per process pays the ~8–11s model load; later
  queries are ~20–120ms on this machine (30 papers → 3526 chunks indexed in
  ~42s). Page-heavy libraries produce many chunks; indexing is I/O+CPU bound and
  intentionally a background job.

### v0.6 additions (no field layer, auto-classification, DSH literature management)

- **Field layer removed (`user_version=6`)**: the five read-only field collections
  are folded into ordinary editable folders — migration inserts explicit
  `paper_collections` rows for every paper whose `papers.field` matched, then sets
  `kind='folder'`. `folders.tree`/`collections.list` never return `kind:'field'`
  again; every folder can be renamed/recolored/moved/deleted/nested and papers are
  never deleted with a folder. `papers.field` stays as plain metadata and the
  `field` search filter remains for compatibility.
- **Auto-classification (`host/classify.js`)**: a folder profile is the mean
  embedding of its direct member papers (empty folders embed their name), cached
  by membership/name/updated_at. `library.classify {paperIds, apply?}` returns
  `suggestions:[{paperId, action:'assign'|'create', folderId?, folderName?,
  newFolderName?, score, confidence, threshold}]`; the default cosine threshold is
  **0.32**; below it the suggestion is to create a folder named by the LLM (2–8
  Chinese chars; deterministic title/venue fallback, never empty). `apply:true`
  assigns or creates+assigns in ONE undoable operation (`library.classify.apply`).
  When the local embedding component is unavailable the API reports
  `status:'unavailable', reason:'embedding unavailable'` and invents nothing.
- **Import auto-organization**: `library.import` runs classification after the
  accepted papers are persisted and adds `classification` to the result
  (`{status:'applied', applied:[…], createdFolders, operationId}` or
  `{status:'unavailable', reason}` / `{status:'error'}`); failures never block the
  import. An explicit `collectionId` skips auto-classification.
- **Agent tools (v0.24 consolidated to 14)**: `papers_search` (search/related/
  abstracts), `papers_get` (detail/outline/citation), `papers_list`,
  `papers_get_passage` (page or batch/range), `papers_get_figure`,
  `papers_manage` (metadata update + folder CRUD/assign/hints),
  `papers_annotations` (list/create), `papers_overview` (+index status),
  `papers_changes` (propose/apply), `papers_pdf`,
  `papers_translate`, and `notes_search` / `notes_get` / `notes_edit`.
- **System prompt**: a second section `plugin:pappers-hall-management`
  (`FILE_REFERENCE+2`) teaches the Agent to search/read with papers_*, ALWAYS
  preview a PDF and ask the user before importing it (confirm only after explicit
  agreement), report auto-classification, manage folders, cite with papers_cite,
  and confirm before deleting/large moves. `diagnostics.agent` exposes
  `{tools:[…], promptSection:true}`.
- **Privacy**: classification uses the same local CPU embeddings (no upload).
  Auto-folder names may call the configured LLM; deterministic fallback keeps the
  feature usable without AI.

### v0.11 additions (settings center, model download channel, OCR indexing)

- **`settings.get` / `settings.update`**: persisted feature switches
  `{vectorSearch, ocr, freeTranslation, autoIndex}`, translation provider
  switches (google/mymemory/llm + fallbackEnabled, at least one engine must stay
  enabled), model installation cards (`models.embedding`, `models.ocr`), index
  state (`channels`, embedding `counts`, incremental `sync`), and a secrets-free
  diagnostics block. Unknown/invalid keys are ignored and reported in
  `applied`/`ignored`; updates are idempotent per `operationId`.
- **Switch semantics**: `vectorSearch=false` turns the vector channel `off` and
  removes vector from `status.degraded` (it is a choice, not a degradation);
  `ocr=false`/not installed means no page is processed; `freeTranslation`/provider
  switches filter the real translation chain; `autoIndex=false` pauses incremental
  embedding sync (re-enabling catches up via `syncNow`).
- **Model download channel (`models.install/cancel/rebuildIndex`)**: nothing is
  downloaded automatically. `models.install {kind}` queues a persistent
  `model.install` job with real progress/errors: embedding runs
  `scripts/setup-embedding.sh` (venv + torch + model cache), OCR creates
  `~/.dsh/pappers-hall/ocr/venv` and installs `rapidocr-onnxruntime`. Cancelling a
  job kills the child process; failures never remove a working component.
  `models.rebuildIndex` reuses the embedding index job.
- **OCR (`ocr.index`, schema v7)**: `paper_pages.ocr_text/ocr_updated_at`;
  scanned pages are rendered to PNG, processed by `host/ocr_worker.py` (stdio
  JSON-lines, rapidocr-onnxruntime, local CPU), stored, and fed back into the page
  FTS/LIKE channels; `reader.pageText`/`reader.page` fall back to OCR text when
  there is no native text layer. `status.ocr` and `diagnostics.ocr` report honest
  `{available,installed,enabled,pages,indexedPages}`.
- **`translation.test`**: one real translation call for the settings panel
  (`{ok,provider,engine,translated,latencyMs,reason?}`); failures are reported,
  never faked.
- **Privacy**: embedding/OCR models run locally on CPU; text is never uploaded.
  Installs happen only after an explicit user action in the settings panel.

### v0.13 additions (quick free-only translation + academic AI translation)

- **`translate.text {quick:true}`** (alias `freeOnly:true`): only the free engines
  `google → mymemory` are tried, with a **hard overall deadline ≤6s** (per-call
  timeout shrinks to the remaining budget, retries limited to 1). The LLM is
  **never called silently**. Results carry `mode:'free'|'ai'|'none'`,
  `freeOnly`, `fast:true` and, on failure, `suggestAi:true` plus a user-facing
  reason (“免费引擎暂不可用（限流/网络…），可改用 AI 精译”). An explicit
  `provider:'llm'` in quick mode is rejected honestly. Non-quick
  `translate.text` keeps the full chain (including LLM fallback).
- **AI 精译 quality**: `ai.translateText` prompt is now `translate-text-v2` —
  academic-passage rules (complete sentences in order, accurate terminology,
  preserve symbols/abbreviations/citation markers such as ΔY, CA, GGCMs, [12],
  no omissions/summaries/explanations/added content) and optional
  `context:{paperTitle,section,page}` for terminology reference. Provenance
  reports the v2 promptVersion and context.
- **Fast AI translation**: `ai.quickTranslate` / LLM fast path uses the model's
  real lowest reasoning effort (as before, reported truthfully), a **≤9s**
  deadline and a token budget sized for a complete translation (no truncation).
- Response fields `mode/freeOnly/suggestAi` let the Client label “免费快速” vs
  “AI 精译” and offer the AI fallback button.

## Agent tools

`papers_search`, `papers_get`, `papers_list`, `papers_get_passage`,
`papers_get_figure`, `papers_manage`, `papers_annotations`, `papers_overview`,
`papers_changes`, `papers_pdf`, `papers_translate`,
`notes_search`, `notes_get`, `notes_edit` — registered through
`ctx.tools.register(...)` inside the mount effect.

- `papers_get_figure` loads the real crop, calls
  `ctx.attachments.saveImage({data, mediaType:'image/png', name})` and returns
  `[{type:'image', attachment: ref}, {type:'text', text: metaJson}]`. Without an
  attachment service it returns the JSON metadata with
  `image.status='degraded'` and no fake pixels.
- `scope='reference_bundle'` calls with a `bundle_id` re-validate the bundle
  against the live DB on every call and refuse materials that were deleted or
  whose bundle belongs to another Session (`status:'unavailable'`); when every
  material is gone the tools return an empty `unavailable` result that says so.
- `bundle_id` may be the raw `bn-<12hex>` id **or** the chat token
  `⟦Pappers-Hall 2 篇论文 + 1 张图 · bundle=bn-…⟧` inserted by the Client; the id
  is extracted from the token before validation.
- At mount, a static `systemPrompt` section (`plugin:pappers-hall-materials`)
  teaches the model to turn that token into a `scope='reference_bundle'` call and
  to use `scope='library'` only on an explicit whole-library request. The section
  is registered through the optional `systemPrompt` service, disposed with the
  other registrations, and reported as degraded when the service is absent.
- Translations call the composed `translator` service; without one every
  translate result is `status:'unavailable'` — no invented text.

## PDF ingestion (contract §5)

`library.import` synchronously validates the `%PDF-` magic, hashes the bytes,
deduplicates by sha256, merges manifest metadata (title, Chinese title, authors,
venue, field, DOI/arXiv id, licence, sources, PDF page count) and copies the
original into the content-addressed store. The returned job then:

1. runs `pdftotext -layout` (one call, pages via `\f`) and `pdftotext -bbox-layout`;
2. stores every physical page with point geometry (scanned pages are kept with
   empty text and mark `text: partial`);
3. detects `Figure N:` / `Table N:` caption lines, derives a PDF-point region
   (figures above the caption, tables below; ≥30% page height for figures, never
   crossing the previous caption), renders the crop at 120 dpi plus a 320 px
   thumbnail, and computes a 64-bit dHash;
4. writes the derived FTS rows and a truthful `processing` state
   (`ready` / `partial` with per-channel `text|figures|index`).

Per-paper failures are recorded on the paper (`processing.state='failed'`,
channel detail) and do not abort the rest of the batch. Bibliography imports
(`bibtex`, `ris`, `csljson`, auto-detected by extension/bytes) create
metadata-only papers, deduplicated by DOI first and normalized title+year second.

## Degradation matrix (shown in `status().degraded` and `diagnostics()`)

| Channel | State | Reason |
| --- | --- | --- |
| `vector` | `unavailable` | no embedding model is installed; no semantic similarity is computed |
| `ocr` | `unavailable` | scanned PDFs keep their pages but stay text-less and `partial` |
| `translation` | `unavailable` unless a `translator` service is composed | never fabricates a translation |
| `attachments` | `unavailable` without `ctx.attachments` | figure tool falls back to metadata-only JSON |
| `subprocess` | `degraded` without `ctx.subprocess` | PDF tools run through `node:child_process` |
| `poppler` | `unavailable` when pdfinfo/pdftotext/pdftoppm are missing | import and page rendering report `unavailable` |
| `fts` | `degraded` when FTS5 is unavailable | deterministic LIKE channel (with CJK substring support) |
| `systemPrompt` | `degraded` when the `systemPrompt` service is absent | reference-bundle token guidance is not registered; tools still validate bundle ids |

Search always states its channels explicitly (`fts5`, optional `like`, honest
`vector: degraded`); figure search states `caption_fts`, `dHash near-duplicate`
and honest `image_embedding: degraded`.

## Selftest

`node host/selftest.mjs` currently reports **PASS — 389 checks** (A01 import, reader v2 blocks/layer/outline, C05 abstract fallback + two-column
order, annotations v2, collections/tags, AI-unavailable + fast-mode degradation,
lazy structure regeneration, HTTP assets, tools, export/diagnostics, v0.3
migration/user_version=3, manual metrics + offline metrics.refresh, operations
undo/merge, citation formats, annotation export, reading filters, saved searches,
migration idempotency).

```bash
cd pappers-hall-plugin
node host/selftest.mjs
```

It mounts the Host half on a temporary data dir with a fake Cordis context,
imports `A01_react.pdf` through the public API, drives the persistent worker
with the injected timer and asserts: page text, page geometry, Table-of-contents,
manifest metadata merge, Figure 1 detection + real PNG crop + ImageBlock,
`ReAct` text search, CJK annotation/note search, dHash screenshot search and
source-figure similar search, HTTP API + all four asset routes, all eight tools,
reference bundles (readable token + bundle-scoped tools), the material-token
system-prompt section, delete → search exclusion → restore with a new epoch →
visible again, bibliography import, exports, purge, teardown and remount with
preserved data.

## Known gaps (honest list)

- No vector/OCR/vision-embedding channel: text search is FTS5 + LIKE, figure
  search is caption FTS + dHash near-duplicate only.
- Similar-figure search is a 64-bit dHash near-duplicate channel only; visually
  similar but independently drawn figures are not expected to match, and the
  result is a candidate list, not a similarity percentage.
- Caption/geometry detection is heuristic; figure regions on unusual layouts
  (full-page floats, rotated pages) may be cropped imprecisely. Every failure is
  visible as `figure.status='partial'` instead of a fabricated crop.
- The table of contents is derived from numbered heading lines; it is a
  heuristic and not a structural PDF outline.
- `library.setRead` and `library.tags` are additions beyond the contract; the
  contract has no read-marking method yet (flagged to the Lead).
- Remote DOI/Crossref lookup and GROBID structure parsing are intentionally not
  implemented; metadata comes from the PDF itself plus the local manifest.
