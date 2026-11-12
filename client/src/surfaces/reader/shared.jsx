/**
 * Shared reader toolkit: API adapter, i18n fallback resolver, geometry helpers,
 * React hooks, inline icons and small primitives.
 *
 * Deliberately self-contained (only `react` is imported) so the reader half can
 * be built, smoke-tested and reviewed while `core/**` is still landing; the
 * icon/primitives equivalents are intentionally kept small. At integration time
 * these helpers can be swapped for `../core/{icons,primitives}.jsx` without
 * touching the reader logic (all components consume them through this module).
 */
import React from 'react'
import { READER_EN, READER_ZH, detectLanguage, interpolate } from './messages.js'
import { SlidingThumb, useSlidingThumb } from '../../core/motion.js'

/* -------------------------------------------------------------------------- */
/* Constants                                                                   */
/* -------------------------------------------------------------------------- */

/** Preferred raster width for page images (Host renders the PNG at this width). */
export const PAGE_IMAGE_WIDTH = 1400
/** Preferred raster width for page thumbnails. */
export const THUMB_IMAGE_WIDTH = 220
/** Zoom bounds mandated by the v0.2 contract (75 %–200 % of fit width). */
export const ZOOM_MIN = 0.75
export const ZOOM_MAX = 2
export const ZOOM_STEP = 0.1

/** Highlight palette; names match `annotations.create.color` in the contract. */
export const ANNOTATION_COLORS = ['yellow', 'green', 'blue', 'red', 'purple']

/** Palette values (document annotation colours, not theme tokens). */
export const ANNOTATION_PALETTE = Object.freeze({
  yellow: { hex: '#f2c200', css: '#f2c200' },
  green: { hex: '#3faf58', css: '#3faf58' },
  blue: { hex: '#3d7bfd', css: '#3d7bfd' },
  red: { hex: '#e04b4b', css: '#e04b4b' },
  purple: { hex: '#9b59b6', css: '#9b59b6' },
})

/* -------------------------------------------------------------------------- */
/* Tiny helpers                                                                */
/* -------------------------------------------------------------------------- */

/** Join truthy class names. */
export function cx() {
  let out = ''
  for (let i = 0; i < arguments.length; i += 1) {
    const value = arguments[i]
    if (value) out += (out ? ' ' : '') + value
  }
  return out
}

/** Clamp a number into [min, max]; non-finite input falls back to min. */
export function clamp(value, min, max) {
  const n = Number(value)
  if (!Number.isFinite(n)) return min
  return n < min ? min : n > max ? max : n
}

/** Coerce to number, falling back left to right. */
export function num() {
  for (let i = 0; i < arguments.length; i += 1) {
    const value = Number(arguments[i])
    if (Number.isFinite(value)) return value
  }
  return 0
}

/** Coerce to array. */
export function arrayOf(value) {
  return Array.isArray(value) ? value : []
}

/** First non-empty string argument. */
export function firstText() {
  for (let i = 0; i < arguments.length; i += 1) {
    const value = arguments[i]
    if (typeof value === 'string' && value.trim() !== '') return value
  }
  return ''
}

/** Random id with a safe fallback for older engines. */
export function randomId() {
  try {
    if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') return crypto.randomUUID()
  } catch {
    /* fall through */
  }
  return Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 10)
}

/** Idempotency key for one user-visible write. */
export function newOperationId(prefix) {
  return (prefix ? prefix + '-' : '') + randomId()
}

/** Round to 4 decimals (normalised rects are stored as 0–1 floats). */
export function round4(value) {
  return Math.round(Number(value) * 10000) / 10000
}

/** Format a timestamp for annotation cards. */
export function formatTime(value) {
  if (!value) return ''
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return ''
  try {
    return date.toLocaleString()
  } catch {
    return date.toISOString().slice(0, 16).replace('T', ' ')
  }
}

/** Compact elapsed-time label for the AI panel. */
export function formatElapsed(ms) {
  const value = Number(ms)
  if (!Number.isFinite(value) || value <= 0) return ''
  if (value < 1000) return String(Math.round(value))
  return (value / 1000).toFixed(1) + 's'
}

/** Copy text to the clipboard; resolves to whether it succeeded. */
export async function copyText(text) {
  const value = String(text == null ? '' : text)
  if (!value) return false
  try {
    if (typeof navigator !== 'undefined' && navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
      await navigator.clipboard.writeText(value)
      return true
    }
  } catch {
    /* fall through to the legacy path */
  }
  try {
    if (typeof document === 'undefined' || !document.body) return false
    const area = document.createElement('textarea')
    area.value = value
    area.setAttribute('readonly', '')
    area.style.position = 'fixed'
    area.style.top = '-1000px'
    area.style.opacity = '0'
    document.body.appendChild(area)
    area.select()
    const ok = typeof document.execCommand === 'function' ? document.execCommand('copy') : false
    area.remove()
    return Boolean(ok)
  } catch {
    return false
  }
}

/** Read one UI preference from localStorage (never throws). */
export function readPref(key, fallback) {
  try {
    if (typeof localStorage === 'undefined') return fallback
    const raw = localStorage.getItem('pappers-hall:' + key)
    return raw == null ? fallback : JSON.parse(raw)
  } catch {
    return fallback
  }
}

/** Persist one UI preference to localStorage (never throws). */
export function writePref(key, value) {
  try {
    if (typeof localStorage === 'undefined') return
    localStorage.setItem('pappers-hall:' + key, JSON.stringify(value))
  } catch {
    /* private mode / quota — preferences are best effort */
  }
}

/** Persisted reading position for one paper (page number). */
export function readReadingPosition(paperId) {
  const value = num(readPref('reader-position:' + String(paperId || ''), 0))
  return value > 0 ? Math.round(value) : 0
}

/** Persist the reading position; called debounced by the reader shell. */
export function saveReadingPosition(paperId, page) {
  if (!paperId) return
  writePref('reader-position:' + String(paperId), Math.round(num(page, 1)))
}

/* -------------------------------------------------------------------------- */
/* Host API adapter                                                            */
/* -------------------------------------------------------------------------- */

/** Build a callable from the `api` prop (function, or object with `.call`). */
export function createApiCaller(api) {
  if (typeof api === 'function') {
    return (method, params, options) => Promise.resolve(api(method, params, options))
  }
  if (api && typeof api.call === 'function') {
    return (method, params, options) => Promise.resolve(api.call(method, params, options))
  }
  return () => Promise.reject(makeApiError('unavailable', 'Pappers-Hall API is not available'))
}

/** Error carrying the contract error code. */
export function makeApiError(code, message) {
  const error = new Error(message || code || 'error')
  error.code = code || 'internal'
  return error
}

/** Unwrap the v0.1 `{ok,data}` envelope if a future transport returns one. */
export function unwrapApiResult(result) {
  if (result && typeof result === 'object' && Object.prototype.hasOwnProperty.call(result, 'ok')) {
    if (result.ok === false) {
      const error = result.error || {}
      throw makeApiError(firstText(error.code, 'internal'), firstText(error.message, 'request failed'))
    }
    return result.data
  }
  return result
}

