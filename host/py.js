/**
 * Optional Python bridge (PyMuPDF + PP-OCRv6 + PP-DocLayout-S).
 *
 * The bridge is deliberately optional: when the user has not installed the
 * Python component the Host keeps using the Poppler CLI and skips OCR, so a
 * machine without Python/Wheels still has a complete paper centre. Once the
 * component is installed the Host calls it automatically — there is no model
 * picker and no extra switch.
 *
 * One long-lived worker (`host/py_worker.py`) is spawned per plugin instance and
 * spoken to with JSON lines; every call has a timeout and a crash is contained
 * by restarting on the next call.
 *
 * @module pappers-hall/host/py
 */
import { spawn } from 'node:child_process'
import { existsSync, readdirSync, statSync } from 'node:fs'
import path from 'node:path'
import readline from 'node:readline'
import { fileURLToPath } from 'node:url'

const WORKER_SCRIPT = fileURLToPath(new URL('./py_worker.py', import.meta.url))

/** Capabilities reported by the worker. */
const EMPTY_CAPABILITIES = { pdf: false, ocr: false, layout: false }

/**
 * Create the Python bridge.
 *
 * @param {object} options bridge options.
 * @param {string} options.venvDir directory holding the managed virtualenv.
 * @param {string} options.modelDir directory for downloaded models.
 * @param {string} [options.python] explicit interpreter override.
 * @param {object} [options.logger] logger with warn/debug/info.
 * @param {number} [options.timeoutMs] default per-call timeout.
 * @returns {object} bridge service.
 */
