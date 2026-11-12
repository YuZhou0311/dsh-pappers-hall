/**
 * Zotero-style three-pane library shell: left collections, middle item table,
 * right item details, with draggable split handles, a status strip, a floating
 * batch bar, context menus and the toast host.
 *
 * UI widths and view mode are the only persisted preferences (localStorage in
 * core/library-state.js); library data always comes from the Host API.
 */
import React from 'react'
import { h } from '../../core/dom.js'
import { Icon } from '../../core/icons.jsx'
import { Badge, Button, EmptyState, IconButton, ToastStack, useToasts, SearchInput } from '../../core/primitives.jsx'
import { describeError } from '../../core/api.js'
import { copyText, downloadText } from '../../core/files.js'
import { paperTitle } from '../../core/texts.js'
import { pendingStore } from '../../core/pending.js'
import { STATUS_POLL_MS } from '../../core/constants.js'
import { CollectionsPane } from './collections.jsx'
import { NoteInline } from './note-inline.jsx'
import { BatchBar, LibraryToolbar } from './toolbar.jsx'
import { ItemTable } from './item-table.jsx'
import { DetailsPane } from './details.jsx'
import { DuplicatesPane } from './duplicates.jsx'
import { CitationDialog, CommandPalette, HelpDialog } from './dialogs.jsx'
import { FeedbackHost, notify } from '../../core/feedback.js'
import { installUndoShortcuts, undo } from '../../core/undo.js'
import { deliverMaterials } from '../../core/dnd.js'
import { bus } from '../../core/bus.js'
import { navigation } from '../../core/navigation.js'
import { SearchFilters } from './folders.jsx'

/** Always-visible paper search in the center topbar (debounced). */
function GlobalSearch(props) {
  const t = props.t
  const snapshot = props.snapshot
  const controller = props.controller
  const [value, setValue] = React.useState(snapshot.filters.query || '')
  const external = React.useRef(snapshot.filters.query || '')
  React.useEffect(() => {
    if (snapshot.filters.query !== external.current) {
      external.current = snapshot.filters.query || ''
      setValue(snapshot.filters.query || '')
    }
  }, [snapshot.filters.query])
  React.useEffect(() => {
    const timer = setTimeout(() => {
      if (value !== snapshot.filters.query) controller.setQuery(value)
    }, 260)
    return () => clearTimeout(timer)
  }, [value, controller, snapshot.filters.query])
  return h(SearchInput, {
    className: 'ph-center__globalsearch',
    value: value,
    onChange: setValue,
    placeholder: t('library.searchPlaceholder'),
    'aria-label': t('library.searchPlaceholder'),
    clearLabel: t('common.clear'),
    loading: snapshot.status === 'loading',
  })
}

function operationId(prefix) {
  const random =
    typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
      ? crypto.randomUUID()
      : Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 10)
  return (prefix ? prefix + '-' : '') + random
}

