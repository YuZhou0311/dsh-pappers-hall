/**
 * Poppler integration for the Pappers-Hall Host half.
 *
 * Every external command is explicit argv (no shell), bounded by a timeout, and
 * classified into a small set of stable error codes so the import pipeline can
 * record a truthful `partial` state instead of pretending success. Commands run
 * through the DSH subprocess service when one is composed, otherwise through
 * `node:child_process` — the selftest and a minimal profile need no extra
 * services.
 *
 * @module pappers-hall/host/pdf
 */
import { execFile } from 'node:child_process'
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { inflateSync } from 'node:zlib'
import { parseLayoutXml } from './layout.js'
import { atomicWriteFile, clampInt } from './paths.js'

/** Default timeout for one external PDF command (contract §5: 120s). */
export const DEFAULT_COMMAND_TIMEOUT_MS = 120_000

/** Stable error codes surfaced through job errors and API error payloads. */
export class PdfToolError extends Error {
  /**
   * @param {string} message human-readable diagnostic.
   * @param {string} code one of unavailable|timeout|failed|invalid_pdf|encrypted|unsupported.
   * @param {object} [meta] optional context (command, stderr tail, path).
   */
  constructor(message, code, meta = {}) {
    super(message)
    this.name = 'PdfToolError'
    this.code = code
    this.meta = meta
  }
}

/* ------------------------------------------------------------------ */
/* Command execution                                                    */
/* ------------------------------------------------------------------ */

/**
 * Build one command runner that prefers the composed DSH subprocess service and
 * falls back to `node:child_process.execFile`.
 *
 * The returned function never rejects on a non-zero exit by itself; it resolves
 * with the outcome and lets callers classify, because poppler utilities use
 * non-zero exits for plain diagnostics such as `-v`.
 * @param {object} options runner options.
 * @param {object} [options.ctx] Cordis context, when available.
 * @param {object} [options.logger] logger with warn/debug methods.
 * @param {number} [options.defaultTimeoutMs] per-command deadline.
 * @returns {(argv:string[], options?:object) => Promise<{stdout:Buffer, stderr:string, exitCode:number|null, signal:string|null, missing:boolean, timedOut:boolean}>} runner.
 */
export function createCommandRunner({ ctx, logger, defaultTimeoutMs = DEFAULT_COMMAND_TIMEOUT_MS } = {}) {
  /**
   * @param {string[]} argv program followed by arguments.
   * @param {object} [options] per-command options.
   * @returns {Promise<object>} command outcome.
   */
  return async function runCommand(argv, options = {}) {
    const timeoutMs = options.timeoutMs ?? defaultTimeoutMs
    const maxBytes = options.maxBytes ?? 128 * 1024 * 1024
    const subprocess = typeof ctx?.get === 'function' ? ctx.get('subprocess') : undefined
    if (subprocess !== undefined && typeof subprocess.spawn === 'function' && typeof subprocess.resolveExecutable === 'function') {
      return runThroughSubprocess(subprocess, argv, { timeoutMs, maxBytes })
    }
    return runThroughExecFile(argv, { timeoutMs, maxBuffer: maxBytes, logger })
  }
}

