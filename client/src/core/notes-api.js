/**
 * Notes client service (v0.17).
 *
 * One thin adapter over the Host's `notes.*` methods (docs/CONTRACT-NOTES.md,
 * camelCase wire shape) plus the AI beauty pass. It exists so both note
 * surfaces — the reader's side tab and the standalone notes library — share the
 * same normalisation, error mapping and degradation rules:
 *
 *   - a Host that does not implement `notes.*` yet reports
 *     `{code:'invalid', message:'unknown API method "notes.list"'}`; that is
 *     turned into one honest `notes_unavailable` state instead of a crash;
 *   - `not_running`/`network` stays a separate `offline` state so the UI can say
 *     "插件未运行" rather than blaming the notes service;
 *   - a revision mismatch surfaces as `conflict` with `currentRevision`;
 *   - AI beautification is ALWAYS `ai.ask` (paper-grounded) or `ai.complete`
 *     (generic) + client-side JSON parsing: the Host never rewrites `contentMd`,
 *     and `notes.update` only writes `contentJson`;
 *   - v2 beautification is incremental: only the eligible sections are sent, the
 *     result is merged into the previous v2 structure, and figure blocks are
 *     validated against real `figures.list` candidates (no invented images).
 *
 * No new dependencies; every method degrades to a typed error the UI renders.
 */

import {
  BEAUTIFY_DIRECTIONS,
  BEAUTIFY_LAYOUTS,
  BEAUTIFY_MAX_CHARS,
  BEAUTIFY_MAX_SECTIONS,
  CONTENT_JSON_VERSION,
  DEFAULT_AUTOFIX_DIRECTION,
  MAX_FIGURES_PER_RUN,
  NOTES_FORMAT_VERSION,
  figureCandidatesForPrompt,
  mergeContentJson,
  normalizeFigureCandidate,
  normalizeFolder,
  normalizeFolderTree,
  normalizeNote,
  normalizeNoteList,
  normalizeRevisions,
  normalizeSearchResults,
  notesOffline,
  notesUnavailable,
  parseBeautifyPayload,
} from './notes-model.js'
import { firstText, arrayOf } from './texts.js'

/** Error code the UI treats as "notes service not ready". */
export const NOTES_UNAVAILABLE = 'notes_unavailable'
/** Direction wording handed to the model (kept out of i18n on purpose: it is an instruction, not UI copy). */
const DIRECTION_PROMPTS = {
  plain: '更素：克制、朴素，少修饰，短句优先；保留原意与事实，不添形容词。',
  vivid: '更生动：表达更清晰、有节奏，可加简短小标题或类比，但不夸张、不编造。',
  scientific: '更科学范：学术书面语，术语精确，层次分明（背景/观察/结论式的过渡），不使用口语。',
}
const LAYOUT_PROMPTS = {
  auto: '自动，按内容选择最合适的 block 组合',
  bullets: '尽量用分点（bullets）组织条目',
  table: '内容适合比较时用表格（table），其余仍用段落/分点',
}
/** Static direction suggestions used when the model cannot propose any. */
const STATIC_DIRECTIONS = [
  { id: 'd-plain', direction: 'plain', layout: 'auto', useFigures: false, label: '更素一点', reason: '克制、短句，尽量保留你的原话' },
  { id: 'd-vivid', direction: 'vivid', layout: 'auto', useFigures: false, label: '更生动一点', reason: '表达更有节奏，可加简短小标题' },
  { id: 'd-scientific', direction: 'scientific', layout: 'auto', useFigures: false, label: '更科学范一点', reason: '学术书面语、术语精确、层次分明' },
]
/** Direction label keys are rendered by the UI; these are prompt-only hints. */
const DIRECTION_LABELS = { plain: '更素一点', vivid: '更生动一点', scientific: '更科学范一点' }

/** Attach a stable code to one error without losing it. */
function coded(error, code) {
  const value = error instanceof Error ? error : new Error(String(error || code))
  value.code = code
  return value
}

/**
 * @param {Function} api Host API callable `(method, params) => Promise<data>`.
 */
