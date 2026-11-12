/**
 * Optional local OCR pipeline (v0.11).
 *
 * OCR is opt-in: the user installs the `rapidocr-onnxruntime` venv from the
 * settings panel, enables the `ocr` feature, then runs `ocr.index`. The Host
 * renders pages without a native text layer to PNG and asks a local Python worker
 * (stdio JSON-lines) for text; results are stored in `paper_pages.ocr_text`, fed
 * back into the page FTS/LIKE channels and used by `reader.pageText` as a fallback.
 * Nothing is uploaded and no model is downloaded until the user asks for it.
 *
 * @module pappers-hall/host/ocr
 */
import { spawn } from 'node:child_process'
import { existsSync, readdirSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import path from 'node:path'
import readline from 'node:readline'
import { fileURLToPath } from 'node:url'
import { readSetting, writeSetting } from './db.js'
import { nowIso } from './paths.js'

/** Engine identifier exposed by the settings panel. */
export const OCR_ENGINE = 'rapidocr-onnxruntime'
/** Worker script shipped next to this module. */
const WORKER_SCRIPT = fileURLToPath(new URL('./ocr_worker.py', import.meta.url))

/** Default OCR install root. */
function defaultOcrDir() {
  return path.join(homedir(), '.dsh', 'pappers-hall', 'ocr')
}

/**
 * Create the OCR service.
 * @param {object} options dependencies.
 * @param {import('node:sqlite').DatabaseSync} options.db database.
 * @param {object} options.pdf PDF tool service (page rendering).
 * @param {object} options.search search service (page FTS refresh).
 * @param {object} options.queue persistent job queue.
 * @param {object} options.layout owned path table.
 * @param {object} options.settings settings service.
 * @param {object} [options.config] resolved config.
 * @param {object} [options.logger] logger.
 * @returns {object} OCR service.
 */
export function createOcr({ db, pdf, search, queue, layout, settings, config = {}, logger }) {
  const ocrDir = typeof config.ocrDir === 'string' && config.ocrDir !== '' ? config.ocrDir : defaultOcrDir()
  const pythonPath = typeof config.ocrPython === 'string' && config.ocrPython !== '' ? config.ocrPython : path.join(ocrDir, 'venv', 'bin', 'python')
  const renderWidth = Math.max(600, Math.min(2400, Number(config.ocrRenderWidth) || 1600))

  let child = null
  let reader = null
  let ready = false
  let starting = null
  let lastError = null
  let lastLoadMs = null
  let crashCount = 0
  const pending = new Map()
  let nextId = 1
  let requestChain = Promise.resolve()
  let sizeCache = null

  /** Whether the OCR component is installed (venv python + worker present). */
  function installed() {
    return existsSync(pythonPath) && existsSync(WORKER_SCRIPT)
  }

  /** Feature switch (settings panel). */
  function enabled() {
    return settings !== null && settings !== undefined && typeof settings.features === 'function' ? settings.features().ocr === true : false
  }

  /** Real disk usage of the OCR root (cached 10 minutes). */
  function sizeBytes() {
    if (sizeCache !== null && Date.now() - sizeCache.at < 600_000) return sizeCache.bytes
    let bytes = 0
    const walk = (dir, depth) => {
      if (depth > 6) return
      let entries
      try {
        entries = readdirSync(dir, { withFileTypes: true })
      } catch {
        return
      }
      for (const entry of entries) {
        const target = path.join(dir, entry.name)
        try {
          if (entry.isDirectory()) walk(target, depth + 1)
          else if (entry.isFile()) bytes += statSync(target).size
        } catch {}
      }
    }
    walk(ocrDir, 0)
    sizeCache = { at: Date.now(), bytes }
    return bytes
  }

  /** Count pages without a native text layer / with OCR text. */
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

  /** `ocr.status` / settings model card facts. */
  function status() {
    const isInstalled = installed()
    const counts = pageCounts()
    let reason = null
    if (!isInstalled) reason = 'OCR 未安装（可选）：在设置中下载安装 OCR 组件后，可对扫描版 PDF 建立文字索引'
    else if (lastError !== null) reason = lastError
    else if (!enabled()) reason = 'OCR 已安装但未启用：在设置中开启 OCR 开关后才会处理页面'
    return {
      available: isInstalled && lastError === null,
      installed: isInstalled,
      enabled: enabled(),
      engine: OCR_ENGINE,
      version: readSetting(db, 'models.ocr.version') ?? null,
      sizeBytes: isInstalled ? sizeBytes() : 0,
      pythonPath,
      scanPages: counts.scanPages,
      indexedPages: counts.indexedPages,
      lastError,
      reason,
    }
  }

  /** Spawn the OCR worker and wait for its ready line. */
  function spawnWorker() {
    if (!installed()) return Promise.reject(new Error('OCR component is not installed; install it from the settings panel'))
    const started = Date.now()
    const proc = spawn(pythonPath, [WORKER_SCRIPT], { stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env } })
    child = proc
    ready = false
    reader = readline.createInterface({ input: proc.stdout })
    return new Promise((resolve, reject) => {
      let settled = false
      const finish = (error, facts) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        if (error !== null) {
          lastError = error.message
          ready = false
          try {
            proc.kill('SIGKILL')
          } catch {}
          reject(error)
          return
        }
        ready = true
        lastError = null
        lastLoadMs = Date.now() - started
        logger?.debug?.(`pappers-hall: OCR worker ready in ${lastLoadMs}ms`)
        resolve(facts)
      }
      const timer = setTimeout(() => finish(new Error('OCR worker did not become ready within 120s')), 120_000)
      reader.on('line', (line) => {
        let message
        try {
          message = JSON.parse(line)
        } catch {
          return
        }
        if (message.op === 'ready') {
          if (message.ok === false) finish(new Error(`OCR worker failed to start: ${message.error ?? 'unknown error'}`))
          else finish(null, message)
          return
        }
        const entry = pending.get(message.id)
        if (entry !== undefined) {
          pending.delete(message.id)
          clearTimeout(entry.timer)
          if (message.ok === true) entry.resolve(message)
          else entry.reject(new Error(String(message.error ?? 'OCR worker error')))
        }
      })
      proc.on('error', (error) => finish(error instanceof Error ? error : new Error(String(error))))
      proc.on('exit', (code, signal) => {
        const wasReady = ready
        ready = false
        child = null
        reader?.close?.()
        reader = null
        for (const [, entry] of pending) {
          clearTimeout(entry.timer)
          entry.reject(new Error(`OCR worker exited (${signal ?? code})`))
        }
        pending.clear()
        if (wasReady || settled === false) {
          lastError = `OCR worker exited (${signal ?? code})`
          crashCount += 1
        }
        if (settled === false) finish(new Error(lastError))
      })
      proc.stderr.on('data', (chunk) => {
        const text = String(chunk).trim()
        if (text !== '') logger?.debug?.(`pappers-hall: OCR worker stderr: ${text.slice(0, 400)}`)
      })
    })
  }

  /** Ensure the worker is running (lazy, restart budget 2). */
  async function ensureWorker() {
    if (!installed()) throw new Error('OCR component is not installed')
    if (ready && child !== null) return true
    if (crashCount > 2) throw new Error(lastError ?? 'OCR worker crashed repeatedly')
    if (starting !== null) return starting
    starting = spawnWorker().finally(() => {
      starting = null
    })
    return starting
  }

  /** Run one OCR request on an image path. */
  function request(payload) {
    const run = async () => {
      await ensureWorker()
      if (child === null) throw new Error(lastError ?? 'OCR worker is not running')
      const id = nextId++
      return await new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          pending.delete(id)
          reject(new Error('OCR request timed out after 120s'))
        }, 120_000)
        pending.set(id, { resolve, reject, timer })
        try {
          child.stdin.write(`${JSON.stringify({ id, ...payload })}\n`)
        } catch (error) {
          pending.delete(id)
          clearTimeout(timer)
          reject(error instanceof Error ? error : new Error(String(error)))
        }
      })
    }
    const queued = requestChain.then(run, run)
    requestChain = queued.catch(() => {})
    return queued
  }

  /** OCR one image file. */
  async function ocrImage(imagePath) {
    const started = Date.now()
    const response = await request({ op: 'ocr', imagePath })
    return { text: typeof response.text === 'string' ? response.text : '', blocks: Array.isArray(response.blocks) ? response.blocks : [], latencyMs: Date.now() - started }
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
   *
   * Blocks keep the worker's pixel boxes plus the rendered image size, so callers
   * can map a normalized page selection rectangle onto OCR text (figure labels,
   * scanned pages) and repair quotes that the PDF text layer returned as glyph
   * codes. Cached in memory only; the plain text still lands in `ocr_text`.
   * @param {string} paperId paper id.
   * @param {number} page 1-based page.
   * @returns {Promise<{text:string, blocks:object[], width:number, height:number}|null>} OCR geometry.
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
      const version = db.prepare('SELECT file_path FROM paper_versions WHERE paper_id = ? ORDER BY created_at DESC LIMIT 1').get(id)
      if (version === undefined || typeof version.file_path !== 'string') return null
      const dims = db.prepare('SELECT width, height, layout_json FROM paper_pages WHERE paper_id = ? AND page = ?').get(id, pageNumber)
      let pageWidth = Number(dims?.width ?? 0)
      let pageHeight = Number(dims?.height ?? 0)
      if ((!pageWidth || !pageHeight) && typeof dims?.layout_json === 'string' && dims.layout_json !== '') {
        try {
          const layout = JSON.parse(dims.layout_json)
          pageWidth = Number(layout?.width ?? pageWidth)
          pageHeight = Number(layout?.height ?? pageHeight)
        } catch (error) { /* keep zeros */ }
      }
      const tmpRoot = path.join(layout.tmpDir ?? path.join(ocrDir, 'tmp'), `ocr-blocks-${process.pid}-${Date.now()}`)
      const { mkdir, rm } = await import('node:fs/promises')
      await mkdir(tmpRoot, { recursive: true })
      const imagePath = path.join(tmpRoot, `${id}-${pageNumber}.png`)
      try {
        await pdf.renderPage({ filePath: version.file_path, page: pageNumber, width: renderWidth, outputPath: imagePath })
        const result = await ocrImage(imagePath)
        const text = String(result.text ?? '')
        if (text.trim() !== '') {
          db.prepare('UPDATE paper_pages SET ocr_text = ?, ocr_updated_at = ? WHERE paper_id = ? AND page = ?').run(text, nowIso(), id, pageNumber)
        }
        const aspect = pageWidth > 0 && pageHeight > 0 ? pageHeight / pageWidth : 1.294
        const entry = {
          text,
          blocks: Array.isArray(result.blocks) ? result.blocks : [],
          width: renderWidth,
          height: Math.round(renderWidth * aspect),
          pageWidth: pageWidth > 0 ? pageWidth : null,
          pageHeight: pageHeight > 0 ? pageHeight : null,
        }
        if (blockCache.size >= BLOCK_CACHE_MAX) {
          const oldest = blockCache.keys().next().value
          if (oldest !== undefined) blockCache.delete(oldest)
        }
        blockCache.set(key, entry)
        return entry
      } finally {
        await rm(tmpRoot, { recursive: true, force: true }).catch(() => {})
      }
    } catch (error) {
      lastError = String(error?.message ?? error)
      return null
    }
  }

  /** In-flight page OCR promises, so concurrent readers reuse one render/OCR. */
  const pageLocks = new Map()

  /**
   * Ensure OCR text exists for one page (synchronous read helper for AI/reader).
   *
   * Only used when the stored PDF text layer is judged unreliable; returns null
   * when OCR is not installed/enabled or rendering fails. The result is cached in
   * `paper_pages.ocr_text` and the page search index is refreshed.
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
        const version = db.prepare('SELECT file_path FROM paper_versions WHERE paper_id = ? ORDER BY created_at DESC LIMIT 1').get(id)
        if (version === undefined || typeof version.file_path !== 'string') return null
        const tmpRoot = path.join(layout.tmpDir ?? path.join(ocrDir, 'tmp'), `ocr-read-${process.pid}-${Date.now()}`)
        const { mkdir, rm } = await import('node:fs/promises')
        await mkdir(tmpRoot, { recursive: true })
        const imagePath = path.join(tmpRoot, `${id}-${pageNumber}.png`)
        try {
          await pdf.renderPage({ filePath: version.file_path, page: pageNumber, width: renderWidth, outputPath: imagePath })
          const result = await ocrImage(imagePath)
          const text = String(result.text ?? '').trim()
          if (text === '') return null
          db.prepare('UPDATE paper_pages SET ocr_text = ?, ocr_updated_at = ? WHERE paper_id = ? AND page = ?').run(text, nowIso(), id, pageNumber)
          try { search?.indexPages?.(id) } catch (error) { /* optional */ }
          return text
        } finally {
          await rm(tmpRoot, { recursive: true, force: true }).catch(() => {})
        }
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
    const tmpRoot = path.join(layout.tmpDir ?? path.join(ocrDir, 'tmp'), `ocr-${process.pid}-${Date.now()}`)
    const { mkdir, rm } = await import('node:fs/promises')
    await mkdir(tmpRoot, { recursive: true })
    try {
      for (const item of pages) {
        api.throwIfCancelled(job)
        const version = db.prepare('SELECT file_path FROM paper_versions WHERE paper_id = ? ORDER BY created_at DESC LIMIT 1').get(item.paper_id)
        if (version === undefined || typeof version.file_path !== 'string') {
          failed.push({ paperId: item.paper_id, page: item.page, error: 'paper has no stored PDF' })
          continue
        }
        const imagePath = path.join(tmpRoot, `${item.paper_id}-${item.page}.png`)
        try {
          await pdf.renderPage({ filePath: version.file_path, page: Number(item.page), width: renderWidth, outputPath: imagePath })
          const result = await ocrImage(imagePath)
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
    } finally {
      await rm(tmpRoot, { recursive: true, force: true }).catch(() => {})
    }
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
    const isInstalled = installed()
    if (!isInstalled) return { status: 'unavailable', reason: 'OCR 未安装（可选）：请在设置中安装 OCR 组件', job: null }
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

  /** Close the worker. */
  function close() {
    const proc = child
    child = null
    ready = false
    for (const [, entry] of pending) {
      clearTimeout(entry.timer)
      entry.reject(new Error('OCR service closed'))
    }
    pending.clear()
    if (proc !== null) {
      try {
        proc.stdin.write(`${JSON.stringify({ op: 'shutdown' })}\n`)
        proc.stdin.end()
      } catch {}
      const timer = setTimeout(() => {
        try {
          proc.kill('SIGKILL')
        } catch {}
      }, 2000)
      timer.unref?.()
    }
    reader?.close?.()
    reader = null
  }

  return {
    status,
    index,
    registerHandlers,
    ocrImage,
    ocrText,
    ensurePageText,
    ensurePageBlocks,
    pendingPages,
    processOcrJob,
    installed,
    enabled,
    close,
    paths: { ocrDir, pythonPath, workerScript: WORKER_SCRIPT },
    facts() {
      const current = status()
      return { available: current.available, installed: current.installed, enabled: current.enabled, engine: current.engine, scanPages: current.scanPages, indexedPages: current.indexedPages, reason: current.reason }
    },
  }
}