/** Execute one command through the composed subprocess service. */
async function runThroughSubprocess(subprocess, argv, { timeoutMs, maxBytes }) {
  const controller = new AbortController()
  let timedOut = false
  const timer = setTimeout(() => {
    timedOut = true
    controller.abort(new Error(`command timed out after ${timeoutMs}ms`))
  }, timeoutMs)
  try {
    let executable
    try {
      executable = await subprocess.resolveExecutable(argv[0])
    } catch (error) {
      return { stdout: Buffer.alloc(0), stderr: String(error?.message ?? error), exitCode: null, signal: null, missing: true, timedOut: false }
    }
    if (controller.signal.aborted) return { stdout: Buffer.alloc(0), stderr: 'command aborted before spawn', exitCode: null, signal: null, missing: false, timedOut: true }
    const handle = subprocess.spawn({
      argv: [executable, ...argv.slice(1)],
      cwd: process.cwd(),
      stdio: {
        stdin: 'ignore',
        stdout: { maxBytes },
        stderr: { maxBytes: 4 * 1024 * 1024 },
      },
      graceMs: 2000,
      signal: controller.signal,
    })
    try {
      const outcome = await handle.done
      const stdout = handle.collected?.stdout?.readFrom(0)?.text ?? ''
      const stderr = handle.collected?.stderr?.readFrom(0)?.text ?? ''
      return {
        stdout: Buffer.from(stdout, 'utf8'),
        stderr,
        exitCode: typeof outcome?.exitCode === 'number' ? outcome.exitCode : null,
        signal: typeof outcome?.signal === 'string' ? outcome.signal : null,
        missing: false,
        timedOut,
      }
    } catch (error) {
      const stdout = handle.collected?.stdout?.readFrom(0)?.text ?? ''
      const stderr = handle.collected?.stderr?.readFrom(0)?.text ?? ''
      try {
        handle.terminate()
      } catch {}
      return {
        stdout: Buffer.from(stdout, 'utf8'),
        stderr: stderr || String(error?.message ?? error),
        exitCode: null,
        signal: null,
        missing: false,
        timedOut: timedOut || controller.signal.aborted,
      }
    }
  } finally {
    clearTimeout(timer)
  }
}

/** Execute one command through `node:child_process.execFile`. */
function runThroughExecFile(argv, { timeoutMs, maxBuffer, logger }) {
  return new Promise((resolve) => {
    execFile(
      argv[0],
      argv.slice(1),
      { encoding: 'buffer', timeout: timeoutMs, maxBuffer, windowsHide: true },
      (error, stdout, stderr) => {
        const stderrText = Buffer.isBuffer(stderr) ? stderr.toString('utf8') : String(stderr ?? '')
        if (error === null || error === undefined) {
          resolve({
            stdout: Buffer.isBuffer(stdout) ? stdout : Buffer.from(String(stdout ?? ''), 'utf8'),
            stderr: stderrText,
            exitCode: 0,
            signal: null,
            missing: false,
            timedOut: false,
          })
          return
        }
        const code = typeof error.code === 'string' ? error.code : null
        const timedOut = error.killed === true || code === 'ETIMEDOUT' || /timed? ?out/i.test(String(error.message))
        const missing = code === 'ENOENT'
        if (!missing && !timedOut) {
          logger?.debug?.(`pappers-hall: command failed: ${argv[0]} (${code ?? error.message})`)
        }
        resolve({
          stdout: Buffer.isBuffer(stdout) ? stdout : Buffer.from(String(stdout ?? ''), 'utf8'),
          stderr: stderrText,
          exitCode: typeof error.code === 'number' ? error.code : null,
          signal: typeof error.signal === 'string' ? error.signal : null,
          missing,
          timedOut,
        })
      },
    )
  })
}

/** Turn one non-zero command outcome into a classified {@link PdfToolError}. */
function failureFromOutcome(outcome, command, filePath) {
  const tail = outcome.stderr.trim().split('\n').slice(-3).join(' ').slice(0, 500)
  if (outcome.missing) {
    return new PdfToolError(`PDF tool "${command}" is not installed or not on PATH`, 'unavailable', { command, path: filePath, stderr: tail })
  }
  if (outcome.timedOut) {
    return new PdfToolError(`PDF tool "${command}" timed out`, 'timeout', { command, path: filePath, stderr: tail })
  }
  const encrypted = /encrypted|password/i.test(tail)
  return new PdfToolError(
    encrypted ? `PDF is encrypted and cannot be read: ${path.basename(filePath)}` : `PDF tool "${command}" failed: ${tail || 'no diagnostic output'}`,
    encrypted ? 'encrypted' : 'failed',
    { command, path: filePath, stderr: tail },
  )
}

/* ------------------------------------------------------------------ */
/* Poppler facade                                                       */
/* ------------------------------------------------------------------ */

