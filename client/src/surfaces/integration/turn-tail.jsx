/**
 * Conversation integration: custom Tool result cards for the Pappers-Hall wire
 * tools (`tool.call.toolview`, one keyed view per tool name).
 *
 * Cards parse the tool's JSON text block, render a compact source card (paper
 * title + Chinese title, page/figure/caption/reasons) and offer "打开原文"
 * through the global navigation store and "引用到对话" through the shared
 * pending store. They never send a message.
 */
import React from 'react'
import { h } from '../../core/dom.js'
import { Icon } from '../../core/icons.jsx'
import { Badge, Button, IconButton } from '../../core/primitives.jsx'
import { TOOL_NAMES, NS, PANEL_ID } from '../../core/constants.js'
import { navigation } from '../../core/navigation.js'
import { bus } from '../../core/bus.js'
import { pendingStore } from '../../core/pending.js'
import { installDragToConversation } from '../../core/dnd.js'
import { installUndoShortcuts } from '../../core/undo.js'
import { registerInputTriggers } from './input-triggers.js'

function operationId(prefix) {
  const random =
    typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
      ? crypto.randomUUID()
      : Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 10)
  return (prefix ? prefix + '-' : '') + random
}

function arrayOf(value) {
  return Array.isArray(value) ? value : []
}

function firstText() {
  for (let index = 0; index < arguments.length; index += 1) {
    const value = arguments[index]
    if (typeof value === 'string' && value.trim() !== '') return value
  }
  return ''
}

function reasonLabel(t, reason) {
  const token = String(reason || '').toLowerCase()
  if (!token) return ''
  if (token.indexOf('near_duplicate') >= 0 || token.indexOf('dhash') >= 0) return t('page.reason.neardup')
  if (token.indexOf('caption') >= 0) return t('page.reason.caption')
  if (token.indexOf('annotation') >= 0) return t('page.reason.annotation')
  if (token.indexOf('note') >= 0) return t('page.reason.note')
  if (token.indexOf('visual') >= 0 || token.indexOf('vector') >= 0) return t('page.reason.visual')
  if (token.indexOf('full text') >= 0 || token.indexOf('substring') >= 0) return t('page.reason.body')
  if (token.indexOf('title') >= 0 || token.indexOf('fts') >= 0) return t('page.reason.title')
  return String(reason)
}

function toolTitle(t, name, args) {
  switch (name) {
    case 'papers_search':
      return t('tool.title.search')
    case 'papers_get':
    case 'papers_list':
      return t('tool.title.detail')
    case 'papers_manage':
      return t('tool.title.manage')
    case 'papers_pdf': {
      const action = args && typeof args.action === 'string' ? args.action : 'inspect'
      if (action === 'view') return t('tool.title.pdfView')
      if (action === 'read') return t('tool.title.pdfRead')
      if (action === 'ocr') return t('tool.title.pdfOcr')
      if (action === 'import') return t('tool.title.pdfImport')
      return t('tool.title.pdfInspect')
    }
    case 'papers_changes':
      return t('tool.title.changes')
    case 'notes_search':
    case 'notes_get':
    case 'notes_edit':
      return t('tool.title.notes')
    case 'papers_get_passage':
      return t('tool.title.passage')
    case 'papers_get_figure':
      return t('tool.title.figure')
    case 'papers_translate':
      return t('tool.title.translate')
    case 'papers_cite':
      return t('tool.title.cite')
    case 'papers_index_status':
      return t('tool.title.status')
    case 'papers_propose_changes':
      return t('tool.title.proposal')
    case 'papers_apply_changes':
      return t('tool.title.apply')
    case 'papers_get_annotations':
      return t('tool.title.annotations')
    case 'papers_annotate':
      return t('tool.title.annotations')
    default:
      return t('tool.title.unknown')
  }
}

function toolIcon(name, args) {
  switch (name) {
    case 'papers_get_figure':
      return 'figure'
    case 'papers_pdf':
      return args && args.action === 'view' ? 'figure' : 'pages'
    case 'papers_get_passage':
    case 'papers_translate':
      return 'pages'
    case 'papers_overview':
      return 'search'
    case 'papers_cite':
      return 'quote'
    case 'papers_changes':
    case 'papers_manage':
      return 'edit'
    case 'papers_annotations':
      return 'highlighter'
    default:
      return 'book'
  }
}

