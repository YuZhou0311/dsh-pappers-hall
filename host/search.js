/**
 * Joint search for the Pappers-Hall Host half (contract §2.1 `search.query`,
 * `figures.search`).
 *
 * Available channels are stated explicitly in every response. There is no
 * embedding model in this build, so the vector channel reports `degraded` and
 * never manufactures a similarity: text recall comes from SQLite FTS5 plus a
 * deterministic LIKE channel for CJK and phrase queries, and figure recall from
 * caption FTS plus a dHash near-duplicate channel.
 *
 * @module pappers-hall/host/search
 */
import { dhashFromPng, hammingDistance } from './pdf.js'
import { clampInt, escapeLike, hasCjk } from './paths.js'
import { DomainError, invalid, notFound } from './store.js'

/** Parse one annotation `rects_json` column into a plain rect list. */
function parseRectsColumn(value) {
  if (typeof value !== 'string' || value === '') return []
  try {
    const parsed = JSON.parse(value)
    return Array.isArray(parsed) ? parsed : []
  } catch {
    return []
  }
}

/**
 * Whether a stored figure label names the requested figure/table number.
 * Detected labels look like "Figure 2", "Table 3", "Fig. 1"; the query may use
 * Chinese or English wording, so only kind + number are compared.
 * @param {string} label stored label.
 * @param {'figure'|'table'} kind requested kind.
 * @returns {boolean} label matches.
 */
function LOWER_LABEL_PREFIX(label, kind) {
  const text = String(label ?? '').toLowerCase()
  const numberMatch = text.match(/([0-9]+[a-z]?)\s*$/)
  if (numberMatch === null) return false
  const isTable = /^(table|tab\.?)/.test(text)
  return kind === 'table' ? isTable : !isTable
}

/** Relative channel weights used to merge hits from different tables. */
const KIND_WEIGHTS = {
  paperTitle: 1,
  paperAbstract: 0.84,
  body: 0.72,
  figure: 0.8,
  annotation: 0.88,
  note: 0.88,
}

/** JS-side snippet builder for the LIKE channel (FTS has `snippet()`). */
function likeSnippet(text, needle, radius = 90) {
  const source = String(text ?? '')
  if (source === '') return ''
  const needleText = String(needle ?? '').trim()
  if (needleText === '') return source.slice(0, radius * 2).replace(/\s+/g, ' ').trim()
  const index = source.toLowerCase().indexOf(needleText.toLowerCase())
  if (index < 0) {
    // Multi-token CJK queries may not appear verbatim; fall back to the first token.
    const firstToken = needleText.split(/\s+/)[0]
    if (firstToken !== needleText) return likeSnippet(source, firstToken, radius)
    return source.slice(0, radius * 2).replace(/\s+/g, ' ').trim()
  }
  const start = Math.max(0, index - radius)
  const end = Math.min(source.length, index + needleText.length + radius)
  const prefix = start > 0 ? '…' : ''
  const suffix = end < source.length ? '…' : ''
  return `${prefix}${source.slice(start, end).replace(/\s+/g, ' ').trim()}${suffix}`
}