/**
 * Create the poppler facade used by the ingest pipeline and the asset routes.
 * @param {object} options facade options.
 * @param {(argv:string[], options?:object)=>Promise<object>} options.run command runner.
 * @param {object} [options.commands] executable overrides (`pdfinfo`, `pdftotext`, `pdftoppm`).
 * @param {object} [options.logger] logger.
 * @param {number} [options.timeoutMs] per-command deadline.
 * @returns {object} poppler facade.
 */
export function createPdfTools({ run, commands = {}, logger, timeoutMs = DEFAULT_COMMAND_TIMEOUT_MS }) {
  const binaries = {
    pdfinfo: commands.pdfinfo ?? 'pdfinfo',
    pdftotext: commands.pdftotext ?? 'pdftotext',
    pdftoppm: commands.pdftoppm ?? 'pdftoppm',
  }
  /** Last detection result; `undefined` until `detect()` runs. */
  let detection

  /** Run one poppler command, throwing a classified error on a non-zero exit. */
  async function call(argv, { filePath, allowFailure = false } = {}) {
    const outcome = await run(argv, { timeoutMs })
    if (outcome.exitCode !== 0 && !allowFailure) throw failureFromOutcome(outcome, argv[0], filePath ?? argv.at(-1) ?? '')
    return outcome
  }

  return {
    binaries,
    /**
     * Probe the three poppler binaries.
     * @returns {Promise<{available:boolean, version:string|null, missing:string[], versions:object}>}
     */
    async detect() {
      const versions = {}
      const missing = []
      for (const [name, binary] of Object.entries(binaries)) {
        const outcome = await run([binary, '-v'], { timeoutMs: 15_000 })
        if (outcome.missing) {
          missing.push(binary)
          continue
        }
        const text = `${outcome.stdout.toString('utf8')}\n${outcome.stderr}`
        const match = /(?:pdftotext|pdftoppm|pdfinfo)\s+version\s+([^\s]+)/i.exec(text)
        if (match !== null) versions[name] = match[1]
        // `-v` may exit non-zero on some builds; only the version text matters here.
      }
      detection = { available: missing.length === 0, version: versions.pdftotext ?? versions.pdftoppm ?? versions.pdfinfo ?? null, missing, versions }
      if (!detection.available) logger?.warn?.(`pappers-hall: missing PDF tools: ${missing.join(', ')}`)
      return detection
    },

    /** Current detection facts (`detect()` must have run). */
    get detection() {
      return detection ?? { available: false, version: null, missing: [], versions: {} }
    },

    /**
     * Read document information and page count.
     * @param {string} filePath absolute PDF path.
     * @returns {Promise<object>} parsed pdfinfo facts.
     */
    async info(filePath) {
      const outcome = await call([binaries.pdfinfo, '-f', '1', '-l', '1', filePath], { filePath })
      const text = outcome.stdout.toString('utf8')
      const read = (label) => {
        const match = new RegExp(`^${label}:\\s*(.*)$`, 'm').exec(text)
        return match === null ? null : match[1].trim() === '' ? null : match[1].trim()
      }
      const pages = Number.parseInt(read('Pages') ?? '', 10)
      const encrypted = /^Encrypted:\s*yes/im.test(text)
      const sizeMatch =
        /^Page\s+1\s+size:\s*([\d.]+)\s+x\s+([\d.]+)/im.exec(text) ?? /^Page size:\s*([\d.]+)\s+x\s+([\d.]+)/im.exec(text)
      return {
        pageCount: Number.isFinite(pages) ? pages : 0,
        title: read('Title'),
        author: read('Author'),
        subject: read('Subject'),
        creator: read('Creator'),
        producer: read('Producer'),
        encrypted,
        pdfVersion: read('PDF version'),
        pageWidth: sizeMatch === null ? null : Number.parseFloat(sizeMatch[1]),
        pageHeight: sizeMatch === null ? null : Number.parseFloat(sizeMatch[2]),
      }
    },

    /**
     * Extract every page's layout-preserving text in one call.
     * @param {string} filePath absolute PDF path.
     * @returns {Promise<{pageCount:number, pages:string[]}>} page texts, 1-based order.
     */
    async textPages(filePath) {
      const outcome = await call([binaries.pdftotext, '-layout', '-enc', 'UTF-8', filePath, '-'], { filePath })
      const pages = splitTextPages(outcome.stdout.toString('utf8'))
      return { pageCount: pages.length, pages }
    },

    /**
     * Extract the full per-page flow/block/line/word layout.
     *
     * Returns an empty page list for documents whose text layer is missing; the
     * caller keeps the text state and marks structure `failed`.
     * @param {string} filePath absolute PDF path.
     * @returns {Promise<{pages:Array<object>, bytes:number, failed:boolean}>} parsed layout pages.
     */
    async layoutDocument(filePath) {
      const outcome = await call([binaries.pdftotext, '-bbox-layout', '-enc', 'UTF-8', filePath, '-'], {
        filePath,
        allowFailure: true,
      })
      if (outcome.exitCode !== 0) return { pages: [], bytes: outcome.stdout.byteLength, failed: true }
      const text = outcome.stdout.toString('utf8')
      return { pages: parseLayoutXml(text), bytes: text.length, failed: false }
    },

    /**
     * Extract per-page line bounding boxes for caption detection (v0.1 shape)
     * plus the block tree used by v0.2 structure generation.
     * @param {string} filePath absolute PDF path.
     * @returns {Promise<Array<{page:number, width:number|null, height:number|null, lines:Array<object>, blocks:Array<object>}>>} pages.
     */
    async layoutPages(filePath) {
      const document = await this.layoutDocument(filePath)
      return flattenLayoutPages(document.pages)
    },

    /**
     * Render one page to PNG with a target pixel width.
     * @param {object} request render request.
     * @param {string} request.filePath absolute PDF path.
     * @param {number} request.page 1-based page.
     * @param {number} request.width target pixel width (200..2400).
     * @param {string} request.outputPath destination PNG.
     * @returns {Promise<{width:number,height:number}>} rendered pixel dimensions.
     */
    async renderPage({ filePath, page, width, outputPath }) {
      const targetWidth = clampInt(width, 120, 3000, 1400)
      return withTempDir(async (directory) => {
        const prefix = path.join(directory, 'page')
        await call(
          [
            binaries.pdftoppm,
            '-png',
            '-f',
            String(page),
            '-l',
            String(page),
            '-singlefile',
            '-scale-to-x',
            String(targetWidth),
            '-scale-to-y',
            '-1',
            filePath,
            prefix,
          ],
          { filePath },
        )
        const png = await readFile(`${prefix}.png`)
        const size = pngSize(png)
        await atomicWriteFile(outputPath, png)
        return size
      })
    },

    /**
     * Render one PDF-point region to PNG (figure crop).
     *
     * Crop coordinates are converted from PDF points to rendered pixels at the
     * chosen dpi and clamped into the page: poppler silently truncates a window
     * that crosses the page edge, which would skew every stored geometry.
     * @param {object} request crop request.
     * @param {string} request.filePath absolute PDF path.
     * @param {number} request.page 1-based page.
     * @param {{x:number,y:number,w:number,h:number}} request.bbox PDF-point region.
     * @param {{width:number,height:number}} request.pageSize PDF-point page size.
     * @param {string} request.outputPath destination PNG.
     * @param {number} [request.dpi] render resolution (default 120).
     * @param {number} [request.targetWidth] target pixel width; overrides dpi.
     * @returns {Promise<{width:number,height:number}>} rendered pixel dimensions.
     */
    async renderCrop({ filePath, page, bbox, pageSize, outputPath, dpi = 120, targetWidth }) {
      const pageWidthPt = pageSize?.width ?? bbox.x + bbox.w
      const pageHeightPt = pageSize?.height ?? bbox.y + bbox.h
      const resolvedDpi = Number.isFinite(targetWidth) && targetWidth > 0 ? (targetWidth / Math.max(1, bbox.w)) * 72 : dpi
      const scale = resolvedDpi / 72
      const pagePixels = Math.max(1, Math.round(pageWidthPt * scale))
      const pagePixelHeight = Math.max(1, Math.round(pageHeightPt * scale))
      const x = clampInt(Math.round(bbox.x * scale), 0, Math.max(0, pagePixels - 8), 0)
      const y = clampInt(Math.round(bbox.y * scale), 0, Math.max(0, pagePixelHeight - 8), 0)
      const w = clampInt(Math.round(bbox.w * scale), 8, Math.max(8, pagePixels - x), 8)
      const h = clampInt(Math.round(bbox.h * scale), 8, Math.max(8, pagePixelHeight - y), 8)
      return withTempDir(async (directory) => {
        const prefix = path.join(directory, 'crop')
        await call(
          [
            binaries.pdftoppm,
            '-png',
            '-f',
            String(page),
            '-l',
            String(page),
            '-singlefile',
            '-r',
            String(Math.round(resolvedDpi * 100) / 100),
            '-x',
            String(x),
            '-y',
            String(y),
            '-W',
            String(w),
            '-H',
            String(h),
            filePath,
            prefix,
          ],
          { filePath },
        )
        const png = await readFile(`${prefix}.png`)
        const size = pngSize(png)
        await atomicWriteFile(outputPath, png)
        return size
      })
    },

    /**
     * Compute the 64-bit dHash of one rendered page.
     * @param {string} filePath absolute PDF path.
     * @param {number} page 1-based page.
     * @returns {Promise<string|null>} 16-char hex digest, or null when unavailable.
     */
    async pageDhash(filePath, page) {
      try {
        return await withTempDir(async (directory) => {
          const prefix = path.join(directory, 'hash')
          await call(
            [binaries.pdftoppm, '-gray', '-f', String(page), '-l', String(page), '-singlefile', '-scale-to-x', '9', '-scale-to-y', '8', filePath, prefix],
            { filePath },
          )
          const pgm = await readFile(`${prefix}.pgm`)
          return dhashFromGray(parsePgm(pgm))
        })
      } catch (error) {
        logger?.debug?.(`pappers-hall: page dhash failed: ${String(error?.message ?? error)}`)
        return null
      }
    },

    /**
     * Compute the 64-bit dHash of a cropped figure region.
     * @param {object} request crop request (same geometry as {@link renderCrop}).
     * @returns {Promise<string|null>} 16-char hex digest, or null when unavailable.
     */
    async cropDhash({ filePath, page, bbox, pageSize, dpi = 28 }) {
      try {
        return await withTempDir(async (directory) => {
          const pageWidthPt = pageSize?.width ?? bbox.x + bbox.w
          const pageHeightPt = pageSize?.height ?? bbox.y + bbox.h
          const scale = dpi / 72
          const pagePixels = Math.max(1, Math.round(pageWidthPt * scale))
          const pagePixelHeight = Math.max(1, Math.round(pageHeightPt * scale))
          const x = clampInt(Math.round(bbox.x * scale), 0, Math.max(0, pagePixels - 4), 0)
          const y = clampInt(Math.round(bbox.y * scale), 0, Math.max(0, pagePixelHeight - 4), 0)
          const w = clampInt(Math.round(bbox.w * scale), 4, Math.max(4, pagePixels - x), 4)
          const h = clampInt(Math.round(bbox.h * scale), 4, Math.max(4, pagePixelHeight - y), 4)
          const prefix = path.join(directory, 'hash')
          await call(
            [
              binaries.pdftoppm,
              '-gray',
              '-f',
              String(page),
              '-l',
              String(page),
              '-singlefile',
              '-r',
              String(dpi),
              '-x',
              String(x),
              '-y',
              String(y),
              '-W',
              String(w),
              '-H',
              String(h),
              filePath,
              prefix,
            ],
            { filePath },
          )
          const pgm = await readFile(`${prefix}.pgm`)
          return dhashFromGray(downsampleGray(parsePgm(pgm), 9, 8))
        })
      } catch (error) {
        logger?.debug?.(`pappers-hall: figure dhash failed: ${String(error?.message ?? error)}`)
        return null
      }
    },
  }
}

