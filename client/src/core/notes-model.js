/**
 * Pure note-model helpers shared by the reader notes tab and the standalone
 * notes library (v0.17).
 *
 * Everything here is transport-free and React-free so the contract shapes can be
 * normalised and unit-checked from plain Node:
 *
 *   - wire normalisation for `notes.*` (camelCase per docs/CONTRACT-NOTES.md),
 *     tolerant of snake_case / legacy rows and of a Host half that lags behind;
 *   - Markdown sectionisation (headings first, whole document otherwise) with a
 *     stable per-section `hash` used for the "already beautified" protection;
 *   - the `contentJson` **v2** document schema (section styles plain/accent/
 *     columns/figure; basic blocks plus markdown/cards/chart/gallery/tabs/
 *     disclosure/tasks/status/progress/alert/empty/quotes/actions and
 *     architecture/flow/mind-map diagrams) plus defensive parsing of the
 *     model's JSON answer and a v1 → v2 upgrade path;
 *   - the local safety net: autosave drafts, incomplete-section marks and
 *     one-shot UI flags kept in localStorage so no keystroke is ever lost.
 *
 * The AI never touches `contentMd`: `contentJson` is a separate, hash-guarded
 * rendering layer and "恢复原文" only switches the view.
 */

/** Format version written into `contentJson` and `patch.formatVersion`. */
export const NOTES_FORMAT_VERSION = 2
/** `contentJson.version` written by this client (v1 is still readable). */
export const CONTENT_JSON_VERSION = 2
/** localStorage prefixes (never contain note bodies in the key itself). */
export const DRAFT_PREFIX = 'pappers-hall.notes.draft.'
export const INCOMPLETE_PREFIX = 'pappers-hall.notes.incomplete.'
export const FLAG_PREFIX = 'pappers-hall.flag.'
/** One beautify request keeps the prompt inside the Host's input budget. */
export const BEAUTIFY_MAX_CHARS = 1800
export const BEAUTIFY_MAX_SECTIONS = 8
/** v2 document styles; at least two alternate in a beautified note. */
export const SECTION_STYLES = ['plain', 'accent', 'columns', 'figure']
/** At most this many real paper figures per beautify run (sparse by design). */
export const MAX_FIGURES_PER_RUN = 2
/**
 * Auto-beautify (边写边美化) thresholds, shared by the editor and tests.
 *
 * Triggering is purely character-count based: after a save, once ~500 new
 * characters are accumulated, the finished sections are laid out. No idle
 * timer; 500–1000 chars is the intended batch size (one AI call handles it).
 */
export const AUTO_MIN_CHARS = 500
export const AUTO_MAX_CHARS = 1000
export const AUTO_IDLE_MS = 0
export const AUTO_BURST_MIN_CHARS = 500
export const AUTO_COOLDOWN_MS = 0
export const AUTOFIX_PREFIX = 'pappers-hall.notes.autofix.'
export const AUTOFIX_INTRO_FLAG = 'notes.autofix.intro.v1'
export const DEFAULT_AUTOFIX_DIRECTION = 'scientific'
/** Figure id shape coming from the Host's figures.list. */
const FIGURE_ID_PATTERN = /^fg-[a-z0-9]{4,32}$/i
/* -------------------------------------------------------------------------- */
/* Small helpers                                                              */
/* -------------------------------------------------------------------------- */

/** FNV-1a 32-bit hash as 8 hex chars (stable across sessions, no dependency). */
export function hashText(value) {
  const text = String(value == null ? '' : value)
  let hash = 0x811c9dc5
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index)
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  return hash.toString(16).padStart(8, '0')
}

