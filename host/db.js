/**
 * SQLite storage for the Pappers-Hall Host half: connection setup, schema
 * migration (`PRAGMA user_version`), FTS5 availability probing, and small
 * query helpers shared by every domain module.
 *
 * The database is the single source of truth for library state and lifecycle
 * (contract §4). Index tables are derived data and may be rebuilt.
 *
 * @module pappers-hall/host/db
 */
import { DatabaseSync } from 'node:sqlite'

/** Current schema version written to `PRAGMA user_version`. */
export const SCHEMA_VERSION = 8

/** Tables that exist in every schema version. */
const CORE_SCHEMA = `
CREATE TABLE IF NOT EXISTS papers (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  title_zh TEXT,
  display_title TEXT,
  authors_json TEXT NOT NULL DEFAULT '[]',
  year INTEGER,
  venue TEXT,
  field TEXT,
  field_id TEXT,
  state TEXT NOT NULL DEFAULT 'active',
  epoch INTEGER NOT NULL DEFAULT 0,
  read INTEGER NOT NULL DEFAULT 0,
  sha256 TEXT,
  source_version TEXT,
  license TEXT,
  abstract TEXT,
  doi TEXT,
  arxiv_id TEXT,
  container_title TEXT,
  publication_date TEXT,
  volume TEXT,
  issue TEXT,
  pages TEXT,
  article_number TEXT,
  note TEXT,
  manifest_id TEXT,
  current_version_id TEXT,
  processing_json TEXT NOT NULL DEFAULT '{}',
  metadata_diff_json TEXT NOT NULL DEFAULT '[]',
  added_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  revision INTEGER NOT NULL DEFAULT 0,
  deleted_at TEXT
);
CREATE INDEX IF NOT EXISTS papers_state_idx ON papers(state);
CREATE INDEX IF NOT EXISTS papers_updated_idx ON papers(updated_at);
CREATE INDEX IF NOT EXISTS papers_doi_idx ON papers(doi);
CREATE INDEX IF NOT EXISTS papers_manifest_idx ON papers(manifest_id);

CREATE TABLE IF NOT EXISTS paper_versions (
  id TEXT PRIMARY KEY,
  paper_id TEXT NOT NULL,
  sha256 TEXT NOT NULL,
  bytes INTEGER NOT NULL DEFAULT 0,
  page_count INTEGER,
  source_version TEXT,
  file_path TEXT,
  created_at TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS versions_sha_idx ON paper_versions(sha256);
CREATE INDEX IF NOT EXISTS versions_paper_idx ON paper_versions(paper_id);

CREATE TABLE IF NOT EXISTS paper_pages (
  paper_id TEXT NOT NULL,
  version_id TEXT NOT NULL,
  page INTEGER NOT NULL,
  width REAL,
  height REAL,
  text TEXT NOT NULL DEFAULT '',
  text_chars INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (paper_id, page)
);

CREATE TABLE IF NOT EXISTS figures (
  id TEXT PRIMARY KEY,
  paper_id TEXT NOT NULL,
  version_id TEXT,
  page INTEGER NOT NULL,
  label TEXT,
  caption TEXT,
  bbox_json TEXT,
  width INTEGER,
  height INTEGER,
  file_name TEXT,
  thumb_name TEXT,
  dhash TEXT,
  source TEXT NOT NULL DEFAULT 'caption',
  status TEXT NOT NULL DEFAULT 'ready',
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS figures_paper_idx ON figures(paper_id);

CREATE TABLE IF NOT EXISTS annotations (
  id TEXT PRIMARY KEY,
  paper_id TEXT NOT NULL,
  version_id TEXT,
  page INTEGER NOT NULL,
  quote TEXT,
  text TEXT NOT NULL,
  rect_json TEXT,
  color TEXT,
  origin TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'active',
  epoch INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  revision INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS annotations_paper_idx ON annotations(paper_id);
CREATE INDEX IF NOT EXISTS annotations_state_idx ON annotations(state);

CREATE TABLE IF NOT EXISTS notes (
  id TEXT PRIMARY KEY,
  paper_id TEXT,
  title TEXT,
  text TEXT NOT NULL,
  origin TEXT NOT NULL,
  source_refs_json TEXT NOT NULL DEFAULT '[]',
  state TEXT NOT NULL DEFAULT 'active',
  epoch INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  revision INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS notes_paper_idx ON notes(paper_id);
CREATE INDEX IF NOT EXISTS notes_state_idx ON notes(state);

CREATE TABLE IF NOT EXISTS tags (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS paper_tags (
  paper_id TEXT NOT NULL,
  tag_id INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (paper_id, tag_id)
);

CREATE TABLE IF NOT EXISTS sources (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  paper_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  url TEXT NOT NULL,
  retrieved_at TEXT,
  UNIQUE (paper_id, kind, url)
);
CREATE INDEX IF NOT EXISTS sources_paper_idx ON sources(paper_id);

CREATE TABLE IF NOT EXISTS jobs (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'queued',
  payload_json TEXT NOT NULL DEFAULT '{}',
  result_json TEXT,
  attempts INTEGER NOT NULL DEFAULT 0,
  max_attempts INTEGER NOT NULL DEFAULT 3,
  progress_done INTEGER NOT NULL DEFAULT 0,
  progress_total INTEGER NOT NULL DEFAULT 0,
  progress_unit TEXT NOT NULL DEFAULT 'items',
  error_message TEXT,
  idempotency_key TEXT UNIQUE,
  lease_until TEXT,
  next_run_at TEXT,
  cancel_requested INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS jobs_state_idx ON jobs(state, next_run_at);

CREATE TABLE IF NOT EXISTS job_steps (
  job_id TEXT NOT NULL,
  step TEXT NOT NULL,
  status TEXT NOT NULL,
  detail TEXT,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (job_id, step)
);

CREATE TABLE IF NOT EXISTS bundles (
  id TEXT PRIMARY KEY,
  session_id TEXT,
  display TEXT,
  token TEXT NOT NULL,
  created_at TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'active'
);

CREATE TABLE IF NOT EXISTS bundle_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  bundle_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  ref_id TEXT NOT NULL,
  page INTEGER,
  snapshot_json TEXT NOT NULL DEFAULT '{}',
  ordinal INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS bundle_items_bundle_idx ON bundle_items(bundle_id);

CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  type TEXT NOT NULL,
  paper_id TEXT,
  payload_json TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS events_created_idx ON events(created_at);
`

