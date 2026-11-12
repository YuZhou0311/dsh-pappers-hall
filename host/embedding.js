/**
 * Real local embedding service for the Pappers-Hall Host half (v0.5-B).
 *
 * The heavy lifting runs in a small Python worker (`embedding_worker.py`) using a
 * multilingual sentence-transformers model on CPU. This module owns the worker
 * lifecycle (lazy spawn, ready/timeout handling, crash restarts), builds and
 * serves the `embeddings` table, and exposes the honest availability facts used by
 * `embedding.status`, `status.index.vectorInfo` and `search.query`'s vector
 * channel. Nothing here uploads text: embeddings are computed locally.
 *
 * @module pappers-hall/host/embedding
 */
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import path from 'node:path'
import readline from 'node:readline'
import { fileURLToPath } from 'node:url'
import { readSetting, writeSetting } from './db.js'
import { DomainError } from './store.js'
import { nowIso } from './paths.js'

/** Default multilingual model shipped with the setup script. */
export const DEFAULT_EMBEDDING_MODEL = 'sentence-transformers/paraphrase-multilingual-MiniLM-L12-v2'
/** Known output dimensionality (verified from the worker at runtime too). */
export const EMBEDDING_DIMS = 384
/** Index format version written to settings after a successful build. */
export const EMBEDDING_INDEX_VERSION = 'v1'
/** Folder containing the Python worker next to this module. */
const WORKER_SCRIPT = fileURLToPath(new URL('./embedding_worker.py', import.meta.url))

/** Chunk one page text into 600-800 char windows with ~80 char overlap. */
export function chunkPageText(text, { min = 600, max = 800, overlap = 80 } = {}) {
  const clean = String(text ?? '')
    .replace(/\s*\n\s*/g, '\n')
    .trim()
  if (clean === '') return []
  if (clean.length <= max) return [clean.replace(/\s+/g, ' ').trim()]
  const chunks = []
  let cursor = 0
  while (cursor < clean.length) {
    let end = Math.min(clean.length, cursor + max)
    if (end < clean.length) {
      // Prefer a sentence/whitespace boundary inside the window.
      const window = clean.slice(cursor, end)
      const boundary = Math.max(window.lastIndexOf('. '), window.lastIndexOf('。'), window.lastIndexOf('\n'), window.lastIndexOf(' '))
      if (boundary > min * 0.5) end = cursor + boundary + 1
    }
    const piece = clean
      .slice(cursor, end)
      .replace(/\s+/g, ' ')
      .trim()
    if (piece.length >= 30) chunks.push(piece)
    if (end >= clean.length) break
    const next = Math.max(cursor + 1, end - overlap)
    cursor = next <= cursor ? end : next
  }
  return chunks
}

/** Encode a numeric vector as a compact Float32 BLOB. */
export function encodeVector(vector) {
  const array = new Float32Array(vector)
  return Buffer.from(array.buffer, array.byteOffset, array.byteLength)
}

/** Decode a Float32 BLOB back to an array (copy so it survives buffer reuse). */
export function decodeVector(blob) {
  const buffer = Buffer.from(blob)
  return new Float32Array(buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength))
}

/** Dot product for normalized vectors (cosine similarity). */
export function cosine(left, right) {
  let sum = 0
  const length = Math.min(left.length, right.length)
  for (let index = 0; index < length; index += 1) sum += left[index] * right[index]
  return sum
}

/** Default venv python shipped by scripts/setup-embedding.sh. */
function defaultPythonPath() {
  return path.join(homedir(), '.dsh', 'pappers-hall', 'embedding', 'venv', 'bin', 'python')
}

/** Default model cache directory. */
function defaultCacheDir() {
  return path.join(homedir(), '.dsh', 'pappers-hall', 'models')
}

/** Flatten stored page layout blocks into indexable text (body/heading/caption). */
function pageIndexText(layoutJson) {
  let parsed
  try {
    parsed = typeof layoutJson === 'string' ? JSON.parse(layoutJson) : layoutJson
  } catch {
    return ''
  }
  if (parsed === null || typeof parsed !== 'object' || !Array.isArray(parsed.blocks)) return ''
  return parsed.blocks
    .filter((block) => block !== null && typeof block === 'object' && (block.role === 'body' || block.role === 'heading' || block.role === 'caption'))
    .map((block) => String(block.text ?? '').replace(/\s+/g, ' ').trim())
    .filter((text) => text !== '')
    .join('\n')
}

/**
 * Create the embedding service.
 * @param {object} options service options.
 * @param {import('node:sqlite').DatabaseSync} options.db open database.
 * @param {object} [options.config] resolved plugin config.
 * @param {object} [options.logger] logger.
 * @returns {object} embedding service.
 */
