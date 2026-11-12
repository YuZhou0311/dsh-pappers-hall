/**
 * Model download / installation channel (v0.11).
 *
 * Users install the optional local components from the settings panel; nothing is
 * downloaded automatically. Each install runs as a persistent `model.install` job
 * with real progress and error messages, and a failure never removes an already
 * working component:
 *  - embedding: runs `scripts/setup-embedding.sh` (venv + torch + model download)
 *  - ocr: creates ~/.dsh/pappers-hall/ocr/venv and installs rapidocr-onnxruntime
 *
 * @module pappers-hall/host/models
 */
import { spawn } from 'node:child_process'
import { existsSync, readdirSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import path from 'node:path'
import readline from 'node:readline'
import { fileURLToPath } from 'node:url'
import { readSetting, writeSetting } from './db.js'
import { nowIso } from './paths.js'

const HOST_DIR = path.dirname(fileURLToPath(import.meta.url))
const PLUGIN_ROOT = path.resolve(HOST_DIR, '..')
const WORKER_SCRIPT = path.join(HOST_DIR, 'ocr_worker.py')

/** Resolve one model-install job row into the API shape. */
function mapJob(row) {
  if (row === undefined || row === null) return null
  return {
    id: row.id,
    kind: row.kind,
    state: row.state,
    attempts: Number(row.attempts ?? 0),
    progress: {
      done: Number(row.progress_done ?? 0),
      total: Number(row.progress_total ?? 0),
      unit: row.progress_unit ?? 'steps',
    },
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    ...(typeof row.error_message === 'string' && row.error_message !== '' ? { error: row.error_message } : {}),
  }
}

/** Recursively sum file sizes (bounded). */
function dirSize(dir, depth = 0) {
  if (depth > 7) return 0
  let bytes = 0
  let entries
  try {
    entries = readdirSync(dir, { withFileTypes: true })
  } catch {
    return 0
  }
  for (const entry of entries) {
    const target = path.join(dir, entry.name)
    try {
      if (entry.isDirectory()) bytes += dirSize(target, depth + 1)
      else if (entry.isFile()) bytes += statSync(target).size
    } catch {}
  }
  return bytes
}

/** Run one child process to completion, streaming lines. */
function runProcess(argv, { env, timeoutMs = 1_800_000, onLine, signal } = {}) {
  return new Promise((resolve, reject) => {
    let stdoutTail = ''
    let stderrTail = ''
    let settled = false
    const proc = spawn(argv[0], argv.slice(1), { env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] })
    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      try {
        proc.kill('SIGKILL')
      } catch {}
      reject(new Error(`command timed out after ${Math.round(timeoutMs / 1000)}s: ${argv.join(' ')}`))
    }, timeoutMs)
    const onAbort = () => {
      if (settled) return
      try {
        proc.kill('SIGKILL')
      } catch {}
    }
    signal?.addEventListener?.('abort', onAbort, { once: true })
    const consume = (chunk, which) => {
      const text = String(chunk)
      if (which === 'stdout') stdoutTail = (stdoutTail + text).slice(-4000)
      else stderrTail = (stderrTail + text).slice(-4000)
      if (typeof onLine === 'function') {
        for (const line of text.split(/\r?\n/)) if (line.trim() !== '') onLine(line.trim(), which)
      }
    }
    proc.stdout.on('data', (chunk) => consume(chunk, 'stdout'))
    proc.stderr.on('data', (chunk) => consume(chunk, 'stderr'))
    proc.on('error', (error) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      reject(error instanceof Error ? error : new Error(String(error)))
    })
    proc.on('close', (code, signalName) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      signal?.removeEventListener?.('abort', onAbort)
      resolve({ code: code ?? -1, signal: signalName ?? null, stdout: stdoutTail, stderr: stderrTail })
    })
  })
}

/** Read the OCR worker ready line (smoke test). */
function verifyOcrWorker(pythonPath, signal) {
  return new Promise((resolve, reject) => {
    const proc = spawn(pythonPath, [WORKER_SCRIPT], { stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env } })
    const reader = readline.createInterface({ input: proc.stdout })
    let settled = false
    let stderr = ''
    const finish = (error) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      reader.close()
      try {
        proc.stdin.write(`${JSON.stringify({ op: 'shutdown' })}\n`)
        proc.stdin.end()
      } catch {}
      if (error !== null) {
        try {
          proc.kill('SIGKILL')
        } catch {}
        reject(error)
      } else resolve()
    }
    const timer = setTimeout(() => finish(new Error('OCR worker did not report ready within 120s')), 120_000)
    const onAbort = () => finish(new Error('cancelled'))
    signal?.addEventListener?.('abort', onAbort, { once: true })
    reader.on('line', (line) => {
      let message
      try {
        message = JSON.parse(line)
      } catch {
        return
      }
      if (message.op === 'ready') {
        if (message.ok === false) finish(new Error(`OCR worker failed to start: ${message.error ?? 'unknown error'}`))
        else finish(null)
      }
    })
    proc.stderr.on('data', (chunk) => {
      stderr = (stderr + String(chunk)).slice(-2000)
    })
    proc.on('error', (error) => finish(error instanceof Error ? error : new Error(String(error))))
    proc.on('close', (code) => {
      if (!settled) finish(new Error(`OCR worker exited before ready (code ${code}): ${stderr.slice(-600)}`))
    })
  })
}