/**
 * Flatten parsed layout pages into the v0.1-compatible `{lines, blocks}` view.
 * @param {Array<object>} pages parseLayoutXml pages.
 * @returns {Array<object>} flat pages.
 */
export function flattenLayoutPages(pages) {
  return (pages ?? []).map((page) => {
    const lines = []
    const blocks = []
    for (const flow of page.flows ?? []) {
      for (const block of flow.blocks ?? []) {
        blocks.push(block)
        for (const line of block.lines ?? []) {
          lines.push({
            text: line.text,
            xMin: line.bbox.x,
            yMin: line.bbox.y,
            xMax: line.bbox.x + line.bbox.w,
            yMax: line.bbox.y + line.bbox.h,
          })
        }
      }
    }
    return { page: page.page, width: page.width, height: page.height, lines, blocks }
  })
}

/** Split `pdftotext` stdout into page texts. */
export function splitTextPages(text) {
  let output = String(text ?? '').replace(/\r\n/g, '\n')
  // pdftotext separates pages with form feeds and ends the last page with one too.
  const parts = output.split('\f')
  while (parts.length > 0 && parts.at(-1) === '') parts.pop()
  return parts
}

/**
 * Parse `pdftotext -bbox-layout` XHTML into pages with line boxes.
 *
 * The detailed page/flow/block tree lives in {@link parseLayoutXml} (layout.js);
 * this compatibility view keeps the flat `lines[]` shape the v0.1 figure
 * detector expects, and adds the block tree for structure generation.
 * @param {string} xml raw bbox-layout output.
 * @returns {Array<{page:number,width:number|null,height:number|null,lines:object[],blocks:object[]}>} pages.
 */
