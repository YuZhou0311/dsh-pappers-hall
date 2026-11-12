/**
 * Shared harness for the Pappers-Hall acceptance tests.
 *
 * This module is deliberately dependency-free: it only uses Node builtins
 * (`node:fs`, `node:crypto`, `node:http`'s global `fetch`, ...) so the whole
 * suite runs with a plain `node test/run-tests.mjs` and never touches the
 * plugin's runtime dependencies.
 *
 * It owns:
 * - workspace paths and CLI argument parsing,
 * - fixture loading (the devkit JSON inputs and `papers/manifest.json`),
 * - the same-origin HTTP client for `POST /pappers-hall/api` plus asset GETs,
 * - assertion/case recording with pass|fail|not_run and evidence,
 * - polling helpers for the asynchronous import queue,
 * - environment capture for `reports/test-results.json` / `reports/verify.md`.
 *
 * The suite files (import/search/annotations/lifecycle/toggle) import this
 * module; the fixtures validator lives in `fixtures.mjs`.
 *
 * @module pappers-hall/test/lib
 */
import { createHash } from 'node:crypto'
import { createReadStream, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { platform, arch, release } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { setTimeout as sleep } from 'node:timers/promises'

/* ------------------------------------------------------------------ */
/* Paths and defaults                                                  */
/* ------------------------------------------------------------------ */

/** Absolute directory of this file (`.../pappers-hall-plugin/test`). */
export const HERE = path.dirname(fileURLToPath(import.meta.url))
/** Plugin package root (`.../pappers-hall-plugin`). */
export const PLUGIN_ROOT = path.resolve(HERE, '..')
/** Team workspace root (`/Users/zhouyu/Project/Pappers-Hall`). */
export const WORKSPACE = path.resolve(PLUGIN_ROOT, '..')
/** Developer fixture bundle root (`.../pappers_hall_devkit_lite`). */
export const DEVKIT = path.join(WORKSPACE, 'pappers_hall_devkit_lite')
/** Fixture JSON directory. */
export const FIXTURES_DIR = path.join(DEVKIT, 'tests')
/** Papers directory (manifest + PDF files). */
export const PAPERS_DIR = path.join(DEVKIT, 'papers')
/** PDF directory the import test reads from. */
export const PDF_DIR = path.join(PAPERS_DIR, 'pdf')
/** Machine-readable paper inventory used as the import oracle. */
export const MANIFEST_FILE = path.join(PAPERS_DIR, 'manifest.json')
/** Deliverable reports directory (workspace root `reports/`). */
export const REPORTS_DIR = path.join(WORKSPACE, 'reports')
/** Test-private artifacts directory (maps, dry-run output, toggle state). */
export const ARTIFACTS_DIR = path.join(HERE, '.artifacts')

/** Version of the test harness itself; recorded in every report. */
export const HARNESS_VERSION = '1.0.0'
/** Version of the internal contract the assertions follow. */
export const CONTRACT_VERSION = '0.1'
/** Expected fixture case counts asserted by `--dry-run`. */
export const EXPECTED_COUNTS = Object.freeze({
  paperQueries: 60,
  seedAnnotations: 10,
  annotationQueries: 10,
  visualUnderstanding: 3,
  manifestPapers: 30,
  manifestFields: 5,
  papersPerField: 6,
})

/** Default HTTP API base; the running DSH Web GUI prints this in `DSH_WEB_URL`. */
export const DEFAULT_API_BASE = (process.env.PAPPERS_API_BASE ?? process.env.DSH_WEB_URL ?? 'http://127.0.0.1:54731').replace(/\/+$/, '')
/** Default DSH profile name for the environment record. */
export const DEFAULT_PROFILE = process.env.DSH_PROFILE ?? 'desktop'
/** Default request timeout for one JSON API call. */
export const DEFAULT_TIMEOUT_MS = Number(process.env.PAPPERS_HTTP_TIMEOUT_MS ?? 30_000)
/** Default budget for the 30-PDF import job (pdf text + layout + figure crops). */
export const DEFAULT_IMPORT_TIMEOUT_MS = Number(process.env.PAPPERS_IMPORT_TIMEOUT_MS ?? 30 * 60_000)

/* ------------------------------------------------------------------ */
/* CLI arguments                                                       */
/* ------------------------------------------------------------------ */

/**
 * Parse `--key=value` / `--key value` / `--flag` argv entries.
 * @param {string[]} argv raw process argv slice.
 * @returns {{positional:string[], flags:Record<string,string|boolean>}} parsed arguments.
 */
export function parseArgs(argv = process.argv.slice(2)) {
  const positional = []
  const flags = {}
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index]
    if (!token.startsWith('--')) {
      positional.push(token)
      continue
    }
    const body = token.slice(2)
    const eq = body.indexOf('=')
    if (eq >= 0) {
      flags[body.slice(0, eq)] = body.slice(eq + 1)
      continue
    }
    const next = argv[index + 1]
    if (next !== undefined && !next.startsWith('--')) {
      flags[body] = next
      index += 1
    } else {
      flags[body] = true
    }
  }
  return { positional, flags }
}

/**
 * Read one boolean CLI flag with a default.
 * @param {Record<string,string|boolean>} flags parsed flags.
 * @param {string} name flag name without dashes.
 * @param {boolean} fallback default when absent.
 * @returns {boolean} flag as boolean.
 */
export function flagBool(flags, name, fallback = false) {
  if (!Object.hasOwn(flags, name)) return fallback
  const value = flags[name]
  if (typeof value === 'boolean') return value
  return !['0', 'false', 'no', 'off'].includes(String(value).toLowerCase())
}

/**
 * Read one string CLI flag with a default.
 * @param {Record<string,string|boolean>} flags parsed flags.
 * @param {string} name flag name without dashes.
 * @param {string} fallback default when absent.
 * @returns {string} flag value.
 */
export function flagString(flags, name, fallback = '') {
  const value = flags[name]
  return typeof value === 'string' && value !== '' ? value : fallback
}

/**
 * Split a comma-separated CLI value into trimmed, non-empty entries.
 * @param {string} value raw value.
 * @returns {string[]} entries.
 */
