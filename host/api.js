/**
 * HTTP surface for the Pappers-Hall Host half: the same-origin JSON API used by
 * the Web Client and by test harnesses, plus the binary asset routes (page
 * renders, figure crops, thumbnails and the original PDF).
 *
 * The route handler is a plain `node:http` `(req, res)` function registered by
 * `applyHost` on the composed web server under `/pappers-hall/`. Every asset
 * path is built from validated identifiers, never from a user-supplied path
 * fragment, so path traversal is impossible by construction.
 *
 * @module pappers-hall/host/api
 */
import { readdir, readFile, rm, stat } from 'node:fs/promises'
import path from 'node:path'
import { DomainError } from './store.js'
import { clampInt, safeFileStem } from './paths.js'

/** Writes that can change searchable/embedded content; each schedules a debounced incremental sync. */
const SYNC_METHODS = new Set([
  'library.import',
  'library.update',
  'library.delete',
  'library.restore',
  'library.purge',
  'library.merge',
  'annotations.create',
  'annotations.update',
  'annotations.delete',
  'notes.create',
  'notes.delete',
  'operations.undo',
])

/** Default JSON body limit for the API route (contract §2: 110 MB). */
export const DEFAULT_BODY_LIMIT_BYTES = 110 * 1024 * 1024

/** Paper id shape from the contract. */
const PAPER_ID_PATTERN = /^ph-[a-f0-9]{12}$/

/** Figure id shape (internal, documented in the README). */
const FIGURE_ID_PATTERN = /^fg-[a-f0-9]{12}$/

/** Page image path suffix. */
const PAGE_FILE_PATTERN = /^([1-9][0-9]{0,4})\.png$/

/**
 * Whether one `notes.create` call targets the legacy paper quick-note table.
 *
 * The v0.17 notes workbench reuses the `notes.create` / `notes.delete` wire
 * names, but the pre-existing paper quick-note table (`nt-…` ids, `text` +
 * `origin`) is still part of the public surface (`search.query scope:'notes'`,
 * `export.notes`, bundle materials). The two shapes are disjoint, so dispatch is
 * explicit: a call that carries user markdown (`content`/`contentMd`) or none of
 * the legacy fields is a workbench note.
 * @param {object} params create params.
 * @returns {boolean} true for the legacy paper-note path.
 */
function isLegacyPaperNoteCreate(params = {}) {
  // Presence of the legacy `text` field is the discriminator; passing `text:''`
  // must still produce the historic `invalid` error instead of silently creating
  // an empty workbench note.
  if (!Object.hasOwn(params, 'text')) return false
  if (params.content !== undefined || params.contentMd !== undefined || params.content_md !== undefined) return false
  if (Array.isArray(params.paperIds) || typeof params.folderId === 'string') return false
  return true
}

/** Dispatch `notes.create` between the workbench and the legacy paper-note table. */
function dispatchNoteCreate(params, store, notes) {
  if (isLegacyPaperNoteCreate(params)) return store.notesCreate(params)
  return notes.create(params)
}

/**
 * Dispatch `notes.delete`.
 *
 * `{ids:[...]}` with `note-…` ids is the workbench recycle bin; a legacy
 * `{id:'nt-…'}` (or `nt-…` inside `ids`) keeps its historic single-note delete
 * semantics so older clients and the selftest keep working.
 */
function dispatchNoteDelete(params, store, notes) {
  const raw = Array.isArray(params.ids) ? params.ids.map((id) => String(id)) : typeof params.id === 'string' ? [params.id] : []
  const ids = raw.map((id) => id.trim()).filter((id) => id !== '')
  if (ids.length === 0) throw new DomainError('invalid', 'notes.delete requires ids')
  const docIds = ids.filter((id) => id.startsWith('note-'))
  const legacyIds = ids.filter((id) => !id.startsWith('note-'))
  if (docIds.length > 0 && legacyIds.length === 0) return notes.delete({ ...params, ids: docIds })
  if (legacyIds.length === 0) throw new DomainError('invalid', 'notes.delete requires ids')
  if (docIds.length > 0) throw new DomainError('invalid', 'notes.delete cannot mix workbench notes and legacy paper notes in one call')
  const results = legacyIds.map((id) => (legacyIds.length === 1 ? store.notesDelete({ ...params, id }) : store.notesDelete({ id })))
  return legacyIds.length === 1 ? results[0] : { deleted: legacyIds, trashed: true, results }
}

/**
 * Map the wire method table onto store/search/ingest operations.
 *
 * Kept explicit (rather than reflecting over the store) so a new internal helper
 * can never become a remotely callable operation by accident.
 * @param {object} services wired services.
 * @param {object} services.store domain store.
 * @param {object} services.search search service.
 * @param {object} services.ingest ingest service.
 * @param {object} services.queue job queue.
 * @param {object} [services.notes] notes workbench service (v0.17).
 * @returns {{handlers:Map<string,Function>, call:(method:string, params?:object)=>Promise<object>, envelope:(method:string,params?:object)=>Promise<object>, methods:string[]}} API facade.
 */