export function createEmbedding({ db, config = {}, logger, settings }) {
  const pythonPath = typeof config.embeddingPython === 'string' && config.embeddingPython !== '' ? config.embeddingPython : defaultPythonPath()
  const cacheDir = typeof config.embeddingCacheDir === 'string' && config.embeddingCacheDir !== '' ? config.embeddingCacheDir : defaultCacheDir()
  const modelName = typeof config.embeddingModel === 'string' && config.embeddingModel !== '' ? config.embeddingModel : DEFAULT_EMBEDDING_MODEL
  const disabled = config.embeddingDisabled === true
  const batchSize = Math.max(1, Math.min(64, Number(config.embeddingBatchSize) || 16))
  const readyTimeoutMs = Math.max(1000, Number(config.embeddingReadyTimeoutMs) || 25_000)
  const requestTimeoutMs = Math.max(1000, Number(config.embeddingRequestTimeoutMs) || 60_000)

  let child = null
  let reader = null
  let workerReady = false
  let workerStarting = null
  let workerModel = modelName
  let workerDims = EMBEDDING_DIMS
  let lastError = null
  let lastLoadMs = null
  let lastEmbedLatencyMs = null
  let crashCount = 0
  let configured = !disabled && existsSync(pythonPath) && existsSync(WORKER_SCRIPT)
  let configReason = disabled
    ? 'embedding component is disabled by configuration'
    : !existsSync(pythonPath)
      ? `embedding python not found at ${pythonPath}; run scripts/setup-embedding.sh`
      : !existsSync(WORKER_SCRIPT)
        ? `embedding worker missing at ${WORKER_SCRIPT}`
        : null

  /** id → pending request */
  const pending = new Map()
  let nextRequestId = 1
  let requestChain = Promise.resolve()
  let indexCache = null

  /** Read the current index version setting. */
  function indexVersion() {
    const value = readSetting(db, 'embedding.indexVersion')
    return typeof value === 'string' && value !== '' ? value : null
  }

  /** Expected index version for the configured model. */
  function expectedIndexVersion() {
    return `${EMBEDDING_INDEX_VERSION}:${workerModel}:${workerDims}`
  }

  /** Reject all pending requests (worker exit). */
  function rejectPending(reason) {
    for (const [, entry] of pending) {
      clearTimeout(entry.timer)
      entry.reject(new Error(reason))
    }
    pending.clear()
  }

  /** Spawn the Python worker and wait for its ready line. */
  function spawnWorker() {
    if (!configured) return Promise.reject(new Error(configReason ?? 'embedding component is not configured'))
    const env = { ...process.env, PAPPERS_EMBED_MODEL: modelName, PAPPERS_EMBED_CACHE: cacheDir }
    const started = Date.now()
    const proc = spawn(pythonPath, [WORKER_SCRIPT], { stdio: ['pipe', 'pipe', 'pipe'], env })
    child = proc
    workerReady = false
    reader = readline.createInterface({ input: proc.stdout })
    return new Promise((resolve, reject) => {
      let settled = false
      const finish = (error, facts) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        if (error !== null) {
          lastError = error.message
          workerReady = false
          try {
            proc.kill('SIGKILL')
          } catch {}
          reject(error)
          return
        }
        workerReady = true
        workerModel = facts.model ?? modelName
        workerDims = Number(facts.dims) || EMBEDDING_DIMS
        lastLoadMs = Date.now() - started
        lastError = null
        logger?.debug?.(`pappers-hall: embedding worker ready (${workerModel}, ${workerDims}d) in ${lastLoadMs}ms`)
        resolve(facts)
      }
      const timer = setTimeout(() => finish(new Error(`embedding worker did not become ready within ${readyTimeoutMs}ms`)), readyTimeoutMs)
      reader.on('line', (line) => {
        let message
        try {
          message = JSON.parse(line)
        } catch {
          return
        }
        if (message.op === 'ready') {
          finish(null, message)
          return
        }
        const entry = pending.get(message.id)
        if (entry !== undefined) {
          pending.delete(message.id)
          clearTimeout(entry.timer)
          if (message.ok === true) entry.resolve(message)
          else entry.reject(new Error(String(message.error ?? 'embedding worker error')))
        }
        if (message.ok === false && message.id === undefined) {
          finish(new Error(`embedding worker failed to start: ${message.error ?? 'unknown error'}`))
        }
      })
      proc.on('error', (error) => finish(error instanceof Error ? error : new Error(String(error))))
      proc.on('exit', (code, signal) => {
        const wasReady = workerReady
        workerReady = false
        child = null
        reader?.close?.()
        reader = null
        if (pending.size > 0) rejectPending(`embedding worker exited (${signal ?? code})`)
        if (wasReady || settled === false) {
          lastError = `embedding worker exited (${signal ?? code})`
          crashCount += 1
        }
        if (settled === false) finish(new Error(lastError))
      })
      proc.stderr.on('data', (chunk) => {
        const text = String(chunk).trim()
        if (text !== '') logger?.debug?.(`pappers-hall: embedding worker stderr: ${text.slice(0, 400)}`)
      })
    })
  }

  /** Ensure the worker is running (lazy, with at most two crash restarts per process). */
  async function ensureWorker() {
    if (!configured) throw new Error(configReason ?? 'embedding component is not configured')
    if (workerReady && child !== null) return { model: workerModel, dims: workerDims }
    if (crashCount > 2) {
      lastError = `embedding worker crashed ${crashCount} time(s); restart budget exhausted`
      throw new Error(lastError)
    }
    if (workerStarting !== null) return workerStarting
    workerStarting = spawnWorker().finally(() => {
      workerStarting = null
    })
    return workerStarting
  }

  /** Send one JSON-lines request and await its response. */
  function request(payload) {
    const run = async () => {
      await ensureWorker()
      if (child === null) throw new Error(lastError ?? 'embedding worker is not running')
      const id = nextRequestId++
      return await new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          pending.delete(id)
          reject(new Error(`embedding request timed out after ${requestTimeoutMs}ms`))
        }, requestTimeoutMs)
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

  /** Embed a batch of texts through the worker. */
  async function embedTexts(texts) {
    const list = (Array.isArray(texts) ? texts : []).map((text) => String(text ?? '')).filter((text) => text.trim() !== '')
    if (list.length === 0) return { vectors: [], model: workerModel, dims: workerDims, latencyMs: 0 }
    const started = Date.now()
    const response = await request({ op: 'embed', texts: list, batchSize: batchSize })
    const latencyMs = Date.now() - started
    lastEmbedLatencyMs = latencyMs
    lastError = null
    if (Array.isArray(response.vectors) === false || response.vectors.length !== list.length) {
      throw new Error('embedding worker returned an unexpected vector count')
    }
    return {
      vectors: response.vectors,
      model: response.model ?? workerModel,
      dims: Number(response.dims) || workerDims,
      latencyMs,
    }
  }

  /** Re-detect the environment after a successful install (no restart needed). */
  function refresh() {
    configured = !disabled && existsSync(pythonPath) && existsSync(WORKER_SCRIPT)
    configReason = disabled
      ? 'embedding component is disabled by configuration'
      : !existsSync(pythonPath)
        ? `embedding python not found at ${pythonPath}; run scripts/setup-embedding.sh`
        : !existsSync(WORKER_SCRIPT)
          ? `embedding worker missing at ${WORKER_SCRIPT}`
          : null
    crashCount = 0
    lastError = null
    workerReady = false
    indexCache = null
    return facts()
  }

  /** Build one annotation embedding document (quote + comment + paper title). */
  function annotationDoc(annotationId) {
    const annotation = db
      .prepare(
        `SELECT a.id, a.paper_id, a.page, a.quote, a.comment, p.title, p.title_zh FROM annotations a JOIN papers p ON p.id = a.paper_id AND p.state = 'active'
         WHERE a.id = ? AND a.state = 'active'`,
      )
      .get(annotationId)
    if (annotation === undefined) return undefined
    const text = [annotation.title, annotation.title_zh, annotation.quote, annotation.comment]
      .map((part) => (typeof part === 'string' ? part.replace(/\s+/g, ' ').trim() : ''))
      .filter((part) => part !== '')
      .join('. ')
    if (text === '') return undefined
    return { kind: 'annotation', refId: annotation.id, chunkIndex: 0, paperId: annotation.paper_id, page: annotation.page === null ? null : Number(annotation.page), text: text.slice(0, 1200) }
  }

  /** Upsert one annotation embedding (incremental autoIndex sync). */
  async function syncAnnotation(annotationId) {
    const info = facts()
    if (!info.configured || !info.available || !info.indexReady) return { synced: false, reason: info.lastError ?? 'embedding index is not ready' }
    const doc = annotationDoc(String(annotationId))
    if (doc === undefined) return { synced: false, reason: 'annotation not found or empty' }
    const embedded = await embedTexts([doc.text])
    db.prepare(
      `INSERT INTO embeddings(kind, ref_id, chunk_index, paper_id, page, text, vector, model, dims, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(kind, ref_id, chunk_index, model) DO UPDATE SET
         paper_id = excluded.paper_id, page = excluded.page, text = excluded.text,
         vector = excluded.vector, dims = excluded.dims, updated_at = excluded.updated_at`,
    ).run(doc.kind, doc.refId, doc.chunkIndex, doc.paperId, doc.page, doc.text, encodeVector(embedded.vectors[0]), embedded.model, embedded.dims, nowIso())
    indexCache = null
    return { synced: true, model: embedded.model }
  }

  /** Remove one annotation embedding after the annotation is deleted. */
  function removeAnnotation(annotationId) {
    try {
      const result = db.prepare("DELETE FROM embeddings WHERE kind = 'annotation' AND ref_id = ?").run(String(annotationId))
      indexCache = null
      return { removed: Number(result.changes ?? 0) }
    } catch {
      return { removed: 0 }
    }
  }

  /** Catch up annotations that were created while autoIndex was off. */
  async function syncMissingAnnotations() {
    const info = facts()
    if (!info.configured || !info.available || !info.indexReady) return { synced: 0, skipped: 0, reason: info.lastError ?? 'embedding index is not ready' }
    const rows = db
      .prepare(
        `SELECT a.id FROM annotations a JOIN papers p ON p.id = a.paper_id AND p.state = 'active'
         WHERE a.state = 'active' AND NOT EXISTS (
           SELECT 1 FROM embeddings e WHERE e.kind = 'annotation' AND e.ref_id = a.id AND e.model = ?
         )`,
      )
      .all(info.model)
    let synced = 0
    const failed = []
    for (const row of rows) {
      try {
        const result = await syncAnnotation(row.id)
        if (result.synced === true) synced += 1
      } catch (error) {
        failed.push(String(error?.message ?? error))
      }
    }
    return { synced, skipped: rows.length - synced, failed: failed.slice(0, 5) }
  }

  /** Collect every document that should be embedded (deterministic order). */
  function collectDocuments() {
    const docs = []
    const papers = db
      .prepare('SELECT id, title, title_zh, abstract, keywords_json, field, venue, year FROM papers WHERE state = ? ORDER BY id')
      .all('active')
    for (const paper of papers) {
      let keywords = ''
      try {
        const parsed = typeof paper.keywords_json === 'string' ? JSON.parse(paper.keywords_json) : paper.keywords_json
        if (Array.isArray(parsed)) keywords = parsed.map((item) => String(item ?? '')).filter((item) => item !== '').join(', ')
      } catch {}
      const parts = [paper.title, paper.title_zh, paper.abstract, keywords, paper.venue, paper.field]
        .map((part) => (typeof part === 'string' ? part.replace(/\s+/g, ' ').trim() : ''))
        .filter((part) => part !== '')
      docs.push({
        kind: 'paper',
        refId: paper.id,
        chunkIndex: 0,
        paperId: paper.id,
        page: null,
        text: parts.join('. ').slice(0, 2000),
      })
    }
    const pages = db
      .prepare('SELECT pp.paper_id, pp.page, pp.layout_json FROM paper_pages pp JOIN papers p ON p.id = pp.paper_id AND p.state = ? ORDER BY pp.paper_id, pp.page')
      .all('active')
    for (const page of pages) {
      const chunks = chunkPageText(pageIndexText(page.layout_json), { min: 600, max: 800, overlap: 80 })
      chunks.forEach((text, index) => {
        docs.push({ kind: 'page', refId: `${page.paper_id}:${page.page}`, chunkIndex: index, paperId: page.paper_id, page: Number(page.page), text })
      })
    }
    const figures = db
      .prepare(
        `SELECT f.id, f.paper_id, f.page, f.label, f.caption, p.title, p.title_zh FROM figures f JOIN papers p ON p.id = f.paper_id AND p.state = ? ORDER BY f.id`,
      )
      .all('active')
    for (const figure of figures) {
      const text = [figure.title, figure.title_zh, figure.label, figure.caption]
        .map((part) => (typeof part === 'string' ? part.replace(/\s+/g, ' ').trim() : ''))
        .filter((part) => part !== '')
        .join('. ')
      if (text === '') continue
      docs.push({ kind: 'figure', refId: figure.id, chunkIndex: 0, paperId: figure.paper_id, page: figure.page === null ? null : Number(figure.page), text: text.slice(0, 1200) })
    }
    const annotations = db
      .prepare(
        `SELECT a.id, a.paper_id, a.page, a.quote, a.comment, p.title, p.title_zh FROM annotations a JOIN papers p ON p.id = a.paper_id AND p.state = ? WHERE a.state = 'active' ORDER BY a.id`,
      )
      .all('active')
    for (const annotation of annotations) {
      const text = [annotation.title, annotation.title_zh, annotation.quote, annotation.comment]
        .map((part) => (typeof part === 'string' ? part.replace(/\s+/g, ' ').trim() : ''))
        .filter((part) => part !== '')
        .join('. ')
      if (text === '') continue
      docs.push({ kind: 'annotation', refId: annotation.id, chunkIndex: 0, paperId: annotation.paper_id, page: annotation.page === null ? null : Number(annotation.page), text: text.slice(0, 1200) })
    }
    return docs
  }

  /** Persist embeddings in batches of 16 (serial; idempotent upsert). */
  async function buildIndex({ api, job, force = false } = {}) {
    await ensureWorker()
    const docs = collectDocuments()
    const total = docs.length
    api?.updateProgress?.(job, 0, total, 'chunks')
    api?.checkpoint?.(job, 'collect', 'done', {
      total,
      papers: docs.filter((doc) => doc.kind === 'paper').length,
      pages: docs.filter((doc) => doc.kind === 'page').length,
      figures: docs.filter((doc) => doc.kind === 'figure').length,
      annotations: docs.filter((doc) => doc.kind === 'annotation').length,
    })
    // Stale rows of the same model are removed after the upserts (kept during the
    // run so a crash/retry never leaves the library unsearchable).
    const seen = new Set()
    const upsert = db.prepare(
      `INSERT INTO embeddings(kind, ref_id, chunk_index, paper_id, page, text, vector, model, dims, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(kind, ref_id, chunk_index, model) DO UPDATE SET
         paper_id = excluded.paper_id, page = excluded.page, text = excluded.text,
         vector = excluded.vector, dims = excluded.dims, updated_at = excluded.updated_at`,
    )
    let done = 0
    for (let start = 0; start < docs.length; start += batchSize) {
      api?.throwIfCancelled?.(job)
      const batch = docs.slice(start, start + batchSize)
      const embedded = await embedTexts(batch.map((doc) => doc.text.slice(0, 4000)))
      const now = nowIso()
      for (let index = 0; index < batch.length; index += 1) {
        const doc = batch[index]
        seen.add(`${doc.kind}|${doc.refId}|${doc.chunkIndex}`)
        upsert.run(
          doc.kind,
          doc.refId,
          doc.chunkIndex,
          doc.paperId,
          doc.page,
          doc.text,
          encodeVector(embedded.vectors[index]),
          embedded.model,
          embedded.dims,
          now,
        )
      }
      done += batch.length
      api?.updateProgress?.(job, done, total, 'chunks')
      api?.heartbeat?.(job)
    }
    // Remove rows that no longer correspond to a current document.
    {
      const existing = db.prepare('SELECT id, kind, ref_id, chunk_index FROM embeddings WHERE model = ?').all(workerModel)
      let removed = 0
      for (const row of existing) {
        const key = `${row.kind}|${row.ref_id}|${row.chunk_index}`
        if (!seen.has(key)) {
          db.prepare('DELETE FROM embeddings WHERE id = ?').run(row.id)
          removed += 1
        }
      }
      if (removed > 0) logger?.debug?.(`pappers-hall: embedding index removed ${removed} stale chunk(s)`)
    }
    const builtAt = nowIso()
    const version = expectedIndexVersion()
    writeSetting(db, 'embedding.indexVersion', version)
    writeSetting(db, 'embedding.builtAt', builtAt)
    writeSetting(db, 'embedding.model', workerModel)
    writeSetting(db, 'embedding.dims', workerDims)
    indexCache = null
    const counts = countEmbeddings()
    const result = { model: workerModel, dims: workerDims, version, builtAt, counts, total }
    api?.checkpoint?.(job, 'write', 'done', result)
    return result
  }

  /** Count stored chunks per kind. */
  function countEmbeddings() {
    const counts = { papers: 0, pages: 0, figures: 0, annotations: 0, chunks: 0, papersIndexed: 0 }
    for (const row of db.prepare('SELECT kind, COUNT(*) AS count, COUNT(DISTINCT paper_id) AS papers FROM embeddings GROUP BY kind').all()) {
      if (row.kind === 'paper') counts.papers = Number(row.count ?? 0)
      else if (row.kind === 'page') counts.pages = Number(row.count ?? 0)
      else if (row.kind === 'figure') counts.figures = Number(row.count ?? 0)
      else if (row.kind === 'annotation') counts.annotations = Number(row.count ?? 0)
      counts.chunks += Number(row.count ?? 0)
    }
    counts.papersIndexed = Number(db.prepare('SELECT COUNT(DISTINCT paper_id) AS count FROM embeddings WHERE paper_id IS NOT NULL').get()?.count ?? 0)
    return counts
  }

  /** Current embedding build job, if one is queued/running. */
  function buildingJob() {
    return db
      .prepare("SELECT id, kind, state, progress_done, progress_total, progress_unit, error_message FROM jobs WHERE kind = 'embedding.index' AND state IN ('queued','running','retry_wait') ORDER BY created_at DESC LIMIT 1")
      .get()
  }

  /** Availability facts used by status/search/vectorInfo (never fabricates). */
  function facts() {
    const version = indexVersion()
    const counts = countEmbeddings()
    const building = buildingJob()
    const expected = `${EMBEDDING_INDEX_VERSION}:${workerModel}:${workerDims}`
    const available = configured && crashCount <= 2 && !(lastError !== null && workerReady === false && crashCount > 2)
    return {
      available,
      configured,
      pythonPath,
      model: workerReady ? workerModel : modelName,
      dims: workerReady ? workerDims : EMBEDDING_DIMS,
      indexVersion: version,
      expectedIndexVersion: expected,
      indexReady: version === expected && counts.chunks > 0,
      building: building !== undefined,
      job: building === undefined ? null : { id: building.id, state: building.state, done: Number(building.progress_done ?? 0), total: Number(building.progress_total ?? 0), unit: building.progress_unit ?? 'chunks' },
      counts,
      lastError: configReason ?? lastError,
      lastEmbedLatencyMs,
      worker: { state: workerReady ? 'ready' : child === null ? 'idle' : 'starting', loadMs: lastLoadMs, restarts: crashCount },
      indexBuiltAt: readSetting(db, 'embedding.builtAt') ?? null,
    }
  }

  /** `embedding.status` payload. */
  function status() {
    const info = facts()
    return {
      available: info.available,
      configured: info.configured,
      pythonPath: info.pythonPath,
      model: info.model,
      dims: info.dims,
      indexVersion: info.indexVersion,
      expectedIndexVersion: info.expectedIndexVersion,
      indexReady: info.indexReady,
      building: info.building,
      job: info.job,
      counts: info.counts,
      lastError: info.lastError,
      lastEmbedLatencyMs: info.lastEmbedLatencyMs,
      worker: info.worker,
      indexBuiltAt: info.indexBuiltAt,
      sync: syncStatus(),
      lastSyncedAt: readSetting(db, 'embedding.lastSyncedAt') ?? null,
      setupScript: 'scripts/setup-embedding.sh',
      note: info.configured
        ? '本地 CPU 多语言嵌入模型；文本不上传，仅本机计算。'
        : '嵌入组件未安装：运行 scripts/setup-embedding.sh（可选，占用约 1.2GB），向量检索会诚实降级。',
    }
  }

  /** `status.index.vectorInfo` payload for the client semantic chips. */
  function vectorInfo() {
    const info = facts()
    let reason = null
    if (!info.configured) reason = configReason ?? 'embedding component is not configured'
    else if (!info.available) reason = info.lastError ?? 'embedding worker is unavailable'
    else if (!info.indexReady) reason = 'embedding index not built yet; run embedding.index'
    return { model: info.model, dims: info.dims, latencyMs: info.lastEmbedLatencyMs, reason }
  }

  /** Register the persistent index job handler. */
  function registerHandlers(queue) {
    if (queue === undefined || queue === null || typeof queue.register !== 'function') return
    queue.register('embedding.index', async (job, api) => buildIndex({ api, job, force: job.payload?.force === true }))
  }

  /** Enqueue an index build (or return the already-running job). */
  function index(params = {}) {
    const queue = service.queue
    if (queue === undefined || queue === null) {
      return { status: 'unavailable', reason: 'background job queue is not available', job: null }
    }
    const info = facts()
    if (!info.configured) {
      return {
        status: 'unavailable',
        reason: configReason ?? 'embedding component is not configured',
        setupScript: 'scripts/setup-embedding.sh',
        job: null,
      }
    }
    if (info.building && params.force !== true) {
      return { status: 'already_running', job: info.job, building: true }
    }
    const job = queue.enqueue({
      kind: 'embedding.index',
      payload: { force: params.force === true },
      idempotencyKey: params.force === true ? undefined : `embedding.index:${info.expectedIndexVersion}`,
      total: 0,
      unit: 'chunks',
    })
    logger?.debug?.(`pappers-hall: embedding.index job ${job.id} enqueued`)
    return { status: 'queued', job, building: true }
  }

  /** Auto-enqueue when the component is usable and the stored index is stale. */
  function autoIndexIfNeeded() {
    if (settings !== undefined && settings !== null && typeof settings.features === 'function' && settings.features().autoIndex === false) return undefined
    const info = facts()
    if (!info.configured || info.available !== true) return undefined
    if (info.indexReady) return undefined
    if (info.building) return undefined
    if (service.queue === undefined || service.queue === null) return undefined
    try {
      return index({})
    } catch (error) {
      logger?.warn?.(`pappers-hall: automatic embedding index enqueue failed: ${String(error?.message ?? error)}`)
      return undefined
    }
  }

  /** Load (and cache) all vector rows for cosine search. */
  function loadIndex() {
    const version = indexVersion()
    const stamp = `${version ?? 'none'}:${countEmbeddings().chunks}`
    if (indexCache !== null && indexCache.stamp === stamp) return indexCache.rows
    const rows = db.prepare('SELECT id, kind, ref_id, chunk_index, paper_id, page, text, vector, model, dims FROM embeddings WHERE model = ?').all(workerModel)
    const decoded = rows.map((row) => ({
      id: row.id,
      kind: row.kind,
      refId: row.ref_id,
      chunkIndex: Number(row.chunk_index ?? 0),
      paperId: row.paper_id,
      page: row.page === null ? null : Number(row.page),
      text: row.text,
      vector: decodeVector(row.vector),
    }))
    indexCache = { stamp, rows: decoded }
    return decoded
  }

  /**
   * Semantic search over stored chunk vectors.
   * @param {string} queryText natural-language query (Chinese works).
   * @param {object} [options] k/kinds/paperIds.
   * @returns {Promise<object>} ranked chunk hits + honest status facts.
   */
  async function searchVectors(queryText, options = {}) {
    const info = facts()
    if (!info.configured) return { available: false, reason: configReason ?? 'embedding component is not configured', items: [], model: info.model, dims: info.dims }
    if (!info.available) return { available: false, reason: info.lastError ?? 'embedding worker is unavailable', items: [], model: info.model, dims: info.dims }
    if (!info.indexReady) return { available: false, reason: 'embedding index is empty; run embedding.index', items: [], model: info.model, dims: info.dims, indexReady: false }
    const k = Math.max(1, Math.min(400, Number(options.k) || 40))
    const kinds = Array.isArray(options.kinds) && options.kinds.length > 0 ? new Set(options.kinds) : null
    const allowed = Array.isArray(options.paperIds) ? new Set(options.paperIds) : null
    const rows = loadIndex()
    const started = Date.now()
    const embedded = await embedTexts([queryText])
    const queryVector = new Float32Array(embedded.vectors[0])
    const embedMs = Date.now() - started
    const scored = []
    for (const row of rows) {
      if (kinds !== null && !kinds.has(row.kind)) continue
      if (allowed !== null && (typeof row.paperId !== 'string' || !allowed.has(row.paperId))) continue
      scored.push({ ...row, score: cosine(queryVector, row.vector) })
    }
    scored.sort((left, right) => right.score - left.score)
    return {
      available: true,
      model: embedded.model,
      dims: embedded.dims,
      items: scored.slice(0, k),
      k: Math.min(k, scored.length),
      total: scored.length,
      latencyMs: embedMs,
      embedMs,
      searchMs: Date.now() - started,
      queryVector,
    }
  }

  /* ---------------------- incremental index sync ------------------- */

  // Add/update/delete of papers, pages, figures, annotations and notes must be
  // reflected without a manual rebuild. `syncSoon()` debounces change bursts and
  // reconciles the embeddings table against the current documents: only changed
  // or missing chunks are embedded again, stale rows are removed. It never blocks
  // the caller and never flips the vector channel to degraded while it runs.
  let syncTimer = null
  let syncRunning = false
  let syncQueued = false
  let lastSyncSummary = null

  function syncPending() {
    return syncTimer !== null || syncRunning || syncQueued
  }

  function syncSoon(delayMs = 1200) {
    if (disabled || configured === false) return
    // v0.11 autoIndex switch: pause incremental sync when the user turned it off.
    if (settings !== undefined && settings !== null && typeof settings.features === 'function' && settings.features().autoIndex === false) return
    if (syncTimer !== null) {
      clearTimeout(syncTimer)
      syncTimer = null
    }
    syncQueued = true
    syncTimer = setTimeout(() => {
      syncTimer = null
      syncNow().catch((error) => logger?.warn?.(`pappers-hall: embedding sync failed: ${String(error?.message ?? error)}`))
    }, Math.max(0, Number(delayMs) || 0))
    syncTimer.unref?.()
  }

  /** Reconcile stored embeddings with the current library content. */
  async function syncNow() {
    if (disabled || configured === false) return { status: 'unavailable', reason: 'embedding component is not configured', changed: 0 }
    if (syncRunning) { syncQueued = true; return { status: 'already_running', changed: 0 } }
    syncRunning = true
    syncQueued = false
    const started = Date.now()
    try {
      await ensureWorker()
      const docs = collectDocuments()
      const existing = new Map()
      for (const row of db.prepare('SELECT id, kind, ref_id, chunk_index, text FROM embeddings WHERE model = ?').all(workerModel)) {
        existing.set(`${row.kind}|${row.ref_id}|${row.chunk_index}`, row)
      }
      const planned = []
      const seen = new Set()
      for (const doc of docs) {
        const key = `${doc.kind}|${doc.refId}|${doc.chunkIndex}`
        seen.add(key)
        const current = existing.get(key)
        if (current === undefined || current.text !== doc.text) planned.push(doc)
      }
      const stale = []
      for (const [key, row] of existing) if (!seen.has(key)) stale.push(row.id)
      let changed = 0
      if (planned.length > 0) {
        const upsert = db.prepare(
          `INSERT INTO embeddings(kind, ref_id, chunk_index, paper_id, page, text, vector, model, dims, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(kind, ref_id, chunk_index, model) DO UPDATE SET
             paper_id = excluded.paper_id, page = excluded.page, text = excluded.text,
             vector = excluded.vector, dims = excluded.dims, updated_at = excluded.updated_at`,
        )
        for (let start = 0; start < planned.length; start += batchSize) {
          const batch = planned.slice(start, start + batchSize)
          const embedded = await embedTexts(batch.map((doc) => doc.text.slice(0, 4000)))
          const now = nowIso()
          for (let index = 0; index < batch.length; index += 1) {
            const doc = batch[index]
            upsert.run(doc.kind, doc.refId, doc.chunkIndex, doc.paperId, doc.page, doc.text, encodeVector(embedded.vectors[index]), embedded.model, embedded.dims, now)
          }
          changed += batch.length
        }
      }
      for (const id of stale) db.prepare('DELETE FROM embeddings WHERE id = ?').run(id)
      indexCache = null
      const syncedAt = nowIso()
      writeSetting(db, 'embedding.lastSyncedAt', syncedAt)
      if (indexVersion() === '') writeSetting(db, 'embedding.indexVersion', expectedIndexVersion())
      if (indexVersion() !== '' && lastSyncSummary === null) writeSetting(db, 'embedding.builtAt', readSetting(db, 'embedding.builtAt') ?? syncedAt)
      lastSyncSummary = { at: syncedAt, changed, removed: stale.length, planned: planned.length, stale: stale.length, latencyMs: Date.now() - started }
      logger?.debug?.(`pappers-hall: embedding sync changed=${changed} removed=${stale.length} in ${lastSyncSummary.latencyMs}ms`)
      return { status: 'ok', ...lastSyncSummary, counts: countEmbeddings() }
    } catch (error) {
      lastSyncSummary = { at: nowIso(), error: String(error?.message ?? error), changed: 0 }
      throw error
    } finally {
      syncRunning = false
      if (syncQueued) {
        syncQueued = false
        syncSoon(200)
      }
    }
  }

  function syncStatus() {
    return {
      pending: syncPending(),
      syncing: syncRunning,
      lastSyncedAt: readSetting(db, 'embedding.lastSyncedAt') ?? null,
      last: lastSyncSummary,
    }
  }

  /** Close the worker and release timers. */
  function close() {
    const proc = child
    child = null
    workerReady = false
    rejectPending('embedding service closed')
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

  const service = {
    queue: null,
    registerHandlers,
    index,
    autoIndexIfNeeded,
    status,
    vectorInfo,
    facts,
    embedTexts,
    searchVectors,
    syncSoon,
    syncNow,
    syncStatus,
    refresh,
    syncMissingAnnotations,
    collectDocuments,
    buildIndex,
    countEmbeddings,
    chunkPageText,
    close,
    /** @internal test/support hook to attach the persistent queue. */
    install(queue) {
      service.queue = queue
      registerHandlers(queue)
    },
    diagnostics() {
      const info = facts()
      return {
        available: info.available,
        configured: info.configured,
        model: info.model,
        dims: info.dims,
        indexVersion: info.indexVersion,
        indexReady: info.indexReady,
        building: info.building,
        counts: info.counts,
        lastError: info.lastError,
        worker: info.worker,
      }
    },
  }
  return service
}
