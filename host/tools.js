/**
 * Agent tools for the Pappers-Hall Host half (contract §3).
 *
 * Tools are plain definition objects registered by `applyHost` through
 * `ctx.tools.register(...)`; the DSH tool registry accepts raw JSON Schema
 * parameters, so this module never imports a DSH package. Every tool returns a
 * JSON-safe value rendered as one text block; `papers_get_figure` additionally
 * returns a real ImageBlock produced by `ctx.attachments.saveImage`, which is the
 * only supported path for pixels to reach a vision-capable model.
 *
 * Reference-bundle scope is re-validated against the live database on every
 * call: a deleted/restored source or a bundle bound to another Session returns
 * `status:'unavailable'` instead of leaking content.
 *
 * @module pappers-hall/host/tools
 */
import { open, readFile, stat } from 'node:fs/promises'
import path from 'node:path'
import { normalizeTitleKey, parseBundleId } from './store.js'

/** Plain JSON-object output schema shared by every tool. */
const JSON_OUTPUT_SCHEMA = { type: 'object', additionalProperties: true }

/**
 * Render one JSON value as the single text content block used by most tools.
 * @param {object} value tool value.
 * @returns {Array<object>} content blocks.
 */
function renderJson(value) {
  return [{ type: 'text', text: JSON.stringify(value) }]
}

/** Read the current Agent Session id from a tool execution context, if any. */
function sessionIdOf(exec) {
  const session = exec?.agent?.session
  if (session === undefined || session === null) return undefined
  if (typeof session.sessionId === 'string' && session.sessionId !== '') return session.sessionId
  if (typeof session.id === 'string' && session.id !== '') return session.id
  if (typeof session.header?.id === 'string' && session.header.id !== '') return session.header.id
  return undefined
}

/** Return one unavailable payload instead of throwing for a stale source. */
function unavailable(reason, meta = {}) {
  return { status: 'unavailable', reason, ...meta }
}

/**
 * Build all `papers_*` tool definitions.
 *
 * @param {object} options tool dependencies.
 * @param {object} options.store domain store.
 * @param {object} options.search search service.
 * @param {object} options.api API facade (for cross-checking method wiring).
 * @param {object} [options.ctx] Cordis context (optional services resolved at call time).
 * @param {object} [options.layout] owned path table (figure files).
 * @param {object} [options.logger] logger.
 * @param {object} [options.config] plugin config.
 * @returns {object[]} tool definitions ready for `ctx.tools.register`.
 */