export function createApi({ store, search, ingest, queue, settings, models, ocr, notes, noteAgent, layout }) {
  const handlers = new Map([
    // ---- read-only -------------------------------------------------
    ['status', () => store.status()],
    ['library.list', (params) => store.libraryList(params)],
    ['library.get', (params) => store.libraryGet(params)],
    ['library.tags', () => store.libraryTags()],
    ['search.query', (params) => search.query(params)],
    ['reader.open', (params) => store.readerOpen(params)],
    ['reader.page', (params) => store.readerPage(params)],
    ['reader.layer', (params) => store.readerLayer(params)],
    ['reader.pageText', (params) => store.readerPageText(params)],
    ['reader.outline', (params) => store.readerOutline(params)],
    ['annotations.list', (params) => store.annotationsList(params)],
    ['figures.list', (params) => store.figuresList(params)],
    ['figures.search', (params) => search.figuresSearch(params)],
    ['jobs.list', () => store.jobsList()],
    ['export.bibtex', (params) => store.exportBibtex(params)],
    ['export.csl', (params) => store.exportCsl(params)],
    ['export.notes', (params) => store.exportNotes(params)],
    ['export.locations', (params) => store.exportLocations(params)],
    ['diagnostics', () => store.diagnostics()],
    ['cache.clearPdfPreviews', async () => {
      if (layout === undefined || layout === null || typeof layout.tmpDir !== 'string') {
        throw new DomainError('unavailable', 'PDF preview cache is not available in this Host')
      }
      const directory = path.join(layout.tmpDir, 'pdf-previews')
      let names = []
      try { names = await readdir(directory) } catch { return { status: 'ok', cleared: 0, freedBytes: 0, available: true } }
      let cleared = 0
      let freedBytes = 0
      for (const name of names) {
        if (!/\.png$/i.test(name)) continue
        const filePath = path.join(directory, name)
        try {
          const info = await stat(filePath)
          if (!info.isFile()) continue
          freedBytes += info.size
          await rm(filePath, { force: true })
          cleared += 1
        } catch (error) { /* keep clearing the remaining files */ }
      }
      return { status: 'ok', cleared, freedBytes, available: true }
    }],

    // ---- writes ----------------------------------------------------
    ['library.import', (params) => ingest.importRequest(params ?? {})],
    ['library.update', (params) => store.libraryUpdate(params)],
    ['discover.feed', (params) => store.discoverFeed(params)],
    ['annotations.feed', (params) => store.annotationsFeed(params)],
    ['library.tiles', (params) => store.libraryTiles(params)],
    ['library.setRead', (params) => store.librarySetRead(params)],
    ['library.delete', (params) => store.libraryDelete(params)],
    ['library.restore', (params) => store.libraryRestore(params)],
    ['library.purge', (params) => store.libraryPurge(params)],
    ['library.collections.list', () => store.libraryCollectionsList()],
    ['library.folders.tree', () => store.libraryFoldersTree()],
    ['library.classify', (params) => store.libraryClassify(params ?? {})],
    ['library.setFavorite', (params) => store.librarySetFavorite(params)],
    ['library.collections.create', (params) => store.libraryCollectionsCreate(params)],
    ['library.collections.update', (params) => store.libraryCollectionsUpdate(params)],
    ['library.collections.delete', (params) => store.libraryCollectionsDelete(params)],
    ['library.collections.assign', (params) => store.libraryCollectionsAssign(params)],
    ['tags.list', () => store.tagsList()],
    ['tags.rename', (params) => store.tagsRename(params)],
    ['tags.delete', (params) => store.tagsDelete(params)],
    ['annotations.create', async (params) => {
      // v0.17: a quote selected inside a broken-font figure is glyph-code text.
      // Repair it from region OCR (using the annotation rects) before storing.
      let next = params ?? {}
      let quoteRepair = null
      const quote = typeof next.quote === 'string' ? next.quote : ''
      if (quote !== '' && Array.isArray(next.rects) && typeof next.paperId === 'string' && next.paperId !== '') {
        try {
          const repaired = await store.repairQuoteFromOcr(next.paperId, Number(next.page ?? 1), next.rects, quote)
          if (repaired !== null && typeof repaired.text === 'string' && repaired.text.trim() !== '') {
            next = { ...next, quote: repaired.text }
            quoteRepair = repaired.source
          }
        } catch (error) { /* optional OCR capability */ }
      }
      const result = store.annotationsCreate(next)
      return quoteRepair === null ? result : { ...result, quoteRepair }
    }],
    ['annotations.update', (params) => store.annotationsUpdate(params)],
    ['annotations.delete', (params) => store.annotationsDelete(params)],
    ['notes.create', (params) => dispatchNoteCreate(params, store, notes)],
    ['notes.delete', (params) => dispatchNoteDelete(params, store, notes)],
    // ---- v0.17 notes workbench ---------------------------------------
    ['notes.list', (params) => notes.list(params)],
    ['notes.agent.directions', async (params) => {
      if (noteAgent === undefined || typeof noteAgent.directions !== 'function') throw new DomainError('unavailable', 'note agent is not available in this Host')
      return noteAgent.directions(params ?? {})
    }],
    ['notes.agent.run', async (params) => {
      if (noteAgent === undefined || typeof noteAgent.run !== 'function') throw new DomainError('unavailable', 'note agent is not available in this Host')
      return noteAgent.run(params ?? {})
    }],
    ['notes.get', (params) => notes.get(params)],
    ['notes.update', (params) => notes.update(params)],
    ['notes.restore', (params) => notes.restore(params)],
    ['notes.purge', (params) => notes.purge(params)],
    ['notes.revisions', (params) => notes.revisions(params)],
    ['notes.restoreRevision', (params) => notes.restoreRevision(params)],
    ['notes.folders.tree', () => notes.folderTree()],
    ['notes.folders.create', (params) => notes.folderCreate(params)],
    ['notes.folders.rename', (params) => notes.folderUpdate(params)],
    ['notes.folders.delete', (params) => notes.folderDelete(params)],
    ['notes.folders.assign', (params) => notes.folderAssign(params)],
    ['notes.folders.unassign', (params) => notes.folderUnassign(params)],
    ['notes.link', (params) => notes.link(params)],
    ['notes.unlink', (params) => notes.unlink(params)],
    ['notes.search', (params) => notes.search(params)],
    ['notes.export', (params) => notes.exportNotes(params)],
    ['notes.indexSync', (params) => notes.indexSync(params ?? {})],
    ['notes.indexStatus', () => notes.indexStatus()],
    ['translate.title', (params) => store.translateTitle(params)],
    ['translate.text', (params) => store.translateText(params)],
    ['translate.region', async (params) => {
      const paperId = String(params?.paperId ?? '')
      const page = Number(params?.page)
      const rects = Array.isArray(params?.rects) ? params.rects : []
      if (paperId === '' || !Number.isInteger(page) || page < 1 || rects.length === 0) return { status: 'invalid', translation: null, regionText: '', reason: 'translate.region requires paperId, page and rects' }
      const regionText = await store.ocrRegionText(paperId, page, rects)
      if (regionText === '') return { status: 'unavailable', translation: null, regionText: '', reason: '选区没有识别出可翻译文字（可能是图内文字或 OCR 未就绪）' }
      // Selection text is short and often contains emails/URLs that the free
      // translation chain rejects; use the model's translation primitive directly.
      const aiResult = await store.aiComplete({
        prompt: '把下面这段论文页面选区翻译成简体中文，只输出译文；保留公式、数字、专有名词与引用编号：\n\n' + regionText,
        system: '你是学术翻译，只输出翻译结果，不解释、不总结、不添加原文没有的内容。',
        fast: false,
        reasoningEffort: 'medium',
        maxTokens: 1400,
        kind: 'translate-region',
      })
      if (aiResult && aiResult.status === 'ok') {
        return {
          status: 'translated',
          translation: String(aiResult.answer || ''),
          regionText,
          provider: aiResult.provider || '',
          model: aiResult.model || '',
          elapsedMs: Number(aiResult.elapsedMs) || 0,
        }
      }
      return { status: 'unavailable', translation: null, regionText, reason: String((aiResult && (aiResult.reason || 'AI 翻译不可用')) || 'AI 翻译不可用') }
    }],
    ['translate.blocks', (params) => store.translateBlocks(params)],
    ['embedding.status', () => store.embeddingStatus()],
    // ---- v0.11 settings center / model installation / OCR ----------
    ['settings.get', () => settings.get()],
    ['settings.update', (params) => settings.update(params ?? {})],
    ['models.install', (params) => models.install(params ?? {})],
    ['models.cancel', (params) => models.cancel(params ?? {})],
    ['models.rebuildIndex', (params) => models.rebuildIndex(params ?? {})],
    ['ocr.index', (params) => ocr.index(params ?? {})],
    ['translation.test', (params) => store.translationTest(params ?? {})],
    ['embedding.index', (params) => store.embeddingIndex(params)],
    ['translate.providers', () => store.translateProviders()],
    ['translate.settings', (params) => store.translateSettings(params)],
    ['translate.detect', (params) => store.translateDetect(params)],
    ['ai.status', () => store.aiStatus()],
    ['ai.providers', () => store.aiProviders()],
    ['ai.setDefault', (params) => store.aiSetDefault(params ?? {})],
    ['ai.ask', (params) => store.aiAsk(params)],
    ['ai.complete', (params) => store.aiComplete(params)],
    ['references.commit', (params) => store.referencesCommit(params)],
    ['references.append', (params) => store.referencesAppend(params)],
    ['references.attach', (params) => store.referencesAttach(params)],
    ['references.resolve', (params) => store.referencesResolve(params)],
    [
      'jobs.pause',
      (params) => {
        const result = queue.pause(params?.id)
        return params?.id === undefined ? result : { job: result }
      },
    ],
    [
      'jobs.resume',
      (params) => {
        const result = queue.resume(params?.id)
        return params?.id === undefined ? result : { job: result }
      },
    ],
    // ---- v0.3 journal metrics / undo / duplicates / citations -----
    ['metrics.update', (params) => store.metricsUpdate(params)],
    ['metrics.refresh', (params) => store.metricsRefresh(params)],
    ['metrics.reset', (params) => store.metricsReset(params)],
    ['operations.recent', (params) => store.operationsRecent(params)],
    ['operations.undo', (params) => store.operationsUndo(params)],
    ['library.duplicates', () => store.libraryDuplicates()],
    ['library.merge', (params) => store.libraryMerge(params)],
    ['citation.format', (params) => store.citationFormat(params)],
    ['citation.key', (params) => store.citationKey(params)],
    ['export.annotations', (params) => store.exportAnnotations(params)],
    ['ai.quickTranslate', (params) => store.aiQuickTranslate(params)],
    ['saved_searches.list', () => store.savedSearchesList()],
    ['saved_searches.create', (params) => store.savedSearchesCreate(params)],
    ['saved_searches.update', (params) => store.savedSearchesUpdate(params)],
    ['saved_searches.delete', (params) => store.savedSearchesDelete(params)],
    ['jobs.retry', (params) => ({ job: queue.retry(params?.id) })],
    ['jobs.cancel', (params) => ({ job: queue.cancel(params?.id) })],
  ])

  /**
   * Invoke one method, throwing {@link DomainError} on failure.
   * @param {string} method wire method name.
   * @param {object} [params] parameters.
   * @returns {Promise<unknown>} the method result.
   */
  async function call(method, params) {
    const handler = handlers.get(method)
    if (handler === undefined) throw new DomainError('invalid', `unknown API method "${String(method)}"`, { method })
    if (params !== undefined && params !== null && (typeof params !== 'object' || Array.isArray(params))) {
      throw new DomainError('invalid', 'params must be a JSON object', { method })
    }
    const result = await handler(params ?? {})
    if (SYNC_METHODS.has(method)) {
      try {
        store.notifyIndexChanged(method === 'library.import'
          ? { delayMs: 1500, followUpDelays: [6000, 18000] }
          : { delayMs: 900 })
      } catch (error) { /* optional embedding capability */ }
    }
    return result
  }

  /**
   * Invoke one method and return the contract envelope used by the Client.
   * @param {string} method wire method name.
   * @param {object} [params] parameters.
   * @returns {Promise<{ok:true,data:unknown}|{ok:false,error:{code:string,message:string}}>} envelope.
   */
  async function envelope(method, params) {
    try {
      const data = await call(method, params)
      return { ok: true, data }
    } catch (error) {
      return { ok: false, error: toErrorPayload(error) }
    }
  }

  return { handlers, call, envelope, methods: [...handlers.keys()] }
}