/**
 * FTS5 derived tables.
 *
 * Each table keeps its business id as an `UNINDEXED` column so the owning row
 * can be deleted and rebuilt independently of FTS rowids. Rows are filtered by
 * joining the base table, which is what keeps trashed papers out of search
 * without a synchronous index rewrite.
 */
const FTS_SCHEMA = `
CREATE VIRTUAL TABLE IF NOT EXISTS papers_fts USING fts5(
  paper_id UNINDEXED,
  title,
  title_zh,
  authors,
  venue,
  abstract
);
CREATE VIRTUAL TABLE IF NOT EXISTS pages_fts USING fts5(
  paper_id UNINDEXED,
  page UNINDEXED,
  text
);
CREATE VIRTUAL TABLE IF NOT EXISTS figures_fts USING fts5(
  figure_id UNINDEXED,
  paper_id UNINDEXED,
  label,
  caption
);
CREATE VIRTUAL TABLE IF NOT EXISTS annotations_fts USING fts5(
  annotation_id UNINDEXED,
  paper_id UNINDEXED,
  text,
  quote
);
CREATE VIRTUAL TABLE IF NOT EXISTS notes_fts USING fts5(
  note_id UNINDEXED,
  paper_id UNINDEXED,
  title,
  text
);
`

/**
 * v0.2 tables (contract v0.2 §1.5): Zotero-style collections, membership,
 * AI translation/answer cache and an AI call event log. `ai_cache` keys include
 * the model and prompt version, never user-visible content in clear text.
 */