function StatusBar(props) {
  const t = props.t
  const snapshot = props.snapshot
  const library = props.library
  const [busy, setBusy] = React.useState('')
  const [errorText, setErrorText] = React.useState('')
  const status = snapshot.statusData
  const counts = snapshot.counts || (status && status.counts) || {}
  const index = (status && status.index) || {}
  const channels = index.channels || {}
  const jobs = (status && status.jobs) || {}
  // Optional capabilities (e.g. OCR not installed) stay out of the warning row;
  // the user only needs actionable degradations here.
  const degraded = (Array.isArray(status && status.degraded) ? status.degraded : []).filter((item) => !item || item.severity !== 'optional')
  const pending = Number(counts.jobsPending) || Number(jobs.queued) + Number(jobs.running) || 0
  const running = Number(jobs.running) || 0
  const paused = jobs.globalPaused === true || jobs.state === 'paused'
  const offline = snapshot.offline

  React.useEffect(() => {
    const timer = setInterval(() => library.refreshStatus(), STATUS_POLL_MS)
    return () => clearInterval(timer)
  }, [library])

  const runJob = (action) => {
    setBusy(action)
    setErrorText('')
    props.api(action === 'pause' ? 'jobs.pause' : 'jobs.resume', {})
      .then(() => library.refreshStatus())
      .catch((error) => setErrorText(describeError(t, error)))
      .then(() => setBusy(''))
  }

  if (offline) {
    return h(
      'div',
      { className: 'ph-statusbar' },
      h(Icon, { name: 'warning', size: 14 }),
      h('span', { className: 'ph-statusbar__error' }, t('common.offline.title')),
      h('span', { className: 'ph-statusbar__spacer' }),
      h(Button, { size: 'sm', variant: 'ghost', icon: 'refresh', onClick: () => library.refresh() }, t('common.retry')),
    )
  }

  const chips = [
    ['papers', counts.papers],
    ['annotations', counts.annotations],
    ['notes', counts.notes],
    ['figures', counts.figures],
    ['trash', counts.trash],
  ]
    .filter((entry) => entry[1] != null)
    .map((entry) => h('span', { key: entry[0], className: 'ph-statusbar__chip' }, t('page.status.' + entry[0], { count: Number(entry[1]) })))

  const fts = channels.fts
  const channelText = fts === 'degraded' ? t('page.status.ftsDegraded') : fts === 'ready' ? t('page.status.ftsReady') : ''
  const vectorText = channels.vector && channels.vector !== 'ready' ? t('page.status.vectorUnavailable') : ''

  return h(
    'div',
    { className: 'ph-statusbar' },
    h('div', { className: 'ph-statusbar__group' }, h(Icon, { name: 'pages', size: 14 }), chips),
    h('span', { className: 'ph-statusbar__divider' }),
    h(
      'div',
      { className: 'ph-statusbar__group' },
      h(Icon, { name: 'search', size: 14 }),
      h('span', { className: 'ph-statusbar__muted' }, channelText || t('page.status.index')),
      vectorText ? h('span', { className: 'ph-statusbar__warn' }, vectorText) : null,
      degraded.length > 0
        ? h(
            'span',
            {
              className: 'ph-statusbar__warn',
              title: degraded
                .map((item) => {
                  const label = t('page.status.channel.' + (item && item.channel))
                  return (label || (item && item.channel)) + '：' + ((item && item.reason) || '')
                })
                .concat(t('page.status.degradedHint'))
                .join('\n'),
            },
            t('page.status.degraded', {
              channels: degraded
                .map((item) => t('page.status.channel.' + (item && item.channel)) || (item && item.channel))
                .filter(Boolean)
                .join('、'),
            }),
          )
        : null,
    ),
    h('span', { className: 'ph-statusbar__spacer' }),
    h(
      'div',
      { className: 'ph-statusbar__group' },
      h(Icon, { name: 'refresh', size: 14 }),
      h('span', { className: 'ph-statusbar__muted' }, t('page.status.jobs')),
      h('span', null, pending > 0 ? t('page.status.jobsPending', { count: pending }) : running > 0 ? t('page.status.jobsRunning', { count: running }) : t('page.status.jobsIdle')),
      paused ? h(Badge, { tone: 'warning' }, t('page.status.paused')) : null,
      errorText ? h('span', { className: 'ph-statusbar__warn' }, errorText) : null,
      paused
        ? h(Button, { size: 'sm', variant: 'ghost', icon: 'play', disabled: Boolean(busy), onClick: () => runJob('resume') }, t('page.status.resume'))
        : h(Button, { size: 'sm', variant: 'ghost', icon: 'pause', disabled: Boolean(busy), onClick: () => runJob('pause') }, t('page.status.pause')),
      status && status.storage ? h('span', { className: 'ph-statusbar__muted' }, t('page.status.db', { size: Math.max(0, Math.round(Number(status.storage.dbBytes) / 1024)) + ' KB' })) : null,
      h(IconButton, { icon: 'refresh', title: t('page.status.refresh'), onClick: () => library.refreshStatus() }),
    ),
  )
}

