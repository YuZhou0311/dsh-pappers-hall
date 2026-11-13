/**
 * Dedicated note Beautification Agent.
 *
 * A note layout request creates a short-lived DSH Agent through `ctx.agents`.
 * The Agent is deliberately narrow: every global tool is hidden, and only the
 * five note tools registered below are visible. It can inspect the current
 * note, lay out sections, resolve inline directives (paper figures, tables,
 * web images and sources), search the web for verifiable context, and finish.
 *
 * The Agent never edits `content_md`. Its tools mutate an in-memory draft and
 * return compact results; `note_finish` seals the draft and reports what it
 * did. The caller persists the resulting `content_json`.
 *
 * @module pappers-hall/host/note-agent
 */
import { createHash, randomUUID } from 'node:crypto'
import { mkdir, readdir, rm, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'

const MAX_AGENT_MS = 150_000
const MAX_SECTION_CHARS = 5000
const MAX_NOTE_CHARS = 24_000
const MAX_BLOCKS_PER_SECTION = 40
const MAX_BLOCK_TEXT = 1600
const MAX_TABLE_ROWS = 40
const MAX_TABLE_HEADERS = 8
const MAX_FIGURES = 4
const MAX_WEB_IMAGE_BYTES = 6 * 1024 * 1024
const DIRECTIVE_PATTERN = /\{\{\s*(figure|table|web-image|web|stats|callout|timeline|compare|steps)\s*:\s*([\s\S]*?)\}\}/gi
const STYLE_VALUES = new Set(['plain', 'accent', 'columns', 'figure'])

function text(value) {
  return typeof value === 'string' ? value.trim() : ''
}

function hashText(value) {
  let hash = 0x811c9dc5
  const input = String(value ?? '')
  for (let index = 0; index < input.length; index += 1) {
    hash ^= input.charCodeAt(index)
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  return hash.toString(16).padStart(8, '0')
}

/** Normalise one section slice exactly like the Client before hashing. */
function normaliseSectionText(value) {
  return String(value ?? '')
    .replace(/\r\n?/g, '\n')
    .replace(/[ \t]+$/gm, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

function stripHeading(raw, heading) {
  if (!heading) return raw
  return String(raw).replace(/^#{1,6}[ \t]+.*(?:\n|$)/, '')
}

/** Split Markdown into the same stable sections and hashes the Client uses. */
export function sectionizeMarkdown(contentMd) {
  const source = String(contentMd ?? '')
  const matches = []
  const pattern = /^(#{1,6})[ \t]+(.+?)[ \t]*$/gm
  let match
  while ((match = pattern.exec(source)) !== null) {
    matches.push({ index: match.index, level: match[1].length, heading: match[2].trim(), length: match[0].length })
  }
  const bounds = []
  if (matches.length === 0) {
    bounds.push({ start: 0, end: source.length, heading: '', level: 0 })
  } else {
    if (matches[0].index > 0) bounds.push({ start: 0, end: matches[0].index, heading: '', level: 0 })
    for (let index = 0; index < matches.length; index += 1) {
      const current = matches[index]
      const next = matches[index + 1]
      bounds.push({
        start: current.index,
        end: next ? next.index : source.length,
        heading: current.heading,
        level: current.level,
      })
    }
  }
  return bounds.map((bound, index) => {
    const raw = source.slice(bound.start, bound.end)
    const normalised = normaliseSectionText(raw)
    return {
      id: 's' + index,
      heading: bound.heading,
      level: bound.level,
      text: normaliseSectionText(stripHeading(raw, bound.heading)),
      raw,
      start: bound.start,
      end: bound.end,
      hash: hashText(normalised),
    }
  })
}

/** Extract inline action directives with their nearest preceding section. */
export function extractDirectives(contentMd, sections = sectionizeMarkdown(contentMd)) {
  const source = String(contentMd ?? '')
  const out = []
  let match
  DIRECTIVE_PATTERN.lastIndex = 0
  while ((match = DIRECTIVE_PATTERN.exec(source)) !== null) {
    const start = match.index
    const section = [...sections].reverse().find((candidate) => candidate.start <= start)
    out.push({
      id: 'd' + out.length,
      kind: match[1].toLowerCase(),
      argument: match[2].trim().slice(0, 500),
      start,
      sectionId: section ? section.id : (sections[0]?.id ?? ''),
      raw: match[0].slice(0, 700),
    })
  }
  return out
}

function sectionForAgent(section) {
  return {
    id: section.id,
    heading: section.heading,
    hash: section.hash,
    text: String(section.text || '').slice(0, MAX_SECTION_CHARS),
  }
}

function pickString(value, max = 600) {
  return typeof value === 'string' ? value.trim().slice(0, max) : ''
}

function pickStyle(value) {
  const style = String(value || '').toLowerCase()
  return STYLE_VALUES.has(style) ? style : 'plain'
}

function pickTone(value) {
  const tone = String(value || '').toLowerCase()
  return ['info', 'warn', 'success', 'neutral'].includes(tone) ? tone : 'info'
}

function pickUrl(value) {
  const raw = String(value || '').trim()
  if (/^\/pappers-hall\/[a-z0-9/_-]+\.(?:png|jpe?g|webp|gif)$/i.test(raw)) return raw
  try {
    const parsed = new URL(raw)
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return ''
    return parsed.toString()
  } catch {
    return ''
  }
}

function strings(value, maxItems = 12, maxChars = 500) {
  return (Array.isArray(value) ? value : []).map((item) => String(item ?? '').trim().slice(0, maxChars)).filter(Boolean).slice(0, maxItems)
}

/** Normalise one model/tool-produced block with bounded, honest values. */
export function normalizeAgentBlock(raw, candidates = new Map()) {
  if (!raw || typeof raw !== 'object') return null
  const type = String(raw.type || '').toLowerCase()
  if (type === 'heading') {
    const value = pickString(raw.text, 240)
    return value ? { type: 'heading', text: value } : null
  }
  if (type === 'paragraph' || type === 'p' || type === 'text') {
    const value = pickString(raw.text, MAX_BLOCK_TEXT)
    return value ? { type: 'paragraph', text: value } : null
  }
  if (type === 'quote' || type === 'blockquote') {
    const value = pickString(raw.text, MAX_BLOCK_TEXT)
    return value ? { type: 'quote', text: value } : null
  }
  if (type === 'callout') {
    const value = pickString(raw.text, MAX_BLOCK_TEXT)
    return value ? { type: 'callout', tone: pickTone(raw.tone), title: pickString(raw.title, 120), text: value } : null
  }
  if (type === 'stats' || type === 'metrics') {
    const items = (Array.isArray(raw.items) ? raw.items : []).map((item) => {
      const value = pickString(item?.value ?? item?.number, 24)
      const label = pickString(item?.label ?? item?.title, 60)
      if (!value || !label) return null
      return { value, label, note: pickString(item?.note ?? item?.desc, 120) }
    }).filter(Boolean).slice(0, 4)
    return items.length > 0 ? { type: 'stats', items } : null
  }
  if (type === 'bullets' || type === 'list' || type === 'steps') {
    const items = (Array.isArray(raw.items) ? raw.items : []).map((item) => {
      if (typeof item === 'string') return item.trim().slice(0, 600)
      if (item && typeof item === 'object') return pickString(item.text ?? item.title, 600)
      return ''
    }).filter(Boolean).slice(0, 15)
    return items.length > 0 ? { type: 'bullets', items } : null
  }
  if (type === 'table') {
    const headers = strings(raw.headers, MAX_TABLE_HEADERS, 300)
    const rows = (Array.isArray(raw.rows) ? raw.rows : []).map((row) => strings(row, MAX_TABLE_HEADERS, 300)).filter((row) => row.length > 0).slice(0, MAX_TABLE_ROWS)
    if (rows.length === 0) return null
    const width = Math.max(headers.length, ...rows.map((row) => row.length))
    return { type: 'table', headers, rows, width }
  }
  if (type === 'figure') {
    const figureId = pickString(raw.figureId ?? raw.figure_id ?? raw.id, 40)
    const candidate = candidates.get(figureId)
    if (!candidate) return null
    return {
      type: 'figure',
      figureId,
      paperId: candidate.paperId,
      label: candidate.label || '',
      caption: pickString(raw.caption, 600) || candidate.caption || '',
      page: candidate.page || 1,
      imageUrl: candidate.imageUrl || '/pappers-hall/figure/' + figureId + '.png',
    }
  }
  if (type === 'web-image') {
    const src = pickUrl(raw.src ?? raw.url)
    if (!src) return null
    return {
      type: 'web-image',
      src,
      alt: pickString(raw.alt ?? raw.caption, 300),
      caption: pickString(raw.caption, 600),
      credit: pickString(raw.credit ?? raw.creator, 180),
      sourceUrl: pickUrl(raw.sourceUrl ?? raw.source_url),
      license: pickString(raw.license, 80),
    }
  }
  if (type === 'source' || type === 'sources') {
    const sourceItems = (Array.isArray(raw.items) ? raw.items : [raw]).map((item) => {
      const url = pickUrl(item?.url)
      const title = pickString(item?.title ?? item?.name, 200)
      if (!url) return null
      return { title: title || url, url, note: pickString(item?.note ?? item?.snippet, 300) }
    }).filter(Boolean).slice(0, 8)
    return sourceItems.length > 0 ? { type: 'sources', items: sourceItems } : null
  }
  if (type === 'timeline') {
    const items = (Array.isArray(raw.items) ? raw.items : []).map((item) => {
      const title = pickString(item?.title ?? item?.label, 160)
      const when = pickString(item?.when ?? item?.time, 80)
      const body = pickString(item?.text ?? item?.desc, 500)
      if (!title && !body) return null
      return { when, title, text: body }
    }).filter(Boolean).slice(0, 12)
    return items.length > 0 ? { type: 'timeline', items } : null
  }
  if (type === 'compare') {
    const left = strings(raw.left ?? raw.leftItems, 8, 400)
    const right = strings(raw.right ?? raw.rightItems, 8, 400)
    if (left.length === 0 && right.length === 0) return null
    return { type: 'compare', leftTitle: pickString(raw.leftTitle, 120), rightTitle: pickString(raw.rightTitle, 120), left, right }
  }
  if (type === 'columns') {
    const columns = (Array.isArray(raw.columns) ? raw.columns : []).slice(0, 2).map((column) => {
      const blocks = (Array.isArray(column?.blocks) ? column.blocks : []).map((block) => normalizeAgentBlock(block, candidates)).filter(Boolean).slice(0, 12)
      return { blocks }
    }).filter((column) => column.blocks.length > 0)
    return columns.length === 2 ? { type: 'columns', columns } : null
  }
  return null
}

function normalizeBlocks(blocks, candidates) {
  return (Array.isArray(blocks) ? blocks : []).map((block) => normalizeAgentBlock(block, candidates)).filter(Boolean).slice(0, MAX_BLOCKS_PER_SECTION)
}

function isPrivateHost(hostname) {
  const host = String(hostname || '').toLowerCase()
  if (host === 'localhost' || host.endsWith('.local')) return true
  if (/^\d+\.\d+\.\d+\.\d+$/.test(host)) {
    const [a, b] = host.split('.').map(Number)
    return a === 10 || a === 127 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || a === 0
  }
  return host === '[::1]' || host === '::1'
}

function extensionFor(contentType, url) {
  const type = String(contentType || '').toLowerCase()
  if (type.includes('png')) return 'png'
  if (type.includes('jpeg') || type.includes('jpg')) return 'jpg'
  if (type.includes('webp')) return 'webp'
  if (type.includes('gif')) return 'gif'
  const ext = String(url || '').toLowerCase().match(/\.(png|jpe?g|webp|gif)(?:\?|$)/)?.[1]
  return ext === 'jpeg' ? 'jpg' : (ext || 'png')
}

/**
 * Create the note-only Agent service.
 * @param {object} deps Host services.
 * @returns {{run:Function, available:Function}}
 */
export function createNoteAgent({ ctx, notes, store, ai, layout, logger, web, config = {} }) {
  const running = new Map()

  function getService(name) {
    try { return typeof ctx?.get === 'function' ? ctx.get(name) : undefined } catch { return undefined }
  }

  function modelRoute() {
    const agents = getService('agents')
    if (agents === undefined || typeof agents.create !== 'function') {
      return { status: 'unavailable', reason: 'DSH Agent service is not composed in this profile' }
    }
    let selection
    try {
      const owner = getService('agentDefaultModel')
      selection = owner && typeof owner.currentSelection === 'function' ? owner.currentSelection() : undefined
    } catch { selection = undefined }
    if ((!selection || !selection.provider || !selection.model) && ai && typeof ai.status === 'function') {
      const status = ai.status()
      if (status && status.available && status.provider && status.model) selection = { provider: status.provider, model: status.model }
    }
    if (!selection || !selection.provider || !selection.model) {
      return { status: 'unavailable', reason: 'No default model is selected; choose a model first' }
    }
    return { status: 'ok', provider: String(selection.provider), model: String(selection.model), reasoningEffort: selection.reasoningEffort }
  }

  function figureCandidatesFor(note) {
    const out = []
    const seen = new Set()
    const paperIds = Array.isArray(note?.paperIds) ? note.paperIds : []
    for (const paperId of paperIds.slice(0, 8)) {
      let figures = []
      try { figures = store.figuresList({ paperId }) } catch { figures = [] }
      for (const figure of figures) {
        if (!figure || seen.has(figure.id)) continue
        seen.add(figure.id)
        out.push({ figureId: figure.id, paperId: figure.paperId || paperId, label: figure.label || '', caption: figure.caption || '', page: figure.page || 1, imageUrl: figure.imageUrl || '/pappers-hall/figure/' + figure.id + '.png' })
        if (out.length >= 18) return out
      }
    }
    return out
  }

  async function pruneNoteAssets(directory) {
    let names
    try { names = await readdir(directory) } catch { return }
    const rows = []
    for (const name of names) {
      if (!/\.(?:png|jpe?g|webp|gif)$/i.test(name)) continue
      try { const info = await stat(path.join(directory, name)); if (info.isFile()) rows.push({ name, mtime: info.mtimeMs, size: info.size }) } catch {}
    }
    rows.sort((left, right) => right.mtime - left.mtime)
    let bytes = 0
    for (let index = 0; index < rows.length; index += 1) {
      const row = rows[index]
      const expired = Date.now() - row.mtime > 30 * 24 * 60 * 60 * 1000
      if (expired || index >= 200 || bytes + row.size > 128 * 1024 * 1024) {
        try { await rm(path.join(directory, row.name), { force: true }) } catch {}
      } else bytes += row.size
    }
  }

  async function fetchImage(url, { layout: dataLayout }) {
    let parsed
    try { parsed = new URL(String(url)) } catch { throw Object.assign(new Error('invalid image URL'), { code: 'invalid' }) }
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') throw Object.assign(new Error('only http(s) image URLs are supported'), { code: 'invalid' })
    if (isPrivateHost(parsed.hostname)) throw Object.assign(new Error('private/local image URLs are not allowed'), { code: 'invalid' })
    const response = await fetch(parsed, { signal: AbortSignal.timeout(15_000), headers: { accept: 'image/*', 'user-agent': 'Pappers-Hall/0.21 note-agent' } })
    if (!response.ok) throw Object.assign(new Error('image download failed with HTTP ' + response.status), { code: 'unavailable' })
    const type = String(response.headers.get('content-type') || '')
    if (!type.toLowerCase().startsWith('image/')) throw Object.assign(new Error('the URL did not return an image'), { code: 'invalid' })
    const bytes = Buffer.from(await response.arrayBuffer())
    if (bytes.length === 0 || bytes.length > MAX_WEB_IMAGE_BYTES) throw Object.assign(new Error('image is empty or exceeds the 6 MB limit'), { code: 'invalid' })
    const dir = dataLayout.noteAssetsDir || path.join(dataLayout.dataDir, 'note-assets')
    await mkdir(dir, { recursive: true })
    const digest = createHash('sha256').update(bytes).digest('hex').slice(0, 24)
    const ext = extensionFor(type, parsed.toString())
    const fileName = digest + '.' + ext
    await writeFile(path.join(dir, fileName), bytes)
    await pruneNoteAssets(dir)
    return { src: '/pappers-hall/note-asset/' + fileName, bytes: bytes.length, mediaType: type, credit: '' }
  }

  async function searchImages(query) {
    const q = String(query || '').trim()
    if (q === '') throw Object.assign(new Error('image search requires a query'), { code: 'invalid' })
    const endpoint = 'https://api.openverse.org/v1/images/?q=' + encodeURIComponent(q) + '&page_size=8&license_type=all&mature=false'
    const response = await fetch(endpoint, { signal: AbortSignal.timeout(15_000), headers: { accept: 'application/json', 'user-agent': 'Pappers-Hall/0.21 note-agent' } })
    if (!response.ok) throw Object.assign(new Error('image search failed with HTTP ' + response.status), { code: 'unavailable' })
    const data = await response.json().catch(() => null)
    const results = Array.isArray(data?.results) ? data.results : []
    const candidates = []
    for (const item of results) {
      if (!item || typeof item.url !== 'string') continue
      candidates.push({
        title: pickString(item.title, 200),
        url: item.url,
        thumbnail: pickString(item.thumbnail, 500),
        creator: pickString(item.creator, 160),
        license: pickString(item.license, 60),
        licenseUrl: pickString(item.license_url, 500),
        sourceUrl: pickString(item.foreign_landing_url, 500),
      })
      if (candidates.length >= 5) break
    }
    return candidates
  }

  async function searchWeb(query) {
    const service = web || getService('web')
    if (service === undefined || typeof service.search !== 'function') throw Object.assign(new Error('web search is not composed'), { code: 'unavailable' })
    const result = await service.search({ query: String(query || '').trim().slice(0, 300), maxResults: 6 })
    const sources = Array.isArray(result?.sources) ? result.sources : []
    return sources.slice(0, 6).map((source) => ({
      title: pickString(source.title, 200),
      url: pickString(source.url, 1000),
      snippet: pickString(source.snippet ?? source.content, 700),
    }))
  }

  function toolsFor(draft, candidates, dataLayout) {
    const candidateMap = new Map(candidates.map((candidate) => [candidate.figureId, candidate]))
    const jsonOutput = { schema: { type: 'object', additionalProperties: true }, render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }] }
    const tool = (name, description, parameters, execute) => ({ name, description, parameters, output: jsonOutput, execute })
    return [
      tool('note_read', 'Read the current note and its sections, inline directives, existing nice layout and real figure candidates. Call this first.', { type: 'object', properties: {}, additionalProperties: false }, async () => ({
        noteId: draft.noteId,
        title: draft.title,
        sections: draft.sections.map(sectionForAgent),
        directives: draft.directives,
        existingSections: draft.baseSections.map((section) => ({ id: section.id, style: section.style, blockTypes: (section.blocks || []).map((block) => block.type) })),
        figureCandidates: candidates.map((candidate) => ({ figureId: candidate.figureId, label: candidate.label, page: candidate.page, caption: candidate.caption.slice(0, 200) })),
        maxFigures: MAX_FIGURES,
      })),
      tool('note_set_section', 'Lay out one section as structured blocks. Use the exact sectionId from note_read. This tool replaces only that section; content_md is never changed.', {
        type: 'object',
        properties: {
          sectionId: { type: 'string', description: 'Section id from note_read (s0, s1, ...).' },
          style: { type: 'string', enum: ['plain', 'accent', 'columns', 'figure'], description: 'Section emphasis; use figure only when the section has a real figure.' },
          heading: { type: 'string', description: 'Optional display heading; keep the original heading unless it is clearly a title.' },
          blocks: { type: 'array', items: { type: 'object', additionalProperties: true }, description: 'Structured blocks: heading, paragraph, bullets, quote, callout, stats, table, figure, columns, timeline, compare, steps, web-image, sources.' },
        },
        required: ['sectionId', 'blocks'],
        additionalProperties: false,
      }, async (args) => {
        const section = draft.sections.find((entry) => entry.id === args.sectionId)
        if (!section) throw Object.assign(new Error('unknown sectionId ' + String(args.sectionId)), { code: 'invalid' })
        const blocks = normalizeBlocks(args.blocks, candidateMap)
        if (blocks.length === 0) throw Object.assign(new Error('blocks must contain at least one valid block'), { code: 'invalid' })
        draft.updated.set(section.id, { id: section.id, sourceHash: section.hash, heading: pickString(args.heading, 240) || section.heading, style: pickStyle(args.style), blocks })
        return { status: 'ok', sectionId: section.id, blockCount: blocks.length, blockTypes: blocks.map((block) => block.type) }
      }),
      tool('note_insert', 'Insert one action block into a section: figure (paper figure), table, web_image (search/download a real web image), source, callout, stats, timeline, compare or steps. Use it for inline directives.', {
        type: 'object',
        properties: {
          sectionId: { type: 'string', description: 'Section id from note_read.' },
          action: { type: 'string', enum: ['figure', 'table', 'web_image', 'source', 'callout', 'stats', 'timeline', 'compare', 'steps'], description: 'Block to add.' },
          figureId: { type: 'string', description: 'figure action: exact id from note_read.figureCandidates.' },
          caption: { type: 'string', description: 'Optional caption/alt text.' },
          headers: { type: 'array', items: { type: 'string' }, description: 'table action: header cells.' },
          rows: { type: 'array', items: { type: 'array', items: { type: 'string' } }, description: 'table action: rows.' },
          query: { type: 'string', description: 'web_image action: search query; source action: optional source label.' },
          url: { type: 'string', description: 'web_image/source action: explicit image or source URL.' },
          title: { type: 'string', description: 'Optional block title.' },
          text: { type: 'string', description: 'callout action text.' },
          items: { type: 'array', items: { type: 'object', additionalProperties: true }, description: 'stats/timeline/steps items, or source list items.' },
          leftTitle: { type: 'string' }, rightTitle: { type: 'string' }, left: { type: 'array', items: { type: 'string' } }, right: { type: 'array', items: { type: 'string' } },
        },
        required: ['sectionId', 'action'],
        additionalProperties: false,
      }, async (args) => {
        const section = draft.sections.find((entry) => entry.id === args.sectionId)
        if (!section) throw Object.assign(new Error('unknown sectionId ' + String(args.sectionId)), { code: 'invalid' })
        let block = null
        if (args.action === 'figure') {
          const candidate = candidates.find((entry) => entry.figureId === args.figureId)
          if (!candidate) throw Object.assign(new Error('figureId must come from note_read.figureCandidates'), { code: 'invalid' })
          if (draft.figureCount >= MAX_FIGURES) throw Object.assign(new Error('figure limit reached'), { code: 'invalid' })
          block = { type: 'figure', figureId: candidate.figureId, paperId: candidate.paperId, label: candidate.label || '', caption: pickString(args.caption, 600) || candidate.caption || '', page: candidate.page || 1, imageUrl: candidate.imageUrl || '/pappers-hall/figure/' + candidate.figureId + '.png' }
          draft.figureCount += 1
        } else if (args.action === 'table') {
          block = normalizeAgentBlock({ type: 'table', headers: args.headers, rows: args.rows }, candidateMap)
        } else if (args.action === 'web_image') {
          let url = pickUrl(args.url)
          let credit = ''
          let sourceUrl = ''
          let license = ''
          if (!url) {
            const found = await searchImages(args.query || args.caption || args.title)
            const first = found.find((entry) => pickUrl(entry.url))
            if (!first) throw Object.assign(new Error('no usable web image found; try a different query'), { code: 'unavailable' })
            url = first.url
            credit = first.creator
            sourceUrl = first.sourceUrl
            license = first.license
          }
          const asset = await fetchImage(url, { layout: dataLayout })
          block = { type: 'web-image', src: asset.src, alt: pickString(args.caption, 300), caption: pickString(args.caption, 600), credit: pickString(credit, 180), sourceUrl: pickUrl(sourceUrl), license: pickString(license, 80) }
        } else if (args.action === 'source') {
          const url = pickUrl(args.url)
          if (!url) throw Object.assign(new Error('source action requires a URL'), { code: 'invalid' })
          block = { type: 'sources', items: [{ title: pickString(args.title, 200) || url, url, note: pickString(args.text, 300) }] }
        } else if (args.action === 'callout') {
          block = normalizeAgentBlock({ type: 'callout', title: args.title, text: args.text, tone: args.tone }, candidateMap)
        } else if (args.action === 'stats') {
          block = normalizeAgentBlock({ type: 'stats', items: args.items }, candidateMap)
        } else if (args.action === 'timeline') {
          block = normalizeAgentBlock({ type: 'timeline', items: args.items }, candidateMap)
        } else if (args.action === 'compare') {
          block = normalizeAgentBlock({ type: 'compare', leftTitle: args.leftTitle, rightTitle: args.rightTitle, left: args.left, right: args.right }, candidateMap)
        } else if (args.action === 'steps') {
          block = normalizeAgentBlock({ type: 'steps', items: args.items }, candidateMap)
        }
        if (!block) throw Object.assign(new Error('the requested block is empty or invalid'), { code: 'invalid' })
        const existing = draft.updated.get(section.id) || { id: section.id, sourceHash: section.hash, heading: section.heading, style: 'plain', blocks: [] }
        existing.blocks.push(block)
        existing.blocks = existing.blocks.slice(0, MAX_BLOCKS_PER_SECTION)
        draft.updated.set(section.id, existing)
        return { status: 'ok', sectionId: section.id, blockType: block.type, blockCount: existing.blocks.length }
      }),
      tool('note_web_search', 'Search the web for a bounded set of citeable sources. Use it only for facts or statistics the user explicitly asked to add; never invent values.', {
        type: 'object', properties: { query: { type: 'string', description: 'Search query.' } }, required: ['query'], additionalProperties: false,
      }, async (args) => {
        const sources = await searchWeb(args.query)
        draft.webSources.push(...sources)
        return { status: 'ok', sources }
      }),
      tool('note_finish', 'Finish the note pass. Call exactly once after all sections and directives are handled. Returns a compact summary; it does not write user content.', {
        type: 'object', properties: {}, additionalProperties: false,
      }, async () => {
        draft.finished = true
        return { status: 'ok', updatedSections: draft.updated.size, directives: draft.directives.length, figures: draft.figureCount }
      }),
    ]
  }

  async function run(params = {}) {
    const noteId = String(params.noteId ?? params.id ?? '').trim()
    if (noteId === '') throw Object.assign(new Error('notes.agent.run requires noteId'), { code: 'invalid' })
    if (running.has(noteId)) throw Object.assign(new Error('this note is already being processed by the note agent'), { code: 'busy' })
    const route = modelRoute()
    if (route.status !== 'ok') throw Object.assign(new Error(route.reason), { code: 'unavailable', reason: route.reason })
    const agents = getService('agents')
    const note = notes.get({ id: noteId, revisionLimit: 1 }).note
    if (note.state === 'trash') throw Object.assign(new Error('cannot beautify a trashed note'), { code: 'not_found' })
    const contentMd = String(note.contentMd ?? '')
    if (contentMd.trim() === '') throw Object.assign(new Error('note is empty'), { code: 'empty' })
    const sections = sectionizeMarkdown(contentMd.slice(0, MAX_NOTE_CHARS))
    if (sections.length === 0) throw Object.assign(new Error('note has no readable sections'), { code: 'empty' })
    const directives = extractDirectives(contentMd.slice(0, MAX_NOTE_CHARS), sections)
    const candidates = figureCandidatesFor(note)
    const baseContentJson = params.baseContentJson && typeof params.baseContentJson === 'object' ? params.baseContentJson : null
    const baseSections = Array.isArray(baseContentJson?.sections) ? baseContentJson.sections : []
    const requestedIds = Array.isArray(params.sectionIds) ? params.sectionIds.map(String) : []
    const targetSections = requestedIds.length > 0 ? sections.filter((section) => requestedIds.includes(section.id)) : sections
    if (targetSections.length === 0) throw Object.assign(new Error('no finished section is eligible'), { code: 'empty' })
    const draft = {
      noteId,
      title: note.title || '',
      sections,
      directives,
      updated: new Map(),
      baseSections,
      finished: false,
      figureCount: 0,
      webSources: [],
    }
    const sessionId = 'pappers-note-' + randomUUID()
    const startedAt = Date.now()
    let handle
    let toolCalls = []
    let assistantText = []
    try {
      handle = await agents.create({
        sessionId,
        meta: {
          cwd: layout.dataDir || undefined,
          ...(typeof params.sessionId === 'string' && params.sessionId !== ''
            ? { parentSession: params.sessionId, origin: 'subagent', delegationDepth: 1 }
            : {}),
        },
        agentOptions: {
          provider: route.provider,
          model: route.model,
          // A note pass is a short tool-driven task; do not inherit a user's
          // maximum reasoning budget (it can consume the whole output cap before
          // the first tool call). Use a small budget and leave room for tools.
          reasoningEffort: 'low',
          maxTokens: 6000,
        },
        setup: (agentCtx) => {
          const systemPrompt = agentCtx.get?.('systemPrompt')
          if (systemPrompt && typeof systemPrompt.section === 'function') {
            agentCtx.effect(() => systemPrompt.section({
              name: 'pappers-hall-note-agent',
              order: 950,
              text: [
                'You are Pappers-Hall\'s dedicated note beautification agent. You have exactly five note tools; every action must be a tool call.',
                'Your job: turn the user\'s note Markdown into a varied, readable content_json layout, and execute the inline directives the user wrote in the note.',
                'Hard rules: never change the user\'s Markdown; never invent facts, numbers, citations, figures or URLs; preserve every number, unit, qualifier and proper noun; only use figures from note_read.figureCandidates; only add web images through note_insert(web_image) and web facts through note_web_search.',
                'Inline directives in the note use double-brace markers (the two-character open marker followed by a kind and colon, then the argument and the two-character close marker). Supported kinds: figure, table, web-image, web, stats, callout, timeline, compare, steps. Resolve each directive using note_insert on its section.',
                'Natural-language action lines also count: when the user writes something imperative such as “这里加一张论文图”, “加一个统计表”, “找一张联网图片”, “补一个来源”, treat it as an action request for the containing section and use note_insert. Do not merely copy the instruction into a paragraph; the block is the result. Structural/editorial instructions should change only the layout.',
                'Use note_set_section for each target section. Prefer paragraph/bullets/quotes; use stats/tables/timeline/compare/callout only when the content truly calls for them. Vary section styles but do not overdo accent cards. At most 4 paper figures.',
                'When you finish all sections and directives, call note_finish. Do not answer with a JSON document or Markdown; the tools are the output.',
              ].join('\n'),
            }), 'pappers-hall: note agent prompt')
          }
          const toolDefs = toolsFor(draft, candidates, layout)
          const noteToolNames = new Set(toolDefs.map((definition) => definition.name))
          let globalNames = []
          try {
            const all = typeof ctx?.tools?.definitions === 'function' ? ctx.tools.definitions() : []
            globalNames = (Array.isArray(all) ? all : []).map((definition) => definition && definition.name).filter((name) => typeof name === 'string' && name !== '' && !noteToolNames.has(name))
          } catch (error) {
            logger?.debug?.(`pappers-hall: note agent could not enumerate global tools: ${String(error?.message ?? error)}`)
          }
          for (const definition of toolDefs) {
            agentCtx.effect(() => agentCtx.tools.register(definition), 'pappers-hall: note tool ' + definition.name)
          }
          // Hide every global tool; scoped note tools remain visible.
          if (globalNames.length > 0) {
            agentCtx.effect(() => agentCtx.tools.restrict({ deny: globalNames }), 'pappers-hall: note agent isolation')
          }
        },
      })
      const userText = [
        'NOTE TITLE: ' + (note.title || '(untitled)'),
        'TARGET SECTION IDS: ' + JSON.stringify(targetSections.map((section) => section.id)),
        'SECTIONS (JSON): ' + JSON.stringify(targetSections.map(sectionForAgent)),
        'INLINE DIRECTIVES: ' + JSON.stringify(directives.map((directive) => ({ id: directive.id, kind: directive.kind, argument: directive.argument, sectionId: directive.sectionId }))),
        'REAL FIGURE CANDIDATES: ' + JSON.stringify(candidates.map((candidate) => ({ figureId: candidate.figureId, label: candidate.label, page: candidate.page }))),
        'EXISTING LAYOUT (optional context): ' + JSON.stringify(baseSections.slice(0, 8).map((section) => ({ id: section.id, style: section.style, blockTypes: (section.blocks || []).map((block) => block.type) }))),
        'MODE: ' + (params.mode === 'directives' ? 'execute inline directives and lightly lay out' : 'beautify all target sections') + '. Use note_read if you need more context. When done, call note_finish.',
        'STYLE DIRECTION: ' + String(params.direction || 'scientific') + '; LAYOUT: ' + String(params.layout || 'auto') + '; USE PAPER FIGURES: ' + (params.useFigures === true ? 'yes (only real candidates)' : 'only when a directive asks for one'),
      ].join('\n')
      await handle.agent.followup({ content: [{ type: 'text', text: userText.slice(0, 22000) }], source: { kind: 'user' } })
      // followup() wakes the driver asynchronously; give the loop a tick before
      // observing idle so an immediately-resolved whenIdle() cannot race it.
      await new Promise((resolve) => setTimeout(resolve, 250))
      let timer
      await Promise.race([
        handle.agent.whenIdle(),
        new Promise((_, reject) => { timer = setTimeout(() => reject(Object.assign(new Error('note agent timed out'), { code: 'timeout' })), MAX_AGENT_MS) }),
      ]).finally(() => { if (timer) clearTimeout(timer) })
      const messages = handle.agent.session.deriveMessages()
      for (const message of messages) {
        for (const block of Array.isArray(message.content) ? message.content : []) {
          if (block.type === 'tool-call') toolCalls.push({ name: block.name, arguments: String(block.arguments || '').slice(0, 500) })
          if (message.role === 'assistant' && block.type === 'text') assistantText.push(String(block.text || ''))
          if (block.type === 'tool-result' && block.isError) assistantText.push('tool error: ' + String(block.content?.[0]?.text || ''))
        }
      }
      if (draft.updated.size === 0) {
        const error = new Error('the note agent did not produce a section layout')
        error.code = 'empty'
        error.detail = {
          toolCalls: toolCalls.map((call) => call.name),
          assistant: assistantText.join('\n').slice(0, 1200),
          status: handle.agent.status,
          inbox: { nextTurn: handle.agent.inbox.nextTurn.length, nextStep: handle.agent.inbox.nextStep.length },
          events: (() => { try { return handle.agent.session.snapshotEvents().slice(-12).map((event) => ({ type: event.type, data: event.type === 'turn/end' || event.type === 'step/end' ? event.data : undefined })) } catch { return [] } })(),
          model: handle.agent.model.current(),
        }
        throw error
      }
      const mergedSections = []
      const seen = new Set()
      for (const base of baseSections) {
        const id = String(base?.id || '')
        if (draft.updated.has(id)) {
          mergedSections.push(draft.updated.get(id))
          seen.add(id)
        } else {
          mergedSections.push(base)
          seen.add(id)
        }
      }
      for (const section of sections) {
        if (seen.has(section.id)) continue
        if (draft.updated.has(section.id)) mergedSections.push(draft.updated.get(section.id))
        seen.add(section.id)
      }
      // Section order follows the current Markdown, not stale base ordering.
      const byId = new Map(mergedSections.map((section) => [String(section.id), section]))
      const orderedSections = sections.map((section) => byId.get(section.id)).filter(Boolean)
      for (const section of mergedSections) if (!orderedSections.some((entry) => String(entry.id) === String(section.id))) orderedSections.push(section)
      const figureCount = orderedSections.reduce((sum, section) => sum + (section.blocks || []).filter((block) => block.type === 'figure').length, 0)
      const styles = [...new Set(orderedSections.map((section) => section.style || 'plain'))]
      const contentJson = {
        version: 2,
        direction: String(params.direction || baseContentJson?.direction || 'plain'),
        layout: String(params.layout || baseContentJson?.layout || 'auto'),
        createdAt: new Date().toISOString(),
        engine: { provider: route.provider, model: route.model, elapsedMs: Date.now() - startedAt, kind: 'note-agent' },
        agent: { sessionId, tools: toolCalls.map((call) => call.name), finished: draft.finished, directives: directives.length, webSources: draft.webSources.length },
        sections: orderedSections,
      }
      return {
        status: 'ok',
        contentJson,
        sections: orderedSections,
        sentCount: targetSections.length,
        skippedTooLong: [],
        figureCount,
        styles,
        mode: params.mode === 'directives' ? 'directives' : (params.mode || 'manual'),
        provider: route.provider,
        model: route.model,
        elapsedMs: Date.now() - startedAt,
        cached: false,
        calls: toolCalls.length,
        toolCalls: toolCalls.map((call) => call.name),
        directives: directives.length,
        finished: draft.finished,
        sessionId,
      }
    } catch (error) {
      logger?.warn?.(`pappers-hall: note agent failed: ${String(error?.message ?? error)}`)
      throw error
    } finally {
      if (handle !== undefined) {
        try { await handle.dispose() } catch (error) { logger?.debug?.(`pappers-hall: note agent dispose failed: ${String(error?.message ?? error)}`) }
      }
    }
  }

  return {
    run,
    available() {
      const route = modelRoute()
      return { status: route.status, reason: route.reason, provider: route.provider, model: route.model }
    },
  }
}