const V2_SCHEMA = `
CREATE TABLE IF NOT EXISTS collections (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  color TEXT,
  sort_order INTEGER NOT NULL DEFAULT 0,
  kind TEXT NOT NULL DEFAULT 'custom',
  field_key TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS collections_name_idx ON collections(name);

CREATE TABLE IF NOT EXISTS paper_collections (
  collection_id TEXT NOT NULL,
  paper_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (collection_id, paper_id)
);
CREATE INDEX IF NOT EXISTS paper_collections_paper_idx ON paper_collections(paper_id);

CREATE TABLE IF NOT EXISTS ai_cache (
  key TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  value_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  expires_at TEXT
);
CREATE INDEX IF NOT EXISTS ai_cache_expires_idx ON ai_cache(expires_at);

CREATE TABLE IF NOT EXISTS ai_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  at TEXT NOT NULL,
  kind TEXT NOT NULL,
  provider TEXT,
  model TEXT,
  input_hash TEXT,
  elapsed_ms INTEGER,
  status TEXT,
  sources_json TEXT
);
CREATE INDEX IF NOT EXISTS ai_events_at_idx ON ai_events(at);
`

const V3_SCHEMA = `
CREATE TABLE IF NOT EXISTS papers_journal (
  key TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  issn TEXT,
  publisher TEXT,
  impact_factor REAL,
  impact_factor_year INTEGER,
  five_year_if REAL,
  quartile TEXT,
  source TEXT,
  metrics_json TEXT NOT NULL DEFAULT '{}',
  updated_at TEXT
);
CREATE INDEX IF NOT EXISTS papers_journal_name_idx ON papers_journal(name);

CREATE TABLE IF NOT EXISTS operations (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  summary TEXT NOT NULL,
  target_json TEXT NOT NULL DEFAULT '{}',
  undo_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL,
  undone INTEGER NOT NULL DEFAULT 0,
  undone_at TEXT
);
CREATE INDEX IF NOT EXISTS operations_recent_idx ON operations(created_at);

CREATE TABLE IF NOT EXISTS saved_searches (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  query_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS saved_searches_name_idx ON saved_searches(name);
`

const V4_SCHEMA = `
CREATE TABLE IF NOT EXISTS mt_cache (
  key TEXT PRIMARY KEY,
  provider TEXT NOT NULL,
  source_lang TEXT,
  target_lang TEXT NOT NULL,
  text_hash TEXT NOT NULL,
  value_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  expires_at TEXT
);
CREATE INDEX IF NOT EXISTS mt_cache_expires_idx ON mt_cache(expires_at);
CREATE INDEX IF NOT EXISTS mt_cache_provider_idx ON mt_cache(provider, text_hash);

CREATE TABLE IF NOT EXISTS mt_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  at TEXT NOT NULL,
  provider TEXT NOT NULL,
  chars INTEGER NOT NULL DEFAULT 0,
  elapsed_ms INTEGER,
  status TEXT NOT NULL,
  reason TEXT
);
CREATE INDEX IF NOT EXISTS mt_events_at_idx ON mt_events(at);
`

const V5_SCHEMA = `
CREATE INDEX IF NOT EXISTS collections_parent_idx ON collections(parent_id);
DROP INDEX IF EXISTS collections_name_idx;
CREATE INDEX IF NOT EXISTS collections_name_lookup_idx ON collections(name);
CREATE TABLE IF NOT EXISTS embeddings (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  kind TEXT NOT NULL,
  ref_id TEXT NOT NULL,
  chunk_index INTEGER NOT NULL DEFAULT 0,
  paper_id TEXT,
  page INTEGER,
  text TEXT NOT NULL,
  vector BLOB NOT NULL,
  model TEXT NOT NULL,
  dims INTEGER NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS embeddings_unique_idx ON embeddings(kind, ref_id, chunk_index, model);
CREATE INDEX IF NOT EXISTS embeddings_paper_idx ON embeddings(paper_id);
CREATE INDEX IF NOT EXISTS embeddings_model_idx ON embeddings(model);
`