function PaneResizer(props) {
  const [active, setActive] = React.useState(false)
  const start = React.useRef(null)
  const latest = React.useRef(null)
  const onMouseDown = (event) => {
    event.preventDefault()
    start.current = { x: event.clientX, width: props.width }
    latest.current = props.width
    setActive(true)
    const move = (moveEvent) => {
      if (!start.current) return
      const delta = moveEvent.clientX - start.current.x
      const next = props.side === 'left' ? start.current.width + delta : start.current.width - delta
      latest.current = next
      props.onDrag(next)
    }
    const up = () => {
      start.current = null
      setActive(false)
      document.removeEventListener('mousemove', move)
      document.removeEventListener('mouseup', up)
      if (latest.current != null && props.onCommit) props.onCommit(latest.current)
    }
    document.addEventListener('mousemove', move)
    document.addEventListener('mouseup', up)
  }
  return h('div', {
    className: 'ph-resizer' + (active ? ' ph-resizer--active' : ''),
    role: 'separator',
    'aria-orientation': 'vertical',
    'aria-label': props.label,
    tabIndex: 0,
    onMouseDown: onMouseDown,
    onKeyDown: (event) => {
      if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return
      event.preventDefault()
      const delta = event.key === 'ArrowRight' ? 16 : -16
      props.onDrag(props.width + (props.side === 'left' ? delta : -delta))
    },
  })
}

function ContextMenu(props) {
  const t = props.t
  const menu = props.menu
  const paper = props.paper
  const library = props.library
  const [submenu, setSubmenu] = React.useState(false)
  const [armed, setArmed] = React.useState(false)
  const ref = React.useRef(null)
  const style = { left: Math.min(menu.x, (typeof window !== 'undefined' ? window.innerWidth : 800) - 220) + 'px', top: Math.min(menu.y, (typeof window !== 'undefined' ? window.innerHeight : 600) - 280) + 'px' }

  if (!paper) return null
  const close = () => library.closeContextMenu()
  const act = (fn) => () => {
    close()
    fn()
  }
  const trashMode = paper.state === 'trash'
  const collections = (props.collections || []).filter((collection) => collection.kind !== 'field')

  return h(
    'div',
    { className: 'ph-ctxmenu', style: style, ref: ref, role: 'menu' },
    h('button', { type: 'button', className: 'ph-ctxmenu__item', onClick: act(() => props.onOpen(paper.id, 1)) }, h(Icon, { name: 'book', size: 14 }), t('library.context.open')),
    h('button', { type: 'button', className: 'ph-ctxmenu__item', onClick: act(() => props.onCite(paper)) }, h(Icon, { name: 'quote', size: 14 }), t('library.context.cite')),
    h('button', { type: 'button', className: 'ph-ctxmenu__item', onClick: act(() => { library.selectPaper(paper.id, { tab: 'tags' }); props.onShowDetails && props.onShowDetails() }) }, h(Icon, { name: 'tag', size: 14 }), t('library.context.tag')),
    collections.length > 0
      ? h(
          React.Fragment,
          null,
          h('button', { type: 'button', className: 'ph-ctxmenu__item', onClick: () => setSubmenu(!submenu), 'aria-expanded': submenu ? 'true' : 'false' }, h(Icon, { name: 'collection', size: 14 }), t('library.context.collection')),
          submenu
            ? h('div', { className: 'ph-ctxmenu__sub' }, collections.map((collection) => h('button', { key: collection.id, type: 'button', className: 'ph-ctxmenu__item', onClick: act(() => library.assignCollection(collection.id, [paper.id], true).then(() => props.pushToast('success', t('library.collection.assign') + ' · ' + collection.name)).catch((error) => props.pushToast('error', t('toast.failed', { message: describeError(t, error) })))) }, h('span', { className: 'ph-collection__dot', 'data-color': collection.color || 'blue' }), collection.name)))
            : null,
        )
      : null,
    h('button', { type: 'button', className: 'ph-ctxmenu__item', onClick: act(() => copyText(paper.id).then((ok) => props.pushToast(ok ? 'success' : 'warning', ok ? t('toast.copied') : t('common.unavailable')))) }, h(Icon, { name: 'copy', size: 14 }), t('library.context.copyId')),
    h('div', { className: 'ph-ctxmenu__sep' }),
    trashMode
      ? h(React.Fragment, null,
          h('button', { type: 'button', className: 'ph-ctxmenu__item', onClick: act(() => library.setSelection([paper.id]) || library.restoreSelection().then(() => props.pushToast('success', t('toast.restored'))).catch((error) => props.pushToast('error', t('toast.failed', { message: describeError(t, error) })))) }, h(Icon, { name: 'restore', size: 14 }), t('library.context.restore')),
          h('button', { type: 'button', className: 'ph-ctxmenu__item ph-ctxmenu__item--danger', onClick: () => { if (!armed) { setArmed(true); return } act(() => library.setSelection([paper.id]) || library.purgeSelection().then(() => props.pushToast('success', t('toast.purged'))).catch((error) => props.pushToast('error', t('toast.failed', { message: describeError(t, error) })))) } }, h(Icon, { name: 'trash', size: 14 }), armed ? t('library.batch.purgeConfirm') : t('library.context.purge')),
        )
      : h('button', { type: 'button', className: 'ph-ctxmenu__item ph-ctxmenu__item--danger', onClick: act(() => library.setSelection([paper.id]) || library.trashSelection().then(() => props.pushToast('success', t('toast.trashed'))).catch((error) => props.pushToast('error', t('toast.failed', { message: describeError(t, error) })))) }, h(Icon, { name: 'trash', size: 14 }), t('library.context.trash')),
  )
}

