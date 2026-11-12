/**
 * Notes workbench backend for the Pappers-Hall Host half (v0.17).
 *
 * The workbench stores long-form notes that can live on their own or be linked
 * to any number of library papers. It is deliberately additive: the legacy
 * paper quick-note table (`notes`, ids `nt-…`) keeps backing
 * `notes.create {text,origin}` / `search.query scope:'notes'`; nothing here
 * rewrites or migrates those rows.
 *
 * Invariants enforced by this module:
 * - `content_md` is the user's own text and is NEVER derived from an AI result.
 *   `content_json` is opaque beautified structure written through `notes.update`
 *   only; the two columns never overwrite each other.
 * - Every write runs inside one SQLite transaction; every update snapshots the
 *   previous state into `note_revisions` (last {@link NOTE_REVISION_LIMIT}
 *   snapshots per note) before mutating the row.
 * - Deletion is a soft delete into the recycle bin; `notes.purge` is the only
 *   destructive path and requires the note to be in the trash (or `force:true`).
 * - Retrieval runs on two independent indexes: `note_fts` (full text, always
 *   available when FTS5 exists) and `note_embeddings` (vector, only when the
 *   local embedding component is configured). The indexed text contains the raw
 *   `content_md` plus the semantic plain text of `content_json`, with layout/UI
 *   markers stripped ({@link contentJsonPlainText}). Both indexes are maintained
 *   incrementally after commits and never block the write path.
 * - Every mutating method supports `operationId` idempotency and appends an
 *   undoable entry to the shared `operations` journal; `operations.undo`
 *   dispatches back into {@link applyUndo}.
 *
 * @module pappers-hall/host/notes
 */
import { countRows, readSetting, transaction, writeSetting } from './db.js'
import { clampInt, escapeLike, nowIso, randomHex, safeFileStem } from './paths.js'
import { DomainError, invalid, notFound } from './store.js'

/** Note id shape (`note-` + 12 lower-case hex characters). */
export const NOTE_ID_PATTERN = /^note-[a-f0-9]{12}$/

/** Note folder id shape (`nf-` + 12 lower-case hex characters). */
export const NOTE_FOLDER_ID_PATTERN = /^nf-[a-f0-9]{12}$/

/** How many revision snapshots one note keeps. */
export const NOTE_REVISION_LIMIT = 50

/** Maximum accepted `content_md` length in characters (guards accidental paste bombs). */
export const NOTE_MAX_CONTENT_CHARS = 2_000_000

/** Maximum accepted serialized `content_json` length in characters. */
export const NOTE_MAX_JSON_CHARS = 4_000_000

/** Allowed note statuses. */
const NOTE_STATUSES = new Set(['draft', 'ready'])

/** Search channel pool cap (kept small: note libraries are user-scale, not corpus-scale). */
const SEARCH_POOL = 400

/** Vector chunk window for note embeddings. */
const CHUNK_MAX = 700
const CHUNK_OVERLAP = 60

/** Settings key holding the last index-sync summary (diagnostics only). */
const INDEX_STATE_KEY = 'notes.indexState'

/* ------------------------------------------------------------------ */
/* Semantic plain text extraction                                       */
/* ------------------------------------------------------------------ */

/** Object keys that carry UI/layout metadata and never user content. */
const UI_KEYS = new Set([
  'id',
  'ids',
  'type',
  'kind',
  'nodeType',
  'node_type',
  'tag',
  'tagName',
  'style',
  'styles',
  'class',
  'className',
  'color',
  'colour',
  'align',
  'alignment',
  'variant',
  'width',
  'height',
  'fontSize',
  'font',
  'fontWeight',
  'weight',
  'icon',
  'emoji',
  'attrs',
  'attr',
  'props',
  'layout',
  'theme',
  'template',
  'sectionId',
  'section_id',
  'hash',
  'revision',
  'status',
  'level',
  'order',
  'href',
  'url',
  'src',
  'image',
  'imageUrl',
  'figureId',
  'paperId',
  'noteId',
  'page',
  'bbox',
  'meta',
  'version',
  'formatVersion',
  'beautifiedRevision',
  'createdAt',
  'updatedAt',
  'deletedAt',
  'date',
  'time',
  'lang',
  'role',
  'purpose',
  'anchor',
  'pos',
  'x',
  'y',
  'w',
  'h',
  'opacity',
  'border',
  'shadow',
  'spacing',
  'padding',
  'margin',
  'gap',
  'radius',
  'transform',
  'animation',
  'checked',
  'collapsed',
])

/** Structural enum values that are not content even when stored as strings. */
const STRUCTURAL_TOKENS = new Set([
  'p',
  'div',
  'span',
  'section',
  'paragraph',
  'heading',
  'title',
  'subtitle',
  'quote',
  'blockquote',
  'list',
  'bullets',
  'bullet',
  'numbered',
  'ordered',
  'checklist',
  'table',
  'thead',
  'tbody',
  'tr',
  'td',
  'th',
  'row',
  'cell',
  'card',
  'callout',
  'columns',
  'column',
  'grid',
  'image',
  'figure',
  'code',
  'pre',
  'divider',
  'separator',
  'text',
  'markdown',
  'md',
  'json',
  'node',
  'block',
  'content',
  'strong',
  'em',
  'b',
  'i',
  'u',
  's',
  'small',
  'large',
  'center',
  'left',
  'right',
  'success',
  'info',
  'warning',
  'danger',
  'note',
  'tip',
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
  'ul',
  'ol',
  'li',
  'hr',
  'br',
  'table-row',
  'table-cell',
  'table-header',
])

/** Whether a standalone string is a structural token rather than user content. */
function isStructuralToken(text) {
  return STRUCTURAL_TOKENS.has(String(text).trim().toLowerCase())
}

/**
 * Strip markdown/HTML presentation markers while keeping the words themselves.
 * Used only for index/snippet text, never for stored content.
 * @param {string} value raw text.
 * @returns {string} plain text.
 */