/** Parse the settled result's first JSON text block. */
function parseResult(block) {
  if (!block || !Array.isArray(block.content)) return null
  const text = block.content.find((item) => item && item.type === 'text' && typeof item.text === 'string')
  if (!text) return null
  try {
    return JSON.parse(text.text)
  } catch {
    return { raw: text.text }
  }
}

/** Open one paper/figure through the shared navigation store and reveal the panel. */
function openSource(props, target) {
  if (target.figureId) {
    navigation.openFigureSearch({ paperId: target.paperId, figureId: target.figureId, page: target.page })
  } else if (target.paperId) {
    navigation.openPaper({ paperId: target.paperId, page: target.page || 1, annotationId: target.annotationId || null, source: 'tool' })
  } else {
    return
  }
  if (props.openPanel) props.openPanel()
}

function materialOf(kind, id, page, title) {
  const material = { kind: kind, id: String(id) }
  if (page) material.page = Number(page)
  if (title) material.title = title
  return material
}

/** One call card: header, running/error state and the tool-specific body. */
function ToolSourceCard(props) {
  const t = props.t
  const toolName = props.toolName
  const phase = props.phase
  const block = props.block
  const api = props.api
  const [citing, setCiting] = React.useState('')
  const [open, setOpen] = React.useState(false)
  const [citeError, setCiteError] = React.useState('')
  const result = phase === 'result' ? parseResult(block) : null
  const isError = phase === 'result' && Boolean(block && block.isError)
  const isUnavailable = Boolean(result && result.status === 'unavailable')
  const preparing = phase === 'preparing'
  const running = phase === 'start'
  const args = React.useMemo(() => {
    if (!block) return null
    const raw = phase === 'result' ? block.call && block.call.argsRaw : block.argsRaw
    if (typeof raw !== 'string' || raw === '') return null
    try {
      return JSON.parse(raw)
    } catch {
      return null
    }
  }, [block, phase])

  const cite = (materials) => {
    setCiting('busy')
    setCiteError('')
    api('references.commit', { sessionId: props.sessionId, items: materials.map((item) => ({ kind: item.kind, id: item.id, ...(item.page ? { page: item.page } : {}) })), operationId: operationId('refs') })
      .then((value) => {
        pendingStore.add(value, materials)
        setCiting('done')
      })
      .catch((error) => {
        setCiting('')
        setCiteError(String(error && error.message ? error.message : error))
      })
  }

  let body = null
  if (preparing || running) {
    body = h(
      'div',
      { className: 'ph-toolcard__running' },
      h('span', { className: 'ph-spinner', 'aria-hidden': 'true' }),
      h('span', null, preparing ? t('tool.preparing') : t('tool.running')),
      args && typeof args.query === 'string' ? h('span', { className: 'ph-muted' }, '“' + args.query + '”') : null,
    )
  } else if (isError) {
    body = h(
      'div',
      { className: 'ph-toolcard__error' },
      h(Icon, { name: 'warning', size: 15 }),
      h('span', null, firstText(block && block.error && block.error.message, t('tool.failed'))),
    )
  } else if (isUnavailable) {
    body = h(
      'div',
      { className: 'ph-toolcard__error' },
      h(Icon, { name: 'warning', size: 15 }),
      h('span', null, t('tool.unavailable', { reason: firstText(result.reason, t('common.unavailable')) })),
    )
  } else {
    body = h(ToolBody, { t: t, toolName: toolName, data: result, args: args, props: props, citing: citing, cite: cite })
  }

  return h(
    'div',
    { className: 'ph-toolcard' + (open ? ' ph-toolcard--open' : '') },
    h(
      'div',
      {
        className: 'ph-toolcard__head',
        role: 'button',
        tabIndex: 0,
        'aria-expanded': open ? 'true' : 'false',
        onClick: () => setOpen((value) => !value),
        onKeyDown: (event) => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); setOpen((value) => !value) } },
      },
      h('span', { className: 'ph-toolcard__icon' }, h(Icon, { name: toolIcon(toolName, args), size: 15 })),
      h('span', { className: 'ph-toolcard__title' }, toolTitle(t, toolName, args)),
      h('span', { className: 'ph-toolcard__sub' }, phase === 'result' ? toolSummary(t, toolName, result) : ''),
      h('span', { className: 'ph-spacer' }),
      phase === 'result' && result && result.image && result.image.status === 'ready'
        ? h(Badge, { tone: 'muted', icon: 'figure' }, t('tool.image'))
        : null,
      citing === 'done' ? h(Badge, { tone: 'success', icon: 'checkCircle' }, t('tool.cited')) : null,
      citeError ? h('span', { className: 'ph-toolcard__note' }, citeError) : null,
      props.inspect ? h(IconButton, { icon: 'external', title: 'inspect', onClick: (event) => { event.stopPropagation(); props.inspect() } }) : null,
      h(Icon, { name: 'chevronRight', size: 14, className: 'ph-toolcard__chev' }),
    ),
    open ? h('div', { className: 'ph-toolcard__body' }, body) : null,
  )
}

