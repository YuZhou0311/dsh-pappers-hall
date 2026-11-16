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
export function createModels({ db, queue, embedding, ocr, python, settings, config = {}, logger }) {
  const embeddingPython = typeof config.embeddingPython === 'string' && config.embeddingPython !== '' ? config.embeddingPython : path.join(homedir(), '.dsh', 'pappers-hall', 'embedding', 'venv', 'bin', 'python')
  const embeddingVenv = path.dirname(path.dirname(embeddingPython))
  const embeddingCache = typeof config.embeddingCacheDir === 'string' && config.embeddingCacheDir !== '' ? config.embeddingCacheDir : path.join(homedir(), '.dsh', 'pappers-hall', 'models')
  const setupScript = path.join(PLUGIN_ROOT, 'scripts', 'setup-embedding.sh')
  const python3 = typeof config.python3 === 'string' && config.python3 !== '' ? config.python3 : 'python3'
  const pythonVenvDir = typeof config.pythonVenvDir === 'string' && config.pythonVenvDir !== ''
    ? config.pythonVenvDir
    : path.join(homedir(), '.dsh', 'pappers-hall', 'python', 'venv')
  const pythonModelDir = typeof config.pythonModelDir === 'string' && config.pythonModelDir !== ''
    ? config.pythonModelDir
    : path.join(homedir(), '.dsh', 'pappers-hall', 'python', 'models')
  const modelBaseUrl = typeof config.modelBaseUrl === 'string' && config.modelBaseUrl !== ''
    ? config.modelBaseUrl.replace(/\/$/, '')
    : 'https://huggingface.co/stefanj0/PP-DocLayout-S-ONNX/resolve/main'
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

  /** Fixed companion model downloaded for the layout stage (see release models-v1). */
  const LAYOUT_MODEL = {
    // Public mirror of the same paddle2onnx conversion; the checksum pins it.
    file: 'pp-doclayout-s.onnx',
    remote: 'pp_doclayout_s.onnx',
    sha256: '33688dbee1c23e34b81777e97cb428eb40f24b242c02b5f623484959e830aec8',
    bytes: 4_917_852,
  }

  /** Download one file with a SHA-256 check; partial downloads never land. */
  async function downloadVerified(url, destination, expectedSha, signal, onProgress) {
    const { createHash } = await import('node:crypto')
    const { mkdir, rename, rm, writeFile } = await import('node:fs/promises')
    await mkdir(path.dirname(destination), { recursive: true })
    const response = await fetch(url, { redirect: 'follow', signal })
    if (!response.ok) throw new Error(`download failed (${response.status}) for ${url}`)
    const total = Number(response.headers.get('content-length') ?? 0)
    const chunks = []
    let received = 0
    const reader = response.body?.getReader()
    if (reader === undefined) {
      const buffer = Buffer.from(await response.arrayBuffer())
      chunks.push(buffer)
      received = buffer.length
    } else {
      for (;;) {
        const { done, value } = await reader.read()
        if (done === true) break
        const chunk = Buffer.from(value)
        chunks.push(chunk)
        received += chunk.length
        onProgress?.(received, total)
      }
    }
    const buffer = Buffer.concat(chunks)
    const digest = createHash('sha256').update(buffer).digest('hex')
    if (expectedSha !== undefined && digest !== expectedSha) {
      throw new Error(`checksum mismatch for ${path.basename(destination)}: ${digest}`)
    }
    const temporary = `${destination}.download`
    await writeFile(temporary, buffer)
    await rename(temporary, destination)
    await rm(temporary, { force: true }).catch(() => {})
    return { bytes: buffer.length, sha256: digest }
  }

  /**
   * Install the optional Python component: PyMuPDF (PDF extraction) plus
   * rapidocr's PP-OCRv6 models (OCR) plus the PP-DocLayout-S model (layout).
   *
   * The models are fixed on purpose — there is no picker, so a first install is
   * one click and every install produces the same, verifiable result.
   */
  async function runPythonInstall(job, api) {
    const venvPython = path.join(pythonVenvDir, 'bin', 'python')
    const venvPip = path.join(pythonVenvDir, 'bin', 'pip')
    const steps = 6
    let step = 0
    const advance = (unit = 'steps') => {
      step = Math.min(steps, step + 1)
      api.updateProgress(job, step, steps, unit)
      api.heartbeat(job)
    }
    api.throwIfCancelled(job)
    const { mkdir } = await import('node:fs/promises')
    await mkdir(path.dirname(pythonVenvDir), { recursive: true })
    if (!existsSync(venvPython)) {
      const created = await runProcess([python3, '-m', 'venv', pythonVenvDir], { signal: job.signal, timeoutMs: 5 * 60_000 })
      if (created.code !== 0) throw new Error(`python -m venv failed: ${created.stderr.slice(-600)}`)
    }
    advance()
    api.throwIfCancelled(job)
    const packages = ['--quiet', '--upgrade', 'pymupdf>=1.24', 'rapidocr>=3.0']
    const pip = await runProcess([venvPip, 'install', ...packages], { signal: job.signal, timeoutMs: 30 * 60_000 })
    if (pip.code !== 0) throw new Error(`pip install failed: ${pip.stderr.slice(-700)}`)
    advance()
    api.throwIfCancelled(job)
    // Layout model: fixed file + checksum from the models-v1 release.
    const layoutModelPath = path.join(pythonModelDir, LAYOUT_MODEL.file)
    if (!existsSync(layoutModelPath)) {
      await downloadVerified(`${modelBaseUrl}/${LAYOUT_MODEL.remote}`, layoutModelPath, LAYOUT_MODEL.sha256, job.signal)
    }
    advance()
    api.throwIfCancelled(job)
    // Warm-up: start the worker and let rapidocr fetch its fixed PP-OCRv6
    // weights now, so the first OCR job does not surprise the user with a
    // download (and so a broken install fails here instead of later).
    if (python !== undefined && python !== null && typeof python.start === 'function') {
      try { python.stop?.() } catch {}
      await python.start()
      const warmed = await python.invoke('ensureModels', {}, { timeoutMs: 30 * 60_000 })
      const report = warmed.report ?? {}
      if (report.ocr !== 'ready') throw new Error(`OCR model warm-up failed: ${String(report.ocr)}`)
      if (report.layout !== 'ready') logger?.warn?.(`pappers-hall: layout model unavailable: ${String(report.layout)}`)
    }
    advance()
    api.throwIfCancelled(job)
    let version = null
    try {
      const printed = await runProcess([venvPython, '-c', "import pymupdf, rapidocr; print(pymupdf.VersionBind, getattr(rapidocr,'__version__',''))"], { timeoutMs: 60_000 })
      if (printed.code === 0) version = printed.stdout.trim().split('\n').pop() || null
    } catch {}
    writeSetting(db, 'models.python.installedAt', nowIso())
    if (version !== null) writeSetting(db, 'models.python.version', version)
    writeSetting(db, 'models.ocr.installedAt', nowIso())
    if (version !== null) writeSetting(db, 'models.ocr.version', version)
    sizeCache = null
    advance()
    return { kind: 'python', installedAt: nowIso(), version }
  }

  /**
   * Remove the managed virtualenv and models.
   * @returns {Promise<{removed:string[], bytes:number}>} removal summary.
   */
  async function uninstallPython() {
    const { rm } = await import('node:fs/promises')
    const removed = []
    for (const target of [pythonVenvDir, path.dirname(pythonModelDir) === pythonModelDir ? pythonModelDir : pythonModelDir]) {
      try {
        await rm(target, { recursive: true, force: true })
        removed.push(target)
      } catch (error) {
        logger?.warn?.(`pappers-hall: could not remove ${target}: ${String(error?.message ?? error)}`)
      }
    }
    try { python?.stop?.() } catch {}
    writeSetting(db, 'models.python.installedAt', '')
    sizeCache = null
    return { removed, bytes: 0 }
  }

  /** Persistent install handler. */
  async function processInstallJob(job, api) {
    const kind = job.payload?.kind
    if (kind === 'embedding') return runEmbeddingInstall(job, api)
    // `ocr` stays a supported alias so existing settings/deep links keep working.
    if (kind === 'python' || kind === 'ocr') return runPythonInstall(job, api)
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
    if (kind !== 'embedding' && kind !== 'python' && kind !== 'ocr') return { status: 'invalid', reason: `unsupported model kind ${kind || '(empty)'}`, job: null }
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
    if (kind !== 'embedding' && kind !== 'python' && kind !== 'ocr') return { status: 'invalid', reason: `unsupported model kind ${kind || '(empty)'}`, job: null }
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
    uninstallPython,
    /** Fixed model facts for the settings panel. */
    pythonModelFacts() {
      return {
        layoutModel: { ...LAYOUT_MODEL, url: `${modelBaseUrl}/${LAYOUT_MODEL.remote}` },
        venvDir: pythonVenvDir,
        modelDir: pythonModelDir,
        installedAt: readSetting(db, 'models.python.installedAt') ?? null,
        version: readSetting(db, 'models.python.version') ?? null,
      }
    },
    paths: { embeddingPython, embeddingVenv, embeddingCache, setupScript, pythonVenvDir, pythonModelDir, modelBaseUrl, ocrDir: null },
  }
}