export function splitList(value) {
  if (typeof value !== 'string' || value.trim() === '') return []
  return value
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry !== '')
}

/**
 * Parse one positive integer CLI value with a default.
 * @param {Record<string,string|boolean>} flags parsed flags.
 * @param {string} name flag name.
 * @param {number} fallback default.
 * @returns {number} integer value.
 */
export function flagInt(flags, name, fallback) {
  const value = flags[name]
  if (typeof value !== 'string' || value.trim() === '') return fallback
  const parsed = Number(value)
  return Number.isFinite(parsed) && parsed >= 0 ? Math.floor(parsed) : fallback
}

/* ------------------------------------------------------------------ */
/* Small filesystem / JSON helpers                                     */
/* ------------------------------------------------------------------ */

/**
 * Read and parse one JSON file with a readable error.
 * @param {string} filePath absolute path.
 * @param {string} [label] human label used in errors.
 * @returns {any} parsed JSON.
 */
export function readJsonFile(filePath, label = filePath) {
  let raw
  try {
    raw = readFileSync(filePath, 'utf8')
  } catch (error) {
    throw new Error(`cannot read ${label}: ${String(error?.message ?? error)}`)
  }
  try {
    return JSON.parse(raw)
  } catch (error) {
    throw new Error(`${label} is not valid JSON: ${String(error?.message ?? error)}`)
  }
}

/**
 * Read one JSON file, returning `undefined` when it does not exist.
 * @param {string} filePath absolute path.
 * @returns {any|undefined} parsed JSON or undefined.
 */
export function readJsonIfExists(filePath) {
  if (!existsSync(filePath)) return undefined
  try {
    return readJsonFile(filePath)
  } catch {
    return undefined
  }
}

/**
 * Create one directory (recursively) when missing.
 * @param {string} dir absolute directory path.
 * @returns {string} the same path.
 */
export function ensureDir(dir) {
  mkdirSync(dir, { recursive: true })
  return dir
}

/**
 * Write one pretty-printed JSON file, creating parent directories.
 * @param {string} filePath absolute path.
 * @param {unknown} value JSON-serializable value.
 * @returns {string} the written path.
 */
export function writeJsonFile(filePath, value) {
  ensureDir(path.dirname(filePath))
  writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
  return filePath
}

/**
 * Write one UTF-8 text file, creating parent directories.
 * @param {string} filePath absolute path.
 * @param {string} text content.
 * @returns {string} the written path.
 */
export function writeTextFile(filePath, text) {
  ensureDir(path.dirname(filePath))
  writeFileSync(filePath, text, 'utf8')
  return filePath
}

/**
 * Path inside the private artifacts directory.
 * @param {string} name file name.
 * @returns {string} absolute path.
 */
export function artifactPath(name) {
  ensureDir(ARTIFACTS_DIR)
  return path.join(ARTIFACTS_DIR, name)
}

/**
 * Path inside the workspace reports directory.
 * @param {string} name file name.
 * @returns {string} absolute path.
 */
export function reportPath(name) {
  return path.join(REPORTS_DIR, name)
}

/**
 * SHA-256 of one file, streamed so large PDFs do not load into memory.
 * @param {string} filePath absolute path.
 * @returns {Promise<string>} lowercase hex digest.
 */
export function sha256File(filePath) {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256')
    const stream = createReadStream(filePath)
    stream.on('data', (chunk) => hash.update(chunk))
    stream.on('end', () => resolve(hash.digest('hex')))
    stream.on('error', reject)
  })
}

/**
 * Byte size of one file, or null when it does not exist.
 * @param {string} filePath absolute path.
 * @returns {number|null} size in bytes.
 */
export function fileSize(filePath) {
  try {
    const info = statSync(filePath)
    return info.isFile() ? info.size : null
  } catch {
    return null
  }
}

/**
 * List regular files in one directory, sorted.
 * @param {string} dir directory path.
 * @returns {string[]} file names.
 */
export function listFiles(dir) {
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isFile())
      .map((entry) => entry.name)
      .sort()
  } catch {
    return []
  }
}

/* ------------------------------------------------------------------ */
/* Fixtures                                                            */
/* ------------------------------------------------------------------ */

/**
 * Load every acceptance fixture with structural cross-references attached.
 *
 * The return value is intentionally rich: suites read the raw arrays plus the
 * derived maps so no suite re-implements manifest lookups.
 * @returns {object} loaded fixtures.
 */
export function loadFixtures() {
  const manifest = readJsonFile(MANIFEST_FILE, 'papers/manifest.json')
  const queries = readJsonFile(path.join(FIXTURES_DIR, 'queries.json'), 'tests/queries.json')
  const seedAnnotations = readJsonFile(path.join(FIXTURES_DIR, 'seed_annotations.json'), 'tests/seed_annotations.json')
  const annotationQueries = readJsonFile(path.join(FIXTURES_DIR, 'annotation_queries.json'), 'tests/annotation_queries.json')
  const visualUnderstanding = readJsonFile(path.join(FIXTURES_DIR, 'visual_understanding.json'), 'tests/visual_understanding.json')
  const metadataCases = readJsonFile(path.join(FIXTURES_DIR, 'metadata_cases.json'), 'tests/metadata_cases.json')
  const papers = Array.isArray(manifest.papers) ? manifest.papers : []
  const manifestById = new Map(papers.map((paper) => [paper.id, paper]))
  const manifestBySha = new Map()
  for (const paper of papers) {
    if (typeof paper.sha256 === 'string' && paper.sha256.length > 0) manifestBySha.set(paper.sha256.toLowerCase(), paper)
  }
  const queryList = Array.isArray(queries.queries) ? queries.queries : []
  const seedList = Array.isArray(seedAnnotations.annotations) ? seedAnnotations.annotations : []
  const annotationQueryList = Array.isArray(annotationQueries.queries) ? annotationQueries.queries : []
  const visualList = Array.isArray(visualUnderstanding.queries) ? visualUnderstanding.queries : []
  return {
    manifest,
    papers,
    manifestById,
    manifestBySha,
    queries,
    queryList,
    queryById: new Map(queryList.map((query) => [query.id, query])),
    seedAnnotations,
    seedList,
    seedById: new Map(seedList.map((annotation) => [annotation.id, annotation])),
    annotationQueries,
    annotationQueryList,
    annotationQueryById: new Map(annotationQueryList.map((query) => [query.id, query])),
    visualUnderstanding,
    visualList,
    metadataCases,
  }
}