/** Names of the derived FTS tables, in diagnostics order. */
export const FTS_TABLES = ['papers_fts', 'pages_fts', 'figures_fts', 'annotations_fts', 'notes_fts']

/**
 * Open one SQLite connection in WAL mode with defensive pragmas.
 * @param {string} dbPath absolute database path.
 * @returns {DatabaseSync} open connection.
 */
export function openDatabase(dbPath) {
  const db = new DatabaseSync(dbPath)
  db.exec('PRAGMA journal_mode = WAL')
  db.exec('PRAGMA synchronous = NORMAL')
  db.exec('PRAGMA foreign_keys = ON')
  db.exec('PRAGMA busy_timeout = 5000')
  db.exec('PRAGMA temp_store = MEMORY')
  return db
}

/**
 * Probe FTS5 by creating (and dropping) one temporary virtual table.
 * @param {DatabaseSync} db open connection.
 * @returns {boolean} whether FTS5 works in this SQLite build.
 */
export function probeFts5(db) {
  try {
    db.exec('CREATE VIRTUAL TABLE IF NOT EXISTS temp.pappers_fts_probe USING fts5(value)')
    db.exec('DROP TABLE IF EXISTS temp.pappers_fts_probe')
    return true
  } catch {
    return false
  }
}

/**
 * Add one column when it is missing (SQLite has no `ADD COLUMN IF NOT EXISTS`).
 * Idempotent: repeated plugin mounts and repeated migrations are safe.
 * @param {DatabaseSync} db open connection.
 * @param {string} table table name.
 * @param {string} column column name.
 * @param {string} definition column definition for `ALTER TABLE ADD COLUMN`.
 * @returns {boolean} whether the column was added.
 */
export function ensureColumn(db, table, column, definition) {
  const row = db.prepare(`SELECT name FROM pragma_table_info(?) WHERE name = ?`).get(table, column)
  if (row !== undefined) return false
  db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`)
  return true
}

/** Read one integer-valued pragma. */
export function readUserVersion(db) {
  const row = db.prepare('PRAGMA user_version').get()
  const value = row?.user_version
  return typeof value === 'number' ? value : Number(value ?? 0)
}

/**
 * Migrate the schema to {@link SCHEMA_VERSION}.
 *
 * Migration is monotonic and idempotent; a database created by a newer build is
 * refused instead of being silently downgraded.
 * @param {DatabaseSync} db open connection.
 * @param {object} options migration options.
 * @param {boolean} options.fts5 whether FTS5 was probed successfully.
 * @returns {{version:number, fts5:boolean, migrated:boolean}} migration facts.
 */
export function migrate(db, { fts5 }) {
  const current = readUserVersion(db)
  if (current > SCHEMA_VERSION) {
    throw new Error(`pappers-hall: data directory uses schema v${current} but this build supports v${SCHEMA_VERSION}`)
  }
  let migrated = false
  if (current < SCHEMA_VERSION) {
    db.exec('BEGIN IMMEDIATE')
    try {
      db.exec(CORE_SCHEMA)
      if (fts5) {
        try {
          db.exec(FTS_SCHEMA)
        } catch {
          // Probing succeeded but table creation failed: keep the library usable
          // with the LIKE fallback and retry the repair on the next open.
        }
      }
      applyV2Columns(db)
      db.exec(V2_SCHEMA)
      applyV3Columns(db)
      db.exec(V3_SCHEMA)
      applyV4Columns(db)
      db.exec(V4_SCHEMA)
      applyV5Columns(db)
      db.exec(V5_SCHEMA)
      applyV6Migration(db)
      db.exec(V6_SCHEMA)
      applyV7Columns(db)
      db.exec(V7_SCHEMA)
      applyV8Schema(db, { fts5: fts5 === true })
      const now = new Date().toISOString()
      db.prepare('INSERT OR REPLACE INTO settings(key, value, updated_at) VALUES (?, ?, ?)').run(
        'schemaVersion',
        JSON.stringify(SCHEMA_VERSION),
        now,
      )
      db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`)
      db.exec('COMMIT')
      migrated = true
    } catch (error) {
      try {
        db.exec('ROLLBACK')
      } catch {}
      throw error
    }
  } else {
    // Same version: repair optional pieces that a failed earlier write may have
    // missed, keeping open cheap and idempotent.
    applyV2Columns(db)
    db.exec(V2_SCHEMA)
    applyV3Columns(db)
    db.exec(V3_SCHEMA)
    applyV4Columns(db)
    db.exec(V4_SCHEMA)
    applyV5Columns(db)
    db.exec(V5_SCHEMA)
    applyV6Migration(db)
    db.exec(V6_SCHEMA)
    applyV7Columns(db)
    db.exec(V7_SCHEMA)
    applyV8Schema(db, { fts5: fts5 === true })
  }
  let ftsReady = hasFtsTables(db)
  if (fts5 === true && !ftsReady) {
    try {
      db.exec(FTS_SCHEMA)
      ftsReady = hasFtsTables(db)
    } catch {
      // Still degraded: the LIKE channel keeps working.
    }
  }
  return { version: SCHEMA_VERSION, fts5: ftsReady, migrated }
}