/** True when the failure means the plugin/API is absent rather than a data error. */
export function isOfflineError(error) {
  if (!error) return false
  const code = firstText(error.code)
  if (code === 'not_running' || code === 'offline' || code === 'network' || code === 'unavailable') return true
  const message = String(error.message || '').toLowerCase()
  return message.indexOf('failed to fetch') >= 0 || message.indexOf('network') >= 0 || message.indexOf('load failed') >= 0
}

/** Short human message for an API error. */
export function describeError(error) {
  if (!error) return ''
  return firstText(error.message, error.code, String(error))
}

/* -------------------------------------------------------------------------- */
/* i18n                                                                        */
/* -------------------------------------------------------------------------- */

function safeTranslate(t, key, params) {
  try {
    return typeof t === 'function' ? t(key, params) : ''
  } catch {
    return ''
  }
}

/**
 * Wrap the slotted `t` with the reader fallback table.
 * `t` returns the key itself for unknown keys (DSH locale contract), so a
 * fallback is used whenever the caller dictionary has not caught up yet.
 * @returns {(key: string, params?: object) => string}
 */
export function buildReaderT(t) {
  const language = detectLanguage(safeTranslate(t, 'panel.title'))
  const table = language === 'en' ? READER_EN : READER_ZH
  return function readerTranslate(key, params) {
    const fullKey = String(key || '').startsWith('reader.') ? String(key) : 'reader.' + String(key || '')
    const translated = safeTranslate(t, fullKey, params)
    if (typeof translated === 'string' && translated !== '' && translated !== fullKey) {
      // The Host translator already substitutes {name}; legacy builds may return
      // the raw template, so interpolating again is a no-op in the normal case.
      return interpolate(translated, params)
    }
    const template = table[fullKey] || READER_ZH[fullKey]
    if (template == null) return fullKey
    return interpolate(template, params)
  }
}

/* -------------------------------------------------------------------------- */
/* URLs                                                                        */
/* -------------------------------------------------------------------------- */

/** URL of one rendered PDF page. */
export function pageImageUrl(paperId, page, width) {
  return (
    '/pappers-hall/page/' +
    encodeURIComponent(String(paperId || '')) +
    '/' +
    encodeURIComponent(String(page || 1)) +
    '.png?width=' +
    String(width || PAGE_IMAGE_WIDTH)
  )
}

/** Prefer the Host-reported page image URL, else build the contract URL. */
export function pageUrlOf(paperId, pageInfo) {
  const reported = pageInfo && typeof pageInfo.imageUrl === 'string' ? pageInfo.imageUrl : ''
  return reported || pageImageUrl(paperId, (pageInfo && pageInfo.page) || 1)
}

/* -------------------------------------------------------------------------- */
/* Geometry (normalised 0–1 rects relative to the page box)                    */
/* -------------------------------------------------------------------------- */

/** True when the value looks like a normalised 0–1 rect. */
export function validRect(rect) {
  if (!rect || typeof rect !== 'object') return false
  const x = Number(rect.x)
  const y = Number(rect.y)
  const w = Number(rect.w)
  const h = Number(rect.h)
  if (![x, y, w, h].every((value) => Number.isFinite(value))) return false
  return w > 0.0005 && h > 0.0005 && x >= -0.01 && y >= -0.01 && x <= 1.01 && y <= 1.01
}

/** Copy/clip one rect into the normalised page box. */
export function normalizeRect(rect) {
  if (!validRect(rect)) return null
  const x = clamp(Number(rect.x), 0, 1)
  const y = clamp(Number(rect.y), 0, 1)
  const w = clamp(Number(rect.w), 0, 1 - x)
  const h = clamp(Number(rect.h), 0, 1 - y)
  if (w < 0.0005 || h < 0.0005) return null
  return { x: round4(x), y: round4(y), w: round4(w), h: round4(h) }
}

/** Bounding box of several rects. */
export function unionRect(rects) {
  const list = arrayOf(rects).map(normalizeRect).filter(Boolean)
  if (list.length === 0) return null
  let minX = 1
  let minY = 1
  let maxX = 0
  let maxY = 0
  for (const rect of list) {
    minX = Math.min(minX, rect.x)
    minY = Math.min(minY, rect.y)
    maxX = Math.max(maxX, rect.x + rect.w)
    maxY = Math.max(maxY, rect.y + rect.h)
  }
  return normalizeRect({ x: minX, y: minY, w: maxX - minX, h: maxY - minY })
}

/** Merge per-span line rects into per-line rects (selection → highlight rects). */
export function mergeRects(rects) {
  const list = arrayOf(rects).map(normalizeRect).filter(Boolean)
  if (list.length <= 1) return list
  const sorted = list.slice().sort((left, right) => left.y - right.y || left.x - right.x)
  const merged = []
  for (const rect of sorted) {
    const last = merged[merged.length - 1]
    // Same visual line: vertical centres close relative to the taller box.
    const sameLine =
      last &&
      Math.abs(last.y + last.h / 2 - (rect.y + rect.h / 2)) < Math.max(last.h, rect.h) * 0.6
    // Adjacent segments of one line (word boxes / Range segments) sit < 2 % apart.
    const gap = last ? rect.x - (last.x + last.w) : 0
    const adjacent = last && gap <= 0.02 && gap >= -0.02
    if (sameLine && adjacent) {
      const right = Math.max(last.x + last.w, rect.x + rect.w)
      last.y = round4(Math.min(last.y, rect.y))
      last.w = round4(right - last.x)
      last.h = round4(Math.max(last.h, rect.h))
    } else {
      merged.push(Object.assign({}, rect))
    }
  }
  return merged
}

/** Normalise an already-normalised rect into CSS percentages. */
export function rectStyle(rect) {
  if (!rect) return null
  return {
    left: (rect.x * 100).toFixed(3) + '%',
    top: (rect.y * 100).toFixed(3) + '%',
    width: (rect.w * 100).toFixed(3) + '%',
    height: (rect.h * 100).toFixed(3) + '%',
  }
}

/** Hit-test one point against a list of normalised rects. */
export function rectContains(rect, point) {
  if (!rect || !point) return false
  return point.x >= rect.x && point.x <= rect.x + rect.w && point.y >= rect.y && point.y <= rect.y + rect.h
}

/**
 * Conservative detector for journal page furniture misclassified as body text
 * (cover metadata, affiliations, copyright lines). Used by both the shell (to
 * avoid translating furniture) and the bilingual panel (to hide it by default).
 * A real paragraph that merely mentions a URL is never matched.
 */
export function looksLikePageMetadata(text) {
  const value = String(text == null ? '' : text).trim()
  if (value === '') return true
  let score = 0
  if (/received:\s*\d|accepted:\s*\d|published online:/i.test(value)) score += 2
  if (/check for updates|all rights reserved|creative commons|©|\(\);,/i.test(value)) score += 2
  if (/^(article|review|letter|correspondence|editorial)\b/i.test(value)) score += 2
  const emails = value.match(/@[\w.-]+\.\w+/g) || []
  if (emails.length >= 2) score += 2
  const postalCodes = value.match(/\b\d{3,5}\s+[A-Z]/g) || []
  if (postalCodes.length >= 2 && /university|institute|department|association|germany|usa|uk|netherlands|switzerland/i.test(value)) score += 2
  if (/^[A-Za-z .&|()0-9-]{0,40}\|\s*\(\d{4}\)/.test(value)) score += 2
  if (/(?:https?:\/\/|doi\.org)/i.test(value)) score += 1
  if (value.length < 160 && /^article\b/i.test(value) && /(?:https?:\/\/|doi\.org)/i.test(value)) score += 1
  return score >= 2
}