export function parseBboxLayout(xml) {
  return parseLayoutXml(xml).map((page) => {
    const lines = []
    const blocks = []
    for (const flow of page.flows ?? []) {
      for (const block of flow.blocks ?? []) {
        blocks.push(block)
        for (const line of block.lines ?? []) {
          lines.push({
            text: line.text,
            xMin: line.bbox.x,
            yMin: line.bbox.y,
            xMax: line.bbox.x + line.bbox.w,
            yMax: line.bbox.y + line.bbox.h,
          })
        }
      }
    }
    return { page: page.page, width: page.width, height: page.height, lines, blocks }
  })
}

/* ------------------------------------------------------------------ */
/* Image geometry and perceptual hashing                                */
/* ------------------------------------------------------------------ */

/** Read PNG pixel dimensions from the IHDR chunk. */
export function pngSize(buffer) {
  const bytes = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer)
  if (bytes.length < 24 || bytes.readUInt32BE(0) !== 0x89504e47) {
    throw new PdfToolError('not a PNG image', 'unsupported', { bytes: bytes.length })
  }
  return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) }
}

/**
 * Parse a binary (P5) PGM into `{width,height,data}` with one byte per pixel.
 * @param {Buffer|Uint8Array} buffer PGM bytes.
 * @returns {{width:number,height:number,data:Uint8Array}}
 */