export function stripPresentationMarkup(value) {
  const lines = String(value ?? '').split(/\r?\n/)
  const kept = []
  for (const rawLine of lines) {
    if (/^\s*```/.test(rawLine)) continue // code fence line, keep the code body
    if (/^\s*\|?[\s:|_-]{3,}\|?\s*$/.test(rawLine)) continue // markdown table separator
    let line = rawLine
      .replace(/<[^>]{0,300}>/g, ' ')
      .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
      .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
      .replace(/^\s{0,3}#{1,6}\s+/, '')
      .replace(/^\s*>\s?/, '')
      .replace(/^\s*[-*+•]\s+/, '')
      .replace(/^\s*\d+[.)]\s+/, '')
      .replace(/\*\*([^*]+)\*\*/g, '$1')
      .replace(/__([^_]+)__/g, '$1')
      .replace(/(?<![\w*])\*([^*\n]+)\*(?!\w)/g, '$1')
      .replace(/(?<![\w_])_([^_\n]+)_(?!\w)/g, '$1')
      .replace(/`([^`]+)`/g, '$1')
      .replace(/\|/g, ' ')
    line = line.replace(/[ \t]+/g, ' ').trim()
    if (line !== '') kept.push(line)
  }
  return kept.join('\n').replace(/\n{2,}/g, '\n').trim()
}

/** Recursively collect text-bearing values from an arbitrary content JSON tree. */
function collectContentPieces(value, out, depth = 0) {
  if (depth > 16) return
  if (value === null || value === undefined) return
  if (typeof value === 'string') {
    const text = value.trim()
    if (text !== '' && !isStructuralToken(text)) out.push(text)
    return
  }
  if (typeof value === 'number' || typeof value === 'boolean') return
  if (Array.isArray(value)) {
    for (const item of value) collectContentPieces(item, out, depth + 1)
    return
  }
  if (typeof value !== 'object') return
  for (const [key, child] of Object.entries(value)) {
    if (UI_KEYS.has(key)) continue
    if (typeof child === 'string') {
      const text = child.trim()
      if (text !== '' && !isStructuralToken(text)) out.push(text)
      continue
    }
    if (child === null || child === undefined || typeof child === 'number' || typeof child === 'boolean') continue
    collectContentPieces(child, out, depth + 1)
  }
}

/**
 * Extract the semantic plain text of a `content_json` value.
 *
 * Beautified card structures describe layout through keys such as `type`,
 * `style`, `attrs`, `id` or `icon`; those are ignored, while heading/title,
 * paragraph, bullet item and table cell strings are kept. Duplicates are
 * removed so repeating a heading in the structure does not bias retrieval.
 * @param {unknown} value parsed content JSON (object, array, string or null).
 * @returns {string} plain text, one piece per line.
 */
export function contentJsonPlainText(value) {
  if (value === null || value === undefined) return ''
  let input = value
  if (typeof input === 'string') {
    const text = input.trim()
    if (text === '') return ''
    if (text.startsWith('{') || text.startsWith('[')) {
      try {
        input = JSON.parse(text)
      } catch {
        return stripPresentationMarkup(text)
      }
    } else {
      return stripPresentationMarkup(text)
    }
  }
  const pieces = []
  collectContentPieces(input, pieces, 0)
  const seen = new Set()
  const cleaned = []
  for (const piece of pieces) {
    const text = stripPresentationMarkup(piece)
    if (text === '' || seen.has(text)) continue
    seen.add(text)
    cleaned.push(text)
  }
  return cleaned.join('\n')
}

/**
 * Build the exact text fed to both indexes for one note row.
 *
 * It always contains the raw user markdown plus the semantic plain text of the
 * beautified structure, so switching the UI between markdown and cards cannot
 * change what is searchable.
 * @param {{title?:unknown,content_md?:unknown,contentJson?:unknown,content_json?:unknown}} row note row (or API-shaped object).
 * @returns {string} index text.
 */
export function buildNoteIndexText(row = {}) {
  const parts = []
  const title = String(row.title ?? '').trim()
  if (title !== '') parts.push(title)
  const markdown = String(row.content_md ?? row.contentMd ?? '').trim()
  if (markdown !== '') parts.push(markdown)
  let json = row.content_json ?? row.contentJson
  if (typeof json === 'string' && json.trim() !== '') {
    try {
      json = JSON.parse(json)
    } catch {
      // Keep the raw string; contentJsonPlainText cleans it.
    }
  }
  const semantics = contentJsonPlainText(json)
  if (semantics !== '' && semantics !== stripPresentationMarkup(markdown)) parts.push(semantics)
  return parts.join('\n').replace(/\n{3,}/g, '\n\n').trim()
}

/** Split index text into embedding windows on natural boundaries. */
export function splitNoteText(text, { max = CHUNK_MAX, overlap = CHUNK_OVERLAP } = {}) {
  const clean = String(text ?? '')
    .replace(/\r?\n/g, '\n')
    .replace(/[ \t]+/g, ' ')
    .trim()
  if (clean === '') return []
  if (clean.length <= max) return [clean]
  const chunks = []
  let cursor = 0
  while (cursor < clean.length) {
    let end = Math.min(clean.length, cursor + max)
    if (end < clean.length) {
      const window = clean.slice(cursor, end)
      const boundary = Math.max(window.lastIndexOf('. '), window.lastIndexOf('。'), window.lastIndexOf('\n'), window.lastIndexOf('，'), window.lastIndexOf(' '))
      if (boundary > max * 0.45) end = cursor + boundary + 1
    }
    const piece = clean.slice(cursor, end).trim()
    if (piece.length >= 20) chunks.push(piece)
    if (end >= clean.length) break
    const next = Math.max(cursor + 1, end - overlap)
    cursor = next <= cursor ? end : next
  }
  return chunks
}

/* ------------------------------------------------------------------ */
/* Generic helpers                                                      */
/* ------------------------------------------------------------------ */

/** Parse one JSON column with a fallback. */
function parseJson(value, fallback) {
  if (typeof value !== 'string' || value === '') return fallback
  try {
    return JSON.parse(value)
  } catch {
    return fallback
  }
}

/** Clamp a possibly-string revision into an integer. */
function revisionInt(value, fallback = 0) {
  const n = typeof value === 'number' ? value : Number.parseInt(String(value ?? ''), 10)
  return Number.isFinite(n) ? Math.trunc(n) : fallback
}

/** Format one document row as the API note object (without relations). */
function mapNoteBase(row) {
  return {
    id: row.id,
    title: row.title ?? '',
    contentMd: row.content_md ?? '',
    contentJson: parseJson(row.content_json, null),
    status: row.status ?? 'draft',
    folderId: row.folder_id ?? null,
    formatVersion: row.format_version ?? null,
    beautifiedRevision: row.beautified_revision ?? null,
    revision: revisionInt(row.revision),
    state: row.state ?? 'active',
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    deletedAt: row.deleted_at ?? null,
    hasContentJson: typeof row.content_json === 'string' && row.content_json !== '',
  }
}

/** Rough first-line preview used by list rows. */
function notePreview(row) {
  const markdown = String(row.content_md ?? '').replace(/\s+/g, ' ').trim()
  if (markdown !== '') return markdown.slice(0, 180)
  const semantics = contentJsonPlainText(parseJson(row.content_json, null)).replace(/\s+/g, ' ').trim()
  return semantics.slice(0, 180)
}

/**
 * Create the notes workbench service bound to one open database.
 * @param {object} options service options.
 * @param {import('node:sqlite').DatabaseSync} options.db open database (already migrated to v8).
 * @param {object} [options.logger] logger.
 * @returns {object} notes service.
 */
export function createNotes({ db, logger }) {
  /** Attached optional services (the embedding worker is the only one for now). */
  const attached = { embedding: null }

  /** Cached probe result for the FTS table (re-probed on failure). */
  let ftsAvailable = (() => {
    try {
      db.prepare('SELECT 1 FROM note_fts LIMIT 1').all()
      return true
    } catch {
      return false
    }
  })()

  /* ---------------------- folders ------------------------------ */

  /** Map one `note_folders` row to the API folder object. */
  function mapFolder(row) {
    if (row === undefined || row === null) return null
    return {
      id: row.id,
      name: row.name,
      parentId: row.parent_id ?? null,
      color: row.color ?? null,
      sortOrder: revisionInt(row.sort_order),
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    }
  }

  /** All folders as a map id → row. */
  function folderMap() {
    const map = new Map()
    for (const row of db.prepare('SELECT * FROM note_folders').all()) map.set(row.id, row)
    return map
  }

  /** All direct active-note counts per folder id. */
  function directFolderCounts() {
    const counts = new Map()
    for (const row of db.prepare("SELECT folder_id, COUNT(*) AS count FROM note_docs WHERE state = 'active' AND folder_id IS NOT NULL GROUP BY folder_id").all()) {
      counts.set(String(row.folder_id), Number(row.count ?? 0))
    }
    return counts
  }

  /** Ids of one folder and every descendant (used by list/search filters and tree counts). */
  function folderSubtreeIds(rootId) {
    const rows = db.prepare('SELECT id, parent_id FROM note_folders').all()
    const byParent = new Map()
    for (const row of rows) {
      const key = row.parent_id ?? null
      if (!byParent.has(key)) byParent.set(key, [])
      byParent.get(key).push(String(row.id))
    }
    const result = []
    const stack = [String(rootId)]
    const seen = new Set()
    while (stack.length > 0) {
      const current = stack.pop()
      if (seen.has(current)) continue
      seen.add(current)
      result.push(current)
      for (const child of byParent.get(current) ?? []) stack.push(child)
    }
    return result
  }

  /** Fetch one folder row or throw not_found. */
  function requireFolderRow(folderId) {
    const row = db.prepare('SELECT * FROM note_folders WHERE id = ?').get(folderId)
    if (row === undefined) throw notFound(`note folder ${folderId} does not exist`, { id: folderId })
    return row
  }

  /** Normalize a folder id argument ('' / null / undefined → null). */
  function normalizeFolderId(value, { allowNull = true } = {}) {
    if (value === null || value === undefined || value === '') {
      if (allowNull) return null
      throw invalid('folderId is required')
    }
    const id = String(value)
    if (NOTE_FOLDER_ID_PATTERN.test(id) === false) throw invalid(`invalid note folder id ${id}`, { id })
    requireFolderRow(id)
    return id
  }

  /* ---------------------- note rows / links -------------------- */

  /** Fetch one note row (any state) or throw not_found. */
  function requireNoteRow(id) {
    const row = db.prepare('SELECT * FROM note_docs WHERE id = ?').get(id)
    if (row === undefined) throw notFound(`note ${id} does not exist`, { id })
    return row
  }

  /** Normalize one note id string. */
  function normalizeNoteId(value, method) {
    const id = String(value ?? '').trim()
    if (id === '') throw invalid(`${method} requires id`)
    if (NOTE_ID_PATTERN.test(id) === false) throw invalid(`invalid note id ${id}`, { id })
    return id
  }

  /** Normalize a non-empty unique note id array. */
  function normalizeNoteIds(ids, method) {
    if (!Array.isArray(ids) || ids.length === 0) throw invalid(`${method} requires a non-empty ids array`)
    const normalized = []
    for (const value of ids) {
      const id = normalizeNoteId(value, method)
      if (!normalized.includes(id)) normalized.push(id)
    }
    return normalized
  }

  /** Normalize a non-empty unique paper id array (papers must exist; trashed papers are allowed). */
  function normalizePaperIds(paperIds, method) {
    if (!Array.isArray(paperIds)) throw invalid(`${method} requires a paperIds array`)
    const normalized = []
    for (const value of paperIds) {
      const id = String(value ?? '').trim()
      if (id === '') throw invalid(`${method} requires non-empty paper ids`)
      const row = db.prepare('SELECT id FROM papers WHERE id = ?').get(id)
      if (row === undefined) throw notFound(`paper ${id} does not exist`, { id })
      if (!normalized.includes(id)) normalized.push(id)
    }
    return normalized
  }

  /** Read one note's paper links (with anchor JSON) in insertion order. */
  function linkRows(noteId) {
    return db
      .prepare('SELECT paper_id, anchor_json, created_at FROM note_paper_links WHERE note_id = ? ORDER BY created_at, paper_id')
      .all(noteId)
      .map((row) => ({ paperId: row.paper_id, anchor: parseJson(row.anchor_json, null), createdAt: row.created_at }))
  }

  /** Bulk-read paper links for a list of note ids. */
  function linksByNote(noteIds) {
    const map = new Map()
    if (noteIds.length === 0) return map
    const placeholders = noteIds.map(() => '?').join(',')
    const rows = db
      .prepare(`SELECT note_id, paper_id, anchor_json FROM note_paper_links WHERE note_id IN (${placeholders}) ORDER BY created_at, paper_id`)
      .all(...noteIds)
    for (const row of rows) {
      if (!map.has(row.note_id)) map.set(row.note_id, [])
      map.get(row.note_id).push({ paperId: row.paper_id, anchor: parseJson(row.anchor_json, null) })
    }
    return map
  }

  /** Paper summaries for a list of paper ids (any lifecycle state, stable order by id list). */
  function paperSummaries(paperIds) {
    const map = new Map()
    if (paperIds.length === 0) return map
    const placeholders = paperIds.map(() => '?').join(',')
    for (const row of db
      .prepare(`SELECT id, title, title_zh, year, venue, state FROM papers WHERE id IN (${placeholders})`)
      .all(...paperIds)) {
      map.set(row.id, row)
    }
    return map
  }

  /** Resolve one note's paper links into API-friendly summaries. */
  function paperLinksOf(noteId) {
    const links = linkRows(noteId)
    const summaries = paperSummaries(links.map((link) => link.paperId))
    return links.map((link) => {
      const paper = summaries.get(link.paperId)
      return {
        paperId: link.paperId,
        title: paper?.title ?? null,
        titleZh: paper?.title_zh ?? null,
        year: paper?.year === null || paper?.year === undefined ? null : Number(paper.year),
        venue: paper?.venue ?? null,
        state: paper?.state ?? 'missing',
        anchor: link.anchor,
      }
    })
  }

  /** Attach links to one mapped note object. */
  function noteWithLinks(row, folderLookup = folderMap()) {
    const note = mapNoteBase(row)
    const links = paperLinksOf(row.id)
    note.folder = folderLookup.has(row.folder_id ?? '') ? mapFolder(folderLookup.get(row.folder_id)) : null
    note.paperLinks = links
    note.paperIds = links.map((link) => link.paperId)
    return note
  }

  /** Snapshot the current state of one note into `note_revisions` (bounded). */
  function snapshotRevision(row, reason) {
    db.prepare(
      'INSERT INTO note_revisions(note_id, revision, title, content_md, content_json, reason, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
    ).run(row.id, revisionInt(row.revision), row.title ?? '', row.content_md ?? '', row.content_json ?? null, reason, nowIso())
    // Keep only the newest NOTE_REVISION_LIMIT snapshots for this note.
    db.prepare(
      `DELETE FROM note_revisions
       WHERE note_id = ? AND id NOT IN (
         SELECT id FROM note_revisions WHERE note_id = ? ORDER BY revision DESC, id DESC LIMIT ?
       )`,
    ).run(row.id, row.id, NOTE_REVISION_LIMIT)
  }

  /** Replace the whole paper-link set of one note (inside a transaction). */
  function replacePaperLinks(noteId, paperIds, anchors = new Map(), now = nowIso()) {
    db.prepare('DELETE FROM note_paper_links WHERE note_id = ?').run(noteId)
    for (const paperId of paperIds) {
      const anchor = anchors.get(paperId) ?? null
      db.prepare('INSERT INTO note_paper_links(note_id, paper_id, anchor_json, created_at) VALUES (?, ?, ?, ?)').run(
        noteId,
        paperId,
        anchor === null || anchor === undefined ? null : JSON.stringify(anchor),
        now,
      )
    }
  }

  /* ---------------------- FTS index ---------------------------- */

  /** Probe (and cache) the note FTS table. */
  function noteFtsReady() {
    if (ftsAvailable) return true
    try {
      db.prepare('SELECT 1 FROM note_fts LIMIT 1').all()
      ftsAvailable = true
    } catch {
      ftsAvailable = false
    }
    return ftsAvailable
  }

  /** Rebuild one note's FTS row from its stored columns (no-op without FTS5). */
  function upsertNoteFts(row) {
    if (!noteFtsReady()) return
    try {
      db.prepare('DELETE FROM note_fts WHERE note_id = ?').run(row.id)
      db.prepare('INSERT INTO note_fts(note_id, title, content) VALUES (?, ?, ?)').run(row.id, row.title ?? '', row.index_text ?? '')
    } catch (error) {
      ftsAvailable = false
      logger?.debug?.(`pappers-hall: note FTS update failed: ${String(error?.message ?? error)}`)
    }
  }

  /** Remove one note's FTS row. */
  function removeNoteFts(noteId) {
    if (!noteFtsReady()) return
    try {
      db.prepare('DELETE FROM note_fts WHERE note_id = ?').run(noteId)
    } catch (error) {
      ftsAvailable = false
      logger?.debug?.(`pappers-hall: note FTS delete failed: ${String(error?.message ?? error)}`)
    }
  }

  /* ---------------------- events / journal --------------------- */

  /** Best-effort event row. */
  function recordEvent(type, paperId, payload) {
    try {
      db.prepare('INSERT INTO events(type, paper_id, payload_json, created_at) VALUES (?, ?, ?, ?)').run(
        type,
        paperId ?? null,
        payload === undefined ? null : JSON.stringify(payload),
        nowIso(),
      )
    } catch (error) {
      logger?.debug?.(`pappers-hall: note event write failed: ${String(error?.message ?? error)}`)
    }
  }

  /** Append one undoable entry to the shared operations journal. */
  function recordOperation({ kind, summary, target = {}, undo = {} }) {
    const id = `op-${randomHex(6)}`
    db.prepare(
      'INSERT INTO operations(id, kind, summary, target_json, undo_json, created_at, undone) VALUES (?, ?, ?, ?, ?, ?, 0)',
    ).run(id, kind, summary, JSON.stringify(target), JSON.stringify(undo), nowIso())
    return id
  }

  /** Operation-id idempotency guard; the cached result lives in `settings`. */
  function withOperationId(method, operationId, fn) {
    if (typeof operationId !== 'string' || operationId.trim() === '') return fn()
    const key = `noteoperation:${method}:${operationId.trim()}`
    const existing = readSetting(db, key)
    if (existing !== undefined) return existing
    const result = fn()
    writeSetting(db, key, result)
    return result
  }

  /* ---------------------- text column helpers ----------------- */

  /** Compute and store the index text for one row object (mutates the row copy only). */
  function withIndexText(row) {
    return { ...row, index_text: buildNoteIndexText(row) }
  }

  /** Write one note row's mutable content columns and refresh derived indexes. */
  function writeNoteColumns(noteId, columns) {
    const assignments = Object.keys(columns).map((column) => `${column} = ?`)
    db.prepare(`UPDATE note_docs SET ${assignments.join(', ')} WHERE id = ?`).run(...Object.values(columns), noteId)
    const row = db.prepare('SELECT * FROM note_docs WHERE id = ?').get(noteId)
    if (row !== undefined) upsertNoteFts(row)
    return row
  }

  /* ---------------------- vector index ------------------------- */

  let indexTimer = null
  let indexRunning = false
  let indexQueued = false

  /** Attach optional services (embedding) after construction. */
  function attach(services = {}) {
    if (services.embedding !== undefined) attached.embedding = services.embedding
    return service
  }

  /** Honest embedding facts (never fabricates availability). */
  function embeddingInfo() {
    const embedding = attached.embedding
    if (embedding === null || embedding === undefined || typeof embedding.embedTexts !== 'function') {
      return { configured: false, available: false, model: null, dims: null, reason: 'embedding service is not attached' }
    }
    let facts = {}
    try {
      facts = typeof embedding.facts === 'function' ? embedding.facts() : {}
    } catch (error) {
      return { configured: false, available: false, model: null, dims: null, reason: String(error?.message ?? error) }
    }
    const configured = facts.configured !== false
    const available = configured && facts.available !== false
    return {
      configured,
      available,
      model: typeof facts.model === 'string' && facts.model !== '' ? facts.model : 'local-embedding',
      dims: Number.isFinite(Number(facts.dims)) ? Number(facts.dims) : null,
      reason: available ? null : String(facts.lastError ?? (configured ? 'embedding worker is unavailable' : 'embedding component is not configured')),
    }
  }

  /** Read the last index-sync summary. */
  function readIndexState() {
    return readSetting(db, INDEX_STATE_KEY) ?? null
  }

  /** Persist one index-sync summary. */
  function writeIndexState(patch) {
    try {
      writeSetting(db, INDEX_STATE_KEY, { ...(readIndexState() ?? {}), ...patch, at: patch.at ?? nowIso() })
    } catch (error) {
      logger?.debug?.(`pappers-hall: note index state write failed: ${String(error?.message ?? error)}`)
    }
  }

  /**
   * Reconcile `note_embeddings` with the current notes.
   * Only runs when the embedding component is usable; never throws.
   * @param {{ids?:string[], force?:boolean}} [options] optional note-id subset.
   * @returns {Promise<object>} sync summary.
   */
  async function syncIndexNow(options = {}) {
    if (indexRunning) {
      indexQueued = true
      return { status: 'already_running' }
    }
    indexRunning = true
    const started = Date.now()
    try {
      const info = embeddingInfo()
      if (!info.available) {
        const summary = { status: 'unavailable', reason: info.reason, model: info.model, changed: 0, removed: 0, at: nowIso(), latencyMs: Date.now() - started }
        writeIndexState({ vector: summary })
        return summary
      }
      const ids = Array.isArray(options.ids) && options.ids.length > 0 ? new Set(options.ids.map((id) => String(id))) : null
      const rows = db
        .prepare("SELECT id, title, content_md, content_json, index_text FROM note_docs WHERE state = 'active'")
        .all()
        .filter((row) => ids === null || ids.has(row.id))
      const activeIds = new Set(rows.map((row) => row.id))
      const planned = []
      const desiredKeys = new Set()
      for (const row of rows) {
        const text = buildNoteIndexText(row)
        const chunks = splitNoteText(text)
        for (const [chunkIndex, chunk] of chunks.entries()) {
          desiredKeys.add(`${row.id}|${chunkIndex}`)
          planned.push({ noteId: row.id, chunkIndex, text: chunk })
        }
      }
      const existing = db.prepare('SELECT id, note_id, chunk_index, text, model FROM note_embeddings').all()
      const existingByKey = new Map()
      for (const row of existing) existingByKey.set(`${row.note_id}|${row.chunk_index}|${row.model}`, row)
      const model = info.model
      const changed = []
      for (const item of planned) {
        const current = existingByKey.get(`${item.noteId}|${item.chunkIndex}|${model}`)
        if (options.force === true || current === undefined || current.text !== item.text) changed.push(item)
      }
      const staleIds = []
      for (const row of existing) {
        if (row.model !== model) continue
        if (!activeIds.has(row.note_id) || !desiredKeys.has(`${row.note_id}|${row.chunk_index}`)) staleIds.push(row.id)
      }
      if (changed.length === 0 && staleIds.length === 0) {
        const summary = {
          status: 'ok',
          changed: 0,
          removed: 0,
          upToDate: true,
          model,
          notes: activeIds.size,
          chunks: planned.length,
          latencyMs: Date.now() - started,
          at: nowIso(),
        }
        writeIndexState({ vector: summary })
        return summary
      }
      const upsert = db.prepare(
        `INSERT INTO note_embeddings(note_id, chunk_index, text, vector, model, dims, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(note_id, chunk_index, model) DO UPDATE SET
           text = excluded.text, vector = excluded.vector, dims = excluded.dims, updated_at = excluded.updated_at`,
      )
      const batchSize = 16
      let written = 0
      for (let start = 0; start < changed.length; start += batchSize) {
        const batch = changed.slice(start, start + batchSize)
        const embedded = await attached.embedding.embedTexts(batch.map((item) => item.text))
        if (!Array.isArray(embedded?.vectors) || embedded.vectors.length !== batch.length) {
          throw new Error('embedding worker returned an unexpected vector count for notes')
        }
        const actualModel = typeof embedded.model === 'string' && embedded.model !== '' ? embedded.model : model
        const dims = Number(embedded.dims) || info.dims || 0
        for (const [index, item] of batch.entries()) {
          upsert.run(item.noteId, item.chunkIndex, item.text, encodeVector(embedded.vectors[index]), actualModel, dims, nowIso())
          written += 1
        }
      }
      for (const id of staleIds) db.prepare('DELETE FROM note_embeddings WHERE id = ?').run(id)
      const summary = {
        status: 'ok',
        changed: written,
        removed: staleIds.length,
        model,
        notes: activeIds.size,
        chunks: planned.length,
        latencyMs: Date.now() - started,
        at: nowIso(),
      }
      writeIndexState({ vector: summary })
      return summary
    } catch (error) {
      const summary = { status: 'error', reason: String(error?.message ?? error), changed: 0, removed: 0, at: nowIso(), latencyMs: Date.now() - started }
      writeIndexState({ vector: summary })
      logger?.warn?.(`pappers-hall: note embedding sync failed: ${summary.reason}`)
      return summary
    } finally {
      indexRunning = false
      if (indexQueued) {
        indexQueued = false
        scheduleIndexSync(undefined, 300)
      }
    }
  }

  /** Debounced, non-blocking index sync after a write. */
  function scheduleIndexSync(ids, delayMs = 1500) {
    if (indexTimer !== null) {
      clearTimeout(indexTimer)
      indexTimer = null
    }
    indexTimer = setTimeout(() => {
      indexTimer = null
      Promise.resolve(syncIndexNow({ ids })).catch(() => {})
    }, Math.max(0, Number(delayMs) || 0))
    indexTimer.unref?.()
  }

  /** Index facts for diagnostics/UI (never fabricates vector readiness). */
  function indexStatus() {
    const info = embeddingInfo()
    const models = db
      .prepare('SELECT model, COUNT(*) AS chunks, COUNT(DISTINCT note_id) AS notes FROM note_embeddings GROUP BY model')
      .all()
      .map((row) => ({ model: row.model, chunks: Number(row.chunks ?? 0), notes: Number(row.notes ?? 0) }))
    const indexedChunks = models.reduce((sum, entry) => sum + entry.chunks, 0)
    const indexedNotes = Number(db.prepare('SELECT COUNT(DISTINCT note_id) AS count FROM note_embeddings').get()?.count ?? 0)
    const ftsIndexed = noteFtsReady()
      ? Number(db.prepare('SELECT COUNT(*) AS count FROM note_fts').get()?.count ?? 0)
      : 0
    const state = readIndexState()
    return {
      fts: { available: ftsAvailable, indexedNotes: ftsIndexed },
      vector: {
        configured: info.configured,
        available: info.available,
        model: info.model,
        dims: info.dims,
        indexedNotes,
        indexedChunks,
        ready: indexedChunks > 0,
        models,
        lastSyncedAt: state?.vector?.at ?? null,
        lastError: state?.vector?.status === 'error' || state?.vector?.status === 'unavailable' ? state.vector.reason ?? null : info.reason ?? null,
        last: state?.vector ?? null,
      },
      revisionLimit: NOTE_REVISION_LIMIT,
    }
  }

  /* ---------------------- undo support ------------------------- */

  /**
   * Apply the inverse of one `note.*` journal entry.
   *
   * Called synchronously from `store.operationsUndo`, which already wraps the
   * call in a transaction — never begin a nested transaction here.
   * @param {string} kind journal kind.
   * @param {object} undo stored undo payload.
   * @returns {{status:string, reason?:string, restored?:object}} outcome.
   */
  function applyUndo(kind, undo = {}) {
    const now = nowIso()
    switch (kind) {
      case 'note.create': {
        const row = db.prepare('SELECT * FROM note_docs WHERE id = ?').get(undo.noteId)
        if (row === undefined) return { status: 'not_undoable', reason: 'note no longer exists' }
        db.prepare("UPDATE note_docs SET state = 'trash', deleted_at = ?, updated_at = ? WHERE id = ?").run(now, now, row.id)
        removeNoteFts(row.id)
        scheduleIndexSync([row.id], 300)
        return { status: 'undone', restored: { noteId: row.id, state: 'trash' } }
      }
      case 'note.update':
      case 'note.restoreRevision': {
        const row = db.prepare('SELECT * FROM note_docs WHERE id = ?').get(undo.noteId)
        if (row === undefined) return { status: 'not_undoable', reason: 'note no longer exists' }
        const before = undo.before ?? {}
        const columns = {}
        for (const column of ['title', 'content_md', 'content_json', 'folder_id', 'status', 'format_version', 'beautified_revision']) {
          if (Object.hasOwn(before, column)) columns[column] = before[column]
        }
        const nextRow = withIndexText({ ...row, ...columns })
        columns.index_text = nextRow.index_text
        columns.updated_at = now
        const assignments = Object.keys(columns).map((column) => `${column} = ?`)
        db.prepare(`UPDATE note_docs SET ${assignments.join(', ')}, revision = revision + 1 WHERE id = ?`).run(
          ...Object.values(columns),
          row.id,
        )
        if (Array.isArray(undo.links)) replacePaperLinks(row.id, undo.links.map((link) => link.paperId), new Map(undo.links.map((link) => [link.paperId, link.anchor])), now)
        const updated = db.prepare('SELECT * FROM note_docs WHERE id = ?').get(row.id)
        upsertNoteFts(updated)
        scheduleIndexSync([row.id], 300)
        return { status: 'undone', restored: { noteId: row.id, fields: Object.keys(columns) } }
      }
      case 'note.delete': {
        const ids = Array.isArray(undo.ids) ? undo.ids : []
        for (const id of ids) {
          db.prepare("UPDATE note_docs SET state = 'active', deleted_at = NULL, updated_at = ? WHERE id = ?").run(now, id)
          const row = db.prepare('SELECT * FROM note_docs WHERE id = ?').get(id)
          if (row !== undefined) upsertNoteFts(row)
        }
        scheduleIndexSync(ids, 300)
        return { status: 'undone', restored: { ids, state: 'active' } }
      }
      case 'note.restore': {
        const ids = Array.isArray(undo.ids) ? undo.ids : []
        for (const id of ids) {
          db.prepare("UPDATE note_docs SET state = 'trash', deleted_at = ?, updated_at = ? WHERE id = ?").run(now, now, id)
          removeNoteFts(id)
        }
        scheduleIndexSync(ids, 300)
        return { status: 'undone', restored: { ids, state: 'trash' } }
      }
      case 'note.purge':
        return { status: 'not_undoable', reason: 'purge permanently removes note content and cannot be undone' }
      case 'note.folder.create': {
        const folder = db.prepare('SELECT * FROM note_folders WHERE id = ?').get(undo.folderId)
        if (folder === undefined) return { status: 'not_undoable', reason: 'note folder no longer exists' }
        db.prepare('UPDATE note_folders SET parent_id = ? WHERE parent_id = ?').run(folder.parent_id ?? null, folder.id)
        db.prepare('UPDATE note_docs SET folder_id = ? WHERE folder_id = ?').run(folder.parent_id ?? null, folder.id)
        db.prepare('DELETE FROM note_folders WHERE id = ?').run(folder.id)
        return { status: 'undone', restored: { folderId: folder.id } }
      }
      case 'note.folder.update': {
        const row = db.prepare('SELECT * FROM note_folders WHERE id = ?').get(undo.folderId)
        if (row === undefined) return { status: 'not_undoable', reason: 'note folder no longer exists' }
        const before = undo.before ?? {}
        if (typeof before.name === 'string') db.prepare('UPDATE note_folders SET name = ?, updated_at = ? WHERE id = ?').run(before.name, now, row.id)
        if (Object.hasOwn(before, 'color')) db.prepare('UPDATE note_folders SET color = ?, updated_at = ? WHERE id = ?').run(before.color ?? null, now, row.id)
        return { status: 'undone', restored: { folderId: row.id } }
      }
      case 'note.folder.delete': {
        const before = undo.before ?? {}
        if (typeof before.id !== 'string') return { status: 'not_undoable', reason: 'note folder snapshot missing' }
        db.prepare(
          'INSERT OR REPLACE INTO note_folders(id, name, parent_id, color, sort_order, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
        ).run(
          before.id,
          before.name,
          before.parent_id ?? null,
          before.color ?? null,
          revisionInt(before.sort_order),
          before.created_at ?? now,
          now,
        )
        for (const id of undo.movedChildren ?? []) db.prepare('UPDATE note_folders SET parent_id = ? WHERE id = ?').run(before.id, id)
        for (const id of undo.movedNotes ?? []) db.prepare('UPDATE note_docs SET folder_id = ? WHERE id = ?').run(before.id, id)
        return { status: 'undone', restored: { folderId: before.id } }
      }
      case 'note.folder.assign':
      case 'note.folder.unassign': {
        const before = Array.isArray(undo.before) ? undo.before : []
        for (const item of before) {
          if (typeof item?.noteId !== 'string') continue
          db.prepare('UPDATE note_docs SET folder_id = ?, updated_at = ? WHERE id = ?').run(item.folderId ?? null, now, item.noteId)
        }
        return { status: 'undone', restored: { notes: before.length } }
      }
      case 'note.link':
      case 'note.unlink': {
        const noteId = undo.noteId
        if (typeof noteId !== 'string') return { status: 'not_undoable', reason: 'note id missing' }
        replacePaperLinks(noteId, (undo.previous ?? []).map((link) => link.paperId), new Map((undo.previous ?? []).map((link) => [link.paperId, link.anchor])), now)
        return { status: 'undone', restored: { noteId, links: (undo.previous ?? []).length } }
      }
      default:
        return { status: 'not_undoable', reason: `unsupported notes operation ${kind}` }
    }
  }

  /* ---------------------- notes API ---------------------------- */

  /** Build the shared note filter (alias `n`). */
  function buildNoteWhere(params = {}) {
    const clauses = []
    const values = []
    const state = typeof params.state === 'string' ? params.state : ''
    const includeTrash = params.includeTrash === true || params.trash === true || state === 'trash' || state === 'all'
    if (!includeTrash) clauses.push("n.state = 'active'")
    else if (state === 'trash' || params.trash === true) clauses.push("n.state = 'trash'")
    if (typeof params.status === 'string' && params.status !== '' && params.status !== 'all') {
      if (!NOTE_STATUSES.has(params.status)) throw invalid(`unsupported note status ${params.status}`)
      clauses.push('n.status = ?')
      values.push(params.status)
    }
    const folderId = params.folderId ?? params.folder_id
    if (typeof folderId === 'string' && folderId !== '') {
      const ids = folderSubtreeIds(folderId)
      if (ids.length === 0) {
        clauses.push('1 = 0')
      } else {
        clauses.push(`n.folder_id IN (${ids.map(() => '?').join(',')})`)
        values.push(...ids)
      }
    }
    const paperId = params.paperId ?? params.paper_id
    if (typeof paperId === 'string' && paperId !== '') {
      clauses.push('EXISTS (SELECT 1 FROM note_paper_links l WHERE l.note_id = n.id AND l.paper_id = ?)')
      values.push(paperId)
    }
    if (typeof params.query === 'string' && params.query.trim() !== '') {
      const pattern = `%${escapeLike(params.query.trim())}%`
      clauses.push("(LOWER(n.title) LIKE LOWER(?) ESCAPE '\\' OR LOWER(n.index_text) LIKE LOWER(?) ESCAPE '\\')")
      values.push(pattern, pattern)
    }
    return { clauses, values, sql: clauses.length === 0 ? '' : `WHERE ${clauses.join(' AND ')}` }
  }

  /** Attach folders + paper links to a list of note rows (bulk queries). */
  function attachRelations(rows) {
    const folders = folderMap()
    const ids = rows.map((row) => row.id)
    const links = linksByNote(ids)
    const paperIds = [...new Set([...links.values()].flat().map((link) => link.paperId))]
    const papers = paperSummaries(paperIds)
    return rows.map((row) => {
      const note = mapNoteBase(row)
      note.folder = folders.has(row.folder_id ?? '') ? mapFolder(folders.get(row.folder_id)) : null
      const rowLinks = links.get(row.id) ?? []
      note.paperLinks = rowLinks.map((link) => {
        const paper = papers.get(link.paperId)
        return {
          paperId: link.paperId,
          title: paper?.title ?? null,
          titleZh: paper?.title_zh ?? null,
          year: paper?.year === null || paper?.year === undefined ? null : Number(paper.year),
          venue: paper?.venue ?? null,
          state: paper?.state ?? 'missing',
          anchor: link.anchor,
        }
      })
      note.paperIds = note.paperLinks.map((link) => link.paperId)
      return note
    })
  }

  /** `notes.list` — summaries with folder/paper relations. */
  function list(params = {}) {
    const limit = clampInt(params.limit ?? 50, 1, 200, 50)
    const offset = clampInt(params.offset ?? 0, 0, 1_000_000, 0)
    const where = buildNoteWhere(params)
    const total = Number(db.prepare(`SELECT COUNT(*) AS count FROM note_docs n ${where.sql}`).get(...where.values)?.count ?? 0)
    const sort = typeof params.sort === 'string' ? params.sort : 'updated'
    let orderBy = 'n.updated_at DESC, n.id DESC'
    if (sort === 'created') orderBy = 'n.created_at DESC, n.id DESC'
    if (sort === 'title') orderBy = 'LOWER(n.title) ASC, n.id ASC'
    const rows = db
      .prepare(`SELECT * FROM note_docs n ${where.sql} ORDER BY ${orderBy} LIMIT ? OFFSET ?`)
      .all(...where.values, limit, offset)
    const items = attachRelations(rows).map((note) => ({
      ...note,
      preview: notePreview(rows.find((row) => row.id === note.id) ?? {}),
      paperCount: note.paperIds.length,
      contentMd: undefined,
      contentJson: undefined,
    }))
    return { items, total, limit, offset }
  }

  /** `notes.get` — one note with relations and recent revision list. */
  function get(params = {}) {
    const id = normalizeNoteId(params.id, 'notes.get')
    const row = requireNoteRow(id)
    if (row.state === 'trash' && params.includeTrash === false) throw notFound(`note ${id} is in the recycle bin`, { id })
    const note = noteWithLinks(row)
    note.preview = notePreview(row)
    note.revisions = revisionList(id, { limit: clampInt(params.revisionLimit ?? NOTE_REVISION_LIMIT, 1, NOTE_REVISION_LIMIT, NOTE_REVISION_LIMIT) }).items
    return { note }
  }

  /** List revision snapshots (newest first). */
  function revisionList(noteId, { limit = NOTE_REVISION_LIMIT } = {}) {
    const rows = db
      .prepare('SELECT id, note_id, revision, title, content_md, content_json, reason, created_at FROM note_revisions WHERE note_id = ? ORDER BY revision DESC, id DESC LIMIT ?')
      .all(noteId, limit)
    return {
      noteId,
      items: rows.map((row) => ({
        id: Number(row.id),
        revision: revisionInt(row.revision),
        title: row.title ?? '',
        reason: row.reason ?? 'update',
        createdAt: row.created_at,
        contentMdLength: String(row.content_md ?? '').length,
        hasContentJson: typeof row.content_json === 'string' && row.content_json !== '',
      })),
    }
  }

  /** Validate/normalize an optional expectedRevision guard. */
  function checkExpectedRevision(expectedRevision, row) {
    if (expectedRevision === undefined || expectedRevision === null || expectedRevision === '') return
    const expected = revisionInt(expectedRevision, -1)
    if (expected !== revisionInt(row.revision)) {
      throw new DomainError('conflict', `note ${row.id} has revision ${revisionInt(row.revision)}, not ${expected}`, {
        id: row.id,
        currentRevision: revisionInt(row.revision),
      })
    }
  }

  /** Validate and serialize a new `content_json` value. */
  function normalizeContentJson(value) {
    if (value === null) return null
    let parsed = value
    if (typeof parsed === 'string') {
      const text = parsed.trim()
      if (text === '') return null
      try {
        parsed = JSON.parse(text)
      } catch (error) {
        throw invalid(`contentJson is not valid JSON: ${String(error?.message ?? error)}`)
      }
    }
    if (parsed === undefined) return null
    let serialized
    try {
      serialized = JSON.stringify(parsed)
    } catch (error) {
      throw invalid(`contentJson is not serializable: ${String(error?.message ?? error)}`)
    }
    if (typeof serialized !== 'string') throw invalid('contentJson must be a JSON object, array or null')
    if (serialized.length > NOTE_MAX_JSON_CHARS) throw invalid(`contentJson exceeds ${NOTE_MAX_JSON_CHARS} characters`)
    return serialized
  }

  /** Normalize a title argument. */
  function normalizeTitle(value, { allowEmpty = true } = {}) {
    const title = typeof value === 'string' ? value.trim() : ''
    if (title === '' && !allowEmpty) throw invalid('title cannot be empty')
    if (title.length > 300) throw invalid('title exceeds 300 characters')
    return title
  }

  /** Normalize the user markdown content. */
  function normalizeContent(value) {
    if (value === undefined || value === null) return ''
    if (typeof value !== 'string') throw invalid('content must be a string')
    if (value.length > NOTE_MAX_CONTENT_CHARS) throw invalid(`content exceeds ${NOTE_MAX_CONTENT_CHARS} characters`)
    return value
  }

  /** Normalize a status argument. */
  function normalizeStatus(value) {
    const status = String(value ?? '')
    if (!NOTE_STATUSES.has(status)) throw invalid(`unsupported note status ${status}`)
    return status
  }

  /** Normalize a text field used by beautifiedRevision / formatVersion. */
  function normalizeMeta(value, field) {
    if (value === null || value === undefined || value === '') return null
    if (typeof value === 'number' || typeof value === 'boolean') return String(value)
    if (typeof value !== 'string') throw invalid(`${field} must be a string or number`)
    if (value.length > 200) throw invalid(`${field} exceeds 200 characters`)
    return value
  }

  /**
   * `notes.create` — create one note (atomic, with initial snapshot).
   * @param {object} params create payload.
   * @returns {{note:object}}
   */
  function create(params = {}) {
    return withOperationId('notes.create', params.operationId, () =>
      transaction(db, () => {
        const title = normalizeTitle(params.title ?? '')
        const content = normalizeContent(params.content ?? params.contentMd ?? params.content_md)
        const contentJsonSerialized = normalizeContentJson(params.contentJson ?? params.content_json)
        const folderId = normalizeFolderId(params.folderId ?? params.folder_id)
        const paperIds = params.paperIds === undefined ? [] : normalizePaperIds(params.paperIds, 'notes.create')
        const status = params.status === undefined ? 'draft' : normalizeStatus(params.status)
        const now = nowIso()
        const id = `note-${randomHex(6)}`
        const indexText = buildNoteIndexText({ title, content_md: content, content_json: contentJsonSerialized })
        db.prepare(
          `INSERT INTO note_docs(id, title, content_md, content_json, index_text, status, folder_id, format_version, beautified_revision, state, created_at, updated_at, revision, deleted_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?, 0, NULL)`,
        ).run(
          id,
          title,
          content,
          contentJsonSerialized,
          indexText,
          status,
          folderId,
          normalizeMeta(params.formatVersion ?? params.format_version, 'formatVersion'),
          normalizeMeta(params.beautifiedRevision ?? params.beautified_revision, 'beautifiedRevision'),
          now,
          now,
        )
        const anchors = new Map()
        replacePaperLinks(id, paperIds, anchors, now)
        const row = db.prepare('SELECT * FROM note_docs WHERE id = ?').get(id)
        snapshotRevision(row, 'create')
        upsertNoteFts(row)
        const operationId = recordOperation({
          kind: 'note.create',
          summary: `新建笔记「${title || id}」`,
          target: { noteId: id },
          undo: { noteId: id },
        })
        recordEvent('note.create', paperIds[0] ?? null, { id })
        // New notes must enter the vector index too; update/restore already
        // schedule this, create previously forgot it (FTS was immediate, vector
        // stayed empty until a manual indexSync).
        scheduleIndexSync([id], 1500)
        return { note: { ...noteWithLinks(row), preview: notePreview(row) }, operationId }
      }),
    )
  }

  /**
   * `notes.update` — patch one note. `content`/`contentMd` only ever write
   * `content_md`; `contentJson` only ever writes `content_json`.
   * @param {object} params update payload.
   * @returns {{note:object}}
   */
  function update(params = {}) {
    const id = normalizeNoteId(params.id, 'notes.update')
    const patch = params.patch
    if (patch === undefined || patch === null || typeof patch !== 'object' || Array.isArray(patch)) {
      throw invalid('notes.update requires a patch object')
    }
    return withOperationId('notes.update', params.operationId, () =>
      transaction(db, () => {
        const row = requireNoteRow(id)
        checkExpectedRevision(params.expectedRevision, row)
        const columns = {}
        let reason = 'update'
        if (Object.hasOwn(patch, 'title')) columns.title = normalizeTitle(patch.title)
        const hasContent = Object.hasOwn(patch, 'content') || Object.hasOwn(patch, 'contentMd') || Object.hasOwn(patch, 'content_md')
        if (hasContent) columns.content_md = normalizeContent(patch.content ?? patch.contentMd ?? patch.content_md)
        const hasJson = Object.hasOwn(patch, 'contentJson') || Object.hasOwn(patch, 'content_json')
        if (hasJson) columns.content_json = normalizeContentJson(patch.contentJson ?? patch.content_json)
        if (Object.hasOwn(patch, 'folderId') || Object.hasOwn(patch, 'folder_id')) {
          columns.folder_id = normalizeFolderId(patch.folderId ?? patch.folder_id)
        }
        if (Object.hasOwn(patch, 'status')) columns.status = normalizeStatus(patch.status)
        if (Object.hasOwn(patch, 'beautifiedRevision') || Object.hasOwn(patch, 'beautified_revision')) {
          columns.beautified_revision = normalizeMeta(patch.beautifiedRevision ?? patch.beautified_revision, 'beautifiedRevision')
        }
        if (Object.hasOwn(patch, 'formatVersion') || Object.hasOwn(patch, 'format_version')) {
          columns.format_version = normalizeMeta(patch.formatVersion ?? patch.format_version, 'formatVersion')
        }
        const hasPaperIds = Object.hasOwn(patch, 'paperIds') || Object.hasOwn(patch, 'paper_ids')
        if (Object.keys(columns).length === 0 && !hasPaperIds) throw invalid('notes.update requires at least one field')
        if (
          hasJson &&
          !hasContent &&
          !hasPaperIds &&
          !Object.hasOwn(patch, 'title') &&
          !Object.hasOwn(patch, 'folderId') &&
          !Object.hasOwn(patch, 'folder_id') &&
          !Object.hasOwn(patch, 'status')
        ) {
          reason = 'beautify'
        }
        // Snapshot the pre-change state first: no update can lose user content.
        snapshotRevision(row, reason)
        const beforeLinks = linkRows(id).map((link) => ({ paperId: link.paperId, anchor: link.anchor }))
        const now = nowIso()
        if (Object.keys(columns).length > 0) {
          const nextRow = withIndexText({ ...row, ...columns })
          columns.index_text = nextRow.index_text
          columns.updated_at = now
          writeNoteColumns(id, columns)
        } else {
          db.prepare('UPDATE note_docs SET updated_at = ? WHERE id = ?').run(now, id)
        }
        if (hasPaperIds) {
          const paperIds = normalizePaperIds(patch.paperIds ?? patch.paper_ids, 'notes.update')
          replacePaperLinks(id, paperIds, new Map(), now)
        }
        // Every accepted update advances the revision so optimistic clients can
        // detect concurrent edits even when only the layout changed.
        db.prepare('UPDATE note_docs SET revision = revision + 1 WHERE id = ?').run(id)
        const updated = db.prepare('SELECT * FROM note_docs WHERE id = ?').get(id)
        upsertNoteFts(updated)
        const operationId = recordOperation({
          kind: 'note.update',
          summary: `更新笔记「${updated.title || updated.id}」`,
          target: { noteId: id },
          undo: {
            noteId: id,
            before: {
              title: row.title ?? '',
              content_md: row.content_md ?? '',
              content_json: row.content_json ?? null,
              folder_id: row.folder_id ?? null,
              status: row.status ?? 'draft',
              format_version: row.format_version ?? null,
              beautified_revision: row.beautified_revision ?? null,
            },
            links: beforeLinks,
          },
        })
        recordEvent('note.update', (linkRows(id)[0] ?? {}).paperId ?? null, { id })
        scheduleIndexSync([id], 1500)
        return { note: { ...noteWithLinks(updated), preview: notePreview(updated) }, operationId }
      }),
    )
  }

  /** `notes.delete` — soft delete into the recycle bin. */
  function remove(params = {}) {
    const ids = normalizeNoteIds(params.ids, 'notes.delete')
    return withOperationId('notes.delete', params.operationId, () =>
      transaction(db, () => {
        const deleted = []
        for (const id of ids) {
          const row = requireNoteRow(id)
          db.prepare("UPDATE note_docs SET state = 'trash', deleted_at = ?, updated_at = ? WHERE id = ?").run(nowIso(), nowIso(), id)
          removeNoteFts(id)
          deleted.push(row.id)
        }
        const operationId = recordOperation({
          kind: 'note.delete',
          summary: `移入回收站（${deleted.length} 篇笔记）`,
          target: { ids: deleted },
          undo: { ids: deleted },
        })
        recordEvent('note.delete', null, { ids: deleted })
        scheduleIndexSync(deleted, 1000)
        return { deleted, trashed: true, operationId }
      }),
    )
  }

  /** `notes.restore` — restore notes from the recycle bin. */
  function restore(params = {}) {
    const ids = normalizeNoteIds(params.ids, 'notes.restore')
    return withOperationId('notes.restore', params.operationId, () =>
      transaction(db, () => {
        const restored = []
        for (const id of ids) {
          const row = requireNoteRow(id)
          db.prepare("UPDATE note_docs SET state = 'active', deleted_at = NULL, updated_at = ? WHERE id = ?").run(nowIso(), id)
          const updated = db.prepare('SELECT * FROM note_docs WHERE id = ?').get(id)
          upsertNoteFts(updated)
          restored.push(row.id)
        }
        const operationId = recordOperation({
          kind: 'note.restore',
          summary: `恢复笔记（${restored.length} 篇）`,
          target: { ids: restored },
          undo: { ids: restored },
        })
        recordEvent('note.restore', null, { ids: restored })
        scheduleIndexSync(restored, 1000)
        return { restored, operationId }
      }),
    )
  }

  /** `notes.purge` — explicit permanent deletion (requires trash unless force). */
  function purge(params = {}) {
    const ids = normalizeNoteIds(params.ids, 'notes.purge')
    return withOperationId('notes.purge', params.operationId, () =>
      transaction(db, () => {
        const purged = []
        for (const id of ids) {
          const row = requireNoteRow(id)
          if (row.state !== 'trash' && params.force !== true) {
            throw invalid(`note ${id} is not in the recycle bin; pass force:true to purge an active note`, { id })
          }
          db.prepare('DELETE FROM note_paper_links WHERE note_id = ?').run(id)
          db.prepare('DELETE FROM note_revisions WHERE note_id = ?').run(id)
          db.prepare('DELETE FROM note_embeddings WHERE note_id = ?').run(id)
          removeNoteFts(id)
          db.prepare('DELETE FROM note_docs WHERE id = ?').run(id)
          purged.push(id)
        }
        const operationId = recordOperation({
          kind: 'note.purge',
          summary: `彻底删除笔记（${purged.length} 篇）`,
          target: { ids: purged },
          undo: {},
        })
        recordEvent('note.purge', null, { ids: purged })
        return { purged: purged.length, ids: purged, operationId }
      }),
    )
  }

  /** `notes.revisions` — revision snapshots of one note. */
  function revisions(params = {}) {
    const id = normalizeNoteId(params.id, 'notes.revisions')
    requireNoteRow(id)
    const limit = clampInt(params.limit ?? NOTE_REVISION_LIMIT, 1, NOTE_REVISION_LIMIT, NOTE_REVISION_LIMIT)
    return revisionList(id, { limit })
  }

  /** `notes.restoreRevision` — turn one snapshot into a new revision. */
  function restoreRevision(params = {}) {
    const id = normalizeNoteId(params.id, 'notes.restoreRevision')
    const revision = revisionInt(params.revision, -1)
    if (revision < 0) throw invalid('notes.restoreRevision requires an integer revision')
    return withOperationId('notes.restoreRevision', params.operationId, () =>
      transaction(db, () => {
        const row = requireNoteRow(id)
        checkExpectedRevision(params.expectedRevision, row)
        const snapshot = db
          .prepare('SELECT * FROM note_revisions WHERE note_id = ? AND revision = ? ORDER BY id DESC LIMIT 1')
          .get(id, revision)
        if (snapshot === undefined) throw notFound(`note ${id} has no revision ${revision}`, { id, revision })
        snapshotRevision(row, 'restore')
        const beforeLinks = linkRows(id).map((link) => ({ paperId: link.paperId, anchor: link.anchor }))
        const nextRow = withIndexText({ ...row, title: snapshot.title ?? '', content_md: snapshot.content_md ?? '', content_json: snapshot.content_json ?? null })
        const updated = writeNoteColumns(id, {
          title: nextRow.title,
          content_md: nextRow.content_md,
          content_json: nextRow.content_json,
          index_text: nextRow.index_text,
          updated_at: nowIso(),
        })
        db.prepare('UPDATE note_docs SET revision = revision + 1 WHERE id = ?').run(id)
        const finalRow = db.prepare('SELECT * FROM note_docs WHERE id = ?').get(id)
        upsertNoteFts(finalRow)
        const operationId = recordOperation({
          kind: 'note.restoreRevision',
          summary: `恢复笔记历史版本 r${revision}「${finalRow.title || finalRow.id}」`,
          target: { noteId: id, revision },
          undo: {
            noteId: id,
            before: {
              title: row.title ?? '',
              content_md: row.content_md ?? '',
              content_json: row.content_json ?? null,
              folder_id: row.folder_id ?? null,
              status: row.status ?? 'draft',
              format_version: row.format_version ?? null,
              beautified_revision: row.beautified_revision ?? null,
            },
            links: beforeLinks,
          },
        })
        recordEvent('note.restoreRevision', null, { id, revision })
        scheduleIndexSync([id], 1500)
        return { note: { ...noteWithLinks(finalRow), preview: notePreview(finalRow) }, restoredRevision: revision, operationId }
      }),
    )
  }

  /* ---------------------- folders API -------------------------- */

  /** `notes.folders.tree` — nested folders with subtree note counts. */
  function folderTree() {
    const rows = db.prepare('SELECT * FROM note_folders ORDER BY sort_order, LOWER(name), id').all()
    const direct = directFolderCounts()
    const byParent = new Map()
    for (const row of rows) {
      const key = row.parent_id ?? null
      if (!byParent.has(key)) byParent.set(key, [])
      byParent.get(key).push(row)
    }
    const subtreeCount = (folderId) => {
      let total = direct.get(folderId) ?? 0
      for (const child of byParent.get(folderId) ?? []) total += subtreeCount(child.id)
      return total
    }
    const build = (row) => {
      const children = (byParent.get(row.id) ?? []).map(build)
      return {
        id: row.id,
        name: row.name,
        parentId: row.parent_id ?? null,
        color: row.color ?? null,
        sortOrder: revisionInt(row.sort_order),
        count: subtreeCount(row.id),
        directCount: direct.get(row.id) ?? 0,
        children,
      }
    }
    return { folders: (byParent.get(null) ?? []).map(build) }
  }

  /** `notes.folders.create`. */
  function folderCreate(params = {}) {
    return withOperationId('notes.folders.create', params.operationId, () =>
      transaction(db, () => {
        const name = normalizeTitle(params.name, { allowEmpty: false })
        const parentId = normalizeFolderId(params.parentId ?? params.parent_id)
        const color = params.color === undefined || params.color === null ? null : String(params.color).slice(0, 40)
        const id = `nf-${randomHex(6)}`
        const now = nowIso()
        const sortOrder = Number(
          db.prepare('SELECT COALESCE(MAX(sort_order), 0) AS max FROM note_folders WHERE parent_id IS ?').get(parentId)?.max ?? 0,
        ) + 1
        db.prepare('INSERT INTO note_folders(id, name, parent_id, color, sort_order, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)').run(
          id,
          name,
          parentId,
          color,
          sortOrder,
          now,
          now,
        )
        const operationId = recordOperation({
          kind: 'note.folder.create',
          summary: `新建笔记文件夹「${name}」`,
          target: { folderId: id },
          undo: { folderId: id },
        })
        recordEvent('note.folder.create', null, { id })
        return { folder: { ...mapFolder(db.prepare('SELECT * FROM note_folders WHERE id = ?').get(id)), count: 0, directCount: 0, children: [] }, operationId }
      }),
    )
  }

  /** `notes.folders.rename` — rename and/or recolor one folder. */
  function folderUpdate(params = {}) {
    const id = String(params.id ?? '')
    if (id === '') throw invalid('notes.folders.rename requires id')
    if (NOTE_FOLDER_ID_PATTERN.test(id) === false) throw invalid(`invalid note folder id ${id}`, { id })
    return withOperationId('notes.folders.rename', params.operationId, () =>
      transaction(db, () => {
        const row = requireFolderRow(id)
        const hasName = Object.hasOwn(params, 'name')
        const hasColor = Object.hasOwn(params, 'color')
        if (!hasName && !hasColor) throw invalid('notes.folders.rename requires name or color')
        const name = hasName ? normalizeTitle(params.name, { allowEmpty: false }) : row.name
        const color = hasColor ? (params.color === null ? null : String(params.color).slice(0, 40)) : row.color
        db.prepare('UPDATE note_folders SET name = ?, color = ?, updated_at = ? WHERE id = ?').run(name, color ?? null, nowIso(), id)
        const operationId = recordOperation({
          kind: 'note.folder.update',
          summary: `重命名笔记文件夹「${name}」`,
          target: { folderId: id },
          undo: { folderId: id, before: { name: row.name, color: row.color ?? null } },
        })
        return { folder: { ...mapFolder(db.prepare('SELECT * FROM note_folders WHERE id = ?').get(id)), count: 0, directCount: 0, children: [] }, operationId }
      }),
    )
  }

  /** `notes.folders.delete` — children and notes move up; notes are never deleted. */
  function folderDelete(params = {}) {
    const id = String(params.id ?? '')
    if (id === '') throw invalid('notes.folders.delete requires id')
    if (NOTE_FOLDER_ID_PATTERN.test(id) === false) throw invalid(`invalid note folder id ${id}`, { id })
    return withOperationId('notes.folders.delete', params.operationId, () =>
      transaction(db, () => {
        const row = requireFolderRow(id)
        const parentId = row.parent_id ?? null
        const children = db.prepare('SELECT id FROM note_folders WHERE parent_id = ?').all(id).map((child) => child.id)
        const notes = db.prepare('SELECT id FROM note_docs WHERE folder_id = ?').all(id).map((note) => note.id)
        const now = nowIso()
        for (const childId of children) db.prepare('UPDATE note_folders SET parent_id = ?, updated_at = ? WHERE id = ?').run(parentId, now, childId)
        for (const noteId of notes) db.prepare('UPDATE note_docs SET folder_id = ?, updated_at = ? WHERE id = ?').run(parentId, now, noteId)
        db.prepare('DELETE FROM note_folders WHERE id = ?').run(id)
        const operationId = recordOperation({
          kind: 'note.folder.delete',
          summary: `删除笔记文件夹「${row.name}」（子夹与笔记上移）`,
          target: { folderId: id },
          undo: {
            before: {
              id: row.id,
              name: row.name,
              parent_id: row.parent_id ?? null,
              color: row.color ?? null,
              sort_order: revisionInt(row.sort_order),
              created_at: row.created_at,
            },
            movedChildren: children,
            movedNotes: notes,
          },
        })
        recordEvent('note.folder.delete', null, { id })
        return { deleted: id, movedNotes: notes.length, movedChildren: children, operationId }
      }),
    )
  }

  /** Move a list of notes into one folder. */
  function folderAssign(params = {}) {
    const folderId = normalizeFolderId(params.folderId ?? params.folder_id, { allowNull: false })
    const noteIds = normalizeNoteIds(params.noteIds ?? params.note_ids ?? params.ids, 'notes.folders.assign')
    return withOperationId('notes.folders.assign', params.operationId, () =>
      transaction(db, () => {
        const now = nowIso()
        const before = []
        for (const noteId of noteIds) {
          const row = requireNoteRow(noteId)
          before.push({ noteId, folderId: row.folder_id ?? null })
          db.prepare('UPDATE note_docs SET folder_id = ?, updated_at = ? WHERE id = ?').run(folderId, now, noteId)
        }
        const operationId = recordOperation({
          kind: 'note.folder.assign',
          summary: `移动 ${noteIds.length} 篇笔记到文件夹`,
          target: { folderId, noteIds },
          undo: { before },
        })
        return { assigned: noteIds.length, folderId, operationId }
      }),
    )
  }

  /** Remove notes from their folder (unclassified). */
  function folderUnassign(params = {}) {
    const noteIds = normalizeNoteIds(params.noteIds ?? params.note_ids ?? params.ids, 'notes.folders.unassign')
    return withOperationId('notes.folders.unassign', params.operationId, () =>
      transaction(db, () => {
        const now = nowIso()
        const before = []
        for (const noteId of noteIds) {
          const row = requireNoteRow(noteId)
          before.push({ noteId, folderId: row.folder_id ?? null })
          db.prepare('UPDATE note_docs SET folder_id = NULL, updated_at = ? WHERE id = ?').run(now, noteId)
        }
        const operationId = recordOperation({
          kind: 'note.folder.unassign',
          summary: `将 ${noteIds.length} 篇笔记移出文件夹`,
          target: { noteIds },
          undo: { before },
        })
        return { unassigned: noteIds.length, operationId }
      }),
    )
  }

  /* ---------------------- links API ---------------------------- */

  /** `notes.link` — attach papers (with optional anchors) to one note. */
  function link(params = {}) {
    const noteId = normalizeNoteId(params.noteId ?? params.id, 'notes.link')
    const paperIds = normalizePaperIds(params.paperIds ?? params.paper_ids ?? [], 'notes.link')
    return withOperationId('notes.link', params.operationId, () =>
      transaction(db, () => {
        requireNoteRow(noteId)
        const anchors = new Map()
        const anchorMap = params.anchors !== undefined && params.anchors !== null && typeof params.anchors === 'object' ? params.anchors : null
        for (const paperId of paperIds) {
          const anchor = anchorMap !== null && Object.hasOwn(anchorMap, paperId) ? anchorMap[paperId] : params.anchor ?? null
          anchors.set(paperId, anchor ?? null)
        }
        const previous = linkRows(noteId).map((link) => ({ paperId: link.paperId, anchor: link.anchor }))
        const now = nowIso()
        for (const paperId of paperIds) {
          db.prepare(
            'INSERT INTO note_paper_links(note_id, paper_id, anchor_json, created_at) VALUES (?, ?, ?, ?) ON CONFLICT(note_id, paper_id) DO UPDATE SET anchor_json = excluded.anchor_json',
          ).run(noteId, paperId, anchors.get(paperId) === null ? null : JSON.stringify(anchors.get(paperId)), now)
        }
        const operationId = recordOperation({
          kind: 'note.link',
          summary: `关联 ${paperIds.length} 篇论文到笔记`,
          target: { noteId, paperIds },
          undo: { noteId, previous },
        })
        const row = requireNoteRow(noteId)
        return { note: { ...noteWithLinks(row), preview: notePreview(row) }, operationId }
      }),
    )
  }

  /** `notes.unlink` — detach papers from one note. */
  function unlink(params = {}) {
    const noteId = normalizeNoteId(params.noteId ?? params.id, 'notes.unlink')
    const paperIds = normalizePaperIds(params.paperIds ?? params.paper_ids ?? [], 'notes.unlink')
    return withOperationId('notes.unlink', params.operationId, () =>
      transaction(db, () => {
        requireNoteRow(noteId)
        const previous = linkRows(noteId).map((link) => ({ paperId: link.paperId, anchor: link.anchor }))
        for (const paperId of paperIds) db.prepare('DELETE FROM note_paper_links WHERE note_id = ? AND paper_id = ?').run(noteId, paperId)
        const operationId = recordOperation({
          kind: 'note.unlink',
          summary: `取消 ${paperIds.length} 篇论文与笔记的关联`,
          target: { noteId, paperIds },
          undo: { noteId, previous },
        })
        const row = requireNoteRow(noteId)
        return { note: { ...noteWithLinks(row), preview: notePreview(row) }, operationId }
      }),
    )
  }

  /* ---------------------- search API --------------------------- */

  /** Build a `LIKE` snippet around the first match. */
  function likeSnippet(text, needle, radius = 100) {
    const source = String(text ?? '')
    if (source === '') return ''
    const query = String(needle ?? '').trim()
    if (query === '') return source.slice(0, radius * 2).replace(/\s+/g, ' ').trim()
    let index = source.toLowerCase().indexOf(query.toLowerCase())
    if (index < 0) {
      const firstToken = query.split(/\s+/)[0]
      if (firstToken !== query) return likeSnippet(source, firstToken, radius)
      return source.slice(0, radius * 2).replace(/\s+/g, ' ').trim()
    }
    const start = Math.max(0, index - radius)
    const end = Math.min(source.length, index + query.length + radius)
    const prefix = start > 0 ? '…' : ''
    const suffix = end < source.length ? '…' : ''
    return `${prefix}${source.slice(start, end).replace(/\s+/g, ' ').trim()}${suffix}`
  }

  /** FTS MATCH expression (quoted tokens only; never user-controlled syntax). */
  function ftsMatch(query) {
    const tokens = String(query ?? '')
      .split(/\s+/)
      .map((token) => token.replace(/["'*():^{}[\]\\-]/g, '').trim())
      .filter((token) => /\p{L}|\p{N}/u.test(token))
      .map((token) => `"${token.replace(/"/g, '')}"`)
    if (tokens.length === 0) return null
    return tokens.join(' OR ')
  }

  /**
   * `notes.search` — notes FTS + LIKE (+ vector when the embedding worker is
   * usable). Returns `channels` facts so the UI can be honest about degradation.
   * @param {object} params search parameters.
   * @returns {Promise<object>} search result.
   */
  async function search(params = {}) {
    const query = String(params.q ?? params.query ?? '').trim()
    const limit = clampInt(params.limit ?? 20, 1, 100, 20)
    const offset = clampInt(params.offset ?? 0, 0, 1_000_000, 0)
    const channels = { fts: 0, like: 0, vector: 'degraded' }
    const degraded = []
    if (query === '') return { items: [], total: 0, query, limit, offset, channels, degraded }
    const base = buildNoteWhere({ ...params, query: undefined })
    const merged = new Map()
    const addHit = (id, score, snippet, channel) => {
      const existing = merged.get(id)
      if (existing === undefined) merged.set(id, { id, score, snippet, channels: [channel] })
      else {
        existing.score = Math.max(existing.score, score)
        if (existing.snippet === '') existing.snippet = snippet
        existing.channels.push(channel)
      }
    }

    // LIKE channel: deterministic, always works (also covers CJK substrings that
    // the default unicode61 tokenizer cannot split).
    const likeClauses = [...base.clauses, "(LOWER(n.title) LIKE LOWER(?) ESCAPE '\\' OR LOWER(n.index_text) LIKE LOWER(?) ESCAPE '\\')"]
    const likeValues = [...base.values, `%${escapeLike(query)}%`, `%${escapeLike(query)}%`]
    try {
      const rows = db
        .prepare(
          `SELECT n.id, n.title, n.index_text, n.updated_at FROM note_docs n WHERE ${likeClauses.join(' AND ')} ORDER BY n.updated_at DESC LIMIT ?`,
        )
        .all(...likeValues, SEARCH_POOL)
      channels.like = rows.length
      const needle = query.toLowerCase()
      for (const row of rows) {
        const titleHit = String(row.title ?? '').toLowerCase().includes(needle)
        addHit(row.id, titleHit ? 4 : 2.5, likeSnippet(row.index_text, query), 'like')
      }
    } catch (error) {
      logger?.debug?.(`pappers-hall: note LIKE search failed: ${String(error?.message ?? error)}`)
    }

    // FTS channel.
    const match = ftsMatch(query)
    const ftsFilterSql = base.clauses.length === 0 ? '' : ` AND ${base.clauses.join(' AND ')}`
    if (match !== null && noteFtsReady()) {
      try {
        const rows = db
          .prepare(
            `SELECT n.id, bm25(note_fts) AS rank, snippet(note_fts, 2, '[', ']', ' … ', 16) AS text_snippet
             FROM note_fts JOIN note_docs n ON n.id = note_fts.note_id
             WHERE note_fts MATCH ?${ftsFilterSql}
             ORDER BY rank LIMIT ?`,
          )
          .all(match, ...base.values, SEARCH_POOL)
        channels.fts = rows.length
        for (const row of rows) {
          const rank = Math.abs(Number(row.rank ?? 0))
          addHit(row.id, 2 + 1 / (1 + rank), String(row.text_snippet ?? '').trim(), 'fts')
        }
      } catch (error) {
        ftsAvailable = false
        logger?.debug?.(`pappers-hall: note FTS search failed: ${String(error?.message ?? error)}`)
      }
    }

    // Vector channel (optional; honest degradation).
    const info = embeddingInfo()
    if (info.available) {
      try {
        const candidates = db.prepare(`SELECT n.id FROM note_docs n ${base.sql}`).all(...base.values)
        const allowed = new Set(candidates.map((row) => row.id))
        if (allowed.size > 0) {
          const embedded = await attached.embedding.embedTexts([query])
          const queryVector = new Float32Array(embedded.vectors[0] ?? [])
          const model = typeof embedded.model === 'string' && embedded.model !== '' ? embedded.model : info.model
          const rows = db.prepare('SELECT note_id, chunk_index, text, vector FROM note_embeddings WHERE model = ?').all(model)
          let hits = 0
          const best = new Map()
          for (const row of rows) {
            if (!allowed.has(row.note_id)) continue
            const score = cosine(queryVector, decodeVector(row.vector))
            const current = best.get(row.note_id)
            if (current === undefined || score > current.score) best.set(row.note_id, { score, snippet: row.text })
          }
          for (const [noteId, hit] of best) {
            if (hit.score <= 0.08) continue
            hits += 1
            addHit(noteId, hit.score * 3, likeSnippet(hit.snippet, query), 'vector')
          }
          channels.vector = hits
        } else {
          channels.vector = 0
        }
      } catch (error) {
        channels.vector = 'degraded'
        degraded.push({ channel: 'vector', reason: String(error?.message ?? error) })
        logger?.debug?.(`pappers-hall: note vector search failed: ${String(error?.message ?? error)}`)
      }
    } else {
      degraded.push({ channel: 'vector', reason: info.reason ?? 'embedding component is not available' })
    }

    const ranked = [...merged.values()].sort((left, right) => right.score - left.score || String(left.id).localeCompare(String(right.id)))
    const page = ranked.slice(offset, offset + limit)
    const pageIds = page.map((hit) => hit.id)
    const noteMap = new Map()
    if (pageIds.length > 0) {
      const placeholders = pageIds.map(() => '?').join(',')
      for (const row of db.prepare(`SELECT * FROM note_docs WHERE id IN (${placeholders})`).all(...pageIds)) noteMap.set(row.id, row)
    }
    const relations = attachRelations(pageIds.map((id) => noteMap.get(id)).filter(Boolean))
    const relationMap = new Map(relations.map((note) => [note.id, note]))
    const items = page.map((hit) => {
      const note = relationMap.get(hit.id)
      return {
        noteId: hit.id,
        id: hit.id,
        title: note?.title ?? '',
        snippet: hit.snippet,
        folderId: note?.folderId ?? null,
        folder: note?.folder ?? null,
        paperIds: note?.paperIds ?? [],
        status: note?.status ?? 'draft',
        updatedAt: note?.updatedAt ?? null,
        channels: [...new Set(hit.channels)],
      }
    })
    return { items, total: ranked.length, query, limit, offset, channels, degraded }
  }

  /** Cosine dot product for normalized vectors. */
  function cosine(left, right) {
    const length = Math.min(left.length, right.length)
    let sum = 0
    for (let index = 0; index < length; index += 1) sum += left[index] * right[index]
    return sum
  }

  /** Encode/decode Float32 vectors for `note_embeddings`. */
  function encodeVector(vector) {
    const array = new Float32Array(vector)
    return Buffer.from(array.buffer, array.byteOffset, array.byteLength)
  }

  function decodeVector(blob) {
    const buffer = Buffer.from(blob)
    return new Float32Array(buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength))
  }

  /* ---------------------- export ------------------------------- */

  /** `notes.export` — per-note markdown + JSON payloads (no zip dependency). */
  function exportNotes(params = {}) {
    const ids = normalizeNoteIds(params.ids, 'notes.export')
    const format = params.format === 'md' || params.format === 'json' ? params.format : 'both'
    const exportedAt = nowIso()
    const items = []
    const jsonNotes = []
    for (const id of ids) {
      const row = requireNoteRow(id)
      const note = noteWithLinks(row)
      const baseName = `${row.id}-${safeFileStem(row.title || 'note')}`
      const markdown = [
        `# ${row.title || '未命名笔记'}`,
        '',
        `> ${row.id} · revision ${revisionInt(row.revision)} · ${row.status} · ${row.state}`,
        ...(note.paperIds.length === 0 ? [] : [`> 关联论文：${note.paperLinks.map((link) => link.title ?? link.paperId).join('、')}`]),
        '',
        row.content_md ?? '',
        '',
      ].join('\n')
      const jsonPayload = {
        id: row.id,
        title: row.title ?? '',
        contentMd: row.content_md ?? '',
        contentJson: parseJson(row.content_json, null),
        status: row.status ?? 'draft',
        folderId: row.folder_id ?? null,
        formatVersion: row.format_version ?? null,
        beautifiedRevision: row.beautified_revision ?? null,
        revision: revisionInt(row.revision),
        state: row.state ?? 'active',
        createdAt: row.created_at,
        updatedAt: row.updated_at,
        paperLinks: note.paperLinks,
      }
      items.push({
        id: row.id,
        title: row.title ?? '',
        filename: `${baseName}.md`,
        mediaType: 'text/markdown; charset=utf-8',
        content: markdown,
        jsonFilename: `${baseName}.json`,
        jsonContent: JSON.stringify(jsonPayload, null, 2),
      })
      jsonNotes.push(jsonPayload)
    }
    const result = { items, format, exportedAt, count: items.length }
    if (format !== 'json') result.markdown = items.map((item) => item.content).join('\n---\n\n')
    if (format !== 'md') result.json = JSON.stringify({ exportedAt, notes: jsonNotes }, null, 2)
    return result
  }

  /* ---------------------- service ------------------------------ */

  /** Release the debounce timer (called from the host dispose path). */
  function close() {
    if (indexTimer !== null) {
      clearTimeout(indexTimer)
      indexTimer = null
    }
  }

  const service = {
    attach,
    close,
    // read
    list,
    get,
    revisions,
    search,
    folderTree,
    indexStatus,
    // write
    create,
    update,
    delete: remove,
    restore,
    purge,
    restoreRevision,
    folderCreate,
    folderUpdate,
    folderDelete,
    folderAssign,
    folderUnassign,
    link,
    unlink,
    exportNotes,
    // index sync (explicit hook; writes also schedule it internally)
    syncIndexNow,
    indexSync(params = {}) {
      const ids = Array.isArray(params.ids) && params.ids.length > 0 ? params.ids.map((id) => normalizeNoteId(id, 'notes.indexSync')) : undefined
      const info = embeddingInfo()
      if (!info.available) {
        return { status: 'unavailable', reason: info.reason, queued: 0, vector: indexStatus().vector }
      }
      scheduleIndexSync(ids, 0)
      const queued = ids === undefined ? Number(db.prepare("SELECT COUNT(*) AS count FROM note_docs WHERE state = 'active'").get()?.count ?? 0) : ids.length
      return { status: 'queued', queued, vector: indexStatus().vector }
    },
    /** Internal: used by `store.operationsUndo`, never called over the wire directly. */
    applyUndo,
    /** Internal: count helpers for `status`. */
    counts() {
      return {
        noteDocs: countRows(db, 'note_docs', "state = 'active'"),
        noteTrash: countRows(db, 'note_docs', "state = 'trash'"),
        noteFolders: countRows(db, 'note_folders'),
      }
    },
  }
  return service
}