/* -------------------------------------------------------------------------- */
/* Annotations                                                                 */
/* -------------------------------------------------------------------------- */

/** Map any historical colour value (name or hex) onto the palette name. */
export function colorName(value) {
  const text = String(value || '').toLowerCase()
  if (ANNOTATION_PALETTE[text]) return text
  const match = /^#?([0-9a-f]{3,8})$/.exec(text)
  if (!match) return 'yellow'
  let hex = match[1]
  if (hex.length === 3) hex = hex.split('').map((char) => char + char).join('')
  const r = parseInt(hex.slice(0, 2), 16)
  const g = parseInt(hex.slice(2, 4), 16)
  const b = parseInt(hex.slice(4, 6), 16)
  let best = 'yellow'
  let bestDistance = Number.POSITIVE_INFINITY
  for (const name of ANNOTATION_COLORS) {
    const target = ANNOTATION_PALETTE[name].hex
    const tr = parseInt(target.slice(1, 3), 16)
    const tg = parseInt(target.slice(3, 5), 16)
    const tb = parseInt(target.slice(5, 7), 16)
    const distance = (r - tr) ** 2 + (g - tg) ** 2 + (b - tb) ** 2
    if (distance < bestDistance) {
      bestDistance = distance
      best = name
    }
  }
  return best
}

/** CSS colour for one palette name. */
export function colorHex(name) {
  return (ANNOTATION_PALETTE[colorName(name)] || ANNOTATION_PALETTE.yellow).hex
}

/**
 * Normalise a v0.1 or v0.2 annotation record into the shape every reader
 * component expects: `{id, page, kind, rects, quote, comment, color, origin, …}`.
 */
export function normalizeAnnotation(raw) {
  if (!raw || typeof raw !== 'object') return null
  const id = firstText(raw.id, raw.annotationId)
  if (!id) return null
  const rects = []
  for (const candidate of arrayOf(raw.rects)) {
    const rect = normalizeRect(candidate)
    if (rect) rects.push(rect)
  }
  const legacyRect = normalizeRect(raw.rect)
  if (legacyRect) {
    // v0.1 area annotations carry a single `rect`; avoid duplicating if v2
    // already exposed the same geometry through `rects`.
    const duplicate = rects.some((rect) => Math.abs(rect.x - legacyRect.x) < 1e-4 && Math.abs(rect.y - legacyRect.y) < 1e-4)
    if (!duplicate) rects.push(legacyRect)
  }
  const kind = firstText(raw.kind, legacyRect ? 'area' : rects.length > 0 ? 'highlight' : 'note')
  const quote = firstText(raw.quote)
  const comment = firstText(raw.comment, raw.text, raw.note)
  return {
    id: String(id),
    paperId: raw.paperId != null ? String(raw.paperId) : '',
    versionId: raw.versionId != null ? String(raw.versionId) : '',
    page: Math.max(1, Math.round(num(raw.page, 1))),
    kind: kind === 'highlight' || kind === 'area' || kind === 'note' ? kind : 'highlight',
    rects,
    rect: rects.length > 0 ? rects[0] : null,
    quote,
    comment,
    color: colorName(raw.color),
    origin: firstText(raw.origin, 'user_note'),
    createdAt: raw.createdAt || '',
    updatedAt: raw.updatedAt || '',
    revision: Math.round(num(raw.revision, 0)),
    state: firstText(raw.state, 'active'),
    pending: Boolean(raw.pending),
  }
}

/** Normalise a list, filtering malformed / trashed records. */
export function normalizeAnnotations(list) {
  return arrayOf(list)
    .map(normalizeAnnotation)
    .filter((annotation) => annotation && annotation.state !== 'trash')
}

/** Topmost annotation whose rect contains the point (page-scoped list). */
export function annotationAt(annotations, point) {
  const list = arrayOf(annotations)
  for (let i = list.length - 1; i >= 0; i -= 1) {
    const annotation = list[i]
    if (!annotation) continue
    if (annotation.kind === 'note') {
      const anchor = noteAnchor(annotation)
      if (anchor && Math.abs(anchor.x - point.x) < 0.035 && Math.abs(anchor.y - point.y) < 0.035) return annotation
      continue
    }
    for (const rect of annotation.rects) {
      if (rectContains(rect, point)) return annotation
    }
  }
  return null
}

/** Anchor point of a note annotation (centre of its rect, or page corner). */
export function noteAnchor(annotation) {
  const rect = annotation && annotation.rects && annotation.rects[0]
  if (!rect) return null
  return { x: rect.x + rect.w / 2, y: rect.y + rect.h / 2 }
}

/** Human label for an annotation origin. */
export function annotationOriginLabel(rt, origin) {
  if (origin === 'ai_explanation') return rt('reader.annot.origin.ai')
  if (origin === 'test_note') return rt('reader.annot.origin.test')
  return rt('reader.annot.origin.user')
}

/** Human label for an annotation kind. */
export function annotationKindLabel(rt, kind) {
  if (kind === 'area') return rt('reader.annot.kind.area')
  if (kind === 'note') return rt('reader.annot.kind.note')
  return rt('reader.annot.kind.highlight')
}

/* -------------------------------------------------------------------------- */
/* Text selection / page search                                                */
/* -------------------------------------------------------------------------- */

/**
 * Geometric hit test: words whose bbox overlaps the drag rectangle.
 * All coordinates use the layer's PDF-point space; indexes are returned in
 * reading order (the layer word array order), never DOM order.
 */
export function hitTestWords(words, rect) {
  const list = arrayOf(words)
  if (!rect || !(num(rect.w) > 0) || !(num(rect.h) > 0)) return []
  const indexes = []
  for (let index = 0; index < list.length; index += 1) {
    const word = list[index]
    if (!word) continue
    const x = num(word.x)
    const y = num(word.y)
    const w = num(word.w)
    const h = num(word.h)
    if (!(w > 0) || !(h > 0)) continue
    const overlapX = Math.min(x + w, rect.x + rect.w) - Math.max(x, rect.x)
    const overlapY = Math.min(y + h, rect.y + rect.h) - Math.max(y, rect.y)
    if (overlapX <= 0 || overlapY <= 0) continue
    // Require a small real overlap so a thin drag across a line does not pull
    // in every neighbouring box.
    if ((overlapX * overlapY) / (w * h) < 0.06) continue
    indexes.push(index)
  }
  return indexes
}