function toolSummary(t, toolName, data) {
  if (!data) return ''
  if (toolName === 'papers_search') return data.scope === 'reference_bundle' ? t('tool.scope.reference_bundle') : t('tool.scope.library')
  if (toolName === 'papers_index_status') return t('tool.title.status')
  if (toolName === 'papers_translate') return firstText(data.status, '')
  return ''
}

function SearchBody(props) {
  const t = props.t
  const data = props.data
  const items = arrayOf(data && data.items)
  const channels = arrayOf(data && data.channels).filter((channel) => channel && channel.status !== 'ok')
  if (items.length === 0) return h('p', { className: 'ph-toolcard__note' }, t('tool.noItems'))
  return h(
    'div',
    null,
    h(
      'ul',
      { className: 'ph-toolcard__list' },
      items.slice(0, 5).map((item, index) => {
        const title = firstText(item.titleZh, item.title, t('common.untitled'))
        const paperId = firstText(item.paperId, item.kind === 'paper' ? item.id : '')
        const figureId = item.kind === 'figure' ? item.id : ''
        return h(
          'li',
          { key: (item.kind || 'item') + ':' + (item.id || index), className: 'ph-toolcard__listitem' },
          h(Icon, { name: item.kind === 'figure' ? 'figure' : item.kind === 'annotation' ? 'highlighter' : item.kind === 'note' ? 'note' : 'book', size: 14, className: 'ph-muted' }),
          h(
            'div',
            { className: 'ph-toolcard__main' },
            h('div', { className: 'ph-toolcard__name' }, title),
            h('div', { className: 'ph-toolcard__meta' }, [item.kind, item.page ? t('tool.page', { page: item.page }) : '', item.figureLabel ? t('tool.figureLabel', { label: item.figureLabel }) : ''].filter(Boolean).join(' · ')),
            arrayOf(item.reasons).length > 0 ? h('div', { className: 'ph-reasons' }, item.reasons.slice(0, 3).map((reason, reasonIndex) => h(Badge, { key: reasonIndex, tone: 'business' }, reasonLabel(t, reason)))) : null,
          ),
          h(
            'div',
            { className: 'ph-toolcard__actions' },
            paperId || figureId ? h(IconButton, { icon: 'external', title: t('tool.openPaper'), onClick: () => openSource(props.props, { paperId: paperId, page: item.page, figureId: figureId }) }) : null,
            paperId || figureId || item.kind === 'annotation' ? h(IconButton, { icon: 'quote', title: t('tool.cite'), onClick: () => props.cite([materialOf(item.kind || 'paper', item.id, item.page, title)]) }) : null,
          ),
        )
      }),
    ),
    items.length > 5 ? h('p', { className: 'ph-toolcard__note' }, t('tool.more', { count: items.length - 5 })) : null,
    channels.length > 0 ? h('p', { className: 'ph-toolcard__note' }, channels.map((channel) => (channel.name || 'channel') + ': ' + (channel.status || 'degraded') + (channel.note ? ' — ' + channel.note : '')).join('；')) : null,
  )
}

