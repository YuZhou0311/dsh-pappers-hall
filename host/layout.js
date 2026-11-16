/**
 * Real PDF page layout for the Pappers-Hall v0.2 reader (contract v0.2 §1.1).
 *
 * Poppler `pdftotext -bbox-layout` gives flow → block → line → word boxes in PDF
 * points with the origin at the top-left corner. This module turns that into:
 *
 * - reader blocks: paragraph-level cards with role (`body|heading|caption|table|
 *   header|footer|list`), column, bbox, lines and words, ordered by reading order
 *   (two-column pages are split at the page centre and sorted by (column, y),
 *   full-width blocks act as band separators);
 * - reader layer: every word/line on the page for a text-selection overlay;
 * - a heuristic Abstract extractor and a heading-based outline.
 *
 * No DSH imports and no external dependencies: the output is plain JSON stored in
 * SQLite next to the page row.
 *
 * @module pappers-hall/host/layout
 */
import { clampInt } from './paths.js'

/**
 * Version of the derived layout format; bump when parsing/semantics change.
 *
 * v4 adds PP-DocLayout-S region roles (headings/captions/tables/running heads)
 * on top of the geometric heuristics, so existing papers are regenerated once
 * after the upgrade.
 */
export const LAYOUT_VERSION = 4

/** Round a coordinate to two decimals (layer volume control). */
export function round2(value) {
  if (!Number.isFinite(value)) return 0
  return Math.round(value * 100) / 100
}

/**
 * Normalize letter-spaced small-caps text produced by LaTeX fonts.
 *
 * Poppler's bbox output splits some encoded small-caps words into single letters
 * ("A BSTRACT", "R E A C T"), which breaks heading/caption detection. This only
 * affects classification and heading display; the stored body text and word
 * layer stay untouched.
 * @param {string} text raw text.
 * @returns {string} text with single-letter gaps collapsed.
 */
export function normalizeCaps(text) {
  let output = String(text ?? '')
  for (let pass = 0; pass < 4; pass += 1) output = output.replace(/\b([A-Z])\s+(?=[A-Za-z])/g, '$1')
  return output
}

/**
 * Normalize display text only when it is dominated by single-letter tokens.
 *
 * This repairs LaTeX letter-spaced small caps inside body lines ("R E A C T")
 * without touching normal text; the word layer keeps the raw boxes for
 * selection geometry.
 * @param {string} text raw block text.
 * @returns {string} display text.
 */
export function normalizeSpacedText(text) {
  const value = String(text ?? '')
  const tokens = value.split(/\s+/).filter((token) => token !== '')
  if (tokens.length < 6) return value
  const single = tokens.filter((token) => token.length === 1).length
  return single / tokens.length > 0.35 ? normalizeCaps(value) : value
}

/** Decode the five XML entities poppler emits. */
function decodeXmlEntities(value) {
  return value
    .replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>')
    .replaceAll('&quot;', '"')
    .replaceAll('&#39;', "'")
    .replaceAll('&amp;', '&')
}

/**
 * Rebuild one line's text from word boxes using the rendered gaps.
 *
 * `pdftotext -bbox-layout` splits letter-spaced small caps into single-letter
 * words, so a blind `join(' ')` corrupts titles ("R E A C T"). Gap rules use the
 * line's median glyph height as an approximate font size:
 * - gap < 0.18 × size → concatenate (letter-spaced word fragments);
 * - 0.18–0.55 × size → one space (normal word gap);
 * - larger → one space (column/cell gap; the reader keeps the words separate).
 * @param {Array<{text:string,x:number,y:number,w:number,h:number}>} words one line's words.
 * @returns {string} reconstructed text.
 */
export function reconstructLineText(words) {
  const sorted = [...words].sort((left, right) => left.x - right.x)
  if (sorted.length === 0) return ''
  const heights = sorted.map((word) => word.h).filter((value) => Number.isFinite(value) && value > 0).sort((a, b) => a - b)
  const size = heights.length === 0 ? 10 : heights[Math.floor(heights.length / 2)]
  let text = ''
  let previous = null
  for (const word of sorted) {
    if (previous === null) {
      text = word.text
      previous = word
      continue
    }
    const gap = word.x - (previous.x + previous.w)
    // Concatenate only likely letter-fragment boundaries: a single preceding
    // letter (LaTeX small caps) or a very tight two-letter fragment. Normal word
    // gaps in tight fonts stay spaces.
    const previousLength = previous.text.length
    const join = (previousLength === 1 && gap < size * 0.18) || (previousLength === 2 && gap < size * 0.1)
    if (join) text += word.text
    else text += ` ${word.text}`
    previous = word
  }
  return text.replace(/\s+/g, ' ').trim()
}