export function buildToolDefinitions({ store, search, ctx, layout, logger, config = {}, classify, ingest, pdf, embedding, notes }) {
  const attachments = () => (typeof ctx?.get === 'function' ? ctx.get('attachments') : undefined)
  /** Tool outputs must be lossless JSON (no undefined/NaN/Promises). */
  const jsonSafe = (value) => {
    try { return JSON.parse(JSON.stringify(value ?? null)) } catch (error) { return { status: 'error', reason: String(error?.message ?? error) } }
  }

  /* -------------------- v0.6 management helpers -------------------- */

  /** Best-effort workspace cwd for relative PDF paths. */
  function workspaceCwd(exec) {
    const candidates = [
      exec?.cwd,
      exec?.workspace?.cwd,
      exec?.agent?.workspace?.cwd,
      exec?.agent?.session?.cwd,
      exec?.agent?.session?.header?.cwd,
      config.workspaceCwd,
      process.env.DSH_WORKSPACE,
      process.cwd(),
    ]
    for (const candidate of candidates) if (typeof candidate === 'string' && candidate !== '') return candidate
    return process.cwd()
  }

  /** Resolve an absolute or workspace-relative path (no sandbox escape check here). */
  function resolveToolPath(input, exec) {
    const raw = String(input ?? '').trim()
    if (raw === '') return undefined
    if (path.isAbsolute(raw)) return path.normalize(raw)
    const home = raw.startsWith('~/') ? path.join(process.env.HOME ?? '', raw.slice(2)) : raw
    return path.resolve(workspaceCwd(exec), home)
  }

  /** Read the first bytes of a file. */
  async function headBytes(filePath, count = 5) {
    const handle = await open(filePath, 'r')
    try {
      const buffer = Buffer.alloc(count)
      const { bytesRead } = await handle.read(buffer, 0, count, 0)
      return buffer.subarray(0, bytesRead)
    } finally {
      await handle.close()
    }
  }

  /** Extract a DOI from preview text (first match only). */
  function extractDoi(text) {
    const match = /10\.\d{4,9}\/[-._;()/:A-Za-z0-9]+/.exec(String(text ?? ''))
    return match === null ? null : match[0].replace(/[.,;)]+$/, '')
  }

  /** PDF-file preview used by papers_import_file confirm:false (read-only). */
  async function previewPdfFile(filePath) {
    let info = null
    let firstPage = ''
    try {
      if (pdf !== undefined && pdf !== null && typeof pdf.info === 'function') info = await pdf.info(filePath)
    } catch {}
    try {
      if (pdf !== undefined && pdf !== null && typeof pdf.textPages === 'function') {
        const text = await pdf.textPages(filePath)
        firstPage = String(text.pages?.[0] ?? '')
      }
    } catch {}
    const doi = extractDoi(firstPage) ?? extractDoi(info?.subject)
    const rawInfoTitle = typeof info?.title === 'string' ? info.title.trim() : ''
    // v0.16: many publisher PDFs put a generic label ("Subject:", "Title:") in
    // the metadata title. Treat labels (with optional trailing colon) as empty
    // so the preview never tells the user the paper is called "Subject:".
    const genericTitle = /^(subject|title|document|untitled|paper|article|microsoft word|.*\.docx?)\s*[:：-]?\s*$/i.test(rawInfoTitle) || /^(subject|title|document|untitled)\s*[:：]/i.test(rawInfoTitle)
    const infoTitle = genericTitle ? '' : rawInfoTitle
    const firstLine = firstPage
      .split('\n')
      .map((line) => line.trim())
      .find((line) => line.length >= 8 && line.length <= 240 && !/^(abstract|keywords|doi|arxiv|©|published as|proceedings of|under review|preprint|conference paper)/i.test(line))
    const title = infoTitle !== '' ? infoTitle : firstLine ?? ''
    return {
      kind: title !== '' ? 'paper' : 'unknown',
      title: title !== '' ? title : null,
      doi,
      pageCount: info?.pageCount ?? null,
      bytes: null,
      firstPageSnippet: firstPage.replace(/\s+/g, ' ').trim().slice(0, 400),
    }
  }

  /** Compact folder tree for tool payloads (names/ids/counts only). */
  function compactFolders(items) {
    return (Array.isArray(items) ? items : []).map((node) => ({
      id: node.id,
      name: node.name,
      count: node.count,
      depth: node.depth,
      children: compactFolders(node.children ?? []),
    }))
  }

  /** Compact paper card for tools. */
  function paperCard(hit) {
    return {
      paperId: hit.paperId ?? hit.id,
      title: hit.title ?? null,
      titleZh: hit.titleZh ?? null,
      year: hit.year ?? null,
      venue: hit.venue ?? null,
      score: hit.score === undefined ? null : Number(hit.score.toFixed ? hit.score.toFixed(4) : hit.score),
    }
  }

  /** Read a paper's embedding text (metadata only) for on-the-fly embedding. */
  function paperEmbeddingText(paper) {
    let keywords = ''
    try {
      const parsed = typeof paper.keywords === 'string' ? JSON.parse(paper.keywords) : paper.keywords
      if (Array.isArray(parsed)) keywords = parsed.map(String).filter((item) => item !== '').join(', ')
    } catch {}
    return [paper.title, paper.titleZh, paper.abstract, keywords, paper.venue]
      .map((part) => (typeof part === 'string' ? part.replace(/\s+/g, ' ').trim() : ''))
      .filter((part) => part !== '')
      .join('. ')
      .slice(0, 2000)
  }

  /** Semantic related papers (paperId centroid or text query). */
  async function relatedPapers(args) {
    if (embedding === undefined || embedding === null || typeof embedding.searchVectors !== 'function') {
      return { status: 'unavailable', reason: 'embedding unavailable', items: [] }
    }
    const facts = typeof embedding.facts === 'function' ? embedding.facts() : null
    if (facts !== null && (facts.configured !== true || facts.available !== true || facts.indexReady !== true)) {
      return { status: 'unavailable', reason: facts?.lastError ?? 'embedding unavailable or index not built', items: [] }
    }
    const limit = Math.max(1, Math.min(20, Number.isInteger(args.limit) ? args.limit : 8))
    const paperId = typeof args.paperId === 'string' && args.paperId !== '' ? args.paperId : undefined
    let queryVector = null
    let model = facts?.model ?? null
    let latencyMs = 0
    if (paperId !== undefined) {
      const paper = store.paperSummary(paperId)
      if (paper === undefined) return { status: 'invalid', reason: `paper ${paperId} does not exist`, items: [] }
      const stored = store.db
        .prepare("SELECT vector FROM embeddings WHERE kind = 'paper' AND ref_id = ? AND model = ? ORDER BY id DESC LIMIT 1")
        .get(paperId, facts?.model ?? '')
      if (stored !== undefined) {
        const buffer = Buffer.from(stored.vector)
        queryVector = new Float32Array(buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength))
      } else {
        const text = paperEmbeddingText(paper)
        if (text === '') return { status: 'invalid', reason: 'paper has no embeddable text', items: [] }
        const embedded = await embedding.embedTexts([text])
        queryVector = new Float32Array(embedded.vectors[0])
        model = embedded.model ?? model
      }
    } else {
      const query = typeof args.query === 'string' ? args.query.trim() : ''
      if (query === '') return { status: 'invalid', reason: 'papers_related requires paperId or query', items: [] }
      const embedded = await embedding.searchVectors(query, { k: 200, kinds: ['paper'] })
      if (embedded.available !== true) return { status: 'unavailable', reason: embedded.reason ?? 'embedding search unavailable', items: [] }
      model = embedded.model ?? model
      latencyMs = embedded.latencyMs ?? 0
      const best = new Map()
      for (const chunk of embedded.items) {
        const candidate = chunk.paperId
        if (typeof candidate !== 'string') continue
        if (candidate === paperId) continue
        const current = best.get(candidate)
        if (current === undefined || chunk.score > current.score) best.set(candidate, chunk)
      }
      const rows = dbPaperCards([...best.keys()])
      const items = [...best.entries()]
        .sort((left, right) => right[1].score - left[1].score)
        .slice(0, limit)
        .map(([candidate, chunk]) => ({ ...rows.get(candidate), paperId: candidate, score: Number(chunk.score.toFixed(4)) }))
      return { status: 'ok', items: items.filter((item) => item.title !== undefined), model, latencyMs, k: items.length }
    }
    // paperId path: cosine against stored paper vectors.
    const rows = store.db
      .prepare(
        `SELECT e.ref_id AS paper_id, e.vector FROM embeddings e WHERE e.kind = 'paper' AND e.model = ? AND e.chunk_index = 0`,
      )
      .all(facts?.model ?? '')
    let dot = (left, right) => {
      let sum = 0
      const length = Math.min(left.length, right.length)
      for (let index = 0; index < length; index += 1) sum += left[index] * right[index]
      return sum
    }
    const candidates = []
    for (const row of rows) {
      if (row.paper_id === paperId) continue
      const buffer = Buffer.from(row.vector)
      const vector = new Float32Array(buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength))
      candidates.push({ paperId: row.paper_id, score: dot(queryVector, vector) })
    }
    candidates.sort((left, right) => right.score - left.score)
    const cards = dbPaperCards(candidates.slice(0, limit * 2).map((item) => item.paperId))
    const items = candidates
      .slice(0, limit)
      .map((item) => ({ ...cards.get(item.paperId), paperId: item.paperId, score: Number(item.score.toFixed(4)) }))
      .filter((item) => item.title !== undefined)
    return { status: 'ok', items, model, latencyMs, k: items.length }
  }

  /** Batch paper cards by id for tool results. */
  function dbPaperCards(paperIds) {
    const map = new Map()
    if (paperIds.length === 0) return map
    const rows = store.db
      .prepare(`SELECT id, title, title_zh, year, venue FROM papers WHERE id IN (${paperIds.map(() => '?').join(',')})`)
      .all(...paperIds)
    for (const row of rows) {
      map.set(row.id, { title: row.title_zh ?? row.title, titleOriginal: row.title_zh === null ? null : row.title, year: row.year === null ? null : Number(row.year), venue: row.venue ?? null })
    }
    return map
  }

  /**
   * Resolve a reference bundle and enforce the current Session binding.
   *
   * `bundleIdInput` may be either the raw id (`bn-...`) or the chat token the
   * Client inserts (`⟦Pappers-Hall 2 篇论文 · bundle=bn-...⟧`); the token is the
   * only bundle identity a model sees in the conversation.
   */
  function resolveBundleScope(bundleIdInput, exec) {
    const bundleId = parseBundleId(bundleIdInput)
    if (bundleId === undefined) {
      return {
        ok: false,
        payload: unavailable('scope=reference_bundle requires a bundle_id or a Pappers-Hall material token containing bundle=bn-...', {
          received: typeof bundleIdInput === 'string' ? bundleIdInput.slice(0, 120) : null,
        }),
      }
    }
    let resolved
    try {
      resolved = store.referencesResolve({ bundleId })
    } catch (error) {
      return { ok: false, payload: unavailable(`reference bundle is not resolvable: ${String(error?.message ?? error)}`, { bundleId }) }
    }
    const sessionId = sessionIdOf(exec)
    if (sessionId !== undefined && resolved.bundle.sessionId !== null && resolved.bundle.sessionId !== sessionId) {
      return { ok: false, payload: unavailable('reference bundle belongs to a different conversation', { bundleId }) }
    }
    if (resolved.valid.length === 0) {
      return {
        ok: false,
        payload: unavailable('every material in this reference bundle is no longer available (deleted or restored); nothing was read', {
          bundleId,
          invalid: resolved.invalid.length,
        }),
      }
    }
    const paperIds = new Set()
    const itemKeys = new Set()
    const kinds = new Set()
    for (const material of resolved.valid) {
      kinds.add(material.kind)
      if (material.kind === 'paper') {
        paperIds.add(material.id)
        itemKeys.add(`paper:${material.id}`)
      } else {
        itemKeys.add(`${material.kind}:${material.id}`)
        if (typeof material.paperId === 'string') paperIds.add(material.paperId)
      }
    }
    return { ok: true, bundleId, resolved, paperIds, itemKeys, kinds, invalidCount: resolved.invalid.length }
  }

  /** Filter raw search hits down to the materials one bundle grants. */
  function filterHitsToBundle(items, scope) {
    return items.filter((hit) => {
      if (scope.itemKeys.has(`${hit.kind}:${hit.id}`)) return true
      return hit.kind === 'paper' && scope.paperIds.has(hit.paperId)
    })
  }

  /** Read one figure file for the image path, or undefined. */
  async function figureFile(figureRow) {
    if (figureRow === null || figureRow === undefined) return undefined
    if (typeof figureRow.file_name !== 'string' || figureRow.file_name === '') return undefined
    try {
      return path.join(layout.figuresDir, figureRow.file_name)
    } catch {
      return undefined
    }
  }

  return [
    {
      name: 'papers_search',
      description:
        'Search the Pappers-Hall paper library (titles, full text, figure captions, annotations and notes). ' +
        'Use scope="reference_bundle" with a bundle_id to restrict results to the materials the user explicitly placed in this conversation; ' +
        'use scope="library" only when the user asks to search the whole library.',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Search text; Chinese and English are both supported.' },
          scope: { type: 'string', enum: ['reference_bundle', 'library'], description: 'Result scope.' },
          bundle_id: { type: 'string', description: 'Reference bundle id; required when scope=reference_bundle.' },
          kinds: { type: 'array', items: { type: 'string', enum: ['paper', 'figure', 'annotation', 'note'] }, description: 'Optional kind filter.' },
          limit: { type: 'integer', description: 'Maximum number of results (default 10).' },
          ai: { type: 'boolean', description: 'Set false to disable AI query expansion/re-ranking for this call.' },
        },
        required: ['query'],
        additionalProperties: false,
      },
      output: { schema: JSON_OUTPUT_SCHEMA, render: (_args, value) => renderJson(value) },
      async execute(args, exec) {
        const scope = args.scope === 'reference_bundle' ? 'reference_bundle' : 'library'
        const limit = Math.max(1, Math.min(50, Number.isInteger(args.limit) ? args.limit : 10))
        let bundleScope
        if (scope === 'reference_bundle') {
          const resolved = resolveBundleScope(args.bundle_id, exec)
          if (!resolved.ok) return { items: [], channels: [], scope, ...resolved.payload }
          bundleScope = resolved
        }
        const result = await search.query({
          q: args.query ?? '',
          scope: 'library',
          limit: Math.min(200, limit * 4),
          ai: args.ai === false ? 'off' : 'auto',
          sessionId: sessionIdOf(exec),
        })
        let items = result.items
        if (bundleScope !== undefined) {
          items = filterHitsToBundle(items, bundleScope)
          if (Array.isArray(args.kinds) && args.kinds.length > 0) {
            const wanted = new Set(args.kinds.filter((kind) => bundleScope.kinds.has(kind)))
            items = items.filter((hit) => wanted.has(hit.kind))
          }
        } else if (Array.isArray(args.kinds) && args.kinds.length > 0) {
          items = items.filter((hit) => args.kinds.includes(hit.kind))
        }
        return {
          items: items.slice(0, limit),
          channels: result.channels,
          scope,
          ...(bundleScope === undefined
            ? {}
            : {
                bundle: {
                  id: bundleScope.bundleId,
                  display: bundleScope.resolved.bundle.display,
                  validMaterials: bundleScope.resolved.valid.length,
                  invalidMaterials: bundleScope.invalidCount,
                },
              }),
        }
      },
    },

    {
      name: 'papers_get_passage',
      description:
        'Read the exact text of a page (or the page containing a quote) from one paper in the Pappers-Hall library. ' +
        'The result states whether the passage is full text, abstract only, or metadata only.',
      parameters: {
        type: 'object',
        properties: {
          paper_id: { type: 'string', description: 'Paper id (ph-...).' },
          page: { type: 'integer', description: '1-based physical PDF page.' },
          quote: { type: 'string', description: 'Text fragment to locate; used when page is omitted.' },
          bundle_id: { type: 'string', description: 'Reference bundle id when the source came from a conversation bundle.' },
        },
        required: ['paper_id'],
        additionalProperties: false,
      },
      output: { schema: JSON_OUTPUT_SCHEMA, render: (_args, value) => renderJson(value) },
      async execute(args, exec) {
        const paperId = String(args.paper_id)
        const paper = store.paperSummary(paperId)
        if (paper === undefined || paper.state !== 'active') return unavailable(`paper ${paperId} is not available`)
        if (typeof args.bundle_id === 'string' && args.bundle_id !== '') {
          const scope = resolveBundleScope(args.bundle_id, exec)
          if (!scope.ok) return scope.payload
          if (!scope.paperIds.has(paperId) && !scope.itemKeys.has(`paper:${paperId}`)) {
            return unavailable('paper is not part of the reference bundle', { bundleId: args.bundle_id })
          }
        }
        const version = store.latestVersion(paperId)
        const pageTexts = store.pageTexts(paperId)
        let targetPage = Number.isInteger(args.page) ? args.page : undefined
        let passageText = ''
        if (pageTexts.length === 0) {
          const detail = store.libraryGet({ id: paperId })
          const abstract = typeof detail.abstract === 'string' ? detail.abstract : ''
          return {
            paper: { id: paper.id, title: paper.title, titleZh: paper.titleZh },
            page: null,
            text: abstract,
            depth: abstract === '' ? 'metadata_only' : 'abstract',
            location: { page: null },
            source_sha256: version?.sha256 ?? paper.sha256 ?? null,
          }
        }
        if (targetPage === undefined && typeof args.quote === 'string' && args.quote.trim() !== '') {
          const needle = args.quote.trim().toLowerCase()
          const match = pageTexts.find((row) => String(row.text ?? '').toLowerCase().includes(needle))
          if (match !== undefined) {
            targetPage = Number(match.page)
            const text = String(match.text)
            const index = text.toLowerCase().indexOf(needle)
            const start = Math.max(0, index - 600)
            const end = Math.min(text.length, index + needle.length + 600)
            passageText = text.slice(start, end)
          }
        }
        if (targetPage === undefined) targetPage = Number(pageTexts[0].page)
        if (passageText === '') {
          const row = pageTexts.find((candidate) => Number(candidate.page) === targetPage)
          passageText = typeof row?.text === 'string' ? row.text : ''
        }
        // v0.17: never hand a garbled text layer to the model as paper prose.
        // Use the quality-gated page text (OCR fallback when available).
        let textSource = 'pdf'
        let lowQuality = false
        let qualityReasons = []
        try {
          const readable = await store.pageTextForAi(paperId, targetPage)
          if (readable !== null) {
            textSource = readable.source
            lowQuality = readable.lowQuality === true
            qualityReasons = readable.quality?.reasons ?? []
            const quoteText = typeof args.quote === 'string' ? args.quote.trim().toLowerCase() : ''
            if (quoteText === '' || readable.text.toLowerCase().includes(quoteText)) passageText = readable.text
            else if (lowQuality !== true) passageText = readable.text
          }
        } catch (error) { /* keep the stored text and flag nothing */ }
        return {
          paper: { id: paper.id, title: paper.title, titleZh: paper.titleZh },
          page: targetPage,
          text: passageText,
          depth: 'fulltext',
          textSource,
          lowQuality,
          ...(qualityReasons.length === 0 ? {} : { qualityReasons }),
          location: { page: targetPage },
          source_sha256: version?.sha256 ?? paper.sha256 ?? null,
        }
      },
    },

    {
      name: 'papers_get_figure',
      description:
        'Return one figure of a paper together with its real image, so the current model can look at the figure itself. ' +
        'Identify the figure by figure_id, or by paper_id plus page. The JSON description includes label, caption and page.',
      parameters: {
        type: 'object',
        properties: {
          figure_id: { type: 'string', description: 'Figure id (fg-...).' },
          paper_id: { type: 'string', description: 'Paper id (ph-...) when locating by page.' },
          page: { type: 'integer', description: '1-based page used with paper_id.' },
          bundle_id: { type: 'string', description: 'Reference bundle id when the source came from a conversation bundle.' },
        },
        additionalProperties: false,
      },
      output: {
        schema: JSON_OUTPUT_SCHEMA,
        render: (_args, value) => {
          const { imageAttachmentRef, ...meta } = value
          const blocks = [{ type: 'text', text: JSON.stringify(meta) }]
          if (imageAttachmentRef !== undefined && imageAttachmentRef !== null) blocks.push({ type: 'image', attachment: imageAttachmentRef })
          return blocks
        },
      },
      async execute(args, exec) {
        let figureRow
        if (typeof args.figure_id === 'string' && args.figure_id !== '') {
          figureRow = store.figureRow(args.figure_id)
          if (figureRow === undefined) return unavailable(`figure ${args.figure_id} does not exist`)
        } else if (typeof args.paper_id === 'string' && args.paper_id !== '') {
          const figures = store.figuresList({ paperId: args.paper_id })
          const page = Number.isInteger(args.page) ? args.page : undefined
          const match = page === undefined ? figures[0] : figures.find((figure) => figure.page === page)
          if (match === undefined) return unavailable('no figure found for that paper/page', { paperId: args.paper_id, page: page ?? null })
          figureRow = store.figureRow(match.id)
        } else {
          return unavailable('papers_get_figure requires figure_id or paper_id')
        }
        const paper = store.paperSummary(figureRow.paper_id)
        if (paper === undefined || paper.state !== 'active') return unavailable('figure belongs to an unavailable paper')
        if (typeof args.bundle_id === 'string' && args.bundle_id !== '') {
          const scope = resolveBundleScope(args.bundle_id, exec)
          if (!scope.ok) return scope.payload
          if (!scope.itemKeys.has(`figure:${figureRow.id}`) && !scope.paperIds.has(figureRow.paper_id)) {
            return unavailable('figure is not part of the reference bundle', { bundleId: args.bundle_id })
          }
        }
        const filePath = await figureFile(figureRow)
        const value = {
          figure: {
            id: figureRow.id,
            paperId: figureRow.paper_id,
            label: figureRow.label,
            caption: figureRow.caption,
            page: Number(figureRow.page),
            width: figureRow.width === null ? null : Number(figureRow.width),
            height: figureRow.height === null ? null : Number(figureRow.height),
            dhash: figureRow.dhash ?? null,
            imageUrl: `/pappers-hall/figure/${figureRow.id}.png`,
          },
          paper: { id: paper.id, title: paper.title, titleZh: paper.titleZh },
          page: Number(figureRow.page),
          caption: figureRow.caption ?? null,
          image: { status: 'unavailable' },
        }
        if (filePath !== undefined) {
          const store_ = attachments()
          if (store_ === undefined || typeof store_.saveImage !== 'function') {
            value.image = { status: 'degraded', reason: 'attachment service is unavailable; no ImageBlock can be produced' }
          } else {
            try {
              const bytes = await readFile(filePath)
              const reference = await store_.saveImage({ data: bytes, mediaType: 'image/png', name: `${figureRow.id}.png` })
              value.imageAttachmentRef = reference
              value.image = {
                status: 'ready',
                mediaType: reference.mediaType ?? 'image/png',
                width: reference.width ?? figureRow.width ?? null,
                height: reference.height ?? figureRow.height ?? null,
                bytes: reference.bytes ?? bytes.byteLength,
                attachmentId: String(reference.attachmentId ?? ''),
              }
            } catch (error) {
              logger?.warn?.(`pappers-hall: figure image save failed: ${String(error?.message ?? error)}`)
              value.image = { status: 'degraded', reason: `attachment save failed: ${String(error?.message ?? error)}` }
            }
          }
        } else {
          value.image = { status: 'unavailable', reason: 'figure image was not generated (see status)' }
        }
        return value
      },
    },

    {
      name: 'papers_get_annotations',
      description:
        'List the annotations (highlights, area marks, notes) of one paper with page, normalized rects, quote and comment. ' +
        'Pass bundle_id to restrict the answer to the materials the user placed in this conversation.',
      parameters: {
        type: 'object',
        properties: {
          paper_id: { type: 'string', description: 'Paper id (ph-...).' },
          bundle_id: { type: 'string', description: 'Reference bundle id or material token when the source came from a conversation bundle.' },
          state: { type: 'string', enum: ['active', 'trash', 'all'], description: 'Annotation state filter (default active).' },
        },
        required: ['paper_id'],
        additionalProperties: false,
      },
      output: { schema: JSON_OUTPUT_SCHEMA, render: (_args, value) => renderJson(value) },
      async execute(args, exec) {
        const paperId = String(args.paper_id)
        const paper = store.paperSummary(paperId)
        if (paper === undefined || paper.state !== 'active') return unavailable(`paper ${paperId} is not available`)
        if (typeof args.bundle_id === 'string' && args.bundle_id !== '') {
          const scope = resolveBundleScope(args.bundle_id, exec)
          if (!scope.ok) return scope.payload
          if (!scope.paperIds.has(paperId)) return unavailable('paper is not part of the reference bundle', { bundleId: args.bundle_id })
        }
        const annotations = store.annotationsList({ paperId, state: args.state === 'all' ? 'all' : args.state === 'trash' ? 'trash' : 'active' })
        return {
          paper: { id: paper.id, title: paper.title, titleZh: paper.titleZh },
          annotations: annotations.map((annotation) => ({
            id: annotation.id,
            page: annotation.page,
            kind: annotation.kind,
            rects: annotation.rects,
            quote: annotation.quote,
            comment: annotation.comment,
            color: annotation.color,
            origin: annotation.origin,
            createdAt: annotation.createdAt,
          })),
        }
      },
    },

    {
      name: 'papers_annotate',
      description:
        'Create an annotation on a paper page as the Agent: a highlight (text quote + rects), an area mark (rects) or a page note. ' +
        'Coordinates are page-relative 0-1 rectangles. The annotation is stored with origin="ai_explanation" and is visible in the reader and the annotations list.',
      parameters: {
        type: 'object',
        properties: {
          paper_id: { type: 'string', description: 'Paper id (ph-...).' },
          page: { type: 'integer', description: '1-based physical PDF page.' },
          kind: { type: 'string', enum: ['highlight', 'area', 'note'], description: 'Annotation kind.' },
          rects: {
            type: 'array',
            description: 'Page-relative 0-1 rectangles {x,y,w,h}.',
            items: { type: 'object', additionalProperties: true },
          },
          quote: { type: 'string', description: 'Exact quoted text for a highlight.' },
          comment: { type: 'string', description: 'Annotation text shown in the reader.' },
          color: { type: 'string', enum: ['yellow', 'green', 'blue', 'red', 'purple'], description: 'Highlight color.' },
        },
        required: ['paper_id', 'page'],
        additionalProperties: false,
      },
      output: { schema: JSON_OUTPUT_SCHEMA, render: (_args, value) => renderJson(value) },
      async execute(args) {
        const paperId = String(args.paper_id)
        const paper = store.paperSummary(paperId)
        if (paper === undefined || paper.state !== 'active') return unavailable(`paper ${paperId} is not available`)
        const kind = ['highlight', 'area', 'note'].includes(args.kind) ? args.kind : Array.isArray(args.rects) && args.rects.length > 0 ? 'highlight' : 'note'
        const comment = typeof args.comment === 'string' && args.comment.trim() !== '' ? args.comment.trim() : typeof args.quote === 'string' ? `Highlight: ${args.quote.trim().slice(0, 200)}` : ''
        if (comment === '') return unavailable('papers_annotate requires comment or quote text')
        try {
          const created = store.annotationsCreate({
            paperId,
            page: Number(args.page),
            kind,
            rects: Array.isArray(args.rects) ? args.rects : [],
            quote: typeof args.quote === 'string' ? args.quote : null,
            comment,
            color: args.color,
            origin: 'ai_explanation',
          })
          return { annotation: created.annotation, paper: { id: paper.id, title: paper.title, titleZh: paper.titleZh } }
        } catch (error) {
          return unavailable(`annotation was not created: ${String(error?.message ?? error)}`)
        }
      },
    },

    {
      name: 'papers_translate',
      description:
        'Translate a paper title or a passage into Chinese through the Host translator service. ' +
        'When no translator is composed the result is status="unavailable"; no translation is ever invented.',
      parameters: {
        type: 'object',
        properties: {
          paper_id: { type: 'string', description: 'Paper id; translates the title when text is omitted.' },
          text: { type: 'string', description: 'Exact text to translate.' },
          page: { type: 'integer', description: 'Translate the extracted text of this page.' },
          target: { type: 'string', description: 'Target language (only "zh" is supported by this build).' },
        },
        additionalProperties: false,
      },
      output: { schema: JSON_OUTPUT_SCHEMA, render: (_args, value) => renderJson(value) },
      async execute(args, exec) {
        const target = typeof args.target === 'string' && args.target !== '' ? args.target : 'zh'
        const sessionId = sessionIdOf(exec)
        if (typeof args.text === 'string' && args.text.trim() !== '') {
          const result = await store.translateText({ text: args.text, target, sessionId })
          return { translation: result.translation, status: result.status, provenance: result.provenance, target }
        }
        if (typeof args.paper_id === 'string' && args.paper_id !== '') {
          if (Number.isInteger(args.page)) {
            const result = await store.translateText({ paperId: args.paper_id, page: args.page, target, sessionId })
            return { translation: result.translation, status: result.status, provenance: result.provenance, target, paper_id: args.paper_id, page: args.page }
          }
          const titles = await store.translateTitle({ ids: [args.paper_id], target, sessionId })
          const entry = titles.results[0] ?? { status: 'unavailable' }
          return { translation: entry.titleZh ?? null, status: entry.status, provenance: { field: 'title' }, target, paper_id: args.paper_id }
        }
        return unavailable('papers_translate requires text or paper_id')
      },
    },

    {
      name: 'papers_propose_changes',
      description:
        'Register a proposed batch of library changes for user review without applying them. ' +
        'Returns a proposal_id that papers_apply_changes can apply later, plus per-operation conflicts.',
      parameters: {
        type: 'object',
        properties: {
          operations: {
            type: 'array',
            description: 'Operations to propose; each has an "op" plus its own fields.',
            items: { type: 'object', additionalProperties: true },
          },
        },
        required: ['operations'],
        additionalProperties: false,
      },
      output: { schema: JSON_OUTPUT_SCHEMA, render: (_args, value) => renderJson(value) },
      async execute(args) {
        const operations = Array.isArray(args.operations) ? args.operations : []
        if (operations.length === 0) return unavailable('papers_propose_changes requires at least one operation')
        const checked = []
        for (const [index, operation] of operations.entries()) {
          const result = validateOperation(store, operation)
          checked.push({ index, op: operation?.op ?? null, ...result })
        }
        const proposalId = `pp-${Math.random().toString(16).slice(2, 10)}`
        const preview = checked.map((entry) => entry.preview ?? entry.summary ?? entry.issue ?? entry.op)
        store.writeSetting(`proposal:${proposalId}`, {
          proposalId,
          operations: operations.filter((_, index) => checked[index].ok),
          checked,
          createdAt: new Date().toISOString(),
          applied: false,
        })
        return { proposal_id: proposalId, operations: checked, preview }
      },
    },

    {
      name: 'papers_apply_changes',
      description:
        'Apply a previously proposed change batch idempotently. Returns per-operation results and an undo token. ' +
        'A retried call with the same operation_id returns the original result.',
      parameters: {
        type: 'object',
        properties: {
          proposal_id: { type: 'string', description: 'Proposal id from papers_propose_changes.' },
          operation_id: { type: 'string', description: 'Client idempotency key for this apply request.' },
        },
        required: ['proposal_id'],
        additionalProperties: false,
      },
      output: { schema: JSON_OUTPUT_SCHEMA, render: (_args, value) => renderJson(value) },
      async execute(args) {
        const proposalId = String(args.proposal_id ?? '')
        const operationId = typeof args.operation_id === 'string' && args.operation_id !== '' ? args.operation_id : `apply:${proposalId}`
        const appliedKey = `proposal:${proposalId}:applied`
        const previous = store.readSetting(appliedKey)
        if (previous !== undefined) return { ...previous, idempotent: true }
        const proposal = store.readSetting(`proposal:${proposalId}`)
        if (proposal === undefined) return unavailable(`proposal ${proposalId} does not exist`)
        if (proposal.applied === true) return applyProposal(store, proposal, operationId)
        const result = await applyProposal(store, proposal, operationId)
        store.writeSetting(appliedKey, result)
        return result
      },
    },

    {
      name: 'papers_cite',
      description: 'Format citations for one or more papers in the library in APA, BibTeX or GB/T 7714 style.',
      parameters: {
        type: 'object',
        properties: {
          paper_ids: { type: 'array', items: { type: 'string' }, description: 'Paper ids to cite.' },
          style: { type: 'string', enum: ['apa', 'bibtex', 'gbt7714'], description: 'Citation style.' },
        },
        required: ['paper_ids', 'style'],
        additionalProperties: false,
      },
      output: { schema: JSON_OUTPUT_SCHEMA, render: (_args, value) => renderJson(value) },
      async execute(args) {
        const ids = Array.isArray(args.paper_ids) ? args.paper_ids.filter((id) => typeof id === 'string') : []
        const style = args.style === 'bibtex' || args.style === 'gbt7714' ? args.style : 'apa'
        const citations = []
        const warnings = []
        for (const id of ids) {
          const paper = store.paperSummary(id)
          if (paper === undefined) {
            warnings.push(`${id}: paper not found`)
            continue
          }
          if (paper.state !== 'active') {
            warnings.push(`${id}: paper is in the recycle bin and was not cited`)
            continue
          }
          const detail = store.libraryGet({ id })
          const authors = Array.isArray(detail.authors) ? detail.authors : []
          const year = detail.year ?? 'n.d.'
          const venue = detail.containerTitle ?? detail.venue ?? ''
          if (!Array.isArray(detail.authors) || detail.authors.length === 0) warnings.push(`${id}: no author metadata`)
          if (venue === '') warnings.push(`${id}: no venue metadata`)
          let text
          if (style === 'bibtex') {
            const exported = store.exportBibtex({ ids: [id] }).content.trim()
            text = exported
          } else if (style === 'gbt7714') {
            const names = authors.map((author) => author.literal ?? [author.family, author.given].filter(Boolean).join(' ')).join(', ')
            text = `${names}. ${detail.title}[J]. ${venue}, ${year}.${detail.pages === null || detail.pages === undefined ? '' : ` ${detail.pages}.`}`
          } else {
            const names =
              authors.length === 0
                ? ''
                : authors
                    .map((author) => {
                      if (author.literal !== undefined) return author.literal
                      const family = author.family ?? ''
                      const initials = (author.given ?? '')
                        .split(/\s+/)
                        .filter(Boolean)
                        .map((part) => `${part[0]}.`)
                        .join(' ')
                      return [family, initials].filter(Boolean).join(', ')
                    })
                    .join(', ')
            text = `${names === '' ? '' : `${names} `}(${year}). ${detail.title}. ${venue}.${detail.doi === null || detail.doi === undefined ? '' : ` https://doi.org/${detail.doi}`}`
          }
          citations.push({ paper_id: id, text })
        }
        return { citations, warnings }
      },
    },

    {
      name: 'papers_index_status',
      description:
        'Report the Pappers-Hall library counts, search index channel states, background job states and known capability limitations.',
      parameters: { type: 'object', properties: {}, additionalProperties: false },
      output: { schema: JSON_OUTPUT_SCHEMA, render: (_args, value) => renderJson(value) },
      async execute() {
        const status = store.status()
        return { counts: status.counts, index: status.index, jobs: status.jobs, degraded: status.degraded, processing: status.processing }
      },
    },

    {
      name: 'papers_overview',
      description:
        'Get a compact overview of the Pappers-Hall library before answering a literature task: counts, folder tree, tags, recent papers/annotations and the semantic-index state. ' +
        'Use this first when the user asks what is in the library or asks you to manage/organize papers.',
      parameters: { type: 'object', properties: {}, additionalProperties: false },
      output: { schema: JSON_OUTPUT_SCHEMA, render: (_args, value) => renderJson(value) },
      async execute() {
        const feed = store.discoverFeed({ limit: 5 })
        const embeddingStatus = typeof store.embeddingStatus === 'function' ? store.embeddingStatus() : null
        return {
          status: 'ok',
          stats: feed.stats,
          folders: compactFolders(feed.folders ?? []),
          tags: (feed.tags ?? []).slice(0, 20),
          recentPapers: (feed.unread ?? []).slice(0, 5).map((tile) => ({ paperId: tile.id, title: tile.titleZh ?? tile.title, year: tile.year, venue: tile.venue, favorite: tile.favorite === true })),
          recentAnnotations: (feed.recentAnnotations ?? []).slice(0, 5).map((item) => ({ paperId: item.paperId, paperTitle: item.paperTitle, page: item.page, kind: item.kind, quote: item.quote })),
          embedding: embeddingStatus === null ? null : { available: embeddingStatus.available, indexReady: embeddingStatus.indexReady, model: embeddingStatus.model, counts: embeddingStatus.counts },
        }
      },
    },

    {
      name: 'papers_folders',
      description:
        'Manage the Pappers-Hall folder tree (Zotero-style folders, no separate field layer): tree/create/rename/delete/assign/unassign. ' +
        'Use when the user asks to organize papers, create or rename a folder, move papers into a folder, or inspect the folder tree. ' +
        'Every mutation is undoable; deleting a folder never deletes papers (children move up).',
      parameters: {
        type: 'object',
        properties: {
          action: { type: 'string', enum: ['tree', 'create', 'rename', 'delete', 'assign', 'unassign'], description: 'Operation to perform.' },
          id: { type: 'string', description: 'Folder id (rename/delete).' },
          folderId: { type: 'string', description: 'Target folder id (assign/unassign).' },
          name: { type: 'string', description: 'Folder name (create/rename).' },
          parentId: { type: 'string', description: 'Parent folder id for create (omit for a root folder).' },
          paperIds: { type: 'array', items: { type: 'string' }, description: 'Paper ids for assign/unassign.' },
        },
        required: ['action'],
        additionalProperties: false,
      },
      output: { schema: JSON_OUTPUT_SCHEMA, render: (_args, value) => renderJson(value) },
      async execute(args) {
        const action = String(args.action ?? '')
        const tree = () => store.libraryFoldersTree()
        try {
          if (action === 'tree') return { status: 'ok', action, tree: compactFolders(tree().items), total: tree().total }
          if (action === 'create') {
            if (typeof args.name !== 'string' || args.name.trim() === '') return { status: 'invalid', reason: 'name is required', action }
            const created = store.libraryCollectionsCreate({
              name: args.name.trim(),
              ...(typeof args.parentId === 'string' && args.parentId !== '' ? { parentId: args.parentId } : {}),
            })
            return { status: 'ok', action, result: created, tree: compactFolders(tree().items) }
          }
          if (action === 'rename') {
            if (typeof args.id !== 'string' || args.id === '') return { status: 'invalid', reason: 'id is required', action }
            if (typeof args.name !== 'string' || args.name.trim() === '') return { status: 'invalid', reason: 'name is required', action }
            const updated = store.libraryCollectionsUpdate({ id: args.id, name: args.name.trim() })
            return { status: 'ok', action, result: updated, tree: compactFolders(tree().items) }
          }
          if (action === 'delete') {
            if (typeof args.id !== 'string' || args.id === '') return { status: 'invalid', reason: 'id is required', action }
            const deleted = store.libraryCollectionsDelete({ id: args.id })
            return { status: 'ok', action, result: deleted, tree: compactFolders(tree().items) }
          }
          if (action === 'assign' || action === 'unassign') {
            const folderId = typeof args.folderId === 'string' && args.folderId !== '' ? args.folderId : typeof args.id === 'string' ? args.id : ''
            if (folderId === '') return { status: 'invalid', reason: 'folderId is required', action }
            if (!Array.isArray(args.paperIds) || args.paperIds.length === 0) return { status: 'invalid', reason: 'paperIds is required', action }
            const result = store.libraryCollectionsAssign({ collectionId: folderId, paperIds: args.paperIds.map(String), add: action === 'assign' })
            return { status: 'ok', action, result, tree: compactFolders(tree().items) }
          }
          return { status: 'invalid', reason: `unsupported action ${action}` }
        } catch (error) {
          return { status: 'invalid', action, reason: String(error?.message ?? error), code: error?.code ?? 'error' }
        }
      },
    },

    {
      name: 'papers_list',
      description:
        'List papers with the metadata and abstract a human would read before organizing a library: id, title/titleZh, authors, year, venue, tags, folders, read/favorite, figure/annotation counts and a truncated abstract. ' +
        'Use this as the reading step for classification/organization instead of trusting an automatic classifier. Supports folderId/query/limit/offset; use papers_get for one paper in full.',
      parameters: {
        type: 'object',
        properties: {
          folderId: { type: 'string', description: 'Only papers in this folder (and descendants).' },
          query: { type: 'string', description: 'Optional title/author/venue substring filter.' },
          limit: { type: 'integer', description: 'Page size 1–50 (default 20).' },
          offset: { type: 'integer', description: 'Pagination offset (default 0).' },
        },
        additionalProperties: false,
      },
      output: { schema: JSON_OUTPUT_SCHEMA, render: (_args, value) => renderJson(value) },
      execute(args) {
        const limit = Math.max(1, Math.min(50, Number.isInteger(args.limit) ? args.limit : 20))
        const offset = Math.max(0, Number.isInteger(args.offset) ? args.offset : 0)
        const result = store.libraryList({
          limit,
          offset,
          ...(typeof args.folderId === 'string' && args.folderId !== '' ? { folderId: args.folderId } : {}),
          ...(typeof args.query === 'string' && args.query.trim() !== '' ? { query: args.query.trim() } : {}),
        })
        const items = (result.items || []).map((paper) => {
          let detail = null
          try { detail = store.libraryGet({ id: paper.id }) } catch (error) { detail = null }
          return {
            paperId: paper.id,
            title: paper.title,
            titleZh: paper.titleZh,
            authors: Array.isArray(paper.authors) ? paper.authors.slice(0, 8).map((author) => [author.given, author.family].filter(Boolean).join(' ')) : [],
            year: paper.year,
            venue: paper.venue,
            tags: paper.tags || [],
            folders: (detail && Array.isArray(detail.collections) ? detail.collections : []).map((collection) => collection.name),
            read: paper.read === true,
            favorite: paper.favorite === true,
            figureCount: paper.figureCount ?? 0,
            annotationCount: paper.annotationCount ?? 0,
            abstract: (() => {
              const readable = store.readableAbstract(paper.id)
              return readable && typeof readable.text === 'string' ? readable.text.replace(/\s+/g, ' ').trim().slice(0, 900) : null
            })(),
            abstractSource: (() => { const readable = store.readableAbstract(paper.id); return readable ? readable.source : null })(),
          }
        })
        return { status: 'ok', total: result.total, offset, limit, items }
      },
    },

    {
      name: 'papers_get',
      description:
        'Read one paper in full detail: title, authors, year/venue/DOI, abstract, keywords, tags, folder memberships, notes count, figure list and annotation count. ' +
        'Use with papers_get_passage when you need actual page text. This is the basic read primitive for human-like classification and analysis; it never edits anything.',
      parameters: {
        type: 'object',
        properties: { paperId: { type: 'string', description: 'Paper id (ph-...).' } },
        required: ['paperId'],
        additionalProperties: false,
      },
      output: { schema: JSON_OUTPUT_SCHEMA, render: (_args, value) => renderJson(value) },
      execute(args) {
        const paperId = typeof args.paperId === 'string' ? args.paperId : ''
        if (paperId === '') return { status: 'invalid', reason: 'paperId is required' }
        let detail
        try { detail = store.libraryGet({ id: paperId }) } catch (error) { return { status: 'not_found', reason: String(error?.message ?? error), paperId } }
        let figures = []
        try { figures = store.figuresList({ paperId }) } catch (error) { figures = [] }
        return {
          status: 'ok',
          paper: {
            paperId: detail.id,
            title: detail.title,
            titleZh: detail.titleZh,
            authors: detail.authors,
            year: detail.year,
            venue: detail.venue,
            doi: detail.doi,
            abstract: (() => {
              const readable = store.readableAbstract(detail.id)
              return readable && typeof readable.text === 'string' ? readable.text : detail.abstract
            })(),
            abstractSource: (() => { const readable = store.readableAbstract(detail.id); return readable ? readable.source : (detail.abstractSource ?? null) })(),
            keywords: detail.keywords,
            tags: detail.tags,
            folders: (detail.collections || []).map((collection) => ({ id: collection.id, name: collection.name, kind: collection.kind })),
            read: detail.read,
            favorite: detail.favorite,
            pageCount: detail.pageCount,
            figureCount: detail.figureCount,
            annotationCount: detail.annotationCount,
            noteCount: (detail.notes || []).length,
            figures: (figures || []).map((figure) => ({ figureId: figure.id, label: figure.label, page: figure.page, caption: figure.caption })),
          },
        }
      },
    },

    {
      name: 'notes_list',
      description:
        'List personal notes with title, folder, linked papers, updated time and a short preview. Use it to find notes, or notes.search for full-text search. Notes are the user\'s own content; treat them as read-only unless the user asks to edit.',
      parameters: {
        type: 'object',
        properties: {
          folderId: { type: 'string', description: 'Only notes in this note folder (and descendants).' },
          paperId: { type: 'string', description: 'Only notes linked to this paper.' },
          query: { type: 'string', description: 'Optional title substring filter.' },
          limit: { type: 'integer', description: 'Page size 1–50 (default 20).' },
          offset: { type: 'integer', description: 'Pagination offset (default 0).' },
        },
        additionalProperties: false,
      },
      output: { schema: JSON_OUTPUT_SCHEMA, render: (_args, value) => renderJson(value) },
      async execute(args) {
        if (notes === undefined || notes === null) return { status: 'unavailable', reason: 'notes service is not initialized' }
        return jsonSafe(await notes.list(args ?? {}))
      },
    },

    {
      name: 'notes_get',
      description:
        'Read one note: title, content_md (the user\'s original text), content_json (AI-formatted layout), note folder, linked papers, and revision. Never overwrite content_md when only beautifying.',
      parameters: {
        type: 'object',
        properties: { noteId: { type: 'string', description: 'Note id (note-...).' } },
        required: ['noteId'],
        additionalProperties: false,
      },
      output: { schema: JSON_OUTPUT_SCHEMA, render: (_args, value) => renderJson(value) },
      async execute(args) {
        if (notes === undefined || notes === null) return { status: 'unavailable', reason: 'notes service is not initialized' }
        return jsonSafe(await notes.get({ id: String(args.noteId ?? '') }))
      },
    },

    {
      name: 'notes_create',
      description:
        'Create one personal note (optionally linked to papers and in a note folder). It stores the user\'s content as content_md; AI beautification is a separate, explicit step and must never overwrite content_md.',
      parameters: {
        type: 'object',
        properties: {
          title: { type: 'string', description: 'Note title.' },
          content: { type: 'string', description: 'Original Markdown/plain text content.' },
          folderId: { type: 'string', description: 'Optional note folder id.' },
          paperIds: { type: 'array', items: { type: 'string' }, description: 'Optional linked paper ids.' },
        },
        additionalProperties: false,
      },
      output: { schema: JSON_OUTPUT_SCHEMA, render: (_args, value) => renderJson(value) },
      async execute(args) {
        if (notes === undefined || notes === null) return { status: 'unavailable', reason: 'notes service is not initialized' }
        return jsonSafe(await notes.create({
          ...(typeof args.title === 'string' ? { title: args.title } : {}),
          ...(typeof args.content === 'string' ? { content: args.content } : {}),
          ...(typeof args.folderId === 'string' && args.folderId !== '' ? { folderId: args.folderId } : {}),
          ...(Array.isArray(args.paperIds) ? { paperIds: args.paperIds.map(String) } : {}),
        }))
      },
    },

    {
      name: 'notes_update',
      description:
        'Update one note\'s user content/title/folder/paper links. content/contentMd writes content_md (user original); contentJson writes only the formatted layout. Always preserve content_md when editing layout, and pass expectedRevision for conflict safety.',
      parameters: {
        type: 'object',
        properties: {
          noteId: { type: 'string', description: 'Note id (note-...).' },
          patch: {
            type: 'object',
            description: 'Fields to update: title, content/contentMd (user original), contentJson (formatted layout only), folderId, paperIds, status.',
          },
          expectedRevision: { type: 'integer', description: 'Optional optimistic revision.' },
        },
        required: ['noteId', 'patch'],
        additionalProperties: false,
      },
      output: { schema: JSON_OUTPUT_SCHEMA, render: (_args, value) => renderJson(value) },
      async execute(args) {
        if (notes === undefined || notes === null) return { status: 'unavailable', reason: 'notes service is not initialized' }
        const patch = args.patch !== null && typeof args.patch === 'object' && !Array.isArray(args.patch) ? args.patch : {}
        return jsonSafe(await notes.update({
          id: String(args.noteId ?? ''),
          patch,
          ...(Number.isInteger(args.expectedRevision) ? { expectedRevision: args.expectedRevision } : {}),
        }))
      },
    },

    {
      name: 'notes_search',
      description:
        'Full-text search personal notes (title/content_md + the semantic text of the beautified layout). Can filter by note folder or linked paper. Use it for note recall and paper→note / note→paper discovery.',
      parameters: {
        type: 'object',
        properties: {
          q: { type: 'string', description: 'Search query (Chinese/English).' },
          folderId: { type: 'string', description: 'Optional note folder filter.' },
          paperId: { type: 'string', description: 'Optional linked-paper filter.' },
          limit: { type: 'integer', description: 'Max results (default 20).' },
        },
        required: ['q'],
        additionalProperties: false,
      },
      output: { schema: JSON_OUTPUT_SCHEMA, render: (_args, value) => renderJson(value) },
      async execute(args) {
        if (notes === undefined || notes === null) return { status: 'unavailable', reason: 'notes service is not initialized' }
        return jsonSafe(await notes.search({
          q: String(args.q ?? ''),
          ...(typeof args.folderId === 'string' && args.folderId !== '' ? { folderId: args.folderId } : {}),
          ...(typeof args.paperId === 'string' && args.paperId !== '' ? { paperId: args.paperId } : {}),
          ...(Number.isInteger(args.limit) ? { limit: args.limit } : {}),
        }))
      },
    },

    {
      name: 'notes_link_papers',
      description:
        'Link or unlink a note with one or more papers. Notes may link 0..N papers; every link is undoable and does not modify the paper content.',
      parameters: {
        type: 'object',
        properties: {
          noteId: { type: 'string', description: 'Note id (note-...).' },
          paperIds: { type: 'array', items: { type: 'string' }, description: 'Paper ids to link/unlink.' },
          action: { type: 'string', enum: ['link', 'unlink'], description: 'Default: link.' },
        },
        required: ['noteId', 'paperIds'],
        additionalProperties: false,
      },
      output: { schema: JSON_OUTPUT_SCHEMA, render: (_args, value) => renderJson(value) },
      async execute(args) {
        if (notes === undefined || notes === null) return { status: 'unavailable', reason: 'notes service is not initialized' }
        const paperIds = Array.isArray(args.paperIds) ? args.paperIds.map(String) : []
        if (String(args.action ?? 'link') === 'unlink') return jsonSafe(await notes.unlink({ noteId: String(args.noteId ?? ''), paperIds }))
        return jsonSafe(await notes.link({ noteId: String(args.noteId ?? ''), paperIds }))
      },
    },

    {
      name: 'papers_abstracts',
      description:
        'Fast abstract-only reader for ONE paper or MANY papers. Use it for human-like triage/classification when you need to read abstracts quickly without the full metadata payload of papers_get. ' +
        'Pass paperId (single) or paperIds (batch), or omit both to read abstracts by folder/query; returns title, year, venue, folders, abstract and abstractSource. ' +
        'It is read-only and uses the same human-readable abstract correction as papers_get (library_get/papers_get for full details).',
      parameters: {
        type: 'object',
        properties: {
          paperId: { type: 'string', description: 'Single paper id (ph-...).' },
          paperIds: { type: 'array', items: { type: 'string' }, description: 'Multiple paper ids (batch).' },
          folderId: { type: 'string', description: 'When no ids are given: only papers in this folder (and descendants).' },
          query: { type: 'string', description: 'When no ids are given: optional title/author/venue filter.' },
          limit: { type: 'integer', description: 'Batch page size 1–50 (default 20).' },
          offset: { type: 'integer', description: 'Pagination offset (default 0).' },
        },
        additionalProperties: false,
      },
      output: { schema: JSON_OUTPUT_SCHEMA, render: (_args, value) => renderJson(value) },
      execute(args) {
        const explicit = []
        if (typeof args.paperId === 'string' && args.paperId !== '') explicit.push(args.paperId)
        if (Array.isArray(args.paperIds)) for (const id of args.paperIds) if (typeof id === 'string' && id !== '') explicit.push(id)
        let ids = [...new Set(explicit)]
        if (ids.length === 0) {
          const limit = Math.max(1, Math.min(50, Number.isInteger(args.limit) ? args.limit : 20))
          const offset = Math.max(0, Number.isInteger(args.offset) ? args.offset : 0)
          const list = store.libraryList({
            limit,
            offset,
            ...(typeof args.folderId === 'string' && args.folderId !== '' ? { folderId: args.folderId } : {}),
            ...(typeof args.query === 'string' && args.query.trim() !== '' ? { query: args.query.trim() } : {}),
          })
          ids = (list.items || []).map((paper) => paper.id)
        }
        ids = ids.slice(0, 50)
        const items = []
        for (const paperId of ids) {
          let detail
          try { detail = store.libraryGet({ id: paperId }) } catch (error) { continue }
          const readable = store.readableAbstract(paperId)
          items.push({
            paperId,
            title: detail.title,
            titleZh: detail.titleZh ?? null,
            year: detail.year ?? null,
            venue: detail.venue ?? null,
            folders: (detail.collections || []).map((collection) => collection.name),
            tags: detail.tags || [],
            read: detail.read === true,
            abstract: readable && typeof readable.text === 'string' ? readable.text : (typeof detail.abstract === 'string' ? detail.abstract : null),
            abstractSource: readable ? readable.source : (detail.abstractSource ?? null),
            abstractCorrected: readable ? readable.corrected === true : false,
          })
        }
        return { status: 'ok', count: items.length, items }
      },
    },

    {
      name: 'papers_update',
      description:
        'Directly edit one paper\'s basic metadata (Chinese title, authors, venue, year, DOI, abstract, keywords, tags, read/progress). ' +
        'This is a basic primitive for human-like processing; use it deliberately and tell the user what changed. It never deletes papers.',
      parameters: {
        type: 'object',
        properties: {
          paperId: { type: 'string', description: 'Paper id (ph-...).' },
          patch: { type: 'object', description: 'Metadata fields to update (titleZh, authors, venue, year, doi, abstract, keywords, addTags, removeTags, read, readingProgress).' },
        },
        required: ['paperId', 'patch'],
        additionalProperties: false,
      },
      output: { schema: JSON_OUTPUT_SCHEMA, render: (_args, value) => renderJson(value) },
      execute(args) {
        const paperId = typeof args.paperId === 'string' ? args.paperId : ''
        const patch = args.patch
        if (paperId === '') return { status: 'invalid', reason: 'paperId is required' }
        if (patch === null || typeof patch !== 'object' || Array.isArray(patch)) return { status: 'invalid', reason: 'patch must be an object' }
        try {
          const result = store.libraryUpdate({ id: paperId, patch })
          return { status: 'ok', paper: result.paper ?? result, revision: result.revision ?? null }
        } catch (error) {
          return { status: 'invalid', reason: String(error?.message ?? error), paperId }
        }
      },
    },

    {
      name: 'papers_folder_hints',
      description:
        'Read-only reference for folder organization: cosine similarity between each paper and the existing folder profiles. ' +
        'This is NOT a classification decision and never mutates folders. Vector similarity is only a secondary hint: read the papers with papers_list/papers_get first, ' +
        'form the taxonomy by domain/method/question like a human librarian, then apply it yourself with papers_folders.',
      parameters: {
        type: 'object',
        properties: { paperIds: { type: 'array', items: { type: 'string' }, description: 'Paper ids to compare with existing folders.' } },
        required: ['paperIds'],
        additionalProperties: false,
      },
      output: { schema: JSON_OUTPUT_SCHEMA, render: (_args, value) => renderJson(value) },
      async execute(args) {
        if (!Array.isArray(args.paperIds) || args.paperIds.length === 0) return { status: 'invalid', reason: 'paperIds is required' }
        const result = await store.libraryClassify({ paperIds: args.paperIds.map(String), apply: false })
        return {
          status: result.status,
          referenceOnly: true,
          note: 'Vector similarity is a hint only, not a decision. Read papers and apply your own judgment with papers_folders.',
          reason: result.reason ?? null,
          threshold: result.threshold ?? null,
          suggestions: result.suggestions ?? [],
        }
      },
    },

    {
      name: 'papers_import_file',
      description:
        'Preview or import one local PDF into the Pappers-Hall library. ALWAYS call with confirm=false first when the user mentions/uploads a PDF path: ' +
        'it only reads title/DOI/page facts and returns status="needs_confirmation" with a question — it never writes. Only after the user says yes, call again with confirm=true; ' +
        'the import then runs the normal ingest pipeline and auto-classifies the new paper into a folder (creating one if needed). ' +
        'Relative paths resolve against the workspace cwd. Duplicate files return status="duplicate". ' +
        'After a successful import, tell the user the paper is unclassified and offer to read it with papers_list/papers_get and organize it with papers_folders.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Absolute PDF path or path relative to the workspace cwd.' },
          confirm: { type: 'boolean', description: 'false/omitted = read-only preview; true = actually import after user confirmation.' },
        },
        required: ['path'],
        additionalProperties: false,
      },
      output: { schema: JSON_OUTPUT_SCHEMA, render: (_args, value) => renderJson(value) },
      async execute(args, exec) {
        const resolved = resolveToolPath(args.path, exec)
        if (resolved === undefined) return { status: 'invalid', reason: 'path is required' }
        let fileStat
        try {
          fileStat = await stat(resolved)
        } catch {
          return { status: 'invalid', reason: `file does not exist: ${resolved}`, path: resolved }
        }
        if (!fileStat.isFile()) return { status: 'invalid', reason: 'path is not a regular file', path: resolved }
        let head
        try {
          head = await headBytes(resolved, 5)
        } catch (error) {
          return { status: 'invalid', reason: `file is not readable: ${String(error?.message ?? error)}`, path: resolved }
        }
        if (head.toString('latin1') !== '%PDF-') return { status: 'invalid', reason: 'file is not a PDF (missing %PDF- header)', path: resolved }
        if (args.confirm !== true) {
          const preview = await previewPdfFile(resolved)
          const titleText = preview.title ?? path.basename(resolved)
          return {
            status: 'needs_confirmation',
            kind: preview.kind,
            title: preview.title,
            doi: preview.doi,
            pageCount: preview.pageCount,
            bytes: fileStat.size,
            path: resolved,
            firstPageSnippet: preview.firstPageSnippet,
            question: `这篇 PDF 看起来是论文《${titleText}》，要加入论文中心吗？`,
          }
        }
        if (ingest === undefined || ingest === null || typeof ingest.importRequest !== 'function') {
          return { status: 'unavailable', reason: 'import pipeline is unavailable', path: resolved }
        }
        const imported = await ingest.importRequest({ paths: [resolved] })
        const first = Array.isArray(imported.acceptedItems) && imported.acceptedItems.length > 0 ? imported.acceptedItems[0] : undefined
        if (first === undefined) {
          if (Array.isArray(imported.duplicates) && imported.duplicates.length > 0) {
            return { status: 'duplicate', reason: 'this PDF is already in the library', paperId: imported.duplicates[0].paperId, duplicates: imported.duplicates, errors: imported.errors }
          }
          const firstError = Array.isArray(imported.errors) ? imported.errors[0] : undefined
          return { status: 'invalid', reason: firstError?.message ?? 'import produced no paper', errors: imported.errors, path: resolved }
        }
        const paper = store.paperSummary(first.paperId)
        // v0.16 fix: this tool calls the ingest pipeline directly (not through
        // library.import), so it must trigger the incremental embedding sync
        // itself; otherwise a paper imported from DSH conversation has no
        // vector index until a manual rebuild (search/related miss it).
        try {
          store.notifyIndexChanged({ delayMs: 1500, followUpDelays: [6000, 18000] })
        } catch (error) { /* optional embedding capability */ }
        return {
          status: 'imported',
          paperId: first.paperId,
          title: paper?.titleZh ?? paper?.title ?? null,
          classification: imported.classification ?? null,
          import: { jobId: imported.jobId ?? null, accepted: imported.accepted, duplicates: imported.duplicates, errors: imported.errors },
          path: resolved,
        }
      },
    },

    {
      name: 'papers_related',
      description:
        'Find semantically related papers in the library using real local embeddings (multilingual, cosine similarity). ' +
        'Pass paperId to find neighbors of an existing paper, or query for free-text semantic search. Excludes the source paper, returns title/year/venue/score. ' +
        'Use when the user asks "what else is related to this paper/topic" or needs reading suggestions.',
      parameters: {
        type: 'object',
        properties: {
          paperId: { type: 'string', description: 'Source paper id (ph-...).' },
          query: { type: 'string', description: 'Free-text semantic query (Chinese works; used when paperId is omitted).' },
          limit: { type: 'integer', description: 'Maximum number of related papers (default 8).' },
        },
        additionalProperties: false,
      },
      output: { schema: JSON_OUTPUT_SCHEMA, render: (_args, value) => renderJson(value) },
      async execute(args) {
        const paperId = typeof args.paperId === 'string' ? args.paperId : undefined
        const query = typeof args.query === 'string' ? args.query : undefined
        return relatedPapers({ paperId, query, limit: args.limit })
      },
    },
  ]
}