function PassageBody(props) {
  const t = props.t
  const data = props.data
  const paper = data.paper || {}
  const paperId = firstText(paper.id)
  return h(
    'div',
    { className: 'ph-toolcard__row' },
    h(Icon, { name: 'pages', size: 16, className: 'ph-muted' }),
    h(
      'div',
      { className: 'ph-toolcard__main' },
      h('div', { className: 'ph-toolcard__name' }, title),
      h('div', { className: 'ph-toolcard__meta' }, [data.page ? t('tool.page', { page: data.page }) : '', data.depth === 'fulltext' ? t('tool.depth.fulltext') : data.depth === 'abstract' ? t('tool.depth.abstract') : t('tool.depth.metadata_only')].filter(Boolean).join(' · ')),
      h('p', { className: 'ph-toolcard__text' }, firstText(data.text, '')),
      h(
        'div',
        { className: 'ph-toolcard__actions' },
        paperId ? h(Button, { size: 'sm', icon: 'external', onClick: () => openSource(props.props, { paperId: paperId, page }) }, t('tool.openPage', { page: page || 1 })) : null,
        paperId ? h(Button, { size: 'sm', icon: 'quote', onClick: () => props.cite([materialOf('paper', paperId, data.page, firstText(paper.titleZh, paper.title))]) }, t('tool.cite')) : null,
      ),
    ),
  )
}

function FigureBody(props) {
  const t = props.t
  const data = props.data
  // Old tool results were stored before the unified figure payload existed;
  // fall back to the flat view fields so historical cards do not break.
  const figure = data.figure || {}
  const paper = data.paper || {}
  const paperId = firstText(figure.paperId, paper.id)
  const image = data.image || {}
  const localTitle = data.path ? String(data.path).split(/[\\/]/).pop() : ''
  const title = firstText(paper.titleZh, paper.title, localTitle, t('common.untitled'))
  const label = firstText(figure.label, data.label)
  const page = figure.page ?? data.page
  const caption = firstText(figure.caption, data.caption)
  const imageUrl = firstText(figure.imageUrl)
  const [imageFailed, setImageFailed] = React.useState(false)
  React.useEffect(() => { setImageFailed(false) }, [imageUrl])
  return h(
    'div',
    { className: 'ph-toolcard__row' },
    h(
      'div',
      { className: 'ph-toolcard__thumb' },
      imageUrl && !imageFailed
        ? h('img', { src: imageUrl, alt: '', loading: 'lazy', decoding: 'async', draggable: false, onError: () => setImageFailed(true) })
        : h('span', { className: 'ph-toolcard__thumbicon' }, h(Icon, { name: 'figure', size: 20 })),
    ),
    h(
      'div',
      { className: 'ph-toolcard__main' },
      h('div', { className: 'ph-toolcard__name' }, title),
      h('div', { className: 'ph-toolcard__meta' }, [data.local ? t('tool.localPdf') : '', label ? t('tool.figureLabel', { label }) : '', page ? t('tool.page', { page }) : ''].filter(Boolean).join(' · ')),
      h('p', { className: 'ph-toolcard__text' }, caption || t('reader.figure.noCaption')),
      image && image.status && image.status !== 'ready' ? h('p', { className: 'ph-toolcard__note' }, t('tool.unavailable', { reason: firstText(image.reason, image.status) })) : null,
      h(
        'div',
        { className: 'ph-toolcard__actions' },
        paperId ? h(Button, { size: 'sm', icon: 'external', onClick: () => openSource(props.props, { paperId: paperId, page }) }, t('tool.openPage', { page: page || 1 })) : null,
        firstText(figure.id) ? h(Button, { size: 'sm', icon: 'search', onClick: () => openSource(props.props, { paperId: paperId, page, figureId: figure.id }) }, t('tool.similar')) : null,
        firstText(figure.id) ? h(Button, { size: 'sm', icon: 'quote', onClick: () => props.cite([materialOf('figure', figure.id, page, firstText(caption, label))]) }, t('tool.cite')) : null,
      ),
    ),
  )
}

function TranslateBody(props) {
  const t = props.t
  const data = props.data
  const translated = firstText(data.translation)
  return h(
    'div',
    null,
    h('div', { className: 'ph-toolcard__meta' }, firstText(data.status, ''), data.target ? ' · ' + data.target : ''),
    translated
      ? h('p', { className: 'ph-toolcard__text' }, translated)
      : h('p', { className: 'ph-toolcard__note' }, t('tool.unavailable', { reason: firstText(data.provenance && data.provenance.reason, data.status || 'unavailable') })),
    h(
      'div',
      { className: 'ph-toolcard__actions' },
      data.paper_id ? h(Button, { size: 'sm', icon: 'external', onClick: () => openSource(props.props, { paperId: data.paper_id, page: data.page }) }, t('tool.openPage', { page: data.page || 1 })) : null,
    ),
  )
}

