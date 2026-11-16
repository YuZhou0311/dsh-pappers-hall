/**
 * Optional local OCR (PP-OCRv6) and layout analysis (PP-DocLayout-S).
 *
 * Both run inside the single Python worker described in `host/py.js`; the Host
 * only decides *when* to pay for them. OCR stays opt-in: the user installs the
 * Python component from the settings panel, enables the feature, then runs
 * `ocr.index`. Pages without a text layer get rendered, recognised and stored in
 * `paper_pages.ocr_text`, which feeds the page search channels and the reader
 * fallback. Nothing is uploaded and the models are downloaded once, at install
 * time.
 *
 * @module pappers-hall/host/ocr
 */
import path from 'node:path'
import { homedir } from 'node:os'
import { readSetting, writeSetting } from './db.js'
import { nowIso } from './paths.js'

/** Engine identifier exposed by the settings panel. */
export const OCR_ENGINE = 'PP-OCRv6'

/** Default OCR install root (kept in sync with `host/py.js` defaults). */
function defaultPythonDir() {
  return path.join(homedir(), '.dsh', 'pappers-hall', 'python')
}

/**
 * Create the OCR service.
 * @param {object} options dependencies.
 * @param {import('node:sqlite').DatabaseSync} options.db database.
 * @param {object} options.python Python bridge (`host/py.js`).
 * @param {object} [options.docLayout] layout region service.
 * @param {object} options.search search service (page FTS refresh).
 * @param {object} options.queue persistent job queue.
 * @param {object} options.layout owned path table.
 * @param {object} options.settings settings service.
 * @param {object} [options.config] resolved config.
 * @param {object} [options.logger] logger.
 * @returns {object} OCR service.
 */