/**
 * Expected 1-based physical PDF page of one query.
 * @param {object} query query fixture.
 * @returns {number|null} page number.
 */
export function queryPage(query) {
  const page = query?.source_anchor?.pdf_page
  return Number.isInteger(page) && page >= 1 ? page : null
}

/**
 * Figure labels mentioned by one query anchor, split from expressions such as
 * `Figure 2 and Figure 3`.
 * @param {object} query query fixture.
 * @returns {string[]} raw labels.
 */
export function queryFigureLabels(query) {
  const figure = query?.source_anchor?.figure
  if (typeof figure !== 'string' || figure.trim() === '') return []
  return figure
    .split(/\s*(?:,|、|and|&)\s*/i)
    .map((label) => label.trim())
    .filter((label) => label !== '')
}

/**
 * Normalize one figure label for tolerant comparison (`Fig. 1` == `Figure 1`).
 * @param {string} label raw label.
 * @returns {string} normalized label.
 */
export function normalizeFigureLabel(label) {
  const text = String(label ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '')
  if (text === '') return ''
  const numbered = /^(?:fig(?:ure)?)(\d+)$/.exec(text)
  return numbered === null ? text : `figure${numbered[1]}`
}

/**
 * Whether two figure labels refer to the same numbered figure.
 * @param {string} actual label returned by the plugin.
 * @param {string} expected label from the fixture.
 * @returns {boolean} true when equivalent.
 */
export function figureLabelsMatch(actual, expected) {
  const left = normalizeFigureLabel(actual)
  const right = normalizeFigureLabel(expected)
  return left !== '' && left === right
}

/**
 * Convert fixture paper ids (A01, R02, ...) into production paper ids.
 * @param {Map<string,string>} paperMap fixture id -> production id.
 * @param {string[]} fixtureIds expected fixture ids.
 * @returns {string[]} production ids that exist.
 */
export function productionIds(paperMap, fixtureIds) {
  const ids = []
  for (const fixtureId of fixtureIds ?? []) {
    const productionId = paperMap.get(fixtureId)
    if (typeof productionId === 'string') ids.push(productionId)
  }
  return ids
}

/**
 * Truncate an arbitrary value for report evidence.
 * @param {unknown} value value to clip.
 * @param {number} [maxChars] maximum length.
 * @returns {string} clipped text.
 */
export function clip(value, maxChars = 400) {
  let text
  if (typeof value === 'string') text = value
  else {
    try {
      text = JSON.stringify(value)
    } catch {
      text = String(value)
    }
  }
  if (text === undefined) return ''
  return text.length <= maxChars ? text : `${text.slice(0, maxChars)}…(${text.length} chars)`
}

/**
 * Cheap deep equality for JSON values (used on idempotent responses).
 * @param {unknown} left first value.
 * @param {unknown} right second value.
 * @returns {boolean} deep equality.
 */
export function deepEqual(left, right) {
  return JSON.stringify(left) === JSON.stringify(right)
}

/* ------------------------------------------------------------------ */
/* HTTP client                                                         */
/* ------------------------------------------------------------------ */

/** One structured failure from the plugin API. */
export class ApiError extends Error {
  /**
   * @param {string} code contract error code (`not_found`, `invalid`, ...).
   * @param {string} message human message.
   * @param {object} [options] extra context.
   * @param {string} [options.method] wire method that failed.
   * @param {number} [options.httpStatus] HTTP status observed.
   * @param {unknown} [options.detail] structured detail.
   */
  constructor(code, message, options = {}) {
    super(message)
    this.name = 'ApiError'
    this.code = code
    this.method = options.method ?? ''
    this.httpStatus = options.httpStatus ?? 0
    this.detail = options.detail
  }
}

/** One polling timeout with the last observed value attached. */
export class TimeoutError extends Error {
  /**
   * @param {string} message human message.
   * @param {unknown} [lastValue] last polled sample.
   */
  constructor(message, lastValue) {
    super(message)
    this.name = 'TimeoutError'
    this.lastValue = lastValue
  }
}

/** Whether one thrown value is a network-level connection failure. */
function isConnectionFailure(error) {
  const code = error?.cause?.code ?? error?.code ?? ''
  return ['ECONNREFUSED', 'ECONNRESET', 'EPIPE', 'EHOSTUNREACH', 'ENETUNREACH', 'UND_ERR_SOCKET'].includes(code)
}

/** Parse a response body as JSON, returning undefined on failure. */
function parseJsonBody(text) {
  if (typeof text !== 'string' || text.trim() === '') return undefined
  try {
    return JSON.parse(text)
  } catch {
    return undefined
  }
}

/**
 * Same-origin client for the Pappers-Hall HTTP surface.
 *
 * Contract §2: `POST /pappers-hall/api` with `{method, params}` and an
 * `{ok:true,data}` / `{ok:false,error}` envelope; GET routes serve page/figure/
 * thumbnail/PDF assets. Named routes are not behind the DSH index cookie, so a
 * plain localhost client can drive the same API the Web Client uses.
 */
export class PappersClient {
  /**
   * @param {object} [options] client options.
   * @param {string} [options.baseUrl] DSH Web GUI root, e.g. http://127.0.0.1:54731.
   * @param {number} [options.timeoutMs] one JSON call timeout.
   * @param {number} [options.retries] connection-failure retries.
   */
  constructor(options = {}) {
    this.baseUrl = String(options.baseUrl ?? DEFAULT_API_BASE).replace(/\/+$/, '')
    this.apiUrl = `${this.baseUrl}/pappers-hall/api`
    this.timeoutMs = Number(options.timeoutMs ?? DEFAULT_TIMEOUT_MS)
    this.retries = Number(options.retries ?? 2)
    /** @type {Array<{at:string, method:string, httpStatus:number, code?:string, ms:number}>} */
    this.log = []
  }