/**
 * Create the model installation service.
 * @param {object} options dependencies.
 * @param {import('node:sqlite').DatabaseSync} options.db database.
 * @param {object} options.queue persistent job queue.
 * @param {object} options.embedding embedding service.
 * @param {object} options.ocr OCR service.
 * @param {object} options.settings settings service.
 * @param {object} [options.config] resolved config.
 * @param {object} [options.logger] logger.
 * @returns {object} models service.
 */
export function createModels({ db, queue, embedding, ocr, settings, config = {}, logger }) {
  const embeddingPython = typeof config.embeddingPython === 'string' && config.embeddingPython !== '' ? config.embeddingPython : path.join(homedir(), '.dsh', 'pappers-hall', 'embedding', 'venv', 'bin', 'python')
  const embeddingVenv = path.dirname(path.dirname(embeddingPython))
  const embeddingCache = typeof config.embeddingCacheDir === 'string' && config.embeddingCacheDir !== '' ? config.embeddingCacheDir : path.join(homedir(), '.dsh', 'pappers-hall', 'models')
  const setupScript = path.join(PLUGIN_ROOT, 'scripts', 'setup-embedding.sh')
  const python3 = typeof config.python3 === 'string' && config.python3 !== '' ? config.python3 : 'python3'
  const ocrPaths = ocr !== null && ocr !== undefined && typeof ocr.paths === 'object' ? ocr.paths : null
  let sizeCache = null

  /** Raw active install job for one model kind. */
  function activeInstallRow(kind) {
    try {
      for (const row of db
        .prepare("SELECT * FROM jobs WHERE kind = 'model.install' AND state IN ('queued','running','paused','retry_wait') ORDER BY created_at DESC")
        .all()) {
        let payload
        try {
          payload = JSON.parse(row.payload_json ?? '{}')
        } catch {
          payload = {}
        }
        if (payload.kind === kind) return row
      }
    } catch {}
    return undefined
  }

  /** Public job facts for one model kind. */
  function activeInstallJob(kind) {
    return mapJob(activeInstallRow(kind))
  }

  /** Real embedding footprint (venv + model cache), cached 10 minutes. */
  function embeddingSizeBytes() {
    if (sizeCache !== null && Date.now() - sizeCache.at < 600_000) return sizeCache.bytes
    const bytes = dirSize(embeddingVenv) + dirSize(embeddingCache)
    sizeCache = { at: Date.now(), bytes }
    return bytes
  }

  /** One install job's steps (4 units each). */
  async function runEmbeddingInstall(job, api) {
    if (!existsSync(setupScript)) throw new Error(`setup script missing: ${setupScript}`)
    api.updateProgress(job, 0, 4, 'steps')
    let step = 0
    const advance = () => {
      step = Math.min(4, step + 1)
      api.updateProgress(job, step, 4, 'steps')
      api.heartbeat(job)
    }
    api.throwIfCancelled(job)
    const result = await runProcess(['bash', setupScript], {
      env: {
        DSH_HOME: path.join(homedir(), '.dsh'),
        ...(typeof config.embeddingModel === 'string' && config.embeddingModel !== '' ? { PAPPERS_EMBED_MODEL: config.embeddingModel } : {}),
        PAPPERS_EMBED_CACHE: embeddingCache,
      },
      signal: job.signal,
      timeoutMs: 30 * 60_000,
      onLine: (line) => {
        if (/creating venv|venv exists/i.test(line)) advance()
        else if (/preloading model/i.test(line)) advance()
        else if (/ready model=/i.test(line)) advance()
        logger?.debug?.(`pappers-hall: embedding install: ${line.slice(0, 200)}`)
      },
    })
    if (result.code !== 0) {
      throw new Error(`setup-embedding.sh failed (exit ${result.code}): ${result.stderr.slice(-700) || result.stdout.slice(-700)}`)
    }
    advance()
    writeSetting(db, 'models.embedding.installedAt', nowIso())
    writeSetting(db, 'models.embedding.version', 'torch 2.2.2 / sentence-transformers 2.7.0')
    sizeCache = null
    try {
      embedding.refresh?.()
    } catch {}
    return { kind: 'embedding', installedAt: nowIso(), setupScript }
  }

  /** Install the OCR venv + rapidocr-onnxruntime package. */
  async function runOcrInstall(job, api) {
    if (ocrPaths === null) throw new Error('OCR service is not initialized')
    const ocrDir = ocrPaths.ocrDir
    const venvDir = path.join(ocrDir, 'venv')
    const venvPython = path.join(venvDir, 'bin', 'python')
    const venvPip = path.join(venvDir, 'bin', 'pip')
    let step = 0
    api.updateProgress(job, 0, 4, 'steps')
    const advance = () => {
      step = Math.min(4, step + 1)
      api.updateProgress(job, step, 4, 'steps')
      api.heartbeat(job)
    }
    api.throwIfCancelled(job)
    const { mkdir } = await import('node:fs/promises')
    await mkdir(ocrDir, { recursive: true })
    if (!existsSync(venvPython)) {
      const created = await runProcess([python3, '-m', 'venv', venvDir], { signal: job.signal, timeoutMs: 5 * 60_000 })
      if (created.code !== 0) throw new Error(`python -m venv failed: ${created.stderr.slice(-600)}`)
    }
    advance()
    api.throwIfCancelled(job)
    const pip = await runProcess([venvPip, 'install', '--quiet', 'rapidocr-onnxruntime'], { signal: job.signal, timeoutMs: 30 * 60_000 })
    if (pip.code !== 0) throw new Error(`pip install rapidocr-onnxruntime failed: ${pip.stderr.slice(-700)}`)
    advance()
    api.throwIfCancelled(job)
    await verifyOcrWorker(venvPython, job.signal)
    advance()
    let version = null
    try {
      const printed = await runProcess([venvPython, '-c', "import rapidocr_onnxruntime as m; print(getattr(m,'__version__',''))"], { timeoutMs: 60_000 })
      if (printed.code === 0) version = printed.stdout.trim().split('\n').pop() || null
    } catch {}
    writeSetting(db, 'models.ocr.installedAt', nowIso())
    if (version !== null) writeSetting(db, 'models.ocr.version', version)
    advance()
    return { kind: 'ocr', installedAt: nowIso(), version }
  }

  /** Persistent install handler. */
  async function processInstallJob(job, api) {
    const kind = job.payload?.kind
    if (kind === 'embedding') return runEmbeddingInstall(job, api)
    if (kind === 'ocr') return runOcrInstall(job, api)
    throw new Error(`unsupported model kind ${String(kind)}`)
  }

  /** Register the persistent model-install handler. */
  function registerHandlers(targetQueue) {
    if (targetQueue === undefined || targetQueue === null || typeof targetQueue.register !== 'function') return
    targetQueue.register('model.install', (job, api) => processInstallJob(job, api))
  }

  /** `models.install` — enqueue a real install job. */
  function install(params = {}) {
    const kind = String(params.kind ?? '')
    if (kind !== 'embedding' && kind !== 'ocr') return { status: 'invalid', reason: `unsupported model kind ${kind || '(empty)'}`, job: null }
    if (queue === undefined || queue === null) return { status: 'unavailable', reason: 'background job queue is not available', job: null }
    const operationId = typeof params.operationId === 'string' && params.operationId.trim() !== '' ? params.operationId.trim() : ''
    const operationKey = operationId === '' ? null : `models.install.op.${operationId}`
    if (operationKey !== null) {
      const previous = readSetting(db, operationKey)
      if (previous !== undefined) return previous
    }
    const active = activeInstallRow(kind)
    if (active !== undefined) {
      const result = { status: 'already_running', job: mapJob(active), model: null }
      if (operationKey !== null) writeSetting(db, operationKey, result)
      return result
    }
    // No long-lived idempotency key: after a cancel/failure the user must be able
    // to start a fresh install. Double clicks are covered by the active-job check
    // above and by the optional operationId.
    const job = queue.enqueue({
      kind: 'model.install',
      payload: { kind },
      total: 4,
      unit: 'steps',
      maxAttempts: 1,
    })
    const result = { status: 'queued', job: mapJob(job), model: null }
    if (operationKey !== null) writeSetting(db, operationKey, result)
    logger?.debug?.(`pappers-hall: ${kind} install job ${job.id} queued`)
    return result
  }

  /** `models.cancel` — cancel an active install job. */
  function cancel(params = {}) {
    const kind = String(params.kind ?? '')
    if (kind !== 'embedding' && kind !== 'ocr') return { status: 'invalid', reason: `unsupported model kind ${kind || '(empty)'}`, job: null }
    const active = activeInstallRow(kind)
    if (active === undefined) return { status: 'idle', job: null, reason: '没有正在进行的安装任务' }
    const job = queue.cancel(active.id)
    return { status: 'cancelled', job: mapJob(job) }
  }

  /** `models.rebuildIndex` — force a full embedding rebuild. */
  function rebuildIndex(params = {}) {
    const result = embedding.index({ force: true, operationId: params.operationId })
    return {
      status: result.status ?? 'queued',
      job: result.job === undefined ? null : result.job,
      ...(result.reason === undefined ? {} : { reason: result.reason }),
      ...(result.setupScript === undefined ? {} : { setupScript: result.setupScript }),
    }
  }

  return {
    install,
    cancel,
    rebuildIndex,
    registerHandlers,
    processInstallJob,
    activeInstallJob,
    activeInstallRow,
    embeddingSizeBytes,
    paths: { embeddingPython, embeddingVenv, embeddingCache, setupScript, ocrDir: ocrPaths?.ocrDir ?? null },
  }
}
