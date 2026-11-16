/**
 * Domain store for the Pappers-Hall Host half: every persistent object and every
 * read/write operation of contract §2.1 except standalone search and ingestion
 * (those modules attach themselves through {@link createStore}'s `attach`).
 *
 * Rules that hold for every method here:
 * - Normal browsing and every Agent tool read exclude `papers.state='trash'`;
 *   deletion only flips state and bumps the lifecycle epoch, so a delayed job
 *   can compare `epoch` before publishing derived data (contract §4).
 * - Writes that change searchable text re-index through the attached search
 *   service; there is no second write path that silently skips the index.
 * - Every filesystem write is atomic (temporary file + rename).
 *
 * @module pappers-hall/host/store
 */
import { readdirSync, statSync, unlinkSync } from 'node:fs'
import path from 'node:path'
import { countRows, databaseFacts, readSetting, transaction, writeSetting } from './db.js'
import { LAYOUT_VERSION as LAYOUT_VERSION_CURRENT } from './layout.js'
import { clampInt, escapeLike, hasCjk, nowIso, randomHex, safeFileStem } from './paths.js'
import { assessTextQuality, looksLikeCipherText, repairCaesarShift } from './text-quality.js'

/** Contract error codes; the HTTP layer maps them to status codes. */
export class DomainError extends Error {
  /**
   * @param {string} code not_found|invalid|conflict|unavailable|degraded|internal.
   * @param {string} message human-readable diagnostic.
   * @param {object} [meta] structured context returned to the Client.
   */
  constructor(code, message, meta = {}) {
    super(message)
    this.name = 'DomainError'
    this.code = code
    this.meta = meta
  }
}

/** Wrap a missing-object condition in the contract error shape. */
export function notFound(message, meta = {}) {
  return new DomainError('not_found', message, meta)
}

/** Throw an invalid-argument error. */
export function invalid(message, meta = {}) {
  return new DomainError('invalid', message, meta)
}

/* ------------------------------------------------------------------ */
/* Row mapping                                                          */
/* ------------------------------------------------------------------ */

/** Parse a JSON column, returning a fallback on corruption. */
function parseJson(value, fallback) {
  if (typeof value !== 'string' || value === '') return fallback
  try {
    return JSON.parse(value)
  } catch {
    return fallback
  }
}

/** Coerce a SQLite integer/boolean column to a JS boolean. */
function toBoolean(value) {
  return value === 1 || value === true
}

/** Normalize one stored author list. */
function parseAuthors(json) {
  const parsed = parseJson(json, [])
  if (!Array.isArray(parsed)) return []
  return parsed
    .map((author) => {
      if (author === null || typeof author !== 'object') return null
      if (typeof author.literal === 'string' && author.literal.trim() !== '') return { literal: author.literal.trim() }
      const given = typeof author.given === 'string' ? author.given.trim() : ''
      const family = typeof author.family === 'string' ? author.family.trim() : ''
      if (given === '' && family === '') return null
      return { ...(given === '' ? {} : { given }), ...(family === '' ? {} : { family }) }
    })
    .filter((author) => author !== null)
}

/** Human-readable author line, used by citations and the FTS row. */
function authorLine(authors) {
  return authors.map((author) => author.literal ?? [author.given, author.family].filter(Boolean).join(' ')).join(', ')
}

/** BibTeX `and`-joined author list: `Family, Given and Family, Given`. */
function bibtexAuthors(authors) {
  return authors
    .map((author) => {
      if (author.literal !== undefined) return `{${author.literal}}`
      if (author.family && author.given) return `${author.family}, ${author.given}`
      return author.family ?? author.given ?? ''
    })
    .filter((value) => value !== '')
    .join(' and ')
}

/** A stable, readable citation key: `familyyyyyword`. */
function bibtexKey(row) {
  const authors = parseAuthors(row.authors_json)
  const first = authors.find((author) => author.family ?? author.literal)
  const name = (first?.family ?? first?.literal ?? 'anon')
    .normalize('NFKD')
    .replace(/[^A-Za-z0-9]/g, '')
    .toLowerCase()
  const year = Number.isFinite(Number(row.year)) ? String(row.year) : ''
  const word = String(row.title ?? '')
    .normalize('NFKD')
    .replace(/[^A-Za-z0-9\s]/g, ' ')
    .trim()
    .split(/\s+/)
    .find((token) => token.length > 3 && !['with', 'from', 'using', 'their', 'this', 'that'].includes(token.toLowerCase()))
  const tail = (word ?? 'paper').toLowerCase()
  return `${name || 'anon'}${year}${tail}`.replace(/[^A-Za-z0-9]/g, '') || row.id.replace(/^ph-/, 'ph')
}

/**
 * One BibTeX entry for a paper row (v0.3 citation.format reuses export.bibtex).
 * @param {object} row paper row.
 * @returns {string} BibTeX entry text.
 */
function bibtexEntry(row) {
  const authors = bibtexAuthors(parseAuthors(row.authors_json))
  const fields = [
    ['title', row.title],
    ['author', authors],
    ['year', row.year],
    ['journal', row.container_title ?? row.venue],
    ['doi', row.doi],
    ['url', row.doi === null || row.doi === undefined ? null : `https://doi.org/${row.doi}`],
    ['volume', row.volume],
    ['number', row.issue],
    ['pages', row.pages],
    ['eprint', row.arxiv_id],
    ['archivePrefix', row.arxiv_id === null || row.arxiv_id === undefined ? null : 'arXiv'],
    ['license', row.license],
  ]
  const body = fields
    .filter(([, value]) => value !== null && value !== undefined && value !== '')
    .map(([name, value]) => `  ${name} = {${String(value).replace(/[{}]/g, '')}}`)
    .join(',\n')
  return `@article{${bibtexKey(row)},\n${body}\n}`
}

/** One CSL-JSON item for a paper row. */
function cslItem(row) {
  const authors = parseAuthors(row.authors_json).map((author) =>
    author.literal === undefined ? { given: author.given ?? '', family: author.family ?? '' } : { literal: author.literal },
  )
  const dateParts = Number.isFinite(Number(row.year)) ? [[Number(row.year)]] : undefined
  return {
    id: row.id,
    type: 'article-journal',
    title: row.title,
    ...(authors.length === 0 ? {} : { author: authors }),
    ...(dateParts === undefined ? {} : { issued: { 'date-parts': dateParts } }),
    ...(row.container_title === null || row.container_title === undefined ? {} : { 'container-title': row.container_title }),
    ...(row.venue === null || row.venue === undefined ? {} : { 'collection-title': row.venue }),
    ...(row.doi === null || row.doi === undefined ? {} : { DOI: row.doi }),
    ...(row.volume === null || row.volume === undefined ? {} : { volume: String(row.volume) }),
    ...(row.issue === null || row.issue === undefined ? {} : { issue: String(row.issue) }),
    ...(row.pages === null || row.pages === undefined ? {} : { page: String(row.pages) }),
    ...(row.title_zh === null || row.title_zh === undefined ? {} : { 'title-zh': row.title_zh }),
  }
}

/** One RIS entry for a paper row. */
function risEntry(row) {
  const authors = parseAuthors(row.authors_json)
  const lines = ['TY  - JOUR', `TI  - ${row.title}`]
  for (const author of authors) {
    const name = author.literal ?? [author.family, author.given].filter(Boolean).join(', ')
    if (name !== '') lines.push(`AU  - ${name}`)
  }
  if (Number.isFinite(Number(row.year))) lines.push(`PY  - ${row.year}`)
  const journal = row.container_title ?? row.venue
  if (journal !== null && journal !== undefined && journal !== '') lines.push(`JO  - ${journal}`)
  if (row.volume !== null && row.volume !== undefined) lines.push(`VL  - ${row.volume}`)
  if (row.issue !== null && row.issue !== undefined) lines.push(`IS  - ${row.issue}`)
  if (row.pages !== null && row.pages !== undefined) lines.push(`SP  - ${row.pages}`)
  if (row.doi !== null && row.doi !== undefined) lines.push(`DO  - ${row.doi}`)
  lines.push(`ID  - ${bibtexKey(row)}`, 'ER  - ')
  return lines.join('\n')
}

/** One APA 7 reference for a paper row. */
function apaEntry(row) {
  const authors = parseAuthors(row.authors_json)
  const names = authors.map((author) => {
    if (author.literal !== undefined) return author.literal
    const initials = String(author.given ?? '')
      .split(/\s+/)
      .filter((part) => part !== '')
      .map((part) => `${part[0].toUpperCase()}.`)
      .join(' ')
    return `${author.family ?? ''}${initials === '' ? '' : `, ${initials}`}`.trim()
  })
  const authorText = names.length === 0 ? '' : names.length === 1 ? names[0] : names.length === 2 ? `${names[0]}, & ${names[1]}` : `${names.slice(0, -1).join(', ')}, & ${names[names.length - 1]}`
  const year = Number.isFinite(Number(row.year)) ? `(${row.year})` : '(n.d.)'
  const journal = row.container_title ?? row.venue
  const parts = [authorText === '' ? '' : `${authorText}.`, year, `${row.title}.`]
  if (journal !== null && journal !== undefined && journal !== '') {
    const volume = row.volume === null || row.volume === undefined ? '' : `*${row.volume}*`
    const issue = row.issue === null || row.issue === undefined ? '' : `(${row.issue})`
    const pages = row.pages === null || row.pages === undefined ? '' : `, ${row.pages}`
    parts.push(`${journal}, ${volume}${issue}${pages}.`)
  }
  if (row.doi !== null && row.doi !== undefined) parts.push(`https://doi.org/${row.doi}`)
  return parts.filter((part) => part !== '').join(' ')
}

/** One GB/T 7714-2015 reference for a paper row. */
function gbt7714Entry(row) {
  const authors = parseAuthors(row.authors_json)
  const names = authors.map((author) => {
    if (author.literal !== undefined) return author.literal
    return `${String(author.family ?? '').toUpperCase()} ${String(author.given ?? '')
      .split(/\s+/)
      .filter((part) => part !== '')
      .map((part) => part[0].toUpperCase())
      .join('')}`.trim()
  })
  const authorText = names.slice(0, 3).join(', ')
  const year = Number.isFinite(Number(row.year)) ? String(row.year) : ''
  const journal = row.container_title ?? row.venue
  const volume = row.volume === null || row.volume === undefined ? '' : `, ${row.volume}`
  const issue = row.issue === null || row.issue === undefined ? '' : `(${row.issue})`
  const pages = row.pages === null || row.pages === undefined ? '' : `: ${row.pages}`
  return `${authorText}. ${row.title}[J]. ${journal ?? ''}${year === '' ? '' : `, ${year}`}${volume}${issue}${pages}.`
}