  /**
   * One POST to the JSON API, returning the raw transport result.
   * @param {string} method wire method.
   * @param {object} [params] params object.
   * @param {{timeoutMs?:number, retries?:number}} [options] per-call overrides.
   * @returns {Promise<{httpStatus:number, body:any, text:string, ms:number}>} transport result.
   */
  async post(method, params = {}, options = {}) {
    const timeoutMs = Number(options.timeoutMs ?? this.timeoutMs)
    const retries = Number(options.retries ?? this.retries)
    const startedAt = Date.now()
    let lastError
    for (let attempt = 0; attempt <= retries; attempt += 1) {
      try {
        const response = await fetch(this.apiUrl, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ method, params }),
          signal: AbortSignal.timeout(timeoutMs),
        })
        const text = await response.text()
        return { httpStatus: response.status, body: parseJsonBody(text), text, ms: Date.now() - startedAt }
      } catch (error) {
        lastError = error
        const retryable = isConnectionFailure(error) || error?.name === 'TimeoutError'
        if (!retryable || attempt >= retries) break
        await sleep(250 * (attempt + 1))
      }
    }
    const elapsed = Date.now() - startedAt
    const code = isConnectionFailure(lastError) ? 'connection_refused' : lastError?.name === 'TimeoutError' ? 'timeout' : 'network_error'
    throw new ApiError(code, `POST ${method} failed: ${String(lastError?.message ?? lastError)}`, {
      method,
      httpStatus: 0,
    })
  }

  /**
   * Call one JSON API method and unwrap the `data` envelope.
   * @param {string} method wire method.
   * @param {object} [params] params object.
   * @param {{timeoutMs?:number, retries?:number}} [options] per-call overrides.
   * @returns {Promise<any>} the `data` payload.
   */
  async call(method, params = {}, options = {}) {
    const startedAt = Date.now()
    const result = await this.post(method, params, options)
    const body = result.body
    if (body !== undefined && body !== null && typeof body === 'object' && body.ok === true) {
      this.log.push({ at: new Date().toISOString(), method, httpStatus: result.httpStatus, code: 'ok', ms: result.ms })
      return body.data
    }
    if (body !== undefined && body !== null && typeof body === 'object' && body.ok === false) {
      const error = body.error ?? {}
      this.log.push({ at: new Date().toISOString(), method, httpStatus: result.httpStatus, code: String(error.code ?? 'unknown'), ms: result.ms })
      throw new ApiError(String(error.code ?? 'unknown'), String(error.message ?? `method ${method} failed`), {
        method,
        httpStatus: result.httpStatus,
        detail: error.detail,
      })
    }
    // Tolerate a bare JSON payload (older host builds) but never a non-JSON body.
    if (body !== undefined && result.httpStatus >= 200 && result.httpStatus < 300) {
      this.log.push({ at: new Date().toISOString(), method, httpStatus: result.httpStatus, code: 'ok-bare', ms: result.ms })
      return body
    }
    this.log.push({ at: new Date().toISOString(), method, httpStatus: result.httpStatus, code: 'non_json', ms: result.ms })
    throw new ApiError(`http_${result.httpStatus}`, `method ${method} returned HTTP ${result.httpStatus} (${clip(result.text, 160)})`, {
      method,
      httpStatus: result.httpStatus,
    })
  }

  /**
   * Call one JSON API method and capture success/failure without throwing.
   * @param {string} method wire method.
   * @param {object} [params] params object.
   * @param {{timeoutMs?:number}} [options] per-call overrides.
   * @returns {Promise<{ok:boolean, data?:any, error?:ApiError, httpStatus?:number, ms:number}>} result.
   */
  async tryCall(method, params = {}, options = {}) {
    const startedAt = Date.now()
    try {
      const data = await this.call(method, params, options)
      return { ok: true, data, ms: Date.now() - startedAt }
    } catch (error) {
      return {
        ok: false,
        error: error instanceof ApiError ? error : new ApiError('internal', String(error?.message ?? error), { method }),
        httpStatus: error?.httpStatus ?? 0,
        ms: Date.now() - startedAt,
      }
    }
  }

  /**
   * GET one absolute or root-relative asset path.
   * @param {string} target `/pappers-hall/...` or absolute URL.
   * @param {{timeoutMs?:number}} [options] per-call overrides.
   * @returns {Promise<{httpStatus:number, contentType:string, bytes:number, sha256:string, headers:Headers, text?:string}>} asset result.
   */
  async getAsset(target, options = {}) {
    const url = /^https?:\/\//i.test(target) ? target : `${this.baseUrl}${target.startsWith('/') ? '' : '/'}${target}`
    const response = await fetch(url, { signal: AbortSignal.timeout(Number(options.timeoutMs ?? this.timeoutMs)) })
    const buffer = Buffer.from(await response.arrayBuffer())
    const contentType = response.headers.get('content-type') ?? ''
    const result = {
      httpStatus: response.status,
      contentType,
      bytes: buffer.length,
      sha256: createHash('sha256').update(buffer).digest('hex'),
      headers: response.headers,
    }
    if (!contentType.startsWith('image/') && !contentType.startsWith('application/pdf')) result.text = clip(buffer.toString('utf8'), 240)
    return result
  }

  /**
   * Probe the plugin route: `GET /pappers-hall/` answers with a JSON marker when
   * the plugin route is registered (contract §2 prefix handler).
   * @returns {Promise<{registered:boolean, httpStatus:number, body?:any}>} probe result.
   */
  async probeRoute() {
    try {
      const response = await fetch(`${this.baseUrl}/pappers-hall/`, { signal: AbortSignal.timeout(this.timeoutMs) })
      const text = await response.text()
      const body = parseJsonBody(text)
      const registered = response.status === 200 && body !== undefined && body.ok === true && body.data?.plugin === 'dsh-pappers-hall'
      return { registered, httpStatus: response.status, body }
    } catch (error) {
      return { registered: false, httpStatus: 0, body: { error: String(error?.message ?? error) } }
    }
  }

  /**
   * GET one native DSH static resource (public, no index cookie), used as a
   * GUI-alive probe that does not depend on the plugin route.
   * @param {string} target root-relative path, e.g. `/plugins/.../client.js`.
   * @param {{timeoutMs?:number}} [options] per-call overrides.
   * @returns {Promise<{httpStatus:number, contentType:string, bytes:number}>} probe result (status 0 on network failure).
   */
  async probeStatic(target, options = {}) {
    const url = `${this.baseUrl}${target.startsWith('/') ? '' : '/'}${target}`
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(Number(options.timeoutMs ?? this.timeoutMs)) })
      const buffer = Buffer.from(await response.arrayBuffer())
      return { httpStatus: response.status, contentType: response.headers.get('content-type') ?? '', bytes: buffer.length }
    } catch (error) {
      return { httpStatus: 0, contentType: '', bytes: 0, error: String(error?.message ?? error) }
    }
  }

  /**
   * Observe the plugin HTTP surface for enable/disable evidence.
   *
   * Three independent observations:
   * - `route`: `GET /pappers-hall/` — the plugin prefix handler answers a JSON
   *   marker while mounted (contract §2). Without the plugin, the Web SPA
   *   fallback answers 404 (GET).
   * - `apiPost`: `POST /pappers-hall/api {status}` — a live plugin answers a
   *   JSON envelope (HTTP 200 `{ok:true}`); an unmounted plugin falls through to
   *   the SPA fallback which rejects POST with 405 (never a plugin envelope).
   * - `gui`: one native public static asset — 200 proves the DSH GUI itself is
   *   healthy while the plugin is off (contract §7.5: native DSH unaffected).
   * @returns {Promise<object>} surface observation.
   */
  async pluginSurface() {
    const route = await this.probeRoute()
    const apiPost = await this.post('status', {}, { retries: 1 })
    const apiPostJson = apiPost.body !== undefined && apiPost.body !== null && typeof apiPost.body === 'object'
    const apiPostEnvelope = apiPostJson && (apiPost.body.ok === true || apiPost.body.ok === false)
    // `/favicon.svg` is a public frontend-static asset (no cookie) and proves
    // the native Web GUI server is healthy independently of the plugin.
    const gui = await this.probeStatic('/favicon.svg', { timeoutMs: 10_000 })
    return {
      at: new Date().toISOString(),
      base_url: this.baseUrl,
      route: { httpStatus: route.httpStatus, plugin_marker: route.registered, body: clip(route.body, 240) },
      api_post: {
        httpStatus: apiPost.httpStatus,
        json_envelope: apiPostEnvelope,
        body: clip(apiPost.body ?? apiPost.text, 240),
      },
      gui_static: gui,
    }
  }

  /**
   * Call `status` and capture failure instead of throwing (preflight helper).
   * @returns {Promise<{ok:true, data:any}|{ok:false, error:ApiError}>} status probe.
   */
  async status() {
    const result = await this.tryCall('status')
    return result.ok ? { ok: true, data: result.data } : { ok: false, error: result.error }
  }
}