/**
 * Validate one proposed operation without applying it.
 * @param {object} store domain store.
 * @param {object} operation proposed operation.
 * @returns {object} `{ok, conflict?|summary?, preview?}`.
 */
function validateOperation(store, operation) {
  if (operation === null || typeof operation !== 'object') return { ok: false, preview: 'operation must be an object' }
  const op = String(operation.op ?? '')
  try {
    switch (op) {
      case 'set_title_zh': {
        const paperId = String(operation.paper_id ?? '')
        const paper = store.paperSummary(paperId)
        if (paper === undefined) return { ok: false, preview: `paper ${paperId} not found` }
        if (paper.state !== 'active') return { ok: false, preview: `paper ${paperId} is in the recycle bin` }
        if (typeof operation.title_zh !== 'string' || operation.title_zh.trim() === '') return { ok: false, preview: 'title_zh is required' }
        if (Number.isInteger(operation.expected_revision) && operation.expected_revision !== paper.revision) {
          return { ok: false, conflict: true, preview: `paper ${paperId} revision is ${paper.revision}, not ${operation.expected_revision}` }
        }
        return { ok: true, summary: `set Chinese title of ${paper.title}`, preview: `${paper.title} → ${operation.title_zh}` }
      }
      case 'add_tag':
      case 'remove_tag': {
        const paperId = String(operation.paper_id ?? '')
        const paper = store.paperSummary(paperId)
        if (paper === undefined) return { ok: false, preview: `paper ${paperId} not found` }
        if (typeof operation.tag !== 'string' || operation.tag.trim() === '') return { ok: false, preview: 'tag is required' }
        return { ok: true, summary: `${op} "${operation.tag.trim()}" on ${paper.title}`, preview: `${op}: ${operation.tag.trim()}` }
      }
      case 'create_annotation': {
        const paperId = String(operation.paper_id ?? '')
        const paper = store.paperSummary(paperId)
        if (paper === undefined) return { ok: false, preview: `paper ${paperId} not found` }
        if (typeof operation.text !== 'string' || operation.text.trim() === '') return { ok: false, preview: 'annotation text is required' }
        return { ok: true, summary: `annotation on page ${operation.page ?? 1} of ${paper.title}`, preview: operation.text.slice(0, 120) }
      }
      case 'save_note': {
        if (typeof operation.text !== 'string' || operation.text.trim() === '') return { ok: false, preview: 'note text is required' }
        return { ok: true, summary: 'save a note', preview: operation.text.slice(0, 120) }
      }
      default:
        return { ok: false, preview: `unsupported operation ${op}` }
    }
  } catch (error) {
    return { ok: false, preview: String(error?.message ?? error) }
  }
}