/** Parse one XML attribute bag into a plain object. */
function parseAttributes(source) {
  const attributes = {}
  for (const match of String(source).matchAll(/([A-Za-z:]+)="([^"]*)"/g)) attributes[match[1]] = match[2]
  return attributes
}

/** Convert raw box attributes into `{x,y,w,h}` PDF-point geometry. */
function toBox(attributes) {
  const xMin = Number.parseFloat(attributes.xMin ?? '')
  const yMin = Number.parseFloat(attributes.yMin ?? '')
  const xMax = Number.parseFloat(attributes.xMax ?? '')
  const yMax = Number.parseFloat(attributes.yMax ?? '')
  if (![xMin, yMin, xMax, yMax].every(Number.isFinite)) return undefined
  return {
    x: round2(Math.min(xMin, xMax)),
    y: round2(Math.min(yMin, yMax)),
    w: round2(Math.abs(xMax - xMin)),
    h: round2(Math.abs(yMax - yMin)),
  }
}

/**
 * Build the same page/flow/block/line tree from PyMuPDF word boxes.
 *
 * The PyMuPDF bridge returns flat words with `block`/`line` indices instead of
 * Poppler's XHTML, so everything downstream (flatten, reader structure, figure
 * captions) stays backend-agnostic.
 *
 * @param {Array<{page:number,width:number|null,height:number|null,words:Array<object>}>} pages word pages.
 * @returns {Array<{page:number,width:number|null,height:number|null,flows:Array<{blocks:object[]}>}>} layout pages.
 */
export function layoutFromWordPages(pages) {
  const output = []
  for (const [index, page] of (pages ?? []).entries()) {
    const byBlock = new Map()
    for (const word of page.words ?? []) {
      const text = String(word.t ?? '').trim()
      if (text === '') continue
      const blockKey = Number.isFinite(Number(word.block)) ? Number(word.block) : 0
      const lineKey = Number.isFinite(Number(word.line)) ? Number(word.line) : 0
      if (!byBlock.has(blockKey)) byBlock.set(blockKey, new Map())
      const lines = byBlock.get(blockKey)
      if (!lines.has(lineKey)) lines.set(lineKey, [])
      lines.get(lineKey).push({
        x: round2(Number(word.x) || 0),
        y: round2(Number(word.y) || 0),
        w: round2(Number(word.w) || 0),
        h: round2(Number(word.h) || 0),
        text,
      })
    }
    const blocks = []
    for (const [, lineMap] of byBlock) {
      const lines = []
      for (const words of lineMap.values()) {
        if (words.length === 0) continue
        const x = Math.min(...words.map((word) => word.x))
        const y = Math.min(...words.map((word) => word.y))
        const right = Math.max(...words.map((word) => word.x + word.w))
        const bottom = Math.max(...words.map((word) => word.y + word.h))
        lines.push({
          bbox: { x: round2(x), y: round2(y), w: round2(right - x), h: round2(bottom - y) },
          words,
          text: reconstructLineText(words),
        })
      }
      if (lines.length === 0) continue
      lines.sort((left, right) => left.bbox.y - right.bbox.y || left.bbox.x - right.bbox.x)
      const x = Math.min(...lines.map((line) => line.bbox.x))
      const y = Math.min(...lines.map((line) => line.bbox.y))
      const right = Math.max(...lines.map((line) => line.bbox.x + line.bbox.w))
      const bottom = Math.max(...lines.map((line) => line.bbox.y + line.bbox.h))
      blocks.push({ bbox: { x: round2(x), y: round2(y), w: round2(right - x), h: round2(bottom - y) }, lines })
    }
    blocks.sort((left, right) => left.bbox.y - right.bbox.y || left.bbox.x - right.bbox.x)
    if (blocks.length === 0 && !Number.isFinite(page.width)) continue
    output.push({
      page: index + 1,
      width: Number.isFinite(page.width) ? round2(page.width) : null,
      height: Number.isFinite(page.height) ? round2(page.height) : null,
      flows: blocks.length > 0 ? [{ blocks }] : [],
    })
  }
  return output
}

/**
 * Parse `pdftotext -bbox-layout` output into pages/flows/blocks/lines/words.
 *
 * Documents that only expose word boxes (older poppler output) are grouped into
 * lines and single-line blocks so downstream code never branches on the shape.
 * @param {string} xml raw bbox-layout XHTML.
 * @returns {Array<{page:number,width:number|null,height:number|null,flows:Array<{blocks:object[]}>}>}
 */