function CiteBody(props) {
  const t = props.t
  const data = props.data
  const citations = arrayOf(data.citations)
  const warnings = arrayOf(data.warnings)
  return h(
    'div',
    null,
    citations.map((citation, index) =>
      h(
        'div',
        { key: citation.paper_id || index, className: 'ph-toolcard__cite' },
        h('span', null, citation.text || ''),
        h(IconButton, {
          icon: 'copy',
          title: t('tool.copy'),
          onClick: () => {
            try {
              if (typeof navigator !== 'undefined' && navigator.clipboard) navigator.clipboard.writeText(String(citation.text || ''))
            } catch (error) {
              /* clipboard is best-effort */
            }
          },
        }),
      ),
    ),
    warnings.length > 0 ? h('ul', { className: 'ph-toolcard__warn' }, warnings.map((warning, index) => h('li', { key: index }, warning))) : null,
  )
}

function StatusBody(props) {
  const t = props.t
  const data = props.data
  const counts = data.counts || {}
  const index = data.index || {}
  const channels = index.channels || {}
  const jobs = data.jobs || {}
  const degraded = arrayOf(data.degraded)
  const facts = [
    ['papers', counts.papers],
    ['annotations', counts.annotations],
    ['notes', counts.notes],
    ['figures', counts.figures],
    ['trash', counts.trash],
  ]
    .filter((entry) => entry[1] != null)
    .map((entry) => h('span', { key: entry[0], className: 'ph-toolcard__fact' }, t('page.status.' + entry[0], { count: Number(entry[1]) })))
  return h(
    'div',
    { className: 'ph-toolcard__counts' },
    facts,
    h('span', { className: 'ph-toolcard__fact' }, t('tool.index.fts') + ': ', h('b', null, firstText(channels.fts, 'unknown'))),
    h('span', { className: 'ph-toolcard__fact' }, t('tool.index.vector') + ': ', h('b', null, firstText(channels.vector, 'unknown'))),
    h('span', { className: 'ph-toolcard__fact' }, t('tool.jobs') + ': ', h('b', null, jobs.globalPaused ? t('page.status.paused') : String(Number(jobs.running) || 0) + ' / ' + String(Number(jobs.queued) || 0))),
    degraded.length > 0 ? h('ul', { className: 'ph-toolcard__warn' }, degraded.map((entry, index2) => h('li', { key: index2 }, (entry.channel || 'channel') + ' — ' + (entry.reason || '')))) : null,
  )
}

function GenericBody(props) {
  const t = props.t
  const data = props.data
  if (!data) return h('p', { className: 'ph-toolcard__note' }, t('tool.resultEmpty'))
  if (typeof data.raw === 'string') return h('pre', { className: 'ph-toolcard__cite' }, data.raw.slice(0, 800))
  const text = JSON.stringify(data, null, 2)
  return h('pre', { className: 'ph-toolcard__cite' }, text.length > 1200 ? text.slice(0, 1200) + '…' : text)
}

function ToolBody(props) {
  switch (props.toolName) {
    case 'papers_search':
      return h(SearchBody, { t: props.t, data: props.data, props: props.props, cite: props.cite })
    case 'papers_get_passage':
      return h(PassageBody, { t: props.t, data: props.data, props: props.props, cite: props.cite })
    case 'papers_get_figure':
      return h(FigureBody, { t: props.t, data: props.data, props: props.props, cite: props.cite })
    case 'papers_pdf':
      if (props.args && props.args.action === 'view') return h(FigureBody, { t: props.t, data: props.data, props: props.props, cite: props.cite })
      return h(GenericBody, { t: props.t, data: props.data })
    case 'papers_translate':
      return h(TranslateBody, { t: props.t, data: props.data, props: props.props })
    case 'papers_cite':
      return h(CiteBody, { t: props.t, data: props.data })
    case 'papers_overview':
      return h(StatusBody, { t: props.t, data: props.data })
    case 'papers_changes':
    case 'papers_annotations':
      return h(GenericBody, { t: props.t, data: props.data })
    default:
      return h(GenericBody, { t: props.t, data: props.data })
  }
}