/** Convert any thrown value into the stable `{code,message}` payload. */
export function toErrorPayload(error) {
  if (error instanceof DomainError) {
    return { code: error.code, message: error.message, ...(error.meta === undefined ? {} : { detail: error.meta }) }
  }
  const message = error instanceof Error ? error.message : String(error)
  const code = typeof error?.code === 'string' && /^[a-z_]+$/.test(error.code) ? error.code : 'internal'
  return { code, message, ...(error?.detail === undefined ? {} : { detail: error.detail }) }
}

/** Map one domain error code to an HTTP status code. */
function httpStatusForCode(code) {
  switch (code) {
    case 'not_found':
      return 404
    case 'invalid':
      return 400
    case 'conflict':
      return 409
    case 'unavailable':
    case 'degraded':
      return 503
    default:
      return 500
  }
}

/** Write one JSON response. */
function sendJson(res, status, payload) {
  const body = JSON.stringify(payload)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
  })
  res.end(body)
}

/** Read a bounded request body as UTF-8 text. */
function readBody(req, limitBytes) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let total = 0
    req.on('data', (chunk) => {
      total += chunk.length
      if (total > limitBytes) {
        const error = new Error(`request body exceeds ${limitBytes} bytes`)
        error.code = 'too_large'
        reject(error)
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    req.on('error', reject)
  })
}