export function parseLayoutXml(xml) {
  const pages = []
  for (const pageMatch of String(xml ?? '').matchAll(/<page\b([^>]*)>([\s\S]*?)<\/page>/g)) {
    const pageAttributes = parseAttributes(pageMatch[1])
    const width = Number.parseFloat(pageAttributes.width ?? '')
    const height = Number.parseFloat(pageAttributes.height ?? '')
    const body = pageMatch[2]
    /** @type {Array<{blocks:object[]}>} */
    const flows = []
    for (const flowMatch of body.matchAll(/<flow\b[^>]*>([\s\S]*?)<\/flow>/g)) {
      const blocks = []
      for (const blockMatch of flowMatch[1].matchAll(/<block\b([^>]*)>([\s\S]*?)<\/block>/g)) {
        const blockBox = toBox(parseAttributes(blockMatch[1]))
        const lines = []
        for (const lineMatch of blockMatch[2].matchAll(/<line\b([^>]*)>([\s\S]*?)<\/line>/g)) {
          const lineAttributes = parseAttributes(lineMatch[1])
          const words = []
          for (const wordMatch of lineMatch[2].matchAll(/<word\b([^>]*)>([\s\S]*?)<\/word>/g)) {
            const wordAttributes = parseAttributes(wordMatch[1])
            const box = toBox(wordAttributes)
            const text = decodeXmlEntities(wordMatch[2])
            if (box === undefined || text === '') continue
            words.push({ ...box, text })
          }
          if (words.length === 0) continue
          const lineBox =
            toBox(lineAttributes) ?? {
              x: Math.min(...words.map((word) => word.x)),
              y: Math.min(...words.map((word) => word.y)),
              w: round2(Math.max(...words.map((word) => word.x + word.w)) - Math.min(...words.map((word) => word.x))),
              h: round2(Math.max(...words.map((word) => word.y + word.h)) - Math.min(...words.map((word) => word.y))),
            }
          lines.push({ bbox: lineBox, words, text: reconstructLineText(words) })
        }
        if (lines.length === 0) continue
        blocks.push({ bbox: blockBox ?? lines[0].bbox, lines })
      }
      if (blocks.length > 0) flows.push({ blocks })
    }
    if (flows.length === 0) {
      // Legacy word-only shape: group into lines, then single-line blocks.
      const words = []
      for (const wordMatch of body.matchAll(/<word\b([^>]*)>([\s\S]*?)<\/word>/g)) {
        const box = toBox(parseAttributes(wordMatch[1]))
        const text = decodeXmlEntities(wordMatch[2])
        if (box !== undefined && text !== '') words.push({ ...box, text })
      }
      const lines = groupWordsIntoLines(words)
      if (lines.length > 0) flows.push({ blocks: lines.map((line) => ({ bbox: line.bbox, lines: [line] })) })
    }
    if (flows.length === 0 && !Number.isFinite(width)) continue
    pages.push({
      page: pages.length + 1,
      width: Number.isFinite(width) ? round2(width) : null,
      height: Number.isFinite(height) ? round2(height) : null,
      flows,
    })
  }
  return pages
}

/** Group flat word boxes into pseudo-lines by baseline proximity. */
export function groupWordsIntoLines(words) {
  const sorted = [...words].filter((word) => (word.text ?? '') !== '').sort((a, b) => a.y - b.y || a.x - b.x)
  const lines = []
  let current = []
  let baseline = Number.NaN
  const flush = () => {
    if (current.length === 0) return
    current.sort((a, b) => a.x - b.x)
    const text = reconstructLineText(current)
    lines.push({
      bbox: {
        x: round2(Math.min(...current.map((word) => word.x))),
        y: round2(Math.min(...current.map((word) => word.y))),
        w: round2(Math.max(...current.map((word) => word.x + word.w)) - Math.min(...current.map((word) => word.x))),
        h: round2(Math.max(...current.map((word) => word.y + word.h)) - Math.min(...current.map((word) => word.y))),
      },
      words: current,
      text,
    })
    current = []
  }
  for (const word of sorted) {
    if (Number.isFinite(baseline) && Math.abs(word.y - baseline) > 3) {
      flush()
      baseline = Number.NaN
    }
    current.push(word)
    baseline = Number.isFinite(baseline) ? Math.min(baseline, word.y) : word.y
  }
  flush()
  return lines
}

/* ------------------------------------------------------------------ */
/* Block classification and reading order                              */
/* ------------------------------------------------------------------ */

/** Heading patterns taken from real paper structure, not from one publisher. */
const NUMBERED_HEADING = /^\d{1,2}(?:\.\d{1,2}){0,3}\.?\s+[A-Z][A-Za-z]/
const NAMED_HEADING =
  /^(?:abstract|introduction|related\s+works?|background|preliminaries|method(?:s|ology)?|approach|model|experiments?|evaluation|results?|analysis|discussion|conclusions?|references|appendix(?:\s+[A-Z0-9]+)?|acknowledg(?:e)?ments?|supplementary\s+material)\b/i