function makeToolView(name) {
  const View = function PappersHallToolView(props) {
    return h(ToolSourceCard, Object.assign({}, props, { toolName: name }))
  }
  View.displayName = 'PappersHallToolView(' + name + ')'
  return View
}

/**
 * Register one keyed tool view per Pappers-Hall wire tool.
 * @param {object} ctx Client plugin context.
 * @param {{t: Function, api: Function}} services localized copy and transport.
 * @returns {Function} disposer (already owned by the caller's effect).
 */
export function registerConversationIntegration(ctx, services) {
  const api = services.api
  const openPanel = () => {
    const layout = typeof ctx.get === 'function' ? ctx.get('layout') : undefined
    if (!layout || typeof layout.selectPanel !== 'function') return false
    try {
      layout.selectPanel(PANEL_ID)
      return true
    } catch (error) {
      console.warn('[pappers-hall] cannot reveal the paper center', error)
      return false
    }
  }
  // Composer "+"/@ integration (optional service; skipped silently when absent).
  ctx.effect(
    () => {
      const openPaper = (paperId) => {
        try {
          navigation.openPaper({ paperId: String(paperId), page: 1, source: 'mention' })
          const layout = typeof ctx.get === 'function' ? ctx.get('layout') : undefined
          if (layout && typeof layout.selectPanel === 'function') layout.selectPanel(PANEL_ID)
          return true
        } catch (error) {
          return false
        }
      }
      const openFolder = (folderId) => {
        bus.emit('open-library-view', { folderId: String(folderId) })
        try {
          const layout = typeof ctx.get === 'function' ? ctx.get('layout') : undefined
          if (layout && typeof layout.selectPanel === 'function') layout.selectPanel(PANEL_ID)
        } catch (error) { /* best effort */ }
        return true
      }
      // The input-trigger module may mount after this plugin; retry briefly so the
      // composer "+" menu entry and @论文中心 source appear without a reload.
      let disposed = false
      let disposeTriggers = () => {}
      let timer
      let attempts = 0
      const attempt = () => {
        if (disposed) return true
        attempts += 1
        const result = registerInputTriggers(ctx, { t: services.t, api: services.api, openPaper: openPaper, openFolder: openFolder })
        if (typeof result === 'function') {
          disposeTriggers = result
          return true
        }
        return false
      }
      if (!attempt()) {
        timer = setInterval(() => {
          if (attempt() || attempts > 60) {
            clearInterval(timer)
            timer = undefined
          }
        }, 500)
      }
      return () => {
        disposed = true
        if (timer !== undefined) clearInterval(timer)
        try { disposeTriggers() } catch (error) { /* ignore */ }
      }
    },
    'pappers-hall: composer triggers',
  )

  // Global interactions owned by the plugin: ⌘Z/⌘⇧Z and drag-to-conversation.
  ctx.effect(
    () => {
      installUndoShortcuts()
      const services2 = services
      const uiWorkspace = typeof ctx.get === 'function' ? ctx.get('uiWorkspace') : undefined
      const sessions = typeof ctx.get === 'function' ? ctx.get('sessions') : undefined
      const getWorkspaceId = () => {
        try {
          const state = sessions && typeof sessions.getSnapshot === 'function' ? sessions.getSnapshot() : null
          const current = state && state.current
          const entry = current && state.byId ? state.byId[current] : null
          return entry && entry.workspaceId ? entry.workspaceId : undefined
        } catch (error) {
          return undefined
        }
      }
      return installDragToConversation({ t: services2.t, uiWorkspace: uiWorkspace, sessions: sessions, getWorkspaceId: getWorkspaceId })
    },
    'pappers-hall: global undo + drag to conversation',
  )

  TOOL_NAMES.forEach((name) => {
    ctx.effect(
      () =>
        ctx.slots.inject('tool.call.toolview', () =>
          ctx.slots.register(
            {
              name: 'tool.call.toolview',
              key: name,
              locale: NS,
              inject: () => ({ api: api, openPanel: openPanel }),
            },
            makeToolView(name),
          ),
        ),
      'pappers-hall: tool view ' + name,
    )
  })
}