export function createPythonBridge({ venvDir, modelDir, python, logger, timeoutMs = 120_000 } = {}) {
  const pythonPath = typeof python === 'string' && python !== '' ? python : path.join(venvDir, 'bin', 'python')
  const layoutModel = path.join(modelDir, 'pp-doclayout-s.onnx')
  const ocrModelRoot = path.join(modelDir, 'rapidocr')

  let child = null
  let reader = null
  let starting = null
  let ready = false
  let nextId = 1
  let lastError = null
  let crashCount = 0
  let capabilities = { ...EMPTY_CAPABILITIES }
  let versions = {}
  const pending = new Map()

  /** Whether the interpreter and worker script are present on disk. */
  function installed() {
    return existsSync(pythonPath) && existsSync(WORKER_SCRIPT)
  }

  /** Directory sizes are only needed for the settings panel. */
  function venvBytes() {
    const walk = (dir, depth) => {
      if (depth > 6 || !existsSync(dir)) return 0
      let entries
      try {
        entries = readdirSync(dir, { withFileTypes: true })
      } catch {
        return 0
      }
      let total = 0
      for (const entry of entries) {
        const full = path.join(dir, entry.name)
        try {
          total += entry.isDirectory() ? walk(full, depth + 1) : statSync(full).size
        } catch {
          // file vanished between readdir and stat
        }
      }
      return total
    }
    return walk(venvDir, 0)
  }

  /** Resolve one pending request with an error, or reject on timeout. */
  function settle(id, payload) {
    const entry = pending.get(id)
    if (!entry) return
    pending.delete(id)
    clearTimeout(entry.timer)
    if (payload.ok === false) {
      const error = new Error(String(payload.error ?? 'python worker failed'))
      error.code = payload.code ?? 'py_failed'
      entry.reject(error)
      return
    }
    entry.resolve(payload)
  }

  /** Attach readers and start the worker process. */
  function spawnWorker() {
    const options = {
      modelRoot: ocrModelRoot,
      layoutModel: existsSync(layoutModel) ? layoutModel : null,
    }
    const handle = spawn(pythonPath, [WORKER_SCRIPT], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, PAPPERS_PY_OPTIONS: JSON.stringify(options) },
    })
    child = handle
    reader = readline.createInterface({ input: handle.stdout })
    reader.on('line', (line) => {
      let payload
      try {
        payload = JSON.parse(line)
      } catch {
        return
      }
      if (payload.id === undefined) return
      settle(payload.id, payload)
    })
    handle.stderr.on('data', (chunk) => {
      const text = chunk.toString('utf8').trim()
      if (text !== '') logger?.debug?.(`pappers-hall python: ${text.slice(-400)}`)
    })
    // A stopped worker must not fail requests that belong to its replacement:
    // the installer restarts the bridge right after `stop()`, and a late exit
    // event used to reject the new worker's readiness ping.
    const isCurrent = () => child === handle
    const failAll = (reason) => {
      if (!isCurrent()) return
      ready = false
      lastError = reason
      crashCount += 1
      for (const [id, entry] of pending) {
        pending.delete(id)
        clearTimeout(entry.timer)
        entry.reject(Object.assign(new Error(reason), { code: 'py_unavailable' }))
      }
    }
    handle.on('exit', (code) => { failAll(`worker exited (${code})`) })
    handle.on('error', (error) => { failAll(`worker error: ${error.message}`) })
  }

  /** Ensure a worker is running and its capabilities are known. */
  async function start() {
    if (ready) return
    if (starting !== null) return starting
    if (!installed()) throw Object.assign(new Error('python component is not installed'), { code: 'py_missing' })
    starting = (async () => {
      try {
        spawnWorker()
        const pong = await call('ping', {}, { timeoutMs: 90_000 })
        capabilities = { ...EMPTY_CAPABILITIES, ...(pong.capabilities ?? {}) }
        versions = pong.versions ?? {}
        ready = true
      } catch (error) {
        lastError = error.message
        try { child?.kill() } catch { /* already gone */ }
        child = null
        throw Object.assign(new Error(`python worker failed to start: ${error.message}`), { code: 'py_unavailable' })
      } finally {
        starting = null
      }
    })()
    return starting
  }

  /**
   * Send one request to the worker.
   * @param {string} op worker operation.
   * @param {object} [params] operation parameters.
   * @param {object} [options] call options.
   * @returns {Promise<object>} worker payload.
   */
  function call(op, params = {}, options = {}) {
    if (!child) return Promise.reject(Object.assign(new Error('python worker is not running'), { code: 'py_unavailable' }))
    const id = nextId++
    const limit = options.timeoutMs ?? timeoutMs
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id)
        reject(Object.assign(new Error(`python worker timed out after ${limit}ms (${op})`), { code: 'py_timeout' }))
      }, limit)
      pending.set(id, { resolve, reject, timer })
      try {
        child.stdin.write(JSON.stringify({ id, op, ...params }) + '\n')
      } catch (error) {
        clearTimeout(timer)
        pending.delete(id)
        reject(Object.assign(new Error(`python worker write failed: ${error.message}`), { code: 'py_unavailable' }))
      }
    })
  }

  /** Invoke one operation, starting the worker first. */
  async function invoke(op, params = {}, options = {}) {
    await start()
    return call(op, params, options)
  }

  /** Stop the worker (best effort). */
  function stop() {
    ready = false
    const current = child
    child = null
    try { current?.stdin.write('{"op":"shutdown"}\n') } catch { /* ignore */ }
    try { current?.kill() } catch { /* ignore */ }
    reader?.close()
    reader = null
  }

  return {
    pythonPath,
    venvDir,
    modelDir,
    layoutModel,
    ocrModelRoot,
    installed,
    venvBytes,
    start,
    stop,
    invoke,
    call,
    /** Capabilities discovered at start-up. */
    get capabilities() { return capabilities },
    /** Package versions reported by the worker. */
    get versions() { return versions },
    /** Last start/inference error, if any. */
    get lastError() { return lastError },
    /** Crash counter for diagnostics. */
    get crashCount() { return crashCount },
    /** Whether the worker is currently running. */
    get ready() { return ready },
  }
}