/**
 * Add the v0.2 columns to the v0.1 tables, idempotently.
 * @param {DatabaseSync} db open connection.
 * @returns {string[]} added column names (diagnostics only).
 */
export function applyV2Columns(db) {
  const added = []
  const ensure = (table, column, definition) => {
    if (ensureColumn(db, table, column, definition)) added.push(`${table}.${column}`)
  }
  ensure('papers', 'structure_state', "TEXT NOT NULL DEFAULT 'pending'")
  ensure('papers', 'structure_updated_at', 'TEXT')
  ensure('papers', 'outline_json', "TEXT NOT NULL DEFAULT '[]'")
  ensure('papers', 'abstract_source', 'TEXT')
  ensure('papers', 'title_zh_source', 'TEXT')
  ensure('paper_pages', 'layout_json', 'TEXT')
  ensure('paper_pages', 'structure_state', "TEXT NOT NULL DEFAULT 'pending'")
  ensure('paper_pages', 'structure_version', 'INTEGER NOT NULL DEFAULT 0')
  ensure('paper_pages', 'block_count', 'INTEGER NOT NULL DEFAULT 0')
  ensure('paper_pages', 'word_count', 'INTEGER NOT NULL DEFAULT 0')
  ensure('annotations', 'kind', "TEXT NOT NULL DEFAULT 'note'")
  ensure('annotations', 'rects_json', "TEXT NOT NULL DEFAULT '[]'")
  ensure('annotations', 'comment', 'TEXT')
  return added
}

/**
 * Add the v0.3 columns to the v0.2 tables, idempotently.
 * @param {DatabaseSync} db open connection.
 * @returns {string[]} added column names (diagnostics only).
 */