/**
 * Find the word nearest to a page point (points-space), preferring a box that
 * contains the point. Returns -1 when nothing is close enough so callers can
 * fall back to rectangle hit-testing in margins.
 * @param {object[]} words rendered word boxes (x/y/w/h in points).
 * @param {{x:number,y:number}} point page point in points.
 * @param {number} pageWidth page width in points.
 * @returns {number} word index or -1.
 */
export function wordIndexAt(words, point, pageWidth) {
  const list = arrayOf(words)
  if (!point || !(num(pageWidth) > 0)) return -1
  const px = num(point.x)
  const py = num(point.y)
  const tolerance = Math.max(10, Math.min(36, num(pageWidth) * 0.05))
  let best = -1
  let bestDistance = tolerance * tolerance
  for (let index = 0; index < list.length; index += 1) {
    const word = list[index]
    if (!word || word.t == null || String(word.t) === '') continue
    if (!(num(word.w) > 0) || !(num(word.h) > 0)) continue
    if (isRotatedWord(word, 1000)) continue
    const x = num(word.x)
    const y = num(word.y)
    const dx = px < x ? x - px : px > x + num(word.w) ? px - (x + num(word.w)) : 0
    const dy = py < y ? y - py : py > y + num(word.h) ? py - (y + num(word.h)) : 0
    const distance = dx * dx + dy * dy
    if (distance < bestDistance) {
      bestDistance = distance
      best = index
    }
    if (dx === 0 && dy === 0) return index
  }
  return best
}

/** Points-space rectangle from two normalised points. */
export function pointRect(start, end) {
  if (!start || !end) return null
  return {
    x: Math.min(start.x, end.x),
    y: Math.min(start.y, end.y),
    w: Math.abs(start.x - end.x),
    h: Math.abs(start.y - end.y),
  }
}

/** True when a word box looks like rotated / vertical text (arXiv side stamp). */
export function isRotatedWord(word, pageHeight) {
  const width = num(word && word.w)
  const height = num(word && word.h)
  if (!(width > 0.2) || !(height > 0.2)) return true
  if (height > width * 2.5 && height > 8) return true
  if (pageHeight > 0 && height > pageHeight * 0.04 && width < height * 0.3) return true
  return false
}

/** Group selected words into visual lines while preserving reading order. */
function groupWordsIntoLines(words) {
  const lines = []
  for (const word of words) {
    const y = num(word.y)
    const h = num(word.h)
    const last = lines[lines.length - 1]
    if (last) {
      const overlap = Math.min(y + h, last.y + last.h) - Math.max(y, last.y)
      if (overlap > Math.min(h, last.h) * 0.4) {
        last.words.push(word)
        last.y = Math.min(last.y, y)
        last.h = Math.max(last.y + last.h, y + h) - last.y
        continue
      }
    }
    lines.push({ y, h, words: [word] })
  }
  return lines
}

/**
 * Assemble readable text for one selected line.
 * Normal lines join whole words with spaces; letter-spaced lines (many single
 * glyph "words", as produced for small-caps titles) only insert a space when the
 * geometric gap is clearly larger than the glyph gap.
 */
function lineTextFromWords(words) {
  const sorted = words.slice().sort((left, right) => num(left.x) - num(right.x))
  const gaps = []
  for (let index = 1; index < sorted.length; index += 1) {
    gaps.push(num(sorted[index].x) - (num(sorted[index - 1].x) + num(sorted[index - 1].w)))
  }
  const singleGlyphs = sorted.filter((word) => String(word.t).trim().length <= 1).length
  const letterSpaced = sorted.length >= 6 && singleGlyphs / Math.max(1, sorted.length) > 0.5
  const orderedGaps = gaps.slice().sort((left, right) => left - right)
  const medianGap = orderedGaps.length ? orderedGaps[Math.floor(orderedGaps.length / 2)] : 0
  const threshold = Math.max(2.2, medianGap * 1.8)
  let text = ''
  for (let index = 0; index < sorted.length; index += 1) {
    if (index > 0) {
      const gap = num(sorted[index].x) - (num(sorted[index - 1].x) + num(sorted[index - 1].w))
      if (!letterSpaced || gap > threshold) text += ' '
    }
    text += String(sorted[index].t)
  }
  return text
}

/**
 * Build quote + per-line rects for a selection made of known layer words.
 * Geometry (not DOM order) decides line boxes, so rotated stamps never leak into
 * rects and multi-line selections map to one rect per line.
 */
export function buildWordSelection(words, indexes, width, height) {
  if (!(num(width) > 0) || !(num(height) > 0)) return null
  const chosen = []
  for (const index of indexes) {
    const word = words[index]
    if (!word || word.t == null || String(word.t) === '') continue
    if (isRotatedWord(word, height)) continue
    chosen.push(word)
  }
  if (chosen.length === 0) return null
  const lines = groupWordsIntoLines(chosen)
  const rects = []
  const texts = []
  for (const line of lines) {
    const sorted = line.words.slice().sort((left, right) => num(left.x) - num(right.x))
    const minX = Math.min(...sorted.map((word) => num(word.x)))
    const maxX = Math.max(...sorted.map((word) => num(word.x) + num(word.w)))
    const minY = Math.min(...sorted.map((word) => num(word.y)))
    const maxY = Math.max(...sorted.map((word) => num(word.y) + num(word.h)))
    const rect = normalizeRect({
      x: minX / width,
      y: minY / height,
      w: (maxX - minX) / width,
      h: (maxY - minY) / height,
    })
    if (!rect) continue
    rects.push(rect)
    texts.push(lineTextFromWords(sorted))
  }
  if (rects.length === 0) return null
  const anchor = unionRect(rects)
  if (!anchor) return null
  return {
    quote: texts.join('\n').slice(0, 3000),
    rects: mergeRects(rects),
    anchor,
    lines: lines.length,
    wordCount: chosen.length,
  }
}

/**
 * Read the current window selection clipped to one page element.
 *
 * When `wordSource` (the rendered, rotated-filtered layer words + page size) is
 * available the quote and rects are rebuilt from word geometry — this removes
 * rotated side-stamps from selections, keeps one rect per line and restores
 * missing spaces between glyph-split words. Otherwise falls back to the native
 * Range client rects (v0.1 Hosts without a word layer).
 */