export function parsePgm(buffer) {
  const bytes = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer)
  let cursor = 0
  const readToken = () => {
    while (cursor < bytes.length && /\s/.test(String.fromCharCode(bytes[cursor]))) cursor += 1
    if (bytes[cursor] === 0x23) {
      while (cursor < bytes.length && bytes[cursor] !== 0x0a) cursor += 1
      return readToken()
    }
    const start = cursor
    while (cursor < bytes.length && !/\s/.test(String.fromCharCode(bytes[cursor]))) cursor += 1
    return bytes.subarray(start, cursor).toString('ascii')
  }
  const magic = readToken()
  if (magic !== 'P5') throw new PdfToolError('unsupported PGM format', 'unsupported', { magic })
  const width = Number.parseInt(readToken(), 10)
  const height = Number.parseInt(readToken(), 10)
  const maxValue = Number.parseInt(readToken(), 10)
  cursor += 1 // exactly one whitespace byte precedes the raster
  const expected = width * height
  const data = bytes.subarray(cursor, cursor + expected)
  if (maxValue !== 255) {
    const scaled = new Uint8Array(expected)
    for (let index = 0; index < expected; index += 1) scaled[index] = Math.round(((data[index] ?? 0) * 255) / maxValue)
    return { width, height, data: scaled }
  }
  return { width, height, data: new Uint8Array(data) }
}