export function createNotesService(api) {
  if (typeof api !== 'function') throw new Error('createNotesService requires the Host API callable')
  let state = { status: 'unknown', reason: '', revision: 0 }
  const listeners = new Set()
  let probing = null

  function publish(next) {
    state = Object.assign({}, state, next, { revision: state.revision + 1 })
    listeners.forEach((listener) => {
      try {
        listener(state)
      } catch (error) {
        console.warn('[pappers-hall] notes service listener failed', error)
      }
    })
  }

  /** Run one Host call, mapping "unknown method" into the shared unavailable state. */
  function request(method, params) {
    let promise
    try {
      promise = Promise.resolve(api(method, params == null ? {} : params))
    } catch (error) {
      promise = Promise.reject(error)
    }
    return promise.then(
      (data) => {
        if (state.status !== 'ready') publish({ status: 'ready', reason: '' })
        return data
      },
      (error) => {
        if (notesUnavailable(error)) {
          publish({ status: 'unavailable', reason: String(error && error.message ? error.message : '') })
          const next = coded(error, NOTES_UNAVAILABLE)
          next.cause = error
          throw next
        }
        // A transient write/read failure must not demote a working notes
        // service to "offline": callers retry locally (autosave draft). Only a
        // failure while we still do not know the service state flips it.
        if (notesOffline(error) && state.status !== 'ready') {
          publish({ status: 'offline', reason: String(error && error.message ? error.message : '') })
        }
        throw error
      },
    )
  }

  /** One cheap read to decide whether the Host half has the notes surface. */
  function probe() {
    if (state.status === 'ready') return Promise.resolve(state)
    if (probing) return probing
    probing = request('notes.folders.tree', {})
      .then(() => state)
      .catch((error) => {
        if (error && error.code === NOTES_UNAVAILABLE) return state
        if (notesOffline(error)) {
          publish({ status: 'offline', reason: String(error.message || '') })
          return state
        }
        // A Host that answers but lacks the method usually answers `invalid`;
        // any other failure keeps the unknown state so a retry can settle it.
        return state
      })
      .then((value) => {
        probing = null
        return value
      })
    return probing
  }

  /**
   * Call an AI primitive without touching the notes-service state: a missing
   * `ai.complete`/`ai.ask` means "AI unavailable", never "notes service down".
   */
  function aiCall(method, params) {
    let promise
    try {
      promise = Promise.resolve(api(method, params == null ? {} : params))
    } catch (error) {
      promise = Promise.reject(error)
    }
    return promise.catch((error) => {
      if (notesUnavailable(error)) {
        const next = coded(error, 'unavailable')
        next.reason = String(error && error.message ? error.message : '')
        throw next
      }
      throw error
    })
  }

  const service = {
    /** Current service state: `{status:'unknown'|'ready'|'unavailable'|'offline', reason}`. */
    getSnapshot() {
      return state
    },
    subscribe(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    probe,

    /* ------------------------------ notes CRUD --------------------------- */
    list(params) {
      return request('notes.list', params || {}).then((data) => normalizeNoteList(data))
    },
    get(id, params) {
      return request('notes.get', Object.assign({ id: String(id || '') }, params || {})).then((data) => {
        const note = normalizeNote(data && (data.note || data))
        if (!note) throw coded(new Error('notes.get returned no note'), 'invalid')
        return note
      })
    },
    create(params) {
      return request('notes.create', params || {}).then((data) => normalizeNote(data && (data.note || data)))
    },
    update(params) {
      const payload = Object.assign({}, params || {})
      if (payload.patch && typeof payload.patch === 'object') {
        // Keep the wire contract camelCase; the Host decides how to store it.
        payload.patch = Object.assign({}, payload.patch)
      }
      return request('notes.update', payload).catch((error) => {
        if (error && error.code === 'conflict') {
          const detail = (error && error.detail) || {}
          const next = coded(error, 'conflict')
          next.currentRevision = Number(detail.currentRevision ?? detail.current_revision ?? payload.expectedRevision) || 0
          throw next
        }
        throw error
      }).then((data) => normalizeNote(data && (data.note || data)))
    },
    remove(ids) {
      return request('notes.delete', { ids: arrayOf(ids).map(String).filter(Boolean) })
    },
    restore(ids) {
      return request('notes.restore', { ids: arrayOf(ids).map(String).filter(Boolean) })
    },
    purge(ids) {
      return request('notes.purge', { ids: arrayOf(ids).map(String).filter(Boolean) })
    },
    revisions(id) {
      return request('notes.revisions', { id: String(id || '') }).then(normalizeRevisions)
    },
    restoreRevision(id, revision) {
      return request('notes.restoreRevision', { id: String(id || ''), revision: Number(revision) }).then((data) => normalizeNote(data && (data.note || data)))
    },
    search(params) {
      return request('notes.search', params || {}).then(normalizeSearchResults)
    },
    exportNotes(ids, format) {
      return request('notes.export', { ids: arrayOf(ids).map(String).filter(Boolean), format: format || 'both' })
    },

    /* ------------------------------ folders ------------------------------ */
    foldersTree() {
      return request('notes.folders.tree', {}).then(normalizeFolderTree)
    },
    createFolder(params) {
      return request('notes.folders.create', params || {}).then((data) => normalizeFolder(data && (data.folder || data)))
    },
    renameFolder(params) {
      return request('notes.folders.rename', params || {}).then((data) => normalizeFolder(data && (data.folder || data)))
    },
    deleteFolder(id) {
      return request('notes.folders.delete', { id: String(id || '') })
    },
    assignFolder(folderId, noteIds) {
      return request('notes.folders.assign', { folderId: folderId ? String(folderId) : null, noteIds: arrayOf(noteIds).map(String) })
    },
    unassignFolder(noteIds) {
      return request('notes.folders.unassign', { noteIds: arrayOf(noteIds).map(String) })
    },

    /* ------------------------------ papers ------------------------------- */
    link(noteId, paperIds, anchor) {
      const params = { noteId: String(noteId || ''), paperIds: arrayOf(paperIds).map(String).filter(Boolean) }
      if (anchor && typeof anchor === 'object') params.anchor = anchor
      return request('notes.link', params).then((data) => normalizeNote(data && (data.note || data)))
    },
    unlink(noteId, paperIds) {
      return request('notes.unlink', { noteId: String(noteId || ''), paperIds: arrayOf(paperIds).map(String).filter(Boolean) }).then((data) => normalizeNote(data && (data.note || data)))
    },

    /* ------------------------------ AI bridge ---------------------------- */
    /** `ai.status` is independent from notes: failure just means "unknown". */
    aiStatus() {
      let promise
      try {
        promise = Promise.resolve(api('ai.status', {}))
      } catch (error) {
        promise = Promise.reject(error)
      }
      return promise.catch(() => null)
    },

    /* ---------------------------- figure candidates ------------------------ */
    /**
     * Collect real figure candidates from the note's linked papers.
     * Returns `{candidates, byId, paperCount, reason?}`; caps the list so the
     * prompt stays small and spreads the picks across pages.
     * @param {Array<{paperId:string,title?:string,titleZh?:string}>|Array<string>} paperLinks
     * @param {{limit?:number}} [options]
     */
    figureCandidates(paperLinks, options) {
      const opts = options || {}
      const links = arrayOf(paperLinks)
        .map((entry) => (typeof entry === 'string' ? { paperId: entry } : entry))
        .filter((entry) => entry && entry.paperId)
      if (links.length === 0) {
        return Promise.resolve({ candidates: [], byId: new Map(), paperCount: 0, reason: 'no_linked_paper' })
      }
      const limit = Math.max(1, Math.min(24, Number(opts.limit) || 12))
      const chosen = links.slice(0, 3)
      const perPaper = Math.max(2, Math.ceil(limit / chosen.length))
      return Promise.all(
        chosen.map((link) =>
          Promise.resolve()
            .then(() => api('figures.list', { paperId: link.paperId }))
            .then((rows) =>
              arrayOf(rows)
                .map((row) => normalizeFigureCandidate(row, { paperId: link.paperId, paperTitle: link.title, paperTitleZh: link.titleZh }))
                .filter(Boolean),
            )
            .catch(() => []),
        ),
      ).then((groups) => {
        const candidates = []
        groups.forEach((rows) => {
          const withCaption = rows.filter((row) => row.caption)
          const pool = withCaption.length > 0 ? withCaption : rows
          const step = Math.max(1, Math.floor(pool.length / Math.max(1, perPaper)))
          let taken = 0
          for (let index = 0; index < pool.length && candidates.length < limit; index += step) {
            const candidate = pool[index]
            if (candidates.some((entry) => entry.figureId === candidate.figureId)) continue
            candidates.push(candidate)
            taken += 1
            if (taken >= perPaper) break
          }
        })
        const sliced = candidates.slice(0, limit)
        return { candidates: sliced, byId: new Map(sliced.map((candidate) => [candidate.figureId, candidate])), paperCount: chosen.length }
      })
    },

    /* ------------------------- automatic directions ----------------------- */
    /**
     * Ask the model for 3 differentiated micro-directions before an automatic
     * beautify pass (non-blocking overlay in the editor). Falls back to three
     * built-in suggestions when the model is unavailable or answers badly.
     *
     * @param {object} options
     * @param {string} [options.title] note title
     * @param {Array} [options.sections] eligible sections (only headings/snippets are sent)
     * @param {Array} [options.figureCandidates]
     * @param {string} [options.direction] current default direction
     * @param {string} [options.sessionId]
     */
    suggestDirections(options) {
      const opts = options || {}
      const sections = arrayOf(opts.sections).slice(0, 8)
      const figureCandidates = arrayOf(opts.figureCandidates)
      const hasFigures = figureCandidates.length > 0
      const current = BEAUTIFY_DIRECTIONS.includes(opts.direction) ? opts.direction : DEFAULT_AUTOFIX_DIRECTION
      const prompt = buildDirectionPrompt({
        title: firstText(opts.title),
        sections,
        hasFigures,
        figureCount: figureCandidates.length,
        current,
        minChars: Number(opts.minChars) || 0,
      })
      const params = {
        prompt,
        system: '你是科研笔记编辑助手，只输出用户要求的 JSON，不输出解释与代码围栏。',
        fast: true,
        maxTokens: 700,
        kind: 'note-directions',
        cache: false,
      }
      if (opts.sessionId) params.sessionId = opts.sessionId
      return aiCall('ai.complete', params)
        .then((result) => {
          const data = result || {}
          if (data.status !== 'ok') {
            const error = new Error(firstText(data.reason, 'AI unavailable'))
            error.code = data.status === 'unavailable' ? 'unavailable' : 'error'
            throw error
          }
          const parsed = parseDirectionsPayload(data.answer, { hasFigures, current })
          return Object.assign(parsed, {
            provider: firstText(data.provider),
            model: firstText(data.model),
            elapsedMs: Number(data.elapsedMs) || 0,
            cached: data.cached === true,
            degraded: false,
            reason: '',
          })
        })
        .catch((error) => {
          const fallback = staticDirections(hasFigures, current)
          return {
            directions: fallback.directions,
            recommended: fallback.recommended,
            provider: '',
            model: '',
            elapsedMs: 0,
            cached: false,
            degraded: true,
            reason: firstText(error && (error.reason || error.message), 'AI 方向建议不可用，已使用内置建议'),
          }
        })
    },

    /**
     * Ask the model to re-lay-out the finished sections as a varied, continuous
     * v2 document (styles + sparse figures/columns/tables).
     *
     * Only `contentJson` is produced; `contentMd` is never sent as a replacement
     * body and the caller persists with `notes.update patch.contentJson`.
     *
     * @param {object} options
     * @param {object} options.note normalised note (for paper context)
     * @param {Array} options.sections finished sections to beautify (incremental)
     * @param {object|null} [options.baseContentJson] previous structure to merge into
     * @param {Array} [options.liveSections] current `{id,hash}` list for ordering
     * @param {Array} [options.figureCandidates] real `figures.list` candidates
     * @param {string} [options.direction] plain | vivid | scientific
     * @param {string} [options.layout] auto | bullets | table
     * @param {boolean} [options.useFigures] nudge the model towards one real figure
     * @param {string} [options.mode] `manual` | `auto`
     * @param {string} [options.paperId] paper used as the ai.ask grounding context
     * @param {string} [options.contextText] unfinished previous section(s), context only
     * @param {string} [options.sessionId]
     */
    beautify(options) {
      const opts = options || {}
      const note = opts.note || {}
      const direction = DIRECTION_PROMPTS[opts.direction] ? opts.direction : 'plain'
      const layout = LAYOUT_PROMPTS[opts.layout] ? opts.layout : 'auto'
      // Linked notes stay paper-grounded (`ai.ask`); standalone notes use the
      // generic `ai.complete` primitive (v0.17.1 host).
      const paperId = firstText(opts.paperId, arrayOf(note.paperIds)[0])
      const figureCandidates = arrayOf(opts.figureCandidates).slice(0, 18)
      // Keep the prompt inside the Host's 6000-char input budget: truncate per
      // section and stop at the section/char cap, reporting what was skipped.
      const sent = []
      let chars = 0
      const skippedTooLong = []
      for (const section of arrayOf(opts.sections).slice(0, BEAUTIFY_MAX_SECTIONS)) {
        const body = String(section.text || section.raw || '').trim()
        const budget = Math.min(900, BEAUTIFY_MAX_CHARS - chars)
        if (budget < 80) {
          skippedTooLong.push(section.id)
          continue
        }
        const clipped = body.length > budget ? body.slice(0, budget).trimEnd() + (body.length > budget ? '…' : '') : body
        chars += clipped.length + String(section.heading || '').length + 24
        sent.push({ id: String(section.id), heading: String(section.heading || ''), text: clipped, hash: String(section.hash || '') })
        if (chars >= BEAUTIFY_MAX_CHARS) break
      }
      if (sent.length === 0) {
        const error = new Error('no finished section is small enough to beautify')
        error.code = 'empty'
        return Promise.reject(error)
      }
      const context = String(opts.contextText || '').trim()
      const prompt = buildBeautifyPrompt({
        direction,
        layout,
        sections: sent,
        context,
        figureCandidates,
        useFigures: opts.useFigures === true,
        mode: opts.mode || 'manual',
      })
      const params = paperId
        ? { paperId, prompt, mode: 'deep', fast: false }
        : { prompt, system: '你是一名科研笔记编辑，只输出用户要求的 JSON，不添加原文没有的事实。', fast: false, reasoningEffort: 'medium', kind: 'note-beautify', maxTokens: 3000 }
      if (opts.sessionId) params.sessionId = opts.sessionId
      return aiCall(paperId ? 'ai.ask' : 'ai.complete', params)
        .then((result) => {
          const data = result || {}
          if (data.status !== 'ok') {
            const error = new Error(firstText(data.reason, 'AI unavailable'))
            error.code = data.status === 'unavailable' ? 'unavailable' : 'error'
            error.reason = firstText(data.reason)
            throw error
          }
          const sections = parseBeautifyPayload(data.answer, sent, { figureCandidates })
          const contentJson = mergeContentJson(opts.baseContentJson || null, sections, {
            direction,
            layout,
            engine: { provider: firstText(data.provider), model: firstText(data.model), elapsedMs: Number(data.elapsedMs) || 0 },
            liveSections: arrayOf(opts.liveSections),
          })
          let figureCount = 0
          for (const section of sections) {
            for (const block of arrayOf(section.blocks)) if (block.type === 'figure') figureCount += 1
          }
          return {
            contentJson,
            sections,
            sentCount: sent.length,
            skippedTooLong,
            figureCount,
            styles: Array.from(new Set(sections.map((section) => section.style))),
            mode: opts.mode || 'manual',
            provider: firstText(data.provider),
            model: firstText(data.model),
            elapsedMs: Number(data.elapsedMs) || 0,
            cached: data.cached === true,
          }
        })
    },

    /** The format version written with every beautified note. */
    formatVersion: NOTES_FORMAT_VERSION,
  }

  return service
}

/** Build the one-shot v2 beautify instruction (kept exported so tests can assert it). */
export function buildBeautifyPrompt({ direction, layout, sections, context, figureCandidates, useFigures, mode }) {
  const list = arrayOf(sections).map((section) => ({
    id: section.id,
    heading: section.heading || '',
    text: section.text || '',
  }))
  const candidates = figureCandidatesForPrompt(figureCandidates, 10)
  const lines = [
    '你是 Pappers-Hall 的科研笔记排版助手。任务以“恢复和强化排版结构”为主，多样化表达只作辅助；这不是重写任务。',
    '硬性规则：',
    '1) 信息零丢失（最高优先级）：原文的每个事实、数字、单位、公式、限定词（如“可能/显著/仅/约”）、引用编号与专有名词都必须保留；禁止概括、合并、删减或改写句意；只允许调整分段、标题层级、列表化、表格化和排版顺序。',
    '2) 只输出给定 id 的章节，不得新增 id；未完成章节不在输入里，不要臆造它们。',
    '3) 排版为主：优先还原原文的标题层级、段落顺序和阅读节奏；只有当原文本身确实包含并列关系、步骤、对比或数值比较时才用分点/表格；columns/figure 只在内容确实适合时使用，严禁为了“多样”而拆散原句或制造卡片。',
    '4) 每节必须给 style：plain / accent / columns（两栏）/ figure（图文）；style 只是辅助，拿不准就用 plain。避免整篇 plain 或整篇卡片化即可，不要强行求多。',
    '5) blocks 类型：heading / paragraph / bullets / table / quote / callout / figure / columns。',
    '   - columns 必须正好 2 栏：{"type":"columns","columns":[{"blocks":[...]},{"blocks":[...]}]}，栏内放段落/分点；',
    '   - 少而精：整次输出最多 1 个 columns、最多 1 个表格、最多 ' + String(MAX_FIGURES_PER_RUN) + ' 张 figure；不要为凑数使用；',
    '   - figure 只能写 figureId（来自下面候选），不要编造 id、不要自己写图注（正文可配一句说明）；',
    '   - 没有相关图就不要放 figure；候选为空时禁止 figure。',
    (useFigures
      ? '6) 本次主人希望“图文并茂一点”：如果确实有助于理解，请从候选中选 1 张最相关的真实配图放进 figure（没有相关图就不放）。'
      : '6) 配图按需：只有确实帮助理解时才从候选中选 1 张真实配图。'),
    '7) 输出语言与笔记正文一致；段落 ≤ 300 字，分点每条 ≤ 200 字。',
    '8) 严格只输出一个 JSON 对象，不要 Markdown 代码围栏、不要任何解释。schema：',
    '{"sections":[{"id":"s0","heading":"...","style":"plain","blocks":[{"type":"heading","text":"..."},{"type":"paragraph","text":"..."},{"type":"bullets","items":["..."]},{"type":"table","headers":["..."],"rows":[["..."]]},{"type":"quote","text":"..."},{"type":"callout","tone":"info","title":"...","text":"..."},{"type":"columns","columns":[{"blocks":[{"type":"paragraph","text":"..."}]},{"blocks":[{"type":"paragraph","text":"..."}]}]},{"type":"figure","figureId":"fg-..."}]}]}',
    '美化方向：' + DIRECTION_PROMPTS[direction],
    '排版偏好：' + LAYOUT_PROMPTS[layout],
    '运行模式：' + (mode === 'auto' ? '自动增量（只排版给出的章节，其余章节保持已有排版）' : '手动'),
  ]
  if (candidates.length > 0) {
    lines.push('真实论文配图候选（只能从这里选 figureId）：')
    lines.push(JSON.stringify(candidates))
  } else {
    lines.push('真实论文配图候选：无（禁止输出 figure block）')
  }
  if (context) {
    lines.push('上文（用户还没写完，仅用于理解上下文，绝对不要输出、不要补写）：')
    lines.push(context.slice(0, 600))
  }
  lines.push('笔记章节输入（JSON）：')
  lines.push(JSON.stringify(list))
  return lines.join('\n')
}

/** Build the automatic-direction suggestion prompt (kept exported for tests). */
export function buildDirectionPrompt({ title, sections, hasFigures, figureCount, current, minChars }) {
  const list = arrayOf(sections).map((section) => ({
    id: String(section.id || ''),
    heading: String(section.heading || ''),
    excerpt: String(section.text || '').slice(0, 80),
  }))
  const lines = [
    '你是 Pappers-Hall 的科研笔记编辑助手。主人正在一边写笔记一边让 AI 排版。',
    '请根据下面【已完成但尚未排版】的章节内容，给出 3 个差异化的“微调方向”建议，供主人一键采用或忽略。',
    '可选 direction：plain（更素）/ vivid（更生动）/ scientific（更科学范）；',
    '可选 layout：auto（自动）/ bullets（多分点）/ table（多表格）；',
    hasFigures
      ? '可用真实论文配图 ' + String(figureCount) + ' 张；如需图文并茂可把某一项的 useFigures 设为 true（最多 1 张，只能来自真实候选）。'
      : '没有可用的论文配图，禁止 useFigures=true，也不要建议配图。',
    '不要改写内容，只给方向建议；label ≤ 10 字，reason ≤ 24 字。',
    '严格只输出 JSON：{"directions":[{"id":"d1","direction":"plain","layout":"auto","useFigures":false,"label":"...","reason":"..."},{"id":"d2",...},{"id":"d3",...}],"recommended":"d1"}',
    '笔记标题：' + (title || '（未命名）'),
    '当前默认方向：' + (DIRECTION_LABELS[current] || current) + (minChars ? '；本次约 ' + String(minChars) + ' 字待排版' : ''),
    '已完成章节（JSON）：',
    JSON.stringify(list),
  ]
  return lines.join('\n')
}

/** Parse the direction suggestion answer into validated 3 options. */
export function parseDirectionsPayload(answer, { hasFigures, current }) {
  const text = String(answer == null ? '' : answer).trim()
  const fence = /```(?:json)?\s*([\s\S]*?)```/i.exec(text)
  const jsonText = fence ? fence[1].trim() : text
  const first = jsonText.indexOf('{')
  const last = jsonText.lastIndexOf('}')
  let parsed = null
  if (first >= 0 && last > first) {
    try {
      parsed = JSON.parse(jsonText.slice(first, last + 1))
    } catch {
      parsed = null
    }
  }
  const rawDirections = arrayOf(parsed && parsed.directions)
  const seen = new Set()
  const directions = []
  for (const raw of rawDirections) {
    if (!raw || typeof raw !== 'object') continue
    const direction = String(raw.direction || '').toLowerCase()
    if (!DIRECTION_PROMPTS[direction] || seen.has(direction)) continue
    seen.add(direction)
    const layout = String(raw.layout || '').toLowerCase()
    directions.push({
      id: firstText(raw.id) || 'd-' + direction,
      direction,
      layout: LAYOUT_PROMPTS[layout] ? layout : 'auto',
      useFigures: Boolean(hasFigures && raw.useFigures === true),
      label: String(firstText(raw.label) || DIRECTION_LABELS[direction]).slice(0, 24),
      reason: String(firstText(raw.reason) || '').slice(0, 120),
    })
    if (directions.length >= 3) break
  }
  // Fill missing slots with built-in suggestions so the overlay always has 3.
  const fallback = staticDirections(hasFigures, current)
  for (const option of fallback.directions) {
    if (directions.length >= 3) break
    if (seen.has(option.direction)) continue
    seen.add(option.direction)
    directions.push(option)
  }
  const recommendedRaw = firstText(parsed && parsed.recommended)
  const recommended = directions.some((option) => option.id === recommendedRaw)
    ? recommendedRaw
    : (directions.find((option) => option.direction === current) || directions[0]).id
  return { directions, recommended }
}

/** Built-in fallback directions (used when the model is unavailable). */
export function staticDirections(hasFigures, current) {
  const directions = STATIC_DIRECTIONS.map((option) => Object.assign({}, option))
  if (hasFigures) {
    directions[1] = {
      id: 'd-figure',
      direction: 'vivid',
      layout: 'auto',
      useFigures: true,
      label: '图文并茂一点',
      reason: '少而精插入 1 张论文原图，其余保持克制',
    }
  }
  const wanted = BEAUTIFY_DIRECTIONS.includes(current) ? current : DEFAULT_AUTOFIX_DIRECTION
  const recommended = (directions.find((option) => option.direction === wanted) || directions[directions.length - 1]).id
  return { directions, recommended }
}