export function createOcr({ db, python, docLayout, search, queue, layout, settings, config = {}, logger }) {
  const pythonDir = typeof config.pythonDir === 'string' && config.pythonDir !== '' ? config.pythonDir : defaultPythonDir()
  const renderWidth = Math.max(600, Math.min(2400, Number(config.ocrRenderWidth) || 1600))
  let lastError = null

  /** Whether the Python component exposes OCR. */
  function installed() {
    return Boolean(python && python.installed() && python.capabilities.ocr)
  }

  /** Feature switch (settings panel). */
  function enabled() {
    return settings !== null && settings !== undefined && typeof settings.features === 'function' ? settings.features().ocr === true : false
  }

  /** Real disk usage of the Python component and its models (cached 10 minutes). */
  let sizeCache = null
  function sizeBytes() {
    if (sizeCache !== null && Date.now() - sizeCache.at < 600_000) return sizeCache.bytes
    const bytes = (typeof python?.venvBytes === 'function' ? python.venvBytes() : 0)
    sizeCache = { at: Date.now(), bytes }
    return bytes
  }

  /** Scanned / indexed page counts for the settings card. */
  function pageCounts() {
    let scanPages = 0
    let indexedPages = 0
    try {
      scanPages = Number(
        db
          .prepare(
            `SELECT COUNT(*) AS count FROM paper_pages pp JOIN papers p ON p.id = pp.paper_id
             WHERE p.state = 'active' AND COALESCE(TRIM(pp.text), '') = ''`,
          )
          .get()?.count ?? 0,
      )
      indexedPages = Number(
        db
          .prepare(
            `SELECT COUNT(*) AS count FROM paper_pages pp JOIN papers p ON p.id = pp.paper_id
             WHERE p.state = 'active' AND COALESCE(TRIM(pp.ocr_text), '') <> ''`,
          )
          .get()?.count ?? 0,
      )
    } catch {}
    return { scanPages, indexedPages }
  }

  /** `ocr.status` / settings component facts. */
  function status() {
    const isInstalled = installed()
    const counts = pageCounts()
    let reason = null
    if (!isInstalled) reason = 'OCR 未安装（可选）：在设置中安装本地 Python 组件后，可对扫描版 PDF 建立文字索引'
    else if (lastError !== null) reason = lastError
    else if (!enabled()) reason = 'OCR 已安装但未启用：在设置中开启 OCR 开关后才会处理页面'
    return {
      available: isInstalled && lastError === null,
      installed: isInstalled,
      enabled: enabled(),
      engine: OCR_ENGINE,
      version: readSetting(db, 'models.ocr.version') ?? python?.versions?.rapidocr ?? null,
      sizeBytes: isInstalled ? sizeBytes() : 0,
      pythonPath: python?.pythonPath ?? null,
      layoutModel: Boolean(docLayout && typeof docLayout.available === 'function' && docLayout.available()),
      scanPages: counts.scanPages,
      indexedPages: counts.indexedPages,
      lastError,
      reason,
    }
  }

  /** Stored OCR text of one page (reader/search fallback). */
  function ocrText(paperId, page) {
    try {
      const row = db.prepare('SELECT ocr_text FROM paper_pages WHERE paper_id = ? AND page = ?').get(paperId, page)
      return typeof row?.ocr_text === 'string' && row.ocr_text.trim() !== '' ? row.ocr_text : null
    } catch {
      return null
    }
  }

  /** Latest stored PDF path for one paper. */
  function pdfPathOf(paperId) {
    const version = db.prepare('SELECT file_path FROM paper_versions WHERE paper_id = ? ORDER BY created_at DESC LIMIT 1').get(paperId)
    return version !== undefined && typeof version.file_path === 'string' ? version.file_path : null
  }

  /** Page size in PDF points from the stored layout row. */
  function pageSizeOf(paperId, page) {
    const row = db.prepare('SELECT width, height, layout_json FROM paper_pages WHERE paper_id = ? AND page = ?').get(paperId, page)
    let width = Number(row?.width ?? 0)
    let height = Number(row?.height ?? 0)
    if ((!width || !height) && typeof row?.layout_json === 'string' && row.layout_json !== '') {
      try {
        const parsed = JSON.parse(row.layout_json)
        width = Number(parsed?.width ?? width)
        height = Number(parsed?.height ?? height)
      } catch {}
    }
    return { width: width > 0 ? width : null, height: height > 0 ? height : null }
  }

  /**
   * OCR one page of a stored PDF.
   *
   * Runs inside the Python worker: the page is rendered there, recognised with
   * PP-OCRv6, and (when the layout model is installed) labelled with
   * PP-DocLayout-S regions in the same pass.
   * @param {string} filePath absolute PDF path.
   * @param {number} page 1-based page.
   * @param {{width:number|null,height:number|null}} [pageSize] PDF-point page size.
   * @returns {Promise<{text:string, blocks:object[], regions:object[], width:number, height:number}>} OCR result.
   */
  async function ocrPage(filePath, page, pageSize = { width: null, height: null }) {
    const pageWidthPt = Number(pageSize.width) > 0 ? Number(pageSize.width) : 612
    const pageHeightPt = Number(pageSize.height) > 0 ? Number(pageSize.height) : 792
    const dpi = Math.max(150, Math.min(300, Math.round((renderWidth * 72) / pageWidthPt)))
    const result = await python.invoke('ocrPage', { path: filePath, page, dpi, layout: Boolean(docLayout?.available?.()) }, { timeoutMs: 300_000 })
    const scale = renderWidth / pageWidthPt
    const blocks = (Array.isArray(result.lines) ? result.lines : []).map((line) => ({
      text: line.text,
      score: line.score,
      box: Array.isArray(line.box) ? [line.box[0] * scale, line.box[1] * scale, line.box[2] * scale, line.box[3] * scale] : null,
    }))
    return {
      text: String(result.text ?? ''),
      blocks,
      regions: Array.isArray(result.regions) ? result.regions : [],
      width: renderWidth,
      height: Math.round((renderWidth * pageHeightPt) / pageWidthPt),
      pageWidth: pageWidthPt,
      pageHeight: pageHeightPt,
    }
  }

  /** Pages that still need OCR for the requested papers. */
  function pendingPages(ids, force) {
    const filters = ["p.state = 'active'"]
    const params = []
    if (Array.isArray(ids) && ids.length > 0) {
      filters.push(`p.id IN (${ids.map(() => '?').join(',')})`)
      params.push(...ids)
    }
    filters.push("COALESCE(TRIM(pp.text), '') = ''")
    if (force !== true) filters.push("COALESCE(TRIM(pp.ocr_text), '') = ''")
    return db
      .prepare(
        `SELECT pp.paper_id, pp.page FROM paper_pages pp JOIN papers p ON p.id = pp.paper_id
         WHERE ${filters.join(' AND ')} ORDER BY pp.paper_id, pp.page`,
      )
      .all(...params)
  }

  /** In-memory OCR geometry cache for region queries (bounded). */
  const blockCache = new Map()
  const BLOCK_CACHE_MAX = 24

  /**
   * OCR one page and return text + positioned blocks (for region-level repair).
   * @param {string} paperId paper id.
   * @param {number} page 1-based page.
   * @returns {Promise<{text:string, blocks:object[], regions:object[], width:number, height:number}|null>} OCR geometry.
   */
  async function ensurePageBlocks(paperId, page) {
    const id = String(paperId ?? '')
    const pageNumber = Number(page)
    if (id === '' || !Number.isInteger(pageNumber) || pageNumber < 1) return null
    const key = `${id}:${pageNumber}`
    if (blockCache.has(key)) return blockCache.get(key)
    const facts = status()
    if (facts.available !== true || facts.installed !== true || facts.enabled !== true) return null
    try {
      const filePath = pdfPathOf(id)
      if (filePath === null) return null
      const entry = await ocrPage(filePath, pageNumber, pageSizeOf(id, pageNumber))
      if (entry.text.trim() !== '') {
        db.prepare('UPDATE paper_pages SET ocr_text = ?, ocr_updated_at = ? WHERE paper_id = ? AND page = ?').run(entry.text, nowIso(), id, pageNumber)
      }
      if (blockCache.size >= BLOCK_CACHE_MAX) {
        const oldest = blockCache.keys().next().value
        if (oldest !== undefined) blockCache.delete(oldest)
      }
      blockCache.set(key, entry)
      return entry
    } catch (error) {
      lastError = String(error?.message ?? error)
      return null
    }
  }

  /** In-flight page OCR promises, so concurrent readers reuse one render/OCR. */
  const pageLocks = new Map()

  /**
   * Ensure OCR text exists for one page (synchronous read helper for AI/reader).
   * @param {string} paperId paper id.
   * @param {number} page 1-based page number.
   * @returns {Promise<string|null>} OCR text or null.
   */
  async function ensurePageText(paperId, page) {
    const id = String(paperId ?? '')
    const pageNumber = Number(page)
    if (id === '' || !Number.isInteger(pageNumber) || pageNumber < 1) return null
    const cached = ocrText(id, pageNumber)
    if (cached !== null) return cached
    const facts = status()
    if (facts.available !== true || facts.installed !== true || facts.enabled !== true) return null
    const key = `${id}:${pageNumber}`
    if (pageLocks.has(key)) return pageLocks.get(key)
    const task = (async () => {
      try {
        const filePath = pdfPathOf(id)
        if (filePath === null) return null
        const result = await ocrPage(filePath, pageNumber, pageSizeOf(id, pageNumber))
        const text = String(result.text ?? '').trim()
        if (text === '') return null
        db.prepare('UPDATE paper_pages SET ocr_text = ?, ocr_updated_at = ? WHERE paper_id = ? AND page = ?').run(text, nowIso(), id, pageNumber)
        try { search?.indexPages?.(id) } catch {}
        return text
      } catch (error) {
        lastError = String(error?.message ?? error)
        return null
      } finally {
        pageLocks.delete(key)
      }
    })()
    pageLocks.set(key, task)
    return task
  }

  /** OCR index job handler. */
  async function processOcrJob(job, api) {
    const pages = pendingPages(job.payload?.ids, job.payload?.force === true)
    const total = pages.length
    api.updateProgress(job, 0, total, 'pages')
    if (total === 0) return { pages: 0, indexed: 0 }
    let done = 0
    let indexed = 0
    const failed = []
    const updatedPapers = new Set()
    for (const item of pages) {
      api.throwIfCancelled(job)
      const filePath = pdfPathOf(item.paper_id)
      if (filePath === null) {
        failed.push({ paperId: item.paper_id, page: item.page, error: 'paper has no stored PDF' })
        continue
      }
      try {
        const result = await ocrPage(filePath, Number(item.page), pageSizeOf(item.paper_id, item.page))
        if (result.text.trim() === '') {
          failed.push({ paperId: item.paper_id, page: item.page, error: 'OCR produced no text' })
        } else {
          db.prepare('UPDATE paper_pages SET ocr_text = ?, ocr_updated_at = ? WHERE paper_id = ? AND page = ?').run(result.text, nowIso(), item.paper_id, item.page)
          updatedPapers.add(item.paper_id)
          indexed += 1
        }
      } catch (error) {
        failed.push({ paperId: item.paper_id, page: item.page, error: String(error?.message ?? error) })
      }
      done += 1
      api.updateProgress(job, done, total, 'pages')
      api.heartbeat(job)
    }
    for (const paperId of updatedPapers) search?.indexPages?.(paperId)
    writeSetting(db, 'models.ocr.lastIndexAt', nowIso())
    writeSetting(db, 'models.ocr.lastIndexedPages', indexed)
    if (indexed > 0) lastError = null
    return { pages: total, indexed, failed: failed.slice(0, 20) }
  }

  /** Register the persistent OCR job handler. */
  function registerHandlers(targetQueue) {
    if (targetQueue === undefined || targetQueue === null || typeof targetQueue.register !== 'function') return
    targetQueue.register('ocr.index', (job, api) => processOcrJob(job, api))
  }

  /** `ocr.index` — enqueue OCR for scanned pages (only when installed+enabled). */
  function index(params = {}) {
    if (!installed()) return { status: 'unavailable', reason: 'OCR 未安装（可选）：请在设置中安装本地组件', job: null }
    if (!enabled()) return { status: 'unavailable', reason: 'OCR 未启用：请在设置中开启 OCR 开关', job: null }
    if (queue === undefined || queue === null) return { status: 'unavailable', reason: 'background job queue is not available', job: null }
    const ids = Array.isArray(params.ids) ? params.ids.map(String).filter((id) => id !== '') : undefined
    const force = params.force === true
    const pages = pendingPages(ids, force)
    const operationId = typeof params.operationId === 'string' && params.operationId.trim() !== '' ? params.operationId.trim() : ''
    const job = queue.enqueue({
      kind: 'ocr.index',
      payload: { ids, force },
      ...(operationId === '' ? {} : { idempotencyKey: `ocr.index:${operationId}` }),
      total: pages.length,
      unit: 'pages',
      maxAttempts: 2,
    })
    return { status: 'queued', job, pages: pages.length }
  }

  /** Release worker resources (the bridge owns the process). */
  function close() {
    try { python?.stop?.() } catch {}
  }

  return {
    status,
    index,
    registerHandlers,
    ocrPage,
    ocrText,
    ensurePageText,
    ensurePageBlocks,
    pendingPages,
    processOcrJob,
    installed,
    enabled,
    close,
    paths: { pythonDir, pythonPath: python?.pythonPath ?? null },
    facts() {
      const current = status()
      return {
        available: current.available,
        installed: current.installed,
        enabled: current.enabled,
        engine: current.engine,
        scanPages: current.scanPages,
        indexedPages: current.indexedPages,
        reason: current.reason,
      }
    },
  }
}