/* ------------------------------------------------------------------ */
/* Assertions and the case recorder                                    */
/* ------------------------------------------------------------------ */

/**
 * Build one assertion record.
 * @param {string} name assertion name.
 * @param {boolean} ok whether it passed.
 * @param {unknown} [expected] expected value.
 * @param {unknown} [actual] actual value.
 * @param {string} [detail] extra diagnostic.
 * @returns {{name:string, ok:boolean, expected?:unknown, actual?:unknown, detail?:string}} assertion.
 */
export function check(name, ok, expected, actual, detail) {
  return {
    name,
    ok: ok === true,
    ...(expected === undefined ? {} : { expected }),
    ...(actual === undefined ? {} : { actual }),
    ...(detail === undefined ? {} : { detail }),
  }
}

/**
 * Assemble assertion records into one case and append it to the recorder.
 *
 * Status rules: `statusOverride` wins; otherwise `not_run` when there are no
 * assertions, `pass` when every assertion passed, `fail` otherwise.
 */
export class Recorder {
  /**
   * @param {{runId:string, suite?:string}} options recorder options.
   */
  constructor(options = {}) {
    this.runId = options.runId ?? new Date().toISOString()
    /** @type {object[]} */
    this.cases = []
    this.startedAt = new Date().toISOString()
  }

  /**
   * Start one timed case handle.
   * @param {{suite:string, caseId:string, kind?:string, title:string, input?:unknown, expected?:unknown}} spec case spec.
   * @returns {object} case handle to pass to {@link Recorder.end}.
   */
  begin(spec) {
    return {
      suite: spec.suite,
      case_id: spec.caseId,
      kind: spec.kind ?? 'api',
      title: spec.title,
      input: spec.input,
      expected: spec.expected,
      started_at: new Date().toISOString(),
      started_ms: Date.now(),
    }
  }

  /**
   * Finish one case.
   * @param {object} handle handle from {@link Recorder.begin}.
   * @param {object} result finish payload.
   * @param {Array<object>} [result.assertions] assertion records.
   * @param {unknown} [result.actual] observed value.
   * @param {unknown} [result.evidence] evidence payload.
   * @param {string} [result.notes] human notes.
   * @param {string} [result.status] explicit pass|fail|not_run.
   * @param {string} [result.reason] not_run reason.
   * @returns {object} the recorded case.
   */
  end(handle, result = {}) {
    const assertions = Array.isArray(result.assertions) ? result.assertions : []
    let status = result.status
    if (status === undefined) {
      if (assertions.length === 0) status = 'not_run'
      else status = assertions.every((assertion) => assertion.ok) ? 'pass' : 'fail'
    }
    const recorded = {
      case_id: handle.case_id,
      suite: handle.suite,
      kind: handle.kind,
      title: handle.title,
      started_at: handle.started_at,
      duration_ms: Date.now() - handle.started_ms,
      status,
      ...(handle.input === undefined ? {} : { input: handle.input }),
      ...(handle.expected === undefined ? {} : { expected: handle.expected }),
      ...(result.actual === undefined ? {} : { actual: result.actual }),
      assertions,
      ...(result.evidence === undefined ? {} : { evidence: result.evidence }),
      ...(result.notes === undefined ? {} : { notes: result.notes }),
      ...(result.reason === undefined ? {} : { reason: result.reason }),
    }
    this.cases.push(recorded)
    return recorded
  }

