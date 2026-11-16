/**
 * Pappers-Hall discovery sidebar (right pane).
 *
 * Not a search + flat list: a tabbed feed with grouped papers (continue
 * reading / unread / annotated / collections), annotation streams grouped by
 * paper, a two-column figure wall, filters, selection and an engine footer.
 * Data comes from `discover.feed` / `annotations.feed`; when the Host lags the
 * client falls back to `library.list` / `search.query` aggregation (TODO: drop
 * the fallbacks once v0.4 Host is guaranteed).
 */
import React from 'react'
import { h } from '../core/dom.js'
import { Icon } from '../core/icons.jsx'
import { Badge, Button, Check, EmptyState, IconButton, SearchInput, Spinner, TabStrip, ToastStack, useToasts } from '../core/primitives.jsx'
import { describeError, isOffline } from '../core/api.js'
import { defaultApi } from '../core/api.js'
import { pendingStore } from '../core/pending.js'
import { commitReferenceBatch } from '../core/reference-actions.js'
import { navigation } from '../core/navigation.js'
import { dragProps } from '../core/dnd.js'
import { notify } from '../core/feedback.js'
import { bus } from '../core/bus.js'
import { tagColor } from '../core/tag-colors.js'
import { paperTitle, metaLine, firstText } from '../core/texts.js'
import { copyText } from '../core/files.js'
import { translationStore, providerLabel } from '../core/translation.js'
import { FolderPicker } from './library/folders.jsx'
import { ReaderShell } from './reader/shell.jsx'
import { NoteCards } from './notes/cards.jsx'
import { ensureNotesStyles } from './notes/styles.js'
import { matchSectionCards } from '../core/notes-model.js'

function opId() {
  const random = typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function' ? crypto.randomUUID() : Math.random().toString(36).slice(2)
  return 'drawer-' + random
}
/** Last Paper Center reader route, used to keep the paper beside the chat. */
function previewFromLastRoute() {
  try {
    if (typeof sessionStorage === 'undefined') return null
    const raw = sessionStorage.getItem('pappers-hall:navigation-route')
    if (!raw) return null
    const route = JSON.parse(raw)
    if (!route || route.view !== 'reader' || !route.paperId) return null
    return { kind: 'paper', paper: { id: String(route.paperId) }, page: Math.max(1, Number(route.page) || 1) }
  } catch {
    return null
  }
}

function relative(t, value) {
  if (!value) return ''
  const time = Date.parse(String(value))
  if (!Number.isFinite(time)) return ''
  const delta = Date.now() - time
  if (delta < 60000) return t('translation.justNow')
  if (delta < 3600000) return t('drawer.time.minutes', { count: Math.round(delta / 60000) })
  if (delta < 86400000) return t('drawer.time.hours', { count: Math.round(delta / 3600000) })
  return t('drawer.time.days', { count: Math.round(delta / 86400000) })
}
function thumbOf(paper) {
  return (paper && paper.thumbnailUrl) || (paper && paper.id ? '/pappers-hall/thumb/' + paper.id + '.png' : '')
}
function authorLine(authors) {
  const list = Array.isArray(authors) ? authors : []
  const names = list.map((a) => (a && (a.literal || [a.given, a.family].filter(Boolean).join(' '))) || '').filter(Boolean)
  if (names.length === 0) return ''
  return names.length > 2 ? names.slice(0, 2).join(', ') + ' et al.' : names.join(', ')
}

function Thumb(props) {
  const paperId = props.paperId
  const primary = props.src || (paperId ? '/pappers-hall/thumb/' + paperId + '.png' : '')
  const fallback = paperId ? '/pappers-hall/page/' + paperId + '/1.png?width=120' : ''
  const [step, setStep] = React.useState(primary ? 0 : fallback ? 1 : 2)
  React.useEffect(() => {
    setStep(primary ? 0 : fallback ? 1 : 2)
  }, [primary, fallback])
  const src = step === 0 ? primary : step === 1 ? fallback : ''
  if (!src || step >= 2) return h('span', { className: 'ph-side-thumb ph-side-thumb--empty' }, h(Icon, { name: props.icon || 'book', size: 16 }))
  return h(
    'span',
    { className: 'ph-side-thumb' },
    h('img', {
      src: src,
      alt: '',
      width: 48,
      height: 64,
      loading: props.eager ? 'eager' : 'lazy',
      decoding: 'async',
      draggable: false,
      style: { width: '48px', height: '64px', objectFit: 'cover', objectPosition: 'top center', background: 'var(--dsw-alias-bg-layer-3)' },
      onError: () => setStep((value) => (value === 0 && fallback ? 1 : 2)),
    }),
  )
}