/** Trim + collapse horizontal whitespace so cosmetic edits never invalidate a section. */
function normaliseSectionText(value) {
  return String(value == null ? '' : value)
    .replace(/\r\n?/g, '\n')
    .replace(/[ \t]+$/gm, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

/** True when a string is a non-empty trimmed string. */
function isText(value) {
  return typeof value === 'string' && value.trim() !== ''
}

/**
 * The API layer adds `detail` to errors; older builds only carry `code`/`message`.
 * This detects "the Host does not implement notes.* yet" as opposed to offline.
 * @param {unknown} error
 */
export function notesUnavailable(error) {
  if (!error || typeof error !== 'object') return false
  const code = String(error.code || '')
  if (code === 'notes_unavailable' || code === 'unknown_method' || code === 'not_implemented' || code === 'method_not_found') return true
  const message = String(error.message || '')
  return /unknown API method|unknown method|not implemented|unsupported method|no such method/i.test(message)
}

/** Transport-level failure (plugin disabled / network) rather than a missing method. */
export function notesOffline(error) {
  if (!error || typeof error !== 'object') return false
  return error.code === 'not_running' || error.code === 'network' || error.code === 'http_404'
}

/* -------------------------------------------------------------------------- */
/* Markdown sectionisation                                                    */
/* -------------------------------------------------------------------------- */

/**
 * Split one Markdown/plain document into sections.
 *
 * Headings (`#`..`######`) start a section; text before the first heading is its
 * own section so a note that starts with prose still yields a stable section.
 * Without any heading the whole document is one section. `start`/`end` are
 * character offsets into the original string so the editor can map a textarea
 * selection onto sections.
 *
 * @param {string} contentMd
 * @returns {Array<{id:string, heading:string, level:number, text:string, raw:string, start:number, end:number, hash:string}>}
 */
export function sectionizeMarkdown(contentMd) {
  const text = String(contentMd == null ? '' : contentMd)
  const matches = []
  const pattern = /^(#{1,6})[ \t]+(.+?)[ \t]*$/gm
  let match
  while ((match = pattern.exec(text)) !== null) {
    matches.push({ index: match.index, level: match[1].length, heading: match[2].trim(), length: match[0].length })
  }
  const bounds = []
  if (matches.length === 0) {
    bounds.push({ start: 0, end: text.length, heading: '', level: 0 })
  } else {
    if (matches[0].index > 0) bounds.push({ start: 0, end: matches[0].index, heading: '', level: 0 })
    for (let index = 0; index < matches.length; index += 1) {
      const current = matches[index]
      const next = matches[index + 1]
      bounds.push({
        start: current.index,
        end: next ? next.index : text.length,
        heading: current.heading,
        level: current.level,
      })
    }
  }
  return bounds.map((bound, index) => {
    const raw = text.slice(bound.start, bound.end)
    const normalised = normaliseSectionText(raw)
    return {
      id: 's' + index,
      heading: bound.heading,
      level: bound.level,
      // The heading line is dropped from `text` when present so prompts do not
      // repeat it twice; `raw` keeps the exact slice for the original renderer.
      text: normaliseSectionText(stripHeading(raw, bound.heading)),
      raw,
      start: bound.start,
      end: bound.end,
      hash: hashText(normalised),
    }
  })
}

/** Remove the leading heading line from one section slice. */
function stripHeading(raw, heading) {
  if (!heading) return raw
  return String(raw).replace(/^#{1,6}[ \t]+.*(?:\n|$)/, '')
}

/**
 * Heuristic "this section is probably not finished yet".
 * The user can override every section from the editor; this only sets the
 * default so an in-progress outline is never beautified into final cards.
 * @param {{heading?:string, text?:string}} section
 */
export function isSectionLikelyIncomplete(section) {
  const text = normaliseSectionText(section && section.text)
  if (text === '') return Boolean(section && section.heading)
  if (text.length < 8) return true
  // Allow a trailing punctuation after the marker (e.g. 「…待补充。」).
  return /(?:TODO|待补充|待补|待完善|待续|未完|继续补充|…|\.\.\.)[。.!！?？；;\s]*$/.test(text.slice(-48))
}

/** Sections overlapping the `[start, end)` textarea selection. */
/** Inline directive kinds the note Agent understands. */
export const DIRECTIVE_KINDS = ['figure', 'table', 'web-image', 'web', 'stats', 'callout', 'timeline', 'compare', 'steps', 'markdown', 'cards', 'chart', 'gallery', 'tabs', 'disclosure', 'tasks', 'status', 'progress', 'alert', 'divider', 'empty', 'quotes', 'actions', 'form', 'grid', 'computed', 'avatar', 'calendar', 'data-table', 'comparison-table', 'media', 'video', 'audio', 'diagram', 'architecture', 'flowchart', 'mindmap']

/**
 * Find `{{kind: argument}}` directives in the user's Markdown and attach each
 * to the section containing it. The markers stay in `contentMd`; the Agent
 * converts them into structured blocks.
 * @param {string} contentMd
 * @param {Array} [sections] result of {@link sectionizeMarkdown}
 * @returns {Array<{id:string,kind:string,argument:string,start:number,sectionId:string,raw:string}>}
 */
export function extractDirectives(contentMd, sections) {
  const source = String(contentMd == null ? '' : contentMd)
  const list = Array.isArray(sections) ? sections : sectionizeMarkdown(source)
  const pattern = /\{\{\s*(figure|table|web-image|web|stats|callout|timeline|compare|steps|markdown|cards|chart|gallery|tabs|disclosure|tasks|status|progress|alert|divider|empty|quotes|actions|form|grid|computed|avatar|calendar|data-table|comparison-table|media|video|audio|diagram|architecture|flowchart|mindmap)\s*:\s*([\s\S]*?)\}\}/gi
  const out = []
  let match
  while ((match = pattern.exec(source)) !== null) {
    const start = match.index
    const section = [...list].reverse().find((candidate) => candidate.start <= start)
    out.push({
      id: 'd' + out.length,
      kind: match[1].toLowerCase(),
      argument: String(match[2] || '').trim().slice(0, 500),
      start,
      sectionId: section ? section.id : (list[0] ? list[0].id : ''),
      raw: String(match[0] || '').slice(0, 700),
    })
  }
  return out
}

/** Count inline directives without building the full list. */
export function countDirectives(contentMd) {
  return (String(contentMd == null ? '' : contentMd).match(/\{\{\s*(?:figure|table|web-image|web|stats|callout|timeline|compare|steps|markdown|cards|chart|gallery|tabs|disclosure|tasks|status|progress|alert|divider|empty|quotes|actions|form|grid|computed|avatar|calendar|data-table|comparison-table|media|video|audio|diagram|architecture|flowchart|mindmap)\s*:/gi) || []).length
}

export function sectionsForSelection(sections, start, end) {
  const list = arrayOf(sections)
  const from = Math.max(0, Number(start) || 0)
  const to = Math.max(from, Number(end) || 0)
  const hit = list.filter((section) => section.end > from && section.start < to)
  return hit.length > 0 ? hit : list.filter((section) => section.start <= from && section.end >= to)
}

/** Hard caps for model-produced blocks so one bad answer cannot bloat the note. */
const MAX_BLOCKS_PER_SECTION = 48
const MAX_BLOCK_TEXT = 1600
const MAX_BULLETS = 15
const MAX_BULLET_TEXT = 600
const MAX_TABLE_HEADERS = 8
const MAX_TABLE_ROWS = 40
const MAX_CELL_TEXT = 300
const MAX_COLUMNS = 2
const MAX_NESTED_BLOCKS = 14
const MAX_CARDS = 6
const MAX_CHART_POINTS = 12
const MAX_GALLERY_ITEMS = 8
const MAX_TABS = 4
const MAX_TASKS = 20
const MAX_DIAGRAM_NODES = 24
const MAX_DIAGRAM_EDGES = 32
const MAX_QUOTES = 8
const MAX_STATUS_ITEMS = 4
const MAX_MARKDOWN = 6000
const MAX_DATA_KEYS = 80
const MAX_FIELDS = 10
const MAX_GRID_BLOCKS = 12
const MAX_DATA_ROWS = 100
const MAX_COMPUTED = 6
/** Accepted callout tones. */
const CALLOUT_TONES = new Set(['info', 'warn', 'success', 'neutral'])
/** Accepted beautify directions / layouts. */
export const BEAUTIFY_DIRECTIONS = ['plain', 'vivid', 'scientific']
export const BEAUTIFY_LAYOUTS = ['auto', 'bullets', 'table']
/** Deterministic style fallback when the model forgets section styles. */
const STYLE_PATTERN = ['plain', 'accent', 'plain', 'columns', 'plain', 'figure']

/* -------------------------------------------------------------------------- */
/* contentJson v2 document schema                                             */
/* -------------------------------------------------------------------------- */

/** Normalise one figure block against a candidate figure (never invented data). */
function normalizeFigureBlock(raw, allowedFigures) {
  if (!raw || typeof raw !== 'object') return null
  const figureId = firstText(raw.figureId, raw.figure_id, raw.id)
  if (!figureId || !FIGURE_ID_PATTERN.test(figureId)) return null
  const candidate = allowedFigures ? allowedFigures.get(figureId) : null
  if (allowedFigures && !candidate) return null
  const source = candidate || raw
  const paperId = firstText(source.paperId, raw.paperId)
  if (!paperId) return null
  const page = Math.max(1, Math.round(Number(source.page ?? raw.page) || 1))
  return {
    type: 'figure',
    figureId,
    paperId,
    label: firstText(source.label, raw.label).slice(0, 24),
    caption: firstText(source.caption, raw.caption).slice(0, 600),
    page,
    imageUrl: firstText(source.imageUrl, raw.imageUrl) || '/pappers-hall/figure/' + figureId + '.png',
  }
}

/** A `columns` block holds exactly two columns of nested text blocks. */
function normalizeColumnsBlock(raw, options) {
  const columns = arrayOf(raw.columns || raw.cols).slice(0, MAX_COLUMNS)
  if (columns.length < 2) return null
  const built = []
  for (const column of columns) {
    const nested = arrayOf(column && (column.blocks || column.items)).slice(0, MAX_NESTED_BLOCKS)
    const blocks = normalizeBlocks(nested, { allowedFigures: options ? options.allowedFigures : undefined, depth: 1 })
    if (blocks.length === 0) return null
    built.push({ blocks })
  }
  return { type: 'columns', columns: built }
}

/** Bound data path such as `/form/status` (no bracket expressions). */
function normalizeBind(value) {
  const path = firstText(value)
  return /^\/[A-Za-z0-9_./-]{1,160}$/.test(path) ? path : ''
}

/** Sanitise contentJson.data; it is user/agent state, not executable markup. */
function sanitizeData(value, depth = 0) {
  if (depth > 4) return null
  if (value == null || typeof value === 'boolean' || typeof value === 'number') return value
  if (typeof value === 'string') return value.slice(0, 2000)
  if (Array.isArray(value)) return value.slice(0, MAX_DATA_KEYS).map((item) => sanitizeData(item, depth + 1))
  if (typeof value !== 'object') return null
  const out = {}
  for (const [key, item] of Object.entries(value).slice(0, MAX_DATA_KEYS)) {
    if (!/^[A-Za-z0-9_-]{1,40}$/.test(key)) continue
    out[key] = sanitizeData(item, depth + 1)
  }
  return out
}

function normalizeFormField(item, index) {
  if (!item || typeof item !== 'object') return null
  const kind = String(item.kind || item.type || 'text').toLowerCase()
  const allowed = ['text', 'textarea', 'select', 'multiselect', 'slider', 'date', 'stepper', 'checkbox']
  if (!allowed.includes(kind)) return null
  const label = firstText(item.label, item.title).slice(0, 100)
  if (!label) return null
  const bind = normalizeBind(item.bind || item.path)
  const options = arrayOf(item.options).map((option) => {
    if (typeof option === 'string') return { value: option.slice(0, 120), label: option.slice(0, 120) }
    if (!option || typeof option !== 'object') return null
    const value = firstText(option.value, option.id).slice(0, 120)
    return value ? { value, label: firstText(option.label, option.name, value).slice(0, 120) } : null
  }).filter(Boolean).slice(0, 20)
  const initial = kind === 'checkbox' ? item.value === true : firstText(item.value).slice(0, 1200)
  return {
    id: firstText(item.id, 'f' + index).replace(/[^A-Za-z0-9_-]/g, '').slice(0, 24) || 'f' + index,
    kind,
    label,
    bind,
    placeholder: firstText(item.placeholder).slice(0, 160),
    options,
    value: initial,
    min: kind === 'slider' || kind === 'stepper' ? numberValue(item.min, 0) : undefined,
    max: kind === 'slider' || kind === 'stepper' ? numberValue(item.max, 100) : undefined,
    step: kind === 'slider' || kind === 'stepper' ? Math.max(0.0001, numberValue(item.step, 1)) : undefined,
  }
}

function numberValue(value, fallback = 0) {
  const number = Number(value)
  return Number.isFinite(number) ? number : fallback
}

/** Safe note-asset URL (agent-downloaded image). */
function isNoteAsset(src) {
  return /^\/pappers-hall\/note-asset\/[a-f0-9]{16,40}\.(?:png|jpg|jpeg|webp|gif)$/i.test(String(src || ''))
}

/** Shared gallery item: a real figure candidate or a local note asset. */
function normalizeMediaItem(item, options) {
  if (!item || typeof item !== 'object') return null
  const figureId = firstText(item.figureId, item.figure_id)
  if (figureId && FIGURE_ID_PATTERN.test(figureId)) {
    const allowed = options ? options.allowedFigures : undefined
    const candidate = allowed ? allowed.get(figureId) : null
    if (allowed && !candidate) return null
    const source = candidate || item
    const paperId = firstText(source.paperId, item.paperId)
    if (!paperId) return null
    return {
      kind: 'figure',
      figureId,
      paperId,
      page: Math.max(1, Math.round(Number(source.page ?? item.page) || 1)),
      imageUrl: firstText(source.imageUrl, item.imageUrl) || '/pappers-hall/figure/' + figureId + '.png',
      label: firstText(source.label, item.label).slice(0, 24),
      caption: firstText(source.caption, item.caption).slice(0, 600),
      alt: firstText(item.alt).slice(0, 200),
    }
  }
  const src = firstText(item.src, item.imageUrl, item.url)
  if (!isNoteAsset(src)) return null
  return {
    kind: 'image',
    src,
    alt: firstText(item.alt, item.caption).slice(0, 300),
    caption: firstText(item.caption).slice(0, 600),
    credit: firstText(item.credit, item.creator).slice(0, 180),
    sourceUrl: firstText(item.sourceUrl).slice(0, 1000),
    license: firstText(item.license).slice(0, 80),
  }
}

/** Normalise one chart data set; rejects non-numeric or empty data. */
function normalizeChartBlock(raw) {
  const variant = ['bar', 'line', 'donut'].includes(String(raw.variant || '').toLowerCase())
    ? String(raw.variant).toLowerCase()
    : 'bar'
  const rows = arrayOf(raw.data || raw.items || raw.points)
    .map((item) => {
      if (Array.isArray(item)) return { label: String(item[0] == null ? '' : item[0]).trim().slice(0, 40), value: Number(item[1]) }
      if (!item || typeof item !== 'object') return null
      return { label: firstText(item.label, item.name).slice(0, 40), value: Number(item.value) }
    })
    .filter((item) => item && item.label && Number.isFinite(item.value))
    .slice(0, MAX_CHART_POINTS)
  let labels = arrayOf(raw.labels).map((value) => String(value == null ? '' : value).trim().slice(0, 40))
  let values = arrayOf(raw.values).map((value) => Number(value))
  if (rows.length === 0 && labels.length > 0 && values.length > 0) {
    labels = labels.slice(0, Math.min(labels.length, values.length, MAX_CHART_POINTS))
    rows.push(...labels.map((label, index) => ({ label, value: values[index] })))
  }
  const data = rows.filter((item) => Number.isFinite(item.value))
  const series = arrayOf(raw.series).map((item) => {
    if (!item || typeof item !== 'object') return null
    const name = firstText(item.name, item.label).slice(0, 60)
    const values = arrayOf(item.values).map((value) => Number(value)).filter(Number.isFinite).slice(0, MAX_CHART_POINTS)
    return name && values.length > 0 ? { name, values } : null
  }).filter(Boolean).slice(0, 4)
  if (data.length === 0 && series.length === 0) return null
  return {
    type: 'chart',
    variant,
    title: firstText(raw.title).slice(0, 120),
    unit: firstText(raw.unit).slice(0, 24),
    stacked: raw.stacked === true,
    data,
    series,
    labels,
  }
}

/** Normalise nodes/edges for the SVG diagram renderer. */
function normalizeDiagramBlock(raw) {
  const allowedLayouts = ['architecture', 'flow', 'mindmap']
  const layout = allowedLayouts.includes(String(raw.layout || '').toLowerCase())
    ? String(raw.layout).toLowerCase()
    : 'architecture'
  const nodes = []
  const byId = new Map()
  for (const item of arrayOf(raw.nodes).slice(0, MAX_DIAGRAM_NODES)) {
    if (!item || typeof item !== 'object') continue
    const id = firstText(item.id, item.key).replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 24)
    if (!id || byId.has(id)) continue
    const label = firstText(item.label, item.title, id).slice(0, 100)
    if (!label) continue
    const node = {
      id,
      label,
      detail: firstText(item.detail, item.desc).slice(0, 180),
      group: firstText(item.group, item.column).slice(0, 40),
      tone: ['blue', 'green', 'amber', 'violet', 'neutral'].includes(String(item.tone || '')) ? String(item.tone) : '',
      ...(firstText(item.parent) ? { parent: firstText(item.parent).replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 24) } : {}),
    }
    nodes.push(node)
    byId.set(id, node)
  }
  if (nodes.length === 0) return null
  const edges = []
  for (const item of arrayOf(raw.edges).slice(0, MAX_DIAGRAM_EDGES)) {
    if (!item || typeof item !== 'object') continue
    const from = firstText(item.from, item.source).replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 24)
    const to = firstText(item.to, item.target).replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 24)
    if (!byId.has(from) || !byId.has(to) || from === to) continue
    edges.push({ from, to, label: firstText(item.label).slice(0, 80) })
  }
  // A mind map may be authored as a tree via parent ids instead of edges.
  if (layout === 'mindmap' && edges.length === 0) {
    for (const node of nodes) if (node.parent && byId.has(node.parent) && node.parent !== node.id) edges.push({ from: node.parent, to: node.id, label: '' })
  }
  // A mind map may be authored as a tree via parent ids instead of edges.
  if (layout === 'mindmap' && edges.length === 0) {
    for (const node of nodes) if (node.parent && byId.has(node.parent) && node.parent !== node.id) edges.push({ from: node.parent, to: node.id, label: '' })
  }
  if (layout === 'mindmap' && nodes.length < 2) return null
  if (layout !== 'mindmap' && nodes.length < 2) return null
  return {
    type: 'diagram',
    layout,
    title: firstText(raw.title).slice(0, 140),
    caption: firstText(raw.caption).slice(0, 500),
    nodes,
    edges,
  }
}

/** Normalise one block; returns null for anything unusable. */
export function normalizeBlock(raw, options) {
  if (!raw || typeof raw !== 'object') return null
  const type = String(raw.type || '').toLowerCase()
  if (type === 'heading') {
    const text = firstText(raw.text)
    return text ? { type: 'heading', text: text.slice(0, 240) } : null
  }
  if (type === 'paragraph' || type === 'p' || type === 'text') {
    const text = firstText(raw.text)
    return text ? { type: 'paragraph', text: text.slice(0, MAX_BLOCK_TEXT) } : null
  }
  if (type === 'quote' || type === 'blockquote') {
    const text = firstText(raw.text)
    return text ? { type: 'quote', text: text.slice(0, MAX_BLOCK_TEXT) } : null
  }
  if (type === 'callout' || type === 'note') {
    const text = firstText(raw.text)
    if (!text) return null
    const tone = String(raw.tone || '').toLowerCase()
    return {
      type: 'callout',
      tone: CALLOUT_TONES.has(tone) ? tone : 'info',
      title: firstText(raw.title).slice(0, 120),
      text: text.slice(0, MAX_BLOCK_TEXT),
    }
  }
  if (type === 'stats' || type === 'metrics' || type === 'numbers') {
    const items = arrayOf(raw.items)
      .map((item) => {
        if (!item || typeof item !== 'object') return null
        const value = firstText(item.value, item.number).slice(0, 24)
        const label = firstText(item.label, item.title).slice(0, 60)
        if (!value || !label) return null
        const rawTone = String(item.tone || item.color || '').toLowerCase()
        const tone = ['blue', 'green', 'amber', 'violet'].includes(rawTone) ? rawTone : ''
        return { value, label, note: firstText(item.note, item.desc).slice(0, 120), ...(tone ? { tone } : {}) }
      })
      .filter(Boolean)
      .slice(0, 4)
    return items.length > 0 ? { type: 'stats', items } : null
  }
  if (type === 'bullets' || type === 'list' || type === 'ul') {
    const items = arrayOf(raw.items)
      .map((item) => (typeof item === 'string' ? item : item && typeof item === 'object' ? firstText(item.text) : ''))
      .map((item) => String(item || '').trim())
      .filter(Boolean)
      .slice(0, MAX_BULLETS)
      .map((item) => item.slice(0, MAX_BULLET_TEXT))
    if (items.length === 0) return null
    return { type: 'bullets', items }
  }
  if (type === 'table') {
    const headers = arrayOf(raw.headers).map((value) => String(value == null ? '' : value).trim().slice(0, MAX_CELL_TEXT)).slice(0, MAX_TABLE_HEADERS)
    const rows = arrayOf(raw.rows)
      .map((row) => arrayOf(row).map((cell) => String(cell == null ? '' : cell).trim().slice(0, MAX_CELL_TEXT)).slice(0, MAX_TABLE_HEADERS))
      .filter((row) => row.length > 0)
      .slice(0, MAX_TABLE_ROWS)
    if (rows.length === 0) return null
    const width = Math.max(headers.length, ...rows.map((row) => row.length))
    const align = ['left', 'center', 'right'].includes(String(raw.align || '').toLowerCase()) ? String(raw.align).toLowerCase() : ''
    return { type: 'table', headers, rows, width, caption: firstText(raw.caption).slice(0, 200), align }
  }
  if (type === 'figure' || type === 'image') {
    return normalizeFigureBlock(raw, options ? options.allowedFigures : undefined)
  }
  if (type === 'web-image' || type === 'web_image') {
    const src = firstText(raw.src, raw.url)
    // Note-agent images are cached locally; remote URLs would be blocked by the
    // host page's image policy and render as broken media.
    if (!/^\/pappers-hall\/note-asset\/[a-f0-9]{16,40}\.(?:png|jpg|jpeg|webp|gif)$/i.test(src)) return null
    return {
      type: 'web-image',
      src: src.slice(0, 1200),
      alt: firstText(raw.alt, raw.caption).slice(0, 300),
      caption: firstText(raw.caption).slice(0, 600),
      credit: firstText(raw.credit, raw.creator).slice(0, 180),
      sourceUrl: firstText(raw.sourceUrl).slice(0, 1000),
      license: firstText(raw.license).slice(0, 80),
    }
  }
  if (type === 'sources' || type === 'source-list' || type === 'source') {
    const items = arrayOf(raw.items || raw.sources).map((item) => {
      const url = firstText(item && (item.url || item.href))
      if (!/^https?:\/\//i.test(url)) return null
      return { title: firstText(item.title, item.label, url).slice(0, 200), url: url.slice(0, 1000), note: firstText(item.note, item.snippet).slice(0, 300) }
    }).filter(Boolean).slice(0, 10)
    return items.length > 0 ? { type: 'sources', items } : null
  }
  if (type === 'timeline') {
    const items = arrayOf(raw.items).map((item) => {
      const title = firstText(item && (item.title || item.label)).slice(0, 160)
      const text = firstText(item && (item.text || item.desc)).slice(0, 500)
      if (!title && !text) return null
      return { when: firstText(item && (item.when || item.time)).slice(0, 80), title, text }
    }).filter(Boolean).slice(0, 12)
    const orientation = String(raw.orientation || raw.layout || '').toLowerCase() === 'horizontal' ? 'horizontal' : 'vertical'
    return items.length > 0 ? { type: 'timeline', orientation, items } : null
  }
  if (type === 'compare' || type === 'comparison') {
    const left = arrayOf(raw.left || raw.leftItems).map((item) => firstText(item && typeof item === 'object' ? item.text : item)).filter(Boolean).slice(0, 8)
    const right = arrayOf(raw.right || raw.rightItems).map((item) => firstText(item && typeof item === 'object' ? item.text : item)).filter(Boolean).slice(0, 8)
    if (left.length === 0 && right.length === 0) return null
    return { type: 'compare', leftTitle: firstText(raw.leftTitle).slice(0, 120), rightTitle: firstText(raw.rightTitle).slice(0, 120), left, right }
  }
  if (type === 'steps') {
    const items = arrayOf(raw.items).map((item) => {
      if (typeof item === 'string') return item.trim().slice(0, 600)
      if (item && typeof item === 'object') return firstText(item.text, item.title).slice(0, 600)
      return ''
    }).filter(Boolean).slice(0, 15)
    return items.length > 0 ? { type: 'steps', items } : null
  }
  if (type === 'avatar') {
    const name = firstText(raw.name, raw.title).slice(0, 100)
    if (!name) return null
    const src = firstText(raw.src, raw.imageUrl)
    return { type: 'avatar', name, role: firstText(raw.role, raw.subtitle).slice(0, 120), ...(isNoteAsset(src) || /^https?:\/\//i.test(src) ? { src: src.slice(0, 1200) } : {}) }
  }
  if (type === 'calendar' || type === 'events') {
    const events = arrayOf(raw.events || raw.items).map((item) => {
      if (!item || typeof item !== 'object') return null
      const title = firstText(item.title, item.label).slice(0, 160)
      const date = firstText(item.date, item.when, item.day).slice(0, 80)
      if (!title) return null
      return { date, title, text: firstText(item.text, item.desc).slice(0, 500) }
    }).filter(Boolean).slice(0, 20)
    return events.length > 0 ? { type: 'calendar', title: firstText(raw.title).slice(0, 120), events } : null
  }
  if (type === 'computed' || type === 'calculations') {
    const items = arrayOf(raw.items || raw.values).map((item) => {
      if (!item || typeof item !== 'object') return null
      const label = firstText(item.label, item.title).slice(0, 100)
      const op = ['sum', 'avg', 'count', 'min', 'max'].includes(String(item.op || item.operation || '').toLowerCase()) ? String(item.op || item.operation).toLowerCase() : ''
      const paths = arrayOf(item.paths || item.sources).map((value) => normalizeBind(value)).filter(Boolean).slice(0, 12)
      if (!label || !op || paths.length === 0) return null
      return { label, op, paths, unit: firstText(item.unit).slice(0, 24) }
    }).filter(Boolean).slice(0, MAX_COMPUTED)
    return items.length > 0 ? { type: 'computed', title: firstText(raw.title).slice(0, 120), items } : null
  }
  if (type === 'form' || type === 'fields') {
    const fields = arrayOf(raw.fields || raw.items).map((item, index) => normalizeFormField(item, index)).filter(Boolean).slice(0, MAX_FIELDS)
    // A form without an explicit binding still needs stable state paths; derive
    // one from the form title hash plus the field id.
    const prefix = '/form/' + hashText(firstText(raw.title, raw.id, 'form')).slice(0, 8)
    for (const field of fields) if (!field.bind) field.bind = prefix + '/' + field.id
    return fields.length > 0 ? { type: 'form', title: firstText(raw.title).slice(0, 120), fields } : null
  }
  if (type === 'grid') {
    if (options && options.depth > 0) return null
    const columns = Math.max(1, Math.min(4, Math.round(numberValue(raw.columns, 2))))
    const blocks = normalizeBlocks(arrayOf(raw.blocks || raw.items).slice(0, MAX_GRID_BLOCKS), {
      allowedFigures: options ? options.allowedFigures : undefined,
      depth: (options && options.depth ? options.depth : 0) + 1,
    })
    return blocks.length > 0 ? { type: 'grid', columns, blocks } : null
  }
  if (type === 'data-table' || type === 'datatable') {
    const columns = arrayOf(raw.columns).map((item) => {
      if (!item || typeof item !== 'object') return null
      const key = firstText(item.key, item.id).slice(0, 40)
      const label = firstText(item.label, item.title, key).slice(0, 100)
      if (!key || !label) return null
      return { key, label, align: ['left', 'center', 'right'].includes(String(item.align || '')) ? String(item.align) : '', width: firstText(item.width).slice(0, 16) }
    }).filter(Boolean).slice(0, 8)
    const rows = arrayOf(raw.rows || raw.items).map((row) => {
      if (Array.isArray(row)) return row.slice(0, 8).map((cell) => String(cell == null ? '' : cell).slice(0, 400))
      if (!row || typeof row !== 'object') return null
      return columns.map((column) => String(row[column.key] == null ? '' : row[column.key]).slice(0, 400))
    }).filter((row) => row && row.length > 0).slice(0, MAX_DATA_ROWS)
    if (columns.length === 0 || rows.length === 0) return null
    return { type: 'data-table', title: firstText(raw.title).slice(0, 140), columns, rows, rowsPath: normalizeBind(raw.rowsPath), sortable: raw.sortable === true, caption: firstText(raw.caption).slice(0, 200) }
  }
  if (type === 'comparison-table' || type === 'comparison') {
    const columns = arrayOf(raw.columns || raw.sides).map((item) => {
      if (!item || typeof item !== 'object') return null
      const title = firstText(item.title, item.label).slice(0, 120)
      if (!title) return null
      const items = arrayOf(item.items || item.points || item.rows).map((point) => firstText(point && typeof point === 'object' ? point.text : point).slice(0, 500)).filter(Boolean).slice(0, 12)
      return { title, items }
    }).filter(Boolean).slice(0, 4)
    return columns.length >= 2 ? { type: 'comparison-table', title: firstText(raw.title).slice(0, 140), columns, caption: firstText(raw.caption).slice(0, 300) } : null
  }
  if (type === 'media' || type === 'video' || type === 'audio') {
    const kind = type === 'video' ? 'video' : type === 'audio' ? 'audio' : (String(raw.kind || 'video').toLowerCase() === 'audio' ? 'audio' : 'video')
    const src = firstText(raw.src, raw.url)
    if (!/^https?:\/\//i.test(src) && !isNoteAsset(src)) return null
    return { type: 'media', kind, src: src.slice(0, 1200), poster: firstText(raw.poster).slice(0, 1200), title: firstText(raw.title).slice(0, 140), caption: firstText(raw.caption).slice(0, 500) }
  }
  if (type === 'markdown' || type === 'md' || type === 'richtext') {
    const text = firstText(raw.text, raw.markdown)
    return text ? { type: 'markdown', text: text.slice(0, MAX_MARKDOWN) } : null
  }
  if (type === 'cards' || type === 'card-grid' || type === 'features') {
    const items = arrayOf(raw.items || raw.cards).map((item) => {
      if (!item || typeof item !== 'object') return null
      const title = firstText(item.title, item.label).slice(0, 100)
      const text = firstText(item.text, item.desc, item.body).slice(0, 700)
      if (!title && !text) return null
      const tone = ['blue', 'green', 'amber', 'violet', 'neutral'].includes(String(item.tone || '')) ? String(item.tone) : ''
      return { title, text, eyebrow: firstText(item.eyebrow, item.kicker).slice(0, 60), ...(tone ? { tone } : {}) }
    }).filter(Boolean).slice(0, MAX_CARDS)
    if (items.length === 0) return null
    const layout = ['grid', 'list', 'hero', 'compact'].includes(String(raw.layout || '').toLowerCase()) ? String(raw.layout).toLowerCase() : 'grid'
    return { type: 'cards', layout, items }
  }
  if (type === 'chart' || type === 'plot') {
    return normalizeChartBlock(raw)
  }
  if (type === 'gallery' || type === 'image-gallery' || type === 'figures') {
    const items = arrayOf(raw.items || raw.images).map((item) => normalizeMediaItem(item, options)).filter(Boolean).slice(0, MAX_GALLERY_ITEMS)
    if (items.length === 0) return null
    return { type: 'gallery', title: firstText(raw.title).slice(0, 140), items }
  }
  if (type === 'tabs') {
    if (options && options.depth > 0) return null
    const tabs = arrayOf(raw.tabs || raw.items).map((item, index) => {
      if (!item || typeof item !== 'object') return null
      const blocks = normalizeBlocks(arrayOf(item.blocks || item.content).slice(0, MAX_NESTED_BLOCKS), {
        allowedFigures: options ? options.allowedFigures : undefined,
        depth: (options && options.depth ? options.depth : 0) + 1,
      })
      if (blocks.length === 0) return null
      return { id: firstText(item.id, 't' + index).replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 24), label: firstText(item.label, item.title, 'Tab ' + (index + 1)).slice(0, 60), blocks }
    }).filter(Boolean).slice(0, MAX_TABS)
    if (tabs.length < 2) return null
    return { type: 'tabs', bind: normalizeBind(raw.bind), tabs }
  }
  if (type === 'disclosure' || type === 'details' || type === 'accordion') {
    if (options && options.depth > 0) return null
    const blocks = normalizeBlocks(arrayOf(raw.blocks || raw.content).slice(0, MAX_NESTED_BLOCKS), {
      allowedFigures: options ? options.allowedFigures : undefined,
      depth: (options && options.depth ? options.depth : 0) + 1,
    })
    if (blocks.length === 0) return null
    return { type: 'disclosure', title: firstText(raw.title, raw.label).slice(0, 160), bind: normalizeBind(raw.bind), open: raw.open === true, blocks }
  }
  if (type === 'tasks' || type === 'checklist' || type === 'todo') {
    const items = arrayOf(raw.items || raw.tasks).map((item) => {
      if (typeof item === 'string') return { text: item.trim().slice(0, 500), done: false }
      if (!item || typeof item !== 'object') return null
      const text = firstText(item.text, item.title).slice(0, 500)
      return text ? { text, done: item.done === true } : null
    }).filter(Boolean).slice(0, MAX_TASKS)
    if (items.length === 0) return null
    return { type: 'tasks', title: firstText(raw.title).slice(0, 120), bind: normalizeBind(raw.bind), items }
  }
  if (type === 'status' || type === 'badges') {
    const items = arrayOf(raw.items).map((item) => {
      if (!item || typeof item !== 'object') return null
      const label = firstText(item.label, item.title).slice(0, 80)
      const value = firstText(item.value, item.text).slice(0, 100)
      if (!label && !value) return null
      const toneRaw = String(item.tone || item.status || '').toLowerCase()
      const tone = ['neutral', 'info', 'success', 'warn', 'danger'].includes(toneRaw) ? toneRaw : 'neutral'
      return { label, value, tone }
    }).filter(Boolean).slice(0, MAX_STATUS_ITEMS)
    return items.length > 0 ? { type: 'status', items } : null
  }
  if (type === 'progress') {
    const items = arrayOf(raw.items).map((item) => {
      if (!item || typeof item !== 'object') return null
      const label = firstText(item.label, item.title).slice(0, 100)
      const max = Math.max(1, Math.min(1e9, Number(item.max) || 100))
      const value = Math.max(0, Math.min(max, Number(item.value) || 0))
      const toneRaw = String(item.tone || '').toLowerCase()
      const tone = ['blue', 'green', 'amber', 'red'].includes(toneRaw) ? toneRaw : 'blue'
      return label ? { label, value, max, tone } : null
    }).filter(Boolean).slice(0, MAX_STATUS_ITEMS)
    return items.length > 0 ? { type: 'progress', items } : null
  }
  if (type === 'alert') {
    const toneRaw = String(raw.tone || '').toLowerCase()
    const tone = ['info', 'warn', 'success', 'danger'].includes(toneRaw) ? toneRaw : 'info'
    return { type: 'alert', tone, title: firstText(raw.title).slice(0, 120), text: firstText(raw.text).slice(0, MAX_BLOCK_TEXT) }
  }
  if (type === 'divider' || type === 'hr') return { type: 'divider' }
  if (type === 'empty' || type === 'empty-state') {
    return { type: 'empty', title: firstText(raw.title).slice(0, 120), text: firstText(raw.text).slice(0, 400) }
  }
  if (type === 'quotes' || type === 'reviews' || type === 'testimonials') {
    const items = arrayOf(raw.items).map((item) => {
      if (!item || typeof item !== 'object') return null
      const text = firstText(item.text, item.quote).slice(0, 700)
      if (!text) return null
      return { text, source: firstText(item.source, item.author, item.name).slice(0, 160), note: firstText(item.note, item.role).slice(0, 160) }
    }).filter(Boolean).slice(0, MAX_QUOTES)
    return items.length > 0 ? { type: 'quotes', items } : null
  }
  if (type === 'actions' || type === 'followups' || type === 'links') {
    const items = arrayOf(raw.items || raw.actions).map((item) => {
      if (!item || typeof item !== 'object') return null
      const label = firstText(item.label, item.title).slice(0, 100)
      if (!label) return null
      const figureId = firstText(item.figureId).slice(0, 40)
      const paperId = firstText(item.paperId).slice(0, 40)
      if (figureId && paperId) {
        return { kind: 'figure', label, figureId, paperId, page: Math.max(1, Math.round(Number(item.page) || 1)), note: firstText(item.note).slice(0, 200) }
      }
      const url = firstText(item.url, item.href)
      if (!/^https?:\/\//i.test(url)) {
        if (String(item.kind || '').toLowerCase() === 'copy') return { kind: 'copy', label, value: firstText(item.value).slice(0, 2000), note: firstText(item.note).slice(0, 200) }
        return null
      }
      return { kind: 'url', label, url: url.slice(0, 1000), note: firstText(item.note).slice(0, 200) }
    }).filter(Boolean).slice(0, 6)
    return items.length > 0 ? { type: 'actions', items } : null
  }
  if (type === 'diagram' || type === 'architecture' || type === 'flowchart' || type === 'mindmap' || type === 'mind-map') {
    const layout = type === 'mindmap' || type === 'mind-map' ? 'mindmap' : type === 'flowchart' ? 'flow' : type === 'architecture' ? 'architecture' : undefined
    return normalizeDiagramBlock({ ...raw, layout: raw.layout || layout })
  }
  if (type === 'columns' || type === 'two-columns' || type === 'twocolumns') {
    if (options && options.depth > 0) return null
    return normalizeColumnsBlock(raw, options)
  }
  return null
}

/** Normalise an array of model blocks. */
export function normalizeBlocks(rawBlocks, options) {
  const blocks = []
  for (const raw of arrayOf(rawBlocks).slice(0, MAX_BLOCKS_PER_SECTION)) {
    const block = normalizeBlock(raw, options)
    if (block) blocks.push(block)
  }
  return blocks
}

/** Does this block list contain a real figure? */
export function hasFigureBlock(blocks) {
  return arrayOf(blocks).some((block) => block && block.type === 'figure')
}

/** Normalise a section style; `figure` only sticks when a figure is present. */
export function normalizeSectionStyle(value, blocks) {
  const style = String(value || '').toLowerCase()
  if (style === 'figure') return hasFigureBlock(blocks) ? 'figure' : 'accent'
  if (SECTION_STYLES.includes(style)) return style
  return hasFigureBlock(blocks) ? 'figure' : 'plain'
}

/** Read a `/a/b` path from contentJson.data (returns undefined when absent). */
export function getDataPath(data, path) {
  const parts = String(path || '').split('/').filter(Boolean)
  let current = data
  for (const part of parts) {
    if (current == null || typeof current !== 'object') return undefined
    current = current[part]
  }
  return current
}

/** Immutable `/a/b` write; returns a shallow-cloned tree. */
export function setDataPath(data, path, value) {
  const parts = String(path || '').split('/').filter(Boolean)
  if (parts.length === 0) return data
  const root = data && typeof data === 'object' ? { ...data } : {}
  let current = root
  for (let index = 0; index < parts.length - 1; index += 1) {
    const key = parts[index]
    const child = current[key]
    current[key] = child && typeof child === 'object' && !Array.isArray(child) ? { ...child } : {}
    current = current[key]
  }
  current[parts[parts.length - 1]] = value
  return root
}

/**
 * Normalise a whole `contentJson` value (object or JSON string).
 * v1 (no section styles) is upgraded to v2 with `plain` sections.
 * @returns {{version:number, direction:string, layout:string, createdAt:string, engine:object|null, sections:Array<{id:string, heading:string, sourceHash:string, style:string, blocks:Array}>}|null}
 */
export function normalizeContentJson(raw) {
  let value = raw
  if (typeof value === 'string') {
    const text = value.trim()
    if (text === '') return null
    try {
      value = JSON.parse(text)
    } catch {
      return null
    }
  }
  if (!value || typeof value !== 'object') return null
  let rawSections = value.sections
  // Tolerate a few near-miss shapes without inventing structure.
  if (!Array.isArray(rawSections) && Array.isArray(value.cards)) rawSections = value.cards
  if (!Array.isArray(rawSections) && Array.isArray(value.items)) rawSections = value.items
  if (!Array.isArray(rawSections)) return null
  const sections = []
  rawSections.forEach((entry, index) => {
    if (!entry || typeof entry !== 'object') return
    const id = firstText(entry.id, entry.sectionId, 's' + index).slice(0, 40)
    const sourceHash = firstText(entry.sourceHash, entry.hash).slice(0, 64)
    const blocks = normalizeBlocks(entry.blocks)
    if (blocks.length === 0) return
    const headingBlock = blocks.find((block) => block.type === 'heading')
    sections.push({
      id,
      sourceHash,
      style: normalizeSectionStyle(entry.style, blocks),
      heading: firstText(entry.heading, headingBlock && headingBlock.text).slice(0, 240),
      blocks,
    })
  })
  if (sections.length === 0) return null
  return {
    version: CONTENT_JSON_VERSION,
    direction: BEAUTIFY_DIRECTIONS.includes(value.direction) ? value.direction : '',
    layout: BEAUTIFY_LAYOUTS.includes(value.layout) ? value.layout : 'auto',
    createdAt: firstText(value.createdAt),
    engine: value.engine && typeof value.engine === 'object' ? value.engine : null,
    data: value.data && typeof value.data === 'object' ? sanitizeData(value.data) : {},
    sections,
  }
}

/**
 * Match the stored structure against the current text.
 *
 * A stored section renders with its v2 layout only when its `id` **and** its
 * `sourceHash` still match the live text: any edit inside that section
 * invalidates just that section, the rest keep their layout. Everything else
 * falls back to the original text, which is what "未完成章节保护" and "节级 hash"
 * mean in practice.
 *
 * @param {string} contentMd
 * @param {object|null} contentJson
 */
export function matchSectionCards(contentMd, contentJson) {
  const sections = sectionizeMarkdown(contentMd)
  const stored = normalizeContentJson(contentJson)
  const byId = new Map()
  if (stored) {
    for (const section of stored.sections) {
      if (section.sourceHash) byId.set(section.id, section)
    }
  }
  const rows = sections.map((section) => {
    const card = byId.get(section.id)
    const beautified = Boolean(card && card.sourceHash === section.hash)
    return {
      section,
      blocks: beautified ? card.blocks : null,
      style: beautified ? card.style : 'plain',
      heading: (card && card.heading) || section.heading,
      beautified,
    }
  })
  const beautifiedCount = rows.filter((row) => row.beautified).length
  return {
    sections: rows,
    beautifiedCount,
    staleCount: rows.length - beautifiedCount,
    source: stored,
  }
}

/**
 * Incremental plan for manual + automatic beautification.
 * Only finished text that has no valid layout yet (new or stale) is eligible;
 * incomplete sections are never included.
 *
 * @param {string} contentMd
 * @param {object|null} contentJson
 * @param {Array<string>} incompleteIds
 */
export function planBeautifySections(contentMd, contentJson, incompleteIds) {
  const matched = matchSectionCards(contentMd, contentJson)
  const incomplete = new Set(arrayOf(incompleteIds).map(String))
  const rows = matched.sections.map((row) => ({
    section: row.section,
    beautified: row.beautified,
    incomplete: incomplete.has(row.section.id),
  }))
  const eligible = rows
    .filter((row) => !row.incomplete && !row.beautified && String(row.section.text || '').trim() !== '')
    .map((row) => row.section)
  const pendingChars = eligible.reduce((sum, section) => sum + String(section.text || '').length, 0)
  return {
    rows,
    matched,
    eligible,
    pendingChars,
    incompleteCount: rows.filter((row) => row.incomplete).length,
    beautifiedCount: matched.beautifiedCount,
  }
}

/**
 * Merge newly beautified sections into the existing v2 structure.
 *
 * This is the single merge path used by the manual dialog and the automatic
 * background pass: only the sections returned by the model are replaced, every
 * other section keeps its previous layout (no duplicate/overwrite/lost content).
 *
 * @param {object|null} base previous contentJson
 * @param {Array} incoming parsed sections (authoritative sourceHash already set)
 * @param {object} meta `{direction, layout, engine, liveSections}`
 */
export function mergeContentJson(base, incoming, meta) {
  const previous = normalizeContentJson(base)
  const nextSections = arrayOf(incoming).filter(Boolean)
  const incomingById = new Map(nextSections.map((section) => [section.id, section]))
  const priorById = new Map(previous ? previous.sections.map((section) => [section.id, section]) : [])
  const live = arrayOf(meta && meta.liveSections)
  const order = live.length > 0
    ? live.map((section) => String(section.id))
    : Array.from(new Set([...(previous ? previous.sections.map((section) => section.id) : []), ...nextSections.map((section) => section.id)]))
  const seen = new Set()
  const sections = []
  for (const id of order) {
    if (seen.has(id)) continue
    seen.add(id)
    const section = incomingById.get(id) || priorById.get(id)
    if (section) sections.push(section)
  }
  for (const section of nextSections) {
    if (seen.has(section.id)) continue
    seen.add(section.id)
    sections.push(section)
  }
  const info = meta || {}
  return {
    version: CONTENT_JSON_VERSION,
    direction: BEAUTIFY_DIRECTIONS.includes(info.direction) ? info.direction : previous ? previous.direction : '',
    layout: BEAUTIFY_LAYOUTS.includes(info.layout) ? info.layout : previous ? previous.layout : 'auto',
    createdAt: new Date().toISOString(),
    engine: info.engine && typeof info.engine === 'object' ? info.engine : previous ? previous.engine : null,
    sections,
  }
}

/**
 * Parse the model answer into validated v2 sections.
 *
 * Only sections that were actually sent are accepted; the authoritative
 * `sourceHash` always comes from the client's own sectionisation, never from the
 * model. Figure blocks must reference a candidate figure supplied by the client
 * (`options.figureCandidates`), so the model can never invent an image.
 *
 * @param {string} answer raw model text
 * @param {Array<{id:string, hash:string, heading?:string}>} sentSections sections included in the prompt
 * @param {{figureCandidates?:Array, ensureStyleVariety?:boolean}} [options]
 */
/** Flatten a v2 block (including columns) to plain text for fidelity checks. */
function blockText(block) {
  if (!block || typeof block !== 'object') return ''
  if (typeof block.text === 'string') return block.text
  if (Array.isArray(block.items)) return block.items.map((item) => (typeof item === 'string' ? item : [item && item.value, item && item.label, item && item.note].filter(Boolean).join(' '))).join(' ')
  if (Array.isArray(block.headers) || Array.isArray(block.rows)) {
    return [].concat(Array.isArray(block.headers) ? block.headers : [], ...(Array.isArray(block.rows) ? block.rows : [])).join(' ')
  }
  if (Array.isArray(block.columns)) return block.columns.map((column) => (Array.isArray(column && column.blocks) ? column.blocks.map(blockText).join(' ') : '')).join(' ')
  return ''
}
function blocksText(blocks) { return (Array.isArray(blocks) ? blocks : []).map(blockText).join(' ') }
/** Numeric/qualifier tokens that must survive a re-layout. */
function fidelityTokens(text) {
  const value = String(text || '')
  const tokens = []
  for (const match of value.matchAll(/\d+(?:[.,]\d+)?/g)) { if (match[0].length >= 1) tokens.push(match[0]) }
  for (const symbol of ['±', '≈', '≤', '≥', '<', '>', '%']) if (value.includes(symbol)) tokens.push(symbol)
  return Array.from(new Set(tokens))
}

export function parseBeautifyPayload(answer, sentSections, options) {
  const opts = options || {}
  const text = String(answer == null ? '' : answer).trim()
  if (text === '') throw assignCode(new Error('empty model answer'), 'empty')
  let jsonText = text
  const fence = /```(?:json)?\s*([\s\S]*?)```/i.exec(text)
  if (fence) jsonText = fence[1].trim()
  const first = jsonText.indexOf('{')
  const last = jsonText.lastIndexOf('}')
  if (first < 0 || last <= first) throw assignCode(new Error('no JSON object in the model answer'), 'invalid_json')
  let parsed
  try {
    parsed = JSON.parse(jsonText.slice(first, last + 1))
  } catch (error) {
    throw assignCode(new Error('the model answer is not valid JSON: ' + (error && error.message ? error.message : String(error))), 'invalid_json')
  }
  const rawSections = Array.isArray(parsed) ? parsed : arrayOf(parsed && parsed.sections)
  if (rawSections.length === 0) throw assignCode(new Error('the model answer has no sections'), 'shape')

  const candidates = arrayOf(opts.figureCandidates)
  const allowedFigures = candidates.length > 0
    ? new Map(candidates.map((candidate) => [String(candidate.figureId || candidate.id), candidate]))
    : null
  const sent = new Map(arrayOf(sentSections).map((section) => [section.id, section]))
  const sections = []
  let figureCount = 0
  for (const entry of rawSections) {
    if (!entry || typeof entry !== 'object') continue
    const id = firstText(entry.id, entry.sectionId)
    const sentSection = sent.get(id)
    if (!sentSection) continue
    let rawBlocks = arrayOf(entry.blocks)
    // Keep figures sparse per run: extra figures beyond the cap are dropped.
    rawBlocks = rawBlocks.filter((block) => {
      const type = String((block && block.type) || '').toLowerCase()
      if (type !== 'figure' && type !== 'image') return true
      if (figureCount >= MAX_FIGURES_PER_RUN) return false
      figureCount += 1
      return true
    })
    const blocks = normalizeBlocks(rawBlocks, { allowedFigures })
    if (blocks.length === 0) continue
    // Fidelity guard: a re-layout must not drop information. If the model
    // omitted numeric/qualifier tokens or shrank the section substantially,
    // keep the original section (it renders as 原文) instead of accepting it.
    const sourceText = String(sentSection.text || '')
    if (sourceText.trim().length >= 20) {
      const outputText = blocksText(blocks)
      const missing = fidelityTokens(sourceText).filter((token) => !outputText.includes(token))
      if (missing.length > 0) continue
      if (sourceText.trim().length >= 80 && outputText.replace(/\s+/g, '').length < sourceText.replace(/\s+/g, '').length * 0.5) continue
    }
    const headingBlock = blocks.find((block) => block.type === 'heading')
    sections.push({
      id,
      sourceHash: sentSection.hash,
      style: normalizeSectionStyle(entry.style, blocks),
      heading: firstText(entry.heading, headingBlock && headingBlock.text, sentSection.heading).slice(0, 240),
      blocks,
    })
  }
  if (sections.length === 0) throw assignCode(new Error('no usable section came back'), 'shape')
  if (opts.ensureStyleVariety !== false) ensureStyleVariety(sections)
  return sections
}

/** Guarantee at least two alternating v2 styles when the model was lazy. */
export function ensureStyleVariety(sections) {
  const list = arrayOf(sections)
  if (list.length < 2) return list
  const distinct = new Set(list.map((section) => section.style))
  if (distinct.size >= 2) return list
  list.forEach((section, index) => {
    if (hasFigureBlock(section.blocks)) {
      section.style = 'figure'
      return
    }
    section.style = STYLE_PATTERN[index % STYLE_PATTERN.length]
  })
  return list
}

/** Attach an error code without losing the stack. */
function assignCode(error, code) {
  error.code = code
  return error
}

/* -------------------------------------------------------------------------- */
/* Figure candidates (real paper figures only)                                */
/* -------------------------------------------------------------------------- */

/**
 * Normalise one `figures.list` row into the candidate shape handed to the model.
 * @param {object} raw
 * @param {{paperId?:string, paperTitle?:string, paperTitleZh?:string}} fallback
 */
export function normalizeFigureCandidate(raw, fallback) {
  if (!raw || typeof raw !== 'object') return null
  const figureId = firstText(raw.id, raw.figureId, raw.figure_id)
  if (!figureId || !FIGURE_ID_PATTERN.test(figureId)) return null
  const paperId = firstText(raw.paperId, fallback && fallback.paperId)
  if (!paperId) return null
  const label = firstText(raw.label)
  const caption = firstText(raw.caption).slice(0, 400)
  if (!caption && !label) return null
  return {
    figureId,
    paperId,
    paperTitle: firstText(raw.paperTitle, fallback && fallback.paperTitle),
    paperTitleZh: firstText(raw.paperTitleZh, fallback && fallback.paperTitleZh),
    label: label.slice(0, 24),
    caption,
    page: Math.max(1, Math.round(Number(raw.page) || 1)),
    imageUrl: firstText(raw.imageUrl) || '/pappers-hall/figure/' + figureId + '.png',
    width: Number(raw.width) || null,
    height: Number(raw.height) || null,
  }
}

/** Compact candidate list for the prompt (no UI-only fields, captions capped). */
export function figureCandidatesForPrompt(candidates, limit) {
  const max = Number(limit) || 12
  return arrayOf(candidates).slice(0, max).map((candidate) => ({
    figureId: candidate.figureId,
    paperId: candidate.paperId,
    paperTitle: candidate.paperTitleZh || candidate.paperTitle || '',
    label: candidate.label || '',
    page: candidate.page || 1,
    caption: String(candidate.caption || '').slice(0, 180),
  }))
}

/* -------------------------------------------------------------------------- */
/* Auto-beautify preference (per note, localStorage)                          */
/* -------------------------------------------------------------------------- */

/** Read the per-note auto-beautify settings (defaults when never saved). */
export function readAutoFix(noteId) {
  const id = firstText(noteId)
  const defaults = { enabled: false, direction: DEFAULT_AUTOFIX_DIRECTION, lastBeautifiedAt: 0, lastBeautifiedRevision: 0 }
  if (!id) return defaults
  const value = readJson(AUTOFIX_PREFIX + id)
  if (!value) return defaults
  return {
    enabled: value.enabled === true,
    direction: BEAUTIFY_DIRECTIONS.includes(value.direction) ? value.direction : DEFAULT_AUTOFIX_DIRECTION,
    lastBeautifiedAt: Number(value.lastBeautifiedAt) || 0,
    lastBeautifiedRevision: Number(value.lastBeautifiedRevision) || 0,
  }
}

/** Persist one patch of the per-note auto-beautify settings. */
export function patchAutoFix(noteId, patch) {
  const id = firstText(noteId)
  if (!id) return readAutoFix('')
  const current = readAutoFix(id)
  const next = Object.assign({}, current, patch || {})
  if (!BEAUTIFY_DIRECTIONS.includes(next.direction)) next.direction = DEFAULT_AUTOFIX_DIRECTION
  next.lastBeautifiedAt = Number(next.lastBeautifiedAt) || 0
  next.lastBeautifiedRevision = Number(next.lastBeautifiedRevision) || 0
  writeJson(AUTOFIX_PREFIX + id, next)
  return next
}

/* -------------------------------------------------------------------------- */
/* Wire normalisation (docs/CONTRACT-NOTES.md, camelCase)                     */
/* -------------------------------------------------------------------------- */

/** Local copies of the tiny text helpers so this module stays Node-importable (no React). */
function firstText() {
  for (let index = 0; index < arguments.length; index += 1) {
    const value = arguments[index]
    if (typeof value === 'string' && value.trim() !== '') return value
  }
  return ''
}

function arrayOf(value) {
  return Array.isArray(value) ? value : []
}

/** One linked-paper summary. */
export function normalizePaperLink(raw) {
  if (!raw || typeof raw !== 'object') return null
  const paperId = firstText(raw.paperId, raw.paper_id, raw.id)
  if (!paperId) return null
  return {
    paperId,
    title: firstText(raw.title),
    titleZh: firstText(raw.titleZh, raw.title_zh),
    year: Number(raw.year) || null,
    venue: firstText(raw.venue),
    anchor: raw.anchor && typeof raw.anchor === 'object' ? raw.anchor : null,
  }
}

/** One revision row from `notes.revisions` / `notes.get`. */
export function normalizeRevision(raw) {
  if (!raw || typeof raw !== 'object') return null
  return {
    revision: Number(raw.revision) || 0,
    reason: firstText(raw.reason, 'update'),
    title: firstText(raw.title),
    createdAt: firstText(raw.createdAt, raw.created_at),
    hasContentJson: Boolean(raw.hasContentJson ?? raw.has_content_json),
    contentMdLength: Number(raw.contentMdLength ?? raw.content_md_length) || 0,
  }
}

/**
 * Normalise one note. Accepts both the v0.17 wire shape (`contentMd`,
 * `contentJson`, `paperLinks`) and legacy/snake_case rows so a partially
 * migrated Host still renders instead of crashing.
 */
export function normalizeNote(raw) {
  if (!raw || typeof raw !== 'object') return null
  const rawJson = raw.contentJson !== undefined ? raw.contentJson : raw.content_json
  const contentMd = String(firstText(raw.contentMd, raw.content_md, raw.content, raw.text) || '')
  const paperLinks = arrayOf(raw.paperLinks || raw.paper_links).map(normalizePaperLink).filter(Boolean)
  const paperIds = arrayOf(raw.paperIds || raw.paper_ids).map((value) => String(value)).filter(Boolean)
  if (paperIds.length === 0) {
    for (const link of paperLinks) if (link && link.paperId) paperIds.push(link.paperId)
  }
  return {
    id: firstText(raw.id, raw.noteId, raw.note_id),
    title: firstText(raw.title),
    contentMd,
    contentJson: normalizeContentJson(rawJson),
    rawContentJson: rawJson == null ? null : rawJson,
    preview: firstText(raw.preview, raw.snippet),
    status: firstText(raw.status, 'draft'),
    folderId: raw.folderId !== undefined ? raw.folderId || null : raw.folder_id || null,
    folder: raw.folder && typeof raw.folder === 'object' ? { id: firstText(raw.folder.id), name: firstText(raw.folder.name) } : null,
    paperIds,
    paperLinks,
    revision: Number(raw.revision) || 0,
    beautifiedRevision: raw.beautifiedRevision !== undefined ? raw.beautifiedRevision : raw.beautified_revision ?? null,
    formatVersion: raw.formatVersion !== undefined ? raw.formatVersion : raw.format_version ?? null,
    state: firstText(raw.state, 'active'),
    createdAt: firstText(raw.createdAt, raw.created_at),
    updatedAt: firstText(raw.updatedAt, raw.updated_at),
    deletedAt: firstText(raw.deletedAt, raw.deleted_at),
    revisions: arrayOf(raw.revisions).map(normalizeRevision).filter(Boolean),
    hasContentJson: Boolean(raw.hasContentJson ?? raw.has_content_json ?? rawJson != null),
    raw,
  }
}

/** Unwrap `{items,total}` / `{notes}` / a bare array into `{items,total}`. */
export function normalizeNoteList(data) {
  if (Array.isArray(data)) return { items: data.map(normalizeNote).filter(Boolean), total: data.length }
  const value = data && typeof data === 'object' ? data : {}
  const rawItems = arrayOf(value.items || value.notes || value.results)
  const items = rawItems.map(normalizeNote).filter(Boolean)
  return {
    items,
    total: Number(value.total ?? value.count ?? items.length) || items.length,
    limit: Number(value.limit) || null,
    offset: Number(value.offset) || 0,
  }
}

/** Normalise `notes.revisions` (and the `revisions` already inside `notes.get`). */
export function normalizeRevisions(data) {
  if (Array.isArray(data)) return data.map(normalizeRevision).filter(Boolean)
  const value = data && typeof data === 'object' ? data : {}
  return arrayOf(value.items || value.revisions).map(normalizeRevision).filter(Boolean)
}

/** Normalise a folder node (recursive). */
export function normalizeFolder(raw) {
  if (!raw || typeof raw !== 'object') return null
  const id = firstText(raw.id, raw.folderId, raw.folder_id)
  if (!id) return null
  return {
    id,
    name: firstText(raw.name, raw.title, id),
    parentId: firstText(raw.parentId, raw.parent_id) || null,
    color: firstText(raw.color) || null,
    count: Number(raw.count ?? raw.noteCount ?? raw.note_count ?? 0) || 0,
    children: arrayOf(raw.children).map(normalizeFolder).filter(Boolean),
  }
}

/** Normalise `notes.folders.tree` into a root array. */
export function normalizeFolderTree(data) {
  const roots = Array.isArray(data)
    ? data
    : arrayOf(data && (data.folders || data.items || data.tree || data.roots))
  return roots.map(normalizeFolder).filter(Boolean)
}

/** Depth-first folder list with `depth`, parents before children. */
export function flattenFolders(tree) {
  const out = []
  const walk = (nodes, depth) => {
    for (const node of arrayOf(nodes)) {
      out.push(Object.assign({}, node, { depth }))
      if (node.children && node.children.length > 0) walk(node.children, depth + 1)
    }
  }
  walk(tree, 0)
  return out
}

/** Folder ids of one folder plus every descendant (for filtering note lists). */
export function folderIdsWithDescendants(tree, folderId) {
  const target = String(folderId || '')
  if (!target) return []
  const ids = []
  const walk = (node) => {
    if (!node) return
    ids.push(node.id)
    for (const child of arrayOf(node.children)) walk(child)
  }
  const find = (nodes) => {
    for (const node of arrayOf(nodes)) {
      if (node.id === target) {
        walk(node)
        return true
      }
      if (find(node.children)) return true
    }
    return false
  }
  find(tree)
  return ids.length > 0 ? ids : [target]
}

/** Normalise `notes.search` rows into the same note summary shape. */
export function normalizeSearchResults(data) {
  const value = data && typeof data === 'object' ? data : {}
  const rawItems = Array.isArray(data) ? data : arrayOf(value.items || value.results)
  const items = rawItems.map((raw) => {
    if (!raw || typeof raw !== 'object') return null
    const id = firstText(raw.noteId, raw.id, raw.note_id)
    if (!id) return null
    return {
      id,
      title: firstText(raw.title),
      snippet: firstText(raw.snippet, raw.preview),
      folderId: raw.folderId !== undefined ? raw.folderId || null : raw.folder_id || null,
      folder: raw.folder && typeof raw.folder === 'object' ? { id: firstText(raw.folder.id), name: firstText(raw.folder.name) } : null,
      paperIds: arrayOf(raw.paperIds || raw.paper_ids).map(String),
      updatedAt: firstText(raw.updatedAt, raw.updated_at),
    }
  }).filter(Boolean)
  return {
    items,
    total: Number(value.total ?? items.length) || items.length,
    query: firstText(value.query),
    channels: value.channels && typeof value.channels === 'object' ? value.channels : null,
    degraded: arrayOf(value.degraded),
  }
}

/* -------------------------------------------------------------------------- */
/* Time formatting                                                            */
/* -------------------------------------------------------------------------- */

/** Parse an ISO string or an epoch-milliseconds number. */
function toEpoch(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  const text = String(value == null ? '' : value)
  if (/^\d{10,}$/.test(text)) return Number(text)
  return Date.parse(text)
}

/** `HH:mm` today, `MM-DD HH:mm` this year, `YYYY-MM-DD` otherwise. */
export function formatNoteTime(value, nowValue) {
  const time = toEpoch(value)
  if (!Number.isFinite(time)) return ''
  const now = new Date(Number.isFinite(Number(nowValue)) ? Number(nowValue) : Date.now())
  const date = new Date(time)
  const pad = (number) => String(number).padStart(2, '0')
  if (date.getFullYear() === now.getFullYear() && date.getMonth() === now.getMonth() && date.getDate() === now.getDate()) {
    return pad(date.getHours()) + ':' + pad(date.getMinutes())
  }
  if (date.getFullYear() === now.getFullYear()) {
    return pad(date.getMonth() + 1) + '-' + pad(date.getDate()) + ' ' + pad(date.getHours()) + ':' + pad(date.getMinutes())
  }
  return date.getFullYear() + '-' + pad(date.getMonth() + 1) + '-' + pad(date.getDate())
}

/** `HH:mm` only (autosave stamps). */
export function formatClock(value) {
  const time = toEpoch(value)
  if (!Number.isFinite(time)) return ''
  const date = new Date(time)
  const pad = (number) => String(number).padStart(2, '0')
  return pad(date.getHours()) + ':' + pad(date.getMinutes())
}

/* -------------------------------------------------------------------------- */
/* Local safety net (localStorage, best-effort)                               */
/* -------------------------------------------------------------------------- */

function storage() {
  try {
    // Require a real browser window: Node 26 exposes an experimental
    // `localStorage` that throws without --localstorage-file.
    if (typeof window === 'undefined') return null
    return window.localStorage || null
  } catch {
    /* private mode / disabled storage */
  }
  return null
}

function readJson(key) {
  const store = storage()
  if (!store) return null
  try {
    const raw = store.getItem(key)
    if (raw == null || raw === '') return null
    const value = JSON.parse(raw)
    return value && typeof value === 'object' ? value : null
  } catch {
    return null
  }
}

function writeJson(key, value) {
  const store = storage()
  if (!store) return false
  try {
    if (value == null) store.removeItem(key)
    else store.setItem(key, JSON.stringify(value))
    return true
  } catch {
    return false
  }
}

/** Persist the unsaved editor body so a crashed tab cannot lose keystrokes. */
export function saveDraft(noteId, draft) {
  const id = firstText(noteId)
  if (!id || !draft || typeof draft !== 'object') return false
  return writeJson(DRAFT_PREFIX + id, {
    title: String(draft.title == null ? '' : draft.title),
    content: String(draft.content == null ? '' : draft.content),
    at: Number(draft.at) || Date.now(),
    baseRevision: Number(draft.baseRevision) || 0,
  })
}

/** Read the pending local draft for one note. */
export function readDraft(noteId) {
  const id = firstText(noteId)
  if (!id) return null
  const value = readJson(DRAFT_PREFIX + id)
  if (!value) return null
  if (typeof value.title !== 'string' && typeof value.content !== 'string') return null
  return {
    title: String(value.title == null ? '' : value.title),
    content: String(value.content == null ? '' : value.content),
    at: Number(value.at) || 0,
    baseRevision: Number(value.baseRevision) || 0,
  }
}

/** Drop the draft once the Host acknowledged the exact same body. */
export function clearDraft(noteId) {
  const id = firstText(noteId)
  if (!id) return false
  return writeJson(DRAFT_PREFIX + id, null)
}

/** Remember which sections the user marked as "not finished yet". */
export function saveIncompleteSections(noteId, ids) {
  const id = firstText(noteId)
  if (!id) return false
  const list = arrayOf(ids).map(String).filter(Boolean)
  return writeJson(INCOMPLETE_PREFIX + id, list.length > 0 ? { ids: list } : null)
}

/**
 * Read the user's incomplete-section marks.
 * @returns {string[]|null} `null` when the user never set marks (heuristic wins).
 */
export function readIncompleteSections(noteId) {
  const id = firstText(noteId)
  if (!id) return null
  const value = readJson(INCOMPLETE_PREFIX + id)
  return value && Array.isArray(value.ids) ? value.ids.map(String) : null
}

/**
 * Effective incomplete-section set for one note: the user's explicit marks when
 * present, otherwise the "still being written" heuristic.
 * @param {string} noteId
 * @param {Array} sections from `sectionizeMarkdown`
 * @returns {Array<string>} section ids
 */
export function resolveIncompleteSections(noteId, sections) {
  const stored = readIncompleteSections(noteId)
  if (stored !== null) return stored
  return arrayOf(sections)
    .filter((section) => isSectionLikelyIncomplete(section))
    .map((section) => String(section.id))
}

/** One-shot UI flags (first-run hints). */
export function readFlag(name) {
  const key = firstText(name)
  if (!key) return false
  const value = readJson(FLAG_PREFIX + key)
  return Boolean(value && value.on)
}

/** Set a one-shot UI flag. */
export function writeFlag(name, on) {
  const key = firstText(name)
  if (!key) return false
  return writeJson(FLAG_PREFIX + key, on === false ? null : { on: true })
}

/* -------------------------------------------------------------------------- */
/* Export (client-side fallback for notes.export)                             */
/* -------------------------------------------------------------------------- */

/** Render one note as Markdown (used when the Host export endpoint is absent). */
export function noteToMarkdown(note) {
  if (!note) return ''
  const lines = ['# ' + (note.title || '未命名笔记'), '']
  if (note.paperLinks && note.paperLinks.length > 0) {
    lines.push('关联论文：' + note.paperLinks.map((link) => link.titleZh || link.title || link.paperId).join('；'), '')
  }
  lines.push(note.contentMd || '')
  return lines.join('\n').trim() + '\n'
}