export function readPageSelection(pageEl, wordSource) {
  if (!pageEl || typeof window === 'undefined' || !window.getSelection) return null
  const selection = window.getSelection()
  if (!selection || selection.rangeCount === 0) return null
  const nativeQuote = String(selection.toString() || '')
    .replace(/\s+/g, ' ')
    .trim()
  if (!nativeQuote) return null
  const range = selection.getRangeAt(0)
  if (!pageEl.contains(range.commonAncestorContainer)) return null
  const pageRect = pageEl.getBoundingClientRect()
  if (!(pageRect.width > 0) || !(pageRect.height > 0)) return null

  // ---- word-geometry path (preferred) -----------------------------------
  const layerEl = pageEl.querySelector('.ph-r-textlayer')
  const sourceWords = arrayOf(wordSource && wordSource.words)
  if (layerEl && sourceWords.length > 0) {
    const spans = layerEl.querySelectorAll('.ph-r-word')
    const indexes = []
    for (const span of spans) {
      const index = Math.round(num(span.getAttribute('data-ph-i'), -1))
      if (!(index >= 0) || index >= sourceWords.length) continue
      let intersects = false
      try {
        intersects = typeof range.intersectsNode === 'function' ? range.intersectsNode(span) : false
      } catch {
        intersects = false
      }
      if (intersects) indexes.push(index)
    }
    if (indexes.length > 0) {
      const built = buildWordSelection(sourceWords, indexes, num(wordSource.width), num(wordSource.height))
      if (built) return built
    }
  }

  // ---- native Range fallback --------------------------------------------
  let clientRects = []
  try {
    clientRects = Array.from(range.getClientRects())
  } catch {
    clientRects = []
  }
  if (clientRects.length === 0) {
    try {
      const bounding = range.getBoundingClientRect()
      if (bounding && bounding.width > 0 && bounding.height > 0) clientRects = [bounding]
    } catch {
      clientRects = []
    }
  }
  const rects = []
  for (const clientRect of clientRects) {
    if (!clientRect || clientRect.width <= 0 || clientRect.height <= 0) continue
    const left = (clientRect.left - pageRect.left) / pageRect.width
    const top = (clientRect.top - pageRect.top) / pageRect.height
    const width = clientRect.width / pageRect.width
    const height = clientRect.height / pageRect.height
    const x0 = clamp(left, 0, 1)
    const y0 = clamp(top, 0, 1)
    const x1 = clamp(left + width, 0, 1)
    const y1 = clamp(top + height, 0, 1)
    if (x1 - x0 < 0.001 || y1 - y0 < 0.001) continue
    rects.push({ x: round4(x0), y: round4(y0), w: round4(x1 - x0), h: round4(y1 - y0) })
  }
  const merged = mergeRects(rects)
  if (merged.length === 0) return null
  const anchor = unionRect(merged)
  if (!anchor) return null
  return { quote: nativeQuote.slice(0, 3000), rects: merged, anchor }
}