export function applyV3Columns(db) {
  const added = []
  const ensure = (table, column, definition) => {
    if (ensureColumn(db, table, column, definition)) added.push(`${table}.${column}`)
  }
  ensure('papers', 'citation_count', 'INTEGER')
  ensure('papers', 'citation_updated_at', 'TEXT')
  ensure('papers', 'keywords_json', "TEXT NOT NULL DEFAULT '[]'")
  ensure('papers', 'metrics_json', "TEXT NOT NULL DEFAULT '{}'")
  ensure('papers', 'journal_key', 'TEXT')
  ensure('papers', 'reading_progress', 'INTEGER NOT NULL DEFAULT 0')
  // One-time repair for rows written by an earlier v0.3 build where
  // metrics.reset nulled citation_count while the automatic value lived in
  // papers.metrics_json. Keep the column and the metrics payload consistent.
  try {
    db.exec(
      "UPDATE papers SET citation_count = json_extract(metrics_json, '$.citedByCount') WHERE citation_count IS NULL AND json_extract(metrics_json, '$.citedByCount') IS NOT NULL",
    )
  } catch {
    // JSON1 unavailable (should not happen on the supported SQLite build): the
    // library.list sort fallback still keeps ordering consistent.
  }
  return added
}

/**
 * Add the v0.4 columns (translation/discover bookkeeping), idempotently.
 * FTS/derived caches live in V4_SCHEMA tables; this only adds paper columns.
 * @param {DatabaseSync} db open connection.
 * @returns {string[]} added column names (diagnostics only).
 */
export function applyV4Columns(db) {
  const added = []
  const ensure = (table, column, definition) => {
    if (ensureColumn(db, table, column, definition)) added.push(`${table}.${column}`)
  }
  ensure('papers', 'last_read_at', 'TEXT')
  return added
}

/**
 * Add the v0.5 folder/favorite columns, idempotently.
 *
 * Existing v0.4 custom collections become `kind='folder'` (public API still
 * reports them as 'custom' for compatibility); the five derived field
 * collections keep `kind='field'` and stay read-only.
 * @param {DatabaseSync} db open connection.
 * @returns {string[]} added column names (diagnostics only).
 */
export function applyV5Columns(db) {
  const added = []
  const ensure = (table, column, definition) => {
    if (ensureColumn(db, table, column, definition)) added.push(`${table}.${column}`)
  }
  ensure('papers', 'favorite', 'INTEGER NOT NULL DEFAULT 0')
  ensure('collections', 'parent_id', 'TEXT')
  try {
    db.exec("UPDATE collections SET kind = 'folder' WHERE kind IS NULL OR kind = 'custom'")
  } catch {}
  return added
}

const V6_SCHEMA = `
CREATE INDEX IF NOT EXISTS collections_kind_idx ON collections(kind);
`

const V7_SCHEMA = `
CREATE INDEX IF NOT EXISTS paper_pages_ocr_idx ON paper_pages(paper_id) WHERE ocr_text IS NOT NULL;
`

/**
 * v0.17 (schemaVersion 8): the notes workbench.
 *
 * These tables are deliberately NEW rather than columns on the legacy `notes`
 * table. The legacy `notes` table backs paper-level quick notes created through
 * `notes.create {text, origin}` (ids `nt-…`) and is joined by `notes_fts` and by
 * `search.query`; reusing it for long-form notes would break those channels and
 * would make a paper purge cascade delete user documents. The notes workbench
 * therefore keeps its own content, folders, paper links, revision snapshots, FTS
 * index and (independent) embedding table. Nothing here rewrites, truncates or
 * migrates legacy rows.
 */