function LibrarySkeleton() {
  return h(
    React.Fragment,
    null,
    h('div', { className: 'ph-pane ph-pane--left' }, h('div', { className: 'ph-left-skeleton' }, [0, 1, 2, 3, 4].map((index) => h('div', { key: index, className: 'ph-details__skeletonrow' }, h('span', { className: 'ph-skeleton', style: { width: '16px', height: '16px' } }), h('span', { className: 'ph-skeleton', style: { flex: 1, height: '11px' } }))))),
    h('div', { className: 'ph-pane ph-pane--mid' }, h('div', { className: 'ph-table-skeleton' }, [0, 1, 2, 3, 4, 5, 6, 7].map((index) => h('div', { key: index, className: 'ph-table-skeleton__row' }, h('span', { className: 'ph-skeleton', style: { width: 14, height: 14 } }), h('div', { className: 'ph-table-skeleton__main' }, h('span', { className: 'ph-skeleton', style: { width: '58%' } }), h('span', { className: 'ph-skeleton', style: { width: '36%', height: 9 } })), h('span', { className: 'ph-skeleton', style: { width: 72, height: 10 } }))))),
    h('div', { className: 'ph-pane ph-pane--right' }, h('div', { className: 'ph-details__skeleton' }, [0, 1, 2, 3, 4, 5].map((index) => h('div', { key: index, className: 'ph-details__skeletonrow' }, h('span', { className: 'ph-skeleton', style: { width: 64, height: 10 } }), h('span', { className: 'ph-skeleton', style: { flex: 1, height: 10 } }))))),
  )
}

