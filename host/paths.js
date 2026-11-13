/**
 * Filesystem layout, configuration resolution and small fs helpers for the
 * Pappers-Hall Host half.
 *
 * This module intentionally imports nothing from DSH: the Host half must also
 * run under the standalone selftest harness (`node host/selftest.mjs`) where no
 * Cordis context exists.
 *
 * @module pappers-hall/host/paths
 */
import { createHash, randomBytes } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { mkdir, open, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

/** Absolute directory of this module (`.../pappers-hall-plugin/host`). */
const HERE = path.dirname(fileURLToPath(import.meta.url))

/** Module filesystem name, kept in one place for diagnostics and exports. */
export const PLUGIN_ID = 'dsh-pappers-hall'

/** Fallback plugin version when the package manifest cannot be read. */
export const FALLBACK_PLUGIN_VERSION = '0.1.0'

/**
 * Read the plugin package version from the sibling `package.json`.
 * A read failure only weakens diagnostics, so it degrades instead of throwing.
 * @returns {Promise<string>} package version.
 */
export async function readPluginVersion() {
  const info = await readJsonIfPresent(path.join(HERE, '..', 'package.json'))
  return typeof info?.version === 'string' && info.version !== '' ? info.version : FALLBACK_PLUGIN_VERSION
}

/** DSH home used when `config.dataDir` is not given. */
export function dshHome(config = {}) {
  if (typeof config.dshHome === 'string' && config.dshHome.trim() !== '') {
    return path.resolve(config.dshHome.trim())
  }
  const fromEnv = process.env.DSH_HOME
  if (typeof fromEnv === 'string' && fromEnv.trim() !== '') return path.resolve(fromEnv.trim())
  return path.join(homedir(), '.dsh')
}

/**
 * Resolve the plugin-owned data directory.
 *
 * Priority: `config.dataDir` (absolute or cwd-relative) > `$DSH_HOME/pappers-hall`.
 * The directory is never shared with the profile or the user's working project.
 * @param {object} config resolved plugin config.
 * @returns {string} absolute data directory path.
 */
export function resolveDataDir(config = {}) {
  const configured = typeof config.dataDir === 'string' ? config.dataDir.trim() : ''
  if (configured !== '') {
    return path.isAbsolute(configured) ? path.normalize(configured) : path.resolve(process.cwd(), configured)
  }
  return path.join(dshHome(config), 'pappers-hall')
}

/**
 * Developer fixture root (the pappers_hall_devkit_lite checkout).
 *
 * Used only to merge bibliography metadata and manifest hashes; its absence is
 * a normal deployment state, never an error.
 * @param {object} config resolved plugin config.
 * @returns {string} absolute fixture directory candidate.
 */
export function resolveFixtureDir(config = {}) {
  const configured = typeof config.fixtureDir === 'string' ? config.fixtureDir.trim() : ''
  if (configured !== '') {
    return path.isAbsolute(configured) ? path.normalize(configured) : path.resolve(process.cwd(), configured)
  }
  return path.resolve(HERE, '..', '..', 'pappers_hall_devkit_lite')
}

/**
 * All owned paths below one data directory.
 * @param {string} dataDir absolute data directory.
 * @returns {object} path table.
 */
export function layoutFor(dataDir) {
  const cacheDir = path.join(dataDir, 'cache')
  return {
    dataDir,
    dbPath: path.join(dataDir, 'pappers-hall.sqlite'),
    filesDir: path.join(dataDir, 'files'),
    figuresDir: path.join(dataDir, 'figures'),
    noteAssetsDir: path.join(dataDir, 'note-assets'),
    tmpDir: path.join(dataDir, 'tmp'),
    cacheDir,
    pagesCacheDir: path.join(cacheDir, 'pages'),
    thumbsCacheDir: path.join(cacheDir, 'thumbs'),
    figuresCacheDir: path.join(cacheDir, 'figures'),
  }
}

/**
 * Create every owned directory (idempotent).
 * @param {object} layout path table from {@link layoutFor}.
 * @returns {Promise<void>}
 */
export async function ensureLayout(layout) {
  await Promise.all([
    mkdir(layout.dataDir, { recursive: true }),
    mkdir(layout.filesDir, { recursive: true }),
    mkdir(layout.figuresDir, { recursive: true }),
    mkdir(layout.noteAssetsDir, { recursive: true }),
    mkdir(layout.tmpDir, { recursive: true }),
    mkdir(layout.pagesCacheDir, { recursive: true }),
    mkdir(layout.thumbsCacheDir, { recursive: true }),
    mkdir(layout.figuresCacheDir, { recursive: true }),
  ])
}

/** Random lowercase hex string. */
export function randomHex(bytes = 6) {
  return randomBytes(bytes).toString('hex')
}

/** Current wall-clock time as an ISO-8601 UTC string. */
export function nowIso() {
  return new Date().toISOString()
}

/** ISO string `seconds` from now. */
export function futureIso(seconds) {
  return new Date(Date.now() + seconds * 1000).toISOString()
}

/** Clamp a finite integer into `[min, max]`, falling back when not an integer. */
export function clampInt(value, min, max, fallback) {
  const n = typeof value === 'number' ? value : Number.parseInt(String(value ?? ''), 10)
  if (!Number.isFinite(n)) return fallback
  const i = Math.trunc(n)
  if (i < min) return min
  if (i > max) return max
  return i
}

/** Escape a value for a SQL `LIKE ? ESCAPE '\\'` pattern. */
export function escapeLike(value) {
  return String(value).replace(/[\\%_]/g, (char) => `\\${char}`)
}

/** Escape an HTML/XML text node for embedding in generated markup. */
export function escapeXml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
}