const V8_SCHEMA = `
CREATE TABLE IF NOT EXISTS note_docs (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL DEFAULT '',
  content_md TEXT NOT NULL DEFAULT '',
  content_json TEXT,
  index_text TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'draft',
  folder_id TEXT,
  format_version TEXT,
  beautified_revision TEXT,
  state TEXT NOT NULL DEFAULT 'active',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  revision INTEGER NOT NULL DEFAULT 0,
  deleted_at TEXT
);
CREATE INDEX IF NOT EXISTS note_docs_state_idx ON note_docs(state, updated_at);
CREATE INDEX IF NOT EXISTS note_docs_folder_idx ON note_docs(folder_id);
CREATE INDEX IF NOT EXISTS note_docs_status_idx ON note_docs(status);

CREATE TABLE IF NOT EXISTS note_folders (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  parent_id TEXT,
  color TEXT,
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS note_folders_parent_idx ON note_folders(parent_id);

CREATE TABLE IF NOT EXISTS note_paper_links (
  note_id TEXT NOT NULL,
  paper_id TEXT NOT NULL,
  anchor_json TEXT,
  created_at TEXT NOT NULL,
  PRIMARY KEY (note_id, paper_id)
);
CREATE INDEX IF NOT EXISTS note_paper_links_paper_idx ON note_paper_links(paper_id);

CREATE TABLE IF NOT EXISTS note_revisions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  note_id TEXT NOT NULL,
  revision INTEGER NOT NULL,
  title TEXT NOT NULL DEFAULT '',
  content_md TEXT NOT NULL DEFAULT '',
  content_json TEXT,
  reason TEXT NOT NULL DEFAULT 'update',
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS note_revisions_note_idx ON note_revisions(note_id, revision DESC);

CREATE TABLE IF NOT EXISTS note_embeddings (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  note_id TEXT NOT NULL,
  chunk_index INTEGER NOT NULL DEFAULT 0,
  text TEXT NOT NULL,
  vector BLOB NOT NULL,
  model TEXT NOT NULL,
  dims INTEGER NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS note_embeddings_unique_idx ON note_embeddings(note_id, chunk_index, model);
CREATE INDEX IF NOT EXISTS note_embeddings_note_idx ON note_embeddings(note_id);
CREATE INDEX IF NOT EXISTS note_embeddings_model_idx ON note_embeddings(model);
`

/** Full-text index for the notes workbench (separate from the legacy `notes_fts`). */
const V8_FTS_SCHEMA = `
CREATE VIRTUAL TABLE IF NOT EXISTS note_fts USING fts5(
  note_id UNINDEXED,
  title,
  content
);
`

/** Tables owned by the v0.17 notes workbench, in diagnostics order. */
export const NOTE_TABLES = ['note_docs', 'note_folders', 'note_paper_links', 'note_revisions', 'note_embeddings']

/**
 * Create the v0.17 notes tables idempotently.
 *
 * Called from {@link migrate} for both the fresh-upgrade and the same-version
 * repair path, so a database whose optional FTS table creation failed earlier is
 * repaired on the next open without touching any data.
 * @param {DatabaseSync} db open connection.
 * @param {{fts5?:boolean}} [options] whether FTS5 is available.
 * @returns {{tables:string[], fts:boolean}} migration facts.
 */
export function applyV8Schema(db, { fts5 = false } = {}) {
  db.exec(V8_SCHEMA)
  let fts = false
  try {
    db.prepare('SELECT 1 FROM note_fts LIMIT 1').all()
    fts = true
  } catch {
    if (fts5 === true) {
      try {
        db.exec(V8_FTS_SCHEMA)
        fts = true
      } catch {
        // FTS5 is missing in this build: notes.search falls back to LIKE.
      }
    }
  }
  return { tables: [...NOTE_TABLES], fts }
}

/**
 * v0.11: add OCR text columns to extracted pages (scanned PDFs).
 * @param {DatabaseSync} db open connection.
 * @returns {string[]} added column names.
 */
export function applyV7Columns(db) {
  const added = []
  const ensure = (table, column, definition) => {
    if (ensureColumn(db, table, column, definition)) added.push(`${table}.${column}`)
  }
  ensure('paper_pages', 'ocr_text', 'TEXT')
  ensure('paper_pages', 'ocr_updated_at', 'TEXT')
  return added
}

/**
 * v0.6: fold the read-only field collections into ordinary folders.
 *
 * Every existing field collection gets explicit membership rows for the papers
 * whose `papers.field` matched it (the old derived view), then becomes a normal
 * editable folder. `papers.field` stays as metadata only. Idempotent: after the
 * first run there are no `kind='field'` rows left, so re-running is a no-op.
 * @param {DatabaseSync} db open connection.
 * @returns {{folded:number, memberships:number}} migration facts.
 */