  /**
   * Record a case that could not be executed.
   * @param {{suite:string, caseId:string, kind?:string, title:string, input?:unknown, expected?:unknown}} spec case spec.
   * @param {string} reason why it was not run.
   * @param {unknown} [evidence] optional evidence.
   * @returns {object} the recorded case.
   */
  skip(spec, reason, evidence) {
    return this.end(this.begin(spec), { status: 'not_run', reason, evidence })
  }

  /**
   * Record one case whose body threw.
   * @param {object} handle case handle.
   * @param {Error|unknown} error thrown value.
   * @param {unknown} [evidence] optional evidence.
   * @returns {object} the recorded case.
   */
  crash(handle, error, evidence) {
    return this.end(handle, {
      status: 'fail',
      actual: { error: String(error?.message ?? error), code: error?.code ?? undefined },
      evidence,
    })
  }

  /**
   * Aggregate summary over all recorded cases.
   * @returns {{total:number, pass:number, fail:number, not_run:number, pass_rate:number, by_suite:Record<string,object>}} summary.
   */
  summary() {
    return summarizeCases(this.cases)
  }
}

/**
 * Aggregate pass/fail/not_run counts, total and per suite.
 * @param {object[]} cases recorded cases.
 * @returns {{total:number, pass:number, fail:number, not_run:number, pass_rate:number, by_suite:Record<string,object>}} summary.
 */
export function summarizeCases(cases) {
  const summary = { total: 0, pass: 0, fail: 0, not_run: 0, pass_rate: 0, by_suite: {} }
  for (const testCase of cases) {
    summary.total += 1
    const suite = testCase.suite ?? 'unknown'
    if (!Object.hasOwn(summary.by_suite, suite)) summary.by_suite[suite] = { total: 0, pass: 0, fail: 0, not_run: 0 }
    const bucket = summary.by_suite[suite]
    bucket.total += 1
    if (testCase.status === 'pass') {
      summary.pass += 1
      bucket.pass += 1
    } else if (testCase.status === 'fail') {
      summary.fail += 1
      bucket.fail += 1
    } else {
      summary.not_run += 1
      bucket.not_run += 1
    }
  }
  const executed = summary.pass + summary.fail
  summary.pass_rate = executed === 0 ? 0 : Math.round((summary.pass / executed) * 1000) / 1000
  return summary
}

/**
 * Format a duration for console output.
 * @param {number} milliseconds duration.
 * @returns {string} human string.
 */
export function fmtDuration(milliseconds) {
  if (!Number.isFinite(milliseconds) || milliseconds < 0) return 'n/a'
  if (milliseconds < 1000) return `${milliseconds}ms`
  if (milliseconds < 60_000) return `${(milliseconds / 1000).toFixed(1)}s`
  const minutes = Math.floor(milliseconds / 60_000)
  const seconds = Math.round((milliseconds % 60_000) / 1000)
  return `${minutes}m${String(seconds).padStart(2, '0')}s`
}

/**
 * Format one status line for console output.
 * @param {object} testCase recorded case.
 * @returns {string} line.
 */
export function formatCaseLine(testCase) {
  const bad = testCase.assertions.filter((assertion) => !assertion.ok)
  const detail =
    testCase.status === 'not_run'
      ? testCase.reason ?? ''
      : bad.length > 0
        ? bad.map((assertion) => `${assertion.name}: expected ${clip(assertion.expected, 80)} got ${clip(assertion.actual, 80)}`).join('; ')
        : ''
  return `[${testCase.status.toUpperCase().padEnd(7)}] ${testCase.case_id} ${testCase.title} (${fmtDuration(testCase.duration_ms)})${detail === '' ? '' : ` — ${clip(detail, 240)}`}`
}

/* ------------------------------------------------------------------ */
/* Polling                                                             */
/* ------------------------------------------------------------------ */

/**
 * Poll an async predicate until it reports done or the timeout elapses.
 * @param {() => Promise<{done:boolean, value:any}>} probe polled function.
 * @param {{timeoutMs:number, intervalMs?:number, label?:string}} options polling options.
 * @returns {Promise<any>} the value from the first `done` probe.
 */
export async function pollUntil(probe, options) {
  const timeoutMs = Number(options.timeoutMs)
  const intervalMs = Number(options.intervalMs ?? 500)
  const deadline = Date.now() + timeoutMs
  let last
  for (;;) {
    last = await probe()
    if (last?.done === true) return last.value
    if (Date.now() >= deadline) {
      throw new TimeoutError(`timed out after ${fmtDuration(timeoutMs)} waiting for ${options.label ?? 'condition'}`, last?.value)
    }
    await sleep(Math.min(intervalMs, Math.max(50, deadline - Date.now())))
  }
}

/** Job states that mean the queue will not change it again. */
export const TERMINAL_JOB_STATES = new Set(['succeeded', 'failed', 'cancelled'])

/**
 * Poll `jobs.list` until every requested job reached a terminal state.
 * @param {PappersClient} client API client.
 * @param {string[]} jobIds job ids to wait for.
 * @param {{timeoutMs?:number, intervalMs?:number, onTick?:(snapshot:object)=>void}} options polling options.
 * @returns {Promise<{jobs:object[], timeline:object[], timedOut:boolean, lastSnapshot:object}>} final snapshot.
 */