function PaperRow(props) {
  const t = props.t
  const paper = props.paper
  const selected = props.selected
  const pause = props.pause
  const drag = dragProps(t, [{ kind: 'paper', id: paper.id, title: paperTitle(t, paper) }], { source: 'sidebar' })
  return h(
    'div',
    { className: 'ph-side-row ph-side-row--paper' + (selected ? ' ph-side-row--selected' : '') },
    h('span', { className: 'ph-side-row__check' }, h(Check, { checked: selected, onChange: () => props.onSelect(paper), 'aria-label': paperTitle(t, paper) })),
    h(Thumb, { src: thumbOf(paper), paperId: paper.id, eager: props.index != null && props.index < 8 }),
    h(
      'div',
      Object.assign({
        className: 'ph-side-row__main',
        onClick: () => props.onPreview(paper),
        role: 'button',
        tabIndex: 0,
        'aria-pressed': selected ? 'true' : 'false',
        onKeyDown: (event) => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); props.onPreview(paper) } },
      }, drag),
      h('div', { className: 'ph-side-row__title' }, paperTitle(t, paper)),
      paper.title && paper.title !== paperTitle(t, paper) ? h('div', { className: 'ph-side-row__original' }, paper.title) : null,
      h('div', { className: 'ph-side-row__meta' }, [authorLine(paper.authors), paper.year ? String(paper.year) : '', firstText(paper.venue, paper.containerTitle)].filter(Boolean).join(' · ')),
      h(
        'div',
        { className: 'ph-side-row__badges' },
        h('span', { className: 'ph-statusdot' + (paper.read ? ' ph-statusdot--read' : paper.readingProgress ? ' ph-statusdot--reading' : '') }),
        h('span', { className: 'ph-caption' }, paper.read ? t('page.read') : paper.readingProgress ? t('library.smart.reading') : t('library.smart.toRead')),
        Number(paper.annotationCount) > 0 ? h('span', { className: 'ph-caption' }, h(Icon, { name: 'highlighter', size: 10 }), ' ' + paper.annotationCount) : null,
        Number(paper.citationCount) > 0 ? h('span', { className: 'ph-caption' }, h(Icon, { name: 'quote', size: 10 }), ' ' + Number(paper.citationCount).toLocaleString('zh-CN')) : null,
        (paper.tags || []).slice(0, 2).map((tag) => h(Badge, { key: tag, tone: 'muted', 'data-tag-color': tagColor(tag) }, tag)),
      ),
    ),
    h(
      'div',
      { className: 'ph-side-row__actions' },
      h(IconButton, { icon: 'book', title: t('drawer.action.readHere'), onClick: () => props.onPreview(paper) }),
      h(IconButton, { icon: 'quote', title: t('drawer.action.cite'), onClick: () => props.onCite([{ kind: 'paper', id: paper.id, title: paperTitle(t, paper) }]) }),
      h(IconButton, { icon: 'panelRight', title: t('drawer.action.details'), onClick: () => props.onDetails(paper) }),
    ),
  )
}

function AnnotationRow(props) {
  const t = props.t
  const item = props.item
  return h(
    'div',
    Object.assign(
      { className: 'ph-side-annot ph-side-annot--' + (item.color || 'yellow'), title: t('drawer.dragHint') },
      dragProps(t, [{ kind: 'annotation', id: item.id, page: item.page, title: item.quote || item.comment || '' }], { source: 'sidebar' }),
    ),
    h(
      'div',
      { className: 'ph-side-annot__body' },
      h('div', { className: 'ph-side-annot__quote', title: item.quote }, item.quote || item.comment || ''),
      h(
        'div',
        { className: 'ph-side-annot__meta' },
        h('button', { type: 'button', className: 'ph-chipbtn', onClick: () => props.onOpen(item) }, t('drawer.page', { page: Number(item.page) || 1 })),
        item.kind ? h('span', { className: 'ph-caption' }, t('drawer.kind.' + item.kind)) : null,
        h('span', { className: 'ph-caption' }, relative(t, item.createdAt)),
      ),
      item.comment && item.comment !== item.quote ? h('div', { className: 'ph-side-annot__comment' }, item.comment) : null,
    ),
    h(
      'div',
      { className: 'ph-side-row__actions ph-side-row__actions--always' },
      h(IconButton, { icon: 'external', title: t('drawer.action.open'), onClick: () => props.onOpen(item) }),
      h(IconButton, { icon: 'quote', title: t('drawer.action.cite'), onClick: () => props.onCite([{ kind: 'annotation', id: item.id, page: item.page, title: item.paperTitle || item.quote }]) }),
      h(IconButton, { icon: 'copy', title: t('drawer.action.copy'), onClick: () => props.onCopy(item) }),
    ),
  )
}