/** Normalize one DOI value (strip URL prefixes, trim, lowercase). */
function normalizeDoiValue(value) {
  if (typeof value !== 'string') return null
  const cleaned = value.trim().replace(/^https?:\/\/(?:dx\.)?doi\.org\//i, '').replace(/^doi:\s*/i, '').trim()
  return cleaned === '' ? null : cleaned
}

/** Stable journal cache key from a venue name: lowercase alphanumeric slug. */
function journalKeyFor(name) {
  if (typeof name !== 'string') return null
  const slug = name
    .normalize('NFKD')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
  return slug === '' ? null : slug.slice(0, 96)
}

/** Normalize a keyword list: trimmed unique strings, max 40 entries. */
function normalizeKeywords(value) {
  if (!Array.isArray(value)) return []
  const out = []
  for (const entry of value) {
    if (typeof entry !== 'string') continue
    const text = entry.trim().slice(0, 80)
    if (text !== '' && !out.includes(text)) out.push(text)
    if (out.length >= 40) break
  }
  return out
}

/** Default processing state for a paper that has not been ingested yet. */
const PENDING_PROCESSING = { state: 'pending', channels: { text: 'pending', figures: 'pending', index: 'pending' } }

/** Normalize a stored processing JSON document. */
function parseProcessing(json) {
  const parsed = parseJson(json, null)
  if (parsed === null || typeof parsed !== 'object') return { ...PENDING_PROCESSING }
  return {
    state: typeof parsed.state === 'string' ? parsed.state : 'pending',
    channels: {
      text: parsed.channels?.text ?? 'pending',
      figures: parsed.channels?.figures ?? 'pending',
      index: parsed.channels?.index ?? 'pending',
    },
  }
}

/** Map one `papers` row (+ aggregate columns) to PaperSummary. */
function toPaperSummary(row, options = {}) {
  const authors = parseAuthors(row.authors_json)
  const state = row.state === 'trash' ? 'trash' : 'active'
  const pageCount = Number.isFinite(row.page_count) && row.page_count !== null ? Number(row.page_count) : null
  return {
    id: row.id,
    title: row.title,
    titleZh: row.title_zh ?? null,
    displayTitle: row.display_title ?? null,
    authors,
    year: row.year === null || row.year === undefined ? null : Number(row.year),
    venue: row.venue ?? null,
    field: row.field ?? null,
    fieldId: row.field_id ?? null,
    state,
    read: toBoolean(row.read),
    annotationCount: Number(row.annotation_count ?? 0),
    figureCount: Number(row.figure_count ?? 0),
    pageCount,
    sha256: row.sha256 ?? null,
    sourceVersion: row.source_version ?? null,
    license: row.license ?? null,
    addedAt: row.added_at,
    updatedAt: row.updated_at,
    thumbnailUrl: `/pappers-hall/thumb/${row.id}.png`,
    processing: parseProcessing(row.processing_json),
    revision: Number(row.revision ?? 0),
    // v0.2: tags always present so the list table can render them.
    tags: Array.isArray(options.tags) ? options.tags : [],
    // v0.5: single favorite flag (Zotero-style star view).
    favorite: toBoolean(row.favorite),
    // v0.3: list cards show reading state, citations and journal metrics. The
    // citation value falls back to the automatic metrics payload so sort=citations
    // and library.get.metrics cannot disagree when a legacy row has a NULL column.
    readingProgress: Number(row.reading_progress ?? 0),
    citationCount:
      row.citation_count === null || row.citation_count === undefined
        ? (() => {
            const auto = parseJson(row.metrics_json, {})
            return Number.isFinite(Number(auto.citedByCount)) ? Number(auto.citedByCount) : null
          })()
        : Number(row.citation_count),
    impactFactor: row.journal_impact_factor === null || row.journal_impact_factor === undefined ? null : Number(row.journal_impact_factor),
    impactFactorYear:
      row.journal_impact_factor_year === null || row.journal_impact_factor_year === undefined ? null : Number(row.journal_impact_factor_year),
    quartile: row.journal_quartile ?? null,
    ...(options.includeDeletedAt ? { deletedAt: row.deleted_at ?? null, epoch: Number(row.epoch ?? 0) } : {}),
    ...(row.structure_state === undefined ? {} : { structureState: row.structure_state }),
  }
}

/** Columns `papers` reads always select, with aggregate counts kept in one query. */
const PAPER_COLUMNS = `
  p.*,
  (SELECT COUNT(*) FROM figures f WHERE f.paper_id = p.id) AS figure_count,
  (SELECT COUNT(*) FROM annotations a WHERE a.paper_id = p.id AND a.state = 'active') AS annotation_count,
  (SELECT v.page_count FROM paper_versions v WHERE v.id = p.current_version_id) AS page_count
`

/** Map one `figures` row to FigureRef. */
function toFigureRef(row) {
  const bbox = parseJson(row.bbox_json, null)
  const hasImage = typeof row.file_name === 'string' && row.file_name !== ''
  return {
    id: row.id,
    paperId: row.paper_id,
    label: row.label ?? null,
    caption: row.caption ?? null,
    page: Number(row.page),
    width: row.width === null || row.width === undefined ? null : Number(row.width),
    height: row.height === null || row.height === undefined ? null : Number(row.height),
    imageUrl: hasImage ? `/pappers-hall/figure/${row.id}.png?v=${encodeURIComponent(row.dhash || row.id)}` : null,
    thumbnailUrl: hasImage ? `/pappers-hall/figure/${row.id}.png?width=320&v=${encodeURIComponent(row.dhash || row.id)}` : null,
    dhash: row.dhash ?? null,
    source: row.source ?? 'caption',
    ...(bbox === null ? {} : { bbox }),
    ...(row.status === 'ready' ? {} : { status: row.status }),
  }
}

/**
 * Map one `annotations` row to the v0.2 Annotation shape.
 *
 * The v0.1 fields (`rect`, `text`) stay present for old Clients, while `kind`,
 * `rects` (normalized 0–1) and `comment` are the v0.2 contract fields.
 */
function toAnnotation(row) {
  const rects = parseJson(row.rects_json, undefined)
  const legacyRect = parseJson(row.rect_json, null)
  return {
    id: row.id,
    paperId: row.paper_id,
    versionId: row.version_id ?? null,
    page: Number(row.page),
    kind: typeof row.kind === 'string' && row.kind !== '' ? row.kind : legacyRect === null ? 'note' : 'area',
    rects: Array.isArray(rects) ? rects : [],
    quote: row.quote ?? null,
    comment: row.comment ?? null,
    text: row.text ?? '',
    rect: legacyRect,
    color: row.color ?? null,
    origin: row.origin,
    createdAt: row.created_at,
    updatedAt: row.updated_at ?? row.created_at,
    revision: Number(row.revision ?? 0),
    state: row.state === 'trash' ? 'trash' : 'active',
  }
}

/** Map one `notes` row to Note. */
function toNote(row) {
  const refs = parseJson(row.source_refs_json, [])
  return {
    id: row.id,
    paperId: row.paper_id ?? null,
    title: row.title ?? null,
    text: row.text,
    origin: row.origin,
    sourceRefs: Array.isArray(refs) ? refs : [],
    createdAt: row.created_at,
    state: row.state === 'trash' ? 'trash' : 'active',
    revision: Number(row.revision ?? 0),
  }
}

/** Valid v0.2 annotation kinds and colors. */
const ANNOTATION_KINDS = new Set(['highlight', 'area', 'note'])
const ANNOTATION_COLORS = new Set(['yellow', 'green', 'blue', 'red', 'purple'])
const LEGACY_COLOR_MAP = {
  '#ffd400': 'yellow',
  '#ffeb3b': 'yellow',
  '#a5d6a7': 'green',
  '#90caf9': 'blue',
  '#ef9a9a': 'red',
  '#ce93d8': 'purple',
}

/**
 * Validate and normalize an annotation rect list. Coordinates are page-relative
 * 0–1 so zoom and render resolution never corrupt an annotation.
 */
function normalizeRects(rects) {
  if (rects === undefined || rects === null) return []
  if (!Array.isArray(rects)) throw invalid('rects must be an array')
  if (rects.length > 40) throw invalid('at most 40 rects are allowed per annotation')
  return rects.map((rect, index) => {
    if (rect === null || typeof rect !== 'object') throw invalid(`rects[${index}] must be an object`)
    const values = ['x', 'y', 'w', 'h'].map((key) => Number(rect[key]))
    if (!values.every(Number.isFinite)) throw invalid(`rects[${index}] needs finite x,y,w,h`)
    const [x, y, w, h] = values
    if (w <= 0 || h <= 0) throw invalid(`rects[${index}] must have positive w and h`)
    if (x < -0.01 || y < -0.01 || x > 1.01 || y > 1.01 || w > 1.01 || h > 1.01) {
      throw invalid(`rects[${index}] coordinates must be page-relative 0..1`)
    }
    const clamp01 = (value) => Math.min(1, Math.max(0, value))
    return {
      x: Math.round(clamp01(x) * 10000) / 10000,
      y: Math.round(clamp01(y) * 10000) / 10000,
      w: Math.round(Math.min(clamp01(w), 1 - clamp01(x)) * 10000) / 10000,
      h: Math.round(Math.min(clamp01(h), 1 - clamp01(y)) * 10000) / 10000,
    }
  })
}

/** Normalize one annotation color (v0.2 names or legacy hex). */
function normalizeColor(color) {
  if (typeof color !== 'string' || color.trim() === '') return 'yellow'
  const value = color.trim().toLowerCase()
  if (ANNOTATION_COLORS.has(value)) return value
  if (LEGACY_COLOR_MAP[value] !== undefined) return LEGACY_COLOR_MAP[value]
  return 'yellow'
}

/** Infer the annotation kind for a v0.1 Client that sends only `rect`/`text`. */
function inferAnnotationKind(params) {
  if (params.rect !== undefined && params.rect !== null) return 'area'
  if (Array.isArray(params.rects) && params.rects.length > 0) return 'highlight'
  return 'note'
}

/** Validate one legacy v0.1 `rect` ({x,y,w,h} finite numbers) or null. */
function normalizeLegacyRect(rect) {
  if (rect === undefined || rect === null) return null
  if (typeof rect !== 'object' || ['x', 'y', 'w', 'h'].some((key) => !Number.isFinite(Number(rect[key])))) {
    throw invalid('rect must be {x,y,w,h} with finite numbers')
  }
  if (Number(rect.w) <= 0 || Number(rect.h) <= 0) throw invalid('rect must have positive w and h')
  return { x: Number(rect.x), y: Number(rect.y), w: Number(rect.w), h: Number(rect.h) }
}

/** Map one `jobs` row to Job. */
export function toJob(row) {
  const done = Number(row.progress_done ?? 0)
  const total = Number(row.progress_total ?? 0)
  const job = {
    id: row.id,
    kind: row.kind,
    state: row.state,
    attempts: Number(row.attempts ?? 0),
    progress: { done, total, unit: row.progress_unit ?? 'items' },
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    idempotencyKey: row.idempotency_key ?? null,
  }
  if (typeof row.error_message === 'string' && row.error_message !== '') job.error = row.error_message
  if (typeof row.lease_until === 'string') job.leaseUntil = row.lease_until
  if (typeof row.next_run_at === 'string') job.nextRunAt = row.next_run_at
  if (row.cancel_requested === 1) job.cancelRequested = true
  return job
}

/* ------------------------------------------------------------------ */
/* Store factory                                                        */
/* ------------------------------------------------------------------ */

/**
 * Create the domain store bound to one open database.
 *
 * Search, ingestion and the job queue are attached after construction through
 * {@link attach} so that the modules can be wired in dependency order by
 * `applyHost` (and replaced independently in tests).
 *
 * @param {object} options store options.
 * @param {import('node:sqlite').DatabaseSync} options.db open database.
 * @param {object} options.layout owned path table.
 * @param {boolean} options.fts5 whether derived FTS tables are usable.
 * @param {object} [options.config] resolved plugin config.
 * @param {object} [options.logger] logger.
 * @param {object} [options.manifest] bibliography manifest index (may be empty).
 * @param {object} [options.ctx] Cordis context for optional services (translator).
 * @param {object} [options.identity] plugin identity facts for status/diagnostics.
 * @returns {object} store with the domain API.
 */
export function createStore({ db, layout, fts5, config = {}, logger, manifest = emptyManifest(), ctx, identity = {} }) {
  const attached = {
    search: null,
    ingest: null,
    queue: null,
    pdf: null,
    ai: null,
    translate: null,
    embedding: null,
    classify: null,
    settings: null,
    ocr: null,
    models: null,
    notes: null,
  }

  /** Facts surfaced by `diagnostics.agent` (set by applyHost after registration). */
  let agentFacts = { tools: [], promptSection: false }

  /** Record one event row (best effort; never breaks a business write). */
  function recordEvent(type, paperId, payload) {
    try {
      db.prepare('INSERT INTO events(type, paper_id, payload_json, created_at) VALUES (?, ?, ?, ?)').run(
        type,
        paperId ?? null,
        payload === undefined ? null : JSON.stringify(payload),
        nowIso(),
      )
    } catch (error) {
      logger?.debug?.(`pappers-hall: event write failed: ${String(error?.message ?? error)}`)
    }
  }

  /**
   * Operation-id idempotency guard: the first successful result is stored in
   * `settings`, so a retried Client write returns the same answer even across a
   * plugin reload. The database outlives the store instance.
   */
  function withOperation(method, operationId, fn) {
    if (typeof operationId !== 'string' || operationId.trim() === '') return fn()
    const key = `operation:${method}:${operationId.trim()}`
    const existing = readSetting(db, key)
    if (existing !== undefined) return existing
    const result = fn()
    writeSetting(db, key, result)
    return result
  }

  /**
   * Append one reversible operation to the journal.
   * @param {{kind:string, summary:string, target?:object, undo?:object}} entry operation facts.
   * @returns {string} operation id.
   */
  function recordOperation({ kind, summary, target = {}, undo = {} }) {
    const id = `op-${randomHex(6)}`
    db.prepare(
      'INSERT INTO operations(id, kind, summary, target_json, undo_json, created_at, undone) VALUES (?, ?, ?, ?, ?, ?, 0)',
    ).run(id, kind, summary, JSON.stringify(target), JSON.stringify(undo), nowIso())
    return id
  }

  /** Current tag names of one paper (undo snapshot). */
  function tagNamesSnapshot(paperId) {
    return db.prepare('SELECT t.name FROM tags t JOIN paper_tags pt ON pt.tag_id = t.id WHERE pt.paper_id = ? ORDER BY t.name').all(paperId).map((row) => row.name)
  }

  /** Restore one paper's exact tag set (undo helper). */
  function restoreTagSet(paperId, names) {
    const now = nowIso()
    db.prepare('DELETE FROM paper_tags WHERE paper_id = ?').run(paperId)
    for (const name of names) {
      db.prepare('INSERT OR IGNORE INTO tags(name, created_at) VALUES (?, ?)').run(name, now)
      const tag = db.prepare('SELECT id FROM tags WHERE name = ?').get(name)
      if (tag !== undefined) db.prepare('INSERT OR IGNORE INTO paper_tags(paper_id, tag_id, created_at) VALUES (?, ?, ?)').run(paperId, tag.id, now)
    }
  }

  /**
   * Execute the inverse of one journal entry. Kept in one place so the undo
   * surface stays auditable; each branch is the exact inverse of the write that
   * recorded it. Purge has no inverse.
   * @param {object} entry operations row.
   * @returns {{status:string, reason?:string, restored?:object}} undo outcome.
   */
  function applyInverse(entry) {
    const undo = parseJson(entry.undo_json, {})
    const kind = entry.kind
    if (kind === 'library.purge') return { status: 'not_undoable', reason: 'purge permanently removes files and cannot be undone' }
    // v0.17 notes workbench entries are inverted by the notes service, which owns
    // the note tables. The journal row and the transaction stay shared.
    if (kind.startsWith('note.')) {
      return attached.notes !== null && attached.notes !== undefined && typeof attached.notes.applyUndo === 'function'
        ? attached.notes.applyUndo(kind, undo)
        : { status: 'not_undoable', reason: 'notes service is not attached' }
    }
    switch (kind) {
      case 'annotation.create': {
        const row = db.prepare('SELECT * FROM annotations WHERE id = ?').get(undo.annotationId)
        if (row === undefined) return { status: 'not_undoable', reason: 'annotation no longer exists' }
        db.prepare("UPDATE annotations SET state = 'trash', epoch = epoch + 1, updated_at = ? WHERE id = ?").run(nowIso(), row.id)
        attached.search?.removeAnnotationIndex?.(row.id)
        return { status: 'undone', restored: { annotationId: row.id, state: 'trash' } }
      }
      case 'annotation.update': {
        const row = db.prepare('SELECT * FROM annotations WHERE id = ?').get(undo.annotationId)
        if (row === undefined) return { status: 'not_undoable', reason: 'annotation no longer exists' }
        const values = undo.before ?? {}
        const columns = Object.keys(values)
        if (columns.length === 0) return { status: 'undone', restored: { annotationId: row.id } }
        const assignments = columns.map((column) => `${column} = ?`)
        db.prepare(`UPDATE annotations SET ${[...assignments, 'updated_at = ?', 'revision = revision + 1'].join(', ')} WHERE id = ?`).run(
          ...Object.values(values),
          nowIso(),
          row.id,
        )
        attached.search?.indexAnnotation?.(row.id)
        return { status: 'undone', restored: { annotationId: row.id, fields: columns } }
      }
      case 'annotation.delete': {
        const row = db.prepare('SELECT * FROM annotations WHERE id = ?').get(undo.annotationId)
        if (row === undefined) return { status: 'not_undoable', reason: 'annotation no longer exists' }
        db.prepare("UPDATE annotations SET state = 'active', epoch = epoch + 1, updated_at = ? WHERE id = ?").run(nowIso(), row.id)
        attached.search?.indexAnnotation?.(row.id)
        return { status: 'undone', restored: { annotationId: row.id, state: 'active' } }
      }
      case 'library.setRead': {
        const now = nowIso()
        for (const item of undo.before ?? []) {
          db.prepare('UPDATE papers SET read = ?, updated_at = ?, revision = revision + 1 WHERE id = ?').run(item.read, now, item.id)
        }
        return { status: 'undone', restored: { read: (undo.before ?? []).map((item) => item.id) } }
      }
      case 'library.update': {
        const values = undo.before ?? {}
        const columns = Object.keys(values)
        const now = nowIso()
        if (columns.length > 0) {
          const assignments = columns.map((column) => `${column} = ?`)
          db.prepare(`UPDATE papers SET ${[...assignments, 'updated_at = ?', 'revision = revision + 1'].join(', ')} WHERE id = ?`).run(
            ...Object.values(values),
            now,
            undo.paperId,
          )
        }
        if (Array.isArray(undo.tags)) restoreTagSet(undo.paperId, undo.tags)
        reindexPaper(undo.paperId)
        return { status: 'undone', restored: { id: undo.paperId, fields: columns, tags: undo.tags ?? [] } }
      }
      case 'library.collections.assign': {
        const now = nowIso()
        for (const paperId of undo.paperIds ?? []) {
          if (undo.add === true) {
            db.prepare('DELETE FROM paper_collections WHERE collection_id = ? AND paper_id = ?').run(undo.collectionId, paperId)
          } else {
            db.prepare('INSERT OR IGNORE INTO paper_collections(collection_id, paper_id, created_at) VALUES (?, ?, ?)').run(undo.collectionId, paperId, now)
          }
        }
        return { status: 'undone', restored: { collectionId: undo.collectionId, paperIds: undo.paperIds ?? [] } }
      }
      case 'library.delete': {
        const now = nowIso()
        for (const id of undo.ids ?? []) {
          db.prepare("UPDATE papers SET state = 'active', epoch = epoch + 1, revision = revision + 1, deleted_at = NULL, updated_at = ? WHERE id = ?").run(now, id)
        }
        return { status: 'undone', restored: { ids: undo.ids ?? [] } }
      }
      case 'library.restore': {
        const now = nowIso()
        for (const id of undo.ids ?? []) {
          db.prepare("UPDATE papers SET state = 'trash', epoch = epoch + 1, revision = revision + 1, deleted_at = ?, updated_at = ? WHERE id = ?").run(now, now, id)
        }
        return { status: 'undone', restored: { ids: undo.ids ?? [] } }
      }
      case 'library.merge': {
        const now = nowIso()
        for (const moved of undo.movedSources ?? []) {
          db.prepare('UPDATE sources SET paper_id = ? WHERE id = ?').run(moved.fromPaperId, moved.sourceId)
        }
        for (const removed of undo.removedSources ?? []) {
          db.prepare('INSERT OR IGNORE INTO sources(paper_id, kind, url, retrieved_at) VALUES (?, ?, ?, ?)').run(
            removed.paperId,
            removed.kind,
            removed.url,
            removed.retrievedAt ?? null,
          )
        }
        for (const moved of undo.movedAnnotations ?? []) {
          db.prepare('UPDATE annotations SET paper_id = ?, updated_at = ? WHERE id = ?').run(moved.fromPaperId, now, moved.annotationId)
        }
        // v0.17: put the notes workbench paper links back on the duplicate.
        for (const moved of undo.movedNoteLinks ?? []) {
          if (moved.hadPrimary !== true) {
            db.prepare('DELETE FROM note_paper_links WHERE note_id = ? AND paper_id = ?').run(moved.noteId, undo.primaryId)
          }
          db.prepare(
            'INSERT OR IGNORE INTO note_paper_links(note_id, paper_id, anchor_json, created_at) VALUES (?, ?, ?, ?)',
          ).run(moved.noteId, moved.fromPaperId, moved.anchorJson ?? null, moved.createdAt ?? now)
        }
        for (const link of undo.addedTags ?? []) {
          db.prepare('DELETE FROM paper_tags WHERE paper_id = ? AND tag_id = (SELECT id FROM tags WHERE name = ?)').run(link.paperId, link.name)
        }
        for (const link of undo.addedCollections ?? []) {
          db.prepare('DELETE FROM paper_collections WHERE collection_id = ? AND paper_id = ?').run(link.collectionId, link.paperId)
        }
        for (const item of undo.readBefore ?? []) {
          db.prepare('UPDATE papers SET read = ? WHERE id = ?').run(item.read, item.id)
        }
        for (const id of undo.trashed ?? []) {
          db.prepare("UPDATE papers SET state = 'active', epoch = epoch + 1, revision = revision + 1, deleted_at = NULL, updated_at = ? WHERE id = ?").run(now, id)
        }
        for (const id of [undo.primaryId, ...(undo.trashed ?? [])]) {
          if (typeof id === 'string') {
            reindexPaper(id)
            attached.search?.indexPages?.(id)
            attached.search?.indexFigures?.(id)
          }
        }
        return {
          status: 'undone',
          restored: { primaryId: undo.primaryId, annotations: (undo.movedAnnotations ?? []).length, trashed: undo.trashed ?? [] },
        }
      }
      case 'library.collections.create': {
        const row = db.prepare('SELECT * FROM collections WHERE id = ?').get(undo.collectionId)
        if (row === undefined) return { status: 'not_undoable', reason: 'folder no longer exists' }
        // operations.undo already runs inside one transaction; do not nest.
        db.prepare('DELETE FROM paper_collections WHERE collection_id = ?').run(row.id)
        db.prepare('DELETE FROM collections WHERE id = ?').run(row.id)
        return { status: 'undone', restored: { collectionId: row.id } }
      }
      case 'library.collections.update': {
        const row = db.prepare('SELECT * FROM collections WHERE id = ?').get(undo.collectionId)
        if (row === undefined) return { status: 'not_undoable', reason: 'folder no longer exists' }
        const before = undo.before ?? {}
        const columns = Object.keys(before)
        if (columns.length === 0) return { status: 'undone', restored: { collectionId: row.id } }
        db.prepare(`UPDATE collections SET ${[...columns.map((column) => `${column} = ?`), 'updated_at = ?'].join(', ')} WHERE id = ?`).run(
          ...Object.values(before),
          nowIso(),
          row.id,
        )
        return { status: 'undone', restored: { collectionId: row.id, fields: columns } }
      }
      case 'library.collections.delete': {
        const before = undo.before ?? {}
        if (typeof before.id !== 'string') return { status: 'not_undoable', reason: 'folder snapshot missing' }
        const now = nowIso()
        // operations.undo already runs inside one transaction; do not nest.
        db.prepare(
          'INSERT OR REPLACE INTO collections(id, name, color, sort_order, kind, field_key, parent_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
        ).run(
          before.id,
          before.name,
          before.color ?? null,
          Number(before.sort_order ?? 0),
          before.kind ?? 'folder',
          before.field_key ?? null,
          before.parent_id ?? null,
          before.created_at ?? now,
          now,
        )
        for (const link of undo.memberships ?? []) {
          db.prepare('INSERT OR IGNORE INTO paper_collections(collection_id, paper_id, created_at) VALUES (?, ?, ?)').run(before.id, link.paperId, now)
        }
        for (const childId of undo.children ?? []) {
          db.prepare('UPDATE collections SET parent_id = ? WHERE id = ?').run(before.id, childId)
        }
        return { status: 'undone', restored: { collectionId: before.id, memberships: (undo.memberships ?? []).length, children: undo.children ?? [] } }
      }
      case 'library.setFavorite': {
        const now = nowIso()
        for (const item of undo.before ?? []) {
          db.prepare('UPDATE papers SET favorite = ?, updated_at = ?, revision = revision + 1 WHERE id = ?').run(item.favorite, now, item.id)
        }
        return { status: 'undone', restored: { ids: (undo.before ?? []).map((item) => item.id) } }
      }
      case 'library.classify.apply': {
        // Undo one automatic classification: remove the memberships we added
        // (only those that did not exist before) and any folders we created.
        for (const assignment of undo.assignments ?? []) {
          if (assignment.existed === true) continue
          db.prepare('DELETE FROM paper_collections WHERE collection_id = ? AND paper_id = ?').run(assignment.collectionId, assignment.paperId)
        }
        for (const folderId of undo.createdFolders ?? []) {
          db.prepare('DELETE FROM paper_collections WHERE collection_id = ?').run(folderId)
          db.prepare('DELETE FROM collections WHERE id = ?').run(folderId)
        }
        return { status: 'undone', restored: { assignments: (undo.assignments ?? []).length, createdFolders: (undo.createdFolders ?? []).length } }
      }
      case 'library.merge.primaryOnly':
        return { status: 'undone', restored: { primaryId: undo.primaryId } }
      default:
        return { status: 'not_undoable', reason: `operation kind ${kind} has no inverse` }
    }
  }

  /** Journal snapshot of the columns a `library.update` patch can touch. */
  function updateUndoSnapshot(row, patch) {
    const wanted = [
      ['title', 'title'],
      ['title_zh', 'titleZh'],
      ['title_zh_source', null],
      ['display_title', 'displayTitle'],
      ['field', 'field'],
      ['venue', 'venue'],
      ['doi', 'doi'],
      ['note', 'note'],
      ['abstract', 'abstract'],
      ['year', 'year'],
      ['authors_json', 'authors'],
      ['read', 'read'],
      ['keywords_json', 'keywords'],
      ['reading_progress', 'readingProgress'],
    ]
    const before = {}
    for (const [column, patchKey] of wanted) {
      if (patchKey === null || Object.hasOwn(patch, patchKey)) before[column] = row[column] ?? null
    }
    if (Object.hasOwn(patch, 'titleZh')) before.title_zh_source = row.title_zh_source ?? null
    return before
  }

  /** Fetch one JSON URL with a hard timeout; never throws for HTTP errors. */
  async function fetchJsonWithTimeout(url, timeoutMs) {
    const response = await fetch(url, {
      headers: { accept: 'application/json', 'user-agent': 'pappers-hall/0.3 (DSH plugin; mailto:pappers-hall@users.noreply.github.com)' },
      signal: AbortSignal.timeout(timeoutMs),
    })
    if (!response.ok) return { ok: false, status: response.status, error: `http-${response.status}` }
    return { ok: true, status: response.status, data: await response.json() }
  }

  /**
   * Refresh one paper's citation/journal metrics from OpenAlex + Crossref.
   * Never invents a JCR impact factor; OpenAlex 2yr mean citedness is stored under
   * its own field. Journal rows are cached for 7 days (source fetch only).
   * @param {string} paperId paper id.
   * @param {number} timeoutMs per-request timeout.
   * @returns {Promise<object>} per-paper refresh result.
   */
  async function refreshPaperMetrics(paperId, timeoutMs) {
    const row = requirePaperRow(paperId)
    if (row.state !== 'active') return { id: paperId, status: 'failed', reason: 'not_active' }
    const doi = normalizeDoiValue(row.doi)
    if (doi === null) return { id: paperId, status: 'failed', reason: 'no-doi' }
    const venue = row.container_title ?? row.venue
    const currentKey = row.journal_key ?? journalKeyFor(venue)
    const cachedJournal = currentKey === null ? undefined : db.prepare('SELECT * FROM papers_journal WHERE key = ?').get(currentKey)
    const cachedAuto = cachedJournal === undefined ? {} : parseJson(cachedJournal.metrics_json, {})
    const journalFresh =
      cachedJournal !== undefined &&
      typeof cachedJournal.updated_at === 'string' &&
      Date.now() - Date.parse(cachedJournal.updated_at) < METRICS_TTL_MS &&
      cachedAuto.openalexSourceId !== undefined
    const works = await fetchJsonWithTimeout(`https://api.openalex.org/works/doi:${encodeURIComponent(doi)}?mailto=pappers-hall@users.noreply.github.com`, timeoutMs)
    if (!works.ok) return { id: paperId, status: 'failed', reason: `openalex_${works.error}`, doi }
    const work = works.data ?? {}
    const sourceRaw = work.primary_location?.source?.id
    const sourceId = typeof sourceRaw === 'string' ? sourceRaw.replace(/^https?:\/\/openalex\.org\//, '') : undefined
    // Journal-level data is cached for 7 days: only refetch the source when stale.
    let sourceData
    if (!journalFresh && sourceId !== undefined) {
      const fetched = await fetchJsonWithTimeout(`https://api.openalex.org/sources/${encodeURIComponent(sourceId)}?mailto:pappers-hall@users.noreply.github.com`, timeoutMs)
      if (fetched.ok) sourceData = fetched.data ?? {}
    }
    const crossref = await fetchJsonWithTimeout(`https://api.crossref.org/works/${encodeURIComponent(doi)}`, timeoutMs)
    const crossrefMessage = crossref.ok ? crossref.data?.message ?? {} : undefined
    const summary = sourceData?.summary_stats ?? {}
    const journalName = sourceData?.display_name ?? cachedJournal?.name ?? crossrefMessage?.['container-title']?.[0] ?? venue ?? null
    const issn = sourceData?.issn_l ?? cachedJournal?.issn ?? crossrefMessage?.ISSN?.[0] ?? null
    const publisher = crossrefMessage?.publisher ?? sourceData?.host_organization_name ?? cachedJournal?.publisher ?? null
    const twoYearMeanCitedness = journalFresh
      ? (Number.isFinite(Number(cachedAuto.twoYearMeanCitedness)) ? Number(cachedAuto.twoYearMeanCitedness) : null)
      : (Number.isFinite(Number(summary['2yr_mean_citedness'])) ? Number(summary['2yr_mean_citedness']) : null)
    const hIndex = journalFresh
      ? (Number.isFinite(Number(cachedAuto.hIndex)) ? Number(cachedAuto.hIndex) : null)
      : (Number.isFinite(Number(summary.h_index)) ? Number(summary.h_index) : null)
    const i10Index = journalFresh
      ? (Number.isFinite(Number(cachedAuto.i10Index)) ? Number(cachedAuto.i10Index) : null)
      : (Number.isFinite(Number(summary.i10_index)) ? Number(summary.i10_index) : null)
    const citedByCount = Number.isFinite(Number(work.cited_by_count)) ? Number(work.cited_by_count) : null
    const citedByPercentile = Number.isFinite(Number(work.cited_by_percentile_year?.min)) ? Number(work.cited_by_percentile_year.min) : null
    const now = nowIso()
    const journalKey = journalKeyFor(journalName) ?? currentKey ?? (sourceId === undefined ? null : `openalex-${sourceId.toLowerCase()}`)
    const autoMetrics = {
      citedByCount,
      twoYearMeanCitedness,
      hIndex,
      i10Index,
      citedByPercentile,
      openalexWorkId: typeof work.id === 'string' ? work.id : null,
      openalexSourceId: sourceId ?? cachedAuto.openalexSourceId ?? null,
      source: crossref.ok ? 'openalex+crossref' : 'openalex',
      updatedAt: now,
      ...(crossref.ok ? {} : { crossrefError: crossref.error }),
    }
    const crossrefInfo = crossref.ok
      ? {
          publisher: crossrefMessage?.publisher ?? null,
          issn: crossrefMessage?.ISSN?.[0] ?? null,
          volume: crossrefMessage?.volume ?? null,
          issue: crossrefMessage?.issue ?? null,
          pages: crossrefMessage?.page ?? null,
          containerTitle: crossrefMessage?.['container-title']?.[0] ?? null,
          publishedDate:
            Array.isArray(crossrefMessage?.['published-print']?.['date-parts']?.[0]) || Array.isArray(crossrefMessage?.['published-online']?.['date-parts']?.[0])
              ? undefined
              : undefined,
        }
      : undefined
    transaction(db, () => {
      if (journalKey !== null) {
        const existing = db.prepare('SELECT * FROM papers_journal WHERE key = ?').get(journalKey)
        const manualSource = existing?.source === 'manual'
        const journalMetrics = JSON.stringify({ openalexSourceId: sourceId ?? null, twoYearMeanCitedness, hIndex, i10Index, issn, publisher, crossref: crossrefInfo ?? null })
        if (existing === undefined) {
          db.prepare(
            `INSERT INTO papers_journal(key, name, issn, publisher, impact_factor, impact_factor_year, five_year_if, quartile, source, metrics_json, updated_at)
             VALUES (?, ?, ?, ?, NULL, NULL, NULL, NULL, ?, ?, ?)`,
          ).run(journalKey, String(journalName ?? venue ?? journalKey).slice(0, 300), issn, publisher, autoMetrics.source, journalMetrics, now)
        } else if (!manualSource) {
          db.prepare(
            "UPDATE papers_journal SET name = COALESCE(?, name), issn = COALESCE(?, issn), publisher = COALESCE(?, publisher), source = ?, metrics_json = ?, updated_at = ? WHERE key = ?",
          ).run(journalName ?? null, issn, publisher, autoMetrics.source, journalMetrics, now, journalKey)
        } else {
          db.prepare('UPDATE papers_journal SET metrics_json = ?, updated_at = ? WHERE key = ?').run(journalMetrics, now, journalKey)
        }
      }
      const paperValues = {
        citation_count: citedByCount,
        citation_updated_at: now,
        metrics_json: JSON.stringify(autoMetrics),
        updated_at: now,
        revision: Number(row.revision ?? 0) + 1,
      }
      const extra = {}
      if ((row.container_title ?? row.venue ?? '') === '' && journalName !== null && journalName !== undefined) {
        extra.container_title = journalName
        extra.venue = journalName
      }
      if ((row.volume === null || row.volume === undefined) && crossrefInfo?.volume !== undefined) extra.volume = crossrefInfo.volume
      if ((row.issue === null || row.issue === undefined) && crossrefInfo?.issue !== undefined) extra.issue = crossrefInfo.issue
      if ((row.pages === null || row.pages === undefined) && crossrefInfo?.pages !== undefined) extra.pages = crossrefInfo.pages
      if (journalKey !== null) extra.journal_key = journalKey
      const values = { ...paperValues, ...extra }
      const columns = Object.keys(values)
      db.prepare(`UPDATE papers SET ${columns.map((column) => `${column} = ?`).join(', ')} WHERE id = ?`).run(...Object.values(values), paperId)
    })
    reindexPaper(paperId)
    return {
      id: paperId,
      status: 'ok',
      doi,
      source: autoMetrics.source,
      journalName,
      journalKey,
      citedByCount,
      twoYearMeanCitedness,
      hIndex,
      i10Index,
      issn,
      publisher,
      cachedJournal: journalFresh,
      crossref: crossref.ok,
    }
  }

  /** Read one paper row (whatever its state) or throw not_found. */
  function requirePaperRow(id) {
    const row = db.prepare(`SELECT ${PAPER_COLUMNS} FROM papers p WHERE p.id = ?`).get(id)
    if (row === undefined) throw notFound(`paper ${id} does not exist`, { id })
    return row
  }

  /** Read one paper row, refusing trashed papers (tool/search visibility rule). */
  function requireActivePaperRow(id) {
    const row = requirePaperRow(id)
    if (row.state !== 'active') throw notFound(`paper ${id} is not available (state=${row.state})`, { id, state: row.state })
    return row
  }

  /** Latest version row for a paper (current_version_id first, then newest). */
  function latestVersion(paperId) {
    const paper = db.prepare('SELECT current_version_id FROM papers WHERE id = ?').get(paperId)
    if (paper?.current_version_id) {
      const version = db.prepare('SELECT * FROM paper_versions WHERE id = ?').get(paper.current_version_id)
      if (version !== undefined) return version
    }
    return db.prepare('SELECT * FROM paper_versions WHERE paper_id = ? ORDER BY created_at DESC LIMIT 1').get(paperId)
  }

  /** Tags of one paper as a plain string list. */
  function tagsOf(paperId) {
    return db
      .prepare('SELECT t.name FROM tags t JOIN paper_tags pt ON pt.tag_id = t.id WHERE pt.paper_id = ? ORDER BY t.name')
      .all(paperId)
      .map((row) => row.name)
  }

  /** Tags of many papers at once (one query for a whole list page). */
  function tagsOfMany(paperIds) {
    const map = new Map()
    if (paperIds.length === 0) return map
    const placeholders = paperIds.map(() => '?').join(',')
    const rows = db
      .prepare(`SELECT pt.paper_id AS paper_id, t.name AS name FROM paper_tags pt JOIN tags t ON t.id = pt.tag_id WHERE pt.paper_id IN (${placeholders}) ORDER BY t.name`)
      .all(...paperIds)
    for (const row of rows) {
      const list = map.get(row.paper_id)
      if (list === undefined) map.set(row.paper_id, [row.name])
      else list.push(row.name)
    }
    return map
  }

  /** Folders one paper belongs to (v0.6: v0.5 field collections are ordinary folders). */
  function collectionsOf(paperId) {
    const items = db
      .prepare(
        `SELECT c.id, c.name, c.color, c.parent_id FROM paper_collections pc JOIN collections c ON c.id = pc.collection_id
         WHERE pc.paper_id = ? ORDER BY c.sort_order, c.name`,
      )
      .all(paperId)
    return items.map((row) => ({
      id: row.id,
      name: row.name,
      color: row.color ?? null,
      kind: 'custom',
      parentId: row.parent_id ?? null,
      depth: folderDepth(row.id ?? ''),
    }))
  }

  /** Notes attached to one paper. */
  function notesOf(paperId) {
    return db.prepare("SELECT * FROM notes WHERE paper_id = ? AND state = 'active' ORDER BY created_at DESC").all(paperId).map(toNote)
  }

  /** Derive available fields for PaperDetail. */
  function availableFieldsOf(row) {
    const optional = ['titleZh', 'abstract', 'doi', 'arxivId', 'containerTitle', 'publicationDate', 'volume', 'issue', 'pages', 'articleNumber', 'year', 'venue', 'license']
    const map = {
      titleZh: row.title_zh,
      abstract: row.abstract,
      doi: row.doi,
      arxivId: row.arxiv_id,
      containerTitle: row.container_title,
      publicationDate: row.publication_date,
      volume: row.volume,
      issue: row.issue,
      pages: row.pages,
      articleNumber: row.article_number,
      year: row.year,
      venue: row.venue,
      license: row.license,
    }
    return ['title', 'authors', ...optional.filter((field) => map[field] !== null && map[field] !== undefined && map[field] !== '')]
  }

  /** Build PaperDetail from one paper row. */
  /**
   * Derive an abstract from the *stored* page-1 layout without running poppler.
   *
   * Used by `library.get` so a v0.1 paper shows an abstract immediately after the
   * plugin upgrade, even before the background v0.2 re-layout backfill reaches it.
   * - A real "Abstract" heading (also letter-spaced "A BSTRACT") → source `pdf`;
   * - otherwise the largest first-page body paragraph > 400 chars → `pdf-heuristic`.
   * @param {string} paperId paper id.
   * @returns {{text:string, source:'pdf'|'pdf-heuristic'}|null} derived abstract.
   */
  const AFFILIATION_RE = /(?:@|Univers|Institut|Department|Academy|Laboratoire|College|Corresponding author|E-?mail|Company|Inc\.|Ltd\.)/i
  const BOILERPLATE_RE = /^(?:Published by|Citation:|©|This is an open access|Received:|Accepted:|Revised:|doi:|https?:\/\/|www\.)/i

  /** True when a text is a real abstract-like paragraph rather than affiliations/boilerplate. */
  function looksLikeAbstractText(value) {
    const text = String(value ?? '').replace(/\s+/g, ' ').trim()
    if (text.length < 200) return false
    if (BOILERPLATE_RE.test(text)) return false
    const head = text.slice(0, 500)
    if ((head.match(/@/g) || []).length > 0) return false
    const institutions = head.match(/(?:Univers|Institut|Department|Academy|Laboratoire|College|Corresponding author)/gi) || []
    if (institutions.length >= 2) return false
    const digits = (head.replace(/\D/g, '').length || 0) / Math.max(1, head.length)
    if (digits > 0.08) return false
    return /\b(?:we|our|this (?:paper|study|article)|here|present|propose|investigate|quantify|show|results?|studies|model|method)\b/i.test(text)
  }

  /** Strip an "Abstract" label and normalize whitespace. */
  function cleanAbstractText(value) {
    return String(value ?? '')
      .replace(/^\s*(?:a\s*b\s*s\s*t\s*r\s*a\s*c\s*t|abstract)\s*[.:]?\s*/i, '')
      .replace(/\s+/g, ' ')
      .trim()
  }

  function deriveAbstractFromStoredLayout(paperId) {
    const page = db
      .prepare("SELECT layout_json FROM paper_pages WHERE paper_id = ? AND page = 1 AND layout_json IS NOT NULL AND layout_json <> ''")
      .get(paperId)
    if (page === undefined) return null
    const layout = parseJson(page.layout_json, null)
    const blocks = Array.isArray(layout?.blocks) ? layout.blocks : []
    if (blocks.length === 0) return null
    const blockText = (block) => String(block?.text ?? '').trim()
    const letterSpaced = (text) => /^\s*a\s*b\s*s\s*t\s*r\s*a\s*c\s*t\b/i.test(text)
    let headingIndex = -1
    for (let index = 0; index < blocks.length; index += 1) {
      const text = blockText(blocks[index])
      if (/^abstract\b/i.test(text) || letterSpaced(text)) {
        headingIndex = index
        break
      }
    }
    if (headingIndex >= 0) {
      const collected = []
      let chars = 0
      // Some PDFs put the first abstract sentences in the same block as the
      // "Abstract." label (JULES-crop, Copernicus layouts). Keep that remainder.
      const headingRemainder = cleanAbstractText(blockText(blocks[headingIndex]))
      if (headingRemainder.length >= 80) {
        collected.push(headingRemainder)
        chars += headingRemainder.length
      }
      for (let index = headingIndex + 1; index < blocks.length; index += 1) {
        const block = blocks[index]
        if (block.role === 'header' || block.role === 'footer') continue
        if (block.role === 'heading') break
        const text = blockText(block)
        if (text === '') continue
        if (BOILERPLATE_RE.test(text)) continue
        collected.push(text)
        chars += text.length
        if (chars >= 1600) break
      }
      const joined = cleanAbstractText(collected.join(' '))
      if (joined.length >= 80) return { text: joined.slice(0, 1600), source: 'pdf' }
    }
    const bodyBlocks = blocks.filter((block) => block.role === 'body' && blockText(block) !== '')
    const readable = bodyBlocks
      .map(blockText)
      .filter((text) => text.length >= 250 && looksLikeAbstractText(text))
      .sort((left, right) => right.length - left.length)[0]
    if (readable !== undefined) return { text: cleanAbstractText(readable).slice(0, 1600), source: 'pdf-heuristic' }
    const single = bodyBlocks
      .map(blockText)
      .filter((text) => text.length > 400 && !BOILERPLATE_RE.test(text) && !(text.match(/@/g) || []).length)
      .sort((left, right) => right.length - left.length)[0]
    if (single !== undefined) return { text: single.slice(0, 1200), source: 'pdf-heuristic' }
    const groups = []
    let currentColumn
    let run = ''
    for (const block of bodyBlocks) {
      const column = Number(block.column ?? 0)
      if (currentColumn !== undefined && column !== currentColumn) {
        groups.push(run)
        run = ''
      }
      run = run === '' ? blockText(block) : `${run} ${blockText(block)}`
      currentColumn = column
    }
    if (run !== '') groups.push(run)
    const group = groups
      .map((text) => text.replace(/\s+/g, ' ').trim())
      .filter((text) => text.length > 400)
      .sort((left, right) => right.length - left.length)[0]
    return group === undefined ? null : { text: group.slice(0, 1200), source: 'pdf-heuristic' }
  }

  /** Latest journal metrics row for one paper (falling back to venue). */
  function journalRowFor(row) {
    const key = row.journal_key ?? journalKeyFor(row.container_title ?? row.venue)
    if (key === null) return undefined
    return db.prepare('SELECT * FROM papers_journal WHERE key = ?').get(key)
  }

  /** Journal metric freshness window: 7 days for cached sources. */
  const METRICS_TTL_MS = 7 * 24 * 60 * 60 * 1000

  /**
   * Public `library.get.metrics` payload.
   *
   * JCR impact factor is only reported when a real/manual source provides it;
   * OpenAlex's 2yr mean citedness is exposed separately and never relabelled.
   * @param {object} row papers row.
   * @returns {object} metrics payload.
   */
  function metricsPayload(row) {
    const journal = journalRowFor(row)
    const auto = parseJson(row.metrics_json, {})
    const updatedCandidates = [journal?.updated_at, row.citation_updated_at, auto.updatedAt].filter((value) => typeof value === 'string' && value !== '')
    updatedCandidates.sort()
    const updatedAt = updatedCandidates.length === 0 ? null : updatedCandidates[updatedCandidates.length - 1]
    const stale = updatedAt === null ? true : Date.now() - Date.parse(updatedAt) > METRICS_TTL_MS
    return {
      impactFactor: journal?.impact_factor ?? null,
      impactFactorYear: journal?.impact_factor_year ?? null,
      fiveYearImpactFactor: journal?.five_year_if ?? null,
      quartile: journal?.quartile ?? null,
      issn: journal?.issn ?? null,
      publisher: journal?.publisher ?? null,
      journalName: journal?.name ?? row.container_title ?? row.venue ?? null,
      citationCount:
        row.citation_count === null || row.citation_count === undefined
          ? auto.citedByCount ?? null
          : Number(row.citation_count),
      twoYearMeanCitedness: auto.twoYearMeanCitedness ?? null,
      citedByPercentile: auto.citedByPercentile ?? null,
      hIndex: auto.hIndex ?? null,
      i10Index: auto.i10Index ?? null,
      source: journal?.source ?? auto.source ?? null,
      updatedAt,
      stale,
      canRefresh: normalizeDoiValue(row.doi) !== null,
    }
  }

  /**
   * Apply manual metrics/keywords to one paper (source='manual').
   * @param {string} paperId paper id.
   * @param {object} fields impactFactor/impactFactorYear/fiveYearImpactFactor/quartile/issn/
   *   publisher/citationCount/keywords.
   * @returns {object} updated paper row.
   */
  function applyManualMetrics(paperId, fields) {
    const row = requirePaperRow(paperId)
    const venue = row.container_title ?? row.venue
    const key = row.journal_key ?? journalKeyFor(venue)
    const now = nowIso()
    const journalColumns = {
      impactFactor: 'impact_factor',
      impactFactorYear: 'impact_factor_year',
      fiveYearImpactFactor: 'five_year_if',
      quartile: 'quartile',
      issn: 'issn',
      publisher: 'publisher',
    }
    const journalValues = {}
    const paperValues = {}
    for (const [field, column] of Object.entries(journalColumns)) {
      if (!Object.hasOwn(fields, field)) continue
      const value = fields[field]
      if (value === null) journalValues[column] = null
      else if (column === 'impact_factor' || column === 'five_year_if') {
        const number = Number(value)
        if (!Number.isFinite(number) || number < 0) throw invalid(`${field} must be a non-negative number`)
        journalValues[column] = number
      } else if (column === 'impact_factor_year') {
        const year = Number(value)
        if (!Number.isInteger(year) || year < 1900 || year > 3000) throw invalid('impactFactorYear must be a year')
        journalValues[column] = year
      } else {
        journalValues[column] = String(value).trim() === '' ? null : String(value).trim()
      }
    }
    if (Object.hasOwn(fields, 'citationCount')) {
      const count = Number(fields.citationCount)
      if (fields.citationCount === null) paperValues.citation_count = null
      else if (!Number.isFinite(count) || count < 0) throw invalid('citationCount must be a non-negative number')
      else paperValues.citation_count = Math.trunc(count)
    }
    if (Object.hasOwn(fields, 'keywords')) paperValues.keywords_json = JSON.stringify(normalizeKeywords(fields.keywords))
    transaction(db, () => {
      if (Object.keys(journalValues).length > 0) {
        if (key === null) throw invalid('manual journal metrics need a venue (or a journalKey)')
        const existing = db.prepare('SELECT * FROM papers_journal WHERE key = ?').get(key)
        if (existing === undefined) {
          const columns = ['key', 'name', 'source', 'metrics_json', 'updated_at', ...Object.keys(journalValues)]
          const params = [key, String(venue ?? key).slice(0, 300), 'manual', '{}', now, ...Object.values(journalValues)]
          db.prepare(`INSERT INTO papers_journal(${columns.join(', ')}) VALUES (${columns.map(() => '?').join(', ')})`).run(...params)
        } else {
          const assignments = Object.keys(journalValues).map((column) => `${column} = ?`)
          db.prepare(`UPDATE papers_journal SET ${[...assignments, "source = 'manual'", 'updated_at = ?'].join(', ')} WHERE key = ?`).run(
            ...Object.values(journalValues),
            now,
            key,
          )
        }
        paperValues.journal_key = key
      }
      if (Object.keys(paperValues).length > 0) {
        const assignments = Object.keys(paperValues).map((column) => `${column} = ?`)
        db.prepare(`UPDATE papers SET ${[...assignments, 'updated_at = ?', 'revision = revision + 1'].join(', ')} WHERE id = ?`).run(
          ...Object.values(paperValues),
          now,
          paperId,
        )
        if (Object.hasOwn(paperValues, 'keywords_json')) reindexPaper(paperId)
      }
    })
    return requirePaperRow(paperId)
  }

  function paperDetail(row) {
    const tags = tagsOf(row.id)
    const summary = toPaperSummary(row, { includeDeletedAt: true, tags })
    const versions = db
      .prepare('SELECT * FROM paper_versions WHERE paper_id = ? ORDER BY created_at ASC')
      .all(row.id)
      .map((version) => ({
        id: version.id,
        sha256: version.sha256,
        bytes: Number(version.bytes ?? 0),
        pageCount: version.page_count === null ? null : Number(version.page_count),
        sourceVersion: version.source_version ?? null,
        createdAt: version.created_at,
      }))
    const sources = db
      .prepare('SELECT kind, url, retrieved_at FROM sources WHERE paper_id = ? ORDER BY id')
      .all(row.id)
      .map((source) => ({ kind: source.kind, url: source.url, retrievedAt: source.retrieved_at ?? null }))
    let abstractText = typeof row.abstract === 'string' && row.abstract.trim() !== '' ? row.abstract : null
    let abstractSource =
      abstractText === null ? null : (row.abstract_source ?? 'metadata')
    if (abstractText === null) {
      const derived = deriveAbstractFromStoredLayout(row.id)
      if (derived !== null) {
        abstractText = derived.text
        abstractSource = derived.source
        db.prepare('UPDATE papers SET abstract = ?, abstract_source = ?, updated_at = ? WHERE id = ?').run(
          derived.text,
          derived.source,
          nowIso(),
          row.id,
        )
      }
    }
    return {
      ...summary,
      abstract: abstractText,
      keywords: parseJson(row.keywords_json, []),
      citationKey: bibtexKey(row),
      readingProgress: Number(row.reading_progress ?? 0),
      metrics: metricsPayload(row),
      doi: row.doi ?? null,
      arxivId: row.arxiv_id ?? null,
      containerTitle: row.container_title ?? null,
      publicationDate: row.publication_date ?? null,
      volume: row.volume ?? null,
      issue: row.issue ?? null,
      pages: row.pages ?? null,
      articleNumber: row.article_number ?? null,
      sources,
      versions,
      metadataDiff: parseJson(row.metadata_diff_json, []),
      tags,
      collections: collectionsOf(row.id),
      notes: notesOf(row.id),
      abstractSource,
      fileInfo: (() => {
        const current = versions.length === 0 ? undefined : versions[versions.length - 1]
        if (current === undefined) return null
        const fileRow = db.prepare('SELECT file_path FROM paper_versions WHERE id = ?').get(current.id)
        return {
          path: fileRow?.file_path ?? null,
          bytes: current.bytes,
          sha256: current.sha256,
          pageCount: current.pageCount,
          sourceVersion: current.sourceVersion,
          license: row.license ?? null,
        }
      })(),
      availableFields: availableFieldsOf(row),
    }
  }

  /** SQL select used by the discover feed PaperTiles (paper + journal + version facts). */
  const TILE_COLUMNS = `${PAPER_COLUMNS},
    (SELECT COUNT(*) FROM paper_versions v WHERE v.paper_id = p.id) AS version_count,
    j.impact_factor AS journal_impact_factor`

  /**
   * Map one paper row to a v0.4 PaperTile (sidebar discovery cards).
   * @param {object} row paper row from TILE_COLUMNS.
   * @param {string[]} tags tag names.
   * @returns {object} PaperTile.
   */
  function toPaperTile(row, tags) {
    return {
      id: row.id,
      title: row.title,
      titleZh: row.title_zh ?? null,
      authors: parseAuthors(row.authors_json),
      year: row.year === null || row.year === undefined ? null : Number(row.year),
      venue: row.field ?? row.container_title ?? row.venue ?? null,
      tags: Array.isArray(tags) ? tags : [],
      read: toBoolean(row.read),
      readingProgress: Number(row.reading_progress ?? 0),
      annotationCount: Number(row.annotation_count ?? 0),
      figureCount: Number(row.figure_count ?? 0),
      lastReadAt: row.last_read_at ?? null,
      addedAt: row.added_at,
      citationCount:
        row.citation_count === null || row.citation_count === undefined
          ? (() => {
              const auto = parseJson(row.metrics_json, {})
              return Number.isFinite(Number(auto.citedByCount)) ? Number(auto.citedByCount) : null
            })()
          : Number(row.citation_count),
      impactFactor: row.journal_impact_factor === null || row.journal_impact_factor === undefined ? null : Number(row.journal_impact_factor),
      hasPdf: Number(row.version_count ?? 0) > 0,
    }
  }

  /** Batch-load paper tiles for the given rows (shared tag lookup). */
  function tilesFromRows(rows) {
    const tagMap = tagsOfMany(rows.map((row) => row.id))
    return rows.map((row) => toPaperTile(row, tagMap.get(row.id) ?? []))
  }

  /** Read one collection row or undefined. */
  function collectionRowById(id) {
    if (typeof id !== 'string' || id === '') return undefined
    return db.prepare('SELECT * FROM collections WHERE id = ?').get(id)
  }

  /** Depth of one folder in the tree (root folder = 0); cycle-safe. */
  function folderDepth(id) {
    let depth = 0
    let cursor = collectionRowById(id)
    const seen = new Set()
    while (cursor !== undefined && cursor.parent_id !== null && cursor.parent_id !== undefined) {
      if (seen.has(cursor.parent_id)) break
      seen.add(cursor.parent_id)
      const parent = collectionRowById(cursor.parent_id)
      if (parent === undefined) break
      depth += 1
      cursor = parent
      if (depth > 32) break
    }
    return depth
  }

  /** All descendant folder ids of one folder (including itself). */
  function descendantFolderIds(id) {
    const row = collectionRowById(id)
    if (row === undefined) throw notFound(`folder ${id} does not exist`, { id })
    const ids = [row.id]
    for (let cursor = 0; cursor < ids.length; cursor += 1) {
      for (const child of db.prepare('SELECT id FROM collections WHERE parent_id = ?').all(ids[cursor])) {
        if (!ids.includes(child.id)) ids.push(child.id)
      }
    }
    return ids
  }

  /** Parent id of one folder (used by feed flattening). */
  function folderParentOf(id) {
    const row = collectionRowById(id)
    return row === undefined ? null : row.parent_id ?? null
  }

  /** Count folder nodes below one tree item (recursive). */
  function countFolderNodes(item) {
    let count = 0
    for (const child of item.children ?? []) {
      if (child.kind === 'folder') count += 1
      count += countFolderNodes(child)
    }
    return count
  }

  /**
   * Paper-filter clause for a folder/collection id.
   * Field collections filter by the derived paper field; folders include all
   * descendant folders (contract §1.2).
   */
  function folderFilter(id) {
    const row = collectionRowById(id)
    if (row === undefined) throw notFound(`folder ${id} does not exist`, { id })
    const ids = descendantFolderIds(id)
    return {
      clause: `EXISTS (SELECT 1 FROM paper_collections pc WHERE pc.paper_id = p.id AND pc.collection_id IN (${ids.map(() => '?').join(',')}))`,
      params: ids,
    }
  }

  /** Apply the common `state/read/annotated/field/yearFrom/favorite/folder/tags` filters. */
  function paperFilterClauses(filters = {}, alias = 'p') {
    const clauses = []
    const params = []
    const state = filters.trash === true ? 'trash' : filters.state ?? 'active'
    if (state !== 'all') {
      clauses.push(`${alias}.state = ?`)
      params.push(state)
    }
    if (filters.read !== undefined && filters.read !== null && filters.read !== 'all') {
      clauses.push(`${alias}.read = ?`)
      params.push(filters.read === true ? 1 : 0)
    }
    if (filters.favorite !== undefined && filters.favorite !== null && filters.favorite !== 'all') {
      clauses.push(`${alias}.favorite = ?`)
      params.push(filters.favorite === true || filters.favorite === 1 ? 1 : 0)
    }
    if (filters.annotated === true) {
      clauses.push(`EXISTS (SELECT 1 FROM annotations a WHERE a.paper_id = ${alias}.id AND a.state = 'active')`)
    }
    if (typeof filters.field === 'string' && filters.field.trim() !== '') {
      clauses.push(`(${alias}.field = ? OR ${alias}.field_id = ?)`)
      params.push(filters.field.trim(), filters.field.trim())
    }
    const folderId = typeof filters.folderId === 'string' && filters.folderId !== '' ? filters.folderId : undefined
    if (folderId !== undefined) {
      const folder = folderFilter(folderId)
      clauses.push(folder.clause.replaceAll('p.', `${alias}.`))
      params.push(...folder.params)
    }
    const tags = (Array.isArray(filters.tags) ? filters.tags : []).map((tag) => String(tag ?? '').trim()).filter((tag) => tag !== '')
    if (tags.length > 0) {
      clauses.push(
        `(SELECT COUNT(DISTINCT t.name) FROM paper_tags pt JOIN tags t ON t.id = pt.tag_id WHERE pt.paper_id = ${alias}.id AND t.name IN (${tags.map(() => '?').join(',')})) = ?`,
      )
      params.push(...tags, tags.length)
    }
    if (Number.isFinite(filters.yearFrom)) {
      clauses.push(`${alias}.year >= ?`)
      params.push(Math.trunc(filters.yearFrom))
    }
    return { clauses, params }
  }

  /** Heuristic table of contents from stored page text. */
  function tableOfContents(paperId) {
    const headingPattern =
      /^(?:\d{1,2}(?:\.\d{1,2}){0,2}\.?\s+[A-Z][^\n]{1,80}|Abstract|Introduction|Related Work|Background|Method(?:s|ology)?|Experiments?|Results?|Discussion|Conclusions?|References|Appendix[A-Z]?|Acknowledg(?:e)?ments?)$/
    const rows = db.prepare('SELECT page, text FROM paper_pages WHERE paper_id = ? ORDER BY page').all(paperId)
    const toc = []
    const seen = new Set()
    for (const row of rows) {
      const lines = String(row.text ?? '')
        .split('\n')
        .map((line) => line.trim())
        .filter((line) => line !== '')
        .slice(0, 8)
      for (const line of lines) {
        if (line.length > 110 || !headingPattern.test(line)) continue
        const title = line.replace(/\s+/g, ' ')
        const key = title.toLowerCase()
        if (seen.has(key)) continue
        seen.add(key)
        toc.push({ title, page: Number(row.page) })
        if (toc.length >= 60) return toc
      }
    }
    return toc
  }

  /** Validate the shape of an author list coming from the API. */
  function normalizeAuthors(authors) {
    if (!Array.isArray(authors)) throw invalid('authors must be an array')
    return authors.map((author, index) => {
      if (author === null || typeof author !== 'object') throw invalid(`authors[${index}] must be an object`)
      if (typeof author.literal === 'string' && author.literal.trim() !== '') return { literal: author.literal.trim() }
      const given = typeof author.given === 'string' ? author.given.trim() : ''
      const family = typeof author.family === 'string' ? author.family.trim() : ''
      if (given === '' && family === '') throw invalid(`authors[${index}] needs given, family or literal`)
      return { ...(given === '' ? {} : { given }), ...(family === '' ? {} : { family }) }
    })
  }

  /** Normalize a string-or-null patch value. */
  function nullableString(value, field) {
    if (value === null || value === undefined) return null
    if (typeof value !== 'string') throw invalid(`${field} must be a string or null`)
    return value
  }

  /** Re-index one paper's metadata row through the attached search service. */
  function reindexPaper(paperId) {
    if (attached.search === null) return
    try {
      attached.search.indexPaper(paperId)
    } catch (error) {
      logger?.warn?.(`pappers-hall: re-index failed for ${paperId}: ${String(error?.message ?? error)}`)
    }
  }

  /** Insert/link one tag name to a paper (shared by replace/add paths). */
  function linkTag(paperId, rawName, now) {
    const name = String(rawName ?? '').trim().slice(0, 60)
    if (name === '') return
    db.prepare('INSERT OR IGNORE INTO tags(name, created_at) VALUES (?, ?)').run(name, now)
    const tag = db.prepare('SELECT id FROM tags WHERE name = ?').get(name)
    if (tag !== undefined) db.prepare('INSERT OR IGNORE INTO paper_tags(paper_id, tag_id, created_at) VALUES (?, ?, ?)').run(paperId, tag.id, now)
  }

  /** Remove one tag link and delete the tag row when it becomes unused. */
  function unlinkTag(paperId, rawName) {
    const name = String(rawName ?? '').trim()
    if (name === '') return
    const tag = db.prepare('SELECT id FROM tags WHERE name = ?').get(name)
    if (tag === undefined) return
    db.prepare('DELETE FROM paper_tags WHERE paper_id = ? AND tag_id = ?').run(paperId, tag.id)
    const remaining = db.prepare('SELECT COUNT(*) AS count FROM paper_tags WHERE tag_id = ?').get(tag.id)
    if (Number(remaining?.count ?? 0) === 0) db.prepare('DELETE FROM tags WHERE id = ?').run(tag.id)
  }

  /** Apply v0.2 `tags`/`addTags`/`removeTags` patch semantics to one paper. */
  function applyPaperTagPatch(paperId, patch, now) {
    if (Array.isArray(patch.tags)) {
      db.prepare('DELETE FROM paper_tags WHERE paper_id = ?').run(paperId)
      for (const name of patch.tags) linkTag(paperId, name, now)
    }
    if (Array.isArray(patch.addTags)) for (const name of patch.addTags) linkTag(paperId, name, now)
    if (Array.isArray(patch.removeTags)) for (const name of patch.removeTags) unlinkTag(paperId, name)
  }

  /** Parse one page's stored layout JSON (v0.2 blocks/words/lines). */
  function pageStructure(row) {
    if (row === undefined || typeof row.layout_json !== 'string' || row.layout_json === '') return undefined
    const parsed = parseJson(row.layout_json, undefined)
    if (parsed === null || typeof parsed !== 'object' || !Array.isArray(parsed.blocks)) return undefined
    return parsed
  }

  /**
   * Ensure the real page structure for one paper is ready, scheduling the lazy
   * background job when an old (v0.1) library row has no layout yet.
   * @param {string} paperId paper id.
   * @returns {{state:'ready'|'pending'|'failed', jobId?:string}}
   */
  function ensureStructure(paperId, options = {}) {
    const row = db.prepare('SELECT structure_state FROM papers WHERE id = ?').get(paperId)
    if (row === undefined) throw notFound(`paper ${paperId} does not exist`, { id: paperId })
    if (row.structure_state === 'ready' && options.force !== true) return { state: 'ready' }
    if (attached.ingest !== null && typeof attached.ingest.ensureStructure === 'function') {
      return attached.ingest.ensureStructure(paperId, options)
    }
    return { state: row.structure_state === 'failed' ? 'failed' : 'pending' }
  }

  /** Width/height in rendered pixels for the default page image width. */
  function renderedPageSize(width, height, defaultWidth = 1400) {
    const pointWidth = Number(width)
    const pointHeight = Number(height)
    if (!Number.isFinite(pointWidth) || !Number.isFinite(pointHeight) || pointWidth <= 0 || pointHeight <= 0) {
      return { widthPx: defaultWidth, heightPx: Math.round(defaultWidth * 1.294) }
    }
    return { widthPx: defaultWidth, heightPx: Math.round((defaultWidth * pointHeight) / pointWidth) }
  }

  /* ---------------------------------------------------------------- */
  /* Status and diagnostics                                            */
  /* ---------------------------------------------------------------- */

  const store = {
    /** Expose internals for api/ingest/tools wiring (not part of the wire API). */
    db,
    layout,
    config,
    manifest,
    fts5,
    attach(dependencies) {
      Object.assign(attached, dependencies)
      return store
    },
    get attachments() {
      return attached
    },

    /* ---------------------- read-only API ------------------------- */

    /** `status`: plugin/storage/counts/index/degraded/jobs snapshot. */
    status() {
      const processingRows = db.prepare('SELECT processing_json FROM papers WHERE state = ?').all('active')
      let ready = 0
      let pending = 0
      let partial = 0
      let failed = 0
      for (const row of processingRows) {
        const state = parseProcessing(row.processing_json).state
        if (state === 'ready') ready += 1
        else if (state === 'failed') failed += 1
        else if (state === 'partial') partial += 1
        else pending += 1
      }
      const dbBytes = layout?.dbPath !== undefined ? fileSizeOf(layout.dbPath) : null
      const facts = databaseFacts(db)
      const index = attached.search?.indexFacts?.() ?? {
        channels: { fts: fts5 ? 'ready' : 'degraded', vector: 'unavailable' },
        paperCount: countRows(db, 'papers', 'state = ?', ['active']),
      }
      // v0.5 client `SemanticChips` reads index.vectorInfo for model/latency/reason.
      if (index.vectorInfo === undefined) {
        index.vectorInfo = attached.embedding?.vectorInfo?.() ?? {
          model: null,
          dims: null,
          latencyMs: null,
          reason: 'embedding component is not initialized (v0.5-B vector search pending)',
        }
      }
      const degraded = collectDegraded({ fts5, ctx, identity, embedding: attached.embedding, translate: attached.translate, ocr: attached.ocr, settings: attached.settings })
      const jobs = attached.queue?.summary?.() ?? { queued: 0, running: 0, paused: 0, retry_wait: 0, failed: 0, succeeded: 0, cancelled: 0, globalPaused: false }
      return {
        plugin: {
          id: identity.pluginId ?? 'dsh-pappers-hall',
          version: identity.pluginVersion ?? '0.1.0',
          hostVersion: identity.hostVersion ?? 'unknown',
          enabled: true,
        },
        storage: {
          dataDir: layout?.dataDir ?? config.dataDir ?? '',
          dbPath: layout?.dbPath ?? '',
          dbBytes: dbBytes === null ? 0 : dbBytes,
          pageSize: facts.pageSize,
        },
        counts: {
          papers: countRows(db, 'papers', "state = 'active'"),
          trash: countRows(db, 'papers', "state = 'trash'"),
          annotations: countRows(db, 'annotations', "state = 'active'"),
          notes: countRows(db, 'notes', "state = 'active'"),
          // v0.17 notes workbench counts are reported separately so the legacy
          // paper quick-note count above keeps its historic meaning.
          noteDocs: countRows(db, 'note_docs', "state = 'active'"),
          noteTrash: countRows(db, 'note_docs', "state = 'trash'"),
          noteFolders: countRows(db, 'note_folders'),
          figures: countRows(db, 'figures'),
          jobsPending: countRows(db, 'jobs', "state IN ('queued','running','paused','retry_wait')"),
        },
        index,
        degraded,
        ocr: (() => {
          try {
            const status = attached.ocr !== null && attached.ocr !== undefined && typeof attached.ocr.status === 'function' ? attached.ocr.status() : null
            if (status === null) return { available: false, enabled: false, installed: false, pages: 0, indexedPages: 0, engine: null, reason: 'OCR service is not initialized' }
            return {
              available: status.available === true,
              enabled: status.enabled === true,
              installed: status.installed === true,
              engine: status.engine ?? null,
              pages: Number(status.scanPages ?? 0),
              indexedPages: Number(status.indexedPages ?? 0),
              reason: status.reason ?? null,
            }
          } catch (error) {
            return { available: false, enabled: false, installed: false, pages: 0, indexedPages: 0, engine: null, reason: String(error?.message ?? error) }
          }
        })(),
        processing: { ready, pending, partial, failed },
        jobs,
      }
    },

    /** `diagnostics`: versions/capabilities/data dir/schema version. */
    diagnostics() {
      const detections = attached.pdf?.detection ?? { backend: 'none', available: false, version: null, missing: [], versions: {} }
      const translatorAvailable = typeof ctx?.get === 'function' && ctx.get('translator') !== undefined
      let freeTranslationProviders = []
      try {
        const providers = attached.translate !== undefined && attached.translate !== null && typeof attached.translate.providers === 'function' ? attached.translate.providers() : null
        const items = providers !== null && Array.isArray(providers.items) ? providers.items : []
        freeTranslationProviders = items
          .filter((item) => item && item.enabled !== false && (item.configured === true || item.available === true))
          .map((item) => item.id)
      } catch (error) {
        freeTranslationProviders = []
      }
      const translationReady = translatorAvailable || freeTranslationProviders.length > 0
      return {
        versions: [
          { name: 'node', version: process.versions.node, license: 'MIT' },
          { name: 'node:sqlite', version: process.versions.sqlite ?? 'bundled', license: 'MIT' },
          [
            { name: detections.backend === 'pymupdf' ? 'pymupdf' : 'poppler', version: detections.version ?? 'unavailable', license: detections.backend === 'pymupdf' ? 'AGPL-3.0 (user-installed)' : 'GPL-2.0-or-later' },
          ],
          { name: 'pappers-hall', version: identity.pluginVersion ?? '0.1.0', license: 'MIT' },
        ],
        host: {
          dsh: identity.hostVersion ?? 'unknown',
          node: process.versions.node,
          platform: `${process.platform}-${process.arch}`,
        },
        capabilities: {
          pdfBackend: detections.backend ?? 'poppler',
          pdfText: detections.available ? 'ready' : 'unavailable',
          pageRender: detections.available ? 'ready' : 'unavailable',
          figureCrop: detections.available ? 'ready' : 'unavailable',
          dhash: detections.available ? 'ready' : 'unavailable',
          fts: fts5 ? 'ready' : 'degraded',
          // Derived live from the embedding component + built index (not a mount
          // snapshot): ready only when a real semantic index is servable.
          vector: (() => {
            const featureOn = attached.settings === null || attached.settings === undefined ? true : attached.settings.features().vectorSearch !== false
            if (!featureOn) return 'disabled'
            const embedding = attached.embedding
            if (embedding === null || embedding === undefined) return 'unavailable'
            const facts = typeof embedding.facts === 'function' ? embedding.facts() : null
            if (facts !== null && facts.available === true && facts.indexReady === true) return 'ready'
            if (facts !== null && facts.configured === true) return 'degraded'
            return 'unavailable'
          })(),
          ocr: (() => {
            try {
              const status = attached.ocr !== null && attached.ocr !== undefined && typeof attached.ocr.status === 'function' ? attached.ocr.status() : null
              if (status === null) return 'unavailable'
              return status.available === true && status.enabled === true ? 'ready' : 'unavailable'
            } catch {
              return 'unavailable'
            }
          })(),
          translation: translationReady ? 'ready' : 'unavailable',
          translationProviders: freeTranslationProviders,
        },
        dataDir: layout?.dataDir ?? '',
        schemaVersion: Number(readSetting(db, 'schemaVersion') ?? 0),
        prompt: { materialsSection: identity.promptRegistered === true ? 'ready' : 'unavailable' },
        agent: { tools: [...agentFacts.tools], promptSection: agentFacts.promptSection === true },
        ai: (() => {
          const ai = attached.ai
          if (ai === undefined || ai === null) return { available: false, provider: null, model: null, reason: 'AI service not initialized' }
          const status = ai.status()
          return { available: status.available, provider: status.provider, model: status.model, ...(status.reason === undefined ? {} : { reason: status.reason }) }
        })(),
        renderer: { textLayer: true, pageImages: true, blocks: true },
        translation: attached.translate?.diagnostics?.() ?? null,
        embedding: attached.embedding?.diagnostics?.() ?? null,
        ocr: (() => {
          try {
            const status = attached.ocr !== null && attached.ocr !== undefined && typeof attached.ocr.status === 'function' ? attached.ocr.status() : null
            if (status === null) return null
            return {
              available: status.available === true,
              installed: status.installed === true,
              enabled: status.enabled === true,
              engine: status.engine ?? null,
              version: status.version ?? null,
              scanPages: Number(status.scanPages ?? 0),
              indexedPages: Number(status.indexedPages ?? 0),
              lastError: status.lastError ?? null,
            }
          } catch {
            return null
          }
        })(),
        settings: attached.settings !== null && attached.settings !== undefined && typeof attached.settings.features === 'function' ? { features: attached.settings.features() } : null,
        features: {
          collections: true,
          tags: true,
          annotationsV2: true,
          readerBlocks: true,
          readerLayer: true,
          outline: true,
          aiTranslate: attached.ai !== undefined && attached.ai.available === true,
          aiSearch: attached.ai !== undefined && attached.ai.available === true,
          aiAsk: attached.ai !== undefined && attached.ai.available === true,
          aiFastMode: true,
          operations: true,
          undo: true,
          journalMetrics: true,
          duplicates: true,
          citationFormats: true,
          annotationExport: true,
          savedSearches: true,
        },
        fixture: { available: manifest.available === true, papers: manifest.byId?.size ?? 0 },
      }
    },

    /* ---------------------- library ------------------------------- */

    /**
     * `library.list`
     * @param {object} params query/filter/sort/paging parameters.
     * @returns {{total:number, offset:number, limit:number, items:object[]}}
     */
    libraryList(params = {}) {
      const offset = clampInt(params.offset ?? 0, 0, 1_000_000, 0)
      const limit = clampInt(params.limit ?? 50, 1, 200, 50)
      const tagFilter = Array.isArray(params.tags) ? params.tags : typeof params.tag === 'string' && params.tag.trim() !== '' ? [params.tag] : []
      const { clauses, params: filterParams } = paperFilterClauses({
        state: params.state ?? 'active',
        read: params.read,
        annotated: params.annotated,
        favorite: params.favorite,
        field: params.field,
        // v0.5: collectionId is an alias of folderId and includes descendants.
        folderId: typeof params.folderId === 'string' && params.folderId !== '' ? params.folderId : params.collectionId,
        tags: tagFilter,
        yearFrom: params.yearFrom,
        trash: params.trash,
      })
      if (typeof params.reading === 'string' && ['to-read', 'reading', 'read'].includes(params.reading)) {
        if (params.reading === 'read') clauses.push('p.read = 1')
        else if (params.reading === 'to-read') clauses.push('p.read = 0 AND COALESCE(p.reading_progress, 0) <= 0')
        else clauses.push('p.read = 0 AND COALESCE(p.reading_progress, 0) > 0 AND COALESCE(p.reading_progress, 0) < 100')
      }
      const query = typeof params.query === 'string' ? params.query.trim() : ''
      if (query !== '') {
        const pattern = `%${escapeLike(query)}%`
        clauses.push(
          `(p.title LIKE ? ESCAPE '\\' OR p.title_zh LIKE ? ESCAPE '\\' OR p.display_title LIKE ? ESCAPE '\\' OR p.authors_json LIKE ? ESCAPE '\\' OR p.venue LIKE ? ESCAPE '\\' OR p.doi LIKE ? ESCAPE '\\' OR p.manifest_id LIKE ? ESCAPE '\\')`,
        )
        filterParams.push(pattern, pattern, pattern, pattern, pattern, pattern, pattern)
      }
      const where = clauses.length === 0 ? '' : `WHERE ${clauses.join(' AND ')}`
      const sort = params.sort ?? 'recent'
      const orderBy =
        sort === 'title'
          ? "ORDER BY COALESCE(NULLIF(p.display_title, ''), NULLIF(p.title_zh, ''), p.title) COLLATE NOCASE ASC"
          : sort === 'added'
            ? 'ORDER BY p.added_at DESC'
            : sort === 'year'
              ? 'ORDER BY p.year DESC NULLS LAST, p.updated_at DESC'
              : sort === 'authors'
                ? "ORDER BY p.authors_json COLLATE NOCASE ASC"
                : sort === 'citations'
                  ? "ORDER BY (p.citation_count IS NULL AND json_extract(p.metrics_json, '$.citedByCount') IS NULL), COALESCE(p.citation_count, json_extract(p.metrics_json, '$.citedByCount')) DESC, p.updated_at DESC"
                  : sort === 'impactFactor'
                    ? 'ORDER BY j.impact_factor IS NULL, j.impact_factor DESC, p.updated_at DESC'
                    : sort === 'favorite'
                      ? 'ORDER BY p.favorite DESC, p.updated_at DESC'
                      : 'ORDER BY p.updated_at DESC'
      const total = Number(db.prepare(`SELECT COUNT(*) AS count FROM papers p ${where}`).get(...filterParams)?.count ?? 0)
      const rows = db
        .prepare(
          `SELECT ${PAPER_COLUMNS}, j.impact_factor AS journal_impact_factor,
                  j.impact_factor_year AS journal_impact_factor_year, j.quartile AS journal_quartile
           FROM papers p LEFT JOIN papers_journal j ON j.key = p.journal_key ${where} ${orderBy} LIMIT ? OFFSET ?`,
        )
        .all(...filterParams, limit, offset)
      const tagMap = tagsOfMany(rows.map((row) => row.id))
      return { total, offset, limit, items: rows.map((row) => toPaperSummary(row, { tags: tagMap.get(row.id) ?? [] })) }
    },

    /* ---------------------- discover / feed (v0.4) ---------------- */

    /**
     * `discover.feed` — discovery payload for the redesigned sidebar.
     * @param {{limit?:number}} params section size (default 5).
     * @returns {object} stats + sections.
     */
    discoverFeed(params = {}) {
      const limit = clampInt(params.limit ?? 5, 1, 12, 5)
      const active = "p.state = 'active'"
      const selectTiles = (where, order, size) =>
        db
          .prepare(`SELECT ${TILE_COLUMNS} FROM papers p LEFT JOIN papers_journal j ON j.key = p.journal_key WHERE ${where} ORDER BY ${order} LIMIT ?`)
          .all(size)
      const continueReading = selectTiles(`${active} AND p.last_read_at IS NOT NULL`, 'p.last_read_at DESC', limit)
      const unread = selectTiles(`${active} AND p.read = 0`, 'p.added_at DESC', limit)
      const annotated = selectTiles(
        `${active} AND (SELECT COUNT(*) FROM annotations a WHERE a.paper_id = p.id AND a.state = 'active') > 0`,
        "(SELECT COUNT(*) FROM annotations a WHERE a.paper_id = p.id AND a.state = 'active') DESC, p.updated_at DESC",
        limit,
      )
      const favorite = selectTiles(`${active} AND p.favorite = 1`, 'p.added_at DESC', limit)
      const stats = {
        papers: Number(db.prepare("SELECT COUNT(*) AS count FROM papers WHERE state = 'active'").get()?.count ?? 0),
        unread: Number(db.prepare("SELECT COUNT(*) AS count FROM papers WHERE state = 'active' AND read = 0").get()?.count ?? 0),
        reading: Number(
          db.prepare("SELECT COUNT(*) AS count FROM papers WHERE state = 'active' AND read = 0 AND COALESCE(reading_progress, 0) > 0").get()?.count ?? 0,
        ),
        read: Number(db.prepare("SELECT COUNT(*) AS count FROM papers WHERE state = 'active' AND read = 1").get()?.count ?? 0),
        annotations: Number(db.prepare("SELECT COUNT(*) AS count FROM annotations WHERE state = 'active'").get()?.count ?? 0),
        figures: Number(
          db
            .prepare(
              "SELECT COUNT(*) AS count FROM figures f JOIN papers p ON p.id = f.paper_id WHERE p.state = 'active' AND f.status = 'ready'",
            )
            .get()?.count ?? 0,
        ),
        notes: Number(db.prepare("SELECT COUNT(*) AS count FROM notes WHERE state = 'active'").get()?.count ?? 0),
        trash: Number(db.prepare("SELECT COUNT(*) AS count FROM papers WHERE state = 'trash'").get()?.count ?? 0),
        tags: Number(
          db
            .prepare(
              'SELECT COUNT(DISTINCT t.id) AS count FROM tags t JOIN paper_tags pt ON pt.tag_id = t.id JOIN papers p ON p.id = pt.paper_id WHERE p.state = ?',
            )
            .get('active')?.count ?? 0,
        ),
        collections: Number(db.prepare('SELECT COUNT(*) AS count FROM collections').get()?.count ?? 0),
        favorite: Number(db.prepare("SELECT COUNT(*) AS count FROM papers WHERE state = 'active' AND favorite = 1").get()?.count ?? 0),
      }
      const recentAnnotations = db
        .prepare(
          `SELECT a.id, a.paper_id, a.page, a.kind, a.color, a.quote, a.comment, a.created_at, p.title, p.title_zh
           FROM annotations a JOIN papers p ON p.id = a.paper_id AND p.state = 'active'
           WHERE a.state = 'active' ORDER BY a.created_at DESC, a.id DESC LIMIT ?`,
        )
        .all(limit + 3)
        .map((row) => ({
          id: row.id,
          paperId: row.paper_id,
          paperTitle: row.title_zh ?? row.title,
          paperTitleOriginal: row.title_zh === null || row.title_zh === undefined ? null : row.title,
          page: Number(row.page),
          kind: row.kind,
          color: row.color ?? null,
          quote: row.quote ?? null,
          comment: row.comment ?? null,
          createdAt: row.created_at,
        }))
      const recentFigures = db
        .prepare(
          `SELECT f.id, f.paper_id, f.page, f.label, f.caption, p.title, p.title_zh
           FROM figures f JOIN papers p ON p.id = f.paper_id AND p.state = 'active'
           WHERE f.status = 'ready' ORDER BY f.created_at DESC, f.id DESC LIMIT ?`,
        )
        .all(limit + 1)
        .map((row) => ({
          id: row.id,
          paperId: row.paper_id,
          paperTitle: row.title_zh ?? row.title,
          page: Number(row.page),
          label: row.label ?? null,
          caption: row.caption ?? null,
          captionThumbUrl: `/pappers-hall/figure/${row.id}.png?width=320&v=${encodeURIComponent(row.dhash || row.id)}`,
          imageUrl: `/pappers-hall/figure/${row.id}.png?v=${encodeURIComponent(row.dhash || row.id)}`,
        }))
      const collections = this.libraryCollectionsList().items
      const tags = this.tagsList().items
      const folderTree = this.libraryFoldersTree()
      const folderCounts = []
      const walkFolders = (nodes) => {
        for (const node of nodes) {
          folderCounts.push({ id: node.id, name: node.name, color: node.color, kind: node.kind, count: node.count, parentId: folderParentOf(node.id), depth: node.depth })
          walkFolders(node.children ?? [])
        }
      }
      walkFolders(folderTree.items)
      return {
        stats,
        continueReading: tilesFromRows(continueReading),
        unread: tilesFromRows(unread),
        annotated: tilesFromRows(annotated),
        favorite: tilesFromRows(favorite),
        folders: folderTree.items,
        folderCounts,
        collections,
        tags,
        recentAnnotations,
        recentFigures,
      }
    },

    /**
     * `annotations.feed` — cross-paper annotation stream with filters and paging.
     * @param {object} params limit/paperId/colors/kinds/query/before.
     * @returns {{items:object[], hasMore:boolean, nextBefore:string|null}}
     */
    annotationsFeed(params = {}) {
      const limit = clampInt(params.limit ?? 20, 1, 100, 20)
      const clauses = ["a.state = 'active'", "p.state = 'active'"]
      const values = []
      if (typeof params.paperId === 'string' && params.paperId !== '') {
        clauses.push('a.paper_id = ?')
        values.push(params.paperId)
      }
      const colors = (Array.isArray(params.colors) ? params.colors : typeof params.color === 'string' ? [params.color] : [])
        .map((value) => String(value))
        .filter((value) => value !== '')
      if (colors.length > 0) {
        clauses.push(`a.color IN (${colors.map(() => '?').join(',')})`)
        values.push(...colors)
      }
      const kinds = (Array.isArray(params.kinds) ? params.kinds : typeof params.kind === 'string' ? [params.kind] : [])
        .map((value) => String(value))
        .filter((value) => value !== '')
      if (kinds.length > 0) {
        clauses.push(`a.kind IN (${kinds.map(() => '?').join(',')})`)
        values.push(...kinds)
      }
      if (typeof params.query === 'string' && params.query.trim() !== '') {
        const pattern = `%${escapeLike(params.query.trim())}%`
        clauses.push("(a.quote LIKE ? ESCAPE '\\' OR a.comment LIKE ? ESCAPE '\\' OR a.text LIKE ? ESCAPE '\\' OR p.title LIKE ? ESCAPE '\\')")
        values.push(pattern, pattern, pattern, pattern)
      }
      if (typeof params.folderId === 'string' && params.folderId !== '') {
        const folder = folderFilter(params.folderId)
        clauses.push(folder.clause)
        values.push(...folder.params)
      }
      const feedTags = (Array.isArray(params.tags) ? params.tags : []).map((tag) => String(tag ?? '').trim()).filter((tag) => tag !== '')
      if (feedTags.length > 0) {
        clauses.push(
          `(SELECT COUNT(DISTINCT t.name) FROM paper_tags pt JOIN tags t ON t.id = pt.tag_id WHERE pt.paper_id = p.id AND t.name IN (${feedTags.map(() => '?').join(',')})) = ?`,
        )
        values.push(...feedTags, feedTags.length)
      }
      if (typeof params.before === 'string' && params.before !== '') {
        clauses.push('a.created_at < ?')
        values.push(params.before)
      }
      const rows = db
        .prepare(
          `SELECT a.id, a.paper_id, a.page, a.kind, a.color, a.quote, a.comment, a.created_at, p.title, p.title_zh
           FROM annotations a JOIN papers p ON p.id = a.paper_id
           WHERE ${clauses.join(' AND ')}
           ORDER BY a.created_at DESC, a.id DESC LIMIT ?`,
        )
        .all(...values, limit + 1)
      const hasMore = rows.length > limit
      const pageRows = hasMore ? rows.slice(0, limit) : rows
      const items = pageRows.map((row) => ({
        id: row.id,
        paperId: row.paper_id,
        paperTitle: row.title_zh ?? row.title,
        paperTitleOriginal: row.title_zh === null || row.title_zh === undefined ? null : row.title,
        page: Number(row.page),
        kind: row.kind,
        color: row.color ?? null,
        quote: row.quote ?? null,
        comment: row.comment ?? null,
        createdAt: row.created_at,
      }))
      return {
        items,
        hasMore,
        nextBefore: items.length === 0 ? null : items[items.length - 1].createdAt,
      }
    },

    /**
     * `library.tiles` — batch PaperTiles (sidebar refresh); defaults to recents.
     * @param {{ids?:string[]}} params request.
     * @returns {{items:object[]}}
     */
    libraryTiles(params = {}) {
      const ids = Array.isArray(params.ids) ? params.ids.map(String) : []
      if (ids.length === 0) {
        const rows = db
          .prepare(`SELECT ${TILE_COLUMNS} FROM papers p LEFT JOIN papers_journal j ON j.key = p.journal_key WHERE p.state = 'active' ORDER BY p.updated_at DESC LIMIT ?`)
          .all(clampInt(params.limit ?? 20, 1, 100, 20))
        return { items: tilesFromRows(rows) }
      }
      const rows = db
        .prepare(
          `SELECT ${TILE_COLUMNS} FROM papers p LEFT JOIN papers_journal j ON j.key = p.journal_key WHERE p.id IN (${ids.map(() => '?').join(',')})`,
        )
        .all(...ids)
      const byId = new Map(rows.map((row) => [row.id, row]))
      const ordered = ids.map((id) => byId.get(id)).filter((row) => row !== undefined)
      return { items: tilesFromRows(ordered) }
    },

    /**
     * Resolve the paper-id allow-list for folder/tag/favorite filters (v0.5).
     *
     * Used by search.query so every channel (FTS, LIKE, figures, annotations,
     * notes, later the vector channel) only returns papers inside the filter set.
     * @param {object} filters folderId/tags/favorite/field.
     * @returns {string[]|null} allowed ids, or null when no filter is active.
     */
    searchFilterPaperIds(filters = {}) {
      const tags = (Array.isArray(filters.tags) ? filters.tags : []).map((tag) => String(tag ?? '').trim()).filter((tag) => tag !== '')
      const folderId = typeof filters.folderId === 'string' && filters.folderId !== '' ? filters.folderId : undefined
      const favorite = filters.favorite === undefined || filters.favorite === null ? undefined : filters.favorite
      const field = typeof filters.field === 'string' && filters.field !== '' ? filters.field : undefined
      if (folderId === undefined && tags.length === 0 && favorite === undefined && field === undefined) return null
      const { clauses, params } = paperFilterClauses({ state: 'active', folderId, tags, favorite, field }, 'p')
      return db
        .prepare(`SELECT p.id FROM papers p WHERE ${clauses.join(' AND ')}`)
        .all(...params)
        .map((row) => row.id)
    },

    /**
     * `library.classify` — v0.6 semantic folder suggestion (optionally applied).
     * @param {{paperIds:string[], apply?:boolean, sessionId?:string}} params request.
     * @returns {Promise<object>} suggestions and, when apply=true, applied result.
     */
    async libraryClassify(params = {}) {
      const paperIds = normalizeIds(params.paperIds ?? (typeof params.paperId === 'string' && params.paperId !== '' ? [params.paperId] : undefined), 'library.classify')
      if (attached.classify === null || attached.classify === undefined) {
        return { status: 'unavailable', reason: 'embedding unavailable', threshold: null, suggestions: [] }
      }
      const suggestion = await attached.classify.suggest({ paperIds, sessionId: params.sessionId })
      if (suggestion.status !== 'ok') return suggestion
      if (params.apply !== true) return { status: 'ok', ...suggestion }
      const decisions = suggestion.suggestions.filter((item) => item.action === 'assign' || item.action === 'create')
      const applied = decisions.length === 0 ? { applied: [], createdFolders: [], operationId: undefined, errors: [] } : this.classifyApply(decisions)
      return { status: 'ok', ...suggestion, applied }
    },

    /**
     * Apply classification decisions in one undoable operation (v0.6).
     * @param {object[]} decisions `{paperId, action:'assign'|'create', folderId?, newFolderName?, confidence?}`.
     * @returns {{applied:object[], createdFolders:object[], operationId?:string, errors:object[]}}
     */
    classifyApply(decisions = []) {
      const list = Array.isArray(decisions) ? decisions : []
      return withOperation('library.classify.apply', undefined, () => {
        const now = nowIso()
        const createdFolders = []
        const applied = []
        const assignments = []
        const errors = []
        transaction(db, () => {
          for (const decision of list) {
            const paperId = String(decision?.paperId ?? '')
            if (paperId === '') continue
            const paper = db.prepare("SELECT id, title, title_zh, venue FROM papers WHERE id = ? AND state = 'active'").get(paperId)
            if (paper === undefined) {
              errors.push({ paperId, error: 'not_found' })
              continue
            }
            let folderId = typeof decision.folderId === 'string' && decision.folderId !== '' ? decision.folderId : null
            let folderName = typeof decision.folderName === 'string' ? decision.folderName : ''
            let created = false
            if (decision.action === 'create' || folderId === null) {
              const rawName = String(decision.newFolderName ?? decision.folderName ?? '').trim()
              // Never create an empty/number-only folder name.
              const fallback = (() => {
                const titleZh = typeof paper.title_zh === 'string' ? paper.title_zh.trim() : ''
                if (titleZh !== '') return [...titleZh.replace(/\s+/g, '')].slice(0, 12).join('')
                if (typeof paper.title === 'string' && paper.title.trim() !== '') return paper.title.trim().split(/\s+/).slice(0, 3).join(' ')
                return '未分类主题'
              })()
              const name = [...rawName.replace(/[\s"'“”‘’《》【】()（）:：,，.。;；!！?？、/\\|]+/g, '')].slice(0, 24).join('') || fallback
              const sibling = db.prepare("SELECT id, name FROM collections WHERE name = ? AND IFNULL(parent_id, '') = IFNULL(?, '')").get(name, null)
              if (sibling !== undefined) {
                folderId = sibling.id
                folderName = sibling.name
              } else {
                folderId = `cl-${randomHex(6)}`
                db.prepare(
                  "INSERT INTO collections(id, name, color, sort_order, kind, field_key, parent_id, created_at, updated_at) VALUES (?, ?, NULL, ?, 'folder', NULL, NULL, ?, ?)",
                ).run(
                  folderId,
                  name,
                  Number(db.prepare('SELECT COALESCE(MAX(sort_order), 0) + 1 AS next FROM collections').get()?.next ?? 0),
                  now,
                  now,
                )
                createdFolders.push({ id: folderId, name })
                folderName = name
                created = true
              }
            } else {
              const folder = collectionRowById(folderId)
              if (folder === undefined) {
                errors.push({ paperId, error: `folder ${folderId} does not exist` })
                continue
              }
              folderName = folder.name
            }
            const existed = db.prepare('SELECT 1 FROM paper_collections WHERE collection_id = ? AND paper_id = ?').get(folderId, paperId) !== undefined
            db.prepare('INSERT OR IGNORE INTO paper_collections(collection_id, paper_id, created_at) VALUES (?, ?, ?)').run(folderId, paperId, now)
            assignments.push({ collectionId: folderId, paperId, existed })
            applied.push({
              paperId,
              folderId,
              folderName,
              created,
              confidence: decision.confidence === undefined || decision.confidence === null ? null : Number(decision.confidence),
            })
          }
        })
        const operationId = applied.length === 0 ? undefined : recordOperation({
          kind: 'library.classify.apply',
          summary: `自动归类 ${applied.length} 篇论文（新建 ${createdFolders.length} 个文件夹）`,
          target: { paperIds: applied.map((item) => item.paperId), folderIds: [...new Set(applied.map((item) => item.folderId))] },
          undo: { createdFolders: createdFolders.map((folder) => folder.id), assignments },
        })
        recordEvent('library.classify.apply', null, { applied: applied.length, createdFolders: createdFolders.length })
        return { applied, createdFolders, errors, ...(operationId === undefined ? {} : { operationId }) }
      })
    },

    /**
     * Import hook: auto-classify accepted papers (failure never blocks import).
     * @param {string[]} paperIds newly imported paper ids.
     * @returns {Promise<object>} classification payload.
     */
    async classifyImportedPapers(paperIds) {
      const ids = (Array.isArray(paperIds) ? paperIds : []).map(String).filter((id) => id !== '')
      if (ids.length === 0) return { status: 'skipped', applied: [], createdFolders: [] }
      if (attached.classify === null || attached.classify === undefined) {
        return { status: 'unavailable', reason: 'embedding unavailable', applied: [], createdFolders: [] }
      }
      try {
        const suggestion = await attached.classify.suggest({ paperIds: ids })
        if (suggestion.status !== 'ok') {
          return { status: suggestion.status ?? 'unavailable', reason: suggestion.reason ?? 'classification unavailable', applied: [], createdFolders: [] }
        }
        const decisions = suggestion.suggestions.filter((item) => item.action === 'assign' || item.action === 'create')
        if (decisions.length === 0) return { status: 'ok', applied: [], createdFolders: [], suggestions: suggestion.suggestions }
        const applied = this.classifyApply(decisions)
        return {
          status: applied.applied.length === 0 ? 'ok' : 'applied',
          threshold: suggestion.threshold,
          applied: applied.applied,
          createdFolders: applied.createdFolders,
          errors: applied.errors,
          ...(applied.operationId === undefined ? {} : { operationId: applied.operationId }),
          suggestions: suggestion.suggestions,
        }
      } catch (error) {
        return { status: 'error', error: String(error?.message ?? error), applied: [], createdFolders: [] }
      }
    },

    /**
     * Record which agent tools / prompt section this host registered (diagnostics).
     * @param {{tools?:string[], promptSection?:boolean}} facts facts.
     */
    setAgentFacts(facts = {}) {
      agentFacts = {
        tools: Array.isArray(facts.tools) ? facts.tools.map(String) : agentFacts.tools,
        promptSection: facts.promptSection === undefined ? agentFacts.promptSection : facts.promptSection === true,
      }
      return agentFacts
    },

    /**
     * `library.get`
     * @param {{id:string}} params paper id.
     * @returns {object} PaperDetail.
     */
    libraryGet(params = {}) {
      const id = String(params.id ?? '')
      if (id === '') throw invalid('library.get requires id')
      return paperDetail(requirePaperRow(id))
    },

    /**
     * `repairQuoteFromOcr` — repair a quote that came from a garbled text layer.
     *
     * When a user selects text inside a figure (or a scanned page), the PDF text
     * layer may return glyph codes. Render+OCR the page, map the selection rects
     * (normalized page coordinates) onto OCR blocks, and return the OCR text that
     * actually sits inside the selection.
     * @param {string} paperId paper id.
     * @param {number} page 1-based page.
     * @param {Array<{x:number,y:number,w:number,h:number}>} rects normalized page rects.
     * @param {string} quote original quote (used only to decide whether repair is needed).
     * @returns {Promise<{text:string, source:'ocr-region'}|null>} repaired quote or null.
     */
    async repairQuoteFromOcr(paperId, page, rects, quote) {
      if (!looksLikeCipherText(quote)) return null
      const ocr = attached.ocr
      if (ocr === undefined || ocr === null || typeof ocr.ensurePageBlocks !== 'function') return null
      const safeRects = Array.isArray(rects)
        ? rects
            .map((rect) => ({ x: Number(rect?.x), y: Number(rect?.y), w: Number(rect?.w), h: Number(rect?.h) }))
            .filter((rect) => [rect.x, rect.y, rect.w, rect.h].every((value) => Number.isFinite(value)))
        : []
      if (safeRects.length === 0) return null
      let entry
      try { entry = await ocr.ensurePageBlocks(String(paperId), Number(page)) } catch (error) { entry = null }
      if (entry === null || entry === undefined || !Array.isArray(entry.blocks) || entry.blocks.length === 0) return null
      const width = Number(entry.width) > 0 ? Number(entry.width) : 1
      const height = Number(entry.height) > 0 ? Number(entry.height) : 1
      const boxes = []
      for (const block of entry.blocks) {
        if (block === null || typeof block !== 'object' || typeof block.text !== 'string' || block.text.trim() === '') continue
        const points = Array.isArray(block.box) ? block.box : []
        const xs = points.map((point) => Number(point?.[0])).filter(Number.isFinite)
        const ys = points.map((point) => Number(point?.[1])).filter(Number.isFinite)
        if (xs.length === 0 || ys.length === 0) continue
        const nx = Math.min(...xs) / width
        const ny = Math.min(...ys) / height
        const nw = (Math.max(...xs) - Math.min(...xs)) / width
        const nh = (Math.max(...ys) - Math.min(...ys)) / height
        const centerX = nx + nw / 2
        const centerY = ny + nh / 2
        const centerHit = safeRects.some((rect) => centerX >= rect.x && centerX <= rect.x + rect.w && centerY >= rect.y && centerY <= rect.y + rect.h)
        const overlap = safeRects.some((rect) => {
          const left = Math.max(nx, rect.x)
          const top = Math.max(ny, rect.y)
          const right = Math.min(nx + nw, rect.x + rect.w)
          const bottom = Math.min(ny + nh, rect.y + rect.h)
          return right > left && bottom > top && (right - left) * (bottom - top) / Math.max(1e-6, nw * nh) >= 0.35
        })
        if (centerHit || overlap) boxes.push({ x: nx, y: ny, text: block.text.trim() })
      }
      if (boxes.length === 0) return null
      boxes.sort((left, right) => (Math.abs(left.y - right.y) > 0.01 ? left.y - right.y : left.x - right.x))
      const text = boxes.map((box) => box.text).join(' ').replace(/\s+/g, ' ').trim()
      if (text.length < 4) return null
      if (assessTextQuality(text).kind === 'cipher') return null
      return { text, source: 'ocr-region' }
    },

    /**
     * `ocrRegionText` — OCR text inside normalized page rects (region translate).
     *
     * Unlike {@link repairQuoteFromOcr} this is not limited to cipher quotes: the
     * side-by-side paper panel can box-select any patch of a page and translate
     * the OCR text that actually sits inside the selection.
     * @param {string} paperId paper id.
     * @param {number} page 1-based page.
     * @param {Array<{x:number,y:number,w:number,h:number}>} rects normalized page rects.
     * @returns {Promise<string>} region text, or '' when OCR/selection yields nothing.
     */
    async ocrRegionText(paperId, page, rects) {
      const ocr = attached.ocr
      if (ocr === undefined || ocr === null || typeof ocr.ensurePageBlocks !== 'function') return ''
      const safeRects = Array.isArray(rects)
        ? rects
            .map((rect) => ({ x: Number(rect?.x), y: Number(rect?.y), w: Number(rect?.w), h: Number(rect?.h) }))
            .filter((rect) => [rect.x, rect.y, rect.w, rect.h].every((value) => Number.isFinite(value) && value >= 0))
        : []
      if (safeRects.length === 0) return ''
      let entry
      try { entry = await ocr.ensurePageBlocks(String(paperId), Number(page)) } catch (error) { return '' }
      if (entry === null || entry === undefined || !Array.isArray(entry.blocks) || entry.blocks.length === 0) return ''
      const width = Number(entry.width) > 0 ? Number(entry.width) : 1
      const height = Number(entry.height) > 0 ? Number(entry.height) : 1
      const boxes = []
      for (const block of entry.blocks) {
        if (block === null || typeof block !== 'object' || typeof block.text !== 'string' || block.text.trim() === '') continue
        const points = Array.isArray(block.box) ? block.box : []
        const xs = points.map((point) => Number(point?.[0])).filter(Number.isFinite)
        const ys = points.map((point) => Number(point?.[1])).filter(Number.isFinite)
        if (xs.length === 0 || ys.length === 0) continue
        const nx = Math.min(...xs) / width
        const ny = Math.min(...ys) / height
        const nw = (Math.max(...xs) - Math.min(...xs)) / width
        const nh = (Math.max(...ys) - Math.min(...ys)) / height
        const centerX = nx + nw / 2
        const centerY = ny + nh / 2
        const hit = safeRects.some((rect) => {
          const inside = centerX >= rect.x && centerX <= rect.x + rect.w && centerY >= rect.y && centerY <= rect.y + rect.h
          const left = Math.max(nx, rect.x)
          const top = Math.max(ny, rect.y)
          const right = Math.min(nx + nw, rect.x + rect.w)
          const bottom = Math.min(ny + nh, rect.y + rect.h)
          return inside || (right > left && bottom > top && (right - left) * (bottom - top) / Math.max(1e-6, nw * nh) >= 0.3)
        })
        if (hit) boxes.push({ x: nx, y: ny, text: block.text.trim() })
      }
      if (boxes.length === 0) return ''
      boxes.sort((left, right) => (Math.abs(left.y - right.y) > 0.01 ? left.y - right.y : left.x - right.x))
      return boxes.map((box) => box.text).join(' ').replace(/\s+/g, ' ').trim()
    },

    /**
     * `pageTextForAi` — quality-gated page text for LLM/AI consumers (v0.17).
     *
     * Publisher PDFs with broken font encodings can yield glyph-code text
     * ("4XHVWLRQ $VLGH ..."); feeding that to the model silently corrupts the
     * paper's scientific content. Order of preference:
     *   1. stored text layer when it reads like prose;
     *   2. cached OCR text of the page;
     *   3. on-demand OCR (when installed/enabled);
     *   4. deterministic Caesar-shift repair as a last resort;
     *   5. stored text marked `lowQuality:true` so callers can refuse it.
     * @param {string} paperId paper id.
     * @param {number} page 1-based page.
     * @returns {Promise<{text:string, source:string, quality:object, lowQuality:boolean}|null>} page text.
     */
    async pageTextForAi(paperId, page) {
      const id = String(paperId ?? '')
      const pageNumber = Number(page)
      if (id === '' || !Number.isInteger(pageNumber) || pageNumber < 1) return null
      const row = db.prepare('SELECT text, ocr_text FROM paper_pages WHERE paper_id = ? AND page = ?').get(id, pageNumber)
      if (row === undefined) return null
      const stored = typeof row.text === 'string' ? row.text : ''
      const quality = assessTextQuality(stored)
      if (quality.ok === true) return { text: stored, source: 'pdf', quality, lowQuality: false }
      const cachedOcr = typeof row.ocr_text === 'string' ? row.ocr_text.trim() : ''
      if (cachedOcr !== '') {
        const ocrQuality = assessTextQuality(cachedOcr)
        if (ocrQuality.ok === true) return { text: cachedOcr, source: 'ocr-cache', quality: ocrQuality, lowQuality: false }
      }
      const ocr = attached.ocr
      if (ocr !== undefined && ocr !== null && typeof ocr.ensurePageText === 'function') {
        try {
          const fresh = await ocr.ensurePageText(id, pageNumber)
          if (typeof fresh === 'string' && fresh.trim() !== '') {
            const ocrQuality = assessTextQuality(fresh)
            if (ocrQuality.ok === true) return { text: fresh, source: 'ocr', quality: ocrQuality, lowQuality: false }
          }
        } catch (error) { /* optional OCR capability */ }
      }
      const repaired = repairCaesarShift(stored)
      if (repaired !== null) {
        const repairedQuality = assessTextQuality(repaired)
        if (repairedQuality.ok === true) return { text: repaired, source: 'caesar-repair', quality: repairedQuality, lowQuality: false }
      }
      return { text: stored, source: 'pdf', quality, lowQuality: true }
    },

    /**
     * `readableAbstract` — return a human-readable abstract for one paper.
     *
     * Some publisher PDFs store a generic metadata/value ("Published by …") or
     * the author-affiliation block as `abstract`; for the read tools we take the
     * stored text only when it actually looks like an abstract, otherwise derive
     * it from the first-page layout. Read-only: never mutates the database.
     * @param {string} paperId paper id.
     * @returns {{text:string|null, source:string|null, corrected:boolean}|null} readable abstract.
     */
    readableAbstract(paperId) {
      const id = String(paperId ?? '')
      if (id === '') return null
      const row = db.prepare('SELECT id, abstract, abstract_source FROM papers WHERE id = ?').get(id)
      if (row === undefined) return null
      const stored = typeof row.abstract === 'string' ? row.abstract.trim() : ''
      if (stored !== '' && looksLikeAbstractText(stored)) {
        return { text: stored, source: row.abstract_source ?? null, corrected: false }
      }
      const derived = deriveAbstractFromStoredLayout(id)
      if (derived !== null) return { text: derived.text, source: derived.source, corrected: true }
      return stored === '' ? { text: null, source: null, corrected: false } : { text: stored, source: row.abstract_source ?? null, corrected: false }
    },

    /**
     * `library.update` — metadata patch with optimistic revision check.
     * @param {object} params id/patch/expectedRevision/operationId.
     * @returns {{paper:object, revision:number}}
     */
    libraryUpdate(params = {}) {
      const id = String(params.id ?? '')
      const patch = params.patch ?? {}
      if (id === '') throw invalid('library.update requires id')
      if (typeof patch !== 'object' || patch === null || Array.isArray(patch)) throw invalid('patch must be an object')
      const allowed = new Set([
        'titleZh', 'displayTitle', 'field', 'tags', 'addTags', 'removeTags', 'authors', 'venue', 'year', 'doi', 'note',
        'title', 'abstract', 'read', 'keywords', 'readingProgress', 'impactFactor', 'impactFactorYear',
        'fiveYearImpactFactor', 'quartile', 'issn', 'publisher', 'citationCount',
      ])
      const unknown = Object.keys(patch).filter((key) => !allowed.has(key))
      if (unknown.length > 0) throw invalid(`unsupported patch fields: ${unknown.join(', ')}`)
      return withOperation('library.update', params.operationId, () => {
        const row = requirePaperRow(id)
        const undoBefore = updateUndoSnapshot(row, patch)
        const tagsBefore = tagNamesSnapshot(id)
        if (params.expectedRevision !== undefined && Number(params.expectedRevision) !== Number(row.revision)) {
          throw new DomainError('conflict', `paper ${id} has revision ${row.revision}, not ${params.expectedRevision}`, {
            id,
            currentRevision: Number(row.revision),
          })
        }
        const values = {}
        if (Object.hasOwn(patch, 'titleZh')) {
          values.title_zh = nullableString(patch.titleZh, 'titleZh')
          values.title_zh_source = values.title_zh === null ? null : 'human'
        }
        if (Object.hasOwn(patch, 'read')) values.read = patch.read === false ? 0 : 1
        if (Object.hasOwn(patch, 'displayTitle')) values.display_title = nullableString(patch.displayTitle, 'displayTitle')
        if (Object.hasOwn(patch, 'field')) values.field = nullableString(patch.field, 'field')
        if (Object.hasOwn(patch, 'venue')) values.venue = nullableString(patch.venue, 'venue')
        if (Object.hasOwn(patch, 'doi')) values.doi = nullableString(patch.doi, 'doi')
        if (Object.hasOwn(patch, 'note')) values.note = nullableString(patch.note, 'note')
        if (Object.hasOwn(patch, 'abstract')) values.abstract = nullableString(patch.abstract, 'abstract')
        if (Object.hasOwn(patch, 'title')) {
          const title = nullableString(patch.title, 'title')
          if (title === null || title.trim() === '') throw invalid('title cannot be empty')
          values.title = title.trim()
        }
        if (Object.hasOwn(patch, 'year')) {
          if (patch.year === null) values.year = null
          else {
            const year = Number(patch.year)
            if (!Number.isInteger(year) || year < 1000 || year > 3000) throw invalid('year must be an integer between 1000 and 3000')
            values.year = year
          }
        }
        if (Object.hasOwn(patch, 'authors')) values.authors_json = JSON.stringify(normalizeAuthors(patch.authors))
        if (Object.hasOwn(patch, 'keywords')) values.keywords_json = JSON.stringify(normalizeKeywords(patch.keywords))
        if (Object.hasOwn(patch, 'readingProgress')) {
          const progress = Number(patch.readingProgress)
          if (!Number.isFinite(progress)) throw invalid('readingProgress must be a number between 0 and 100')
          values.reading_progress = clampInt(Math.round(progress), 0, 100, 0)
          if (values.reading_progress === 100) values.read = 1
          else if (Object.hasOwn(patch, 'read') === false && values.reading_progress > 0) values.read = 0
        }
        const metricFields = {}
        for (const key of ['impactFactor', 'impactFactorYear', 'fiveYearImpactFactor', 'quartile', 'issn', 'publisher', 'citationCount']) {
          if (Object.hasOwn(patch, key)) metricFields[key] = patch[key]
        }
        const now = nowIso()
        transaction(db, () => {
          const assignments = Object.keys(values).map((column) => `${column} = ?`)
          db.prepare(
            `UPDATE papers SET ${[...assignments, 'revision = revision + 1', 'updated_at = ?'].join(', ')} WHERE id = ?`,
          ).run(...Object.values(values), now, id)
          applyPaperTagPatch(id, patch, now)
        })
        reindexPaper(id)
        if (Object.keys(metricFields).length > 0) applyManualMetrics(id, metricFields)
        recordEvent('library.update', id, { fields: Object.keys(patch) })
        const operationId = recordOperation({
          kind: 'library.update',
          summary: `编辑论文（${Object.keys(patch).slice(0, 3).join('、')}${Object.keys(patch).length > 3 ? '…' : ''}）`,
          target: { paperId: id, fields: Object.keys(patch) },
          undo: { paperId: id, before: undoBefore, tags: tagsBefore },
        })
        const updated = requirePaperRow(id)
        return { paper: paperDetail(updated), revision: Number(updated.revision), operationId }
      })
    },

    /**
     * Extra (non-contract) convenience: mark papers read/unread without a full patch.
     * @param {{ids:string[], read:boolean, operationId?:string}} params request.
     * @returns {{results:Array<{id:string,ok:boolean,read?:boolean}>, readCount:number}}
     */
    librarySetRead(params = {}) {
      // v0.2 sends {id, read}; v0.1 sent {ids, read}. Both are idempotent.
      const ids = Array.isArray(params.ids)
        ? params.ids.map(String)
        : typeof params.id === 'string' && params.id !== ''
          ? [params.id]
          : []
      if (ids.length === 0) throw invalid('library.setRead requires id or ids')
      const read = params.read === false ? 0 : 1
      return withOperation('library.setRead', params.operationId, () => {
        const now = nowIso()
        const results = []
        const before = ids
          .map((id) => db.prepare('SELECT id, read FROM papers WHERE id = ?').get(id))
          .filter((row) => row !== undefined)
          .map((row) => ({ id: row.id, read: Number(row.read ?? 0) }))
        for (const id of ids) {
          const row = db.prepare('SELECT id FROM papers WHERE id = ?').get(id)
          if (row === undefined) {
            results.push({ id, ok: false })
            continue
          }
          db.prepare('UPDATE papers SET read = ?, updated_at = ?, revision = revision + 1 WHERE id = ?').run(read, now, id)
          results.push({ id, ok: true, read: read === 1 })
        }
        recordEvent('library.setRead', ids.length === 1 ? ids[0] : null, { ids, read })
        const operationId = recordOperation({
          kind: 'library.setRead',
          summary: `${read === 1 ? '标记已读' : '标记未读'}（${before.length} 篇）`,
          target: { ids },
          undo: { before },
        })
        return {
          results,
          readCount: countRows(db, 'papers', 'read = 1'),
          operationId,
          ...(ids.length === 1 ? { id: ids[0], read: read === 1, ok: results[0]?.ok === true } : {}),
        }
      })
    },

    /**
     * `library.delete` — soft delete into the recycle bin and bump the epoch.
     * @param {object} params ids/operationId.
     * @returns {{results:object[], trashCount:number}}
     */
    libraryDelete(params = {}) {
      const ids = normalizeIds(params.ids, 'library.delete')
      return withOperation('library.delete', params.operationId, () => {
        const now = nowIso()
        const results = []
        transaction(db, () => {
          for (const id of ids) {
            const row = db.prepare('SELECT id, state FROM papers WHERE id = ?').get(id)
            if (row === undefined) {
              results.push({ id, ok: false, error: 'not_found' })
              continue
            }
            db.prepare(
              "UPDATE papers SET state = 'trash', epoch = epoch + 1, revision = revision + 1, deleted_at = ?, updated_at = ? WHERE id = ?",
            ).run(now, now, id)
            results.push({ id, ok: true, state: 'trash' })
          }
        })
        for (const result of results) if (result.ok) recordEvent('library.delete', result.id, { state: 'trash' })
        const deletedIds = results.filter((result) => result.ok).map((result) => result.id)
        const operationId = deletedIds.length === 0 ? undefined : recordOperation({
          kind: 'library.delete',
          summary: `移入回收站（${deletedIds.length} 篇）`,
          target: { ids: deletedIds },
          undo: { ids: deletedIds },
        })
        return { results, trashCount: countRows(db, 'papers', "state = 'trash'"), ...(operationId === undefined ? {} : { operationId }) }
      })
    },

    /**
     * `library.restore` — return papers to the active library with a fresh epoch.
     * @param {object} params ids/operationId.
     * @returns {{results:object[], epoch:number}}
     */
    libraryRestore(params = {}) {
      const ids = normalizeIds(params.ids, 'library.restore')
      return withOperation('library.restore', params.operationId, () => {
        const now = nowIso()
        const results = []
        let epoch = 0
        transaction(db, () => {
          for (const id of ids) {
            const row = db.prepare('SELECT id, epoch FROM papers WHERE id = ?').get(id)
            if (row === undefined) {
              results.push({ id, ok: false, error: 'not_found' })
              continue
            }
            db.prepare(
              "UPDATE papers SET state = 'active', epoch = epoch + 1, revision = revision + 1, deleted_at = NULL, updated_at = ? WHERE id = ?",
            ).run(now, id)
            const fresh = db.prepare('SELECT epoch FROM papers WHERE id = ?').get(id)
            epoch = Math.max(epoch, Number(fresh?.epoch ?? 0))
            results.push({ id, ok: true, state: 'active', epoch: Number(fresh?.epoch ?? 0) })
          }
        })
        for (const result of results) if (result.ok) recordEvent('library.restore', result.id, { epoch: result.epoch })
        const restoredIds = results.filter((result) => result.ok).map((result) => result.id)
        const operationId = restoredIds.length === 0 ? undefined : recordOperation({
          kind: 'library.restore',
          summary: `从回收站恢复（${restoredIds.length} 篇）`,
          target: { ids: restoredIds },
          undo: { ids: restoredIds },
        })
        return { results, epoch, ...(operationId === undefined ? {} : { operationId }) }
      })
    },

    /**
     * `library.purge` — physically delete papers and derived rows/files.
     * @param {object} params ids/operationId.
     * @returns {{results:Array<{id:string,ok:boolean,error?:string}>}}
     */
    libraryPurge(params = {}) {
      const ids = normalizeIds(params.ids, 'library.purge')
      return withOperation('library.purge', params.operationId, () => {
        const results = []
        const purged = []
        for (const id of ids) {
          const row = db.prepare('SELECT id FROM papers WHERE id = ?').get(id)
          if (row === undefined) {
            results.push({ id, ok: false, error: 'not_found' })
            continue
          }
          const versions = db.prepare('SELECT sha256, file_path FROM paper_versions WHERE paper_id = ?').all(id)
          const figures = db.prepare('SELECT id, file_name, thumb_name FROM figures WHERE paper_id = ?').all(id)
          transaction(db, () => {
            db.prepare('DELETE FROM figures WHERE paper_id = ?').run(id)
            db.prepare('DELETE FROM annotations WHERE paper_id = ?').run(id)
            db.prepare('DELETE FROM notes WHERE paper_id = ?').run(id)
            // v0.17: a purged paper disappears from every notes workbench link, but
            // the note documents themselves are never deleted by a paper purge.
            db.prepare('DELETE FROM note_paper_links WHERE paper_id = ?').run(id)
            db.prepare('DELETE FROM paper_tags WHERE paper_id = ?').run(id)
            db.prepare('DELETE FROM sources WHERE paper_id = ?').run(id)
            db.prepare('DELETE FROM paper_pages WHERE paper_id = ?').run(id)
            db.prepare('DELETE FROM paper_versions WHERE paper_id = ?').run(id)
            db.prepare('DELETE FROM papers WHERE id = ?').run(id)
          })
          attached.search?.removePaperIndex?.(id)
          for (const figure of figures) removeFigureFiles(layout, figure)
          removePaperCacheFiles(layout, id, figures.map((figure) => figure.id))
          for (const version of versions) removeFileIfUnreferenced(db, version)
          recordEvent('library.purge', id, {})
          purged.push(id)
          results.push({ id, ok: true })
        }
        const operationId = purged.length === 0 ? undefined : recordOperation({
          kind: 'library.purge',
          summary: `永久删除（${purged.length} 篇，不可撤销）`,
          target: { ids: purged },
          undo: {},
        })
        return { results, ...(operationId === undefined ? {} : { operationId }) }
      })
    },

    /**
     * Extra (non-contract) convenience: all tag names with usage counts.
     * @returns {{items:Array<{name:string,count:number}>}}
     */
    libraryTags() {
      const items = db
        .prepare(
          `SELECT t.name AS name, COUNT(pt.paper_id) AS count
           FROM tags t LEFT JOIN paper_tags pt ON pt.tag_id = t.id
           GROUP BY t.id ORDER BY t.name`,
        )
        .all()
        .map((row) => ({ name: row.name, count: Number(row.count ?? 0) }))
      return { items }
    },

    /* ---------------------- reader -------------------------------- */

    /**
     * `reader.open`
     * @param {{id:string, page?:number}} params reader request.
     * @returns {object} reader payload.
     */
    /**
     * Delegate one translation request to the v0.4 engine chain, mapping its
     * plain error codes onto the API's DomainError vocabulary.
     * @param {Function} run translation service call.
     * @returns {Promise<unknown>} translation payload.
     */
    async _translateCall(run) {
      try {
        return await run()
      } catch (error) {
        const code = error?.code
        const domainCode = code === 'not_found' ? 'not_found' : code === 'invalid' || code === 'invalid_provider' ? 'invalid' : 'internal'
        throw new DomainError(domainCode, String(error?.message ?? error), {})
      }
    },

    readerOpen(params = {}) {
      const id = String(params.id ?? '')
      if (id === '') throw invalid('reader.open requires id')
      const row = requirePaperRow(id)
      // Contract §4: the recycle bin leaves every new read — the reader included.
      if (row.state !== 'active') throw notFound(`paper ${id} is not active; restore it from the recycle bin first`, { id, state: row.state })
      const version = latestVersion(id)
      const detail = paperDetail(row)
      try {
        db.prepare('UPDATE papers SET last_read_at = ? WHERE id = ?').run(nowIso(), id)
      } catch {}
      const pageRows = db.prepare('SELECT page, width, height, text_chars FROM paper_pages WHERE paper_id = ? ORDER BY page').all(id)
      const pages = pageRows.map((pageRow) => ({
        page: Number(pageRow.page),
        imageUrl: `/pappers-hall/page/${id}/${pageRow.page}.png?width=1400`,
        width: pageRow.width === null ? null : Math.round(Number(pageRow.width)),
        height: pageRow.height === null ? null : Math.round(Number(pageRow.height)),
        textChars: Number(pageRow.text_chars ?? 0),
      }))
      const pageCount = pages.length > 0 ? pages.length : version?.page_count !== undefined && version?.page_count !== null ? Number(version.page_count) : 0
      const requestedPage = clampInt(params.page ?? 1, 1, Math.max(1, pageCount), 1)
      return {
        paper: detail,
        version:
          version === undefined
            ? null
            : {
                id: version.id,
                sha256: version.sha256,
                pageCount: version.page_count === null ? null : Number(version.page_count),
                sourceVersion: version.source_version ?? null,
              },
        pages,
        currentPage: pageCount === 0 ? null : requestedPage,
        toc: tableOfContents(id),
        figures: db.prepare('SELECT * FROM figures WHERE paper_id = ? ORDER BY page, id').all(id).map(toFigureRef),
        annotations: db
          .prepare("SELECT * FROM annotations WHERE paper_id = ? AND state = 'active' ORDER BY page, created_at")
          .all(id)
          .map(toAnnotation),
        notes: notesOf(id),
      }
    },

    /**
     * Normalize the block order of a stale (pre-v0.2) stored layout so the Client
     * reading-order contract holds even while the background re-layout runs.
     * @param {object[]} blocks stored blocks.
     * @returns {object[]} ordered blocks.
     */
    _orderStaleBlocks(blocks) {
      const rank = (role) => (role === 'header' ? 0 : role === 'footer' ? 3 : 1)
      const columnOf = (block) => (block.fullWidth === true ? 0 : Number(block.column ?? 0))
      return [...blocks].sort(
        (left, right) =>
          rank(left.role) - rank(right.role) ||
          columnOf(left) - columnOf(right) ||
          Number(left.bbox?.y ?? 0) - Number(right.bbox?.y ?? 0) ||
          Number(left.bbox?.x ?? 0) - Number(right.bbox?.x ?? 0),
      )
    },

    /**
     * `reader.page` (v0.2) — real paragraph blocks with PDF-point bboxes.
     *
     * An old v0.1 library row has no layout yet; the request then schedules the
     * lazy `structure` background job and returns `structureState:'pending'` so
     * the Client can show plain text and poll instead of blocking the request.
     * @param {{id:string, page:number}} params page request.
     * @returns {object} one page payload.
     */
    readerPage(params = {}) {
      const id = String(params.id ?? '')
      const page = Number(params.page)
      if (id === '') throw invalid('reader.page requires id')
      if (!Number.isInteger(page) || page < 1) throw invalid('reader.page requires a positive integer page')
      const owner = db.prepare('SELECT id, state, structure_state FROM papers WHERE id = ?').get(id)
      if (owner === undefined) throw notFound(`paper ${id} does not exist`, { id })
      if (owner.state !== 'active') throw notFound(`paper ${id} is not active; restore it from the recycle bin first`, { id, state: owner.state })
      const row = db.prepare('SELECT * FROM paper_pages WHERE paper_id = ? AND page = ?').get(id, page)
      if (row === undefined) throw notFound(`page ${page} of paper ${id} was not extracted`, { id, page })
      // v0.4 discover feed: remember the last actual read for "continue reading".
      try {
        db.prepare('UPDATE papers SET last_read_at = ? WHERE id = ?').run(nowIso(), id)
      } catch {}
      const structure = pageStructure(row)
      // A structure generated by an older layout algorithm is stale: regenerate it
      // in the background instead of showing fragmented v0.1-quality blocks.
      // Structures generated before the PP-DocLayout-S pass have no regions even
      // when their version matches (e.g. the component was installed later), so a
      // page without regions is regenerated once the model is available.
      const layoutService = attached.docLayout
      const hasDocLayout = layoutService !== null && layoutService !== undefined
        && typeof layoutService.available === 'function' && layoutService.available() === true
      const missingRegions = hasDocLayout && structure !== undefined
        && !Array.isArray(structure.regions)
        && Array.isArray(structure.blocks) && structure.blocks.length > 0
      const stale = structure !== undefined
        && (Number(structure.layoutVersion ?? 0) < LAYOUT_VERSION_CURRENT || missingRegions)
      let structureState = structure === undefined || stale ? (owner.structure_state === 'failed' ? 'failed' : 'pending') : 'ready'
      let jobId
      if (structure === undefined || stale) {
        const ensured = ensureStructure(id, { force: stale })
        structureState = ensured.state
        jobId = ensured.jobId
      }
      const annotationCount = Number(
        db.prepare("SELECT COUNT(*) AS count FROM annotations WHERE paper_id = ? AND page = ? AND state = 'active'").get(id, page)?.count ?? 0,
      )
      const size = renderedPageSize(row.width, row.height)
      return {
        page,
        width: row.width === null ? null : Math.round(Number(row.width)),
        height: row.height === null ? null : Math.round(Number(row.height)),
        widthPx: size.widthPx,
        heightPx: size.heightPx,
        imageUrl: `/pappers-hall/page/${id}/${page}.png?width=1400`,
        text: (() => {
          const native = typeof row.text === 'string' ? row.text : ''
          const ocrText = typeof row.ocr_text === 'string' ? row.ocr_text : ''
          return native.trim() !== '' ? native : ocrText
        })(),
        textSource: (() => {
          const native = typeof row.text === 'string' ? row.text : ''
          const ocrText = typeof row.ocr_text === 'string' ? row.ocr_text : ''
          if (native.trim() !== '') return 'pdf'
          return ocrText.trim() !== '' ? 'ocr' : 'none'
        })(),
        // While a stale layout is being regenerated keep showing it: old blocks
        // still carry real text/bboxes, so the reader never flashes empty.
        blocks: structure === undefined ? [] : stale ? this._orderStaleBlocks(structure.blocks ?? []) : structure.blocks,
        columns: structure === undefined ? 1 : (structure.columns ?? 1),
        layoutVersion: structure === undefined || stale ? 0 : (structure.layoutVersion ?? 0),
        annotationCount,
        structureState,
        ...(jobId === undefined ? {} : { jobId }),
      }
    },

    /**
     * `reader.layer` — every word/line box for the text-selection overlay.
     * @param {{id:string, page:number}} params layer request.
     * @returns {object} word and line boxes in PDF points (origin top-left).
     */
    readerLayer(params = {}) {
      const id = String(params.id ?? '')
      const page = Number(params.page)
      if (id === '') throw invalid('reader.layer requires id')
      if (!Number.isInteger(page) || page < 1) throw invalid('reader.layer requires a positive integer page')
      const owner = db.prepare('SELECT id, state FROM papers WHERE id = ?').get(id)
      if (owner === undefined) throw notFound(`paper ${id} does not exist`, { id })
      if (owner.state !== 'active') throw notFound(`paper ${id} is not active; restore it from the recycle bin first`, { id, state: owner.state })
      const row = db.prepare('SELECT * FROM paper_pages WHERE paper_id = ? AND page = ?').get(id, page)
      if (row === undefined) throw notFound(`page ${page} of paper ${id} was not extracted`, { id, page })
      // v0.4 discover feed: remember the last actual read for "continue reading".
      try {
        db.prepare('UPDATE papers SET last_read_at = ? WHERE id = ?').run(nowIso(), id)
      } catch {}
      const structure = pageStructure(row)
      const stale = structure !== undefined && Number(structure.layoutVersion ?? 0) < LAYOUT_VERSION_CURRENT
      if (structure === undefined || stale) {
        const ensured = ensureStructure(id, { force: stale })
        return {
          page,
          width: row.width === null ? null : Math.round(Number(row.width)),
          height: row.height === null ? null : Math.round(Number(row.height)),
          words: [],
          lines: [],
          structureState: ensured.state,
          ...(ensured.jobId === undefined ? {} : { jobId: ensured.jobId }),
        }
      }
      return {
        page,
        width: row.width === null ? null : Math.round(Number(row.width)),
        height: row.height === null ? null : Math.round(Number(row.height)),
        words: Array.isArray(structure.words) ? structure.words : [],
        lines: Array.isArray(structure.lines) ? structure.lines : [],
        structureState: 'ready',
      }
    },

    /**
     * `reader.pageText` — v0.1-compatible plain text of one page.
     * @param {{id:string, page:number}} params request.
     * @returns {{page:number, text:string}} plain text.
     */
    readerPageText(params = {}) {
      const id = String(params.id ?? '')
      const page = Number(params.page)
      if (id === '') throw invalid('reader.pageText requires id')
      if (!Number.isInteger(page) || page < 1) throw invalid('reader.pageText requires a positive integer page')
      const row = db.prepare('SELECT text, ocr_text FROM paper_pages WHERE paper_id = ? AND page = ?').get(id, page)
      if (row === undefined) throw notFound(`page ${page} of paper ${id} was not extracted`, { id, page })
      const native = typeof row.text === 'string' ? row.text : ''
      const ocrText = typeof row.ocr_text === 'string' ? row.ocr_text : ''
      // v0.11: scanned pages have no native text layer; fall back to OCR text.
      if (native.trim() === '' && ocrText.trim() !== '') return { page, text: ocrText, source: 'ocr' }
      return { page, text: native, source: native.trim() === '' ? 'none' : 'pdf' }
    },

    /**
     * `reader.outline` — PDF-outline-substitute from heading blocks, with the
     * v0.1 text heuristic as fallback for libraries that are still pending.
     * @param {{id:string}} params request.
     * @returns {{items:Array<{title:string,page:number,level:number}>, source:string}}
     */
    readerOutline(params = {}) {
      const id = String(params.id ?? '')
      if (id === '') throw invalid('reader.outline requires id')
      const row = requirePaperRow(id)
      const stored = parseJson(row.outline_json, [])
      if (Array.isArray(stored) && stored.length > 0) return { items: stored, source: 'pdf_headings' }
      const heuristic = tableOfContents(id).map((item) => ({ title: item.title, page: item.page, level: 1 }))
      return { items: heuristic, source: heuristic.length > 0 ? 'text_heuristic' : 'none' }
    },

    /* ---------------------- figures ------------------------------- */

    /**
     * `figures.list`
     * @param {{paperId:string}} params paper id.
     * @returns {object[]} FigureRef list.
     */
    figuresList(params = {}) {
      const paperId = String(params.paperId ?? '')
      if (paperId === '') throw invalid('figures.list requires paperId')
      const rows = db.prepare('SELECT * FROM figures WHERE paper_id = ? ORDER BY page, id').all(paperId)
      return rows.map(toFigureRef)
    },

    /**
     * One figure row plus the paper summary, used by image assets and tools.
     * @param {string} figureId figure id.
     * @returns {{figure:object, paperRow:object}}
     */
    figureRecord(figureId) {
      const row = db.prepare('SELECT * FROM figures WHERE id = ?').get(figureId)
      if (row === undefined) throw notFound(`figure ${figureId} does not exist`, { id: figureId })
      const paperRow = requirePaperRow(row.paper_id)
      return { figure: toFigureRef(row), paperRow }
    },

    /* ---------------------- annotations --------------------------- */

    /**
     * `annotations.list`
     * @param {{paperId:string, versionId?:string}} params list request.
     * @returns {object[]} Annotation list.
     */
    annotationsList(params = {}) {
      const paperId = String(params.paperId ?? '')
      if (paperId === '') throw invalid('annotations.list requires paperId')
      const state = params.state === 'trash' ? 'trash' : params.state === 'all' ? 'all' : 'active'
      const clauses = ['paper_id = ?']
      const values = [paperId]
      if (state !== 'all') {
        clauses.push('state = ?')
        values.push(state)
      }
      if (typeof params.versionId === 'string' && params.versionId !== '') {
        clauses.push('version_id = ?')
        values.push(params.versionId)
      }
      if (Number.isInteger(params.page)) {
        clauses.push('page = ?')
        values.push(params.page)
      }
      return db
        .prepare(`SELECT * FROM annotations WHERE ${clauses.join(' AND ')} ORDER BY page, created_at`)
        .all(...values)
        .map(toAnnotation)
    },

    /**
     * `annotations.create`
     * @param {object} params annotation payload.
     * @returns {{annotation:object}}
     */
    annotationsCreate(params = {}) {
      const paperId = String(params.paperId ?? '')
      if (paperId === '') throw invalid('annotations.create requires paperId')
      const origin = String(params.origin ?? 'user_note')
      if (!['user_note', 'test_note', 'ai_explanation'].includes(origin)) throw invalid(`unsupported annotation origin ${origin}`)
      const kind = params.kind === undefined || params.kind === null ? inferAnnotationKind(params) : String(params.kind)
      if (!ANNOTATION_KINDS.has(kind)) throw invalid(`unsupported annotation kind ${kind}`)
      const rects = normalizeRects(params.rects)
      const legacyRect = normalizeLegacyRect(params.rect)
      if (kind !== 'note' && rects.length === 0 && legacyRect === null) throw invalid(`annotation kind "${kind}" requires rects`)
      const comment = typeof params.comment === 'string' ? params.comment.trim() : typeof params.text === 'string' ? params.text.trim() : ''
      const quote = typeof params.quote === 'string' && params.quote.trim() !== '' ? params.quote.trim() : null
      if (kind === 'note' && comment === '') throw invalid('a note annotation requires comment text')
      return withOperation('annotations.create', params.operationId, () => {
        requireActivePaperRow(paperId)
        const version = latestVersion(paperId)
        const page = clampInt(params.page ?? 1, 1, Math.max(1, Number(version?.page_count ?? 1)), 1)
        const pageCount = Number(db.prepare("SELECT COUNT(*) AS count FROM annotations WHERE paper_id = ? AND page = ? AND state = 'active'").get(paperId, page)?.count ?? 0)
        if (pageCount >= 200) throw new DomainError('conflict', `page ${page} already has 200 annotations (limit per page)`, { paperId, page })
        const id = `an-${randomHex(6)}`
        const now = nowIso()
        // `text` stays populated for v0.1 search/tools; v0.2 consumers read `comment`.
        const text = comment !== '' ? comment : (quote ?? '')
        db.prepare(
          `INSERT INTO annotations(id, paper_id, version_id, page, kind, rects_json, quote, comment, text, rect_json, color, origin, state, epoch, created_at, updated_at, revision)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', 0, ?, ?, 0)`,
        ).run(
          id,
          paperId,
          version?.id ?? null,
          page,
          kind,
          JSON.stringify(rects),
          quote,
          comment !== '' ? comment : null,
          text,
          legacyRect === null ? null : JSON.stringify(legacyRect),
          normalizeColor(params.color),
          origin,
          now,
          now,
        )
        attached.search?.indexAnnotation?.(id)
        recordEvent('annotations.create', paperId, { id, origin, kind })
        const operationId = recordOperation({
          kind: 'annotation.create',
          summary: `创建标注（第 ${page} 页 · ${kind}）`,
          target: { paperId, annotationId: id, page },
          undo: { annotationId: id },
        })
        const row = db.prepare('SELECT * FROM annotations WHERE id = ?').get(id)
        return { annotation: toAnnotation(row), operationId }
      })
    },

    /**
     * `annotations.update`
     * @param {object} params id + patch fields.
     * @returns {{annotation:object}}
     */
    annotationsUpdate(params = {}) {
      const id = String(params.id ?? '')
      if (id === '') throw invalid('annotations.update requires id')
      return withOperation('annotations.update', params.operationId, () => {
        const row = db.prepare('SELECT * FROM annotations WHERE id = ?').get(id)
        if (row === undefined) throw notFound(`annotation ${id} does not exist`, { id })
        if (params.expectedRevision !== undefined && Number(params.expectedRevision) !== Number(row.revision)) {
          throw new DomainError('conflict', `annotation ${id} has revision ${row.revision}, not ${params.expectedRevision}`, {
            id,
            currentRevision: Number(row.revision),
          })
        }
        const values = {}
        if (Object.hasOwn(params, 'kind')) {
          const kind = String(params.kind)
          if (!ANNOTATION_KINDS.has(kind)) throw invalid(`unsupported annotation kind ${kind}`)
          values.kind = kind
        }
        if (Object.hasOwn(params, 'comment')) values.comment = typeof params.comment === 'string' ? params.comment.trim() : null
        if (Object.hasOwn(params, 'text')) {
          const text = typeof params.text === 'string' ? params.text.trim() : ''
          if (text === '') throw invalid('text cannot be empty')
          values.text = text
        }
        if (Object.hasOwn(params, 'quote')) values.quote = typeof params.quote === 'string' ? params.quote : null
        if (Object.hasOwn(params, 'color')) values.color = normalizeColor(params.color)
        if (Object.hasOwn(params, 'rects')) values.rects_json = JSON.stringify(normalizeRects(params.rects))
        if (Object.hasOwn(params, 'rect')) values.rect_json = normalizeLegacyRect(params.rect) === null ? null : JSON.stringify(normalizeLegacyRect(params.rect))
        if (Object.keys(values).length === 0) throw invalid('annotations.update requires at least one field')
        const now = nowIso()
        const assignments = Object.keys(values).map((column) => `${column} = ?`)
        db.prepare(`UPDATE annotations SET ${[...assignments, 'updated_at = ?', 'revision = revision + 1'].join(', ')} WHERE id = ?`).run(
          ...Object.values(values),
          now,
          id,
        )
        attached.search?.indexAnnotation?.(id)
        recordEvent('annotations.update', row.paper_id, { id })
        const before = {}
        for (const column of Object.keys(values)) before[column] = row[column] ?? null
        const operationId = recordOperation({
          kind: 'annotation.update',
          summary: `修改标注（第 ${Number(row.page)} 页）`,
          target: { paperId: row.paper_id, annotationId: id, page: Number(row.page) },
          undo: { annotationId: id, before },
        })
        return { annotation: toAnnotation(db.prepare('SELECT * FROM annotations WHERE id = ?').get(id)), operationId }
      })
    },

    /**
     * `annotations.delete` — soft delete (recycle bin semantics per object).
     * @param {{id:string, operationId?:string}} params delete request.
     * @returns {{id:string, ok:boolean, state:string}}
     */
    annotationsDelete(params = {}) {
      const id = String(params.id ?? '')
      if (id === '') throw invalid('annotations.delete requires id')
      return withOperation('annotations.delete', params.operationId, () => {
        const row = db.prepare('SELECT * FROM annotations WHERE id = ?').get(id)
        if (row === undefined) throw notFound(`annotation ${id} does not exist`, { id })
        db.prepare("UPDATE annotations SET state = 'trash', epoch = epoch + 1, updated_at = ? WHERE id = ?").run(nowIso(), id)
        attached.search?.removeAnnotationIndex?.(id)
        recordEvent('annotations.delete', row.paper_id, { id })
        const operationId = recordOperation({
          kind: 'annotation.delete',
          summary: `删除标注（第 ${Number(row.page)} 页）`,
          target: { paperId: row.paper_id, annotationId: id, page: Number(row.page) },
          undo: { annotationId: id },
        })
        return { id, ok: true, state: 'trash', operationId }
      })
    },

    /* ---------------------- notes -------------------------------- */

    /**
     * `notes.create`
     * @param {object} params note payload.
     * @returns {{note:object}}
     */
    notesCreate(params = {}) {
      const text = typeof params.text === 'string' ? params.text.trim() : ''
      if (text === '') throw invalid('notes.create requires non-empty text')
      const origin = String(params.origin ?? 'user_note')
      if (!['user_note', 'ai_explanation'].includes(origin)) throw invalid(`unsupported note origin ${origin}`)
      return withOperation('notes.create', params.operationId, () => {
        const paperId = typeof params.paperId === 'string' && params.paperId !== '' ? params.paperId : null
        if (paperId !== null) requireActivePaperRow(paperId)
        const sourceRefs = Array.isArray(params.sourceRefs) ? params.sourceRefs : []
        for (const [index, ref] of sourceRefs.entries()) {
          if (ref === null || typeof ref !== 'object') throw invalid(`sourceRefs[${index}] must be an object`)
          if (typeof ref.kind !== 'string' || typeof ref.id !== 'string') throw invalid(`sourceRefs[${index}] needs kind and id`)
        }
        const id = `nt-${randomHex(6)}`
        const now = nowIso()
        db.prepare(
          `INSERT INTO notes(id, paper_id, title, text, origin, source_refs_json, state, epoch, created_at, updated_at, revision)
           VALUES (?, ?, ?, ?, ?, ?, 'active', 0, ?, ?, 0)`,
        ).run(
          id,
          paperId,
          typeof params.title === 'string' && params.title.trim() !== '' ? params.title.trim() : null,
          text,
          origin,
          JSON.stringify(sourceRefs),
          now,
          now,
        )
        attached.search?.indexNote?.(id)
        recordEvent('notes.create', paperId, { id, origin })
        return { note: toNote(db.prepare('SELECT * FROM notes WHERE id = ?').get(id)) }
      })
    },

    /**
     * `notes.delete`
     * @param {{id:string, operationId?:string}} params delete request.
     * @returns {{id:string, ok:boolean, state:string}}
     */
    notesDelete(params = {}) {
      const id = String(params.id ?? '')
      if (id === '') throw invalid('notes.delete requires id')
      return withOperation('notes.delete', params.operationId, () => {
        const row = db.prepare('SELECT * FROM notes WHERE id = ?').get(id)
        if (row === undefined) throw notFound(`note ${id} does not exist`, { id })
        db.prepare("UPDATE notes SET state = 'trash', epoch = epoch + 1, updated_at = ? WHERE id = ?").run(nowIso(), id)
        attached.search?.removeNoteIndex?.(id)
        recordEvent('notes.delete', row.paper_id, { id })
        return { id, ok: true, state: 'trash' }
      })
    },

    /* ---------------------- collections & tags -------------------- */

    /**
     * `library.collections.list` — all v0.6 folders (there is no read-only layer).
     * Non-field folders still report `kind:'custom'` for v0.2–v0.5 compatibility;
     * `library.folders.tree` reports the canonical `kind:'folder'`.
     * @returns {{items:Array<{id:string,name:string,color:string|null,order:number,count:number,kind:string}>}}
     */
    libraryCollectionsList() {
      const items = db
        .prepare('SELECT * FROM collections ORDER BY sort_order ASC, name ASC')
        .all()
        .map((row) => {
          const count = Number(
            db
              .prepare(
                "SELECT COUNT(*) AS count FROM paper_collections pc JOIN papers p ON p.id = pc.paper_id WHERE pc.collection_id = ? AND p.state = 'active'",
              )
              .get(row.id)?.count ?? 0,
          )
          return {
            id: row.id,
            name: row.name,
            color: row.color ?? null,
            order: Number(row.sort_order ?? 0),
            count,
            kind: 'custom',
            parentId: row.parent_id ?? null,
            depth: folderDepth(row.id),
          }
        })
      return { items }
    },

    /**
     * `library.folders.tree` — nested folder tree (v0.5 Zotero-style).
     * `count` includes papers in descendant folders; field collections are inert
     * read-only roots so the sidebar can still filter by domain.
     * @returns {{items:object[], total:number, folderCount:number, fieldCount:number}}
     */
    libraryFoldersTree() {
      const rows = db.prepare('SELECT * FROM collections ORDER BY sort_order ASC, name ASC').all()
      const byParent = new Map()
      for (const row of rows) {
        const parent = row.parent_id === null || row.parent_id === undefined ? null : row.parent_id
        const list = byParent.get(parent ?? '__root__') ?? []
        list.push(row)
        byParent.set(parent ?? '__root__', list)
      }
      const directCounts = new Map()
      for (const row of db.prepare("SELECT pc.collection_id AS collection_id, COUNT(DISTINCT pc.paper_id) AS count FROM paper_collections pc JOIN papers p ON p.id = pc.paper_id AND p.state = 'active' GROUP BY pc.collection_id").all()) {
        directCounts.set(row.collection_id, Number(row.count ?? 0))
      }
      const build = (parentKey) => {
        const list = byParent.get(parentKey) ?? []
        return list.map((row) => {
          const children = build(row.id)
          // Contract v0.5/v0.6: count is the number of UNIQUE papers in the folder
          // plus every descendant folder (same semantics as library.list folderId),
          // so a paper assigned to two sub-folders is counted once.
          const subtreeIds = descendantFolderIds(row.id)
          const count = Number(
            db
              .prepare(
                `SELECT COUNT(DISTINCT pc.paper_id) AS count FROM paper_collections pc
                 JOIN papers p ON p.id = pc.paper_id AND p.state = 'active'
                 WHERE pc.collection_id IN (${subtreeIds.map(() => '?').join(',')})`,
              )
              .get(...subtreeIds)?.count ?? 0,
          )
          return {
            id: row.id,
            name: row.name,
            color: row.color ?? null,
            kind: 'folder',
            count,
            directCount: directCounts.get(row.id) ?? 0,
            depth: folderDepth(row.id),
            children,
          }
        })
      }
      const items = build('__root__')
      const folders = items.length + items.reduce((sum, item) => sum + countFolderNodes(item), 0)
      return { items, total: items.length, folderCount: folders, fieldCount: 0 }
    },

    /**
     * `library.setFavorite` — toggle the single favorite star for papers.
     * @param {{ids:string[], favorite?:boolean, operationId?:string}} params request.
     * @returns {{results:object[], favoriteCount:number, operationId?:string}}
     */
    librarySetFavorite(params = {}) {
      const ids = normalizeIds(params.ids ?? (typeof params.id === 'string' ? [params.id] : undefined), 'library.setFavorite')
      const favorite = params.favorite === false ? 0 : 1
      return withOperation('library.setFavorite', params.operationId, () => {
        const before = ids
          .map((id) => db.prepare('SELECT id, favorite FROM papers WHERE id = ?').get(id))
          .filter((row) => row !== undefined)
          .map((row) => ({ id: row.id, favorite: Number(row.favorite ?? 0) }))
        const now = nowIso()
        const results = []
        transaction(db, () => {
          for (const id of ids) {
            const row = db.prepare('SELECT id FROM papers WHERE id = ?').get(id)
            if (row === undefined) {
              results.push({ id, ok: false, error: 'not_found' })
              continue
            }
            db.prepare('UPDATE papers SET favorite = ?, updated_at = ?, revision = revision + 1 WHERE id = ?').run(favorite, now, id)
            results.push({ id, ok: true, favorite: favorite === 1 })
          }
        })
        recordEvent('library.setFavorite', null, { ids, favorite: favorite === 1 })
        const changed = results.filter((result) => result.ok).map((result) => result.id)
        const operationId = changed.length === 0 ? undefined : recordOperation({
          kind: 'library.setFavorite',
          summary: `${favorite === 1 ? '收藏' : '取消收藏'}（${changed.length} 篇）`,
          target: { ids: changed, favorite: favorite === 1 },
          undo: { before },
        })
        return {
          results,
          favoriteCount: Number(db.prepare('SELECT COUNT(*) AS count FROM papers WHERE state = ? AND favorite = 1').get('active')?.count ?? 0),
          ...(operationId === undefined ? {} : { operationId }),
        }
      })
    },

    /**
     * `library.collections.create`
     * @param {{name:string,color?:string,order?:number,operationId?:string}} params request.
     * @returns {{collection:object}}
     */
    libraryCollectionsCreate(params = {}) {
      const name = typeof params.name === 'string' ? params.name.trim() : ''
      if (name === '') throw invalid('collection name is required')
      if (name.length > 80) throw invalid('collection name is too long')
      return withOperation('library.collections.create', params.operationId, () => {
        let parentId = null
        if (params.parentId !== undefined && params.parentId !== null && params.parentId !== '') {
          parentId = String(params.parentId)
          const parent = collectionRowById(parentId)
          if (parent === undefined) throw notFound(`parent folder ${parentId} does not exist`, { parentId })
          // depth limit 6 levels (root folder = level 1)
          if (folderDepth(parentId) + 2 > 6) throw invalid('folder nesting depth limit is 6', { parentId })
        }
        const clash = db
          .prepare("SELECT id FROM collections WHERE name = ? AND IFNULL(parent_id, '') = IFNULL(?, '')")
          .get(name, parentId)
        if (clash !== undefined) throw new DomainError('conflict', `folder "${name}" already exists here`, { name, id: clash.id })
        const id = `cl-${randomHex(6)}`
        const now = nowIso()
        const order =
          Number.isInteger(params.order) ? params.order : Number(db.prepare('SELECT COALESCE(MAX(sort_order), 0) + 1 AS next FROM collections').get()?.next ?? 0)
        db.prepare(
          "INSERT INTO collections(id, name, color, sort_order, kind, field_key, parent_id, created_at, updated_at) VALUES (?, ?, ?, ?, 'folder', NULL, ?, ?, ?)",
        ).run(id, name, typeof params.color === 'string' ? params.color : null, order, parentId, now, now)
        recordEvent('library.collections.create', null, { id, name, parentId })
        const operationId = recordOperation({
          kind: 'library.collections.create',
          summary: `新建文件夹「${name}」`,
          target: { collectionId: id, name, parentId },
          undo: { collectionId: id },
        })
        const row = db.prepare('SELECT * FROM collections WHERE id = ?').get(id)
        return {
          collection: { id: row.id, name: row.name, color: row.color, order: Number(row.sort_order), kind: 'custom', parentId: row.parent_id ?? null },
          operationId,
        }
      })
    },

    /**
     * `library.collections.update`
     * @param {{id:string,name?:string,color?:string,order?:number,operationId?:string}} params request.
     * @returns {{collection:object}}
     */
    libraryCollectionsUpdate(params = {}) {
      const id = String(params.id ?? '')
      if (id === '') throw invalid('library.collections.update requires id')
      return withOperation('library.collections.update', params.operationId, () => {
        const row = db.prepare('SELECT * FROM collections WHERE id = ?').get(id)
        if (row === undefined) throw notFound(`collection ${id} does not exist`, { id })
        const values = {}
        let nextParentId = row.parent_id ?? null
        if (Object.hasOwn(params, 'name')) {
          const name = typeof params.name === 'string' ? params.name.trim() : ''
          if (name === '') throw invalid('collection name cannot be empty')
          values.name = name
        }
        if (Object.hasOwn(params, 'color')) values.color = typeof params.color === 'string' ? params.color : null
        if (Object.hasOwn(params, 'order')) {
          if (!Number.isFinite(Number(params.order))) throw invalid('order must be a number')
          values.sort_order = Math.trunc(Number(params.order))
        }
        if (Object.hasOwn(params, 'parentId')) {
          const parentId = params.parentId === null || params.parentId === '' ? null : String(params.parentId)
          if (parentId === id) throw invalid('a folder cannot be moved into itself', { id })
          if (parentId !== null) {
            const parent = collectionRowById(parentId)
            if (parent === undefined) throw notFound(`parent folder ${parentId} does not exist`, { parentId })
            if (descendantFolderIds(id).includes(parentId)) throw invalid('a folder cannot be moved into one of its descendants', { id, parentId })
            if (folderDepth(parentId) + 1 + (descendantFolderIds(id).length === 0 ? 1 : 0) > 6) {
              // Conservative depth check: subtree height is bounded by total descendants.
              const height = (() => {
                const ids = descendantFolderIds(id)
                let maxDepth = 0
                for (const candidate of ids) maxDepth = Math.max(maxDepth, folderDepth(candidate) - folderDepth(id))
                return maxDepth
              })()
              if (folderDepth(parentId) + 1 + height + 1 > 6) throw invalid('folder nesting depth limit is 6', { parentId })
            }
          }
          values.parent_id = parentId
          nextParentId = parentId
        }
        if (Object.keys(values).length === 0) throw invalid('nothing to update')
        const name = typeof values.name === 'string' ? values.name : row.name
        const clash = db
          .prepare("SELECT id FROM collections WHERE name = ? AND IFNULL(parent_id, '') = IFNULL(?, '') AND id <> ?")
          .get(name, nextParentId, id)
        if (clash !== undefined) throw new DomainError('conflict', `folder "${name}" already exists here`, { name, id: clash.id })
        const before = { name: row.name, color: row.color ?? null, sort_order: Number(row.sort_order ?? 0), parent_id: row.parent_id ?? null }
        const assignments = Object.keys(values).map((column) => `${column} = ?`)
        db.prepare(`UPDATE collections SET ${[...assignments, 'updated_at = ?'].join(', ')} WHERE id = ?`).run(...Object.values(values), nowIso(), id)
        const operationId = recordOperation({
          kind: 'library.collections.update',
          summary: `编辑文件夹「${row.name}」`,
          target: { collectionId: id, fields: Object.keys(values) },
          undo: { collectionId: id, before },
        })
        const updated = db.prepare('SELECT * FROM collections WHERE id = ?').get(id)
        return {
          collection: { id: updated.id, name: updated.name, color: updated.color, order: Number(updated.sort_order), kind: 'custom', parentId: updated.parent_id ?? null },
          operationId,
        }
      })
    },

    /**
     * `library.collections.delete` — custom collections only.
     * @param {{id:string, operationId?:string}} params request.
     * @returns {{id:string, ok:boolean}}
     */
    libraryCollectionsDelete(params = {}) {
      const id = String(params.id ?? '')
      if (id === '') throw invalid('library.collections.delete requires id')
      return withOperation('library.collections.delete', params.operationId, () => {
        const row = db.prepare('SELECT * FROM collections WHERE id = ?').get(id)
        if (row === undefined) throw notFound(`collection ${id} does not exist`, { id })
        const children = db.prepare('SELECT id FROM collections WHERE parent_id = ?').all(id).map((child) => child.id)
        const memberships = db.prepare('SELECT paper_id FROM paper_collections WHERE collection_id = ?').all(id).map((link) => ({ paperId: link.paper_id }))
        const before = {
          id: row.id,
          name: row.name,
          color: row.color ?? null,
          sort_order: Number(row.sort_order ?? 0),
          kind: row.kind,
          field_key: row.field_key ?? null,
          parent_id: row.parent_id ?? null,
          created_at: row.created_at,
        }
        transaction(db, () => {
          // Promote children to the deleted folder's parent (contract §1.2) instead
          // of deleting a whole subtree; papers are never deleted.
          db.prepare('UPDATE collections SET parent_id = ?, updated_at = ? WHERE parent_id = ?').run(row.parent_id ?? null, nowIso(), id)
          db.prepare('DELETE FROM paper_collections WHERE collection_id = ?').run(id)
          db.prepare('DELETE FROM collections WHERE id = ?').run(id)
        })
        recordEvent('library.collections.delete', null, { id })
        const operationId = recordOperation({
          kind: 'library.collections.delete',
          summary: `删除文件夹「${row.name}」（子文件夹上移）`,
          target: { collectionId: id },
          undo: { before, children, memberships },
        })
        return { id, ok: true, operationId, promotedChildren: children }
      })
    },

    /**
     * `library.collections.assign` — add/remove papers in one custom collection.
     * @param {{collectionId:string, paperIds:string[], add:boolean, operationId?:string}} params request.
     * @returns {{results:Array<{id:string,ok:boolean}>}}
     */
    libraryCollectionsAssign(params = {}) {
      const collectionId = String(params.collectionId ?? '')
      if (collectionId === '') throw invalid('library.collections.assign requires collectionId')
      const ids = normalizeIds(params.paperIds, 'library.collections.assign')
      const add = params.add !== false
      return withOperation('library.collections.assign', params.operationId, () => {
        const collection = db.prepare('SELECT * FROM collections WHERE id = ?').get(collectionId)
        if (collection === undefined) throw notFound(`collection ${collectionId} does not exist`, { collectionId })
        const now = nowIso()
        const results = []
        transaction(db, () => {
          for (const paperId of ids) {
            const paper = db.prepare('SELECT id FROM papers WHERE id = ?').get(paperId)
            if (paper === undefined) {
              results.push({ id: paperId, ok: false, error: 'not_found' })
              continue
            }
            if (add) {
              db.prepare('INSERT OR IGNORE INTO paper_collections(collection_id, paper_id, created_at) VALUES (?, ?, ?)').run(collectionId, paperId, now)
            } else {
              db.prepare('DELETE FROM paper_collections WHERE collection_id = ? AND paper_id = ?').run(collectionId, paperId)
            }
            results.push({ id: paperId, ok: true })
          }
        })
        recordEvent('library.collections.assign', null, { collectionId, add, count: results.length })
        const assignedIds = results.filter((result) => result.ok).map((result) => result.id)
        const operationId = assignedIds.length === 0 ? undefined : recordOperation({
          kind: 'library.collections.assign',
          summary: `${add ? '加入' : '移出'}收藏夹「${collection.name}」（${assignedIds.length} 篇）`,
          target: { collectionId, paperIds: assignedIds, add },
          undo: { collectionId, paperIds: assignedIds, add },
        })
        return { results, ...(operationId === undefined ? {} : { operationId }) }
      })
    },

    /**
     * `tags.list`
     * @returns {{items:Array<{name:string,count:number}>}}
     */
    tagsList() {
      const items = db
        .prepare(
          `SELECT t.name AS name, COUNT(pt.paper_id) AS count
           FROM tags t JOIN paper_tags pt ON pt.tag_id = t.id JOIN papers p ON p.id = pt.paper_id AND p.state = 'active'
           GROUP BY t.id ORDER BY t.name`,
        )
        .all()
        .map((row) => ({ name: row.name, count: Number(row.count ?? 0) }))
      return { items }
    },

    /**
     * `tags.rename` — merge-safe rename across every paper.
     * @param {{from:string, to:string, operationId?:string}} params request.
     * @returns {{from:string, to:string, renamed:number}}
     */
    tagsRename(params = {}) {
      const from = typeof params.from === 'string' ? params.from.trim() : ''
      const to = typeof params.to === 'string' ? params.to.trim().slice(0, 60) : ''
      if (from === '') throw invalid('tags.rename requires from')
      if (to === '') throw invalid('tags.rename requires a non-empty to')
      return withOperation('tags.rename', params.operationId, () => {
        const source = db.prepare('SELECT * FROM tags WHERE name = ?').get(from)
        if (source === undefined) throw notFound(`tag "${from}" does not exist`, { from })
        if (from === to) return { from, to, renamed: 0 }
        const now = nowIso()
        let renamed = 0
        transaction(db, () => {
          const links = db.prepare('SELECT paper_id FROM paper_tags WHERE tag_id = ?').all(source.id)
          db.prepare('INSERT OR IGNORE INTO tags(name, created_at) VALUES (?, ?)').run(to, now)
          const target = db.prepare('SELECT id FROM tags WHERE name = ?').get(to)
          for (const link of links) {
            db.prepare('INSERT OR IGNORE INTO paper_tags(paper_id, tag_id, created_at) VALUES (?, ?, ?)').run(link.paper_id, target.id, now)
            renamed += 1
          }
          db.prepare('DELETE FROM paper_tags WHERE tag_id = ?').run(source.id)
          db.prepare('DELETE FROM tags WHERE id = ?').run(source.id)
        })
        recordEvent('tags.rename', null, { from, to, renamed })
        return { from, to, renamed }
      })
    },

    /**
     * `tags.delete`
     * @param {{name:string, operationId?:string}} params request.
     * @returns {{name:string, ok:boolean, removed:number}}
     */
    tagsDelete(params = {}) {
      const name = typeof params.name === 'string' ? params.name.trim() : ''
      if (name === '') throw invalid('tags.delete requires name')
      return withOperation('tags.delete', params.operationId, () => {
        const tag = db.prepare('SELECT * FROM tags WHERE name = ?').get(name)
        if (tag === undefined) throw notFound(`tag "${name}" does not exist`, { name })
        const removed = Number(db.prepare('SELECT COUNT(*) AS count FROM paper_tags WHERE tag_id = ?').get(tag.id)?.count ?? 0)
        transaction(db, () => {
          db.prepare('DELETE FROM paper_tags WHERE tag_id = ?').run(tag.id)
          db.prepare('DELETE FROM tags WHERE id = ?').run(tag.id)
        })
        recordEvent('tags.delete', null, { name, removed })
        return { name, ok: true, removed }
      })
    },

    /* ---------------------- journal metrics (v0.3) ---------------- */

    /**
     * `metrics.update` — manual journal/paper metrics, provenance source='manual'.
     * @param {{paperId:string, fields:object}} params request.
     * @returns {{paper:object, metrics:object}}
     */
    metricsUpdate(params = {}) {
      const paperId = String(params.paperId ?? '')
      if (paperId === '') throw invalid('metrics.update requires paperId')
      const fields = params.fields ?? params.patch ?? {}
      if (typeof fields !== 'object' || fields === null || Array.isArray(fields)) throw invalid('fields must be an object')
      const allowed = new Set(['impactFactor', 'impactFactorYear', 'fiveYearImpactFactor', 'quartile', 'issn', 'publisher', 'citationCount', 'keywords'])
      const unknown = Object.keys(fields).filter((key) => !allowed.has(key))
      if (unknown.length > 0) throw invalid(`unsupported metric fields: ${unknown.join(', ')}`)
      if (Object.keys(fields).length === 0) throw invalid('metrics.update requires at least one field')
      return withOperation('metrics.update', params.operationId, () => {
        const row = applyManualMetrics(paperId, fields)
        recordEvent('metrics.update', paperId, { fields: Object.keys(fields) })
        return { paper: paperDetail(row), metrics: metricsPayload(row) }
      })
    },

    /**
     * `metrics.reset` — clear manual journal metrics for one paper and fall back to
     * the last automatic (OpenAlex/Crossref) source, or "未获取" when none exists.
     * @param {{paperId:string, operationId?:string}} params request.
     * @returns {{paper:object, metrics:object}}
     */
    metricsReset(params = {}) {
      const paperId = String(params.paperId ?? '')
      if (paperId === '') throw invalid('metrics.reset requires paperId')
      return withOperation('metrics.reset', params.operationId, () => {
        const row = requirePaperRow(paperId)
        const journal = journalRowFor(row)
        // Automatic metrics live on the paper (papers.metrics_json) while journal
        // metrics live on papers_journal; reset must restore the paper-level
        // citation count or `library.list sort=citations` would disagree with
        // `library.get.metrics` (the exact bug reported by the verifier).
        const paperAuto = parseJson(row.metrics_json, {})
        const journalAuto = journal === undefined ? {} : parseJson(journal.metrics_json, {})
        const autoSource =
          (typeof journalAuto.source === 'string' && journalAuto.source !== '' ? journalAuto.source : undefined) ??
          (journalAuto.openalexSourceId !== undefined ? 'openalex' : undefined) ??
          (typeof paperAuto.source === 'string' && paperAuto.source !== '' ? paperAuto.source : null)
        if (journal !== undefined) {
          db.prepare(
            'UPDATE papers_journal SET impact_factor = NULL, impact_factor_year = NULL, five_year_if = NULL, quartile = NULL, source = ?, updated_at = ? WHERE key = ?',
          ).run(autoSource, nowIso(), journal.key)
        }
        const autoCitations = Object.hasOwn(paperAuto, 'citedByCount')
          ? paperAuto.citedByCount ?? null
          : Object.hasOwn(journalAuto, 'citedByCount')
            ? journalAuto.citedByCount ?? null
            : null
        db.prepare('UPDATE papers SET citation_count = ?, updated_at = ?, revision = revision + 1 WHERE id = ?').run(
          autoCitations,
          nowIso(),
          paperId,
        )
        recordEvent('metrics.reset', paperId, {})
        const updated = requirePaperRow(paperId)
        return { paper: paperDetail(updated), metrics: metricsPayload(updated) }
      })
    },

    /**
     * `metrics.refresh` — explicit network refresh (OpenAlex works/sources + Crossref).
     *
     * Never called at mount. Without `allowNetwork:true` every paper reports
     * `unavailable` instead of touching the network. A JCR impact factor is never
     * synthesized: OpenAlex 2yr mean citedness is a separate field.
     * @param {{paperIds:string[], allowNetwork?:boolean, timeoutMs?:number}} params request.
     * @returns {Promise<{results:object[], refreshed:number, failed:number, network:boolean, tookMs:number}>}
     */
    async metricsRefresh(params = {}) {
      const paperIds = normalizeIds(params.paperIds ?? params.ids, 'metrics.refresh')
      const started = Date.now()
      if (params.allowNetwork !== true) {
        return {
          network: false,
          refreshed: 0,
          failed: 0,
          tookMs: Date.now() - started,
          results: paperIds.map((id) => ({ id, status: 'unavailable', reason: 'allowNetwork is required for network refresh' })),
        }
      }
      const timeoutMs = clampInt(params.timeoutMs ?? 8_000, 1_000, 20_000, 8_000)
      const results = []
      for (let index = 0; index < paperIds.length; index += 2) {
        const chunk = paperIds.slice(index, index + 2)
        const settled = await Promise.all(chunk.map((id) => refreshPaperMetrics(id, timeoutMs).catch((error) => ({ id, status: 'failed', reason: String(error?.message ?? error) }))))
        results.push(...settled)
      }
      return {
        network: true,
        refreshed: results.filter((result) => result.status === 'ok').length,
        failed: results.filter((result) => result.status !== 'ok').length,
        tookMs: Date.now() - started,
        results,
      }
    },

    /* ---------------------- citation / export (v0.3) -------------- */

    /**
     * `citation.format`
     * @param {{ids:string[], style:string}} params request.
     * @returns {{style:string, content:string, count:number}}
     */
    citationFormat(params = {}) {
      const ids = normalizeIds(params.ids, 'citation.format')
      const style = typeof params.style === 'string' ? params.style : 'bibtex'
      if (!['bibtex', 'apa', 'gbt7714', 'ris', 'csljson'].includes(style)) throw invalid(`unsupported citation style ${style}`)
      const rows = papersByIds(db, ids)
      let content
      if (style === 'csljson') content = `${JSON.stringify(rows.map(cslItem), null, 2)}\n`
      else if (style === 'ris') content = `${rows.map(risEntry).join('\n\n')}\n`
      else if (style === 'apa') content = `${rows.map(apaEntry).join('\n\n')}\n`
      else if (style === 'gbt7714') content = `${rows.map(gbt7714Entry).join('\n\n')}\n`
      else content = `${rows.map(bibtexEntry).join('\n\n')}\n`
      return { style, content, count: rows.length }
    },

    /**
     * `citation.key`
     * @param {{ids:string[]}} params paper ids.
     * @returns {{keys:Array<{id:string,key:string,source:string}>}}
     */
    citationKey(params = {}) {
      const rows = papersByIds(db, normalizeIds(params.ids, 'citation.key'))
      return { keys: rows.map((row) => ({ id: row.id, key: bibtexKey(row), source: 'authoryear' })) }
    },

    /**
     * `export.annotations`
     * @param {{paperId:string, format:'markdown'|'json'}} params request.
     * @returns {{content:string, count:number, format:string}}
     */
    exportAnnotations(params = {}) {
      const paperId = String(params.paperId ?? '')
      const format = params.format === 'json' ? 'json' : 'markdown'
      const paper = requirePaperRow(paperId)
      const annotations = db
        .prepare("SELECT * FROM annotations WHERE paper_id = ? AND state = 'active' ORDER BY page, created_at")
        .all(paperId)
        .map(toAnnotation)
      if (format === 'json') {
        return {
          format,
          count: annotations.length,
          content: `${JSON.stringify({ paper: { id: paper.id, title: paper.title, titleZh: paper.title_zh ?? null }, annotations }, null, 2)}\n`,
        }
      }
      const lines = [`# ${paper.title_zh ?? paper.title} — 批注`, '', `Paper: ${paper.title} (${paper.id})`, '']
      for (const annotation of annotations) {
        lines.push(`## 第 ${annotation.page} 页 · ${annotation.kind}${annotation.color === null ? '' : ` · ${annotation.color}`} · ${annotation.createdAt}`)
        if (annotation.quote !== null && annotation.quote !== undefined && annotation.quote !== '') lines.push('', `> ${annotation.quote.replace(/\n/g, '\n> ')}`)
        if (annotation.comment !== null && annotation.comment !== undefined && annotation.comment !== '') lines.push('', annotation.comment)
        lines.push('')
      }
      return { format, count: annotations.length, content: `${lines.join('\n')}\n` }
    },

    /* ---------------------- duplicates / merge (v0.3) ------------ */

    /**
     * `library.duplicates`
     * @returns {{groups:Array<{key:string, reason:string, items:object[]}>}}
     */
    libraryDuplicates() {
      const summaryById = new Map()
      const loadSummary = (id) => {
        if (!summaryById.has(id)) {
          const row = db.prepare(`SELECT ${PAPER_COLUMNS} FROM papers p WHERE p.id = ?`).get(id)
          if (row !== undefined) summaryById.set(id, toPaperSummary(row, { tags: tagsOf(id) }))
        }
        return summaryById.get(id)
      }
      const groups = []
      const seen = new Set()
      const shaRows = db
        .prepare(
          `SELECT v.sha256 AS sha, GROUP_CONCAT(DISTINCT v.paper_id) AS ids FROM paper_versions v
           JOIN papers p ON p.id = v.paper_id AND p.state = 'active'
           GROUP BY v.sha256 HAVING COUNT(DISTINCT v.paper_id) > 1`,
        )
        .all()
      for (const row of shaRows) {
        const ids = String(row.ids ?? '').split(',').filter((id) => id !== '')
        if (ids.length < 2) continue
        groups.push({ key: `sha256:${row.sha}`, reason: 'sha256', items: ids.map(loadSummary).filter(Boolean) })
        for (const id of ids) seen.add(id)
      }
      const normalizeTitle = (value) =>
        String(value ?? '')
          .normalize('NFKD')
          .toLowerCase()
          .replace(/[^a-z0-9\u4e00-\u9fff]+/g, ' ')
          .replace(/\s+/g, ' ')
          .trim()
          .replace(/^(?:a|an|the)\s+/, '')
      const titleRows = db.prepare("SELECT id, title FROM papers WHERE state = 'active'").all()
      const byTitle = new Map()
      for (const row of titleRows) {
        const key = normalizeTitle(row.title)
        if (key.length < 12) continue
        const list = byTitle.get(key) ?? []
        list.push(row.id)
        byTitle.set(key, list)
      }
      for (const [key, ids] of byTitle.entries()) {
        if (ids.length < 2) continue
        if (ids.every((id) => seen.has(id))) continue
        groups.push({ key: `title:${key}`, reason: 'title', items: ids.map(loadSummary).filter(Boolean) })
      }
      return { groups }
    },

    /**
     * `library.merge` — merge duplicate papers into the primary; others go to trash.
     * The whole merge is journaled and reversible via `operations.undo`.
     * @param {{primaryId:string, duplicateIds:string[], operationId?:string}} params request.
     * @returns {{primaryId:string, merged:number, trashed:string[], operationId:string}}
     */
    libraryMerge(params = {}) {
      const primaryId = String(params.primaryId ?? '')
      if (primaryId === '') throw invalid('library.merge requires primaryId')
      const duplicateIds = [...new Set(params.duplicateIds.map(String))].filter((id) => id !== primaryId)
      if (duplicateIds.length === 0) throw invalid('library.merge requires at least one duplicateId different from primaryId')
      return withOperation('library.merge', params.operationId, () => {
        const primary = requireActivePaperRow(primaryId)
        const duplicates = duplicateIds.map((id) => requirePaperRow(id))
        for (const duplicate of duplicates) {
          if (duplicate.state !== 'active') throw invalid(`paper ${duplicate.id} is not active`, { id: duplicate.id })
        }
        const undo = {
          primaryId,
          movedAnnotations: [],
          movedSources: [],
          removedSources: [],
          addedTags: [],
          addedCollections: [],
          movedNoteLinks: [],
          readBefore: [{ id: primaryId, read: Number(primary.read ?? 0) }],
          trashed: duplicateIds,
        }
        const primaryTags = new Set(tagNamesSnapshot(primaryId))
        const primaryCollections = new Set(
          db.prepare('SELECT collection_id FROM paper_collections WHERE paper_id = ?').all(primaryId).map((row) => row.collection_id),
        )
        const now = nowIso()
        let mergedRead = Number(primary.read ?? 0)
        transaction(db, () => {
          for (const duplicate of duplicates) {
            mergedRead = Math.max(mergedRead, Number(duplicate.read ?? 0))
            for (const tag of tagNamesSnapshot(duplicate.id)) {
              if (primaryTags.has(tag)) continue
              db.prepare('INSERT OR IGNORE INTO tags(name, created_at) VALUES (?, ?)').run(tag, now)
              const tagRow = db.prepare('SELECT id FROM tags WHERE name = ?').get(tag)
              if (tagRow !== undefined) {
                db.prepare('INSERT OR IGNORE INTO paper_tags(paper_id, tag_id, created_at) VALUES (?, ?, ?)').run(primaryId, tagRow.id, now)
                primaryTags.add(tag)
                undo.addedTags.push({ paperId: primaryId, name: tag })
              }
            }
            for (const link of db.prepare('SELECT collection_id FROM paper_collections WHERE paper_id = ?').all(duplicate.id)) {
              if (primaryCollections.has(link.collection_id)) continue
              db.prepare('INSERT OR IGNORE INTO paper_collections(collection_id, paper_id, created_at) VALUES (?, ?, ?)').run(link.collection_id, primaryId, now)
              primaryCollections.add(link.collection_id)
              undo.addedCollections.push({ collectionId: link.collection_id, paperId: primaryId })
            }
            for (const annotation of db.prepare('SELECT id FROM annotations WHERE paper_id = ?').all(duplicate.id)) {
              db.prepare('UPDATE annotations SET paper_id = ?, updated_at = ? WHERE id = ?').run(primaryId, now, annotation.id)
              undo.movedAnnotations.push({ annotationId: annotation.id, fromPaperId: duplicate.id })
            }
            db.prepare('UPDATE notes SET paper_id = ?, updated_at = ? WHERE paper_id = ?').run(primaryId, now, duplicate.id)
            // v0.17: workbench notes link to papers through note_paper_links; move the
            // duplicate's links onto the primary (both papers may already share a note).
            for (const link of db.prepare('SELECT note_id, anchor_json, created_at FROM note_paper_links WHERE paper_id = ?').all(duplicate.id)) {
              const clash = db.prepare('SELECT note_id FROM note_paper_links WHERE note_id = ? AND paper_id = ?').get(link.note_id, primaryId)
              db.prepare(
                'INSERT OR IGNORE INTO note_paper_links(note_id, paper_id, anchor_json, created_at) VALUES (?, ?, ?, ?)',
              ).run(link.note_id, primaryId, link.anchor_json ?? null, link.created_at ?? now)
              db.prepare('DELETE FROM note_paper_links WHERE note_id = ? AND paper_id = ?').run(link.note_id, duplicate.id)
              undo.movedNoteLinks.push({
                noteId: link.note_id,
                fromPaperId: duplicate.id,
                anchorJson: link.anchor_json ?? null,
                createdAt: link.created_at ?? now,
                hadPrimary: clash !== undefined,
              })
            }
            // sources has UNIQUE(paper_id, kind, url). Both papers commonly carry the
            // same manifest/crossref links, so a bulk UPDATE would abort the whole
            // merge. Move non-conflicting rows, delete conflicting duplicates and
            // journal both actions for a faithful undo.
            for (const source of db.prepare('SELECT id, kind, url, retrieved_at FROM sources WHERE paper_id = ?').all(duplicate.id)) {
              const clash = db.prepare('SELECT id FROM sources WHERE paper_id = ? AND kind = ? AND url = ?').get(primaryId, source.kind, source.url)
              if (clash !== undefined) {
                db.prepare('DELETE FROM sources WHERE id = ?').run(source.id)
                undo.removedSources.push({ paperId: duplicate.id, kind: source.kind, url: source.url, retrievedAt: source.retrieved_at ?? null })
              } else {
                db.prepare('UPDATE sources SET paper_id = ? WHERE id = ?').run(primaryId, source.id)
                undo.movedSources.push({ sourceId: source.id, fromPaperId: duplicate.id })
              }
            }
            db.prepare(
              "UPDATE papers SET state = 'trash', epoch = epoch + 1, revision = revision + 1, deleted_at = ?, updated_at = ? WHERE id = ?",
            ).run(now, now, duplicate.id)
          }
          db.prepare('UPDATE papers SET read = ?, updated_at = ?, revision = revision + 1 WHERE id = ?').run(mergedRead, now, primaryId)
        })
        for (const moved of undo.movedAnnotations) attached.search?.indexAnnotation?.(moved.annotationId)
        for (const id of [primaryId, ...duplicateIds]) {
          attached.search?.removePaperIndex?.(id)
          attached.search?.indexPaper?.(id)
        }
        const operationId = recordOperation({
          kind: 'library.merge',
          summary: `合并重复文献（${duplicateIds.length} 篇 → 主条目）`,
          target: { primaryId, duplicateIds },
          undo,
        })
        recordEvent('library.merge', primaryId, { duplicateIds })
        return { primaryId, merged: duplicateIds.length, trashed: duplicateIds, operationId }
      })
    },

    /* ---------------------- operations / undo (v0.3) -------------- */

    /**
     * `operations.recent`
     * @param {{limit?:number}} params request.
     * @returns {{items:Array<{id:string,kind:string,summary:string,createdAt:string,undone:boolean}>}}
     */
    operationsRecent(params = {}) {
      const limit = clampInt(params.limit ?? 20, 1, 100, 20)
      const items = db
        .prepare('SELECT id, kind, summary, created_at, undone, undone_at FROM operations ORDER BY created_at DESC, id DESC LIMIT ?')
        .all(limit)
        .map((row) => ({
          id: row.id,
          kind: row.kind,
          summary: row.summary,
          createdAt: row.created_at,
          undone: Number(row.undone ?? 0) === 1,
          undoneAt: row.undone_at ?? null,
        }))
      return { items }
    },

    /**
     * `operations.undo` — execute the journaled inverse; idempotent per operation.
     * @param {{operationId:string}} params request.
     * @returns {object} undo result.
     */
    operationsUndo(params = {}) {
      const operationId = String(params.operationId ?? '')
      if (operationId === '') throw invalid('operations.undo requires operationId')
      const entry = db.prepare('SELECT * FROM operations WHERE id = ?').get(operationId)
      if (entry === undefined) throw notFound(`operation ${operationId} does not exist`, { operationId })
      if (Number(entry.undone ?? 0) === 1) {
        return { status: 'already_undone', operationId, kind: entry.kind, summary: entry.summary, undoneAt: entry.undone_at ?? null }
      }
      const outcome = transaction(db, () => {
        const result = applyInverse(entry)
        if (result.status === 'undone') {
          db.prepare('UPDATE operations SET undone = 1, undone_at = ? WHERE id = ?').run(nowIso(), operationId)
        }
        return result
      })
      recordEvent('operations.undo', null, { operationId, kind: entry.kind, status: outcome.status })
      if (outcome.status !== 'undone') {
        return { ...outcome, operationId, kind: entry.kind, summary: entry.summary }
      }
      return { ...outcome, operationId, kind: entry.kind, summary: entry.summary }
    },

    /* ---------------------- saved searches (v0.3) ----------------- */

    /** `saved_searches.list` */
    savedSearchesList() {
      const items = db
        .prepare('SELECT * FROM saved_searches ORDER BY updated_at DESC, id DESC')
        .all()
        .map((row) => ({ id: row.id, name: row.name, query: parseJson(row.query_json, {}), createdAt: row.created_at, updatedAt: row.updated_at }))
      return { items }
    },

    /** `saved_searches.create` */
    savedSearchesCreate(params = {}) {
      const name = typeof params.name === 'string' ? params.name.trim().slice(0, 120) : ''
      if (name === '') throw invalid('saved_searches.create requires name')
      const query = params.query ?? {}
      if (typeof query !== 'object' || query === null || Array.isArray(query)) throw invalid('saved_searches.create query must be an object')
      return withOperation('saved_searches.create', params.operationId, () => {
        const clash = db.prepare('SELECT id FROM saved_searches WHERE name = ?').get(name)
        if (clash !== undefined) throw new DomainError('conflict', `saved search "${name}" already exists`, { name, id: clash.id })
        const id = `ss-${randomHex(6)}`
        const now = nowIso()
        db.prepare('INSERT INTO saved_searches(id, name, query_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?)').run(
          id,
          name,
          JSON.stringify(query),
          now,
          now,
        )
        return { savedSearch: { id, name, query, createdAt: now, updatedAt: now } }
      })
    },

    /** `saved_searches.update` */
    savedSearchesUpdate(params = {}) {
      const id = String(params.id ?? '')
      if (id === '') throw invalid('saved_searches.update requires id')
      return withOperation('saved_searches.update', params.operationId, () => {
        const row = db.prepare('SELECT * FROM saved_searches WHERE id = ?').get(id)
        if (row === undefined) throw notFound(`saved search ${id} does not exist`, { id })
        const values = {}
        if (Object.hasOwn(params, 'name')) {
          const name = typeof params.name === 'string' ? params.name.trim().slice(0, 120) : ''
          if (name === '') throw invalid('saved search name cannot be empty')
          const clash = db.prepare('SELECT id FROM saved_searches WHERE name = ? AND id <> ?').get(name, id)
          if (clash !== undefined) throw new DomainError('conflict', `saved search "${name}" already exists`, { name })
          values.name = name
        }
        if (Object.hasOwn(params, 'query')) {
          if (typeof params.query !== 'object' || params.query === null || Array.isArray(params.query)) throw invalid('query must be an object')
          values.query_json = JSON.stringify(params.query)
        }
        if (Object.keys(values).length === 0) throw invalid('saved_searches.update requires name or query')
        const assignments = Object.keys(values).map((column) => `${column} = ?`)
        db.prepare(`UPDATE saved_searches SET ${[...assignments, 'updated_at = ?'].join(', ')} WHERE id = ?`).run(...Object.values(values), nowIso(), id)
        const updated = db.prepare('SELECT * FROM saved_searches WHERE id = ?').get(id)
        return { savedSearch: { id, name: updated.name, query: parseJson(updated.query_json, {}), createdAt: updated.created_at, updatedAt: updated.updated_at } }
      })
    },

    /** `saved_searches.delete` */
    savedSearchesDelete(params = {}) {
      const id = String(params.id ?? '')
      if (id === '') throw invalid('saved_searches.delete requires id')
      return withOperation('saved_searches.delete', params.operationId, () => {
        const row = db.prepare('SELECT id FROM saved_searches WHERE id = ?').get(id)
        if (row === undefined) throw notFound(`saved search ${id} does not exist`, { id })
        db.prepare('DELETE FROM saved_searches WHERE id = ?').run(id)
        return { id, ok: true }
      })
    },

    /* ---------------------- jobs --------------------------------- */

    /**
     * `jobs.list`
     * @returns {{items:object[], summary:object}}
     */
    jobsList() {
      const items = db.prepare('SELECT * FROM jobs ORDER BY created_at DESC LIMIT 200').all().map(toJob)
      return { items, summary: attached.queue?.summary?.() ?? jobSummary(db) }
    },

    /* ---------------------- exports ------------------------------ */

    /**
     * `export.bibtex`
     * @param {{ids:string[]}} params paper ids.
     * @returns {{filename:string, mediaType:string, content:string}}
     */
    exportBibtex(params = {}) {
      const rows = papersByIds(db, normalizeIds(params.ids, 'export.bibtex'))
      const entries = rows.map((row) => {
        const authors = bibtexAuthors(parseAuthors(row.authors_json))
        const fields = [
          ['title', row.title],
          ['author', authors],
          ['year', row.year],
          ['journal', row.container_title ?? row.venue],
          ['booktitle', row.container_title ?? row.venue],
          ['doi', row.doi],
          ['url', row.doi === null || row.doi === undefined ? null : `https://doi.org/${row.doi}`],
          ['volume', row.volume],
          ['number', row.issue],
          ['pages', row.pages],
          ['eprint', row.arxiv_id],
          ['archivePrefix', row.arxiv_id === null || row.arxiv_id === undefined ? null : 'arXiv'],
          ['license', row.license],
        ]
        const body = fields
          .filter(([, value]) => value !== null && value !== undefined && value !== '')
          .map(([name, value]) => `  ${name} = {${String(value).replace(/[{}]/g, '')}}`)
          .join(',\n')
        return `@article{${bibtexKey(row)},\n${body}\n}`
      })
      return {
        filename: 'pappers-hall.bib',
        mediaType: 'application/x-bibtex; charset=utf-8',
        content: `${entries.join('\n\n')}\n`,
      }
    },

    /**
     * `export.csl`
     * @param {{ids:string[]}} params paper ids.
     * @returns {{filename:string, mediaType:string, content:string}}
     */
    exportCsl(params = {}) {
      const rows = papersByIds(db, normalizeIds(params.ids, 'export.csl'))
      const items = rows.map((row) => {
        const authors = parseAuthors(row.authors_json).map((author) =>
          author.literal === undefined ? { given: author.given ?? '', family: author.family ?? '' } : { literal: author.literal },
        )
        const dateParts = Number.isFinite(Number(row.year)) ? [[Number(row.year)]] : undefined
        return {
          id: row.id,
          type: 'article-journal',
          title: row.title,
          ...(authors.length === 0 ? {} : { author: authors }),
          ...(dateParts === undefined ? {} : { issued: { 'date-parts': dateParts } }),
          ...(row.container_title === null || row.container_title === undefined ? {} : { 'container-title': row.container_title }),
          ...(row.venue === null || row.venue === undefined ? {} : { 'collection-title': row.venue }),
          ...(row.doi === null || row.doi === undefined ? {} : { DOI: row.doi }),
          ...(row.volume === null || row.volume === undefined ? {} : { volume: String(row.volume) }),
          ...(row.issue === null || row.issue === undefined ? {} : { issue: String(row.issue) }),
          ...(row.pages === null || row.pages === undefined ? {} : { page: String(row.pages) }),
          ...(row.title_zh === null || row.title_zh === undefined ? {} : { 'title-zh': row.title_zh }),
        }
      })
      return {
        filename: 'pappers-hall.csl.json',
        mediaType: 'application/json; charset=utf-8',
        content: `${JSON.stringify(items, null, 2)}\n`,
      }
    },

    /**
     * `export.notes` — accepts paper ids or note ids.
     * @param {{ids:string[]}} params ids.
     * @returns {{filename:string, mediaType:string, content:string}}
     */
    exportNotes(params = {}) {
      const ids = normalizeIds(params.ids, 'export.notes')
      const notes = []
      for (const id of ids) {
        const note = db.prepare('SELECT * FROM notes WHERE id = ?').get(id)
        if (note !== undefined) {
          notes.push({ note: toNote(note), paper: note.paper_id === null ? undefined : db.prepare('SELECT id, title FROM papers WHERE id = ?').get(note.paper_id) })
          continue
        }
        for (const row of db.prepare('SELECT * FROM notes WHERE paper_id = ? ORDER BY created_at').all(id)) {
          notes.push({ note: toNote(row), paper: db.prepare('SELECT id, title FROM papers WHERE id = ?').get(id) })
        }
      }
      const lines = ['# Pappers-Hall notes', '']
      for (const { note, paper } of notes) {
        lines.push(`## ${note.title ?? note.id}`)
        if (paper !== undefined) lines.push(`- paper: ${paper.title} (${paper.id})`)
        lines.push(`- origin: ${note.origin}`)
        lines.push(`- created: ${note.createdAt}`)
        if (note.sourceRefs.length > 0) lines.push(`- sources: ${note.sourceRefs.map((ref) => `${ref.kind}:${ref.id}`).join(', ')}`)
        lines.push('', note.text, '')
      }
      return { filename: 'pappers-hall-notes.md', mediaType: 'text/markdown; charset=utf-8', content: `${lines.join('\n')}\n` }
    },

    /**
     * `export.locations` — anchors usable to jump back into the PDF.
     * @param {{ids:string[]}} params paper ids.
     * @returns {{filename:string, mediaType:string, content:string}}
     */
    exportLocations(params = {}) {
      const rows = papersByIds(db, normalizeIds(params.ids, 'export.locations'))
      const items = []
      for (const row of rows) {
        const version = latestVersion(row.id)
        items.push({
          paperId: row.id,
          title: row.title,
          sha256: version?.sha256 ?? row.sha256 ?? null,
          versionId: version?.id ?? null,
          locations: db
            .prepare("SELECT * FROM annotations WHERE paper_id = ? AND state = 'active' ORDER BY page")
            .all(row.id)
            .map((annotation) => ({
              annotationId: annotation.id,
              page: Number(annotation.page),
              kind: annotation.kind ?? 'note',
              rects: parseJson(annotation.rects_json, []),
              quote: annotation.quote ?? null,
              comment: annotation.comment ?? null,
              rect: parseJson(annotation.rect_json, null),
              color: annotation.color ?? null,
            })),
        })
      }
      return {
        filename: 'pappers-hall-locations.json',
        mediaType: 'application/json; charset=utf-8',
        content: `${JSON.stringify(items, null, 2)}\n`,
      }
    },

    /* ---------------------- translation -------------------------- */

    /**
     * `translation.test` (v0.11) — one real translation call for the settings panel.
     * @param {object} params provider/text/target.
     * @returns {Promise<object>} test result (never fabricated).
     */
    async translationTest(params = {}) {
      if (attached.translate !== null && attached.translate !== undefined && typeof attached.translate.test === 'function') {
        return this._translateCall(() => attached.translate.test(params))
      }
      return { ok: false, provider: params.provider ?? 'auto', translated: null, latencyMs: 0, reason: 'translation service is not initialized' }
    },

    /**
     * `embedding.status` (v0.5-B) — local embedding component facts.
     * @returns {object} status payload (honest unavailable when not installed).
     */
    embeddingStatus() {
      if (attached.embedding !== null && attached.embedding !== undefined) return attached.embedding.status()
      return {
        available: false,
        configured: false,
        pythonPath: null,
        model: null,
        dims: null,
        indexVersion: null,
        building: false,
        counts: { papers: 0, pages: 0, figures: 0, annotations: 0, chunks: 0 },
        lastError: 'embedding service is not initialized',
        setupScript: 'scripts/setup-embedding.sh',
      }
    },

    /**
     * `embedding.index` (v0.5-B) — enqueue a background index build.
     * @param {{force?:boolean}} params request.
     * @returns {object} job/enqueue result.
     */
    embeddingIndex(params = {}) {
      if (attached.embedding !== null && attached.embedding !== undefined) return attached.embedding.index(params)
      return { status: 'unavailable', reason: 'embedding service is not initialized', setupScript: 'scripts/setup-embedding.sh', job: null }
    },

    /**
     * `translate.providers` — engine availability metadata (v0.4).
     * @returns {object} provider list + preference + disclaimer.
     */
    translateProviders() {
      if (attached.translate !== null && attached.translate !== undefined) return attached.translate.providers()
      return { preferred: 'auto', fallback: true, items: [], disclaimer: 'translation service is not initialized', chain: [], events: 0, cacheEntries: 0 }
    },

    /**
     * `translate.settings` — GET without params / SET with provider/fallback (v0.4).
     * @param {{provider?:string, fallback?:boolean}} params request.
     * @returns {object} settings payload.
     */
    translateSettings(params = {}) {
      if (attached.translate !== null && attached.translate !== undefined) return this._translateCall(() => attached.translate.settings(params))
      return { preferred: 'auto', fallback: true, items: [] }
    },

    /**
     * `translate.detect` — simple language detection (v0.4).
     * @param {{text:string}} params request.
     * @returns {object} detection payload.
     */
    translateDetect(params = {}) {
      if (attached.translate !== null && attached.translate !== undefined) return this._translateCall(() => attached.translate.detect(params))
      return { language: 'unknown', han: 0, latin: 0, ratio: 0 }
    },

    /**
     * `translate.title` (v0.2) — AI first, then the composed translator service.
     *
     * Priorities: a human edit is never overwritten, a bibliographic Chinese title
     * is reported as `from_metadata`, and only titles without any Chinese title go
     * to the model (batched, cached). No path invents a translation.
     * @param {{ids:string[], target:string, force?:boolean}} params request.
     * @returns {Promise<{results:object[]}>}
     */
    async translateTitle(params = {}) {
      if (attached.translate !== null && attached.translate !== undefined) return this._translateCall(() => attached.translate.title(params))
      const ids = normalizeIds(params.ids, 'translate.title')
      const target = typeof params.target === 'string' && params.target !== '' ? params.target : 'zh'
      const results = []
      const pending = []
      for (const id of ids) {
        const row = db.prepare('SELECT * FROM papers WHERE id = ?').get(id)
        if (row === undefined) {
          results.push({ id, titleZh: null, status: 'unavailable', reason: 'paper_not_found' })
          continue
        }
        const hasTitle = typeof row.title_zh === 'string' && row.title_zh.trim() !== ''
        if (hasTitle && params.force !== true) {
          const source = row.title_zh_source ?? 'metadata'
          if (source === 'human') {
            results.push({ id, titleZh: row.title_zh, status: 'from_metadata', provenance: { source: 'human' } })
            continue
          }
          results.push({ id, titleZh: row.title_zh, status: 'from_metadata', provenance: { source: row.title_zh_source ?? 'metadata' } })
          continue
        }
        pending.push({ id, title: row.title })
      }
      let aiResult
      if (pending.length > 0 && attached.ai !== undefined && attached.ai.available === true) {
        try {
          aiResult = await attached.ai.translateTitles(pending, params.sessionId, params.fast === true)
        } catch (error) {
          aiResult = { error: String(error?.message ?? error) }
        }
      }
      const aiTranslations = aiResult?.translations instanceof Map ? aiResult.translations : new Map()
      const translator = typeof ctx?.get === 'function' ? ctx.get('translator') : undefined
      let translatorState
      for (const entry of pending) {
        const translated = aiTranslations.get(entry.id)
        if (typeof translated === 'string' && translated.trim() !== '') {
          db.prepare(
            "UPDATE papers SET title_zh = ?, title_zh_source = 'ai', updated_at = ?, revision = revision + 1 WHERE id = ?",
          ).run(translated.trim(), nowIso(), entry.id)
          reindexPaper(entry.id)
          results.push({
            id: entry.id,
            titleZh: translated.trim(),
            status: 'translated',
            provenance: {
              model: aiResult?.model ?? 'ai',
              promptVersion: 'translate-title-v1',
              target,
              cached: aiResult?.cached === true,
              fast: aiResult?.fast === true,
              reasoningEffort: aiResult?.reasoningEffort ?? null,
            },
          })
          continue
        }
        if (translatorState === undefined) translatorState = await translatorReachable(translator)
        if (translatorState.ok) {
          try {
            const translation = await translateWith(translator, entry.title, target === 'zh' ? 'zh' : target)
            db.prepare(
              "UPDATE papers SET title_zh = ?, title_zh_source = 'ai', updated_at = ?, revision = revision + 1 WHERE id = ?",
            ).run(translation, nowIso(), entry.id)
            reindexPaper(entry.id)
            results.push({
              id: entry.id,
              titleZh: translation,
              status: 'translated',
              provenance: { model: translatorState.provider ?? 'translator', promptVersion: 'translator', target },
            })
            continue
          } catch (error) {
            results.push({ id: entry.id, titleZh: null, status: 'unavailable', reason: String(error?.message ?? error) })
            continue
          }
        }
        const reason =
          aiResult?.error ??
          (attached.ai === undefined || attached.ai.available !== true
            ? attached.ai?.status?.().reason ?? 'AI service unavailable'
            : 'model returned no translation') +
            (translatorState.reason === undefined ? '' : `; ${translatorState.reason}`)
        results.push({ id: entry.id, titleZh: null, status: 'unavailable', reason: String(reason) })
      }
      // Preserve request order.
      const order = new Map(ids.map((id, index) => [id, index]))
      results.sort((left, right) => (order.get(left.id) ?? 0) - (order.get(right.id) ?? 0))
      return { results }
    },

    /**
     * `translate.text` (v0.2) — AI first, then the composed translator service.
     * @param {object} params paperId/page/text/target.
     * @returns {Promise<{translation:string|null, status:string, provenance:object}>}
     */
    async translateText(params = {}) {
      if (attached.translate !== null && attached.translate !== undefined) return this._translateCall(() => attached.translate.text(params))
      const translateStartedAt = Date.now()
      const paperId = String(params.paperId ?? '')
      let text = typeof params.text === 'string' && params.text.trim() !== '' ? params.text : ''
      if (paperId !== '') {
        requireActivePaperRow(paperId)
        if (text === '') {
          const page = clampInt(params.page ?? 1, 1, 10_000, 1)
          const row = db.prepare('SELECT text FROM paper_pages WHERE paper_id = ? AND page = ?').get(paperId, page)
          if (row === undefined) throw notFound(`page ${page} of paper ${paperId} was not extracted`, { paperId, page })
          text = row.text
        }
      }
      if (text.trim() === '') throw invalid('translate.text requires text or an extracted page')
      const target = params.target === 'zh' || params.target === undefined ? 'zh' : String(params.target)
      if (attached.ai !== undefined) {
        const aiResult = await attached.ai.translateText({ text, target, sessionId: params.sessionId, fast: params.fast === true })
        if (aiResult.status === 'translated') return aiResult
        // Fall through to the composed translator when AI is unavailable.
        if (aiResult.status === 'unavailable') {
          const translator = typeof ctx?.get === 'function' ? ctx.get('translator') : undefined
          const reachable = await translatorReachable(translator)
          if (reachable.ok) {
            try {
              const translation = await translateWith(translator, text, target)
              const sourceHash = await sha256Text(text)
              return {
                translation,
                status: 'translated',
                fast: false,
                reasoningEffort: null,
                elapsedMs: Math.max(1, Date.now() - translateStartedAt),
                provenance: { model: reachable.provider ?? 'translator', sourceHash, fast: false, reasoningEffort: null },
              }
            } catch (error) {
              return {
                translation: null,
                status: 'unavailable',
                fast: params.fast === true,
                reasoningEffort: null,
                elapsedMs: Math.max(1, Date.now() - translateStartedAt),
                provenance: { reason: String(error?.message ?? error), fast: params.fast === true, ...(aiResult.provenance ?? {}) },
              }
            }
          }
          return {
            translation: null,
            status: 'unavailable',
            fast: params.fast === true,
            reasoningEffort: null,
            elapsedMs: Math.max(1, Date.now() - translateStartedAt),
            provenance: {
              fast: params.fast === true,
              ...(aiResult.provenance ?? {}),
              ...(reachable.reason === undefined ? {} : { translatorReason: reachable.reason }),
            },
          }
        }
        return {
          ...aiResult,
          fast: aiResult.fast === true || params.fast === true,
          reasoningEffort: aiResult.reasoningEffort ?? null,
          elapsedMs: Number.isFinite(aiResult.elapsedMs) ? aiResult.elapsedMs : Math.max(1, Date.now() - translateStartedAt),
        }
      }
      const translator = typeof ctx?.get === 'function' ? ctx.get('translator') : undefined
      const reachable = await translatorReachable(translator)
      if (!reachable.ok) return { translation: null, status: 'unavailable', provenance: { reason: reachable.reason } }
      try {
        const translation = await translateWith(translator, text, target)
        const sourceHash = await sha256Text(text)
        return {
          translation,
          status: 'translated',
          fast: false,
          reasoningEffort: null,
          elapsedMs: Math.max(1, Date.now() - translateStartedAt),
          provenance: { model: reachable.provider ?? 'translator', sourceHash, fast: false, reasoningEffort: null },
        }
      } catch (error) {
        return {
          translation: null,
          status: 'unavailable',
          fast: params.fast === true,
          reasoningEffort: null,
          elapsedMs: Math.max(1, Date.now() - translateStartedAt),
          provenance: { reason: String(error?.message ?? error), fast: params.fast === true },
        }
      }
    },

    /* ---------------------- AI (LLM direct) ----------------------- */

    /**
     * `ai.status` — cheap availability facts without a model request.
     * @returns {object} AI status payload.
     */
    async aiProviders() {
      if (attached.ai === undefined || attached.ai === null || typeof attached.ai.providers !== 'function') {
        return { available: false, providers: [], selection: null, reason: 'AI service not initialized' }
      }
      try { return await attached.ai.providers() } catch (error) { return { available: false, providers: [], selection: null, reason: String(error?.message ?? error) } }
    },

    async aiSetDefault(params = {}) {
      if (attached.ai === undefined || attached.ai === null || typeof attached.ai.setDefault !== 'function') {
        return { ok: false, reason: 'AI service not initialized' }
      }
      try { return await attached.ai.setDefault(params ?? {}) } catch (error) { return { ok: false, reason: String(error?.message ?? error) } }
    },

    aiStatus() {
      if (attached.ai === undefined) {
        return { available: false, provider: null, model: null, limits: {}, reason: 'AI service not initialized', cacheEntries: 0 }
      }
      try {
        return attached.ai.status()
      } catch (error) {
        return { available: false, provider: null, model: null, limits: {}, reason: String(error?.message ?? error), cacheEntries: 0 }
      }
    },

    /**
     * `ai.ask` — grounded answer with optional real image attachment.
     * @param {object} params question/context request.
     * @returns {Promise<object>} AI answer payload.
     */
    /**
     * `ai.complete` — generic completion for note beautification (no paper context).
     * @param {{prompt:string, system?:string, maxTokens?:number, fast?:boolean, reasoningEffort?:string, sessionId?:string}} params completion request.
     * @returns {Promise<object>} completion payload.
     */
    async aiComplete(params = {}) {
      if (attached.ai === undefined || attached.ai === null || typeof attached.ai.completeText !== 'function') {
        return { status: 'unavailable', answer: null, reason: 'AI service not initialized', elapsedMs: 0, cached: false }
      }
      try {
        return await attached.ai.completeText(params ?? {})
      } catch (error) {
        return { status: 'error', answer: null, reason: String(error?.message ?? error), elapsedMs: 0, cached: false }
      }
    },

    async aiAsk(params = {}) {
      if (attached.ai === undefined) {
        return { status: 'unavailable', reason: 'AI service not initialized', sources: [], elapsedMs: 0 }
      }
      try {
        return await attached.ai.ask(params ?? {})
      } catch (error) {
        return { status: 'error', reason: String(error?.message ?? error), sources: [], elapsedMs: 0 }
      }
    },

    /**
     * `ai.quickTranslate` — fast alias of translate.text for a selected quote.
     * @param {{paperId?:string, text?:string, page?:number, target?:string, fast?:boolean, sessionId?:string}} params request.
     * @returns {Promise<object>} translation payload (always fast by default).
     */
    async aiQuickTranslate(params = {}) {
      // v0.3 compatibility: this remains the LLM fast alias. The v0.4 free-engine
      // quick translation path is `translate.text` with the auto provider chain.
      const target = typeof params.target === 'string' && params.target !== '' ? params.target : 'zh'
      let text = typeof params.text === 'string' ? params.text : ''
      if (text === '' && typeof params.paperId === 'string' && params.paperId !== '') {
        const record = requireActivePaperRow(params.paperId)
        const page = clampInt(params.page ?? 1, 1, 10_000, 1)
        const row = db.prepare('SELECT text FROM paper_pages WHERE paper_id = ? AND page = ?').get(params.paperId, page)
        if (row === undefined) throw notFound(`page ${page} of paper ${params.paperId} was not extracted`, { id: params.paperId, page })
        text = String(row.text ?? '')
        void record
      }
      if (text.trim() === '') throw invalid('ai.quickTranslate requires text or an extracted page')
      if (attached.ai === undefined) {
        return { translation: null, status: 'unavailable', fast: true, reasoningEffort: null, elapsedMs: 0, provenance: { reason: 'AI service not initialized', fast: true } }
      }
      return attached.ai.translateText({
        text,
        target,
        fast: params.fast !== false,
        sessionId: params.sessionId,
        ...(params.context !== undefined && params.context !== null ? { context: params.context } : {}),
      })
    },

    /**
     * `translate.blocks` — paragraph-level bilingual translation of one page.
     * @param {{paperId:string, page:number, target:string}} params request.
     * @returns {Promise<object>} per-block translation result.
     */
    async translateBlocks(params = {}) {
      if (attached.translate !== null && attached.translate !== undefined) return this._translateCall(() => attached.translate.blocks(params))
      const paperId = String(params.paperId ?? '')
      const page = Number(params.page)
      if (paperId === '') throw invalid('translate.blocks requires paperId')
      if (!Number.isInteger(page) || page < 1) throw invalid('translate.blocks requires a positive integer page')
      const paper = requirePaperRow(paperId)
      if (paper.state !== 'active') throw notFound(`paper ${paperId} is not available`, { paperId })
      if (attached.ai === undefined) {
        return {
          blocks: [],
          provenance: { model: null, promptVersion: 'translate-blocks-v1', sourceHash: null },
          cached: false,
          status: 'unavailable',
          reason: 'AI service not initialized',
        }
      }
      try {
        return await attached.ai.translateBlocks({ paperId, page, target: typeof params.target === 'string' ? params.target : 'zh', sessionId: params.sessionId, fast: params.fast === true })
      } catch (error) {
        return {
          blocks: [],
          provenance: { model: null, promptVersion: 'translate-blocks-v1', sourceHash: null },
          cached: false,
          status: 'error',
          reason: String(error?.message ?? error),
        }
      }
    },

    /* ---------------------- reference bundles -------------------- */

    /**
     * `references.commit` — freeze one immutable material snapshot.
     * @param {object} params sessionId/items/operationId.
     * @returns {object} bundle identity and resolved materials.
     */
    referencesCommit(params = {}) {
      const items = Array.isArray(params.items) ? params.items : []
      if (items.length === 0) throw invalid('references.commit requires at least one item')
      return withOperation('references.commit', params.operationId, () => {
        const resolved = []
        for (const [index, item] of items.entries()) {
          if (item === null || typeof item !== 'object') throw invalid(`items[${index}] must be an object`)
          const kind = String(item.kind ?? '')
          const id = String(item.id ?? '')
          if (!['paper', 'figure', 'annotation', 'note'].includes(kind)) throw invalid(`items[${index}].kind must be paper|figure|annotation|note`)
          if (id === '') throw invalid(`items[${index}].id is required`)
          resolved.push(resolveBundleItem(db, kind, id, item.page))
        }
        const bundleId = `bn-${randomHex(6)}`
        const display = describeBundle(resolved)
        // The token is what the Client inserts into the chat draft, so it must be
        // both human-readable and machine-parseable by the model: the `bundle=<id>`
        // fragment is the contract between this token and the papers_* tools.
        const token = buildBundleToken(bundleId, resolved)
        const now = nowIso()
        transaction(db, () => {
          db.prepare("INSERT INTO bundles(id, session_id, display, token, created_at, state) VALUES (?, ?, ?, ?, ?, 'active')").run(
            bundleId,
            typeof params.sessionId === 'string' && params.sessionId !== '' ? params.sessionId : null,
            display,
            token,
            now,
          )
          for (const [ordinal, material] of resolved.entries()) {
            db.prepare(
              'INSERT INTO bundle_items(bundle_id, kind, ref_id, page, snapshot_json, ordinal) VALUES (?, ?, ?, ?, ?, ?)',
            ).run(bundleId, material.kind, material.id, material.page ?? null, JSON.stringify(material.snapshot), ordinal)
          }
        })
        recordEvent('references.commit', null, { bundleId, items: resolved.length })
        return {
          bundleId,
          display,
          token,
          materials: resolved.map((material) => material.material),
          scope: 'reference_bundle',
        }
      })
    },

    /**
     * `references.latest` — the newest active bundle for a session.
     *
     * The draft carries a compact `@论文中心 2 篇论文` mention instead of a long
     * protocol token, so the model needs one way to find the bundle the user
     * just attached. This returns it, with its full material list.
     *
     * @param {{sessionId?:string, bundleId?:string}} params lookup request.
     * @returns {object|null} bundle identity and materials, or null.
     */
    referencesLatest(params = {}) {
      const explicit = String(params.bundleId ?? '')
      let row
      if (explicit !== '') {
        row = db.prepare('SELECT * FROM bundles WHERE id = ?').get(explicit)
      } else if (typeof params.sessionId === 'string' && params.sessionId !== '') {
        row = db
          .prepare("SELECT * FROM bundles WHERE session_id = ? AND state = 'active' ORDER BY created_at DESC, rowid DESC LIMIT 1")
          .get(params.sessionId)
      } else {
        row = db.prepare("SELECT * FROM bundles WHERE state = 'active' ORDER BY created_at DESC, rowid DESC LIMIT 1").get()
      }
      if (row === undefined) return null
      const items = db.prepare('SELECT * FROM bundle_items WHERE bundle_id = ? ORDER BY ordinal').all(row.id)
      const materials = items.map((item) => {
        try {
          return resolveBundleItem(db, item.kind, item.ref_id, item.page).material
        } catch {
          return { kind: item.kind, id: item.ref_id, unavailable: true }
        }
      })
      return {
        bundleId: row.id,
        sessionId: row.session_id ?? null,
        display: row.display ?? '',
        token: row.token,
        createdAt: row.created_at,
        materials,
      }
    },

    /**
     * `references.append` — add materials to an existing pending bundle.
     *
     * The Client keeps one bundle while the user is composing, so repeated
     * “引用到对话” clicks accumulate in one draft chip instead of creating a
     * stack of cards that each need their own cancel action.
     *
     * @param {{bundleId:string, sessionId?:string, items:object[], operationId?:string}} params append request.
     * @returns {object} the updated bundle and its complete material list.
     */
    referencesAppend(params = {}) {
      const bundleId = String(params.bundleId ?? '')
      const items = Array.isArray(params.items) ? params.items : []
      if (bundleId === '') throw invalid('references.append requires bundleId')
      if (items.length === 0) throw invalid('references.append requires at least one item')
      const bundleRow = db.prepare('SELECT * FROM bundles WHERE id = ?').get(bundleId)
      if (bundleRow === undefined) throw notFound(`bundle ${bundleId} does not exist`, { bundleId })
      if (bundleRow.state !== 'active') throw invalid('bundle is no longer active', { bundleId })
      if (
        typeof params.sessionId === 'string' &&
        params.sessionId !== '' &&
        typeof bundleRow.session_id === 'string' &&
        bundleRow.session_id !== params.sessionId
      ) {
        throw new DomainError('invalid', 'bundle belongs to a different session', { bundleId })
      }
      return withOperation('references.append', params.operationId, () => {
        const existingRows = db.prepare('SELECT * FROM bundle_items WHERE bundle_id = ? ORDER BY ordinal').all(bundleId)
        const seen = new Set()
        for (const row of existingRows) seen.add(`${row.kind}:${row.ref_id}:${row.page ?? ''}`)
        const resolved = []
        for (const [index, item] of items.entries()) {
          if (item === null || typeof item !== 'object') throw invalid(`items[${index}] must be an object`)
          const kind = String(item.kind ?? '')
          const id = String(item.id ?? '')
          if (!['paper', 'figure', 'annotation', 'note'].includes(kind)) throw invalid(`items[${index}].kind must be paper|figure|annotation|note`)
          if (id === '') throw invalid(`items[${index}].id is required`)
          const page = item.page === undefined || item.page === null ? null : Number(item.page)
          const key = `${kind}:${id}:${page ?? ''}`
          if (seen.has(key)) continue
          seen.add(key)
          resolved.push(resolveBundleItem(db, kind, id, page))
        }
        if (resolved.length > 0) {
          const now = nowIso()
          const start = existingRows.length
          transaction(db, () => {
            for (const [offset, material] of resolved.entries()) {
              db.prepare(
                'INSERT INTO bundle_items(bundle_id, kind, ref_id, page, snapshot_json, ordinal) VALUES (?, ?, ?, ?, ?, ?)',
              ).run(bundleId, material.kind, material.id, material.page ?? null, JSON.stringify(material.snapshot), start + offset)
            }
            const all = db.prepare('SELECT * FROM bundle_items WHERE bundle_id = ? ORDER BY ordinal').all(bundleId)
            const complete = all.map((row) => {
              try { return resolveBundleItem(db, row.kind, row.ref_id, row.page).material } catch { return { kind: row.kind, id: row.ref_id } }
            })
            const display = describeBundle(complete.map((material) => ({ kind: material.kind, material })))
            const token = buildBundleToken(bundleId, complete.map((material) => ({ kind: material.kind, material })))
            db.prepare('UPDATE bundles SET display = ?, token = ? WHERE id = ?').run(display, token, bundleId)
            recordEvent('references.append', null, { bundleId, items: resolved.length })
          })
        }
        const all = db.prepare('SELECT * FROM bundle_items WHERE bundle_id = ? ORDER BY ordinal').all(bundleId)
        const materials = all.map((row) => {
          try { return resolveBundleItem(db, row.kind, row.ref_id, row.page).material } catch { return { kind: row.kind, id: row.ref_id } }
        })
        const updated = db.prepare('SELECT * FROM bundles WHERE id = ?').get(bundleId)
        return {
          bundleId,
          display: updated?.display ?? bundleRow.display ?? '',
          token: updated?.token ?? bundleRow.token,
          materials,
          scope: 'reference_bundle',
          appended: resolved.length,
        }
      })
    },

    /**
     * `references.resolve` — re-validate every frozen material against current state.
     * @param {{bundleId:string, sessionId?:string}} params resolve request.
     * @returns {object} bundle plus valid/invalid partitions.
     */
    referencesResolve(params = {}) {
      const bundleId = String(params.bundleId ?? '')
      if (bundleId === '') throw invalid('references.resolve requires bundleId')
      const bundleRow = db.prepare('SELECT * FROM bundles WHERE id = ?').get(bundleId)
      if (bundleRow === undefined) throw notFound(`bundle ${bundleId} does not exist`, { bundleId })
      if (
        typeof params.sessionId === 'string' &&
        params.sessionId !== '' &&
        typeof bundleRow.session_id === 'string' &&
        bundleRow.session_id !== params.sessionId
      ) {
        throw new DomainError('invalid', 'bundle belongs to a different session', { bundleId })
      }
      const items = db.prepare('SELECT * FROM bundle_items WHERE bundle_id = ? ORDER BY ordinal').all(bundleId)
      const valid = []
      const invalidItems = []
      for (const row of items) {
        const snapshot = parseJson(row.snapshot_json, {})
        try {
          const resolved = resolveBundleItem(db, row.kind, row.ref_id, row.page ?? snapshot.page, { allowRefresh: false })
          valid.push(resolved.material)
        } catch (error) {
          invalidItems.push({ kind: row.kind, id: row.ref_id, page: row.page ?? null, reason: String(error?.message ?? error) })
        }
      }
      return {
        bundle: {
          id: bundleRow.id,
          sessionId: bundleRow.session_id ?? null,
          display: bundleRow.display ?? '',
          token: bundleRow.token,
          createdAt: bundleRow.created_at,
          state: bundleRow.state,
        },
        valid,
        invalid: invalidItems,
      }
    },

    /* ---------------------- internal write helpers ---------------- */

    /** @internal record one import result on a paper row. */
    updateProcessing(paperId, processing) {
      db.prepare('UPDATE papers SET processing_json = ?, updated_at = ? WHERE id = ?').run(JSON.stringify(processing), nowIso(), paperId)
    },

    /** @internal set the current version of one paper. */
    setCurrentVersion(paperId, versionId, sha256, pageCount, sourceVersion) {
      db.prepare(
        'UPDATE papers SET current_version_id = ?, sha256 = ?, source_version = COALESCE(?, source_version), processing_json = ?, updated_at = ? WHERE id = ?',
      ).run(versionId, sha256, sourceVersion ?? null, JSON.stringify({ ...PENDING_PROCESSING, state: 'pending' }), nowIso(), paperId)
      const version = latestVersion(paperId)
      if (version !== undefined && pageCount !== undefined) {
        db.prepare('UPDATE paper_versions SET page_count = ?, source_version = COALESCE(?, source_version) WHERE id = ?').run(
          pageCount,
          sourceVersion ?? null,
          versionId,
        )
      }
    },

    /** @internal replace all extracted pages of one paper (called by ingest). */
    replacePages(paperId, versionId, pages) {
      transaction(db, () => {
        db.prepare('DELETE FROM paper_pages WHERE paper_id = ?').run(paperId)
        const insert = db.prepare(
          `INSERT INTO paper_pages(paper_id, version_id, page, width, height, text, text_chars, layout_json, structure_state, structure_version, block_count, word_count)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        for (const page of pages) {
          const layout = page.layout === undefined || page.layout === null ? null : typeof page.layout === 'string' ? page.layout : JSON.stringify(page.layout)
          insert.run(
            paperId,
            versionId,
            page.page,
            page.width ?? null,
            page.height ?? null,
            page.text ?? '',
            (page.text ?? '').length,
            layout,
            layout === null ? 'pending' : (page.structureState ?? 'ready'),
            layout === null ? 0 : (page.structureVersion ?? LAYOUT_VERSION_CURRENT),
            layout === null ? 0 : Number(page.blockCount ?? 0),
            layout === null ? 0 : Number(page.wordCount ?? 0),
          )
        }
      })
    },

    /**
     * @internal v0.2: store generated page structures for a legacy paper without
     * touching its extracted text (lazy structure job).
     * @param {string} paperId paper id.
     * @param {Array<{page:number, layout:object, blockCount?:number, wordCount?:number}>} structures per-page structure.
     * @returns {number} number of pages updated.
     */
    updatePageLayouts(paperId, structures) {
      let updated = 0
      transaction(db, () => {
        const version = latestVersion(paperId)
        const insert = db.prepare(
          `INSERT OR IGNORE INTO paper_pages(paper_id, version_id, page, width, height, text, text_chars, layout_json, structure_state, structure_version, block_count, word_count)
           VALUES (?, ?, ?, ?, ?, '', 0, ?, 'ready', ?, ?, ?)`,
        )
        const update = db.prepare(
          'UPDATE paper_pages SET layout_json = ?, structure_state = ?, structure_version = ?, block_count = ?, word_count = ?, width = COALESCE(width, ?), height = COALESCE(height, ?) WHERE paper_id = ? AND page = ?',
        )
        for (const structure of structures) {
          const payload = JSON.stringify(structure.layout)
          const blockCount = Number(structure.blockCount ?? (structure.layout.blocks?.length ?? 0))
          const wordCount = Number(structure.wordCount ?? (structure.layout.words?.length ?? 0))
          const width = structure.layout.width ?? null
          const height = structure.layout.height ?? null
          const result = update.run(payload, 'ready', LAYOUT_VERSION_CURRENT, blockCount, wordCount, width, height, paperId, structure.page)
          if (Number(result.changes ?? 0) === 0) {
            insert.run(paperId, version?.id ?? null, structure.page, width, height, payload, LAYOUT_VERSION_CURRENT, blockCount, wordCount)
          }
          updated += 1
        }
      })
      return updated
    },

    /**
     * @internal record structure outcome for one paper.
     * @param {string} paperId paper id.
     * @param {'pending'|'ready'|'failed'} state structure state.
     * @param {object} [extra] extra fields: outline, abstract.
     */
    setPaperStructure(paperId, state, extra = {}) {
      const values = { structure_state: state, structure_updated_at: nowIso() }
      if (Array.isArray(extra.outline)) values.outline_json = JSON.stringify(extra.outline)
      if (typeof extra.abstract === 'string' && extra.abstract !== '') {
        values.abstract = extra.abstract
        values.abstract_source =
          typeof extra.abstractSource === 'string' && extra.abstractSource !== '' ? extra.abstractSource : 'pdf'
      } else if (extra.abstractSource !== undefined) {
        values.abstract_source = extra.abstractSource
      }
      const assignments = Object.keys(values).map((column) => `${column} = ?`)
      db.prepare(`UPDATE papers SET ${assignments.join(', ')}, updated_at = ? WHERE id = ?`).run(...Object.values(values), nowIso(), paperId)
    },

    /** @internal whether one paper has a PDF version (structure makes sense). */
    hasVersion(paperId) {
      return latestVersion(paperId) !== undefined
    },

    /** @internal replace all figures of one paper (called by ingest). */
    replaceFigures(paperId, versionId, figures) {
      transaction(db, () => {
        db.prepare('DELETE FROM figures WHERE paper_id = ?').run(paperId)
        const insert = db.prepare(
          `INSERT INTO figures(id, paper_id, version_id, page, label, caption, bbox_json, width, height, file_name, thumb_name, dhash, source, status, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        for (const figure of figures) {
          insert.run(
            figure.id,
            paperId,
            versionId,
            figure.page,
            figure.label ?? null,
            figure.caption ?? null,
            figure.bbox === null || figure.bbox === undefined ? null : JSON.stringify(figure.bbox),
            figure.width ?? null,
            figure.height ?? null,
            figure.fileName ?? null,
            figure.thumbName ?? null,
            figure.dhash ?? null,
            figure.source ?? 'caption',
            figure.status ?? 'ready',
            nowIso(),
          )
        }
      })
    },

    /** @internal upsert sources for one paper (manifest merge). */
    replaceSources(paperId, sources) {
      transaction(db, () => {
        db.prepare('DELETE FROM sources WHERE paper_id = ?').run(paperId)
        const insert = db.prepare('INSERT OR IGNORE INTO sources(paper_id, kind, url, retrieved_at) VALUES (?, ?, ?, ?)')
        for (const source of sources) {
          if (typeof source?.url !== 'string' || source.url === '') continue
          insert.run(paperId, String(source.kind ?? 'link'), source.url, source.retrievedAt ?? null)
        }
      })
    },

    /** @internal raw paper row by id. */
    paperRow(id) {
      return db.prepare('SELECT * FROM papers WHERE id = ?').get(id)
    },

    /** @internal version row of one paper. */
    versionRow(versionId) {
      return db.prepare('SELECT * FROM paper_versions WHERE id = ?').get(versionId)
    },

    /** @internal notes attached to a paper (already mapped). */
    notesForPaper(paperId) {
      return notesOf(paperId)
    },

    /** @internal annotations of a paper. */
    annotationsForPaper(paperId) {
      return db
        .prepare("SELECT * FROM annotations WHERE paper_id = ? AND state = 'active' ORDER BY page, created_at")
        .all(paperId)
        .map(toAnnotation)
    },

    /** @internal one mapped annotation by id. */
    annotationById(id) {
      const row = db.prepare('SELECT * FROM annotations WHERE id = ?').get(id)
      return row === undefined ? undefined : toAnnotation(row)
    },

    /** @internal one mapped note by id. */
    noteById(id) {
      const row = db.prepare('SELECT * FROM notes WHERE id = ?').get(id)
      return row === undefined ? undefined : toNote(row)
    },

    /** @internal paper summary by id (any state). */
    paperSummary(id) {
      const row = db.prepare(`SELECT ${PAPER_COLUMNS} FROM papers p WHERE p.id = ?`).get(id)
      return row === undefined ? undefined : toPaperSummary(row)
    },

    /** @internal page text row. */
    pageRow(paperId, page) {
      return db.prepare('SELECT * FROM paper_pages WHERE paper_id = ? AND page = ?').get(paperId, page)
    },

    /** @internal all page rows of one paper (page,text). */
    pageTexts(paperId) {
      return db.prepare('SELECT page, text FROM paper_pages WHERE paper_id = ? ORDER BY page').all(paperId)
    },

    /** @internal all stored page structures of one paper (page, layout object). */
    pageLayouts(paperId) {
      const rows = db.prepare("SELECT page, layout_json FROM paper_pages WHERE paper_id = ? AND layout_json IS NOT NULL AND layout_json <> '' ORDER BY page").all(paperId)
      return rows.map((row) => ({ page: Number(row.page), layout: parseJson(row.layout_json, undefined) })).filter((row) => row.layout !== undefined)
    },

    /** @internal figure row by id. */
    figureRow(figureId) {
      return db.prepare('SELECT * FROM figures WHERE id = ?').get(figureId)
    },

    /** @internal all figure rows for one paper (figure repair, no search join). */
    figureRowsForPaper(paperId) {
      return db.prepare('SELECT * FROM figures WHERE paper_id = ? ORDER BY page, id').all(paperId)
    },

    /** @internal update a figure crop in place without changing its id. */
    updateFigureCrop(figureId, patch = {}) {
      const column = (name) => {
        if (name === 'bboxJson') return 'bbox_json'
        if (name === 'fileName') return 'file_name'
        if (name === 'thumbName') return 'thumb_name'
        return name
      }
      const allowed = ['page', 'label', 'caption', 'bboxJson', 'width', 'height', 'fileName', 'thumbName', 'dhash', 'source', 'status']
      const entries = allowed.filter((name) => Object.prototype.hasOwnProperty.call(patch, name))
      if (entries.length === 0) return 0
      const statement = db.prepare(`UPDATE figures SET ${entries.map((name) => `${column(name)} = ?`).join(', ')} WHERE id = ?`)
      return Number(statement.run(...entries.map((name) => patch[name]), figureId)?.changes ?? 0)
    },

    /** @internal all figure rows with dhash for visual search. */
    figureRowsWithHash() {
      return db.prepare("SELECT * FROM figures WHERE dhash IS NOT NULL AND dhash <> ''").all()
    },

    /** @internal ensure a paper exists and is active. */
    requireActivePaper(id) {
      return requireActivePaperRow(String(id ?? ''))
    },

    /** @internal latest version lookup. */
    latestVersion,

    /** @internal title-line helper reused by citations/tools. */
    citationAuthorLine(paperId) {
      const row = db.prepare('SELECT authors_json FROM papers WHERE id = ?').get(paperId)
      return authorLine(parseAuthors(row?.authors_json))
    },

    /** @internal record an event. */
    recordEvent,

    /** @internal run a transaction helper for ingest jobs. */
    transaction(fn) {
      return transaction(db, fn)
    },

    /** @internal read a settings value. */
    readSetting(key) {
      return readSetting(db, key)
    },

    /** @internal write a settings value. */
    writeSetting(key, value) {
      return writeSetting(db, key, value)
    },

    /** @internal mark the incremental embedding index dirty (non-blocking). */
    notifyIndexChanged(options = {}) {
      const embedding = attached.embedding
      if (embedding === undefined || embedding === null || typeof embedding.syncSoon !== 'function') return
      try {
        embedding.syncSoon(typeof options.delayMs === 'number' ? options.delayMs : 1200)
      } catch (error) { /* optional capability */ }
      const followUps = Array.isArray(options.followUpDelays) ? options.followUpDelays : []
      for (const delay of followUps) {
        try {
          const timer = setTimeout(() => { try { embedding.syncSoon(0) } catch (error) { /* optional */ } }, Math.max(0, Number(delay) || 0))
          timer.unref?.()
        } catch (error) { /* optional */ }
      }
    },
  }

  attached.ctx = ctx
  return store
}

/* ------------------------------------------------------------------ */
/* Module helpers                                                       */
/* ------------------------------------------------------------------ */

/** Empty manifest index used when no developer fixture is present. */
export function emptyManifest() {
  return { available: false, byId: new Map(), bySha256: new Map(), byTitle: new Map(), fields: [] }
}

/** Validate a list of ids from one write request. */
function normalizeIds(ids, method) {
  if (!Array.isArray(ids) || ids.length === 0) throw invalid(`${method} requires a non-empty ids array`)
  const normalized = ids.map((id) => String(id ?? '').trim()).filter((id) => id !== '')
  if (normalized.length === 0) throw invalid(`${method} requires non-empty ids`)
  return [...new Set(normalized)]
}

/** File size in bytes, synchronous (node:sqlite store methods are synchronous). */
function fileSizeOf(filePath) {
  try {
    return statSync(filePath).size
  } catch {
    return 0
  }
}

/** Papers selected by an id list (preserving request order). */
function papersByIds(db, ids) {
  const rows = []
  for (const id of ids) {
    const row = db.prepare('SELECT * FROM papers WHERE id = ?').get(id)
    if (row !== undefined) rows.push(row)
  }
  return rows
}

/** Run one job-state summary query. */
export function jobSummary(db) {
  const rows = db.prepare('SELECT state, COUNT(*) AS count FROM jobs GROUP BY state').all()
  const summary = { queued: 0, running: 0, paused: 0, retry_wait: 0, failed: 0, succeeded: 0, cancelled: 0, globalPaused: false }
  for (const row of rows) if (Object.hasOwn(summary, row.state)) summary[row.state] = Number(row.count ?? 0)
  return summary
}

/** Resolve one reference-bundle item against current state. */
function resolveBundleItem(db, kind, id, page, options = {}) {
  if (kind === 'paper') {
    const row = db.prepare('SELECT * FROM papers WHERE id = ?').get(id)
    if (row === undefined || row.state !== 'active') throw notFound(`paper ${id} is not available`, { kind, id })
    const summary = toPaperSummary({ ...row, figure_count: 0, annotation_count: 0, page_count: null })
    return {
      kind,
      id,
      page: page ?? null,
      snapshot: { kind, id, title: row.title, epoch: Number(row.epoch ?? 0), sha256: row.sha256 ?? null },
      material: { kind: 'paper', id, title: row.title, titleZh: row.title_zh ?? null, page: page ?? null, ...(options.allowRefresh === false ? {} : { paper: summary }) },
    }
  }
  if (kind === 'figure') {
    const row = db.prepare('SELECT * FROM figures WHERE id = ?').get(id)
    if (row === undefined) throw notFound(`figure ${id} does not exist`, { kind, id })
    const paper = db.prepare('SELECT id, title, state FROM papers WHERE id = ?').get(row.paper_id)
    if (paper === undefined || paper.state !== 'active') throw notFound(`figure ${id} belongs to an unavailable paper`, { kind, id })
    return {
      kind,
      id,
      page: page ?? Number(row.page),
      snapshot: { kind, id, paperId: row.paper_id, page: Number(row.page), label: row.label ?? null },
      material: { kind: 'figure', id, title: paper.title, paperId: row.paper_id, page: Number(row.page), label: row.label ?? null, caption: row.caption ?? null, imageUrl: `/pappers-hall/figure/${id}.png?v=${encodeURIComponent(row.dhash || id)}` },
    }
  }
  if (kind === 'annotation') {
    const row = db.prepare('SELECT * FROM annotations WHERE id = ?').get(id)
    if (row === undefined || row.state !== 'active') throw notFound(`annotation ${id} is not available`, { kind, id })
    const paper = db.prepare('SELECT id, title, state FROM papers WHERE id = ?').get(row.paper_id)
    if (paper === undefined || paper.state !== 'active') throw notFound(`annotation ${id} belongs to an unavailable paper`, { kind, id })
    return {
      kind,
      id,
      page: page ?? Number(row.page),
      snapshot: { kind, id, paperId: row.paper_id, page: Number(row.page) },
      material: { kind: 'annotation', id, title: paper.title, paperId: row.paper_id, page: Number(row.page), text: row.text, quote: row.quote ?? null },
    }
  }
  // v0.22 notes workbench lives in `note_docs`; the old `notes` table is only a
  // legacy fallback. Resolving only the legacy table made every new note fail to
  // enter a conversation bundle with a misleading HTTP 404.
  const doc = db.prepare('SELECT * FROM note_docs WHERE id = ?').get(id)
  if (doc !== undefined) {
    if (doc.state !== 'active') throw notFound(`note ${id} is not available`, { kind, id })
    const links = db.prepare('SELECT paper_id FROM note_paper_links WHERE note_id = ? ORDER BY created_at, paper_id').all(id)
    const paperIds = links.map((link) => link.paper_id).filter(Boolean)
    return {
      kind,
      id,
      page: page ?? null,
      snapshot: { kind, id, title: doc.title ?? '', paperIds },
      material: {
        kind: 'note',
        id,
        title: doc.title || '未命名笔记',
        text: doc.content_md || doc.index_text || '',
        paperId: paperIds[0] ?? null,
        paperIds,
      },
    }
  }
  const row = db.prepare('SELECT * FROM notes WHERE id = ?').get(id)
  if (row === undefined || row.state !== 'active') throw notFound(`note ${id} is not available`, { kind, id })
  return {
    kind,
    id,
    page: page ?? null,
    snapshot: { kind, id, paperId: row.paper_id ?? null },
    material: { kind: 'note', id, title: row.title ?? null, text: row.text, paperId: row.paper_id ?? null },
  }
}

/** Human-readable bundle display line. */
function describeBundle(materials) {
  const counts = { paper: 0, figure: 0, annotation: 0, note: 0 }
  for (const material of materials) counts[material.kind] = (counts[material.kind] ?? 0) + 1
  const parts = []
  if (counts.paper > 0) parts.push(`${counts.paper} 篇论文`)
  if (counts.figure > 0) parts.push(`${counts.figure} 张图`)
  if (counts.annotation > 0) parts.push(`${counts.annotation} 条批注`)
  if (counts.note > 0) parts.push(`${counts.note} 条笔记`)
  return parts.join(' + ')
}

/**
 * Build the chat-facing material token for one reference bundle.
 *
 * Kept ≤120 characters, human readable, and always contains
 * `bundle=bn-<12hex>` so the model (and a user reading the draft) can pass the
 * bundle id to `papers_search` / `papers_get_passage` / `papers_get_figure`.
 * @param {string} bundleId bundle id (`bn-...`).
 * @param {object[]} materials resolved bundle materials.
 * @returns {string} token such as `@论文中心 2 篇论文 + 1 张图` (no bundle id, no note title).
 */
export function buildBundleToken(bundleId, materials) {
  const counts = { paper: 0, figure: 0, annotation: 0, note: 0 }
  for (const material of materials) counts[material.kind] = (counts[material.kind] ?? 0) + 1
  const parts = []
  if (counts.paper > 0) parts.push(`${counts.paper} 篇论文`)
  if (counts.figure > 0) parts.push(`${counts.figure} 张图`)
  if (counts.annotation > 0) parts.push(`${counts.annotation} 条批注`)
  // The note title is intentionally omitted: the mention must stay short enough
  // to render as one chip, and `papers_references` already returns the titles.
  if (counts.note > 0) parts.push(`${counts.note} 条笔记`)
  const summary = parts.length === 0 ? `${materials.length} 项材料` : parts.join(' + ')
  // Compact mention form: no box glyphs, reads as a normal @-reference in the
  // draft, and still carries the bundle id the model needs. Keep the id intact.
  // Compact mention: the draft stays readable and the bundle id is resolved by
  // the `papers_references` tool (newest bundle of this session) instead of
  // being printed into the message.
  const prefix = '@论文中心 '
  const room = Math.max(1, 60 - prefix.length)
  const clipped = summary.length > room ? summary.slice(0, Math.max(1, room - 1)) + '…' : summary
  return `${prefix}${clipped}`
}

/**
 * Extract a bundle id from a raw id or from a chat material token.
 * @param {string} value raw `bn-...` id or a token containing `bundle=bn-...`.
 * @returns {string|undefined} normalized bundle id.
 */
export function parseBundleId(value) {
  if (typeof value !== 'string') return undefined
  const direct = /^bn-[a-f0-9]{12}$/.exec(value.trim())
  if (direct !== null) return direct[0]
  const embedded = /bn-[a-f0-9]{12}/.exec(value)
  return embedded === null ? undefined : embedded[0]
}

/** Delete one file, ignoring absence and permission failures (best effort purge). */
function unlinkQuiet(filePath) {
  try {
    unlinkSync(filePath)
  } catch {
    // A missing or already-deleted cache/asset file is the expected steady state.
  }
}

/** Delete figure image files for one purged paper. */
function removeFigureFiles(layout, figureRow) {
  for (const name of [figureRow.file_name, figureRow.thumb_name]) {
    if (typeof name !== 'string' || name === '') continue
    unlinkQuiet(path.join(layout.figuresDir, name))
  }
}

/** Delete every cached render derived from one paper id. */
function removePaperCacheFiles(layout, paperId, figureIds) {
  for (const directory of [layout.pagesCacheDir, layout.thumbsCacheDir]) {
    try {
      for (const name of readdirSync(directory)) if (name.startsWith(`${paperId}-`)) unlinkQuiet(path.join(directory, name))
    } catch {
      // A missing cache directory only means nothing was rendered yet.
    }
  }
  try {
    for (const name of readdirSync(layout.figuresCacheDir)) {
      if (figureIds.some((figureId) => name.startsWith(`${figureId}-`))) unlinkQuiet(path.join(layout.figuresCacheDir, name))
    }
  } catch {
    // Same as above: cache cleanup is best effort.
  }
}

/** Delete one stored PDF only when no other version references its digest. */
function removeFileIfUnreferenced(db, version) {
  if (typeof version?.file_path !== 'string' || version.file_path === '') return
  const remaining = db.prepare('SELECT COUNT(*) AS count FROM paper_versions WHERE sha256 = ?').get(version.sha256)
  if (Number(remaining?.count ?? 0) > 0) return
  unlinkQuiet(version.file_path)
}

/**
 * Collect honest degradation entries for the current process/services.
 * @param {object} options detection inputs.
 * @returns {Array<{channel:string, reason:string}>}
 */
export function collectDegraded({ fts5, ctx, identity = {}, embedding, translate, ocr, settings }) {
  const degraded = []
  if (!fts5) degraded.push({ channel: 'fts', reason: 'SQLite FTS5 is unavailable in this build; deterministic LIKE scan only.', severity: 'degraded' })

  let features = null
  try {
    features = settings !== undefined && settings !== null && typeof settings.features === 'function' ? settings.features() : null
  } catch {}

  // Vector retrieval is a live capability: report the real state instead of the
  // mount-time snapshot. When the user turned semantic search off in settings the
  // status says "disabled" (not a degradation).
  if (features === null || features.vectorSearch !== false) {
    let vectorReady = false
    let vectorConfigured = false
    try {
      const facts = embedding !== undefined && embedding !== null && typeof embedding.facts === 'function' ? embedding.facts() : null
      vectorConfigured = facts !== null && facts.configured === true
      vectorReady = facts !== null && facts.available === true && facts.indexReady === true
    } catch (error) { /* keep degraded */ }
    if (!vectorReady) {
      degraded.push({
        channel: 'vector',
        reason: vectorConfigured ? '语义索引尚未建立；可在设置中重建索引' : '本地嵌入组件未配置（可选）；可在设置中安装，或运行 scripts/setup-embedding.sh',
        severity: 'optional',
      })
    }
  }

  // Translation works through the free engine chain even when DSH's optional
  // translator service is absent; disabled provider switches are not a loss.
  let translationReady = typeof ctx?.get === 'function' && ctx.get('translator') !== undefined
  let translationConfigured = false
  try {
    if (translate !== undefined && translate !== null && typeof translate.providers === 'function') {
      const providers = translate.providers()
      const items = providers !== null && Array.isArray(providers.items) ? providers.items : []
      translationConfigured = items.length > 0
      translationReady =
        translationReady || items.some((item) => item && item.enabled !== false && (item.configured === true || item.available === true))
    }
  } catch (error) { /* keep degraded */ }
  if (!translationReady) {
    const allOff =
      settings !== undefined && settings !== null && typeof settings.anyTranslationProviderEnabled === 'function' && settings.anyTranslationProviderEnabled() === false
    degraded.push({
      channel: 'translation',
      reason: allOff ? '所有翻译引擎已在设置中关闭；可在设置中至少启用一个引擎' : translationConfigured ? '翻译引擎当前不可用（网络或配置问题）' : '没有可用的翻译引擎',
      severity: 'optional',
    })
  }

  // OCR is opt-in and genuinely optional: distinguish "not installed" from
  // "installed but switched off" and from a real runtime failure.
  try {
    const ocrStatus = ocr !== undefined && ocr !== null && typeof ocr.status === 'function' ? ocr.status() : null
    if (ocrStatus === null || ocrStatus.available !== true) {
      const installed = ocrStatus !== null && ocrStatus.installed === true
      degraded.push({
        channel: 'ocr',
        reason: installed ? 'OCR 已安装但未启用（可选）：在设置中开启后可对扫描版 PDF 建立文字索引' : 'OCR 未安装（可选）：扫描版 PDF 不提取文字，不影响文本型 PDF 的阅读、检索、批注与翻译',
        severity: 'optional',
      })
    } else if (ocrStatus.enabled !== true) {
      degraded.push({ channel: 'ocr', reason: 'OCR 已安装但未启用（可选）：在设置中开启后可对扫描版 PDF 建立文字索引', severity: 'optional' })
    } else if (ocrStatus.lastError !== null && ocrStatus.lastError !== undefined) {
      degraded.push({ channel: 'ocr', reason: `OCR 运行异常：${String(ocrStatus.lastError)}`, severity: 'degraded' })
    }
  } catch (error) {
    degraded.push({ channel: 'ocr', reason: 'OCR 状态未知（可选）', severity: 'optional' })
  }

  const attachments = typeof ctx?.get === 'function' ? ctx.get('attachments') : undefined
  if (attachments === undefined) degraded.push({ channel: 'attachments', reason: 'attachment service unavailable; imported uploads are limited', severity: 'optional' })
  return degraded
}

/** Check whether the translator service can actually reach a provider. */
async function translatorReachable(translator) {
  if (translator === undefined || typeof translator.translate !== 'function') {
    return { ok: false, reason: 'translator service unavailable' }
  }
  try {
    if (typeof translator.availableProviders === 'function') {
      const providers = await translator.availableProviders()
      if (Array.isArray(providers) && providers.length === 0) return { ok: false, reason: 'no translation provider is reachable' }
      const first = Array.isArray(providers) ? providers[0] : undefined
      return { ok: true, provider: first?.provider ?? first?.id ?? translator?.config?.provider ?? 'translator' }
    }
    return { ok: true, provider: translator?.config?.provider ?? 'translator' }
  } catch (error) {
    return { ok: false, reason: `translation provider probe failed: ${String(error?.message ?? error)}` }
  }
}

/** Translate one string through the composed translator service. */
async function translateWith(translator, text, targetLanguage) {
  const request = { text, targetLanguage }
  const spec = typeof translator.resolve === 'function' ? translator.resolve(request) : request
  const translation = await translator.translate(spec)
  if (typeof translation !== 'string' || translation.trim() === '') throw new Error('translator returned no text')
  return translation
}

/** Streamed sha256 of a UTF-8 string. */
async function sha256Text(text) {
  const { createHash } = await import('node:crypto')
  return createHash('sha256').update(text, 'utf8').digest('hex')
}

/** A small, stable read-only view of the manifest for tools/diagnostics. */
export function manifestIndex(manifestJson) {
  const index = emptyManifest()
  if (manifestJson === null || typeof manifestJson !== 'object' || !Array.isArray(manifestJson.papers)) return index
  index.available = true
  index.fields = Array.isArray(manifestJson.fields) ? manifestJson.fields : []
  for (const paper of manifestJson.papers) {
    if (typeof paper?.id !== 'string') continue
    index.byId.set(paper.id, paper)
    if (typeof paper.sha256 === 'string') index.bySha256.set(paper.sha256.toLowerCase(), paper)
    const titleKey = normalizeTitleKey(paper.title)
    if (titleKey !== '') index.byTitle.set(titleKey, paper)
  }
  return index
}

/** Normalize a title for duplicate/merge lookups. */
export function normalizeTitleKey(title) {
  return String(title ?? '')
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()
}

export { hasCjk, safeFileStem }