export async function waitForJobs(client, jobIds, options = {}) {
  const timeoutMs = Number(options.timeoutMs ?? DEFAULT_IMPORT_TIMEOUT_MS)
  const intervalMs = Number(options.intervalMs ?? 1000)
  const wanted = new Set(jobIds)
  const timeline = []
  try {
    const jobs = await pollUntil(
      async () => {
        const result = await client.call('jobs.list')
        const items = Array.isArray(result?.items) ? result.items : []
        const watched = items.filter((job) => wanted.has(job.id))
        const summary = result?.summary ?? {}
        const snapshot = {
          at: new Date().toISOString(),
          watched: watched.map((job) => ({
            id: job.id,
            state: job.state,
            attempts: job.attempts,
            progress: job.progress,
            error: job.error ?? null,
          })),
          summary,
        }
        timeline.push(snapshot)
        options.onTick?.(snapshot)
        const done = watched.length === wanted.size && watched.every((job) => TERMINAL_JOB_STATES.has(job.state))
        return { done, value: { jobs: watched, summary, items } }
      },
      { timeoutMs, intervalMs, label: `import job(s) ${jobIds.join(',')}` },
    )
    return { ...jobs, timeline, timedOut: false }
  } catch (error) {
    if (error instanceof TimeoutError) {
      const last = error.lastValue ?? { jobs: [], summary: {}, items: [] }
      timeline.push({ at: new Date().toISOString(), timeout: true, watched: last.jobs ?? [], summary: last.summary ?? {} })
      return { jobs: last.jobs ?? [], summary: last.summary ?? {}, timeline, timedOut: true }
    }
    throw error
  }
}

/**
 * Poll the library until every paper accepted by an import job left the
 * `pending` processing state.
 * @param {PappersClient} client API client.
 * @param {string[]} paperIds production paper ids.
 * @param {{timeoutMs?:number, intervalMs?:number}} options polling options.
 * @returns {Promise<{papers:Map<string,object>, timedOut:boolean, snapshots:object[]}>} final per-paper state.
 */
export async function waitForProcessing(client, paperIds, options = {}) {
  const timeoutMs = Number(options.timeoutMs ?? DEFAULT_IMPORT_TIMEOUT_MS)
  const intervalMs = Number(options.intervalMs ?? 1000)
  const wanted = new Set(paperIds)
  const snapshots = []
  try {
    const papers = await pollUntil(
      async () => {
        const result = await client.call('library.list', { state: 'all', limit: 200 })
        const items = Array.isArray(result?.items) ? result.items : []
        const watched = items.filter((item) => wanted.has(item.id))
        const states = watched.map((item) => ({ id: item.id, state: item.processing?.state ?? 'unknown' }))
        snapshots.push({ at: new Date().toISOString(), states })
        const done =
          watched.length === wanted.size &&
          watched.every((item) => {
            const state = item.processing?.state
            return state === 'ready' || state === 'partial' || state === 'failed'
          })
        return { done, value: new Map(watched.map((item) => [item.id, item])) }
      },
      { timeoutMs, intervalMs, label: 'paper processing' },
    )
    return { papers, timedOut: false, snapshots }
  } catch (error) {
    if (error instanceof TimeoutError) {
      return { papers: new Map(), timedOut: true, snapshots }
    }
    throw error
  }
}

/* ------------------------------------------------------------------ */
/* Library resolution                                                  */
/* ------------------------------------------------------------------ */

/**
 * Load every paper in the plugin library (active and trash) and map the 30
 * manifest fixtures onto their production records by SHA-256.
 *
 * SHA-256 is the only durable identity shared by `papers/manifest.json` and the
 * plugin's `PaperSummary`; titles are tolerated to differ, hashes are not.
 * @param {PappersClient} client API client.
 * @param {object} fixtures loaded fixtures.
 * @returns {Promise<object>} resolution result.
 */
export async function resolveLibrary(client, fixtures) {
  const items = []
  let offset = 0
  for (;;) {
    const page = await client.call('library.list', { state: 'all', limit: 200, offset })
    const pageItems = Array.isArray(page?.items) ? page.items : []
    items.push(...pageItems)
    const total = Number(page?.total ?? items.length)
    if (pageItems.length === 0 || items.length >= total) break
    offset += pageItems.length
  }
  const bySha = new Map()
  const duplicatesBySha = new Map()
  for (const item of items) {
    const sha = typeof item.sha256 === 'string' ? item.sha256.toLowerCase() : ''
    if (sha === '') continue
    if (bySha.has(sha)) {
      const list = duplicatesBySha.get(sha) ?? [bySha.get(sha)]
      list.push(item)
      duplicatesBySha.set(sha, list)
    } else {
      bySha.set(sha, item)
    }
  }
  const byFixture = new Map()
  const missing = []
  for (const paper of fixtures.papers) {
    const item = bySha.get(String(paper.sha256 ?? '').toLowerCase())
    if (item === undefined) missing.push(paper.id)
    else byFixture.set(paper.id, item)
  }
  const paperMap = new Map([...byFixture].map(([fixtureId, item]) => [fixtureId, item.id]))
  const active = items.filter((item) => item.state === 'active')
  const trash = items.filter((item) => item.state === 'trash')
  return {
    items,
    active,
    trash,
    bySha,
    byFixture,
    paperMap,
    missing,
    duplicatesBySha,
    counts: { total: items.length, active: active.length, trash: trash.length, fixturesMatched: byFixture.size },
  }
}

/**
 * Fetch the version id bound to the current PDF of one paper.
 * @param {PappersClient} client API client.
 * @param {string} paperId production paper id.
 * @returns {Promise<{versionId:string|null, sha256:string|null, pageCount:number|null, detail:object|null}>} version facts.
 */
export async function paperVersion(client, paperId) {
  try {
    const detail = await client.call('library.get', { id: paperId })
    const versions = Array.isArray(detail?.versions) ? detail.versions : []
    const current = versions[0] ?? null
    return {
      versionId: typeof current?.id === 'string' ? current.id : null,
      sha256: typeof current?.sha256 === 'string' ? current.sha256 : detail?.sha256 ?? null,
      pageCount: Number.isFinite(current?.pageCount) ? current.pageCount : Number.isFinite(detail?.pageCount) ? detail.pageCount : null,
      detail,
    }
  } catch {
    return { versionId: null, sha256: null, pageCount: null, detail: null }
  }
}

/**
 * Resolve the shared library mapping once per run and cache it on the context.
 * @param {{client:PappersClient, fixtures:object, state:object}} ctx suite context.
 * @returns {Promise<object>} resolution result from {@link resolveLibrary}.
 */
export async function prepareLibrary(ctx) {
  if (ctx.state.library !== undefined) return ctx.state.library
  const library = await resolveLibrary(ctx.client, ctx.fixtures)
  ctx.state.library = library
  return library
}