const CAPTION_LINE = /^(?:figure|fig\.|table|algorithm)\s*[A-Z]?\d+[a-z]?\s*[:.]/i
const LIST_LINE = /^(?:[•·▪◦‣–—-]\s|\(\d{1,2}\)\s|\([a-z]\)\s|[a-z]\)\s)/
const PAGE_NUMBER = /^(?:page\s*)?\d{1,4}(?:\s*(?:\/|of)\s*\d{1,4})?$/i

/** Split lines of one raw block into a single normalized string. */
function blockText(lines) {
  return lines.map((line) => line.text).join(' ').replace(/\s+/g, ' ').trim()
}

/** Classify one block's role from its position and text. */
function classifyRole(block, pageWidth, pageHeight) {
  const text = blockText(block.lines)
  const normalized = normalizeCaps(text)
  const { x, y, w, h } = block.bbox
  const topBand = y + h <= pageHeight * 0.06
  const bottomBand = y >= pageHeight * 0.94
  if (topBand && (text.length <= 160 || PAGE_NUMBER.test(text))) return 'header'
  if (bottomBand && (text.length <= 160 || PAGE_NUMBER.test(text))) return 'footer'
  if (CAPTION_LINE.test(normalized)) return 'caption'
  if (h < 6) return 'header'
  // Rotated margin stamps (arXiv:xxx sidebar, DOI rails) are tall narrow blocks;
  // keep them as page furniture instead of letting them join the reading order.
  if (h > w * 2.5 && h > pageHeight * 0.2) return 'footer'
  const firstLine = normalizeCaps((block.lines[0]?.text ?? '').trim())
  const shortHeading = block.lines.length <= 2 && text.length <= 140
  if (shortHeading && (NUMBERED_HEADING.test(firstLine) || NAMED_HEADING.test(firstLine))) return 'heading'
  // All-caps short line in the upper third of the page is a section title even
  // when its wording is not in the known-heading vocabulary.
  const letters = normalized.replace(/[^A-Za-z]/g, '')
  const plainText = /^[A-Za-z0-9 ,.:;()&+\-/%'\u2019]+$/.test(normalized)
  if (shortHeading && plainText && y < pageHeight * 0.3 && letters.length >= 6 && letters === letters.toUpperCase()) return 'heading'
  if (LIST_LINE.test(firstLine)) return 'list'
  // A wide block of many short lines usually is a table.
  if (block.lines.length >= 3 && w > pageWidth * 0.5 && block.lines.every((line) => line.text.length < 60)) return 'table'
  void x
  return 'body'
}

/**
 * Build reader blocks, a page-level word layer and line layer for one page.
 *
 * The reading order algorithm partitions the page into horizontal bands around
 * wide (full-width) blocks. Inside a band, two-column pages sort by
 * `(column, y)`; single-column pages sort by `y`. Header/footer blocks are
 * ordered last so paragraph consumers (bilingual cards) never interleave them.
 * @param {{page:number,width:number|null,height:number|null,flows:object[]}} page parsed page.
 * @param {object} [options] overrides.
 * @param {number} [options.maxBlocks] safety cap.
 * @returns {{blocks:object[], words:object[], lines:object[], columns:1|2, width:number, height:number, layoutVersion:number}}
 */
export function buildReaderStructure(page, { maxBlocks = 400, regions = null } = {}) {
  const width = Number(page.width) > 0 ? Number(page.width) : 612
  const height = Number(page.height) > 0 ? Number(page.height) : 792
  /** @type {Array<{raw:object, bbox:object, role:string, text:string}>} */
  const candidates = []
  for (const flow of page.flows ?? []) {
    for (const block of flow.blocks ?? []) {
      const text = blockText(block.lines ?? [])
      if (text === '') continue
      let role = classifyRole(block, width, height)
      // A detected layout region (PP-DocLayout-S) corrects the geometric guess.
      if (Array.isArray(regions) && regions.length > 0) {
        const cx = block.bbox.x + block.bbox.w / 2
        const cy = block.bbox.y + block.bbox.h / 2
        const hit = regions.find((region) => {
          const box = region?.box
          return Array.isArray(box) && cx >= box[0] && cx <= box[2] && cy >= box[1] && cy <= box[3]
        })
        if (hit !== undefined && typeof hit.role === 'string' && hit.role !== '') role = hit.role
      }
      candidates.push({ raw: block, bbox: block.bbox, role, text })
    }
  }
  if (candidates.length === 0) {
    return { blocks: [], words: [], lines: [], columns: 1, width, height, layoutVersion: LAYOUT_VERSION }
  }

  // Two-column detection: narrow blocks split around the centre, without a
  // majority of full-width content.
  const narrow = candidates.filter((candidate) => candidate.bbox.w < width * 0.62)
  const fullWidth = candidates.filter((candidate) => candidate.bbox.w >= width * 0.62)
  const leftCount = narrow.filter((candidate) => candidate.bbox.x + candidate.bbox.w / 2 < width / 2).length
  const rightCount = narrow.length - leftCount
  // Real two-column pages have several paragraph-level blocks on both sides and
  // no majority of full-width content. A title page with an arXiv sidebar must
  // not be treated as two columns, so require worst-case two narrow body blocks
  // per side plus at least six narrow blocks overall.
  const columns =
    fullWidth.length <= candidates.length * 0.4 && narrow.length >= 6 && leftCount >= 3 && rightCount >= 2 ? 2 : 1

  /** Assign one block to column 0/1 (full-width blocks span both). */
  const columnOf = (candidate) => {
    if (columns === 1) return 0
    if (candidate.bbox.w >= width * 0.62) return -1
    return candidate.bbox.x + candidate.bbox.w / 2 < width / 2 ? 0 : 1
  }

  // Reading order via recursive XY-cut: split the page at the largest empty
  // horizontal or vertical gutter, recurse into both halves, and finally order
  // by (y, x). This handles title bands, two-column bodies, sidebar stamps and
  // mixed layouts without special cases.
  const sortYX = (list) => [...list].sort((left, right) => left.bbox.y - right.bbox.y || left.bbox.x - right.bbox.x)
  const horizontalCut = (list) => {
    const sorted = [...list].sort((left, right) => left.bbox.y - right.bbox.y)
    let best
    let covered = -Infinity
    for (const block of sorted) {
      const start = block.bbox.y
      if (Number.isFinite(covered)) {
        const gap = start - covered
        if (gap > 6 && (best === undefined || gap > best.gap)) best = { gap, at: covered + gap / 2 }
      }
      covered = Math.max(covered, block.bbox.y + block.bbox.h)
    }
    if (best === undefined) return undefined
    return {
      gap: best.gap,
      before: list.filter((block) => block.bbox.y + block.bbox.h <= best.at),
      after: list.filter((block) => block.bbox.y > best.at),
    }
  }
  const verticalCut = (list) => {
    const sorted = [...list].sort((left, right) => left.bbox.x - right.bbox.x)
    let best
    let covered = -Infinity
    for (const block of sorted) {
      const start = block.bbox.x
      if (Number.isFinite(covered)) {
        const gap = start - covered
        if (gap > 8 && (best === undefined || gap > best.gap)) best = { gap, at: covered + gap / 2 }
      }
      covered = Math.max(covered, block.bbox.x + block.bbox.w)
    }
    if (best === undefined) return undefined
    return {
      gap: best.gap,
      before: list.filter((block) => block.bbox.x + block.bbox.w <= best.at),
      after: list.filter((block) => block.bbox.x > best.at),
    }
  }
  const xyCut = (list, depth = 0) => {
    if (list.length <= 1 || depth > 8) return sortYX(list)
    const horizontal = horizontalCut(list)
    const vertical = verticalCut(list)
    const useVertical = vertical !== undefined && (horizontal === undefined || vertical.gap > horizontal.gap * 1.15)
    const cut = useVertical ? vertical : horizontal
    if (cut === undefined || cut.before.length === 0 || cut.after.length === 0) return sortYX(list)
    return [...xyCut(cut.before, depth + 1), ...xyCut(cut.after, depth + 1)]
  }
  const bodyOrder = xyCut(candidates.filter((candidate) => candidate.role !== 'header' && candidate.role !== 'footer'))
  const ordered = [...bodyOrder, ...sortYX(candidates.filter((candidate) => candidate.role === 'header')), ...sortYX(candidates.filter((candidate) => candidate.role === 'footer'))]

  // Title heuristic for page 1: the first ordered block high on the page and
  // noticeably taller than the local line height is the paper title even when the
  // wording is not in the heading vocabulary.
  if (page.page === 1) {
    const lineHeights = ordered
      .flatMap((candidate) => (candidate.raw?.lines ?? []).map((line) => line.bbox?.h))
      .filter((value) => Number.isFinite(value) && value > 0)
      .sort((a, b) => a - b)
    const medianHeight = lineHeights.length === 0 ? 10 : lineHeights[Math.floor(lineHeights.length / 2)]
    const first = ordered.find((candidate) => candidate.role !== 'header' && candidate.role !== 'footer')
    if (
      first !== undefined &&
      first.role === 'body' &&
      first.bbox.y < height * 0.3 &&
      first.bbox.w > width * 0.3 &&
      first.bbox.h <= 90 &&
      first.text.length >= 20 &&
      first.text.length <= 240 &&
      first.bbox.h >= Math.max(medianHeight * 1.25, 11)
    ) {
      first.role = 'heading'
    }
  }

  // Merge paragraphs poppler split into one block per line/author. Same role and
  // column, vertical gap below 1.6 × the local line height, and overlapping
  // horizontally. Headings, captions, tables, formulas and page furniture stay
  // separate so bilingual cards are paragraphs, not visual noise.
  const medianLineHeight = (candidate) => {
    const heights = (candidate.raw.lines ?? [])
      .map((line) => line.bbox?.h)
      .filter((value) => Number.isFinite(value) && value > 0)
      .sort((a, b) => a - b)
    return heights.length === 0 ? candidate.bbox.h : heights[Math.floor(heights.length / 2)]
  }
  const looksLikeFormula = (text) => {
    const compact = String(text ?? '').replace(/\s+/g, '')
    if (compact.length === 0) return false
    const symbols = (compact.match(/[=+\\-×÷^_∑∫√<>≤≥≈±()[\]{}|]/g) ?? []).length
    const digits = (compact.match(/[0-9]/g) ?? []).length
    return symbols / compact.length > 0.15 || digits / compact.length > 0.35
  }
  const mergedOrdered = []
  const canMerge = (left, right) =>
    left.role === right.role &&
    (left.role === 'body' || left.role === 'list') &&
    columnOf(left) === columnOf(right) &&
    left.bbox.y <= right.bbox.y &&
    right.bbox.y - (left.bbox.y + left.bbox.h) <= Math.max(1.6 * medianLineHeight(left), 1.6 * medianLineHeight(right), 2) &&
    Math.min(left.bbox.x + left.bbox.w, right.bbox.x + right.bbox.w) - Math.max(left.bbox.x, right.bbox.x) > Math.min(left.bbox.w, right.bbox.w) * 0.4 &&
    left.text.length + right.text.length <= 5000 &&
    !looksLikeFormula(left.text) &&
    !looksLikeFormula(right.text) &&
    // Author grids put one short line per person with a slightly larger gap:
    // group short adjacent lines of the same column into one credit block.
    (right.bbox.y - (left.bbox.y + left.bbox.h) <= 1.6 * Math.max(medianLineHeight(left), medianLineHeight(right), 2) ||
      (left.text.length <= 80 && right.text.length <= 80 &&
        right.bbox.y - (left.bbox.y + left.bbox.h) <= 2.6 * Math.max(medianLineHeight(left), medianLineHeight(right), 2)))
  for (const candidate of ordered) {
    const previous = mergedOrdered[mergedOrdered.length - 1]
    if (previous !== undefined && canMerge(previous, candidate)) {
      previous.lines = [...(previous.lines ?? []), ...(candidate.raw.lines ?? [])]
      previous.text = `${previous.text} ${candidate.text}`.trim()
      previous.bbox = {
        x: round2(Math.min(previous.bbox.x, candidate.bbox.x)),
        y: round2(Math.min(previous.bbox.y, candidate.bbox.y)),
        w: round2(Math.max(previous.bbox.x + previous.bbox.w, candidate.bbox.x + candidate.bbox.w) - Math.min(previous.bbox.x, candidate.bbox.x)),
        h: round2(Math.max(previous.bbox.y + previous.bbox.h, candidate.bbox.y + candidate.bbox.h) - Math.min(previous.bbox.y, candidate.bbox.y)),
      }
      continue
    }
    mergedOrdered.push({ ...candidate })
  }

  // Page 1 credit area: names/emails/affiliations are laid out as one short line
  // per person. Group them into one credit paragraph so the bilingual card is not
  // a wall of one-name blocks (the lines keep their own bbox inside the block).
  if (page.page === 1) {
    const creditIndexes = []
    for (let index = 0; index < mergedOrdered.length; index += 1) {
      const candidate = mergedOrdered[index]
      if (candidate.role === 'body' && candidate.bbox.y < height * 0.45 && candidate.text.length <= 120) creditIndexes.push(index)
    }
    if (creditIndexes.length >= 3) {
      const firstIndex = creditIndexes[0]
      const credits = creditIndexes.map((index) => mergedOrdered[index]).sort((left, right) => left.bbox.y - right.bbox.y || left.bbox.x - right.bbox.x)
      const mergedCredit = {
        ...credits[0],
        lines: credits.flatMap((candidate) => candidate.lines ?? candidate.raw?.lines ?? []),
        text: credits.map((candidate) => candidate.text).join(' '),
        bbox: {
          x: round2(Math.min(...credits.map((candidate) => candidate.bbox.x))),
          y: round2(Math.min(...credits.map((candidate) => candidate.bbox.y))),
          w: round2(
            Math.max(...credits.map((candidate) => candidate.bbox.x + candidate.bbox.w)) - Math.min(...credits.map((candidate) => candidate.bbox.x)),
          ),
          h: round2(
            Math.max(...credits.map((candidate) => candidate.bbox.y + candidate.bbox.h)) - Math.min(...credits.map((candidate) => candidate.bbox.y)),
          ),
        },
      }
      const kept = mergedOrdered.filter((_, index) => !creditIndexes.includes(index))
      kept.splice(Math.min(firstIndex, kept.length), 0, mergedCredit)
      mergedOrdered.length = 0
      mergedOrdered.push(...kept)
    }
  }

  // Output order is the reading order the Client relies on: page furniture first
  // (header, by y), then the page-1 title, then content sorted by (column, y),
  // and finally footer furniture (by y). Captions/tables/headings travel with
  // their column so a bilingual column stays contiguous.
  const pageTitle =
    page.page === 1
      ? mergedOrdered.find(
          (candidate) =>
            candidate.role === 'heading' && candidate.bbox.y < height * 0.3 && (candidate.bbox.h > 22 || candidate.text.length > 40),
        )
      : undefined
  const byY = (left, right) => left.bbox.y - right.bbox.y || left.bbox.x - right.bbox.x
  const headers = mergedOrdered.filter((candidate) => candidate.role === 'header').sort(byY)
  const footers = mergedOrdered.filter((candidate) => candidate.role === 'footer').sort(byY)
  // Full-width blocks report column 0, so they must sort with column 0 (not
  // before it) or the client sees a y-jump inside the first column.
  const outputColumn = (candidate) => {
    const column = columnOf(candidate)
    return column === -1 ? 0 : column
  }
  const content = mergedOrdered
    .filter((candidate) => candidate !== pageTitle && candidate.role !== 'header' && candidate.role !== 'footer')
    .sort((left, right) => outputColumn(left) - outputColumn(right) || left.bbox.y - right.bbox.y || left.bbox.x - right.bbox.x)
  const outputOrder = [...headers, ...(pageTitle === undefined ? [] : [pageTitle]), ...content, ...footers]

  const blocks = []
  for (const [index, candidate] of outputOrder.slice(0, maxBlocks).entries()) {
    const column = columnOf(candidate)
    const displayText =
      candidate.role === 'heading' || candidate.role === 'caption' ? normalizeCaps(candidate.text) : normalizeSpacedText(candidate.text)
    blocks.push({
      id: `p${page.page}b${index}`,
      role: candidate.role,
      column: column === -1 ? 0 : column,
      fullWidth: column === -1,
      bbox: candidate.bbox,
      text: displayText,
      lines: (candidate.lines ?? candidate.raw?.lines ?? []).map((line) => ({ bbox: line.bbox, text: line.text })),
    })
  }

  // Page-level word/line layer for text selection: include every word, in the
  // same reading order as the blocks they belong to.
  const words = []
  const lines = []
  for (const candidate of ordered) {
    const column = columnOf(candidate)
    for (const line of candidate.raw.lines ?? []) {
      lines.push({ x: line.bbox.x, y: line.bbox.y, w: line.bbox.w, h: line.bbox.h, column: column === -1 ? 0 : column })
      for (const word of line.words ?? []) {
        words.push({ t: word.text, x: round2(word.x), y: round2(word.y), w: round2(word.w), h: round2(word.h) })
      }
    }
  }
  return { blocks, words, lines, columns, width, height, layoutVersion: LAYOUT_VERSION }
}

/**
 * Build the full per-page structure for one document.
 * @param {Array<{page:number,width:number|null,height:number|null,flows:object[]}>} pages parsed pages.
 * @returns {Array<object>} one structure per page.
 */
export function buildDocumentStructure(pages) {
  return pages.map((page) => buildReaderStructure(page))
}

/* ------------------------------------------------------------------ */
/* Abstract and outline                                                */
/* ------------------------------------------------------------------ */

/** Join block text with sensible spacing. */
function joinBlockText(blocks) {
  return blocks
    .map((block) => block.text)
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim()
}

/**
 * Extract the paper abstract from page-1/2 blocks (§1.3 heuristic).
 *
 * The PDF text is preferred, but a missing or implausible result returns
 * `{text:null}` so the caller can fall back to bibliography metadata instead of
 * inventing a summary.
 * @param {Array<{page:number,blocks:object[]}>} pageStructures reader structures in page order.
 * @param {number} [maxChars] cap on extracted length.
 * @returns {{text:string|null, source:'pdf'|null}}
 */
export function extractAbstract(pageStructures, maxChars = 2600) {
  for (const page of pageStructures.slice(0, 3)) {
    const blocks = page.blocks ?? []
    let headingIndex = -1
    for (let index = 0; index < blocks.length; index += 1) {
      const text = normalizeCaps(blocks[index].text.trim())
      if (/^abstract\b/i.test(text) || (blocks[index].role === 'heading' && /^abstract$/i.test(text))) {
        headingIndex = index
        break
      }
    }
    if (headingIndex < 0) continue
    const collected = []
    let chars = 0
    for (let index = headingIndex + 1; index < blocks.length; index += 1) {
      const block = blocks[index]
      if (block.role === 'header' || block.role === 'footer') continue
      if (block.role === 'heading') break
      const text = block.text.trim()
      if (text === '') continue
      collected.push(text)
      chars += text.length
      if (chars >= maxChars) break
    }
    if (collected.length === 0) continue
    const text = joinBlockText(collected.map((value) => ({ text: value })))
    if (text.length < 80) continue
    return { text: text.slice(0, maxChars), source: 'pdf' }
  }
  // Fallback for papers without an "Abstract" heading (e.g. Nature layout):
  // take the largest first-page body paragraph. If page 1 is fragmented into
  // adjacent body runs, concatenate same-column neighbours and take the largest
  // run. This stays heuristic, so the source is labelled pdf-heuristic.
  const pageOne = pageStructures.find((page) => Number(page.page ?? 1) === 1) ?? pageStructures[0]
  if (pageOne !== undefined) {
    const bodyBlocks = (pageOne.blocks ?? []).filter((block) => block.role === 'body' && typeof block.text === 'string')
    const single = bodyBlocks
      .map((block) => block.text.trim())
      .filter((text) => text.length > 400)
      .sort((left, right) => right.length - left.length)[0]
    if (single !== undefined) return { text: single.slice(0, 1200), source: 'pdf-heuristic' }
    const groups = []
    let currentColumn
    let run = ''
    for (const block of bodyBlocks) {
      const column = Number(block.column ?? 0)
      if (currentColumn !== undefined && column !== currentColumn) {
        groups.push(run)
        run = ''
      }
      run = run === '' ? block.text.trim() : `${run} ${block.text.trim()}`
      currentColumn = column
    }
    if (run !== '') groups.push(run)
    const group = groups.filter((text) => text.length > 400).sort((left, right) => right.length - left.length)[0]
    if (group !== undefined) return { text: group.slice(0, 1200), source: 'pdf-heuristic' }
  }
  return { text: null, source: null }
}

/**
 * Build a heading-based outline from reader blocks.
 * @param {Array<{page:number,blocks:object[]}>} pageStructures reader structures in page order.
 * @returns {Array<{title:string,page:number,level:number}>} outline items.
 */
export function buildOutline(pageStructures) {
  const items = []
  const seen = new Set()
  for (const [index, page] of pageStructures.entries()) {
    for (const block of page.blocks ?? []) {
      if (block.role !== 'heading') continue
      // A tall heading on page 1 is the paper title, not a section. Also skip any
      // page-1 heading whose wording is not a known section name.
      if (page.page === 1 && (block.bbox?.h ?? 0) > 22) continue
      if (page.page === 1 && !NAMED_HEADING.test(block.text) && !NUMBERED_HEADING.test(block.text) && !/^abstract\b/i.test(block.text)) continue
      const title = normalizeCaps(block.text).replace(/\s+/g, ' ').trim().slice(0, 180)
      // Drop OCR/figure-damaged heading noise (e.g. "IL IL+RL", "I1·TN").
      if (title.length < 3) continue
      const letterCount = (title.match(/[A-Za-z]/g) ?? []).length
      if (letterCount < 3) continue
      if (letterCount / title.length < 0.5) continue
      if (/[=<>≤≥^_{}|]/.test(title) && !/[a-z]/.test(title)) continue
      if (/^[A-Z0-9 .+\-]{0,5}$/.test(title)) continue
      if (title === '' || seen.has(title.toLowerCase())) continue
      const levelMatch = /^(\d{1,2}(?:\.\d{1,2}){0,3})\s/.exec(title)
      const level = levelMatch === null ? 1 : Math.min(4, levelMatch[1].split('.').length)
      seen.add(title.toLowerCase())
      items.push({ title, page: Number.isFinite(Number(page.page)) ? Number(page.page) : index + 1, level })
      if (items.length >= 120) return items
    }
  }
  return items
}

/**
 * Count body words and approximate paper text length for diagnostics.
 * @param {object[]} pageStructures reader structures.
 * @returns {{words:number, blocks:number, pages:number}} counts.
 */
export function structureCounts(pageStructures) {
  let words = 0
  let blocks = 0
  for (const page of pageStructures) {
    blocks += (page.blocks ?? []).length
    words += (page.words ?? []).length
  }
  return { words, blocks, pages: pageStructures.length }
}

/** Clamp a page number into one document. */
export function clampPage(page, pageCount) {
  return clampInt(page, 1, Math.max(1, pageCount), 1)
}