/** Box-downsample one grayscale raster to `targetWidth × targetHeight`. */
export function downsampleGray(image, targetWidth, targetHeight) {
  const data = new Uint8Array(targetWidth * targetHeight)
  const scaleX = image.width / targetWidth
  const scaleY = image.height / targetHeight
  for (let y = 0; y < targetHeight; y += 1) {
    const yStart = Math.floor(y * scaleY)
    const yEnd = Math.max(yStart + 1, Math.min(image.height, Math.ceil((y + 1) * scaleY)))
    for (let x = 0; x < targetWidth; x += 1) {
      const xStart = Math.floor(x * scaleX)
      const xEnd = Math.max(xStart + 1, Math.min(image.width, Math.ceil((x + 1) * scaleX)))
      let sum = 0
      let count = 0
      for (let sy = yStart; sy < yEnd; sy += 1) {
        for (let sx = xStart; sx < xEnd; sx += 1) {
          sum += image.data[sy * image.width + sx] ?? 0
          count += 1
        }
      }
      data[y * targetWidth + x] = count === 0 ? 0 : Math.round(sum / count)
    }
  }
  return { width: targetWidth, height: targetHeight, data }
}

/**
 * 64-bit difference hash over a 9×8 grayscale raster.
 * @param {{width:number,height:number,data:Uint8Array}} image raster (must be 9×8).
 * @returns {string} 16 lowercase hex characters.
 */
export function dhashFromGray(image) {
  if (image.width !== 9 || image.height !== 8) throw new PdfToolError('dHash input must be 9x8', 'unsupported')
  let hex = ''
  for (let y = 0; y < 8; y += 1) {
    let nibble = 0
    for (let x = 0; x < 8; x += 1) {
      const left = image.data[y * 9 + x] ?? 0
      const right = image.data[y * 9 + x + 1] ?? 0
      nibble = (nibble << 1) | (left > right ? 1 : 0)
      if (x % 4 === 3) {
        hex += nibble.toString(16)
        nibble = 0
      }
    }
  }
  return hex
}

/** Hamming distance between two equal-length hex digests; Infinity for invalid input. */
export function hammingDistance(left, right) {
  if (typeof left !== 'string' || typeof right !== 'string' || left.length === 0 || left.length !== right.length) return Number.POSITIVE_INFINITY
  let distance = 0
  for (let index = 0; index < left.length; index += 1) {
    const a = Number.parseInt(left[index], 16)
    const b = Number.parseInt(right[index], 16)
    if (!Number.isFinite(a) || !Number.isFinite(b)) return Number.POSITIVE_INFINITY
    let xor = a ^ b
    while (xor !== 0) {
      distance += xor & 1
      xor >>= 1
    }
  }
  return distance
}

/**
 * Decode an 8-bit non-interlaced PNG and compute its 9×8 dHash.
 *
 * Only the common screenshot shapes are supported (grayscale, RGB, gray+alpha,
 * RGBA, filter types 0–4). Anything else throws `unsupported`, and the caller
 * reports the image channel as degraded rather than inventing a similarity.
 * @param {Buffer|Uint8Array} buffer PNG bytes.
 * @returns {string} 16 lowercase hex characters.
 */