/**
 * Create the `/pappers-hall/` route handler.
 * @param {object} options handler options.
 * @param {object} options.api API facade from {@link createApi}.
 * @param {object} options.store domain store.
 * @param {object} options.pdf poppler facade.
 * @param {object} options.layout owned path table.
 * @param {object} [options.logger] logger.
 * @param {number} [options.bodyLimitBytes] JSON body cap.
 * @returns {(req:import('node:http').IncomingMessage, res:import('node:http').ServerResponse)=>Promise<void>} handler.
 */
export function createWebHandler({ api, store, pdf, layout, search, logger, bodyLimitBytes = DEFAULT_BODY_LIMIT_BYTES, backup }) {
  /** Whether the poppler facade is usable for render requests. */
  const rendersAvailable = () => pdf?.detection?.available === true

  /* Page rasters are expensive and the reader asks for several at once. Keep
     at most two poppler processes alive and coalesce duplicate requests for the
     same cache path, so opening a page can never queue a second identical
     render behind the first. */
  const pageRenderSlots = { active: 0, queue: [] }
  const pageRenders = new Map()
  function queuePageRender(task) {
    return new Promise((resolve, reject) => {
      const run = () => {
        pageRenderSlots.active += 1
        Promise.resolve()
          .then(task)
          .then(resolve, reject)
          .finally(() => {
            pageRenderSlots.active -= 1
            const next = pageRenderSlots.queue.shift()
            if (next) next()
          })
      }
      if (pageRenderSlots.active < 2) run()
      else pageRenderSlots.queue.push(run)
    })
  }

  /** Serve one file with the private cache policy used by every asset route. */
  async function serveFile(req, res, filePath, contentType) {
    let info
    try {
      info = await stat(filePath)
    } catch {
      sendJson(res, 404, { ok: false, error: { code: 'not_found', message: 'asset not generated yet' } })
      return
    }
    if (!info.isFile()) {
      sendJson(res, 404, { ok: false, error: { code: 'not_found', message: 'asset not generated yet' } })
      return
    }
    res.writeHead(200, {
      'content-type': contentType,
      'content-length': info.size,
      'cache-control': 'private, max-age=3600',
      'last-modified': info.mtime.toUTCString(),
      'x-content-type-options': 'nosniff',
    })
    if (req.method === 'HEAD') {
      res.end()
      return
    }
    try {
      res.end(await readFile(filePath))
    } catch (error) {
      logger?.warn?.(`pappers-hall: asset read failed: ${String(error?.message ?? error)}`)
      res.destroy()
    }
  }

  /** Render one page image into the page cache on demand and serve it. */
  async function servePage(req, res, paperId, page, width) {
    const paper = store.paperRow(paperId)
    if (paper === undefined) {
      sendJson(res, 404, { ok: false, error: { code: 'not_found', message: `paper ${paperId} does not exist` } })
      return
    }
    if (paper.state !== 'active') {
      sendJson(res, 404, { ok: false, error: { code: 'not_found', message: `paper ${paperId} is in the recycle bin` } })
      return
    }
    const version = store.latestVersion(paperId)
    if (version === undefined || typeof version.file_path !== 'string') {
      sendJson(res, 404, { ok: false, error: { code: 'not_found', message: 'paper has no stored PDF' } })
      return
    }
    const pageCount = Number(version.page_count ?? 0)
    if (pageCount > 0 && page > pageCount) {
      sendJson(res, 404, { ok: false, error: { code: 'not_found', message: `page ${page} is outside 1..${pageCount}` } })
      return
    }
    const cachePath = path.join(layout.pagesCacheDir, `${paperId}-${page}-w${width}.png`)
    /* Serve an existing raster before asking whether poppler is available:
       cached pages must keep working even if the tool was removed later. */
    try {
      const cached = await stat(cachePath)
      // A truncated cache file must never be served as a blank page.
      if (cached.isFile() && cached.size > 512) {
        await serveFile(req, res, cachePath, 'image/png')
        return
      }
    } catch {
      // Not cached yet: render below.
    }
    if (!rendersAvailable()) {
      sendJson(res, 503, { ok: false, error: { code: 'unavailable', message: 'poppler is not installed; page rendering is unavailable' } })
      return
    }
    let render = pageRenders.get(cachePath)
    if (render === undefined) {
      const startedAt = Date.now()
      render = queuePageRender(() =>
        pdf.renderPage({ filePath: version.file_path, page, width, outputPath: cachePath, timeoutMs: 45_000 }),
      )
      const tracked = render
      pageRenders.set(cachePath, tracked)
      tracked
        .then(() => {
          logger?.debug?.(`pappers-hall: rendered page ${page} of ${paperId} at ${width}px in ${Date.now() - startedAt}ms`)
        })
        .catch(() => {
          /* the per-request handler reports the actionable error */
        })
        .finally(() => {
          if (pageRenders.get(cachePath) === tracked) pageRenders.delete(cachePath)
        })
    }
    try {
      await render
    } catch (error) {
      const status = error?.code === 'unavailable' ? 503 : error?.code === 'timeout' ? 504 : 500
      sendJson(res, status, { ok: false, error: toErrorPayload(error) })
      return
    }
    await serveFile(req, res, cachePath, 'image/png')
  }

  /** Render one figure crop (optionally at a requested width) and serve it. */
  async function serveFigure(req, res, figureId, width) {
    const figure = store.figureRow(figureId)
    if (figure === undefined) {
      sendJson(res, 404, { ok: false, error: { code: 'not_found', message: `figure ${figureId} does not exist` } })
      return
    }
    const paper = store.paperRow(figure.paper_id)
    if (paper === undefined || paper.state !== 'active') {
      sendJson(res, 404, { ok: false, error: { code: 'not_found', message: 'figure belongs to an unavailable paper' } })
      return
    }
    if (typeof figure.file_name !== 'string' || figure.file_name === '') {
      sendJson(res, 404, { ok: false, error: { code: 'not_found', message: 'figure image was not generated', detail: { status: figure.status } } })
      return
    }
    const basePath = path.join(layout.figuresDir, figure.file_name)
    if (width === null) {
      await serveFile(req, res, basePath, 'image/png')
      return
    }
    const bbox = parseJsonObject(figure.bbox_json)
    const pageSize = bbox?.pageWidth !== undefined ? { width: Number(bbox.pageWidth), height: Number(bbox.pageHeight) } : undefined
    if (bbox === undefined || pageSize === undefined) {
      // Legacy row without page geometry: serve the native crop rather than a wrong scale.
      await serveFile(req, res, basePath, 'image/png')
      return
    }
    const cachePath = path.join(layout.figuresCacheDir, `${figureId}-w${width}.png`)
    try {
      await stat(cachePath)
      await serveFile(req, res, cachePath, 'image/png')
      return
    } catch {
      // Not cached yet: fall through to the renderer.
    }
    const version = store.latestVersion(paper.id)
    if (version === undefined || typeof version.file_path !== 'string' || !rendersAvailable()) {
      await serveFile(req, res, basePath, 'image/png')
      return
    }
    try {
      await pdf.renderCrop({
        filePath: version.file_path,
        page: Number(figure.page),
        bbox: { x: Number(bbox.x), y: Number(bbox.y), w: Number(bbox.w), h: Number(bbox.h) },
        pageSize,
        outputPath: cachePath,
        targetWidth: width,
      })
    } catch (error) {
      logger?.warn?.(`pappers-hall: figure resize failed: ${String(error?.message ?? error)}`)
      await serveFile(req, res, basePath, 'image/png')
      return
    }
    await serveFile(req, res, cachePath, 'image/png')
  }

  /** Serve the first-page thumbnail of one paper. */
  async function serveThumb(req, res, paperId) {
    const paper = store.paperRow(paperId)
    if (paper === undefined || paper.state !== 'active') {
      sendJson(res, 404, { ok: false, error: { code: 'not_found', message: `paper ${paperId} does not exist` } })
      return
    }
    const cachePath = path.join(layout.thumbsCacheDir, `${paperId}-thumb-320.png`)
    try {
      await stat(cachePath)
      await serveFile(req, res, cachePath, 'image/png')
      return
    } catch {
      // Render below.
    }
    const version = store.latestVersion(paperId)
    if (version === undefined || typeof version.file_path !== 'string') {
      sendJson(res, 404, { ok: false, error: { code: 'not_found', message: 'paper has no stored PDF' } })
      return
    }
    if (!rendersAvailable()) {
      sendJson(res, 503, { ok: false, error: { code: 'unavailable', message: 'poppler is not installed; thumbnails are unavailable' } })
      return
    }
    try {
      await pdf.renderPage({ filePath: version.file_path, page: 1, width: 320, outputPath: cachePath })
    } catch (error) {
      sendJson(res, error?.code === 'unavailable' ? 503 : 500, { ok: false, error: toErrorPayload(error) })
      return
    }
    await serveFile(req, res, cachePath, 'image/png')
  }

  /** Serve the original stored PDF of one paper. */
  async function servePdf(req, res, paperId) {
    const paper = store.paperRow(paperId)
    if (paper === undefined || paper.state !== 'active') {
      sendJson(res, 404, { ok: false, error: { code: 'not_found', message: `paper ${paperId} does not exist` } })
      return
    }
    const version = store.latestVersion(paperId)
    if (version === undefined || typeof version.file_path !== 'string') {
      sendJson(res, 404, { ok: false, error: { code: 'not_found', message: 'paper has no stored PDF' } })
      return
    }
    const fileName = `${safeFileStem(paper.title, paperId)}.pdf`
    const info = await stat(version.file_path).catch(() => undefined)
    if (info === undefined) {
      sendJson(res, 404, { ok: false, error: { code: 'not_found', message: 'stored PDF file is missing' } })
      return
    }
    res.writeHead(200, {
      'content-type': 'application/pdf',
      'content-length': info.size,
      'cache-control': 'private, max-age=3600',
      'content-disposition': `inline; filename="${encodeURIComponent(fileName)}"`,
      'x-content-type-options': 'nosniff',
    })
    if (req.method === 'HEAD') {
      res.end()
      return
    }
    try {
      res.end(await readFile(version.file_path))
    } catch (error) {
      logger?.warn?.(`pappers-hall: PDF read failed: ${String(error?.message ?? error)}`)
      res.destroy()
    }
  }

  /** Handle one `/pappers-hall/*` asset path. */
  async function handleAsset(req, res, url) {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405, { allow: 'GET, HEAD' })
      res.end()
      return
    }
    const segments = url.pathname.split('/').filter((segment) => segment !== '')
    // ['pappers-hall', kind, id-or-id.ext, ...]
    if (segments[0] !== 'pappers-hall' || segments.length < 3) {
      sendJson(res, 404, { ok: false, error: { code: 'not_found', message: 'unknown asset path' } })
      return
    }
    const widthParam = url.searchParams.get('width')
    const width = widthParam === null ? null : clampInt(widthParam, 200, 2400, 1400)
    const kind = segments[1]
    if (kind === 'page') {
      if (segments.length !== 4) {
        sendJson(res, 404, { ok: false, error: { code: 'not_found', message: 'page asset requires /page/<paperId>/<page>.png' } })
        return
      }
      const paperId = segments[2]
      const pageMatch = PAGE_FILE_PATTERN.exec(segments[3])
      if (!PAPER_ID_PATTERN.test(paperId) || pageMatch === null) {
        sendJson(res, 400, { ok: false, error: { code: 'invalid', message: 'invalid page asset path' } })
        return
      }
      await servePage(req, res, paperId, Number(pageMatch[1]), width ?? 1400)
      return
    }
    if (kind === 'pdf-preview') {
      const match = /^([a-z0-9]{8,40})\.png$/.exec(segments[2] ?? '')
      if (segments.length !== 3 || match === null) {
        sendJson(res, 400, { ok: false, error: { code: 'invalid', message: 'invalid PDF preview path' } })
        return
      }
      await serveFile(req, res, path.join(layout.tmpDir, 'pdf-previews', match[1] + '.png'), 'image/png')
      return
    }
    if (kind === 'note-asset') {
      const match = /^([a-f0-9]{16,40})\.(png|jpg|webp|gif)$/i.exec(segments[2] ?? '')
      if (segments.length !== 3 || match === null) {
        sendJson(res, 400, { ok: false, error: { code: 'invalid', message: 'invalid note asset path' } })
        return
      }
      const mediaType = match[2].toLowerCase() === 'jpg' ? 'image/jpeg' : 'image/' + match[2].toLowerCase()
      await serveFile(req, res, path.join(layout.noteAssetsDir, match[1] + '.' + match[2].toLowerCase()), mediaType)
      return
    }
    if (kind === 'figure') {
      const match = /^(fg-[a-f0-9]{12})(?:\.png)?$/.exec(segments[2] ?? '')
      if (segments.length !== 3 || match === null) {
        sendJson(res, 400, { ok: false, error: { code: 'invalid', message: 'invalid figure asset path' } })
        return
      }
      await serveFigure(req, res, match[1], width)
      return
    }
    if (kind === 'thumb') {
      const match = /^(ph-[a-f0-9]{12})(?:\.png)?$/.exec(segments[2] ?? '')
      if (segments.length !== 3 || match === null) {
        sendJson(res, 400, { ok: false, error: { code: 'invalid', message: 'invalid thumbnail asset path' } })
        return
      }
      await serveThumb(req, res, match[1])
      return
    }
    if (kind === 'pdf') {
      if (segments.length !== 3 || !PAPER_ID_PATTERN.test(segments[2] ?? '')) {
        sendJson(res, 400, { ok: false, error: { code: 'invalid', message: 'invalid PDF asset path' } })
        return
      }
      await servePdf(req, res, segments[2])
      return
    }
    sendJson(res, 404, { ok: false, error: { code: 'not_found', message: `unknown asset kind ${kind}` } })
  }

  /** Handle one `/pappers-hall/api` JSON call. */
  async function handleApi(req, res) {
    if (req.method !== 'POST') {
      res.writeHead(405, { allow: 'POST' })
      res.end()
      return
    }
    let raw
    try {
      raw = await readBody(req, bodyLimitBytes)
    } catch (error) {
      sendJson(res, error?.code === 'too_large' ? 413 : 400, { ok: false, error: { code: 'invalid', message: String(error?.message ?? error) } })
      return
    }
    let request
    try {
      request = raw.trim() === '' ? {} : JSON.parse(raw)
    } catch {
      sendJson(res, 400, { ok: false, error: { code: 'invalid', message: 'request body is not valid JSON' } })
      return
    }
    if (request === null || typeof request !== 'object' || typeof request.method !== 'string') {
      sendJson(res, 400, { ok: false, error: { code: 'invalid', message: 'request must be {method, params}' } })
      return
    }
    try {
      const data = await api.call(request.method, request.params ?? {})
      sendJson(res, 200, { ok: true, data })
    } catch (error) {
      const payload = toErrorPayload(error)
      sendJson(res, httpStatusForCode(payload.code), { ok: false, error: payload })
    }
  }

  /**
   * The registered prefix handler.
   * @param {import('node:http').IncomingMessage} req request.
   * @param {import('node:http').ServerResponse} res response.
   * @returns {Promise<void>} settles after the response finishes.
   */
  return async function pappersHallRoute(req, res) {
    try {
      const url = new URL(req.url ?? '/', 'http://pappers-hall.local')
      if (url.pathname === '/pappers-hall/api' || url.pathname === '/pappers-hall/api/') {
        await handleApi(req, res)
        return
      }
      if (url.pathname === '/pappers-hall/' || url.pathname === '/pappers-hall') {
        sendJson(res, 200, { ok: true, data: { plugin: 'dsh-pappers-hall', api: '/pappers-hall/api' } })
        return
      }
      if (url.pathname === '/pappers-hall/backup/export' || url.pathname === '/pappers-hall/backup/export/') {
        if (req.method !== 'GET' && req.method !== 'HEAD') {
          res.writeHead(405, { allow: 'GET, HEAD' })
          res.end()
          return
        }
        if (!backup || typeof backup.export !== 'function') {
          sendJson(res, 503, { ok: false, error: { code: 'unavailable', message: 'backup service is not available' } })
          return
        }
        const result = await backup.export()
        res.writeHead(200, {
          'content-type': 'application/zip',
          'content-length': result.buffer.length,
          'content-disposition': 'attachment; filename="' + result.filename.replace(/[^A-Za-z0-9._-]/g, '_') + '"',
          'cache-control': 'no-store',
          'x-content-type-options': 'nosniff',
        })
        if (req.method === 'HEAD') res.end()
        else res.end(result.buffer)
        return
      }
      if (url.pathname === '/pappers-hall/backup/import' || url.pathname === '/pappers-hall/backup/import/') {
        if (req.method !== 'POST') {
          res.writeHead(405, { allow: 'POST' })
          res.end()
          return
        }
        if (!backup || typeof backup.import !== 'function') {
          sendJson(res, 503, { ok: false, error: { code: 'unavailable', message: 'backup service is not available' } })
          return
        }
        let raw
        try {
          raw = await readBody(req, Math.max(bodyLimitBytes, 512 * 1024 * 1024))
        } catch (error) {
          sendJson(res, error?.code === 'too_large' ? 413 : 400, { ok: false, error: { code: 'invalid', message: String(error?.message ?? error) } })
          return
        }
        try {
          const result = await backup.import(raw)
          sendJson(res, 200, { ok: true, data: result })
        } catch (error) {
          sendJson(res, 400, { ok: false, error: { code: 'invalid', message: String(error?.message ?? error) } })
        }
        return
      }
      if (url.pathname.startsWith('/pappers-hall/')) {
        await handleAsset(req, res, url)
        return
      }
      sendJson(res, 404, { ok: false, error: { code: 'not_found', message: 'not found' } })
    } catch (error) {
      logger?.warn?.(`pappers-hall: route failure: ${String(error?.stack ?? error)}`)
      if (!res.headersSent) sendJson(res, 500, { ok: false, error: { code: 'internal', message: 'internal error' } })
      else res.destroy()
    }
  }
}

/** Parse one JSON object column without throwing. */
function parseJsonObject(value) {
  if (typeof value !== 'string' || value === '') return undefined
  try {
    const parsed = JSON.parse(value)
    return parsed !== null && typeof parsed === 'object' ? parsed : undefined
  } catch {
    return undefined
  }
}