/** Tokenize one query for FTS5, dropping syntax characters (never user-controlled MATCH syntax). */
function ftsTokens(query) {
  return String(query ?? '')
    .split(/\s+/)
    .map((token) => token.replace(/["'*():^{}[\]\\-]/g, '').trim())
    .filter((token) => /\p{L}|\p{N}/u.test(token))
    .map((token) => `"${token.replace(/"/g, '')}"`)
}

/** Build the FTS MATCH expression. */
function ftsMatch(query) {
  const tokens = ftsTokens(query)
  if (tokens.length === 0) return null
  return tokens.join(' OR ')
}

/** Paper filters shared by every channel; mirrors store.libraryList semantics. */
function paperFilters(filters = {}, alias = 'p') {
  const clauses = []
  const params = []
  const state = filters.trash === true ? 'trash' : 'active'
  clauses.push(`${alias}.state = ?`)
  params.push(state)
  if (filters.read !== undefined && filters.read !== null && filters.read !== 'all') {
    clauses.push(`${alias}.read = ?`)
    params.push(filters.read === true ? 1 : 0)
  }
  if (filters.annotated === true) {
    clauses.push(`EXISTS (SELECT 1 FROM annotations a2 WHERE a2.paper_id = ${alias}.id AND a2.state = 'active')`)
  }
  if (typeof filters.field === 'string' && filters.field.trim() !== '') {
    clauses.push(`(${alias}.field = ? OR ${alias}.field_id = ?)`)
    params.push(filters.field.trim(), filters.field.trim())
  }
  if (Number.isFinite(filters.yearFrom)) {
    clauses.push(`${alias}.year >= ?`)
    params.push(Math.trunc(filters.yearFrom))
  }
  return { clauses, params }
}

/**
 * Merge hits from one extra keyword pass into an existing result list.
 * Paper-level hits are merged by paper id so an expanded-query hit never
 * duplicates the original one; figure/annotation/note hits merge by kind+id.
 * @param {object[]} base existing hits.
 * @param {object[]} extra hits from the expanded query.
 * @param {string} reason reason appended to merged hits.
 * @returns {object[]} merged hits sorted by score.
 */
function mergeSearchHits(base, extra, reason) {
  const merged = new Map()
  let added = 0
  const keyOf = (hit) => (hit.kind === 'paper' ? `paper:${hit.paperId}` : `${hit.kind}:${hit.id}`)
  for (const hit of base) merged.set(keyOf(hit), { ...hit, reasons: [...(hit.reasons ?? [])] })
  for (const hit of extra) {
    const key = keyOf(hit)
    const existing = merged.get(key)
    if (existing === undefined) {
      added += 1
      // Expansion-only hits stay in the lowest tier: they can add recall but must
      // never outrank an exact/phrase match from the original query.
      merged.set(key, { ...hit, tier: 0, reasons: [...new Set([...(hit.reasons ?? []), reason])], score: Number(hit.score ?? 0) * 0.9 })
      continue
    }
    const reasons = new Set([...(existing.reasons ?? []), ...(hit.reasons ?? []), reason])
    existing.reasons = [...reasons]
    existing.score = Math.max(Number(existing.score ?? 0), Number(hit.score ?? 0) * 0.9)
    if (existing.page === undefined && hit.page !== undefined) existing.page = hit.page
    if ((existing.snippet ?? '') === '' && typeof hit.snippet === 'string') existing.snippet = hit.snippet
  }
  return {
    items: [...merged.values()].sort((left, right) => Number(right.tier ?? 0) - Number(left.tier ?? 0) || right.score - left.score),
    added,
  }
}

/**
 * Create the search service.
 * @param {object} options search options.
 * @param {import('node:sqlite').DatabaseSync} options.db open database.
 * @param {object} options.store attached domain store (read helpers + summary mapper).
 * @param {boolean} options.fts5 whether FTS5 derived tables are usable.
 * @param {object} [options.logger] logger.
 * @param {number} [options.figureDistance] max dHash hamming distance for a near-duplicate.
 * @returns {object} search service.
 */
/** Stable merge key for RRF fusion across keyword and vector hits. */
export function hitKey(hit) {
  if (hit === null || typeof hit !== 'object') return String(hit)
  if (typeof hit.paperId === 'string' && typeof hit.page === 'number' && hit.kind === 'page') return `page:${hit.paperId}:${hit.page}`
  if (typeof hit.id === 'string' && hit.id !== '') return `${hit.kind ?? 'hit'}:${hit.id}`
  if (typeof hit.paperId === 'string') return `paper:${hit.paperId}`
  return JSON.stringify(hit)
}

/**
 * RRF fusion: keyword rank + vector rank, exact/phrase tiers stay on top.
 * @param {object[]} keywordItems ordered keyword hits.
 * @param {object[]} vectorItems ordered cosine hits.
 * @returns {object[]} fused items.
 */
export function fuseVectorHits(keywordItems, vectorItems) {
  const keywordRank = new Map()
  keywordItems.forEach((hit, index) => keywordRank.set(hitKey(hit), index))
  const vectorRank = new Map()
  vectorItems.forEach((hit, index) => vectorRank.set(hitKey(hit), index))
  const byKey = new Map()
  for (const hit of keywordItems) byKey.set(hitKey(hit), { ...hit })
  for (const hit of vectorItems) {
    const key = hitKey(hit)
    const existing = byKey.get(key)
    if (existing !== undefined) {
      existing.reasons = [...new Set([...(existing.reasons ?? []), 'vector_similarity'])]
      existing.vectorScore = hit.score
      if (typeof existing.snippet !== 'string' || existing.snippet === '') existing.snippet = hit.snippet
      if (existing.page === undefined && hit.page !== undefined) existing.page = hit.page
    } else {
      byKey.set(key, hit)
    }
  }
  const entries = [...byKey.entries()].map(([key, hit]) => {
    const keywordPosition = keywordRank.get(key)
    const vectorPosition = vectorRank.get(key)
    const rrf = (keywordPosition === undefined ? 0 : 1 / (60 + keywordPosition + 1)) + (vectorPosition === undefined ? 0 : 1 / (60 + vectorPosition + 1))
    return { hit, rrf, original: keywordPosition ?? 1e9 }
  })
  const head = entries.filter((entry) => Number(entry.hit.tier ?? 0) >= 4).sort((left, right) => left.original - right.original)
  const tail = entries
    .filter((entry) => Number(entry.hit.tier ?? 0) < 4)
    .sort((left, right) => right.rrf - left.rrf || left.original - right.original)
  return [...head, ...tail].map((entry) => entry.hit)
}

export function createSearch({ db, store, fts5, logger, ai, embedding, settings, aiRerank = true, figureDistance = 10 }) {
  /** Run one FTS query, returning [] when the derived index is unusable. */
  function ftsAll(sql, params) {
    try {
      return db.prepare(sql).all(...params)
    } catch (error) {
      logger?.warn?.(`pappers-hall: FTS query failed: ${String(error?.message ?? error)}`)
      return []
    }
  }

  /** Delete every FTS row belonging to one paper. */
  function removePaperIndex(paperId) {
    if (fts5 !== true) return
    for (const table of ['papers_fts', 'pages_fts', 'figures_fts', 'annotations_fts', 'notes_fts']) {
      try {
        db.prepare(`DELETE FROM ${table} WHERE paper_id = ?`).run(paperId)
      } catch {
        // A missing derived table degrades to LIKE; never fail the business write.
      }
    }
  }

function keywordQuery(params = {}) {
    const started = Date.now()
    const queryText = typeof params.q === 'string' ? params.q.trim() : ''
    const scope = typeof params.scope === 'string' ? params.scope : 'library'
    const limit = clampInt(params.limit ?? 50, 1, 200, 50)
    const offset = clampInt(params.offset ?? 0, 0, 1_000_000, 0)
    const filters = params.filters ?? {}
    // v0.5 folder/tag/favorite filters: resolve the allowed paper set once and apply
    // it to every channel's hits (papers, figures, annotations, notes; the vector
    // channel uses the same allow-list). `filters` wins over top-level aliases.
    const filterSpec = {
      folderId: filters.folderId ?? params.folderId,
      tags: Array.isArray(filters.tags) ? filters.tags : Array.isArray(params.tags) ? params.tags : undefined,
      favorite: filters.favorite ?? params.favorite,
      field: filters.field ?? params.field,
    }
    const allowedPaperIdList = store !== undefined && typeof store.searchFilterPaperIds === 'function' ? store.searchFilterPaperIds(filterSpec) : null
    const allowedPaperIds = allowedPaperIdList === null ? null : new Set(allowedPaperIdList)
    const cjk = hasCjk(queryText)
    const channels = []
    const pool = Math.min(400, Math.max(60, limit * 4))
    /** @type {Map<string, object>} */
    const merged = new Map()

    /**
     * Ranking tiers (higher wins, then channel score):
     * 6 exact title, 5 title phrase, 4 all query terms in title,
     * 3 abstract/author phrase, 2 FTS keyword-or match, 0 AI-expansion-only.
     */
    const TIER = { exactTitle: 6, titlePhrase: 5, titleTerms: 4, abstractPhrase: 3, keyword: 2 }
    /** Merge one channel hit into the result map. */
    const add = (key, hit, reason, weight, tier = TIER.keyword) => {
      if (allowedPaperIds !== null) {
        const paperId = typeof hit.paperId === 'string' ? hit.paperId : hit.kind === 'paper' ? hit.id : undefined
        if (typeof paperId !== 'string' || !allowedPaperIds.has(paperId)) return
      }
      const existing = merged.get(key)
      if (existing === undefined) {
        merged.set(key, { ...hit, tier, reasons: [reason], score: weight })
        return
      }
      if (!existing.reasons.includes(reason)) existing.reasons.push(reason)
      existing.tier = Math.max(Number(existing.tier ?? 0), tier)
      existing.score = Math.max(existing.score, weight)
      if (existing.page === undefined && hit.page !== undefined) existing.page = hit.page
      if ((existing.snippet ?? '') === '' && typeof hit.snippet === 'string') existing.snippet = hit.snippet
    }

    const allowed = new Set(
      scope === 'library'
        ? ['paper', 'figure', 'annotation', 'note']
        : scope === 'papers' || scope === 'body' || scope === 'pages'
          ? ['paper']
          : scope === 'figures'
            ? ['figure']
            : scope === 'annotations'
              ? ['annotation']
              : scope === 'notes'
                ? ['note']
                : [],
    )
    if (allowed.size === 0) throw invalid(`unsupported search scope ${scope}`)

    const { clauses: filterClauses, params: filterParams } = paperFilters(filters, 'p')
    const filterSql = filterClauses.length === 0 ? '' : ` AND ${filterClauses.join(' AND ')}`
    // Notes may be paperless, so they cannot reuse the mandatory paper-state
    // clause; they keep the OR guard and the optional filters instead.
    const noteExtra = filterClauses.slice(1)
    const noteExtraParams = filterParams.slice(1)
    const noteExtraSql = noteExtra.length === 0 ? '' : ` AND ${noteExtra.join(' AND ')}`
    const match = queryText === '' ? null : ftsMatch(queryText)

    // ---- exact/phrase tier channel ------------------------------------
    // A long title-like query must always find its own paper first. LIKE tiers are
    // deterministic and cheap; FTS OR keywords stay as the recall channel below.
    const normalizedQuery = queryText.toLowerCase().replace(/\s+/g, ' ').trim()
    if (queryText !== '' && allowed.has('paper') && (scope === 'library' || scope === 'papers' || scope === 'body')) {
      const addPaperRows = (rows, reason, tier, weight) => {
        for (const row of rows) {
          add(
            `paper:${row.id}`,
            {
              kind: 'paper',
              id: row.id,
              paperId: row.id,
              title: row.display_title || row.title,
              titleZh: row.title_zh ?? null,
              snippet: likeSnippet(`${row.title} ${row.abstract ?? ''}`, queryText),
            },
            reason,
            weight,
            tier,
          )
        }
      }
      if (normalizedQuery.length >= 2) {
        const exactRows = db
          .prepare(
            `SELECT p.id, p.title, p.title_zh, p.display_title, p.abstract FROM papers p
             WHERE 1=1${filterSql} AND (
               LOWER(TRIM(p.title)) = ? OR LOWER(TRIM(COALESCE(p.title_zh, ''))) = ?
               OR LOWER(TRIM(COALESCE(p.display_title, ''))) = ?
             ) LIMIT 20`,
          )
          .all(...filterParams, normalizedQuery, normalizedQuery, normalizedQuery)
        addPaperRows(exactRows, 'exact_title_match', TIER.exactTitle, 10)
        const phrase = `%${escapeLike(queryText)}%`
        const phraseRows = db
          .prepare(
            `SELECT p.id, p.title, p.title_zh, p.display_title, p.abstract FROM papers p
             WHERE 1=1${filterSql} AND (
               LOWER(p.title) LIKE LOWER(?) ESCAPE '\\' OR LOWER(COALESCE(p.title_zh, '')) LIKE LOWER(?) ESCAPE '\\'
               OR LOWER(COALESCE(p.display_title, '')) LIKE LOWER(?) ESCAPE '\\'
             ) ORDER BY p.updated_at DESC LIMIT ?`,
          )
          .all(...filterParams, phrase, phrase, phrase, pool)
        addPaperRows(phraseRows, 'title_phrase_match', TIER.titlePhrase, 8)
        const tokens = ftsTokens(queryText)
        if (tokens.length >= 2) {
          const clauses = tokens.map(() => "(LOWER(p.title) LIKE LOWER(?) ESCAPE '\\' OR LOWER(COALESCE(p.title_zh, '')) LIKE LOWER(?) ESCAPE '\\')")
          const params = []
          for (const token of tokens) {
            const pattern = `%${escapeLike(token)}%`
            params.push(pattern, pattern)
          }
          const termRows = db
            .prepare(
              `SELECT p.id, p.title, p.title_zh, p.display_title, p.abstract FROM papers p
               WHERE 1=1${filterSql} AND ${clauses.join(' AND ')} LIMIT ?`,
            )
            .all(...filterParams, ...params, pool)
          addPaperRows(termRows, 'title_terms_match', TIER.titleTerms, 6)
        }
        const abstractPattern = `%${escapeLike(queryText)}%`
        const abstractRows = db
          .prepare(
            `SELECT p.id, p.title, p.title_zh, p.display_title, p.abstract FROM papers p
             WHERE 1=1${filterSql} AND (
               LOWER(COALESCE(p.abstract, '')) LIKE LOWER(?) ESCAPE '\\'
               OR LOWER(COALESCE(p.authors_json, '')) LIKE LOWER(?) ESCAPE '\\'
               OR LOWER(COALESCE(p.venue, '')) LIKE LOWER(?) ESCAPE '\\'
             ) LIMIT ?`,
          )
          .all(...filterParams, abstractPattern, abstractPattern, abstractPattern, pool)
        addPaperRows(abstractRows, 'abstract_phrase_match', TIER.abstractPhrase, 4)
      }
    }

    // ---- FTS5 channels -------------------------------------------------
    let ftsChannelOk = false
    if (fts5 === true && match !== null) {
      if (allowed.has('paper') && (scope === 'library' || scope === 'papers')) {
        const rows = ftsAll(
          `SELECT p.id, p.title, p.title_zh, p.display_title, bm25(papers_fts) AS rank,
                  snippet(papers_fts, 1, '[', ']', ' … ', 14) AS title_snippet,
                  snippet(papers_fts, 5, '[', ']', ' … ', 14) AS abstract_snippet
           FROM papers_fts JOIN papers p ON p.id = papers_fts.paper_id
           WHERE papers_fts MATCH ?${filterSql}
           ORDER BY rank LIMIT ?`,
          [match, ...filterParams, pool],
        )
        ftsChannelOk = true
        for (const row of rows) {
          add(
            `paper:${row.id}`,
            {
              kind: 'paper',
              id: row.id,
              paperId: row.id,
              title: row.display_title || row.title,
              titleZh: row.title_zh ?? null,
              snippet: (row.abstract_snippet || row.title_snippet || '').toString().trim(),
            },
            'title or abstract match',
            KIND_WEIGHTS.paperTitle * (1 / (1 + Math.max(0, Number(row.rank ?? 0)))),
          )
        }
      }
      if (allowed.has('paper') && (scope === 'library' || scope === 'body' || scope === 'pages')) {
        const rows = ftsAll(
          `SELECT p.id, p.title, p.title_zh, p.display_title, pages_fts.page AS page, bm25(pages_fts) AS rank,
                  snippet(pages_fts, 2, '[', ']', ' … ', 18) AS body_snippet
           FROM pages_fts JOIN papers p ON p.id = pages_fts.paper_id
           WHERE pages_fts MATCH ?${filterSql}
           ORDER BY rank LIMIT ?`,
          [match, ...filterParams, pool],
        )
        ftsChannelOk = true
        for (const row of rows) {
          add(
            `paper:${row.id}`,
            {
              kind: 'paper',
              id: row.id,
              paperId: row.id,
              title: row.display_title || row.title,
              titleZh: row.title_zh ?? null,
              page: Number(row.page),
              snippet: String(row.body_snippet ?? '').trim(),
            },
            'full text match',
            KIND_WEIGHTS.body * (1 / (1 + Math.max(0, Number(row.rank ?? 0)))),
          )
        }
      }
      if (allowed.has('figure') && (scope === 'library' || scope === 'figures')) {
        const rows = ftsAll(
          `SELECT f.id, f.paper_id, f.page, f.label, p.title, p.title_zh, p.display_title, bm25(figures_fts) AS rank,
                  snippet(figures_fts, 3, '[', ']', ' … ', 18) AS caption_snippet
           FROM figures_fts JOIN figures f ON f.id = figures_fts.figure_id JOIN papers p ON p.id = figures_fts.paper_id
           WHERE figures_fts MATCH ?${filterSql}
           ORDER BY rank LIMIT ?`,
          [match, ...filterParams, pool],
        )
        ftsChannelOk = true
        for (const row of rows) {
          add(
            `figure:${row.id}`,
            {
              kind: 'figure',
              id: row.id,
              paperId: row.paper_id,
              title: row.display_title || row.title,
              titleZh: row.title_zh ?? null,
              page: Number(row.page),
              figureLabel: row.label ?? null,
              snippet: String(row.caption_snippet ?? '').trim(),
            },
            'figure caption match',
            KIND_WEIGHTS.figure * (1 / (1 + Math.max(0, Number(row.rank ?? 0)))),
          )
        }
      }
      if (allowed.has('annotation') && (scope === 'library' || scope === 'annotations')) {
        const rows = ftsAll(
          `SELECT a.id, a.paper_id, a.page, a.kind AS annotation_kind, a.rects_json, p.title, p.title_zh, p.display_title, bm25(annotations_fts) AS rank,
                  snippet(annotations_fts, 2, '[', ']', ' … ', 18) AS text_snippet
           FROM annotations_fts JOIN annotations a ON a.id = annotations_fts.annotation_id JOIN papers p ON p.id = annotations_fts.paper_id
           WHERE annotations_fts MATCH ? AND a.state = 'active'${filterSql}
           ORDER BY rank LIMIT ?`,
          [match, ...filterParams, pool],
        )
        ftsChannelOk = true
        for (const row of rows) {
          add(
            `annotation:${row.id}`,
            {
              kind: 'annotation',
              id: row.id,
              paperId: row.paper_id,
              title: row.display_title || row.title,
              titleZh: row.title_zh ?? null,
              page: Number(row.page),
              annotationKind: row.annotation_kind ?? null,
              rects: parseRectsColumn(row.rects_json),
              snippet: String(row.text_snippet ?? '').trim(),
            },
            'annotation_match',
            KIND_WEIGHTS.annotation * (1 / (1 + Math.max(0, Number(row.rank ?? 0)))),
          )
        }
      }
      if (allowed.has('note') && (scope === 'library' || scope === 'notes')) {
        const rows = ftsAll(
          `SELECT n.id, n.paper_id, n.title AS note_title, p.title, p.title_zh, p.display_title, bm25(notes_fts) AS rank,
                  snippet(notes_fts, 3, '[', ']', ' … ', 18) AS text_snippet
           FROM notes_fts JOIN notes n ON n.id = notes_fts.note_id
           LEFT JOIN papers p ON p.id = notes_fts.paper_id
           WHERE notes_fts MATCH ? AND n.state = 'active' AND (n.paper_id IS NULL OR p.state = 'active')${noteExtraSql}
           ORDER BY rank LIMIT ?`,
          [match, ...noteExtraParams, pool],
        )
        ftsChannelOk = true
        for (const row of rows) {
          add(
            `note:${row.id}`,
            {
              kind: 'note',
              id: row.id,
              paperId: row.paper_id ?? null,
              title: row.note_title || row.display_title || row.title || 'Note',
              titleZh: row.title_zh ?? null,
              snippet: String(row.text_snippet ?? '').trim(),
            },
            'note match',
            KIND_WEIGHTS.note * (1 / (1 + Math.max(0, Number(row.rank ?? 0)))),
          )
        }
      }
    }

    // ---- LIKE channel (CJK, no-FTS builds, empty FTS results) ----------
    const likeChannelUsed = queryText !== '' && (cjk || fts5 !== true || merged.size === 0 || match === null)
    if (likeChannelUsed) {
      const pattern = `%${escapeLike(queryText)}%`
      if (allowed.has('paper') && (scope === 'library' || scope === 'papers' || scope === 'body')) {
        const paperRows = db
          .prepare(
            `SELECT p.id, p.title, p.title_zh, p.display_title, p.abstract
             FROM papers p WHERE 1=1${filterSql}
               AND (p.title LIKE ? ESCAPE '\\' OR p.title_zh LIKE ? ESCAPE '\\' OR p.display_title LIKE ? ESCAPE '\\'
                    OR p.authors_json LIKE ? ESCAPE '\\' OR p.venue LIKE ? ESCAPE '\\' OR p.abstract LIKE ? ESCAPE '\\')
             ORDER BY p.updated_at DESC LIMIT ?`,
          )
          .all(...filterParams, pattern, pattern, pattern, pattern, pattern, pattern, pool)
        for (const row of paperRows) {
          add(
            `paper:${row.id}`,
            {
              kind: 'paper',
              id: row.id,
              paperId: row.id,
              title: row.display_title || row.title,
              titleZh: row.title_zh ?? null,
              snippet: likeSnippet(`${row.title} ${row.abstract ?? ''}`, queryText),
            },
            scope === 'body' ? 'library metadata substring match' : 'title/author substring match',
            KIND_WEIGHTS.paperTitle * 0.8,
          )
        }
      }
      if (allowed.has('paper') && (scope === 'library' || scope === 'body' || scope === 'pages')) {
        const pageRows = db
          .prepare(
            `SELECT p.id, p.title, p.title_zh, p.display_title, pp.page,
                    CASE WHEN COALESCE(TRIM(pp.text), '') <> '' THEN pp.text ELSE pp.ocr_text END AS text
             FROM paper_pages pp JOIN papers p ON p.id = pp.paper_id
             WHERE 1=1${filterSql} AND (pp.text LIKE ? ESCAPE '\\' OR pp.ocr_text LIKE ? ESCAPE '\\')
             ORDER BY p.updated_at DESC, pp.page ASC LIMIT ?`,
          )
          .all(...filterParams, pattern, pattern, pool)
        for (const row of pageRows) {
          add(
            `paper:${row.id}`,
            {
              kind: 'paper',
              id: row.id,
              paperId: row.id,
              title: row.display_title || row.title,
              titleZh: row.title_zh ?? null,
              page: Number(row.page),
              snippet: likeSnippet(row.text, queryText),
            },
            'full text substring match',
            KIND_WEIGHTS.body * 0.85,
          )
        }
      }
      if (allowed.has('figure') && (scope === 'library' || scope === 'figures')) {
        const figureRows = db
          .prepare(
            `SELECT f.id, f.paper_id, f.page, f.label, f.caption, p.title, p.title_zh, p.display_title
             FROM figures f JOIN papers p ON p.id = f.paper_id
             WHERE 1=1${filterSql} AND (f.caption LIKE ? ESCAPE '\\' OR f.label LIKE ? ESCAPE '\\')
             ORDER BY p.updated_at DESC LIMIT ?`,
          )
          .all(...filterParams, pattern, pattern, pool)
        for (const row of figureRows) {
          add(
            `figure:${row.id}`,
            {
              kind: 'figure',
              id: row.id,
              paperId: row.paper_id,
              title: row.display_title || row.title,
              titleZh: row.title_zh ?? null,
              page: Number(row.page),
              figureLabel: row.label ?? null,
              snippet: likeSnippet(row.caption ?? row.label ?? '', queryText),
            },
            'figure caption substring match',
            KIND_WEIGHTS.figure * 0.85,
          )
        }
      }
      if (allowed.has('annotation') && (scope === 'library' || scope === 'annotations')) {
        const annotationRows = db
          .prepare(
            `SELECT a.id, a.paper_id, a.page, a.kind AS annotation_kind, a.rects_json, a.text, a.quote, a.comment, p.title, p.title_zh, p.display_title
             FROM annotations a JOIN papers p ON p.id = a.paper_id
             WHERE a.state = 'active'${filterSql} AND (a.text LIKE ? ESCAPE '\\' OR a.quote LIKE ? ESCAPE '\\' OR a.comment LIKE ? ESCAPE '\\')
             ORDER BY a.updated_at DESC LIMIT ?`,
          )
          .all(...filterParams, pattern, pattern, pattern, pool)
        for (const row of annotationRows) {
          add(
            `annotation:${row.id}`,
            {
              kind: 'annotation',
              id: row.id,
              paperId: row.paper_id,
              title: row.display_title || row.title,
              titleZh: row.title_zh ?? null,
              page: Number(row.page),
              annotationKind: row.annotation_kind ?? null,
              rects: parseRectsColumn(row.rects_json),
              snippet: likeSnippet(row.text ?? row.comment ?? '', queryText),
            },
            'annotation_match',
            KIND_WEIGHTS.annotation * 0.85,
          )
        }
      }
      if (allowed.has('note') && (scope === 'library' || scope === 'notes')) {
        const noteRows = db
          .prepare(
            `SELECT n.id, n.paper_id, n.title AS note_title, n.text, p.title, p.title_zh, p.display_title
             FROM notes n LEFT JOIN papers p ON p.id = n.paper_id
             WHERE n.state = 'active' AND (n.paper_id IS NULL OR p.state = 'active')${noteExtraSql} AND (n.text LIKE ? ESCAPE '\\' OR n.title LIKE ? ESCAPE '\\')
             ORDER BY n.updated_at DESC LIMIT ?`,
          )
          .all(...noteExtraParams, pattern, pattern, pool)
        for (const row of noteRows) {
          add(
            `note:${row.id}`,
            {
              kind: 'note',
              id: row.id,
              paperId: row.paper_id ?? null,
              title: row.note_title || row.display_title || row.title || 'Note',
              titleZh: row.title_zh ?? null,
              snippet: likeSnippet(row.text, queryText),
            },
            'note substring match',
            KIND_WEIGHTS.note * 0.85,
          )
        }
      }
    }

    channels.push(
      fts5 === true
        ? { name: 'fts5', status: ftsChannelOk ? 'ok' : 'degraded', note: ftsChannelOk ? 'SQLite FTS5 keyword channel' : `FTS5 produced no match for this query (${queryText === '' ? 'empty query' : 'tokens unusable'})` }
        : { name: 'fts5', status: 'degraded', note: 'SQLite FTS5 is unavailable in this build; deterministic LIKE channel only' },
    )
    if (likeChannelUsed) {
      channels.push({ name: 'like', status: 'ok', note: cjk ? 'CJK/phrase substring channel (LIKE, deterministic)' : 'Substring fallback channel (LIKE, deterministic)' })
    }
    const allHits = [...merged.values()].sort(
      (left, right) =>
        Number(right.tier ?? 0) - Number(left.tier ?? 0) ||
        right.score - left.score ||
        String(left.title).localeCompare(String(right.title)),
    )
    const items = allHits
      .slice(offset, offset + limit)
      .map((hit) => ({
        kind: hit.kind,
        id: hit.id,
        paperId: hit.paperId,
        title: hit.title,
        titleZh: hit.titleZh,
        ...(hit.page === undefined ? {} : { page: hit.page }),
        ...(hit.figureLabel === undefined || hit.figureLabel === null ? {} : { figureLabel: hit.figureLabel }),
        ...(hit.annotationKind === undefined || hit.annotationKind === null ? {} : { annotationKind: hit.annotationKind }),
        ...(hit.rects === undefined || hit.rects.length === 0 ? {} : { rects: hit.rects }),
        snippet: hit.snippet ?? '',
        reasons: hit.reasons,
        score: Math.round(hit.score * 10_000) / 10_000,
      }))

    return { items, channels, tookMs: Date.now() - started, total: allHits.length }
}

    /* -------------------------- vector channel ---------------------- */

    /** Embed the query and turn stored chunks into scoped hits. */
    async function vectorChannel(queryText, params, allowedPaperIds, limitPool) {
      if (embedding === undefined || embedding === null) {
        return { status: 'unavailable', reason: 'embedding service is not initialized', model: null, items: [] }
      }
      const scope = typeof params.scope === 'string' ? params.scope : 'library'
      const kinds = scope === 'pages' ? ['page'] : scope === 'figures' ? ['figure'] : scope === 'annotations' ? ['annotation'] : scope === 'papers' ? ['paper'] : undefined
      let result
      try {
        result = await embedding.searchVectors(queryText, {
          k: Math.max(60, Math.min(400, limitPool * 4)),
          kinds,
          paperIds: allowedPaperIds === null ? undefined : [...allowedPaperIds],
        })
      } catch (error) {
        return { status: 'unavailable', reason: String(error?.message ?? error), model: null, items: [] }
      }
      if (result.available !== true) {
        return {
          status: result.indexReady === false && embedding.facts?.().configured === true ? 'degraded' : 'unavailable',
          reason: result.reason ?? 'vector search unavailable',
          model: result.model ?? null,
          dims: result.dims ?? null,
          items: [],
        }
      }
      const chunks = result.items
      const paperIds = [...new Set(chunks.map((chunk) => chunk.paperId).filter((id) => typeof id === 'string'))]
      const paperRows = new Map()
      if (paperIds.length > 0) {
        for (const row of db.prepare(`SELECT id, title, title_zh FROM papers WHERE id IN (${paperIds.map(() => '?').join(',')})`).all(...paperIds)) {
          paperRows.set(row.id, row)
        }
      }
      const titleOf = (id) => paperRows.get(id) ?? { title: '', title_zh: null }
      const items = []
      if (scope === 'pages') {
        for (const chunk of chunks) {
          if (chunk.kind !== 'page') continue
          const paper = titleOf(chunk.paperId)
          items.push({
            kind: 'page',
            id: `page:${chunk.paperId}:${chunk.page}`,
            paperId: chunk.paperId,
            title: paper.title_zh ?? paper.title,
            titleOriginal: paper.title_zh === null ? null : paper.title,
            page: chunk.page,
            snippet: String(chunk.text ?? '').slice(0, 260),
            reasons: ['vector_similarity'],
            score: chunk.score,
            vectorScore: chunk.score,
            tier: 0,
          })
        }
      } else if (scope === 'figures') {
        for (const chunk of chunks) {
          if (chunk.kind !== 'figure') continue
          const figure = db.prepare('SELECT id, paper_id, page, label, caption FROM figures WHERE id = ?').get(chunk.refId)
          const paper = titleOf(chunk.paperId)
          items.push({
            kind: 'figure',
            id: chunk.refId,
            paperId: chunk.paperId,
            title: paper.title_zh ?? paper.title,
            page: figure?.page === undefined || figure?.page === null ? chunk.page : Number(figure.page),
            label: figure?.label ?? null,
            snippet: String(figure?.caption ?? chunk.text ?? '').slice(0, 260),
            reasons: ['vector_similarity'],
            score: chunk.score,
            vectorScore: chunk.score,
            tier: 0,
          })
        }
      } else if (scope === 'annotations') {
        for (const chunk of chunks) {
          if (chunk.kind !== 'annotation') continue
          const annotation = db.prepare('SELECT id, paper_id, page, quote, comment, color, kind FROM annotations WHERE id = ?').get(chunk.refId)
          const paper = titleOf(chunk.paperId)
          items.push({
            kind: 'annotation',
            id: chunk.refId,
            paperId: chunk.paperId,
            title: paper.title_zh ?? paper.title,
            page: chunk.page,
            snippet: String(annotation?.quote ?? annotation?.comment ?? chunk.text ?? '').slice(0, 260),
            reasons: ['vector_similarity'],
            score: chunk.score,
            vectorScore: chunk.score,
            tier: 0,
          })
        }
      } else {
        // Library/papers scope: aggregate chunk similarity per paper (max).
        const best = new Map()
        for (const chunk of chunks) {
          if (typeof chunk.paperId !== 'string') continue
          const current = best.get(chunk.paperId)
          if (current === undefined || chunk.score > current.score) best.set(chunk.paperId, chunk)
        }
        for (const [paperId, chunk] of best) {
          const paper = titleOf(paperId)
          items.push({
            kind: 'paper',
            id: paperId,
            paperId,
            title: paper.title_zh ?? paper.title,
            titleOriginal: paper.title_zh === null ? null : paper.title,
            snippet: String(chunk.text ?? '').slice(0, 260),
            page: chunk.page ?? undefined,
            reasons: ['vector_similarity'],
            score: chunk.score,
            vectorScore: chunk.score,
            tier: 0,
          })
        }
      }
      items.sort((left, right) => right.score - left.score)
      return {
        status: 'ok',
        model: result.model,
        dims: result.dims,
        latencyMs: result.latencyMs,
        chunks: result.k ?? chunks.length,
        items,
        note: `cosine similarity over ${result.model} chunks (${result.k ?? chunks.length} candidates); fused with keyword channels via RRF — scores are relative, not probabilities`,
      }
    }


  const service = {
    available: fts5 === true,

    /** Index facts for `status`. */
    indexFacts() {
      const paperCount = Number(db.prepare("SELECT COUNT(*) AS count FROM papers WHERE state = 'active'").get()?.count ?? 0)
      // v0.5-B: the vector capability is real when the local embedding index is
      // built; otherwise report degraded (component installed, index pending) or
      // unavailable (component missing) — never pretend a semantic index exists.
      let vector = 'unavailable'
      const vectorFeatureEnabled = settings === undefined || settings === null || typeof settings.features !== 'function' ? true : settings.features().vectorSearch !== false
      if (!vectorFeatureEnabled) vector = 'disabled'
      else if (embedding !== undefined && embedding !== null) {
        const facts = typeof embedding.facts === 'function' ? embedding.facts() : null
        if (facts !== null && facts.available === true && facts.indexReady === true) vector = 'ready'
        else if (facts !== null && facts.configured === true) vector = 'degraded'
      }
      return {
        channels: { fts: fts5 === true ? 'ready' : 'degraded', vector },
        paperCount,
      }
    },

    /** Rebuild the papers_fts row of one paper. */
    indexPaper(paperId) {
      if (fts5 !== true) return
      const row = db.prepare('SELECT * FROM papers WHERE id = ?').get(paperId)
      if (row === undefined) return
      let authors = []
      try {
        authors = JSON.parse(row.authors_json)
      } catch {
        authors = []
      }
      const authorText = Array.isArray(authors)
        ? authors.map((author) => author?.literal ?? [author?.given, author?.family].filter(Boolean).join(' ')).join(', ')
        : ''
      try {
        db.prepare('DELETE FROM papers_fts WHERE paper_id = ?').run(paperId)
        db.prepare('INSERT INTO papers_fts(paper_id, title, title_zh, authors, venue, abstract) VALUES (?, ?, ?, ?, ?, ?)').run(
          paperId,
          row.title ?? '',
          row.title_zh ?? '',
          authorText,
          row.venue ?? '',
          row.abstract ?? '',
        )
      } catch (error) {
        logger?.warn?.(`pappers-hall: papers_fts index failed: ${String(error?.message ?? error)}`)
      }
    },

    /** Rebuild the pages_fts rows of one paper. */
    indexPages(paperId) {
      if (fts5 !== true) return
      try {
        db.prepare('DELETE FROM pages_fts WHERE paper_id = ?').run(paperId)
        const insert = db.prepare('INSERT INTO pages_fts(paper_id, page, text) VALUES (?, ?, ?)')
        for (const row of db.prepare('SELECT page, text, ocr_text FROM paper_pages WHERE paper_id = ? ORDER BY page').all(paperId)) {
          // v0.11: scanned pages index their OCR text when there is no native layer.
          const native = typeof row.text === 'string' ? row.text : ''
          const text = native.trim() !== '' ? native : typeof row.ocr_text === 'string' ? row.ocr_text : ''
          if (text.trim() !== '') insert.run(paperId, String(row.page), text)
        }
      } catch (error) {
        logger?.warn?.(`pappers-hall: pages_fts index failed: ${String(error?.message ?? error)}`)
      }
    },

    /** Rebuild the figures_fts rows of one paper. */
    indexFigures(paperId) {
      if (fts5 !== true) return
      try {
        db.prepare('DELETE FROM figures_fts WHERE paper_id = ?').run(paperId)
        const insert = db.prepare('INSERT INTO figures_fts(figure_id, paper_id, label, caption) VALUES (?, ?, ?, ?)')
        for (const row of db.prepare('SELECT id, label, caption FROM figures WHERE paper_id = ? ORDER BY page').all(paperId)) {
          insert.run(row.id, paperId, row.label ?? '', row.caption ?? '')
        }
      } catch (error) {
        logger?.warn?.(`pappers-hall: figures_fts index failed: ${String(error?.message ?? error)}`)
      }
    },

    /** Rebuild the annotations_fts rows of one paper. */
    indexAnnotations(paperId) {
      if (fts5 !== true) return
      try {
        db.prepare('DELETE FROM annotations_fts WHERE paper_id = ?').run(paperId)
        const insert = db.prepare('INSERT INTO annotations_fts(annotation_id, paper_id, text, quote) VALUES (?, ?, ?, ?)')
        for (const row of db.prepare("SELECT id, text, quote, comment FROM annotations WHERE paper_id = ? AND state = 'active'").all(paperId)) {
          insert.run(row.id, paperId, [row.text, row.comment].filter((value) => typeof value === 'string' && value !== '').join(' '), row.quote ?? '')
        }
      } catch (error) {
        logger?.warn?.(`pappers-hall: annotations_fts index failed: ${String(error?.message ?? error)}`)
      }
    },

    /** Re-index one annotation row. */
    indexAnnotation(annotationId) {
      if (fts5 !== true) return
      const row = db.prepare('SELECT * FROM annotations WHERE id = ?').get(annotationId)
      if (row === undefined) return
      try {
        db.prepare('DELETE FROM annotations_fts WHERE annotation_id = ?').run(annotationId)
        if (row.state === 'active') {
          db.prepare('INSERT INTO annotations_fts(annotation_id, paper_id, text, quote) VALUES (?, ?, ?, ?)').run(
            annotationId,
            row.paper_id,
            [row.text, row.comment].filter((value) => typeof value === 'string' && value !== '').join(' '),
            row.quote ?? '',
          )
        }
      } catch (error) {
        logger?.warn?.(`pappers-hall: annotation index failed: ${String(error?.message ?? error)}`)
      }
    },

    /** Re-index one note row. */
    indexNote(noteId) {
      if (fts5 !== true) return
      const row = db.prepare('SELECT * FROM notes WHERE id = ?').get(noteId)
      if (row === undefined) return
      try {
        db.prepare('DELETE FROM notes_fts WHERE note_id = ?').run(noteId)
        if (row.state === 'active') {
          db.prepare('INSERT INTO notes_fts(note_id, paper_id, title, text) VALUES (?, ?, ?, ?)').run(
            noteId,
            row.paper_id ?? '',
            row.title ?? '',
            row.text ?? '',
          )
        }
      } catch (error) {
        logger?.warn?.(`pappers-hall: note index failed: ${String(error?.message ?? error)}`)
      }
    },

    /** Remove one annotation from the derived index. */
    removeAnnotationIndex(annotationId) {
      if (fts5 !== true) return
      try {
        db.prepare('DELETE FROM annotations_fts WHERE annotation_id = ?').run(annotationId)
      } catch {}
    },

    /** Remove one note from the derived index. */
    removeNoteIndex(noteId) {
      if (fts5 !== true) return
      try {
        db.prepare('DELETE FROM notes_fts WHERE note_id = ?').run(noteId)
      } catch {}
    },

    removePaperIndex,

    /** Rebuild every derived index (used by maintenance and the selftest). */
    rebuildAll() {
      if (fts5 !== true) return
      for (const table of ['papers_fts', 'pages_fts', 'figures_fts', 'annotations_fts', 'notes_fts']) {
        try {
          db.prepare(`DELETE FROM ${table}`).run()
        } catch {}
      }
      for (const row of db.prepare('SELECT id FROM papers').all()) {
        service.indexPaper(row.id)
        service.indexPages(row.id)
        service.indexFigures(row.id)
        service.indexAnnotations(row.id)
      }
      for (const row of db.prepare("SELECT id FROM notes WHERE state = 'active'").all()) service.indexNote(row.id)
    },

    /* ----------------------------- query -------------------------- */

    /**
     * `search.query` (v0.2) — keyword channels plus optional AI expansion/re-rank.
     *
     * Keyword scoring is unchanged from v0.1. When the composed LLM is available
     * and `ai !== 'off'`, a Chinese or low-recall query is expanded into English
     * keywords (merged with reason `ai_semantic_expansion`) and the top-20 hits are
     * optionally re-ranked (reason `ai_rerank`). Every AI step reports its channel
     * or falls back to keyword-only results with a degraded reason — no fabricated
     * semantic score is ever produced.
     * @param {object} params query/scope/filters/paging/ai.
     * @returns {Promise<{items:object[], channels:object[], tookMs:number}>}
     */
    async query(params = {}) {
      const started = Date.now()
      const queryText = typeof params.q === 'string' ? params.q.trim() : ''
      const limit = clampInt(params.limit ?? 50, 1, 200, 50)
      const offset = clampInt(params.offset ?? 0, 0, 1_000_000, 0)
      const aiMode = params.ai === 'off' ? 'off' : 'auto'
      // Fetch a page-sized pool before pagination so expansion/rerank can move
      // hits across the page boundary correctly.
      const base = keywordQuery({ ...params, offset: 0, limit: Math.min(200, offset + limit) })
      let items = base.items
      let total = base.total
      const channels = [...base.channels]
      if (queryText === '') {
        return { items: items.slice(offset, offset + limit), channels, tookMs: Date.now() - started, total }
      }
      // v0.5-B: real semantic channel (multilingual MiniLM), fused with keyword
      // channels by RRF. Unavailable/degraded is reported honestly, never faked.
      // `vector:false` (or `channels` without 'vector') is the pure-lexical
      // baseline used by the semantic evaluation: no embedding call is made.
      const vectorFeatureEnabled = settings === undefined || settings === null || typeof settings.features !== 'function' ? true : settings.features().vectorSearch !== false
      const vectorDisabled =
        vectorFeatureEnabled === false ||
        params.vector === false ||
        (Array.isArray(params.channels) && params.channels.length > 0 && !params.channels.map((name) => String(name).toLowerCase()).includes('vector'))
      const vectorFilters = params.filters ?? {}
      const vectorFilterSpec = {
        folderId: vectorFilters.folderId ?? params.folderId,
        tags: Array.isArray(vectorFilters.tags) ? vectorFilters.tags : Array.isArray(params.tags) ? params.tags : undefined,
        favorite: vectorFilters.favorite ?? params.favorite,
        field: vectorFilters.field ?? params.field,
      }
      const vectorAllowedIds = store !== undefined && typeof store.searchFilterPaperIds === 'function' ? store.searchFilterPaperIds(vectorFilterSpec) : null
      const vectorAllowed = vectorAllowedIds === null ? null : new Set(vectorAllowedIds)
      let vector = null
      if (vectorDisabled) {
        channels.push({
          name: 'vector',
          status: 'off',
          note: vectorFeatureEnabled === false ? '向量检索已在设置中关闭；当前仅关键词通道' : 'vector:false requested; keyword channels only (pure FTS/LIKE baseline)',
        })
      } else {
        try {
          vector = await vectorChannel(queryText, params, vectorAllowed, Math.min(200, offset + limit))
        } catch (error) {
          vector = { status: 'unavailable', reason: String(error?.message ?? error), model: null, items: [] }
        }
      }
      if (vector !== null) {
        channels.push(
          vector.status === 'ok'
            ? { name: 'vector', status: 'ok', model: vector.model, latencyMs: vector.latencyMs, k: vector.chunks ?? vector.items.length, note: vector.note }
            : { name: 'vector', status: vector.status, model: vector.model ?? null, latencyMs: vector.latencyMs ?? null, note: vector.reason ?? `vector search ${vector.status}` },
        )
        if (vector.status === 'ok' && vector.items.length > 0) {
          items = fuseVectorHits(items, vector.items)
          total = Math.max(total, items.length)
        }
      }
      const facts = ai !== undefined && typeof ai.availability === 'function' ? ai.availability() : { available: false, reason: 'AI service is not initialized' }
      const aiUsable = aiMode !== 'off' && facts.available === true
      if (aiMode === 'off') {
        channels.push({ name: 'ai_expand', status: 'off', note: 'ai:"off" requested; keyword channels only' })
        channels.push({ name: 'ai_rerank', status: 'off', note: 'ai:"off" requested; keyword ordering kept' })
      } else if (!aiUsable) {
        channels.push({ name: 'ai_expand', status: 'degraded', model: facts.model ?? null, note: facts.reason ?? 'AI unavailable; keyword channels only' })
        channels.push({ name: 'ai_rerank', status: 'degraded', model: facts.model ?? null, note: facts.reason ?? 'AI unavailable; keyword ordering kept' })
      } else {
        const wantedExpansion = hasCjk(queryText) || items.length < Math.max(5, Math.ceil(limit / 2))
        if (wantedExpansion) {
          const expansion = await ai.expandQuery(queryText, params.sessionId)
          if (expansion !== undefined && Array.isArray(expansion.terms) && expansion.terms.length > 0) {
            const extra = keywordQuery({ ...params, q: expansion.terms.join(' '), offset: 0, limit: Math.min(200, offset + limit) })
            const mergedResult = mergeSearchHits(items, extra.items, 'ai_semantic_expansion')
            items = mergedResult.items
            total = offset === 0 ? mergedResult.items.length : Math.max(total, base.total + mergedResult.added)
            channels.push({
              name: 'ai_expand',
              status: 'ok',
              model: expansion.model,
              note:
                expansion.fallback === true
                  ? `deterministic fallback keywords (${expansion.reason ?? 'model output unusable'}): ${expansion.terms.slice(0, 4).join(', ')}; recall via expanded keywords, NOT vector semantics`
                  : `AI keyword expansion hit (${expansion.terms.length} term(s), e.g. ${expansion.terms.slice(0, 3).join(', ')}); recall via expanded keywords, NOT vector semantics`,
            })
          } else {
            channels.push({ name: 'ai_expand', status: 'degraded', model: facts.model, note: 'AI expansion produced no usable terms; keyword channels only' })
          }
        }
        if (aiRerank === true && items.length >= 3 && offset === 0) {
          const reranked = await ai.rerank(queryText, items.slice(0, 20), params.sessionId)
          if (reranked !== undefined && Array.isArray(reranked.order)) {
            const order = new Map()
            for (const [index, id] of reranked.order.entries()) if (!order.has(id)) order.set(id, index)
            const ranked = []
            const rest = []
            for (const hit of items) {
              const position = order.get(hit.paperId) ?? order.get(hit.id)
              if (position === undefined) rest.push(hit)
              else ranked.push({ hit, position })
            }
            ranked.sort((left, right) => left.position - right.position)
            const rerankedItems = [...ranked.map((entry) => ({ ...entry.hit, reasons: [...new Set([...(entry.hit.reasons ?? []), 'ai_rerank'])] })), ...rest]
            // Exact/phrase matches from the original query always stay in front of
            // the model's order: rerank only refines the keyword/expansion tail.
            const hoisted = rerankedItems.filter((hit) => Number(hit.tier ?? 0) >= 4)
            const refined = rerankedItems.filter((hit) => Number(hit.tier ?? 0) < 4)
            items = [...hoisted, ...refined]
            channels.push({ name: 'ai_rerank', status: 'ok', model: reranked.model, note: `re-ranked ${Math.min(20, ranked.length)} hit(s) with the model; order is a suggestion, not a probability` })
          } else {
            channels.push({
              name: 'ai_rerank',
              status: 'degraded',
              model: facts.model,
              note: `AI rerank unavailable (${reranked?.error ?? 'no usable scores'}); keyword ordering kept`,
            })
          }
        }
      }
      return { items: items.slice(offset, offset + limit), channels, tookMs: Date.now() - started, total }
    },

    /* ------------------------- semantic search --------------------- */

    /**
     * `search.semantic` — pure vector search over paper embeddings.
     *
     * Unlike {@link query} this does not fuse keyword channels: the library's
     * "语义" mode shows nearest neighbours with their cosine similarity, so the
     * ranking has to be the embedding's ranking. Availability is reported
     * honestly, and a missing embedding component or empty index is a normal
     * answer, not an error.
     *
     * @param {object} params q, limit, offset, filters.
     * @returns {Promise<{available:boolean, reason?:string, model?:string|null, items:object[], total:number, tookMs:number}>} neighbours.
     */
    async semanticQuery(params = {}) {
      const started = Date.now()
      const queryText = typeof params.q === 'string' ? params.q.trim() : ''
      const limit = clampInt(params.limit ?? 20, 1, 100, 20)
      const base = { items: [], total: 0, tookMs: 0, model: null }
      if (queryText === '') return { available: true, reason: '', ...base, tookMs: Date.now() - started }
      if (embedding === undefined || embedding === null) {
        return { available: false, reason: 'embedding service is not initialized', ...base, tookMs: Date.now() - started }
      }
      const filterSpec = params.filters ?? {}
      const allowedIds =
        store !== undefined && typeof store.searchFilterPaperIds === 'function'
          ? store.searchFilterPaperIds({
              folderId: filterSpec.folderId ?? params.folderId,
              tags: Array.isArray(filterSpec.tags) ? filterSpec.tags : Array.isArray(params.tags) ? params.tags : undefined,
              favorite: filterSpec.favorite ?? params.favorite,
              field: filterSpec.field ?? params.field,
            })
          : null
      let result
      try {
        result = await embedding.searchVectors(queryText, {
          k: Math.max(40, Math.min(400, limit * 6)),
          kinds: ['paper'],
          paperIds: allowedIds === null ? undefined : [...allowedIds],
        })
      } catch (error) {
        return { available: false, reason: String(error?.message ?? error), ...base, tookMs: Date.now() - started }
      }
      if (result.available !== true) {
        return {
          ...base,
          available: false,
          reason: result.reason ?? 'vector search unavailable',
          indexReady: result.indexReady !== false,
          model: result.model ?? null,
          tookMs: Date.now() - started,
        }
      }
      // One row per paper: keep the best chunk score and its opening text.
      const best = new Map()
      for (const chunk of result.items ?? []) {
        if (chunk.kind !== 'paper' || typeof chunk.paperId !== 'string') continue
        const score = Number(chunk.score) || 0
        const previous = best.get(chunk.paperId)
        if (previous === undefined || score > previous.score) {
          best.set(chunk.paperId, { score, text: String(chunk.text ?? '') })
        }
      }
      const ids = [...best.entries()].sort((left, right) => right[1].score - left[1].score).slice(0, limit).map((entry) => entry[0])
      const items = []
      if (ids.length > 0) {
        const rows = new Map()
        for (const row of db.prepare(`SELECT id, title, title_zh, abstract, year, venue FROM papers WHERE id IN (${ids.map(() => '?').join(',')})`).all(...ids)) {
          rows.set(row.id, row)
        }
        for (const id of ids) {
          const row = rows.get(id)
          if (row === undefined) continue
          const entry = best.get(id)
          items.push({
            kind: 'paper',
            id,
            paperId: id,
            title: row.title_zh ?? row.title,
            titleZh: row.title_zh ?? null,
            titleOriginal: row.title_zh === null ? row.title : row.title,
            year: row.year ?? null,
            venue: row.venue ?? null,
            snippet: (row.abstract ? String(row.abstract) : entry.text).replace(/\s+/g, ' ').slice(0, 260),
            similarity: Math.round(entry.score * 10_000) / 10_000,
            reasons: ['vector_similarity'],
          })
        }
      }
      return {
        available: true,
        model: result.model ?? null,
        dims: result.dims ?? null,
        items,
        total: best.size,
        tookMs: Date.now() - started,
      }
    },

    /* -------------------------- figure search --------------------- */

    /**
     * `figures.search` — caption text recall plus dHash near-duplicate search.
     * @param {object} params q/imageBase64/mode/limit.
     * @returns {{items:object[], channels:object[]}}
     */
    figuresSearch(params = {}) {
      const queryText = typeof params.q === 'string' ? params.q.trim() : ''
      const sourceFigureId = typeof params.figureId === 'string' && params.figureId.trim() !== '' ? params.figureId.trim() : undefined
      const mode = params.mode === 'text' || params.mode === 'image' || params.mode === 'similar' ? params.mode : 'auto'
      const limit = clampInt(params.limit ?? 20, 1, 100, 20)
      const channels = []
      const wantedText = queryText !== '' && mode !== 'image' && mode !== 'similar'
      const wantedImage = typeof params.imageBase64 === 'string' && params.imageBase64 !== '' && mode !== 'text'
      const wantedSimilar = sourceFigureId !== undefined && mode !== 'text'
      const items = new Map()

      const addItem = (figureId, hit, reason, score) => {
        const existing = items.get(figureId)
        if (existing === undefined) {
          items.set(figureId, { ...hit, reasons: [reason], score })
          return
        }
        if (!existing.reasons.includes(reason)) existing.reasons.push(reason)
        existing.score = Math.max(existing.score, score)
      }
      /** Add corroborating evidence on top of the current score (unlike addItem's max). */
      const bump = (figureId, amount) => {
        const existing = items.get(figureId)
        if (existing !== undefined) existing.score += amount
      }
      const numericPaperHits = new Set()
      const termPaperHits = new Set()

      // Deterministic figure-recall signals for long Chinese questions:
      // page references ("第 4 页"), figure/table numbers ("图 2"/"Figure 3") and
      // caption term overlap. Without this a Chinese question never matches the
      // English captions and the audited figure is missing from the result set.
      const requestedPages = new Set()
      for (const matchPage of queryText.matchAll(/第\s*(\d+)\s*页|(?:page|p\.?)\s*(\d+)/gi)) {
        const page = Number(matchPage[1] ?? matchPage[2])
        if (Number.isInteger(page) && page >= 1) requestedPages.add(page)
      }
      const requestedLabels = []
      for (const matchLabel of queryText.matchAll(/(图|表|figure|fig\.?|table)\s*([0-9]+[a-z]?)/gi)) {
        const kind = /^(表|table)$/i.test(matchLabel[1]) ? 'table' : 'figure'
        const number = String(matchLabel[2]).toLowerCase()
        if (!requestedLabels.some((entry) => entry.kind === kind && entry.number === number)) requestedLabels.push({ kind, number })
      }
      const captionTerms = new Set()
      for (const matchTerm of queryText.matchAll(/[\u4e00-\u9fff]{2,6}/g)) {
        const term = matchTerm[0].replace(/[的了是与和及在把有这那张里下上吗呢？。，、；：]/g, '')
        if (term.length >= 2) captionTerms.add(term)
      }
      for (const matchTerm of queryText.matchAll(/[A-Za-z][A-Za-z-]{2,}/g)) captionTerms.add(matchTerm[0].toLowerCase())
      let signalUsed = false
      if (wantedText && (requestedPages.size > 0 || requestedLabels.length > 0)) {
        signalUsed = true
        const addSignal = (figureId, reason, score) => addItem(figureId, { figureId }, reason, score)
        for (const page of requestedPages) {
          const rows = db
            .prepare(
              `SELECT f.id, f.page, f.label FROM figures f JOIN papers p ON p.id = f.paper_id
               WHERE p.state = 'active' AND f.page = ? LIMIT 60`,
            )
            .all(page)
          for (const row of rows) addSignal(row.id, 'figure_page_match', 2)
        }
        for (const requested of requestedLabels) {
          // Detected labels are normalized ("Figure 2", "Table 3"); accept the
          // singular/plural and "Fig." spellings via a prefix match on the number.
          const rows = db
            .prepare(
              `SELECT f.id, f.page, f.label FROM figures f JOIN papers p ON p.id = f.paper_id
               WHERE p.state = 'active' AND LOWER(f.label) LIKE ? LIMIT 80`,
            )
            .all(`% ${requested.number}`)
          for (const row of rows) {
            const labelMatches = row.label !== null && LOWER_LABEL_PREFIX(row.label, requested.kind) === true
            if (!labelMatches) continue
            const onRequestedPage = requestedPages.size === 0 || requestedPages.has(Number(row.page))
            addSignal(row.id, onRequestedPage ? 'figure_signal_exact' : 'figure_label_match', onRequestedPage ? 2.8 : 2.4)
          }
        }
        channels.push({
          name: 'figure_signals',
          status: 'ok',
          note: `deterministic page/figure-number recall: pages=[${[...requestedPages].join(', ')}] labels=[${requestedLabels.map((entry) => `${entry.kind} ${entry.number}`).join(', ')}]`,
        })
      }
      const numericTerms = new Set()
      for (const matchNumber of queryText.matchAll(/\d+(?:\.\d+)?%?/g)) {
        const token = matchNumber[0]
        // "1.0", "100%", "3.5" are specific enough to identify a caption; single
        // page/figure digits are handled by the page/label signals instead.
        if (token.length >= 2 && (/[.%]/.test(token) || token.length >= 2)) numericTerms.add(token)
      }
      if (wantedText && numericTerms.size > 0) {
        for (const token of [...numericTerms].slice(0, 6)) {
          const pattern = `%${escapeLike(token)}%`
          const rows = db
            .prepare(
              `SELECT f.id, f.paper_id FROM figures f JOIN papers p ON p.id = f.paper_id
               WHERE p.state = 'active' AND LOWER(f.caption) LIKE LOWER(?) ESCAPE '\\' LIMIT 40`,
            )
            .all(pattern)
          for (const row of rows) {
            addItem(row.id, { figureId: row.id }, 'caption_number_match', 1.4)
            bump(row.id, 0.9)
            numericPaperHits.add(row.paper_id)
          }
        }
        channels.push({
          name: 'caption_numbers',
          status: 'ok',
          note: `caption numeric-token recall: ${[...numericTerms].slice(0, 4).join(', ')}`,
        })
      }
      let captionTermsUsed = false
      if (wantedText && captionTerms.size > 0) {
        captionTermsUsed = true
        for (const term of [...captionTerms].slice(0, 10)) {
          const pattern = `%${escapeLike(term)}%`
          const rows = db
            .prepare(
              `SELECT f.id, f.paper_id FROM figures f JOIN papers p ON p.id = f.paper_id
               WHERE p.state = 'active' AND LOWER(f.caption) LIKE LOWER(?) ESCAPE '\\' LIMIT 40`,
            )
            .all(pattern)
          for (const row of rows) {
            addItem(row.id, { figureId: row.id }, 'caption_terms_match', 0.7)
            bump(row.id, 0.12)
            termPaperHits.add(row.paper_id)
          }
        }
        channels.push({
          name: 'caption_terms',
          status: 'ok',
          note: `caption term overlap over ${Math.min(10, captionTerms.size)} term(s); deterministic substring recall`,
        })
      }

      const match = queryText === '' ? null : ftsMatch(queryText)
      let captionOk = false
      if (wantedText && fts5 === true && match !== null) {
        try {
          const rows = db
            .prepare(
              `SELECT f.id, bm25(figures_fts) AS rank, snippet(figures_fts, 3, '[', ']', ' … ', 20) AS caption_snippet
               FROM figures_fts JOIN figures f ON f.id = figures_fts.figure_id JOIN papers p ON p.id = figures_fts.paper_id
               WHERE figures_fts MATCH ? AND p.state = 'active' ORDER BY rank LIMIT ?`,
            )
            .all(match, limit * 3)
          captionOk = true
          for (const row of rows) {
            addItem(row.id, { figureId: row.id, snippet: String(row.caption_snippet ?? '').trim() }, 'caption_match', 1 / (1 + Math.max(0, Number(row.rank ?? 0))))
          }
        } catch (error) {
          logger?.warn?.(`pappers-hall: figure caption FTS failed: ${String(error?.message ?? error)}`)
        }
      }
      if (wantedText && (hasCjk(queryText) || fts5 !== true || items.size === 0)) {
        const pattern = `%${escapeLike(queryText)}%`
        const rows = db
          .prepare(
            `SELECT f.id, f.caption, p.state FROM figures f JOIN papers p ON p.id = f.paper_id
             WHERE p.state = 'active' AND (f.caption LIKE ? ESCAPE '\\' OR f.label LIKE ? ESCAPE '\\') LIMIT ?`,
          )
          .all(pattern, pattern, limit * 3)
        for (const row of rows) {
          addItem(row.id, { figureId: row.id, snippet: likeSnippet(row.caption ?? '', queryText) }, 'caption_like_match', 0.8)
        }
        if (!captionOk && fts5 !== true) channels.push({ name: 'caption_fts', status: 'degraded', note: 'FTS5 unavailable; caption LIKE only' })
        else if (!captionOk) channels.push({ name: 'caption_fts', status: 'degraded', note: 'FTS5 caption channel returned no rows; LIKE channel used' })
      } else if (wantedText) {
        channels.push({ name: 'caption_fts', status: captionOk ? 'ok' : 'degraded', note: captionOk ? 'Figure caption FTS5 channel' : 'Figure caption FTS5 channel produced no match' })
      }

      if (wantedSimilar) {
        // "Find similar figures": reuse the source figure's own dHash. This is a
        // near-duplicate channel (crop/scale/rescale robust), never an embedding
        // similarity, and it never returns the source figure itself.
        const sourceRow = store.figureRow(sourceFigureId)
        if (sourceRow === undefined) throw notFound(`figure ${sourceFigureId} does not exist`, { id: sourceFigureId })
        const sourcePaper = db.prepare('SELECT id, state FROM papers WHERE id = ?').get(sourceRow.paper_id)
        if (sourcePaper === undefined || sourcePaper.state !== 'active') {
          throw notFound(`figure ${sourceFigureId} belongs to an unavailable paper`, { id: sourceFigureId })
        }
        const digest = typeof sourceRow.dhash === 'string' && sourceRow.dhash.length === 16 ? sourceRow.dhash : undefined
        if (digest === undefined) {
          channels.push({
            name: 'visual_near_duplicate',
            status: 'degraded',
            note: 'the source figure has no dHash (image was not generated); similar-figure search is unavailable for it',
          })
        } else {
          let compared = 0
          for (const row of store.figureRowsWithHash()) {
            if (row.id === sourceRow.id) continue
            const paper = db.prepare('SELECT id, state FROM papers WHERE id = ?').get(row.paper_id)
            if (paper === undefined || paper.state !== 'active') continue
            compared += 1
            const distance = hammingDistance(digest, row.dhash)
            if (Number.isFinite(distance) && distance <= figureDistance) {
              addItem(row.id, { figureId: row.id, distance }, 'visual_near_duplicate', Math.max(0.05, 1 - distance / 64))
            }
          }
          channels.push({
            name: 'visual_near_duplicate',
            status: 'ok',
            note: `dHash of figure ${sourceFigureId} compared with ${compared} other figure(s); threshold ${figureDistance}/64 bits`,
          })
        }
      }

      if (wantedImage) {
        try {
          const digest = dhashFromPng(Buffer.from(String(params.imageBase64).replace(/^data:[^,]*,/, ''), 'base64'))
          let compared = 0
          for (const row of store.figureRowsWithHash()) {
            const paper = db.prepare('SELECT id, title, state FROM papers WHERE id = ?').get(row.paper_id)
            if (paper === undefined || paper.state !== 'active') continue
            compared += 1
            const distance = hammingDistance(digest, row.dhash)
            if (Number.isFinite(distance) && distance <= figureDistance) {
              addItem(row.id, { figureId: row.id, distance }, 'visual_near_duplicate', Math.max(0.05, 1 - distance / 64))
            }
          }
          channels.push({
            name: 'visual_near_duplicate',
            status: 'ok',
            note: `dHash comparison over ${compared} indexed figure(s); threshold ${figureDistance}/64 bits`,
          })
        } catch (error) {
          channels.push({
            name: 'visual_near_duplicate',
            status: 'degraded',
            note: `Screenshot decoding is limited to 8-bit non-interlaced PNG in this build: ${String(error?.message ?? error)}`,
          })
        }
      }
      channels.push({
        name: 'image_embedding',
        status: 'degraded',
        note: 'No vision embedding model is installed; semantic image similarity is not computed or claimed.',
      })

      // A numeric/caption-term hit on one figure is evidence about the whole paper:
      // its sibling figures (e.g. the Figure 3 next to the Figure 2 that matched)
      // deserve the same paper-level corroboration.
      for (const hit of items.values()) {
        const row = store.figureRow(hit.figureId)
        if (row === undefined) continue
        if (numericPaperHits.has(row.paper_id)) hit.score += 0.7
        else if (termPaperHits.has(row.paper_id)) hit.score += 0.15
      }
      const results = []
      for (const hit of items.values()) {
        const figureRow = store.figureRow(hit.figureId)
        if (figureRow === undefined) continue
        const paper = store.paperSummary(figureRow.paper_id)
        if (paper === undefined) continue
        results.push({
          figure: {
            id: figureRow.id,
            paperId: figureRow.paper_id,
            label: figureRow.label ?? null,
            caption: figureRow.caption ?? null,
            page: Number(figureRow.page),
            width: figureRow.width === null ? null : Number(figureRow.width),
            height: figureRow.height === null ? null : Number(figureRow.height),
            imageUrl: `/pappers-hall/figure/${figureRow.id}.png?v=${encodeURIComponent(figureRow.dhash || figureRow.id)}`,
            thumbnailUrl: `/pappers-hall/figure/${figureRow.id}.png?width=320&v=${encodeURIComponent(figureRow.dhash || figureRow.id)}`,
            dhash: figureRow.dhash ?? null,
            source: figureRow.source ?? 'caption',
          },
          paper,
          page: Number(figureRow.page),
          reasons: hit.reasons,
          score: Math.round(hit.score * 10_000) / 10_000,
          ...(hit.snippet === undefined ? {} : { snippet: hit.snippet }),
        })
      }
      results.sort((left, right) => right.score - left.score)
      // A paper can contribute at most three figures to one answer unless a figure
      // was explicitly requested by page/number (then keep every signal hit).
      const signalReasons = new Set(['figure_signal_exact', 'figure_label_match', 'figure_page_match'])
      const perPaper = new Map()
      const capped = []
      for (const result of results) {
        const paperId = result.figure.paperId
        const count = perPaper.get(paperId) ?? 0
        const isSignal = result.reasons.some((reason) => signalReasons.has(reason))
        if (count >= 3 && !isSignal) continue
        perPaper.set(paperId, count + 1)
        capped.push(result)
      }
      return {
        items: capped.slice(0, limit),
        channels,
        ...(sourceFigureId === undefined ? {} : { sourceFigureId }),
      }
    },
  }

  return service
}

/** Re-export the error types so api.js has one import site for domain failures. */
export { DomainError, invalid, notFound }