export function applyV6Migration(db) {
  const now = new Date().toISOString()
  let folded = 0
  let memberships = 0
  try {
    const fields = db.prepare("SELECT id, field_key FROM collections WHERE kind = 'field'").all()
    for (const row of fields) {
      const fieldKey = row.field_key
      if (typeof fieldKey === 'string' && fieldKey !== '') {
        const inserted = db
          .prepare(
            `INSERT OR IGNORE INTO paper_collections(collection_id, paper_id, created_at)
             SELECT ?, p.id, ? FROM papers p WHERE p.field = ?`,
          )
          .run(row.id, now, fieldKey)
        memberships += Number(inserted.changes ?? 0)
      }
      db.prepare("UPDATE collections SET kind = 'folder', updated_at = ? WHERE id = ?").run(now, row.id)
      folded += 1
    }
  } catch {}
  return { folded, memberships }
}

/**
 * Whether the derived FTS tables of this schema exist and are usable.
 * @param {DatabaseSync} db open connection.
 * @returns {boolean}
 */
export function hasFtsTables(db) {
  try {
    for (const table of FTS_TABLES) {
      db.prepare(`SELECT 1 FROM ${table} LIMIT 1`).all()
    }
    return true
  } catch {
    return false
  }
}

/**
 * Run a synchronous function inside one immediate transaction.
 *
 * node:sqlite is synchronous, so callers must not `await` inside `fn`: the
 * transaction would otherwise interleave with another handler on the same
 * connection. Every store write follows this rule.
 * @param {DatabaseSync} db open connection.
 * @param {() => T} fn work to run atomically.
 * @returns {T} whatever `fn` returned.
 * @template T
 */
export function transaction(db, fn) {
  db.exec('BEGIN IMMEDIATE')
  try {
    const result = fn()
    db.exec('COMMIT')
    return result
  } catch (error) {
    try {
      db.exec('ROLLBACK')
    } catch {}
    throw error
  }
}

/** Read one settings value parsed as JSON, or undefined. */
export function readSetting(db, key) {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key)
  if (row === undefined) return undefined
  try {
    return JSON.parse(row.value)
  } catch {
    return undefined
  }
}

/** Write one settings value as JSON. */
export function writeSetting(db, key, value, now) {
  db.prepare('INSERT OR REPLACE INTO settings(key, value, updated_at) VALUES (?, ?, ?)').run(
    key,
    JSON.stringify(value),
    now ?? new Date().toISOString(),
  )
}

/** Count rows of one known table, optionally filtered by `WHERE state = 'trash'`. */
export function countRows(db, table, where = '', params = []) {
  const sql = `SELECT COUNT(*) AS count FROM ${table}${where === '' ? '' : ` WHERE ${where}`}`
  const row = db.prepare(sql).get(...params)
  return typeof row?.count === 'number' ? row.count : Number(row?.count ?? 0)
}

/**
 * Report the plausible `application_id`/journal facts for diagnostics.
 * @param {DatabaseSync} db open connection.
 * @returns {{journalMode:string, pageCount:number, pageSize:number}}
 */
export function databaseFacts(db) {
  const journal = db.prepare('PRAGMA journal_mode').get()
  const pages = db.prepare('PRAGMA page_count').get()
  const size = db.prepare('PRAGMA page_size').get()
  return {
    journalMode: String(journal?.journal_mode ?? 'unknown'),
    pageCount: Number(pages?.page_count ?? 0),
    pageSize: Number(size?.page_size ?? 0),
  }
}

/** Close a connection, ignoring an already-closed handle. */
export function closeDatabase(db) {
  try {
    db.close()
  } catch {
    // Closing twice (plugin reload plus explicit dispose) is allowed.
  }
}