/** Normalise one search query for matching. */
export function normalizeSearch(query) {
  return String(query || '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim()
}

/** Clear the window selection (after a highlight was created). */
export function clearNativeSelection() {
  try {
    if (typeof window !== 'undefined' && window.getSelection) window.getSelection().removeAllRanges()
  } catch {
    /* selection API unavailable */
  }
}

/**
 * Find text matches in one `reader.layer` payload.
 * Words are grouped into visual lines, line text is searched, and matched word
 * boxes become normalised highlight rects.
 * @returns {Array<{rects:Array, snippet:string}>}
 */
export function findLayerMatches(layer, query) {
  const words = arrayOf(layer && layer.words)
  const needle = normalizeSearch(query)
  if (words.length === 0 || !needle) return []
  const width = num(layer.width, 1)
  const height = num(layer.height, 1)
  if (!(width > 0) || !(height > 0)) return []
  const lines = new Map()
  words.forEach((word, index) => {
    if (!word || word.t == null || String(word.t) === '') return
    const x = num(word.x)
    const y = num(word.y)
    const h = num(word.h)
    const key = h > 0 ? Math.round(y / Math.max(h, 1) * 4) : Math.round(y)
    let line = lines.get(key)
    if (!line) {
      line = []
      lines.set(key, line)
    }
    line.push({ word, x, y, h, index })
  })
  const hits = []
  for (const line of lines.values()) {
    line.sort((left, right) => left.x - right.x)
    let text = ''
    const spans = []
    for (const item of line) {
      if (text) text += ' '
      const start = text.length
      text += String(item.word.t)
      spans.push({ start, end: text.length, item })
    }
    const haystack = text.toLowerCase()
    let from = 0
    while (from <= haystack.length) {
      const at = haystack.indexOf(needle, from)
      if (at < 0) break
      const end = at + needle.length
      const rects = []
      for (const span of spans) {
        if (span.end <= at || span.start >= end) continue
        rects.push({
          x: round4(span.item.x / width),
          y: round4(span.item.y / height),
          w: round4(num(span.item.word.w) / width),
          h: round4(num(span.item.word.h) / height),
        })
      }
      const merged = mergeRects(rects)
      if (merged.length > 0) {
        hits.push({
          rects: merged,
          snippet: text.slice(Math.max(0, at - 40), Math.min(text.length, end + 40)),
        })
      }
      from = at + Math.max(1, needle.length)
    }
  }
  return hits
}

/**
 * Fallback matcher for hosts that expose blocks but not a word layer: search
 * block/line text and highlight whole line boxes.
 */
export function findBlockMatches(pageData, query) {
  const needle = normalizeSearch(query)
  if (!needle) return []
  const blocks = arrayOf(pageData && pageData.blocks)
  const width = num(pageData && pageData.width, 1)
  const height = num(pageData && pageData.height, 1)
  if (blocks.length === 0 || !(width > 0) || !(height > 0)) return []
  const hits = []
  for (const block of blocks) {
    const lines = arrayOf(block && block.lines)
    const candidates = lines.length > 0 ? lines : block && block.bbox ? [{ bbox: block.bbox, text: block.text }] : []
    for (const line of candidates) {
      const text = String((line && line.text) || (block && block.text) || '')
      if (!text) continue
      const at = text.toLowerCase().indexOf(needle)
      if (at < 0) continue
      const bbox = line && line.bbox ? line.bbox : block && block.bbox
      if (!bbox) continue
      const rect = normalizeRect({
        x: num(bbox.x) / width,
        y: num(bbox.y) / height,
        w: num(bbox.w) / width,
        h: num(bbox.h) / height,
      })
      if (!rect) continue
      hits.push({ rects: [rect], snippet: text.slice(Math.max(0, at - 40), Math.min(text.length, at + needle.length + 40)) })
    }
  }
  return hits
}

/* -------------------------------------------------------------------------- */
/* Hooks                                                                       */
/* -------------------------------------------------------------------------- */

/**
 * Run one async load whenever `deps` change; aborts stale loads through
 * `options.signal` when the api supports it.
 * @returns {{status:'idle'|'loading'|'ready'|'error', data:any, error:any, reload:Function}}
 */
export function useAsync(load, deps, options) {
  const opts = options || {}
  const enabled = opts.enabled !== false
  const [state, setState] = React.useState({ status: enabled ? 'loading' : 'idle', data: opts.initialData, error: null })
  const [tick, setTick] = React.useState(0)
  const loadRef = React.useRef(load)
  loadRef.current = load

  React.useEffect(() => {
    if (!enabled) {
      setState({ status: 'idle', data: opts.initialData, error: null })
      return undefined
    }
    let alive = true
    let controller = null
    try {
      if (typeof AbortController !== 'undefined') controller = new AbortController()
    } catch {
      controller = null
    }
    setState((previous) => ({ status: 'loading', data: previous.data, error: null }))
    let promise
    try {
      promise = loadRef.current(controller ? controller.signal : undefined)
    } catch (error) {
      promise = Promise.reject(error)
    }
    Promise.resolve(promise)
      .then((data) => unwrapApiResult(data))
      .then(
        (data) => {
          if (!alive) return
          setState({ status: 'ready', data, error: null })
        },
        (error) => {
          if (!alive || (error && error.name === 'AbortError')) return
          setState({ status: 'error', data: undefined, error })
        },
      )
    return () => {
      alive = false
      if (controller) {
        try {
          controller.abort()
        } catch {
          /* nothing to abort */
        }
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps.concat([tick, enabled]))

  const reload = React.useCallback(() => setTick((value) => value + 1), [])
  return { status: state.status, data: state.data, error: state.error, reload }
}

/**
 * Observe the content box of one element. Falls back to window resize events
 * when `ResizeObserver` is missing (older webviews, jsdom smoke tests).
 */
export function useElementSize(ref) {
  const [size, setSize] = React.useState({ width: 0, height: 0 })
  React.useEffect(() => {
    const element = ref.current
    if (!element) return undefined
    let frame = 0
    const measure = () => {
      frame = 0
      const width = element.clientWidth || 0
      const height = element.clientHeight || 0
      setSize((previous) => (previous.width === width && previous.height === height ? previous : { width, height }))
    }
    const schedule = () => {
      if (frame) return
      frame = typeof requestAnimationFrame === 'function' ? requestAnimationFrame(measure) : setTimeout(measure, 16)
    }
    measure()
    let observer = null
    if (typeof ResizeObserver !== 'undefined') {
      observer = new ResizeObserver(schedule)
      observer.observe(element)
    } else if (typeof window !== 'undefined') {
      window.addEventListener('resize', schedule)
    }
    return () => {
      if (frame) {
        if (typeof cancelAnimationFrame === 'function') cancelAnimationFrame(frame)
        else clearTimeout(frame)
      }
      if (observer) observer.disconnect()
      else if (typeof window !== 'undefined') window.removeEventListener('resize', schedule)
    }
  }, [ref])
  return size
}

/**
 * Normalise normalised page rects (0–1) for a translate.text request.
 * v0.17: selection translation passes the rectangles so the Host can repair the
 * quote from the region (图内文字的文字层可能是乱码) instead of guessing.
 * @param {Array<{x:number,y:number,w:number,h:number}>} rawRects
 */
export function normalizeRectsForRequest(rawRects) {
  const list = []
  for (const rect of arrayOf(rawRects).slice(0, 60)) {
    const value = normalizeRect(rect)
    if (!value) continue
    list.push({
      x: Math.round(value.x * 10000) / 10000,
      y: Math.round(value.y * 10000) / 10000,
      w: Math.round(value.w * 10000) / 10000,
      h: Math.round(value.h * 10000) / 10000,
    })
  }
  return list
}

/**
 * Heuristic for garbage text layers (glyph codes without ToUnicode, private-use
 * area characters, replacement chars). The Host owns the authoritative check;
 * this stops the client from presenting a confident translation of mojibake.
 * @param {string} value
 */
export function looksGarbledText(value) {
  const text = String(value == null ? '' : value)
  if (text.trim() === '') return false
  if (/[\uFFFD\uE000-\uF8FF]/.test(text)) return true
  const visible = text.replace(/\s+/g, '')
  if (visible.length < 12) return false
  const letters = (visible.match(/[A-Za-z\u00C0-\u024F\u3400-\u9FFF0-9]/g) || []).length
  if (letters / visible.length < 0.5) return true
  // Long runs of symbols with no letter/digit at all.
  return /[^A-Za-z\u00C0-\u024F\u3400-\u9FFF0-9\s]{8,}/.test(text)
}

/**
 * Read a text-layer/OCR reliability verdict out of a translation result.
 * Returns `{ unreliable:boolean, reason:string }`; `reason` is the Host's own
 * wording when it provided one.
 * @param {object|null} result
 * @param {string} quote
 */
export function assessTranslationReliability(result, quote) {
  const data = result && typeof result === 'object' ? result : {}
  const quality = data.quality && typeof data.quality === 'object' ? data.quality : null
  const hostReason = firstText(
    quality && quality.reason,
    data.textQualityReason,
    data.ocrReason,
    data.reliabilityReason,
  )
  const flagged =
    (quality && quality.ok === false) ||
    data.lowQuality === true ||
    data.textReliable === false ||
    data.reliable === false ||
    /unreliable|garbled|mojibake|low.?quality|poor.?quality|乱码|不可靠/i.test(String(data.textQuality || data.qualityState || '')) ||
    (data.status === 'unavailable' && /text layer|ocr|glyph|乱码|不可靠/i.test(String(data.reason || '')))
  const garbled = looksGarbledText(quote)
  return { unreliable: Boolean(flagged || garbled), reason: firstText(hostReason), garbled }
}

/** Respect the user's reduced-motion preference. */
export function usePrefersReducedMotion() {
  const [reduced, setReduced] = React.useState(false)
  React.useEffect(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return undefined
    let query = null
    try {
      query = window.matchMedia('(prefers-reduced-motion: reduce)')
    } catch {
      return undefined
    }
    const update = () => setReduced(Boolean(query.matches))
    update()
    if (typeof query.addEventListener === 'function') query.addEventListener('change', update)
    else if (typeof query.addListener === 'function') query.addListener(update)
    return () => {
      if (typeof query.removeEventListener === 'function') query.removeEventListener('change', update)
      else if (typeof query.removeListener === 'function') query.removeListener(update)
    }
  }, [])
  return reduced
}

/* -------------------------------------------------------------------------- */
/* Inline icons                                                                */
/* -------------------------------------------------------------------------- */

/** Path data for the reader's 24×24 outline icons (currentColor stroke). */
const ICONS = {
  arrowLeft: [['path', 'M19 12H5M11 6l-6 6 6 6']],
  search: [['circle', { cx: 10.5, cy: 10.5, r: 6.2 }], ['path', 'M15.2 15.2 20 20']],
  close: [['path', 'M6 6l12 12M18 6 6 18']],
  plus: [['path', 'M12 5v14M5 12h14']],
  minus: [['path', 'M5 12h14']],
  chevronLeft: [['path', 'm14.5 6-6 6 6 6']],
  chevronRight: [['path', 'm9.5 6 6 6-6 6']],
  chevronDown: [['path', 'm6 9.5 6 6 6-6']],
  chevronUp: [['path', 'm6 14.5 6-6 6 6']],
  check: [['path', 'm5 12.5 4.5 4.5L19 7.5']],
  book: [['path', 'M6 4.5h9l3 3v12a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1v-14a1 1 0 0 1 1-1Z'], ['path', 'M8.5 9h5M8.5 12.5h4']],
  pages: [['rect', { x: 4.5, y: 4.5, width: 11, height: 15, rx: 1.2 }], ['path', 'M8 9h4M8 12.5h4']],
  note: [['path', 'M6 4.5h12a1 1 0 0 1 1 1V19a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1V5.5a1 1 0 0 1 1-1Z'], ['path', 'M8.5 9h7M8.5 12.5h7M8.5 16h4']],
  highlighter: [['path', 'M5 20l3.6-.9 9.9-9.9a1.9 1.9 0 0 0 0-2.7l-.6-.6a1.9 1.9 0 0 0-2.7 0l-9.9 9.9L5 20Z'], ['path', 'M13.2 6.8 17.6 11.2'], ['path', 'M4 21.5h16']],
  area: [['path', 'M4 8.5V5.5h3M20 8.5V5.5h-3M4 15.5v3h3M20 15.5v3h-3'], ['path', 'M9.5 12h5']],
  sticky: [['path', 'M5 4.5h14a1 1 0 0 1 1 1V14l-5.5 5.5H5a1 1 0 0 1-1-1V5.5a1 1 0 0 1 1-1Z'], ['path', 'M14.5 19.2v-4.7h4.7']],
  translate: [['path', 'M4 6h9M8.5 4v2M11 6c0 4-3 7-6.5 8.5M6 10.5c1.2 2.2 3 3.7 5 4.6'], ['path', 'M13 20l3.8-9.5L20.5 20M14.4 16.8h4.9']],
  sparkles: [['path', 'M12 4.5l1.4 4.1 4.1 1.4-4.1 1.4L12 15.5l-1.4-4.1-4.1-1.4 4.1-1.4L12 4.5Z'], ['path', 'M18.5 15.5l.7 2 2 .7-2 .7-.7 2-.7-2-2-.7 2-.7.7-2Z']],
  copy: [['path', 'M9 9h9.5a1 1 0 0 1 1 1V19a1 1 0 0 1-1 1H9a1 1 0 0 1-1-1v-9a1 1 0 0 1 1-1Z'], ['path', 'M5.5 15.5V5.5a1 1 0 0 1 1-1H16']],
  edit: [['path', 'M4.5 19.5h4L19 9a2.1 2.1 0 0 0-3-3L5.5 16.5v3Z'], ['path', 'm13.8 7.2 3 3']],
  table: [['rect', { x: 4, y: 5, width: 16, height: 14, rx: 1.6 }], ['path', 'M4 10h16M4 14.5h16M10 5v14']],
  bullets: [['path', 'M9 6.5h11M9 12h11M9 17.5h11'], ['circle', { cx: 4.8, cy: 6.5, r: 1.05, fill: 'currentColor', stroke: 'none' }], ['circle', { cx: 4.8, cy: 12, r: 1.05, fill: 'currentColor', stroke: 'none' }], ['circle', { cx: 4.8, cy: 17.5, r: 1.05, fill: 'currentColor', stroke: 'none' }]],
  listOrdered: [['path', 'M9.5 6.5H20M9.5 12H20M9.5 17.5H20'], ['path', 'M4 5.5h1.4v3M4 11h1.2c.5 0 .9.3.9.8s-.4.9-.9.9H4c-.2.7 1.6 1.6 2.3 2.3l-2.3.1']],
  folder: [['path', 'M4 7.5a1.5 1.5 0 0 1 1.5-1.5h3.6l1.8 2H18a1.5 1.5 0 0 1 1.5 1.5V18a1.5 1.5 0 0 1-1.5 1.5H5.5A1.5 1.5 0 0 1 4 18V7.5Z']],
  folderPlus: [['path', 'M4 7.5a1.5 1.5 0 0 1 1.5-1.5h3.6l1.8 2H18a1.5 1.5 0 0 1 1.5 1.5V18a1.5 1.5 0 0 1-1.5 1.5H5.5A1.5 1.5 0 0 1 4 18V7.5Z'], ['path', 'M12 11.5v5M9.5 14h5']],
  link: [['path', 'M10 14a4 4 0 0 0 5.7 0l2.6-2.6a4 4 0 0 0-5.7-5.7L11.4 6.9'], ['path', 'M14 10a4 4 0 0 0-5.7 0L5.7 12.6a4 4 0 0 0 5.7 5.7l1.2-1.2']],
  unlink: [['path', 'M10 14a4 4 0 0 0 5.7 0l2.6-2.6a4 4 0 0 0-5.7-5.7L11.4 6.9'], ['path', 'M14 10a4 4 0 0 0-5.7 0L5.7 12.6a4 4 0 0 0 5.7 5.7l1.2-1.2'], ['path', 'M4 4l16 16']],
  history: [['path', 'M4.5 12a7.5 7.5 0 1 0 2.2-5.3'], ['path', 'M4.5 5v4h4'], ['path', 'M12 8v4.2l2.8 1.8']],
  pin: [['path', 'M9 4h6l-1 5 3 3v2H7v-2l3-3-1-5Z'], ['path', 'M12 14v6']],
  checkCircle: [['circle', { cx: 12, cy: 12, r: 8 }], ['path', 'm8.2 12.3 2.6 2.6 5-5.2']],
  zoomIn: [['circle', { cx: 10.5, cy: 10.5, r: 6.2 }], ['path', 'M15.2 15.2 20 20M10.5 7.8v5.4M7.8 10.5h5.4']],
  zoomOut: [['circle', { cx: 10.5, cy: 10.5, r: 6.2 }], ['path', 'M15.2 15.2 20 20M7.8 10.5h5.4']],
  fit: [['path', 'M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5']],
  sidePanel: [['rect', { x: 4, y: 5, width: 16, height: 14, rx: 2 }], ['path', 'M14.5 5v14']],
  list: [['path', 'M9 6.5h11M9 12h11M9 17.5h11'], ['path', 'M4.5 6.5h.01M4.5 12h.01M4.5 17.5h.01']],
  external: [['path', 'M13.5 5.5H19v5.5'], ['path', 'M19 5.5 11 13.5'], ['path', 'M17 14v4a1.5 1.5 0 0 1-1.5 1.5h-10A1.5 1.5 0 0 1 4 18V8a1.5 1.5 0 0 1 1.5-1.5H9']],
  quote: [['path', 'M9.5 6.5H6.5a2 2 0 0 0-2 2v3a2 2 0 0 0 2 2h2v2.5a2 2 0 0 1-2 2'], ['path', 'M19 6.5h-3a2 2 0 0 0-2 2v3a2 2 0 0 0 2 2h2v2.5a2 2 0 0 1-2 2']],
  refresh: [['path', 'M20 12a8 8 0 1 1-2.3-5.6'], ['path', 'M20 5.5V10h-4.4']],
  warning: [['path', 'M12 4.5 21 19.5H3L12 4.5Z'], ['path', 'M12 10v4.2M12 17.2v.2']],
  trash: [['path', 'M5 7h14M10 7V5a1 1 0 0 1 1-1h2a1 1 0 0 1 1 1v2M7 7l1 13h8l1-13'], ['path', 'M10 11v5.5M14 11v5.5']],
  more: [['circle', { cx: 6, cy: 12, r: 1.2 }], ['circle', { cx: 12, cy: 12, r: 1.2 }], ['circle', { cx: 18, cy: 12, r: 1.2 }]],
  send: [['path', 'M4.5 12 20 4.5 14.5 20l-3.4-5.6L4.5 12Z'], ['path', 'M14.5 20 11 14.5']],
  figure: [['rect', { x: 4, y: 5, width: 16, height: 14, rx: 2 }], ['path', 'M4 15.5 9 11l3.5 3.5L17 10l3 3']],
  image: [['rect', { x: 4, y: 5, width: 16, height: 14, rx: 2 }], ['circle', { cx: 9, cy: 10, r: 1.4 }], ['path', 'm5 17.5 5-5 3.5 3.5 2.5-2.5 3 3']],
}

/** Render one 24×24 outline icon. */
export function Icon(props) {
  const size = Number(props && props.size) || 16
  const shapes = ICONS[props && props.name] || ICONS.book
  const children = shapes.map((shape, index) => {
    if (shape[0] === 'path') return React.createElement('path', { key: index, d: shape[1] })
    if (shape[0] === 'circle') return React.createElement('circle', Object.assign({ key: index }, shape[1]))
    return React.createElement('rect', Object.assign({ key: index }, shape[1]))
  })
  return React.createElement(
    'svg',
    {
      className: cx('ph-r-icon', props && props.className),
      width: size,
      height: size,
      viewBox: '0 0 24 24',
      fill: 'none',
      stroke: 'currentColor',
      strokeWidth: 1.6,
      strokeLinecap: 'round',
      strokeLinejoin: 'round',
      'aria-hidden': 'true',
      focusable: 'false',
    },
    children,
  )
}

/* -------------------------------------------------------------------------- */
/* Small primitives                                                            */
/* -------------------------------------------------------------------------- */

/** Inline loading spinner. */
export function Spinner(props) {
  const size = Number(props && props.size) || 14
  return React.createElement('span', {
    className: cx('ph-r-spinner', props && props.className),
    style: { width: size, height: size },
    'aria-hidden': 'true',
  })
}

/** Shimmer placeholder block. */
export function Skeleton(props) {
  const style = {}
  if (props && props.width != null) style.width = typeof props.width === 'number' ? props.width + 'px' : props.width
  if (props && props.height != null) style.height = typeof props.height === 'number' ? props.height + 'px' : props.height
  if (props && props.radius != null) style.borderRadius = typeof props.radius === 'number' ? props.radius + 'px' : props.radius
  return React.createElement('span', { className: cx('ph-r-skeleton', props && props.className), style: style, 'aria-hidden': 'true' })
}

/**
 * Reader button. `variant`: ghost | soft | solid; `size`: sm | md.
 * `iconOnly` renders a square icon button (children become title/aria-label).
 */
export function Btn(props) {
  const variant = props.variant || 'ghost'
  const size = props.size || 'md'
  const iconOnly = Boolean(props.iconOnly)
  const label = props.label || props.title || (iconOnly ? '' : undefined)
  return React.createElement(
    'button',
    {
      type: 'button',
      className: cx(
        'ph-r-btn',
        'ph-r-btn--' + variant,
        'ph-r-btn--' + size,
        iconOnly && 'ph-r-btn--icon',
        props.active && 'ph-r-btn--active',
        props.className,
      ),
      onClick: props.onClick,
      disabled: props.disabled,
      title: props.title || (typeof props.children === 'string' ? props.children : undefined),
      'aria-label': props['aria-label'] || label || undefined,
      'aria-pressed': props.active ? 'true' : undefined,
      'aria-expanded': props['aria-expanded'],
      tabIndex: props.tabIndex,
      onMouseDown: props.onMouseDown,
      onKeyDown: props.onKeyDown,
    },
    props.icon ? React.createElement(Icon, { name: props.icon, size: size === 'sm' ? 14 : 16 }) : null,
    !iconOnly && props.children != null ? React.createElement('span', { className: 'ph-r-btn__label' }, props.children) : null,
  )
}

/** Square icon-only button with an accessible name. */
export function IconBtn(props) {
  return React.createElement(
    'button',
    {
      type: 'button',
      className: cx('ph-r-iconbtn', props.active && 'ph-r-iconbtn--active', props.className),
      onClick: props.onClick,
      disabled: props.disabled,
      title: props.title,
      'aria-label': props['aria-label'] || props.title,
      'aria-pressed': props.active ? 'true' : undefined,
      tabIndex: props.tabIndex,
    },
    React.createElement(Icon, { name: props.icon, size: props.size || 16 }),
  )
}

/** Horizontal tab strip (`items: [{id,label,count?,badge?}]`). */
export function Tabs(props) {
  const items = arrayOf(props.items)
  const slider = useSlidingThumb()
  return React.createElement(
    'div',
    {
      className: cx('ph-r-tabs', slider.rect && 'ph-r-tabs--sliding', props.className),
      ref: slider.ref,
      role: 'tablist',
      'aria-label': props['aria-label'],
    },
    React.createElement(SlidingThumb, { rect: slider.rect, className: 'ph-thumb--pill', inset: 2, popKey: props.value }),
    items.map((item) =>
      React.createElement(
        'button',
        {
          key: item.id,
          type: 'button',
          role: 'tab',
          'aria-selected': item.id === props.value ? 'true' : 'false',
          'data-ph-active': item.id === props.value ? 'true' : undefined,
          className: cx('ph-r-tab', item.id === props.value && 'ph-r-tab--active'),
          onClick: () => props.onChange(item.id),
          title: item.title,
        },
        React.createElement('span', null, item.label),
        item.count != null ? React.createElement('span', { className: 'ph-r-tab__count' }, String(item.count)) : null,
      ),
    ),
  )
}

/** Compact status pill. */
export function Badge(props) {
  return React.createElement(
    'span',
    { className: cx('ph-r-badge', props && props.tone && 'ph-r-badge--' + props.tone, props && props.className), title: props && props.title },
    props && props.children,
  )
}

/** Empty / error / degraded state block. */
export function Empty(props) {
  return React.createElement(
    'div',
    { className: cx('ph-r-empty', props.tone && 'ph-r-empty--' + props.tone, props.className) },
    props.icon ? React.createElement(Icon, { name: props.icon, size: 22, className: 'ph-r-empty__icon' }) : null,
    React.createElement('p', { className: 'ph-r-empty__title' }, props.title || ''),
    props.desc ? React.createElement('p', { className: 'ph-r-empty__desc' }, props.desc) : null,
    props.action ? React.createElement('div', { className: 'ph-r-empty__action' }, props.action) : null,
  )
}

/** Removable context chip (AI panel, selection context). */
export function Chip(props) {
  const content = [
    props.icon ? React.createElement(Icon, { key: 'icon', name: props.icon, size: 13 }) : null,
    React.createElement('span', { key: 'label', className: 'ph-r-chip__label' }, props.children),
  ]
  const body = props.onClick
    ? React.createElement('button', { type: 'button', className: cx('ph-r-chip', props.active && 'ph-r-chip--active', props.className), onClick: props.onClick, title: props.title }, content)
    : React.createElement('span', { className: cx('ph-r-chip', props.active && 'ph-r-chip--active', props.className), title: props.title }, content)
  if (!props.onRemove) return body
  return React.createElement(
    'span',
    { className: cx('ph-r-chipwrap', props.className) },
    body,
    React.createElement(
      'button',
      { type: 'button', className: 'ph-r-chip__remove', onClick: props.onRemove, title: props.removeLabel, 'aria-label': props.removeLabel },
      React.createElement(Icon, { name: 'close', size: 11 }),
    ),
  )
}