export function DrawerBody(props) {
  const t = props.t
  const sessionId = props.sessionId
  const openLibrary = props.openLibrary
  const { toasts, push, dismiss } = useToasts()
  const translation = React.useSyncExternalStore(translationStore.subscribe, translationStore.getSnapshot, translationStore.getSnapshot)
  const [tab, setTab] = React.useState('papers')
  const [query, setQuery] = React.useState('')
  const [debounced, setDebounced] = React.useState('')
  const [feed, setFeed] = React.useState({ status: 'loading', data: null, error: null })
  const [annotations, setAnnotations] = React.useState({ status: 'loading', items: [], error: null, hasMore: false })
  const [notes, setNotes] = React.useState({ status: 'idle', items: [], error: null })
  const [noteTotal, setNoteTotal] = React.useState(0)
  const [revision, setRevision] = React.useState(0)
  const [filters, setFilters] = React.useState({ quick: 'all', collectionId: '', tag: '', color: '', kind: '', paperId: '' })
  const [selected, setSelected] = React.useState([])
  const [preview, setPreview] = React.useState(() => previewFromLastRoute())
  const [previewNote, setPreviewNote] = React.useState({ status: 'idle', note: null, error: null })
  const releasePreviewStyles = React.useMemo(() => ensureNotesStyles(), [])
  React.useEffect(() => () => releasePreviewStyles(), [releasePreviewStyles])
  const [collapsed, setCollapsed] = React.useState({})
  React.useEffect(() => {
    if (!preview || preview.kind !== 'note') {
      setPreviewNote({ status: 'idle', note: null, error: null })
      return undefined
    }
    let alive = true
    const noteId = preview.note && (preview.note.id || preview.note.noteId)
    if (!noteId) {
      setPreviewNote({ status: 'error', note: null, error: new Error('note id is missing') })
      return undefined
    }
    setPreviewNote({ status: 'loading', note: null, error: null })
    Promise.resolve(defaultApi('notes.get', { id: noteId }))
      .then((data) => {
        const note = data && (data.note || data)
        if (!note || !note.id) throw new Error('notes.get returned no note')
        if (alive) setPreviewNote({ status: 'ready', note, error: null })
      })
      .catch((error) => { if (alive) setPreviewNote({ status: 'error', note: null, error }) })
    return () => { alive = false }
  }, [preview])
  const scrollPositions = React.useRef({})
  const scrollRef = React.useRef(null)
  const searchRef = React.useRef(null)
  const selectedKeys = new Set(selected.map((item) => item.kind + ':' + item.id))

  React.useEffect(() => {
    const timer = setTimeout(() => setDebounced(query.trim()), 260)
    return () => clearTimeout(timer)
  }, [query])

  React.useEffect(() => {
    const onKey = (event) => {
      if ((event.metaKey || event.ctrlKey) && String(event.key).toLowerCase() === 'f') {
        event.preventDefault()
        const input = (searchRef.current && searchRef.current.querySelector && searchRef.current.querySelector('input')) || document.querySelector('.ph-sidebar__search input')
        if (input) input.focus()
      }
      if (event.key === 'Escape' && document.activeElement === (searchRef.current && searchRef.current.querySelector('input'))) {
        setQuery('')
      }
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [])

  React.useEffect(() => {
    translationStore.refresh().catch(() => {})
  }, [])

  // Keep the discovery feed fresh while the sidebar stays open (new imports,
  // verifier fixtures, annotations) without blocking interaction.
  React.useEffect(() => {
    const timer = setInterval(() => setRevision((value) => value + 1), 30000)
    return () => clearInterval(timer)
  }, [])

  // Per-tab scroll position survives tab switches.
  const changeTab = React.useCallback((next) => {
    const node = scrollRef.current
    if (node) scrollPositions.current[tab] = node.scrollTop
    setTab(next)
    if (node) {
      requestAnimationFrame(() => {
        if (scrollRef.current) scrollRef.current.scrollTop = scrollPositions.current[next] || 0
      })
    }
  }, [tab])

  React.useEffect(() => {
    let alive = true
    Promise.resolve(defaultApi('notes.list', { limit: 1 }))
      .then((value) => { if (alive) setNoteTotal(Number(value && value.total) || 0) })
      .catch(() => {})
    return () => { alive = false }
  }, [revision])

  /* ---------------------------------------------------------------- feeds */
  React.useEffect(() => {
    let alive = true
    setFeed((previous) => ({ status: previous.data ? 'refreshing' : 'loading', data: previous.data, error: null }))
    const previousFeedData = feed.data
    const load = async () => {
      const hasFilters = Boolean(debounced || filters.quick !== 'all' || filters.collectionId || filters.tag || filters.folderId || filters.favorite || (Array.isArray(filters.tags) && filters.tags.length > 0))
      // Always refresh the global discovery feed: it owns tab counts, folder/tag
      // option lists and recent figures. A filtered request only replaces the
      // paper sections, so the folder picker never collapses to "all folders"
      // after one selection.
      let globalFeed = null
      try {
        globalFeed = await defaultApi('discover.feed', { limit: 5 })
      } catch (error) {
        globalFeed = null
      }
      if (!alive) return
      if (!hasFilters) {
        if (globalFeed) { setFeed({ status: 'ready', data: globalFeed, error: null }); return }
      }
      const params = { state: 'active', sort: 'recent', limit: 30 }
      if (debounced) params.query = debounced
      if (filters.quick === 'unread') params.read = false
      if (filters.quick === 'reading') params.reading = 'reading'
      if (filters.quick === 'annotated') params.annotated = true
      if (filters.favorite) params.favorite = true
      if (filters.folderId) params.folderId = filters.folderId
      const tagList = Array.isArray(filters.tags) && filters.tags.length > 0 ? filters.tags : (filters.tag ? [filters.tag] : [])
      if (tagList.length > 0) { params.tags = tagList; params.tag = tagList[0] }
      if (Array.isArray(filters.tags) && filters.tags.length > 0) params.tags = filters.tags.slice()
      if (filters.collectionId) params.collectionId = filters.collectionId
      if (filters.tag) params.tag = filters.tag
      try {
        const value = await defaultApi('library.list', params)
        const items = Array.isArray(value && value.items) ? value.items : []
        const global = globalFeed || (previousFeedData && previousFeedData) || {}
        const stats = Object.assign({}, (global && global.stats) || {}, {
          filtered: Number(value && value.total) || items.length,
        })
        const data = {
          ...global,
          stats,
          continueReading: items.filter((p) => !p.read).slice(0, 5),
          unread: items.filter((p) => !p.read).slice(0, 5),
          annotated: items.filter((p) => Number(p.annotationCount) > 0).slice(0, 5),
          folders: (global && global.folders) || [],
          folderTree: (global && (global.folderTree || global.folders)) || [],
          collections: (global && global.collections) || [],
          tags: (global && global.tags) || [],
          recentAnnotations: (global && global.recentAnnotations) || [],
          recentFigures: (global && global.recentFigures) || [],
          favorite: (global && global.favorite) || [],
          degraded: false,
        }
        if (alive) setFeed({ status: 'ready', data: data, error: null })
      } catch (error) {
        if (alive) setFeed({ status: 'error', data: null, error: error })
      }
    }
    load()
    return () => { alive = false }
  }, [debounced, filters.quick, filters.collectionId, filters.tag, filters.folderId, filters.favorite, filters.tags, revision])

  React.useEffect(() => {
    if (tab !== 'annotations') return undefined
    let alive = true
    setAnnotations((previous) => ({ status: 'loading', items: previous.items, error: null, hasMore: previous.hasMore }))
    const params = { limit: 40 }
    if (debounced) params.query = debounced
    if (filters.folderId) params.folderId = filters.folderId
    const feedTags = Array.isArray(filters.tags) && filters.tags.length > 0 ? filters.tags : (filters.tag ? [filters.tag] : [])
    if (feedTags.length > 0) params.tags = feedTags
    if (filters.color) params.colors = [filters.color]
    if (filters.kind) params.kinds = [filters.kind]
    if (filters.paperId) params.paperId = filters.paperId
    if (filters.folderId) params.folderId = filters.folderId
    if (Array.isArray(filters.tags) && filters.tags.length > 0) params.tags = filters.tags.slice()
    defaultApi('annotations.feed', params)
      .then((value) => {
        if (!alive) return
        const items = Array.isArray(value && value.items) ? value.items : []
        setAnnotations({ status: 'ready', items: items, error: null, hasMore: Boolean(value && value.hasMore) })
      })
      .catch((error) => {
        // TODO(v0.4): drop the search.query fallback once annotations.feed always exists.
        defaultApi('search.query', { q: debounced || ' ', scope: 'annotations', limit: 40 })
          .then((value) => { if (alive) setAnnotations({ status: 'ready', items: Array.isArray(value && value.items) ? value.items : [], error: null, hasMore: false, degraded: true }) })
          .catch(() => { if (alive) setAnnotations({ status: 'error', items: [], error: error, hasMore: false }) })
      })
    return () => { alive = false }
  }, [tab, debounced, filters.color, filters.kind, filters.paperId, filters.folderId, filters.tags, revision])

  React.useEffect(() => {
    if (tab !== 'notes') return undefined
    let alive = true
    setNotes({ status: 'loading', items: [], error: null })
    const scopedFolderId = filters.folderId || ''
    const scopedTags = Array.isArray(filters.tags) ? filters.tags.slice() : []
    const hasFolderScope = Boolean(scopedFolderId || scopedTags.length > 0)
    const load = async () => {
      let allowed = null
      if (hasFolderScope) {
        try {
          const value = await defaultApi('library.list', {
            state: 'active',
            limit: 500,
            ...(scopedFolderId ? { folderId: scopedFolderId } : {}),
            ...(scopedTags.length > 0 ? { tags: scopedTags } : {}),
          })
          allowed = new Set((Array.isArray(value && value.items) ? value.items : []).map((paper) => paper && paper.id).filter(Boolean))
        } catch (error) {
          allowed = new Set()
        }
      }
      try {
        // v0.22: the conversation drawer reads the notes workbench (note_docs),
        // not the legacy `search.query scope:'notes'` paper snippets.
        const value = debounced
          ? await defaultApi('notes.search', { q: debounced, limit: 30 })
          : await defaultApi('notes.list', { limit: 30 })
        if (!alive) return
        const items = (Array.isArray(value && value.items) ? value.items : []).map((note) => ({
          id: note.id || note.noteId,
          title: note.title || '',
          preview: note.preview || note.snippet || '',
          folder: note.folder || null,
          paperIds: Array.isArray(note.paperIds) ? note.paperIds : [],
          updatedAt: note.updatedAt,
        }))
        setNotes({ status: 'ready', items, error: null, total: Number(value && value.total) || items.length, filtered: hasFolderScope })
      } catch (error) {
        if (alive) setNotes({ status: 'error', items: [], error: error })
      }
    }
    load()
    return () => { alive = false }
  }, [tab, debounced, filters.folderId, filters.tags, revision])

  /* -------------------------------------------------------------- actions */
  const openItem = React.useCallback((target, page, annotationId) => {
    const paperId = target && (target.paperId || target.id)
    if (!paperId) return
    navigation.openPaper({ paperId: paperId, page: page || target.page || 1, annotationId: annotationId || (target.kind === 'annotation' ? target.id : null), source: 'sidebar' })
    if (openLibrary) openLibrary()
  }, [openLibrary])

  const openPreview = React.useCallback((item) => {
    if (!item) return
    if (item.kind === 'note' || String(item.id || '').startsWith('note-')) setPreview({ kind: 'note', note: item.note || item })
    else setPreview({ kind: 'paper', paper: item, page: 1 })
  }, [])

  const cite = React.useCallback((materials) => {
    const list = (Array.isArray(materials) ? materials : [materials]).filter(Boolean)
    if (list.length === 0) return
    commitReferenceBatch(list, { sessionId, operationId: opId() })
      .then(({ result, created }) => {
        // Appending to the existing set has no safe single-item undo; only a
        // freshly created bundle exposes undo. The dock handles removal.
        notify('success', t('toast.cited'), created ? { label: t('common.undo'), onClick: () => pendingStore.remove(result.bundleId) } : null, 2600)
      })
      .catch((error) => push('error', t('drawer.submitFailed', { message: describeError(t, error) })))
  }, [push, sessionId, t])

  const citeSelection = () => {
    if (selected.length === 0) return
    cite(selected)
    setSelected([])
  }

  const openLibraryView = (view) => {
    if (openLibrary) openLibrary()
    bus.emit('open-library-view', { view: view })
  }
  const openLibraryPaper = (paper) => {
    if (openLibrary) openLibrary()
    bus.emit('open-library-paper', { paperId: paper.id })
  }
  // v0.22: open the note inside the paper library (inline editor + paper panel).
  const openNotesLibrary = (noteId) => {
    if (openLibrary) openLibrary()
    navigation.openNotes({ noteId: noteId || null })
  }

  const toggleSelect = (item) => {
    const key = item.kind + ':' + item.id
    setSelected((previous) => (previous.some((entry) => entry.kind + ':' + entry.id === key) ? previous.filter((entry) => entry.kind + ':' + entry.id !== key) : previous.concat([item])))
  }

  /* ------------------------------------------------------------ rendering */
  const stats = (feed.data && feed.data.stats) || {}
  const recentFigures = (feed.data && feed.data.recentFigures) || []
  const recentAnnotations = (feed.data && feed.data.recentAnnotations) || []
  const counts = {
    papers: stats.papers != null ? stats.papers : (feed.data && feed.data.unread ? feed.data.unread.length : 0),
    annotations: stats.annotations != null ? stats.annotations : annotations.items.length || recentAnnotations.length,
    figures: stats.figures != null ? stats.figures : recentFigures.length,
    notes: noteTotal || (stats.noteDocs != null ? Number(stats.noteDocs) || 0 : 0) || notes.items.length || recentAnnotations.filter((item) => item && item.kind === 'note').length,
  }
  const tabs = [
    { id: 'papers', label: t('drawer.tab.papers'), count: counts.papers },
    { id: 'annotations', label: t('drawer.tab.annotations'), count: counts.annotations },
    { id: 'notes', label: t('drawer.tab.notes'), count: counts.notes },
  ]
  const groups = feed.data
    ? [
        { id: 'continueReading', label: t('drawer.group.continueReading'), items: feed.data.continueReading || [], view: 'recentRead' },
        { id: 'unread', label: t('drawer.group.unread'), items: feed.data.unread || [], view: 'toRead' },
        { id: 'annotated', label: t('drawer.group.annotated'), items: feed.data.annotated || [], view: 'annotated' },
        { id: 'favorite', label: t('drawer.group.collections'), items: feed.data.favorite || [], view: 'favorite' },
      ]
    : []
  const collections = (feed.data && feed.data.collections) || []
  const tags = (feed.data && feed.data.tags) || []
  const selectedPapers = selected.filter((item) => item.kind === 'paper')

  const chip = (id, label, extra) => h('button', { key: id, type: 'button', className: 'ph-fchip' + (filters.quick === id ? ' ph-fchip--active' : ''), onClick: () => setFilters(Object.assign({}, filters, { quick: id })) }, label, extra != null ? h('span', { className: 'ph-fchip__count' }, String(extra)) : null)
  const filterBar = h(
    'div',
    { className: 'ph-side-filters' },
    chip('all', t('drawer.filter.all')),
    chip('unread', t('library.smart.toRead'), stats.unread),
    chip('reading', t('library.smart.reading')),
    h('button', { key: 'fav', type: 'button', className: 'ph-fchip' + (filters.favorite ? ' ph-fchip--active' : ''), onClick: () => setFilters(Object.assign({}, filters, { favorite: !filters.favorite })) }, h(Icon, { name: 'star', size: 10 }), t('folders.favorite')),
    h(FolderPicker, { t: t, folders: { items: (feed.data && (feed.data.folders || feed.data.folderTree)) || [] }, value: filters.folderId || '', allowAll: true, className: 'ph-select--inline', label: t('folders.filterLabel'), onChange: (id) => setFilters(Object.assign({}, filters, { folderId: id || '' })) }),
    chip('annotated', t('library.smart.annotated'), stats.annotations),
    h(
      'select',
      { className: 'ph-select ph-select--inline', value: filters.tag, 'aria-label': t('drawer.filter.tag'), onChange: (event) => setFilters(Object.assign({}, filters, { tag: event.target.value, tags: event.target.value ? [event.target.value] : [] })) },
      h('option', { value: '' }, t('drawer.filter.tag')),
      tags.map((tag) => h('option', { key: tag.name, value: tag.name }, tag.name + ' (' + tag.count + ')')),
    ),
    filters.quick !== 'all' || filters.collectionId || filters.tag || filters.folderId || filters.favorite ? h(IconButton, { icon: 'close', title: t('drawer.filter.clear'), onClick: () => setFilters({ quick: 'all', collectionId: '', tag: '', tags: [], color: '', kind: '', paperId: '', folderId: '', favorite: false }) }) : null,
  )

  let body = null
  if (tab === 'papers') {
    if (feed.status === 'loading' && !feed.data) body = h('div', { className: 'ph-side-skeleton' }, [0, 1, 2, 3].map((i) => h('div', { key: i, className: 'ph-side-skeleton__row' }, h('span', { className: 'ph-skeleton', style: { width: 40, height: 54 } }), h('div', { className: 'ph-side-skeleton__main' }, h('span', { className: 'ph-skeleton', style: { width: '72%' } }), h('span', { className: 'ph-skeleton', style: { width: '46%', height: 9 } })))))
    else if (feed.status === 'error') body = h(EmptyState, { compact: true, tone: isOffline(feed.error) ? 'warning' : 'error', icon: 'warning', title: isOffline(feed.error) ? t('drawer.offline') : t('drawer.loadFailed', { message: describeError(t, feed.error) }), action: h(Button, { size: 'sm', variant: 'secondary', icon: 'refresh', onClick: () => setRevision((v) => v + 1) }, t('common.retry')) })
    else {
      const nonEmpty = groups.filter((group) => group.items.length > 0)
      if (nonEmpty.length === 0 && collections.length === 0) body = h(EmptyState, { compact: true, icon: 'search', title: t('drawer.empty.title'), desc: t('drawer.empty.desc'), action: h(Button, { size: 'sm', variant: 'primary', icon: 'book', onClick: () => openLibraryView('all') }, t('drawer.empty.openLibrary')) })
      else body = h(
        'div',
        { className: 'ph-side-groups' },
        nonEmpty.map((group) => h(
          'section',
          { key: group.id, className: 'ph-side-group' },
          h('div', { className: 'ph-side-group__head' },
            h('span', { className: 'ph-side-group__title' }, group.label, h('span', { className: 'ph-caption' }, String(group.items.length))),
            h('button', { type: 'button', className: 'ph-linkbtn', onClick: () => openLibraryView(group.view) }, t('drawer.group.viewAll') + ' →'),
          ),
          group.items.slice(0, 6).map((paper, index) => h(PaperRow, { key: group.id + ':' + paper.id, t: t, paper: paper, index: index, selected: selectedKeys.has('paper:' + paper.id), onSelect: () => toggleSelect({ kind: 'paper', id: paper.id }), onPreview: openPreview, onOpen: (p, page) => openItem(p, page), onCite: cite, onDetails: openLibraryPaper })),
        )),
        collections.length > 0 ? h('section', { className: 'ph-side-group' },
          h('div', { className: 'ph-side-group__head' }, h('span', { className: 'ph-side-group__title' }, t('drawer.group.collections')), h('button', { type: 'button', className: 'ph-linkbtn', onClick: () => openLibraryView('all') }, t('drawer.group.viewAll') + ' →')),
          h('div', { className: 'ph-side-collections' }, collections.map((collection) => h('button', { key: collection.id, type: 'button', className: 'ph-side-collection', onClick: () => { setFilters(Object.assign({}, filters, { collectionId: collection.id })); openLibraryView('all') } }, h('span', { className: 'ph-collection__dot', 'data-color': collection.color || 'blue' }), h('span', { className: 'ph-side-collection__name' }, collection.name), h('span', { className: 'ph-caption' }, String(collection.count))))),
        ) : null,
      )
    }
  } else if (tab === 'annotations') {
    const items = annotations.items
    const byPaper = new Map()
    items.forEach((item) => {
      const key = item.paperId || 'unknown'
      if (!byPaper.has(key)) byPaper.set(key, { paperTitle: item.paperTitle || '', items: [] })
      byPaper.get(key).items.push(item)
    })
    body = annotations.status === 'loading' && items.length === 0
      ? h('div', { className: 'ph-side-skeleton' }, [0, 1, 2].map((i) => h('div', { key: i, className: 'ph-side-skeleton__row' }, h('span', { className: 'ph-skeleton', style: { width: 3, height: 46 } }), h('div', { className: 'ph-side-skeleton__main' }, h('span', { className: 'ph-skeleton', style: { width: '80%' } }), h('span', { className: 'ph-skeleton', style: { width: '40%', height: 9 } })))))
      : annotations.status === 'error'
        ? h(EmptyState, { compact: true, tone: 'error', icon: 'warning', title: t('drawer.loadFailed', { message: describeError(t, annotations.error) }), action: h(Button, { size: 'sm', variant: 'secondary', icon: 'refresh', onClick: () => setRevision((v) => v + 1) }, t('common.retry')) })
        : items.length === 0
          ? h(EmptyState, { compact: true, icon: 'highlighter', title: t('drawer.hint.annotations') })
          : h('div', { className: 'ph-side-annotgroups' },
              h('div', { className: 'ph-side-annotfilters' },
                h('select', { className: 'ph-select ph-select--inline', value: filters.color, onChange: (e) => setFilters(Object.assign({}, filters, { color: e.target.value })) }, h('option', { value: '' }, t('drawer.filter.color')), ['yellow', 'green', 'blue', 'red', 'purple'].map((c) => h('option', { key: c, value: c }, t('reader.annot.color.' + c)))),
                h('select', { className: 'ph-select ph-select--inline', value: filters.kind, onChange: (e) => setFilters(Object.assign({}, filters, { kind: e.target.value })) }, h('option', { value: '' }, t('drawer.filter.kind')), ['highlight', 'area', 'note'].map((k) => h('option', { key: k, value: k }, t('drawer.kind.' + k)))),
              ),
              Array.from(byPaper.entries()).map(([paperId, group]) => h(
                'section',
                { key: paperId, className: 'ph-annotgroup' },
                h('button', { type: 'button', className: 'ph-annotgroup__head', onClick: () => setCollapsed(Object.assign({}, collapsed, { [paperId]: !collapsed[paperId] })), 'aria-expanded': collapsed[paperId] ? 'false' : 'true' },
                  h(Icon, { name: collapsed[paperId] ? 'chevronRight' : 'chevronDown', size: 12 }),
                  h('span', { className: 'ph-annotgroup__title' }, group.paperTitle || paperId),
                  h('span', { className: 'ph-caption' }, String(group.items.length)),
                ),
                collapsed[paperId] ? null : group.items.map((item) => h(AnnotationRow, { key: item.id, t: t, item: item, onOpen: (entry) => openItem({ paperId: entry.paperId, page: entry.page }, entry.page, entry.id), onCite: cite, onCopy: (entry) => copyText(entry.quote || entry.comment || '').then((ok) => push(ok ? 'success' : 'warning', ok ? t('common.copied') : t('common.unavailable'))) })),
              )),
            )
    body = h('div', null, filterBar, body)
  } else {
    body = notes.status === 'loading'
      ? h('div', { className: 'ph-side-skeleton' }, [0, 1, 2].map((i) => h('div', { key: i, className: 'ph-side-skeleton__row' }, h('span', { className: 'ph-skeleton', style: { width: 3, height: 40 } }), h('div', { className: 'ph-side-skeleton__main' }, h('span', { className: 'ph-skeleton', style: { width: '80%' } })))))
      : notes.status === 'error'
        ? h(EmptyState, { compact: true, tone: 'error', icon: 'warning', title: t('drawer.loadFailed', { message: describeError(t, notes.error) }) })
        : notes.items.length === 0
          ? h(EmptyState, { compact: true, icon: 'note', title: t('drawer.hint.notes'), action: h(Button, { size: 'sm', variant: 'secondary', icon: 'note', onClick: () => openNotesLibrary() }, t('notes.library.open')) })
          : h('div', { className: 'ph-side-notes' }, notes.items.map((note, index) => {
              const selectedNote = selectedKeys.has('note:' + note.id)
              return h('div', Object.assign(
                {
                  key: note.id || index,
                  className: 'ph-side-note' + (selectedNote ? ' ph-side-note--selected' : ''),
                  role: 'button',
                  tabIndex: 0,
                  onClick: () => openPreview({ kind: 'note', note: note }),
                  onKeyDown: (event) => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); openPreview({ kind: 'note', note: note }) } },
                  title: note.title || t('notes.untitled'),
                },
                dragProps(t, [{ kind: 'note', id: note.id, title: note.title || t('notes.untitled') }], { source: 'sidebar' }),
              ),
                h('span', { className: 'ph-side-row__check', onClick: (event) => event.stopPropagation() }, h(Check, { checked: selectedNote, onChange: () => toggleSelect({ kind: 'note', id: note.id, title: note.title || t('notes.untitled') }) })),
                h(Icon, { name: 'note', size: 13 }),
                h('span', { className: 'ph-side-note__main' },
                  h('span', { className: 'ph-side-note__title' }, note.title || t('notes.untitled')),
                  h('span', { className: 'ph-side-note__preview' }, (note.preview || '').replace(/\s+/g, ' ').slice(0, 90) || t('notes.empty.preview')),
                ),
                h(IconButton, {
                  icon: 'external',
                  size: 13,
                  title: t('drawer.openNote'),
                  onClick: (event) => { event.stopPropagation(); openNotesLibrary(note.id) },
                }),
              )
            }))
  }

  if (preview !== null) {
    const previewTitle = preview.kind === 'paper'
      ? paperTitle(t, preview.paper || {})
      : firstText(preview.note && preview.note.title, t('notes.untitled'))
    const jumpCenter = () => {
      const target = preview
      setPreview(null)
      if (target.kind === 'paper') openItem(target.paper, target.page || 1)
      else openNotesLibrary(target.note && target.note.id)
    }
    let previewBody = null
    if (preview.kind === 'paper') {
      previewBody = h(ReaderShell, {
        t: t,
        api: defaultApi,
        page: preview.page || 1,
        initialPage: preview.page || 1,
        paperId: preview.paper && preview.paper.id,
        paper: preview.paper,
        sessionId: sessionId,
        onBack: jumpCenter,
        onOpenPaper: (paperId, page) => { if (paperId) setPreview({ kind: 'paper', paper: { id: paperId }, page: page || 1 }) },
        onOpenSettings: () => bus.emit('open-settings'),
      })
    } else if (previewNote.status === 'ready') {
      const note = previewNote.note
      const rows = matchSectionCards(note.contentMd || '', note.contentJson).sections
      const noteData = note.contentJson && note.contentJson.data ? note.contentJson.data : {}
      previewBody = h(
        'article',
        Object.assign(
          { className: 'ph-side-note-preview', title: t('drawer.dragHint') },
          dragProps(t, [{ kind: 'note', id: note.id, title: firstText(note.title, t('notes.untitled')) }], { source: 'sidebar' }),
        ),
        h('h2', { className: 'ph-side-note-preview__title' }, firstText(note.title, t('notes.untitled'))),
        note.paperLinks && note.paperLinks.length > 0
          ? h('div', { className: 'ph-side-note-preview__papers' }, note.paperLinks.map((link) => h('button', { key: link.paperId, type: 'button', className: 'ph-side-note-preview__paper', onClick: () => setPreview({ kind: 'paper', paper: { id: link.paperId, title: link.title, titleZh: link.titleZh }, page: 1 }) }, h(Icon, { name: 'book', size: 11 }), firstText(link.titleZh, link.title, link.paperId))))
          : null,
        h(NoteCards, {
          t: t,
          rows: rows,
          data: noteData,
          onOpenFigure: (paperId, page) => { if (paperId) setPreview({ kind: 'paper', paper: { id: paperId }, page: page || 1 }) },
        }),
      )
    } else if (previewNote.status === 'error') {
      previewBody = h(EmptyState, { compact: true, tone: 'error', icon: 'warning', title: t('drawer.preview.failed'), desc: describeError(t, previewNote.error) })
    } else {
      previewBody = h('div', { className: 'ph-side-preview__loading' }, h(Spinner, { size: 14 }), t('drawer.preview.loading'))
    }
    return h(
      'div',
      { className: 'ph-sidebar ph-sidebar--preview' },
      h(
        'div',
        { className: 'ph-side-preview__head' },
        h(IconButton, { icon: 'arrowLeft', title: t('drawer.preview.back'), onClick: () => setPreview(null) }),
        h('span', { className: 'ph-side-preview__title', title: previewTitle }, previewTitle),
        h(Button, { size: 'sm', variant: 'secondary', icon: 'external', onClick: jumpCenter }, t('drawer.preview.openCenter')),
        h(IconButton, { icon: 'close', title: t('drawer.preview.close'), onClick: () => setPreview(null) }),
      ),
      h('div', { className: 'ph-side-preview__body' }, previewBody),
    )
  }

  return h(
    'div',
    { className: 'ph-sidebar' },
    h(
      'div',
      { className: 'ph-sidebar__head' },
      h('span', { className: 'ph-sidebar__title' }, h(Icon, { name: 'book', size: 15 }), 'Pappers-Hall'),
      h(IconButton, { icon: 'settings', title: t('settings.open'), 'aria-label': t('settings.open'), onClick: () => bus.emit('open-settings') }),
      h(IconButton, { icon: 'refresh', title: t('page.refresh'), onClick: () => setRevision((value) => value + 1) }),
      h('span', { className: 'ph-caption ph-sidebar__engine' }, providerLabel(t, translation.settings.provider)),
    ),
    h('div', { className: 'ph-sidebar__search' }, h(SearchInput, { ref: searchRef, value: query, onChange: setQuery, placeholder: t('drawer.search.placeholder'), 'aria-label': t('drawer.search.placeholder'), clearLabel: t('common.clear') })),
    h('div', { className: 'ph-sidebar__tabs' }, h(TabStrip, { items: tabs, value: tab, onChange: changeTab, variant: 'pill', 'aria-label': t('drawer.title') })),
    filterBar,
    h('div', { className: 'ph-sidebar__body ph-scroll', ref: scrollRef }, body),
    h(
      'div',
      { className: 'ph-sidebar__foot' },
      selected.length > 0
        ? h(React.Fragment, null,
            h('span', { className: 'ph-caption' }, t('drawer.selected', { count: selected.length })),
            h(Button, { size: 'sm', variant: 'primary', icon: 'quote', onClick: citeSelection }, t('drawer.cite')),
            h(Button, { size: 'sm', icon: 'external', onClick: () => openLibraryView('all') }, t('drawer.openLibrary')),
            h(IconButton, { icon: 'close', title: t('common.clear'), onClick: () => setSelected([]) }),
          )
        : h(React.Fragment, null,
            h('span', { className: 'ph-caption' }, t('drawer.stats', { papers: counts.papers, annotations: counts.annotations, figures: counts.figures })),
            h('span', { className: 'ph-spacer' }),
            h(Button, { size: 'sm', variant: 'ghost', icon: 'note', onClick: () => openNotesLibrary() }, t('notes.library.open')),
            h(Button, { size: 'sm', variant: 'ghost', icon: 'book', onClick: () => openLibraryView('all') }, t('drawer.openLibrary')),
          ),
    ),
    h(ToastStack, { toasts: toasts, onDismiss: dismiss }),
  )
}