/** True when the string contains CJK ideographs (used for the LIKE fallback). */
export function hasCjk(value) {
  return /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/.test(String(value ?? ''))
}

/**
 * Atomically publish a file: write a sibling temporary file, fsync it, then
 * rename over the destination. Readers never observe a partial file.
 * @param {string} target absolute destination path.
 * @param {string|Uint8Array} data bytes or text.
 * @returns {Promise<void>}
 */
export async function atomicWriteFile(target, data) {
  const directory = path.dirname(target)
  await mkdir(directory, { recursive: true })
  const temporary = path.join(directory, `.tmp-${process.pid}-${randomHex(8)}`)
  let handle
  try {
    handle = await open(temporary, 'w')
    await handle.writeFile(data)
    await handle.sync()
    await handle.close()
    handle = undefined
    await rename(temporary, target)
  } catch (error) {
    if (handle !== undefined) await handle.close().catch(() => {})
    await rm(temporary, { force: true }).catch(() => {})
    throw error
  }
}

/** Atomically write a JSON document with stable pretty formatting. */
export async function atomicWriteJson(target, value) {
  await atomicWriteFile(target, `${JSON.stringify(value, null, 2)}\n`)
}

/** Read a JSON file, returning `undefined` when it is absent or unreadable. */
export async function readJsonIfPresent(filePath) {
  try {
    return JSON.parse(await readFile(filePath, 'utf8'))
  } catch {
    return undefined
  }
}

/** Stream a file through sha256; returns lowercase hex. */
export async function hashFile(filePath) {
  const hash = createHash('sha256')
  await new Promise((resolve, reject) => {
    const stream = createReadStream(filePath)
    stream.on('data', (chunk) => hash.update(chunk))
    stream.on('error', reject)
    stream.on('end', resolve)
  })
  return hash.digest('hex')
}

/**
 * Read at most `length` leading bytes of a file.
 * @param {string} filePath file to read.
 * @param {number} length maximum byte count.
 * @returns {Promise<Buffer>} the leading bytes (possibly shorter for tiny files).
 */
export async function readLeadingBytes(filePath, length) {
  const handle = await open(filePath, 'r')
  try {
    const buffer = Buffer.alloc(length)
    const { bytesRead } = await handle.read(buffer, 0, length, 0)
    return buffer.subarray(0, bytesRead)
  } finally {
    await handle.close().catch(() => {})
  }
}

/** Whether a path exists as a regular file. */
export async function isFile(filePath) {
  try {
    return (await stat(filePath)).isFile()
  } catch {
    return false
  }
}

/** Whether a path exists as a directory. */
export async function isDirectory(dirPath) {
  try {
    return (await stat(dirPath)).isDirectory()
  } catch {
    return false
  }
}

/** File size in bytes, or 0 when absent. */
export async function fileSize(filePath) {
  try {
    return (await stat(filePath)).size
  } catch {
    return 0
  }
}

/**
 * Resolve a path below `root` and refuse anything that escapes it. Used for
 * cache/asset naming where a request parameter becomes a path segment.
 * @param {string} root trusted absolute root.
 * @param {...string} segments untrusted relative segments.
 * @returns {string|undefined} normalized absolute path inside root, or undefined.
 */
export function safeJoin(root, ...segments) {
  const resolvedRoot = path.resolve(root)
  const candidate = path.resolve(resolvedRoot, ...segments)
  const relative = path.relative(resolvedRoot, candidate)
  if (relative === '' || relative.startsWith('..') || path.isAbsolute(relative)) return undefined
  return candidate
}

/** Replace filesystem-hostile characters in a display name. */
export function safeFileStem(value, fallback = 'paper') {
  const cleaned = String(value ?? '')
    .normalize('NFKC')
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 80)
  return cleaned === '' ? fallback : cleaned
}

export { HERE as moduleDirectory }