export function dhashFromPng(buffer) {
  const bytes = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer)
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
  if (bytes.length < 33 || !bytes.subarray(0, 8).equals(signature)) {
    throw new PdfToolError('not a PNG image', 'unsupported', { bytes: bytes.length })
  }
  let offset = 8
  let header = null
  const idat = []
  while (offset + 8 <= bytes.length) {
    const length = bytes.readUInt32BE(offset)
    const type = bytes.toString('ascii', offset + 4, offset + 8)
    const dataStart = offset + 8
    const dataEnd = dataStart + length
    if (dataEnd > bytes.length) break
    if (type === 'IHDR') {
      header = {
        width: bytes.readUInt32BE(dataStart),
        height: bytes.readUInt32BE(dataStart + 4),
        bitDepth: bytes[dataStart + 8],
        colorType: bytes[dataStart + 9],
        interlace: bytes[dataStart + 12],
      }
    } else if (type === 'IDAT') {
      idat.push(bytes.subarray(dataStart, dataEnd))
    } else if (type === 'IEND') {
      break
    }
    offset = dataEnd + 4
  }
  if (header === null) throw new PdfToolError('PNG has no IHDR', 'unsupported')
  if (header.bitDepth !== 8) throw new PdfToolError(`unsupported PNG bit depth ${header.bitDepth}`, 'unsupported')
  if (header.interlace !== 0) throw new PdfToolError('interlaced PNG is unsupported', 'unsupported')
  const channels = header.colorType === 0 ? 1 : header.colorType === 2 ? 3 : header.colorType === 4 ? 2 : header.colorType === 6 ? 4 : 0
  if (channels === 0) throw new PdfToolError(`unsupported PNG color type ${header.colorType}`, 'unsupported')
  const raw = inflateSync(Buffer.concat(idat))
  const stride = header.width * channels
  const pixels = unfilterPng(raw, header.width, header.height, channels)
  const gray = new Uint8Array(header.width * header.height)
  for (let index = 0; index < header.width * header.height; index += 1) {
    const base = index * channels
    if (channels === 1 || channels === 2) gray[index] = pixels[base]
    else gray[index] = Math.round(0.299 * pixels[base] + 0.587 * pixels[base + 1] + 0.114 * pixels[base + 2])
  }
  return dhashFromGray(downsampleGray({ width: header.width, height: header.height, data: gray }, 9, 8))
}

/** Undo PNG scanline filters, returning interleaved channel bytes. */
function unfilterPng(raw, width, height, channels) {
  const stride = width * channels
  const out = new Uint8Array(stride * height)
  let cursor = 0
  for (let y = 0; y < height; y += 1) {
    const filter = raw[cursor]
    cursor += 1
    const rowStart = y * stride
    const previousStart = (y - 1) * stride
    for (let x = 0; x < stride; x += 1) {
      const value = raw[cursor + x] ?? 0
      const left = x >= channels ? out[rowStart + x - channels] : 0
      const up = y > 0 ? out[previousStart + x] : 0
      const upLeft = y > 0 && x >= channels ? out[previousStart + x - channels] : 0
      let decoded
      switch (filter) {
        case 0:
          decoded = value
          break
        case 1:
          decoded = (value + left) & 0xff
          break
        case 2:
          decoded = (value + up) & 0xff
          break
        case 3:
          decoded = (value + ((left + up) >> 1)) & 0xff
          break
        case 4: {
          const estimate = left + up - upLeft
          const pa = Math.abs(estimate - left)
          const pb = Math.abs(estimate - up)
          const pc = Math.abs(estimate - upLeft)
          const predictor = pa <= pb && pa <= pc ? left : pb <= pc ? up : upLeft
          decoded = (value + predictor) & 0xff
          break
        }
        default:
          throw new PdfToolError(`unsupported PNG filter ${filter}`, 'unsupported')
      }
      out[rowStart + x] = decoded
    }
    cursor += stride
  }
  return out
}

/* ------------------------------------------------------------------ */
/* Helpers                                                              */
/* ------------------------------------------------------------------ */

/**
 * Run work inside a private temporary directory that is always removed.
 * @param {(directory:string) => Promise<T>} work work body.
 * @returns {Promise<T>} work result.
 * @template T
 */
export async function withTempDir(work) {
  const directory = await mkdtemp(path.join(tmpdir(), 'pappers-hall-'))
  try {
    return await work(directory)
  } finally {
    await rm(directory, { recursive: true, force: true }).catch(() => {})
  }
}

export { readdir as readDirectoryEntries }