/**
 * Apply one stored proposal and return per-operation results with an undo token.
 * @param {object} store domain store.
 * @param {object} proposal stored proposal.
 * @param {string} operationId idempotency label for the applied record.
 * @returns {Promise<{results:object[], undo_token:string}>}
 */
async function applyProposal(store, proposal, operationId) {
  const undoToken = `undo-${Math.random().toString(16).slice(2, 14)}`
  const undo = []
  const results = []
  for (const [index, operation] of (proposal.operations ?? []).entries()) {
    try {
      if (operation.op === 'set_title_zh') {
        const previous = store.paperSummary(operation.paper_id)
        const updated = store.libraryUpdate({
          id: operation.paper_id,
          patch: { titleZh: operation.title_zh.trim() },
          ...(Number.isInteger(operation.expected_revision) ? { expectedRevision: operation.expected_revision } : {}),
        })
        undo.push({ op: 'set_title_zh', paper_id: operation.paper_id, previous_title_zh: previous?.titleZh ?? null })
        results.push({ index, ok: true, revision: updated.revision })
        continue
      }
      if (operation.op === 'add_tag' || operation.op === 'remove_tag') {
        const paper = store.paperSummary(operation.paper_id)
        const current = store.libraryGet({ id: operation.paper_id }).tags ?? []
        const tag = operation.tag.trim()
        const next = operation.op === 'add_tag' ? [...new Set([...current, tag])] : current.filter((item) => item !== tag)
        const updated = store.libraryUpdate({ id: operation.paper_id, patch: { tags: next } })
        undo.push({ op: 'set_tags', paper_id: operation.paper_id, previous_tags: current })
        results.push({ index, ok: true, revision: updated.revision })
        continue
      }
      if (operation.op === 'create_annotation') {
        const created = store.annotationsCreate({
          paperId: operation.paper_id,
          page: operation.page ?? 1,
          quote: operation.quote ?? null,
          text: operation.text,
          rect: operation.rect ?? null,
          origin: 'ai_explanation',
        })
        undo.push({ op: 'delete_annotation', id: created.annotation.id })
        results.push({ index, ok: true, annotation_id: created.annotation.id })
        continue
      }
      if (operation.op === 'save_note') {
        const created = store.notesCreate({
          paperId: operation.paper_id ?? undefined,
          text: operation.text,
          title: operation.title,
          origin: 'ai_explanation',
          sourceRefs: operation.source_refs ?? [],
        })
        undo.push({ op: 'delete_note', id: created.note.id })
        results.push({ index, ok: true, note_id: created.note.id })
        continue
      }
      results.push({ index, ok: false, conflict: false, error: `unsupported operation ${String(operation.op)}` })
    } catch (error) {
      results.push({ index, ok: false, conflict: error?.code === 'conflict', error: String(error?.message ?? error) })
    }
  }
  store.writeSetting(`undo:${undoToken}`, { operationId, undo, createdAt: new Date().toISOString() })
  return { results, undo_token: undoToken }
}

export { normalizeTitleKey }