function useNarrowLayout() {
  const [narrow, setNarrow] = React.useState(() => typeof window !== 'undefined' && window.innerWidth <= 980)
  React.useEffect(() => {
    const onResize = () => setNarrow(typeof window !== 'undefined' && window.innerWidth <= 980)
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [])
  return narrow
}

export function LibraryShell(props) {
  const narrow = useNarrowLayout()
  const t = props.t
  const api = props.api
  const library = props.library
  const snapshot = React.useSyncExternalStore(library.subscribe, library.getSnapshot, library.getSnapshot)
  const { toasts, push, dismiss } = useToasts()
  const [newCollectionOpen, setNewCollectionOpen] = React.useState(false)
  const [newCollectionName, setNewCollectionName] = React.useState('')
  const [dragWidth, setDragWidth] = React.useState({ left: null, right: null })
  const [paletteOpen, setPaletteOpen] = React.useState(false)
  const [citationOpen, setCitationOpen] = React.useState(false)
  const [helpOpen, setHelpOpen] = React.useState(false)
  const [inlineNoteId, setInlineNoteId] = React.useState('')

  React.useEffect(() => {
    if (snapshot.status === 'idle') library.refresh()
    else library.refreshStatus()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  React.useEffect(() => {
    installUndoShortcuts()
    const onKey = (event) => {
      const meta = event.metaKey || event.ctrlKey
      const target = event.target
      const typing = target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable)
      if (meta && !event.shiftKey && String(event.key).toLowerCase() === 'k') { event.preventDefault(); setPaletteOpen((value) => !value); return }
      if (meta && event.shiftKey && String(event.key).toLowerCase() === 'c') { event.preventDefault(); setCitationOpen(true); return }
      if (!meta && event.key === '?' && !typing) { event.preventDefault(); setHelpOpen(true) }
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [])

  React.useEffect(() => {
    const offView = bus.on('open-library-view', (payload) => {
      if (payload && payload.folderId) { library.setFolderFilter(String(payload.folderId)); return }
      const view = payload && payload.view
      if (!view) return
      if (view === 'all') { library.setView('all'); return }
      library.setView(view)
    })
    const offPaper = bus.on('open-library-paper', (payload) => {
      if (!payload || !payload.paperId) return
      library.setView('all')
      setTimeout(() => library.selectPaper(String(payload.paperId)), 60)
    })
    return () => { offView(); offPaper() }
  }, [library])

  React.useEffect(() => {
    if (!snapshot.contextMenu) return undefined
    const close = () => library.closeContextMenu()
    const onKey = (event) => {
      if (event.key === 'Escape') close()
    }
    document.addEventListener('mousedown', close)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', close)
      document.removeEventListener('keydown', onKey)
    }
  }, [snapshot.contextMenu, library])

  const contextPaper = snapshot.contextMenu ? snapshot.items.find((paper) => paper.id === snapshot.contextMenu.paperId) : null

  const citePaper = React.useCallback(
    (paper) => {
      api('references.commit', { items: [{ kind: 'paper', id: paper.id }], operationId: operationId('refs') })
        .then((result) => {
          pendingStore.add(result, [{ kind: 'paper', id: paper.id, title: paper.titleZh || paper.displayTitle || paper.title }])
          push('success', t('toast.cited'))
        })
        .catch((error) => push('error', t('toast.citeFailed', { message: describeError(t, error) })))
    },
    [api, push, t],
  )

  const exportPaper = React.useCallback(
    (paper) => {
      api('export.bibtex', { ids: [paper.id] })
        .then((result) => {
          if (result && result.content) {
            downloadText(result.filename, result.mediaType, result.content)
            push('success', t('toast.exported', { filename: result.filename || 'pappers-hall.bib' }))
          } else push('info', t('common.unavailable'))
        })
        .catch((error) => push('error', t('toast.exportFailed', { message: describeError(t, error) })))
    },
    [api, push, t],
  )

  const copyCitation = React.useCallback((paper, style) => {
    api('citation.format', { ids: [paper.id], style: style || 'bibtex' })
      .then((result) => {
        if (!result || !result.content) return notify('info', t('common.unavailable'))
        copyText(String(result.content)).then((ok) => notify(ok ? 'success' : 'warning', ok ? t('common.copied') : t('common.unavailable')))
      })
      .catch((error) => notify('error', t('toast.failed', { message: describeError(t, error) })))
  }, [api, t])

  const copyCitationKey = React.useCallback((paper) => {
    api('citation.key', { ids: [paper.id] })
      .then((result) => {
        const key = result && Array.isArray(result.keys) && result.keys[0] ? result.keys[0].key : ''
        if (!key) return notify('info', t('common.unavailable'))
        copyText(key).then((ok) => notify(ok ? 'success' : 'warning', ok ? t('common.copied') + ' · ' + key : t('common.unavailable')))
      })
      .catch((error) => notify('error', t('toast.failed', { message: describeError(t, error) })))
  }, [api, t])

  const exportAnnotations = React.useCallback((paper, format, action) => {
    api('export.annotations', { paperId: paper.id, format: format || 'markdown' })
      .then((result) => {
        const content = result && result.content ? String(result.content) : ''
        if (!content) return notify('info', t('annotations.exportEmpty'))
        if (action === 'download') {
          downloadText('pappers-hall-annotations-' + paper.id + (format === 'json' ? '.json' : '.md'), format === 'json' ? 'application/json' : 'text/markdown', content)
          notify('success', t('annotations.exportDone', { count: Number(result.count) || 0 }))
        } else {
          copyText(content).then((ok) => notify(ok ? 'success' : 'warning', ok ? t('common.copied') : t('common.unavailable')))
        }
      })
      .catch((error) => notify('error', t('toast.failed', { message: describeError(t, error) })))
  }, [api, t])

  const insertCitation = React.useCallback((paper) => {
    if (!paper) return
    deliverMaterials([{ kind: 'paper', id: paper.id, title: paperTitle(t, paper) }], {}).then((result) => {
      if (!result.ok) return notify('error', t('dnd.failed', { message: result.reason || '' }))
      notify(result.inserted ? 'success' : 'warning', result.inserted ? t('citation.inserted') : t('dnd.queued', { count: 1 }))
    })
  }, [t])

  const updateMetrics = React.useCallback((ids) => library.refreshMetrics(ids), [library])
  const editMetrics = React.useCallback((paperId, fields) => library.updateMetrics(paperId, fields), [library])
  const resetMetrics = React.useCallback(
    (paperId) => api('metrics.reset', { paperId: String(paperId) })
      .catch(() => api('metrics.update', { paperId: String(paperId), fields: { impactFactor: null, fiveYearImpactFactor: null, impactFactorYear: null, quartile: null, citationCount: null, hIndex: null, issn: null, publisher: null } }))
      .then(() => library.selectPaper(String(paperId), { tab: 'info' })),
    [api, library],
  )

  const selectedForCommand = library.selectedPapers()[0] || snapshot.items.find((paper) => paper.id === snapshot.details.paperId) || null
  const commands = [
    { id: 'open', label: t('cmd.openReader'), icon: 'book', hint: selectedForCommand ? paperTitle(t, selectedForCommand) : '', run: () => selectedForCommand && openPaper(selectedForCommand.id, 1) },
    { id: 'table', label: t('cmd.tableView'), icon: 'list', run: () => library.setViewMode('table') },
    { id: 'grid', label: t('cmd.gridView'), icon: 'grid', run: () => library.setViewMode('grid') },
    { id: 'search', label: t('cmd.focusSearch'), icon: 'search', run: () => { const input = rootRef.current && rootRef.current.querySelector('.ph-toolbar .ph-search input'); if (input) input.focus() } },
    { id: 'import', label: t('cmd.import'), icon: 'import', run: () => { const input = rootRef.current && rootRef.current.querySelector('input[type=file]'); if (input) input.click() } },
    { id: 'metrics', label: t('cmd.refreshMetrics'), icon: 'chart', run: () => library.refreshMetrics(snapshot.selection.length > 0 ? snapshot.selection : snapshot.items.slice(0, 5).map((paper) => paper.id)).catch((error) => notify('error', describeError(t, error))) },
    selectedForCommand ? { id: 'cite', label: t('cmd.copyCitation'), icon: 'quote', run: () => copyCitation(selectedForCommand, 'bibtex') } : null,
    selectedForCommand ? { id: 'citeKey', label: t('cmd.copyCitationKey'), icon: 'key', run: () => copyCitationKey(selectedForCommand) } : null,
    { id: 'duplicates', label: t('cmd.duplicates'), icon: 'copy', run: () => library.setView('duplicates') },
    { id: 'figures', label: t('cmd.figureSearch'), icon: 'image', run: () => props.onOpenFigures && props.onOpenFigures() },
    { id: 'notes', label: t('cmd.notesLibrary'), icon: 'note', run: () => navigation.openNotes({}) },
    { id: 'undo', label: t('common.undo'), icon: 'restore', run: () => undo.undoLast().then((result) => notify(result.ok ? 'success' : 'info', result.ok ? t('common.undo') + ' · ' + (result.label || '') : t('additional.noUndo'))) },
    { id: 'semantic', label: t('cmd.semantic'), icon: 'search', run: () => { const input = rootRef.current && rootRef.current.querySelector('.ph-toolbar .ph-search input'); if (input) { input.focus(); input.setSelectionRange(input.value.length, input.value.length) } } },
    { id: 'help', label: t('help.title'), icon: 'info', run: () => setHelpOpen(true) },
  ].filter(Boolean)

  const openContext = (menu) => library.openContextMenu(menu)
  const openPaper = (paperId, page) => props.onOpenPaper(paperId, page)
  const rootRef = React.useRef(null)

  if (snapshot.offline) {
    return h(
      'div',
      { className: 'ph-center' },
      h('div', { className: 'ph-center__topbar' },
        h('div', { className: 'ph-center__brand' }, h(Icon, { name: 'book', size: 20, className: 'ph-center__mark' }), h('h1', { className: 'ph-center__title' }, t('library.title')), h('span', { className: 'ph-center__subtitle' }, t('library.subtitle'))),
      ),
      h('div', { className: 'ph-center__body' },
        h(EmptyState, { tone: 'warning', icon: 'warning', title: t('common.offline.title'), desc: t('common.offline.desc'), action: h(Button, { variant: 'secondary', icon: 'refresh', onClick: () => library.refresh() }, t('common.retry')) }),
      ),
    )
  }

  const loadingFirst = snapshot.status === 'loading' && snapshot.items.length === 0

  const topbar = h(
    'div',
    { className: 'ph-center__topbar' },
    h('div', { className: 'ph-center__brand' }, h(Icon, { name: 'book', size: 20, className: 'ph-center__mark' }), h('h1', { className: 'ph-center__title' }, t('library.title'))),
    h(GlobalSearch, { t: t, snapshot: snapshot, controller: library }),
    h('div', { className: 'ph-center__actions' },
      h(Button, { size: 'sm', variant: 'soft', icon: 'image', onClick: () => { if (props.onOpenFigures) props.onOpenFigures(); else navigation.openFigureSearch({}) }, title: t('library.smart.figures') }, t('library.smart.figures')),
      h(IconButton, { icon: 'settings', title: t('settings.open'), 'aria-label': t('settings.open'), onClick: () => bus.emit('open-settings') }),
      h(IconButton, { icon: 'refresh', title: t('page.refresh'), onClick: () => library.refresh() }),
    ),
  )

  const middle = inlineNoteId
    ? h(
        'div',
        { className: 'ph-pane ph-pane--mid ph-pane--noteinline' },
        h(NoteInline, {
          t: t,
          api: api,
          noteId: inlineNoteId,
          onClose: () => setInlineNoteId(''),
          onOpenPaper: (paperId, page, annotationId) => openPaper(paperId, page || 1, annotationId),
          notify: push,
        }),
      )
    : h(
        'div',
        { className: 'ph-pane ph-pane--mid' },
        h(LibraryToolbar, { t: t, api: api, snapshot: snapshot, controller: library, pushToast: push }),
        h(SearchFilters, { t: t, snapshot: snapshot, controller: library }),
        snapshot.filters.view === 'duplicates'
          ? h(DuplicatesPane, { t: t, snapshot: snapshot, controller: library, pushToast: push })
          : h(ItemTable, {
              t: t,
              snapshot: snapshot,
              controller: library,
              onOpenPaper: openPaper,
              onToggleRead: (paper, read) => library.setRead(paper.id, read).then(() => push('success', t('toast.readUpdated'))).catch((error) => push('error', t('toast.failed', { message: describeError(t, error) }))),
            }),
        h(BatchBar, { t: t, api: api, snapshot: snapshot, controller: library, folders: snapshot.folders, pushToast: push }),
      )

  const mobileBackdrop =
    narrow && snapshot.mobileLeftOpen
      ? h('button', {
          type: 'button',
          className: 'ph-leftbackdrop',
          'aria-label': t('library.sidebar.hide'),
          onClick: () => library.setMobileLeftOpen(false),
        })
      : null

  const left = h(
    'div',
    { className: 'ph-pane ph-pane--left' + (snapshot.ui.leftCollapsed ? ' ph-pane--collapsed' : '') + (snapshot.mobileLeftOpen ? ' ph-pane--mobile-open' : '') },
    h(CollectionsPane, {
      t: t,
      api: api,
      onOpenNote: (noteId) => setInlineNoteId(noteId || ''),
      snapshot: snapshot,
      controller: library,
      figuresActive: props.figuresActive,
      duplicatesActive: snapshot.filters.view === 'duplicates',
      onOpenDuplicates: () => library.setView('duplicates'),
      onOpenFigures: props.onOpenFigures,
      pushToast: push,
    }),
  )

  const right = inlineNoteId ? null : h(
    'div',
    { className: 'ph-pane ph-pane--right' + (snapshot.ui.rightCollapsed ? ' ph-pane--collapsed' : '') },
    h(DetailsPane, {
      t: t,
      snapshot: snapshot,
      controller: library,
      onOpenPaper: (paperId, page, annotationId) => openPaper(paperId, page || 1, annotationId),
      onLocateFigure: (paperId, figure) => {
        if (props.onOpenFigure) return props.onOpenFigure(paperId, figure)
        navigation.openPaper({
          paperId: paperId,
          page: (figure && figure.page) || 1,
          figureId: figure && figure.id,
          figureLabel: figure && figure.label,
          bbox: figure && figure.bbox,
          source: 'details-figure',
        })
      },
      onCite: citePaper,
      onCiteAnnotation: (annotation) => {
        api('references.commit', { items: [{ kind: 'annotation', id: annotation.id, page: annotation.page }], operationId: operationId('refs') })
          .then((result) => {
            pendingStore.add(result, [{ kind: 'annotation', id: annotation.id, page: annotation.page, title: annotation.text || annotation.quote }])
            push('success', t('toast.cited'))
          })
          .catch((error) => push('error', t('toast.citeFailed', { message: describeError(t, error) })))
      },
      onExport: exportPaper,
      onFindSimilar: props.onFindSimilar,
      onCopyCitation: copyCitation,
      onCopyCitationKey: copyCitationKey,
      onExportAnnotations: exportAnnotations,
      onUpdateMetrics: updateMetrics,
      onEditMetrics: editMetrics,
      onResetMetrics: resetMetrics,
      pushToast: push,
      tagsAvailable: snapshot.tagsAvailable,
      collectionsAvailable: snapshot.collectionsAvailable,
    }),
  )

  if (props.figuresActive) {
    return h(
      'div',
      { className: 'ph-center', ref: rootRef },
      h('div', { className: 'ph-center__body' }, props.figureContent),
      h(StatusBar, { t: t, api: api, snapshot: snapshot, library: library }),
      h(ToastStack, { toasts: toasts, onDismiss: dismiss }),
    )
  }

  return h(
    'div',
    { className: 'ph-center', ref: rootRef },
    topbar,
    h(
      'div',
      {
        className: 'ph-center__body',
        style: {
          '--ph-left-width': String((dragWidth.left != null ? dragWidth.left : snapshot.ui.leftWidth) || 232) + 'px',
          '--ph-right-width': String((dragWidth.right != null ? dragWidth.right : snapshot.ui.rightWidth) || 340) + 'px',
        },
      },
      loadingFirst
        ? h(LibrarySkeleton, { t: t })
        : h(
            React.Fragment,
            null,
            mobileBackdrop,
            left,
            h(PaneResizer, { label: t('library.resize.left'), side: 'left', width: dragWidth.left != null ? dragWidth.left : snapshot.ui.leftWidth, onDrag: (width) => setDragWidth((previous) => Object.assign({}, previous, { left: width })), onCommit: (width) => { library.setUi({ leftWidth: width }); setDragWidth((previous) => Object.assign({}, previous, { left: null })) } }),
            middle,
            h(PaneResizer, { label: t('library.resize.right'), side: 'right', width: dragWidth.right != null ? dragWidth.right : snapshot.ui.rightWidth, onDrag: (width) => setDragWidth((previous) => Object.assign({}, previous, { right: width })), onCommit: (width) => { library.setUi({ rightWidth: width }); setDragWidth((previous) => Object.assign({}, previous, { right: null })) } }),
            right,
          ),
    ),
    snapshot.filters.view === 'trash'
      ? h('div', { className: 'ph-trashbar' }, h(Icon, { name: 'info', size: 14 }), h('span', null, t('library.trash.hint')))
      : null,
    h(StatusBar, { t: t, api: api, snapshot: snapshot, library: library }),
    h(ToastStack, { toasts: toasts, onDismiss: dismiss }),
    h(FeedbackHost, null),
    h(CommandPalette, { open: paletteOpen, onClose: () => setPaletteOpen(false), t: t, commands: commands }),
    h(CitationDialog, { open: citationOpen, onClose: () => setCitationOpen(false), t: t, api: api, onInsert: insertCitation, onToast: (tone, text) => notify(tone, text) }),
    h(HelpDialog, { open: helpOpen, onClose: () => setHelpOpen(false), t: t }),
    snapshot.contextMenu
      ? h('div', { onMouseDown: (event) => event.stopPropagation() }, h(ContextMenu, { t: t, menu: snapshot.contextMenu, paper: contextPaper, library: library, collections: snapshot.collections, onOpen: openPaper, onCite: citePaper, pushToast: push, onShowDetails: () => library.setMobileLeftOpen(false) }))
      : null,
  )
}