/** Thrown when a suite cannot start because the plugin API is unreachable. */
export class PreflightError extends Error {
  /**
   * @param {string} message human message.
   * @param {unknown} [cause] underlying failure.
   */
  constructor(message, cause) {
    super(message)
    this.name = 'PreflightError'
    this.cause = cause
  }
}

/**
 * Verify the plugin API answers `status` before a suite spends time on cases.
 * @param {PappersClient} client API client.
 * @returns {Promise<object>} the plugin status payload.
 * @throws {PreflightError} when the API is unreachable or not the plugin route.
 */
export async function requirePluginStatus(client) {
  const probe = await client.status()
  if (!probe.ok) {
    throw new PreflightError(
      `plugin API unreachable at ${client.apiUrl}: ${probe.error?.code ?? 'unknown'} — ${probe.error?.message ?? ''}`,
      probe.error,
    )
  }
  const status = probe.data
  if (status?.plugin?.id !== 'dsh-pappers-hall' || status?.plugin?.enabled !== true) {
    throw new PreflightError(`unexpected status.plugin payload: ${clip(status?.plugin, 200)}`)
  }
  return status
}

/**
 * Standalone CLI runner shared by the five suite files.
 *
 * `node test/<suite>.mjs [--api-base=...] [--dry-run]` runs just that suite
 * against the live plugin, writes `test/.artifacts/<suite>.json`, and exits 0
 * only when the suite recorded no failure.
 * @param {{suite:string, run:(ctx:object)=>Promise<object>, planned?:object}} spec runner spec.
 * @returns {Promise<number>} exit code.
 */
export async function runSuiteCli(spec) {
  const { flags } = parseArgs()
  if (flagBool(flags, 'dry-run')) {
    const { validateFixtures, printDryRun } = await import('./fixtures.mjs')
    const result = await validateFixtures({ hashPdfs: !flagBool(flags, 'no-hash') })
    printDryRun(result)
    return result.ok ? 0 : 1
  }
  const apiBase = flagString(flags, 'api-base', DEFAULT_API_BASE)
  const profile = flagString(flags, 'profile', DEFAULT_PROFILE)
  const client = new PappersClient({ baseUrl: apiBase, timeoutMs: flagInt(flags, 'timeout-ms', DEFAULT_TIMEOUT_MS) })
  const fixtures = loadFixtures()
  const recorder = new Recorder({ runId: `standalone-${spec.suite}-${new Date().toISOString()}` })
  const environment = await collectEnvironment(client, { profile })
  const ctx = {
    client,
    fixtures,
    recorder,
    environment,
    state: {},
    options: {
      apiBase,
      profile,
      importTimeoutMs: flagInt(flags, 'import-timeout-ms', DEFAULT_IMPORT_TIMEOUT_MS),
      bibliography: flagBool(flags, 'bibliography'),
      lifecyclePaper: flagString(flags, 'lifecycle-paper', 'C05'),
      verbose: true,
    },
  }
  let result
  try {
    result = await spec.run(ctx)
  } catch (error) {
    const handle = recorder.begin({ suite: spec.suite, caseId: `${spec.suite.toUpperCase()}.fatal`, title: 'Suite execution', expected: 'suite runs to completion' })
    recorder.crash(handle, error)
    result = { summary: recorder.summary(), cases: recorder.cases }
  }
  for (const testCase of recorder.cases) console.log(formatCaseLine(testCase))
  const summary = recorder.summary()
  console.log('')
  console.log(`${spec.suite}: ${summary.pass} pass, ${summary.fail} fail, ${summary.not_run} not_run (${summary.total} cases, pass-rate ${summary.pass_rate})`)
  const artifact = writeJsonFile(artifactPath(`${spec.suite}.json`), {
    suite: spec.suite,
    generated_at: new Date().toISOString(),
    environment,
    planned: spec.planned ?? null,
    summary,
    cases: recorder.cases,
    result,
  })
  console.log(`artifact: ${artifact}`)
  return summary.fail > 0 ? 1 : 0
}

/* ------------------------------------------------------------------ */
/* Environment                                                        */
/* ------------------------------------------------------------------ */

/**
 * Capture the environment record for the reports.
 * @param {PappersClient} client API client.
 * @param {{profile?:string}} [options] environment options.
 * @returns {Promise<object>} environment facts.
 */
export async function collectEnvironment(client, options = {}) {
  const environment = {
    captured_at: new Date().toISOString(),
    harness_version: HARNESS_VERSION,
    contract_version: CONTRACT_VERSION,
    node: process.version,
    platform: `${platform()}-${arch()}`,
    os_release: release(),
    profile: options.profile ?? DEFAULT_PROFILE,
    web_url: client?.baseUrl ?? DEFAULT_API_BASE,
    api_url: client?.apiUrl ?? '',
    run_id: process.env.PAPPERS_TEST_RUN_ID ?? '',
  }
  let status = null
  try {
    status = await client.call('status')
    environment.status = status
    environment.dsh_version = status?.plugin?.hostVersion ?? 'unknown'
    environment.plugin = status?.plugin ?? null
    environment.storage = status?.storage ?? null
    environment.index = status?.index ?? null
    environment.degraded = status?.degraded ?? null
    environment.counts = status?.counts ?? null
  } catch (error) {
    environment.status_error = {
      code: error?.code ?? 'unknown',
      message: String(error?.message ?? error),
    }
    environment.dsh_version = 'unknown (plugin API unreachable)'
  }
  if (status !== null) {
    try {
      const diagnostics = await client.call('diagnostics')
      environment.diagnostics = diagnostics
    } catch {
      environment.diagnostics = null
    }
  }
  return environment
}

/* ------------------------------------------------------------------ */
/* Self-check                                                          */
/* ------------------------------------------------------------------ */

/**
 * Resolve whether this module file is the executed entry point.
 * @param {string} moduleUrl `import.meta.url` of the calling module.
 * @returns {boolean} true when executed directly.
 */
export function isMain(moduleUrl) {
  const entry = process.argv[1]
  if (typeof entry !== 'string' || entry === '') return false
  try {
    return path.resolve(entry) === fileURLToPath(moduleUrl)
  } catch {
    return false
  }
}
