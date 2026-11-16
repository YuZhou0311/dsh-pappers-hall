/**
 * ReaderShell — the v0.2 reader surface.
 *
 * Owns all reader state and data flow, and composes the specialised pieces:
 *   toolbar · thumbnail rail · virtualised page canvas · side panel
 *   (outline / annotations / paragraph bilingual / AI assistant)
 *
 * Integration (client/src/surfaces/center.jsx):
 *   <ReaderShell t api pending paperId initialPage onBack onToast sessionId paper />
 *
 * Host methods used: reader.open, reader.page, reader.layer, reader.outline,
 * annotations.list/create/update/delete, translate.blocks, translate.text,
 * ai.status (via panel), ai.ask (via panel), references.commit, library.setRead.
 * Every read degrades to an honest local state when the Host half lags behind
 * the v0.2 contract (pages without `blocks`/`layer`, missing AI, missing
 * translation, missing references.commit, offline API).
 */
import React from 'react'
import { ensureReaderStyles } from './styles.js'
import { AiPanel } from './ai-panel.jsx'
import { useReaderUndo } from './undo.js'
import {
  engineBadge,
  engineTitle,
  isProbablyChinese,
  providerLabel,
  readEngine,
  useTranslationPreference,
} from './engines.js'
import { AnnotationListPanel } from './annotation-layer.jsx'
import { BilingualPanel } from './bilingual.jsx'
import { FloatingAnnotationTools } from './floating-tools.jsx'
import { ReaderNotesPanel } from './notes-panel.jsx'
import { ReaderFiguresPanel } from './figures-panel.jsx'
import { getNoteContext, subscribeNoteContext } from '../../core/note-context.js'
import { commitReferenceBatch } from '../../core/reference-actions.js'
import { Outline } from './outline.jsx'
import { readFlag, writeFlag } from '../../core/notes-model.js'
import { SlidingThumb, useSlidingThumb } from '../../core/motion.js'
import { PageCanvas } from './page-canvas.jsx'
import { ReaderToolbar } from './toolbar.jsx'
import { Thumbnails } from './thumbnails.jsx'
import {
  Btn,
  Empty,
  Icon,
  IconBtn,
  Spinner,
  Tabs,
  ZOOM_MAX,
  ZOOM_MIN,
  ZOOM_STEP,
  arrayOf,
  buildReaderT,
  clamp,
  clearNativeSelection,
  copyText,
  createApiCaller,
  cx,
  describeError,
  findBlockMatches,
  findLayerMatches,
  firstText,
  looksLikePageMetadata,
  isOfflineError,
  makeApiError,
  newOperationId,
  assessTranslationReliability,
  normalizeAnnotation,
  normalizeAnnotations,
  normalizeRect,
  normalizeRectsForRequest,
  num,
  randomId,
  readReadingPosition,
  saveReadingPosition,
  useAsync,
  usePrefersReducedMotion,
} from './shared.jsx'

/** Side-panel tab ids in display order (v0.17: bilingual tab removed). */
const SIDE_TABS = ['outline', 'annotations', 'notes', 'ai']
/** One-shot first-run hint flag for the floating annotation tools. */
const TOOLS_TIP_FLAG = 'reader.tools.tip.v1'
/** Empty annotation list reused when a page has none. */
const NO_ANNOTATIONS = []
/** Annotation colour used when the user has not picked one yet. */
const DEFAULT_COLOR = 'yellow'

/* -------------------------------------------------------------------------- */
/* Local toast helper                                                          */
/* -------------------------------------------------------------------------- */

/**
 * Route notices through the slotted `onToast` when provided, otherwise render a
 * local stack so a bare ReaderShell (tests, storybook) still tells the user what
 * happened.
 */
function useReaderNotices(onToast) {
  const [toasts, setToasts] = React.useState([])
  const timers = React.useRef(new Map())
  const external = typeof onToast === 'function'

  React.useEffect(() => {
    const pending = timers.current
    return () => {
      pending.forEach((timer) => clearTimeout(timer))
      pending.clear()
    }
  }, [])

  const notify = React.useCallback(
    (kind, text, action) => {
      const message = String(text || '')
      if (!message) return
      if (external && !action) {
        try {
          onToast(kind || 'info', message)
        } catch {
          /* a broken host toast must not break the reader */
        }
        return
      }
      const id = randomId()
      setToasts((previous) =>
        previous
          .concat([{
            id,
            kind: kind || 'info',
            text: message,
            action: action && typeof action.onClick === 'function' ? { label: String(action.label || ''), onClick: action.onClick } : null,
          }])
          .slice(-4),
      )
      // Actionable toasts stay a little longer so “撤销” can be clicked.
      const ttl = action ? 9000 : 4800
      const timer = setTimeout(() => {
        setToasts((previous) => previous.filter((toast) => toast.id !== id))
        timers.current.delete(id)
      }, ttl)
      timers.current.set(id, timer)
    },
    [external, onToast],
  )
  const dismiss = React.useCallback((id) => {
    setToasts((previous) => previous.filter((toast) => toast.id !== id))
  }, [])
  return { notify, toasts, dismiss, external }
}

/* -------------------------------------------------------------------------- */
/* Tiny state screens                                                          */
/* -------------------------------------------------------------------------- */

function StateScreen(props) {
  return React.createElement(
    'div',
    { className: 'ph-r-reader' },
    React.createElement(
      'div',
      { className: 'ph-r-toolbar' },
      React.createElement(
        'div',
        { className: 'ph-r-toolbar__row ph-r-toolbar__row--main' },
        React.createElement(Btn, { size: 'sm', variant: 'ghost', icon: 'arrowLeft', onClick: props.onBack }, props.t('reader.back')),
      ),
    ),
    React.createElement(
      'div',
      { style: { flex: '1 1 auto', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 24 } },
      props.loading
        ? React.createElement(
            'div',
            { style: { display: 'flex', alignItems: 'center', gap: 10, color: 'var(--dsw-alias-label-secondary)' }, role: 'status' },
            React.createElement(Spinner, { size: 16 }),
            React.createElement('span', null, props.t('reader.loading')),
          )
        : React.createElement(Empty, {
            icon: props.icon || 'warning',
            tone: props.tone,
            title: props.title,
            desc: props.desc,
            action: props.retry
              ? React.createElement(Btn, { size: 'sm', variant: 'soft', icon: 'refresh', onClick: props.retry }, props.t('reader.retry'))
              : null,
          }),
    ),
  )
}

/* -------------------------------------------------------------------------- */
/* Shell                                                                       */
/* -------------------------------------------------------------------------- */

/** Subscribe to the optional `navigation` singleton without hard-failing. */
function useNavigationSnapshot(navigation) {
  const subscribe = React.useCallback(
    (listener) => (navigation && typeof navigation.subscribe === 'function' ? navigation.subscribe(listener) : () => {}),
    [navigation],
  )
  const getSnapshot = React.useCallback(
    () => (navigation && typeof navigation.getSnapshot === 'function' ? navigation.getSnapshot() : null),
    [navigation],
  )
  return React.useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
}

/** Normalise one annotation payload for the outgoing Host request. */
function annotationRequest(base, draft) {
  const rects = arrayOf(draft.rects).map(normalizeRect).filter(Boolean)
  const params = {
    paperId: base.paperId,
    page: Math.max(1, Math.round(num(draft.page, base.page, 1))),
    kind: draft.kind || 'highlight',
    rects,
    color: draft.color || DEFAULT_COLOR,
    origin: draft.origin || 'user_note',
    operationId: newOperationId('annot'),
  }
  if (base.versionId) params.versionId = base.versionId
  const quote = firstText(draft.quote)
  const comment = firstText(draft.comment)
  if (quote) params.quote = quote
  if (comment) params.comment = comment
  if (params.kind === 'note' && rects.length === 0) return params
  return params
}

/**
 * Error boundary around the whole reader: a render crash keeps the rest of the
 * Paper Center alive and offers a local retry (the v0.1 behaviour).
 */
class ReaderBoundary extends React.Component {
  constructor(props) {
    super(props)
    this.state = { error: null, epoch: 0 }
    this.retry = this.retry.bind(this)
  }

  static getDerivedStateFromError(error) {
    return { error }
  }

  componentDidCatch(error, info) {
    console.error('[pappers-hall] reader crashed', error, info)
  }

  retry() {
    this.setState((previous) => ({ error: null, epoch: previous.epoch + 1 }))
  }

  render() {
    if (this.state.error) {
      const rt = this.props.t
      return React.createElement(StateScreen, {
        t: rt,
        icon: 'warning',
        tone: 'error',
        title: rt('reader.error.title'),
        desc: rt('reader.error.desc', { message: describeError(this.state.error) }),
        retry: this.retry,
        onBack: this.props.onBack,
      })
    }
    return this.props.render('reader-' + this.state.epoch)
  }
}

/**
 * @param {object} props
 * @param {Function} props.t Slotted translator (`ctx.locale.bind(NS)`).
 * @param {Function} props.api Slotted API callable.
 * @param {object} [props.pending] Pending-materials store (drawer/dock share it).
 * @param {string} props.paperId
 * @param {number} [props.initialPage]
 * @param {Function} props.onBack
 * @param {Function} [props.onOpenPaper]
 * @param {Function} [props.onToast]
 * @param {string} [props.sessionId]
 * @param {object} [props.paper] Optional preloaded PaperSummary.
 * @param {string} [props.initialTab] outline | annotations | notes | ai.
 * @param {string} [props.annotationId] Open this annotation (page + popover) once loaded.
 * @param {Function} [props.onOpenNoteLibrary] Switch to the standalone notes library with one note.
 */
export function ReaderShell(props) {
  const rt = React.useMemo(() => buildReaderT(props.t), [props.t])
  return React.createElement(ReaderBoundary, {
    t: rt,
    onBack: props.onBack,
    render: (key) => React.createElement(ReaderShellInner, Object.assign({}, props, { key })),
  })
}

/** Inner implementation (all hooks live here; the wrapper only adds the boundary). */
function ReaderShellInner(props) {
  const rt = React.useMemo(() => buildReaderT(props.t), [props.t])
  const trSlider = useSlidingThumb()
  // Styles live in a ref-counted <style> element; unmounting the reader removes
  // it so disabling the plugin leaves no global side effect behind.
  const releaseStyles = React.useMemo(() => ensureReaderStyles(), [])
  React.useEffect(() => () => releaseStyles(), [releaseStyles])
  const apiCall = React.useMemo(() => createApiCaller(props.api), [props.api])
  const reducedMotion = usePrefersReducedMotion()
  const notices = useReaderNotices(props.onToast)
  const notify = notices.notify
  // v0.3 undo: local stack works standalone; `props.undo` (center-injected global
  // context) is mirrored when available. TODO(integration): once client-engineer
  // exports the undo context, prefer external.undo() for cross-surface Cmd+Z.
  const undoApi = useReaderUndo(props.undo)
  // v0.4: shared translation preference (client translationStore via center, or
  // translate.settings when the context is not injected yet). The page/selection
  // requests read this value at call time, so a settings switch applies next time.
  const translationPreference = useTranslationPreference(props.translation, apiCall)
  const preferredProvider = translationPreference.provider
  const notifyUndo = React.useCallback(
    (kind, text) => {
      notify(kind, text, {
        label: rt('reader.undo.undo'),
        onClick: () => {
          Promise.resolve(undoApi.undo())
            .then((entry) => {
              if (entry) notify('info', rt('reader.undo.done', { label: entry.label }))
            })
            .catch((error) => notify('error', rt('reader.undo.failed', { message: describeError(error) })))
        },
      })
    },
    [notify, rt, undoApi],
  )
  const paperId = firstText(props.paperId)

  /* ------------------------------ data: paper ---------------------------- */
  const openState = useAsync(
    (signal) => (paperId ? apiCall('reader.open', { id: paperId }, { signal }) : Promise.resolve(null)),
    [paperId],
    { enabled: Boolean(paperId) },
  )
  const detail = openState.data || null
  const paper = (detail && detail.paper) || props.paper || null
  const versionId = firstText(detail && detail.version && detail.version.id)
  const pages = React.useMemo(() => arrayOf(detail && detail.pages), [detail])
  const total = React.useMemo(() => {
    const count = Math.round(num(pages.length > 0 ? pages.length : paper && paper.pageCount, 1))
    return Math.max(1, count)
  }, [pages, paper])

  /* ------------------------------ navigation ----------------------------- */
  const [figureFocus, setFigureFocus] = React.useState(null)
  // Figure geometry for the open paper: the page boxes are drag sources, so the
  // canvas needs it before the side-panel figure list is ever opened.
  const [paperFigures, setPaperFigures] = React.useState({ paperId: '', items: [] })
  const [noteContext, setNoteContextState] = React.useState(() => getNoteContext())
  const figureFocusTimer = React.useRef(null)
  const [page, setPage] = React.useState(() => {
    const explicit = Math.round(num(props.initialPage, 0))
    if (explicit > 0) return explicit
    const restored = props.paperId ? readReadingPosition(props.paperId) : 0
    return restored > 0 ? restored : 1
  })
  const jumpSeq = React.useRef(0)
  const [jump, setJump] = React.useState(null)
  const pageRef = React.useRef(page)
  pageRef.current = page
  const totalRef = React.useRef(total)
  totalRef.current = total

  React.useEffect(() => {
    if (typeof props.onPageChange === 'function') props.onPageChange(page)
  }, [page, props.onPageChange])

  const goToPage = React.useCallback((target, options) => {
    const next = clamp(Math.round(num(target, 1)), 1, totalRef.current)
    setPage(next)
    jumpSeq.current += 1
    setJump({ page: next, seq: jumpSeq.current, smooth: !(options && options.instant) })
  }, [])

  const [zoom, setZoom] = React.useState(1)
  const zoomStep = React.useCallback((direction) => {
    setZoom((previous) => {
      const next = Math.round((previous + direction * ZOOM_STEP) * 100) / 100
      return clamp(next, ZOOM_MIN, ZOOM_MAX)
    })
  }, [])
  const zoomFit = React.useCallback(() => setZoom(1), [])

  const [mode, setMode] = React.useState('source')
  // v0.17: the old 双语 tab is gone. 原文/对照/仅译文 now drives a translation
  // sheet docked to the page canvas, so the right panel stays 目录/批注/笔记/AI.
  const changeMode = React.useCallback((next) => {
    setMode(next)
  }, [])

  const [tool, setTool] = React.useState('select')
  const changeTool = React.useCallback(
    (next) => {
      setTool(next)
      if (next === 'area') notify('info', rt('reader.areaModeActive'))
      if (next === 'note') notify('info', rt('reader.noteModeActive'))
      if (next === 'select') clearNativeSelection()
    },
    [notify, rt],
  )

  // On narrow windows the side panel overlays the page, so start closed and
  // let the AI / notes buttons in the toolbar reveal it on demand.
  const [sideOpen, setSideOpen] = React.useState(() => (typeof window === 'undefined' ? true : window.innerWidth > 1150))
  const [sideTab, setSideTab] = React.useState(() => {
    const requested = firstText(props.initialTab)
    return SIDE_TABS.indexOf(requested) >= 0 ? requested : 'outline'
  })
  // Floating annotation tools: the pen colour is shared by highlight / area /
  // sticky note, and the first run shows a one-time hint.
  const [penColor, setPenColorState] = React.useState(DEFAULT_COLOR)
  const setPenColor = React.useCallback((color) => {
    const value = firstText(color, DEFAULT_COLOR)
    lastColor.current = value
    setPenColorState(value)
  }, [])
  const [toolsTip, setToolsTip] = React.useState(() => !readFlag(TOOLS_TIP_FLAG))
  const dismissToolsTip = React.useCallback(() => {
    writeFlag(TOOLS_TIP_FLAG, true)
    setToolsTip(false)
  }, [])
  const showToolsTip = React.useCallback(() => setToolsTip(true), [])
  const openSide = React.useCallback((tab) => {
    setSideOpen(true)
    if (tab) setSideTab(tab)
  }, [])
  const toggleSide = React.useCallback(() => setSideOpen((value) => !value), [])
  const [scrolled, setScrolled] = React.useState(false)
  const handleScrolledChange = React.useCallback((value) => setScrolled(Boolean(value)), [])

  /* ------------------------------ page caches ---------------------------- */
  const pageCache = React.useRef(new Map())
  const layerCache = React.useRef(new Map())
  const [dataVersion, setDataVersion] = React.useState(0)
  const bumpData = React.useCallback(() => setDataVersion((value) => value + 1), [])

  const getPageData = React.useCallback(
    (pageNo) => {
      const entry = pageCache.current.get(pageNo)
      return entry && entry.paperId === paperId ? entry : null
    },
    [paperId],
  )
  const getLayer = React.useCallback(
    (pageNo) => {
      const entry = layerCache.current.get(pageNo)
      return entry && entry.paperId === paperId ? entry : null
    },
    [paperId],
  )

  const structureRefreshes = React.useRef(new Map())
  const ensurePage = React.useCallback(
    (pageNo) => {
      if (!paperId || !pageNo) return
      const existing = pageCache.current.get(pageNo)
      if (existing && existing.paperId === paperId) return
      pageCache.current.set(pageNo, { paperId, status: 'loading' })
      bumpData()
      apiCall('reader.page', { id: paperId, page: pageNo })
        .then((data) => {
          pageCache.current.set(pageNo, { paperId, status: 'ready', data })
          bumpData()
          // Host may backfill the v0.2 layout for older papers; while it is
          // pending the old blocks are still served. Poll a couple of times so
          // the reader upgrades to the rebuilt structure without a reload.
          if (data && data.structureState === 'pending') {
            const attempts = structureRefreshes.current.get(pageNo) || 0
            if (attempts < 2) {
              structureRefreshes.current.set(pageNo, attempts + 1)
              setTimeout(() => {
                const entry = pageCache.current.get(pageNo)
                if (!entry || entry.paperId !== paperId) return
                pageCache.current.delete(pageNo)
                ensurePageRef.current(pageNo)
              }, 3500)
            }
          }
        })
        .catch((error) => {
          pageCache.current.set(pageNo, { paperId, status: 'error', error })
          bumpData()
        })
    },
    [apiCall, bumpData, paperId],
  )
  const ensurePageRef = React.useRef(ensurePage)
  ensurePageRef.current = ensurePage

  const ensureLayer = React.useCallback(
    (pageNo) => {
      if (!paperId || !pageNo) return
      const existing = layerCache.current.get(pageNo)
      if (existing && existing.paperId === paperId) return
      layerCache.current.set(pageNo, { paperId, status: 'loading' })
      bumpData()
      apiCall('reader.layer', { id: paperId, page: pageNo })
        .then((data) => {
          layerCache.current.set(pageNo, { paperId, status: 'ready', data })
          bumpData()
        })
        .catch((error) => {
          layerCache.current.set(pageNo, { paperId, status: 'error', error })
          bumpData()
        })
    },
    [apiCall, bumpData, paperId],
  )

  const retryPage = React.useCallback(
    (pageNo) => {
      pageCache.current.delete(pageNo)
      ensurePage(pageNo)
    },
    [ensurePage],
  )
  const retryLayer = React.useCallback(
    (pageNo) => {
      layerCache.current.delete(pageNo)
      ensureLayer(pageNo)
    },
    [ensureLayer],
  )

  /* ------------------------------ outline -------------------------------- */
  const outlineState = useAsync(
    (signal) => (paperId ? apiCall('reader.outline', { id: paperId }, { signal }) : Promise.resolve({ items: [] })),
    [paperId],
    { enabled: Boolean(paperId) },
  )
  const outlineItems = React.useMemo(() => arrayOf(outlineState.data && outlineState.data.items), [outlineState.data])

  /* ------------------------------ annotations ---------------------------- */
  const [annotationReload, setAnnotationReload] = React.useState(0)
  const annotationsState = useAsync(
    (signal) =>
      paperId
        ? apiCall('annotations.list', versionId ? { paperId, versionId } : { paperId }, { signal })
        : Promise.resolve([]),
    [paperId, versionId, annotationReload],
    { enabled: Boolean(paperId) },
  )
  const [annotations, setAnnotations] = React.useState(NO_ANNOTATIONS)
  React.useEffect(() => {
    if (annotationsState.status === 'ready') setAnnotations(normalizeAnnotations(annotationsState.data))
  }, [annotationsState.status, annotationsState.data])

  const lastColor = React.useRef(DEFAULT_COLOR)
  const intentSeq = React.useRef(0)
  const [annotationIntent, setAnnotationIntent] = React.useState(() => {
    const initial = firstText(props.annotationId)
    if (!initial) return null
    intentSeq.current += 1
    return { id: initial, seq: intentSeq.current }
  })

  const createAnnotation = React.useCallback(
    (draft) => {
      const params = annotationRequest({ paperId, versionId, page: pageRef.current }, draft)
      const optimistic = normalizeAnnotation(
        Object.assign({}, params, {
          id: 'tmp-' + randomId(),
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          revision: 0,
          state: 'active',
          pending: true,
          comment: firstText(draft.comment),
          quote: firstText(draft.quote),
        }),
      )
      if (!optimistic) return Promise.reject(makeApiError('invalid', 'invalid annotation'))
      setAnnotations((previous) => previous.concat([optimistic]))
      let promise
      try {
        promise = apiCall('annotations.create', params)
      } catch (error) {
        promise = Promise.reject(error)
      }
      return Promise.resolve(promise)
        .then((result) => {
          const saved = normalizeAnnotation(result && result.annotation ? result.annotation : result)
          if (!saved) throw makeApiError('internal', 'empty annotation response')
          setAnnotations((previous) => previous.map((annotation) => (annotation.id === optimistic.id ? saved : annotation)))
          if (saved.color) lastColor.current = saved.color
          let liveId = saved.id
          undoApi.push({
            label: rt('reader.undo.created'),
            undo: async () => {
              try {
                await apiCall('annotations.delete', { id: liveId })
              } catch (error) {
                if (error && error.code === 'not_found') return
                throw error
              }
              setAnnotations((previous) => previous.filter((annotation) => annotation.id !== liveId))
            },
            redo: async () => {
              const recreated = normalizeAnnotation(
                await apiCall('annotations.create', params).then((res) => (res && res.annotation ? res.annotation : res)),
              )
              if (!recreated) throw makeApiError('internal', 'empty annotation response')
              liveId = recreated.id
              setAnnotations((previous) => previous.concat([recreated]))
            },
          })
          return saved
        })
        .catch((error) => {
          setAnnotations((previous) => previous.filter((annotation) => annotation.id !== optimistic.id))
          throw error
        })
    },
    [apiCall, paperId, versionId],
  )

  const updateAnnotation = React.useCallback(
    (annotation, patch) => {
      const previous = annotation
      setAnnotations((list) =>
        list.map((item) => (item.id === previous.id ? Object.assign({}, item, patch, { pending: true }) : item)),
      )
      let promise
      try {
        promise = apiCall('annotations.update', Object.assign({ id: previous.id, expectedRevision: previous.revision }, patch))
      } catch (error) {
        promise = Promise.reject(error)
      }
      return Promise.resolve(promise)
        .then((result) => {
          const saved = normalizeAnnotation(result && result.annotation ? result.annotation : result)
          setAnnotations((list) =>
            list.map((item) =>
              item.id === previous.id
                ? saved || Object.assign({}, item, patch, { pending: false, revision: previous.revision + 1 })
                : item,
            ),
          )
          const inverse = {}
          Object.keys(patch || {}).forEach((key) => {
            if (key === 'color') inverse.color = previous.color
            else if (key === 'comment') inverse.comment = previous.comment
            else if (key === 'quote') inverse.quote = previous.quote
          })
          if (Object.keys(inverse).length > 0) {
            const applyPatch = async (values) => {
              const result = await apiCall('annotations.update', Object.assign({ id: previous.id }, values))
              const restored = normalizeAnnotation(result && result.annotation ? result.annotation : result)
              setAnnotations((list) => list.map((item) => (item.id === previous.id ? restored || Object.assign({}, item, values) : item)))
            }
            undoApi.push({
              label: rt('reader.undo.updated'),
              undo: () => applyPatch(inverse),
              redo: () => applyPatch(patch),
            })
          }
          return saved
        })
        .catch((error) => {
          setAnnotations((list) => list.map((item) => (item.id === previous.id ? previous : item)))
          notify('error', rt('reader.annot.failed', { message: describeError(error) }))
          throw error
        })
    },
    [apiCall, notify, rt],
  )

  const deleteAnnotation = React.useCallback(
    (annotation) => {
      let index = -1
      setAnnotations((list) => {
        index = list.findIndex((item) => item.id === annotation.id)
        return list.filter((item) => item.id !== annotation.id)
      })
      let promise
      try {
        promise = apiCall('annotations.delete', { id: annotation.id })
      } catch (error) {
        promise = Promise.reject(error)
      }
      return Promise.resolve(promise)
        .then(() => {
          let liveId = annotation.id
          const recreatePayload = {
            paperId: paperId,
            page: annotation.page,
            kind: annotation.kind,
            rects: annotation.rects,
            quote: annotation.quote,
            comment: annotation.comment,
            color: annotation.color,
            origin: annotation.origin,
          }
          if (versionId) recreatePayload.versionId = versionId
          undoApi.push({
            label: rt('reader.undo.deleted'),
            undo: async () => {
              const recreated = normalizeAnnotation(
                await apiCall('annotations.create', recreatePayload).then((res) => (res && res.annotation ? res.annotation : res)),
              )
              if (!recreated) throw makeApiError('internal', 'empty annotation response')
              liveId = recreated.id
              setAnnotations((list) => list.concat([recreated]))
            },
            redo: async () => {
              try {
                await apiCall('annotations.delete', { id: liveId })
              } catch (error) {
                if (!(error && error.code === 'not_found')) throw error
              }
              setAnnotations((list) => list.filter((item) => item.id !== liveId))
            },
          })
          notifyUndo('success', rt('reader.annot.deleted'))
        })
        .catch((error) => {
          setAnnotations((list) => {
            const restored = list.slice()
            restored.splice(index >= 0 ? index : restored.length, 0, annotation)
            return restored
          })
          notify('error', rt('reader.annot.failed', { message: describeError(error) }))
          throw error
        })
    },
    [apiCall, notify, rt],
  )

  /* ------------------------------ popover -------------------------------- */
  const [popover, setPopover] = React.useState(null)
  const popoverAnnotation = React.useMemo(() => {
    if (!popover) return null
    const found = annotations.find((annotation) => annotation.id === popover.id)
    return found || null
  }, [annotations, popover])
  const popoverProp = React.useMemo(() => {
    if (!popoverAnnotation || !popover) return null
    return { annotation: popoverAnnotation, anchor: popover.anchor, autoFocus: Boolean(popover.autoFocus) }
  }, [popoverAnnotation, popover])
  const activeAnnotationId = popoverAnnotation ? popoverAnnotation.id : null

  // Deep link from the library / search: open the requested annotation once
  // annotations.list has produced it.
  React.useEffect(() => {
    if (!annotationIntent) return
    if (annotationsState.status === 'error') {
      setAnnotationIntent(null)
      return
    }
    if (annotationsState.status !== 'ready') return
    const target = annotations.find((annotation) => annotation.id === annotationIntent.id)
    if (!target) {
      // `annotationsState` can flip to ready one tick before the local list is
      // updated; only treat the id as gone once a non-empty list was applied.
      if (annotations.length > 0) setAnnotationIntent(null)
      return
    }
    setAnnotationIntent(null)
    if (target.page !== pageRef.current) goToPage(target.page)
    setPopover({ id: target.id, anchor: target.rects[0] || { x: 0.5, y: 0.2, w: 0, h: 0 }, autoFocus: false })
  }, [annotations, annotationIntent, annotationsState.status, goToPage])

  // Same-paper navigation intents (tool cards / answer sources asking the reader
  // to jump while it is already mounted). center.jsx remounts us for a different
  // paperId, so only same-paper routes are handled here.
  const navigation = props.navigation
  const navSnapshot = useNavigationSnapshot(navigation)
  const navConsumed = React.useRef(0)
  React.useEffect(() => {
    if (!navigation || !navSnapshot || !navSnapshot.seq) return
    if (navConsumed.current === navSnapshot.seq) return
    const route = navSnapshot.route || {}
    if (route.view !== 'reader' || route.paperId !== paperId) return
    navConsumed.current = navSnapshot.seq
    let intent = null
    try {
      intent = typeof navigation.consumeIntent === 'function' ? navigation.consumeIntent() : null
    } catch (error) {
      intent = null
    }
    const target = intent || route
    if (!target) return
    if (target.page && Math.round(num(target.page, 1)) !== pageRef.current) {
      goToPage(target.page)
    }
    if (target.annotationId) {
      intentSeq.current += 1
      setAnnotationIntent({ id: String(target.annotationId), seq: intentSeq.current })
    }
    if (target.kind === 'figure' && target.figureId) {
      const figurePage = Math.max(1, Math.round(num(target.page, pageRef.current)))
      setFigureFocus({
        figureId: String(target.figureId),
        page: figurePage,
        bbox: target.bbox || null,
        figureLabel: target.figureLabel || target.label || '',
        seq: Date.now(),
      })
      // v0.15: schedule the auto-clear directly on the navigation event; a
      // state-effect timer can be re-created by reader re-renders.
      if (figureFocusTimer.current) clearTimeout(figureFocusTimer.current)
      figureFocusTimer.current = setTimeout(() => setFigureFocus(null), 4600)
    }
  }, [goToPage, navSnapshot, navigation, notify, paperId, rt])

  React.useEffect(() => () => { if (figureFocusTimer.current) clearTimeout(figureFocusTimer.current) }, [])

  React.useEffect(() => {
    const sync = () => setNoteContextState(getNoteContext())
    sync()
    return subscribeNoteContext(sync)
  }, [])

  const linkCurrentPaper = React.useCallback(() => {
    if (!noteContext || typeof noteContext.linkPaper !== 'function') {
      notify('warning', rt('reader.linkNote.noNote'))
      return
    }
    if (!paperId || typeof noteContext.linkPaper !== 'function') return
    Promise.resolve(noteContext.linkPaper(paperId))
      .then((fresh) => {
        if (fresh) {
          setNoteContextState((current) => current ? { ...current, paperIds: Array.isArray(fresh.paperIds) ? fresh.paperIds : current.paperIds } : current)
          notify('success', rt('reader.linkNote.done', { title: noteContext.title || rt('reader.linkNote.untitled') }))
        }
      })
      .catch((error) => notify('error', rt('reader.linkNote.failed', { message: describeError(error) })))
  }, [noteContext, paperId, notify, rt])

  const insertFigureIntoNote = React.useCallback((material) => {
    if (!noteContext || typeof noteContext.insertFigure !== 'function') {
      notify('warning', rt('reader.linkNote.noNote'))
      return
    }
    Promise.resolve(noteContext.insertFigure(material))
      .then(() => notify('success', rt('reader.figures.inserted')))
      .catch((error) => notify('error', rt('reader.figures.insertFailed', { message: describeError(error) })))
  }, [noteContext, notify, rt])

  const linkAnnotationToNote = React.useCallback((annotation) => {
    if (!noteContext || typeof noteContext.insertQuote !== 'function') {
      notify('warning', rt('reader.linkNote.noNote'))
      return
    }
    const quote = firstText(annotation && annotation.quote)
    if (quote === '') {
      notify('warning', rt('reader.linkNote.emptyQuote'))
      return
    }
    Promise.resolve(noteContext.insertQuote({
      quote,
      comment: firstText(annotation && annotation.comment),
      paperTitle: firstText(paper && (paper.titleZh || paper.title)),
      page: Number(annotation && annotation.page) || page,
      annotationId: annotation && annotation.id,
    }))
      .then(() => notify('success', rt('reader.linkNote.quoteDone', { title: noteContext.title || rt('reader.linkNote.untitled') })))
      .catch((error) => notify('error', rt('reader.linkNote.quoteFailed', { message: describeError(error) })))
  }, [noteContext, notify, rt, paper, page])

  React.useEffect(() => {
    if (!figureFocus) return
    if (Math.round(num(page, 1)) !== figureFocus.page) setFigureFocus(null)
  }, [page, figureFocus])

  const openAnnotation = React.useCallback((annotation, anchor) => {
    setPopover({ id: annotation.id, anchor, autoFocus: false })
  }, [])
  const closePopover = React.useCallback(() => setPopover(null), [])

  /* ------------------------------ selection ------------------------------ */
  const [selection, setSelection] = React.useState(null)
  const [selectionResult, setSelectionResult] = React.useState(null)

  const handleSelection = React.useCallback((next) => {
    setSelection(next)
    if (!next) setSelectionResult(null)
  }, [])
  const clearSelection = React.useCallback(() => {
    setSelection(null)
    setSelectionResult(null)
    clearNativeSelection()
  }, [])

  /* ------------------------------ AI requests ---------------------------- */
  const [aiRequest, setAiRequest] = React.useState(null)
  const aiSeq = React.useRef(0)
  const askAi = React.useCallback((request) => {
    aiSeq.current += 1
    setAiRequest(Object.assign({}, request, { seq: aiSeq.current }))
    setSideOpen(true)
    setSideTab('ai')
  }, [])

  /* ------------------------------ references ----------------------------- */
  const commitMaterials = React.useCallback(
    async (materials) => {
      const list = arrayOf(materials)
        .filter((material) => material && material.id)
        .map((material) => {
          const item = { kind: material.kind || 'paper', id: String(material.id) }
          if (material.page) item.page = Math.max(1, Math.round(num(material.page, 1)))
          return item
        })
      if (list.length === 0) throw makeApiError('invalid', 'no materials selected')
      const { result, created } = await commitReferenceBatch(list, {
        sessionId: props.sessionId,
        operationId: newOperationId('refs'),
      })
      const bundleId = firstText(result && result.bundleId, result && result.bundle && result.bundle.id)
      if (created && bundleId && props.pending && typeof props.pending.remove === 'function') {
        undoApi.push({
          label: rt('reader.undo.cited'),
          undo: async () => {
            props.pending.remove(bundleId)
          },
          redo: async () => {
            props.pending.add(result, arrayOf(materials))
          },
        })
      }
      notifyUndo('success', rt('reader.toast.cited'))
      return result
    },
    [apiCall, notify, props.pending, props.sessionId, rt],
  )

  const citePaperPage = React.useCallback(() => {
    const title = firstText(paper && paper.titleZh, paper && paper.title)
    commitMaterials([{ kind: 'paper', id: paperId, page, title }]).catch((error) => {
      notify('error', rt('reader.toast.citeFailed', { message: describeError(error) }))
    })
  }, [commitMaterials, notify, page, paper, paperId, rt])

  const citeAnnotation = React.useCallback(
    (annotation) => {
      commitMaterials([
        {
          kind: 'annotation',
          id: annotation.id,
          page: annotation.page,
          title: firstText(annotation.quote, annotation.comment),
        },
      ]).catch((error) => notify('error', rt('reader.toast.citeFailed', { message: describeError(error) })))
    },
    [commitMaterials, notify, rt],
  )

  const citeAiAnswer = React.useCallback(
    (message) => {
      const materials = [{ kind: 'paper', id: paperId, page, title: firstText(paper && paper.titleZh, paper && paper.title) }]
      for (const source of arrayOf(message && message.sources)) {
        if (source && source.kind === 'figure' && source.figureId) {
          materials.push({ kind: 'figure', id: String(source.figureId), page: num(source.page, page), title: firstText(source.label) })
        }
      }
      commitMaterials(materials).catch((error) => notify('error', rt('reader.toast.citeFailed', { message: describeError(error) })))
    },
    [commitMaterials, notify, page, paper, paperId, rt],
  )

  /* ------------------------------ translation ---------------------------- */
  // Only translate what the bilingual panel shows by default (body/heading/
  // caption, no page furniture); revealed marginal blocks get a per-card button.
  const TRANSLATABLE_ROLES = ['body', 'heading', 'caption']

  const [translations, setTranslations] = React.useState({})
  const translationSequence = React.useRef(0)

  /** Blocks of one page that the Host is able to translate (role/text filter). */
  const translatableBlocksFor = React.useCallback(
    (pageNo) => {
      const entry = getPageData(pageNo)
      if (!entry || entry.status !== 'ready' || !entry.data) return []
      return arrayOf(entry.data.blocks).filter(
        (block) =>
          block &&
          block.id != null &&
          typeof block.text === 'string' &&
          block.text.trim().length >= 2 &&
          TRANSLATABLE_ROLES.indexOf(String(block.role || 'body')) >= 0 &&
          !looksLikePageMetadata(block.text),
      )
    },
    [getPageData],
  )

  const updateTranslationPage = React.useCallback((pageNo, updater) => {
    setTranslations((previous) => {
      const current = previous[pageNo] || {
        status: 'idle',
        entries: {},
        pending: {},
        progress: { total: 0, done: 0, failed: 0 },
        provenance: null,
        provider: 'auto',
        engine: null,
        cachedAll: false,
      }
      const next = updater(current)
      return Object.assign({}, previous, { [pageNo]: next })
    })
  }, [])

  /** Normalize one per-block translation payload into an entry. */
  const normalizeBlockEntry = React.useCallback(
    (block, item, fallbackEngine, fallbackReason, fallbackModel) => {
      const translation = firstText(item && item.translation)
      const engine = readEngine(item, (fallbackEngine && fallbackEngine.provider) || 'auto')
      const translated = Boolean(translation) && String((item && item.status) || 'translated') !== 'unavailable'
      return {
        id: block.id,
        translation: translated ? translation : '',
        status: translated ? 'translated' : 'unavailable',
        reason: translated ? '' : firstText(item && item.reason, fallbackReason, rt('reader.ai.reasonFallback')),
        cached: Boolean(item && item.cached),
        provider: engine.provider,
        engine,
        model: firstText(item && item.model, item && item.engine && item.engine.model, fallbackModel),
        latencyMs: firstText(item && item.latencyMs, item && item.latency),
      }
    },
    [rt],
  )

  const summarizeEngines = React.useCallback((blocks, entries) => {
    const labels = []
    const models = []
    for (const block of blocks) {
      const entry = entries[String(block.id)]
      if (!entry || entry.status !== 'translated') continue
      const title = engineTitle(entry.engine, entry.model)
      if (title && labels.indexOf(title) < 0) labels.push(title)
      if (entry.model && models.indexOf(entry.model) < 0) models.push(entry.model)
    }
    const firstEntry = blocks.map((block) => entries[String(block.id)]).find((entry) => entry && entry.status === 'translated')
    return { label: labels.join(' + '), model: models.join(', '), engine: firstEntry ? firstEntry.engine || null : null }
  }, [])

  /**
   * v0.4 page translation: one `translate.blocks {provider:'auto'}` call lets the
   * Host route each paragraph through Google → MyMemory → LLM (fast + cached).
   * `provider:'llm'` re-runs the page through the LLM for the “AI 精译本页” path.
   */
  const runPageTranslation = React.useCallback(
    async (pageNo, options) => {
      if (!paperId) return null
      const opts = options || {}
      const blocks = translatableBlocksFor(pageNo)
      if (blocks.length === 0) {
        notify('info', rt('reader.toast.translateNoBlocks'))
        return null
      }
      const provider = opts.provider || preferredProvider || 'auto'
      const token = (translationSequence.current += 1)
      const pending = {}
      blocks.forEach((block) => {
        pending[String(block.id)] = true
      })
      updateTranslationPage(pageNo, (current) =>
        Object.assign({}, current, {
          status: 'translating',
          entries: {},
          pending,
          progress: { total: blocks.length, done: 0, failed: 0 },
          provider,
          engine: null,
          provenance: null,
          cachedAll: false,
          reason: '',
          startedAt: Date.now(),
        }),
      )
      const params = { paperId, page: pageNo, target: 'zh', provider }
      if (props.sessionId) params.sessionId = props.sessionId
      const commit = (entries, extra) => {
        if (translationSequence.current !== token) return null
        const summary = summarizeEngines(blocks, entries)
        let done = 0
        let failed = 0
        for (const block of blocks) {
          const entry = entries[String(block.id)]
          if (!entry) continue
          if (entry.status === 'translated') done += 1
          else failed += 1
        }
        const status = done === blocks.length ? 'translated' : done > 0 ? 'partial' : 'unavailable'
        const cachedAll =
          blocks.length > 0 &&
          done === blocks.length &&
          blocks.every((block) => {
            const entry = entries[String(block.id)]
            return entry && entry.status === 'translated' && entry.cached
          })
        const firstFailure = blocks.map((block) => entries[String(block.id)]).find((entry) => entry && entry.status !== 'translated')
        updateTranslationPage(pageNo, (current) =>
          Object.assign({}, current, {
            status,
            entries,
            pending: {},
            progress: { total: blocks.length, done, failed },
            provenance: { label: summary.label, model: summary.model, provider },
            provider,
            engine: summary.engine && summary.engine.engine,
            cachedAll,
            reason:
              status === 'unavailable'
                ? firstText(
                    extra && extra.reason,
                    firstFailure && firstFailure.reason,
                    rt('reader.bilingual.unavailable'),
                  )
                : '',
          }),
        )
        return { status, done, failed }
      }
      try {
        const result = await apiCall('translate.blocks', params, { timeoutMs: 60000 })
        const returned = arrayOf(result && result.blocks)
        const fallbackEngine = readEngine(result, provider)
        const fallbackModel = firstText(
          result && result.engine && result.engine.model,
          result && result.provenance && result.provenance.model,
          result && result.model,
        )
        const fallbackReason = firstText(result && result.reason, rt('reader.ai.reasonFallback'))
        const entries = {}
        blocks.forEach((block, index) => {
          let item = returned.find((candidate) => candidate && String(candidate.id) === String(block.id))
          if (!item && returned.length === blocks.length) item = returned[index]
          entries[String(block.id)] = normalizeBlockEntry(block, item, fallbackEngine, fallbackReason, fallbackModel)
        })
        // If the Host returned only some blocks, retry the missing ones with the
        // per-block endpoint so the page still completes.
        const missing = blocks.filter((block) => {
          const entry = entries[String(block.id)]
          return entry && entry.status !== 'translated' && !entry.reason
        })
        commit(entries, { reason: firstText(result && result.reason) })
        if (missing.length > 0) {
          await Promise.all(missing.slice(0, 2).map((block) => translateBlockInternal(block, pageNo, provider)))
        }
        return entries
      } catch (error) {
        const code = error && error.code
        if (code === 'invalid' || code === 'unknown_method' || code === 'method_not_found' || code === 'not_implemented') {
          return legacyPerBlockTranslate(blocks, pageNo, provider, token)
        }
        const entries = {}
        const reason = describeError(error)
        blocks.forEach((block) => {
          entries[String(block.id)] = {
            id: block.id,
            translation: '',
            status: 'unavailable',
            reason,
            cached: false,
            provider,
            engine: readEngine(null, provider),
          }
        })
        commit(entries, { reason })
        return entries
      }
    },
    [apiCall, notify, preferredProvider, props.sessionId, rt, summarizeEngines, translatableBlocksFor, updateTranslationPage],
  )

  /** Legacy Host without translate.blocks provider support: 2-concurrent per-block translate.text. */
  const legacyPerBlockTranslate = React.useCallback(
    async (blocks, pageNo, provider, token) => {
      const entries = {}
      const queue = blocks.slice().sort((left, right) => String(right.text || '').length - String(left.text || '').length)
      let index = 0
      const worker = async () => {
        while (queue.length > 0) {
          if (translationSequence.current !== token) return
          const block = queue.shift()
          const params = { paperId, page: pageNo, text: block.text, target: 'zh', provider }
          if (props.sessionId) params.sessionId = props.sessionId
          let item = null
          try {
            item = await apiCall('translate.text', params, { timeoutMs: 30000 })
          } catch (error) {
            item = { status: 'unavailable', reason: describeError(error) }
          }
          const entry = normalizeBlockEntry(block, item, readEngine(item, provider), rt('reader.ai.reasonFallback'))
          entries[String(block.id)] = entry
          const done = Object.values(entries).filter((value) => value && value.status === 'translated').length
          const failed = Object.values(entries).filter((value) => value && value.status !== 'translated').length
          if (translationSequence.current === token) {
            updateTranslationPage(pageNo, (current) =>
              Object.assign({}, current, {
                entries: Object.assign({}, entries),
                pending: Object.fromEntries(blocks.filter((block2) => !entries[String(block2.id)]).map((block2) => [String(block2.id), true])),
                progress: { total: blocks.length, done, failed },
              }),
            )
          }
          index += 1
        }
      }
      await Promise.all([worker(), worker()])
      if (translationSequence.current !== token) return entries
      const summary = summarizeEngines(blocks, entries)
      let done = 0
      let failed = 0
      for (const block of blocks) {
        const entry = entries[String(block.id)]
        if (entry && entry.status === 'translated') done += 1
        else failed += 1
      }
      updateTranslationPage(pageNo, (current) =>
        Object.assign({}, current, {
          status: done === blocks.length ? 'translated' : done > 0 ? 'partial' : 'unavailable',
          entries,
          pending: {},
          progress: { total: blocks.length, done, failed },
          provenance: { label: summary.label, model: summary.model, provider },
          engine: summary.engine && summary.engine.engine,
          cachedAll:
            blocks.length > 0 &&
            done === blocks.length &&
            blocks.every((block) => entries[String(block.id)] && entries[String(block.id)].cached),
          reason:
            done === 0
              ? firstText(
                  blocks.map((block) => entries[String(block.id)]).find((entry) => entry && entry.reason)?.reason,
                  rt('reader.bilingual.unavailable'),
                )
              : '',
        }),
      )
      return entries
    },
    [apiCall, normalizeBlockEntry, paperId, props.sessionId, rt, summarizeEngines, updateTranslationPage],
  )

  /** Retry one failed paragraph through translate.text with the current provider chain. */
  const translateBlockInternal = React.useCallback(
    async (block, pageNo, providerOverride) => {
      if (!paperId || !block || block.id == null) return null
      const target = pageNo || pageRef.current
      const provider = providerOverride || preferredProvider || 'auto'
      const params = { paperId, page: target, text: block.text, target: 'zh', provider }
      if (props.sessionId) params.sessionId = props.sessionId
      updateTranslationPage(target, (current) =>
        Object.assign({}, current, {
          pending: Object.assign({}, current.pending, { [String(block.id)]: true }),
          status: current.status === 'translated' ? current.status : 'translating',
        }),
      )
      let item = null
      try {
        item = await apiCall('translate.text', params, { timeoutMs: 30000 })
      } catch (error) {
        item = { status: 'unavailable', reason: describeError(error) }
      }
      const entry = normalizeBlockEntry(block, item, readEngine(item, provider), rt('reader.ai.reasonFallback'))
      updateTranslationPage(target, (current) => {
        const entries = Object.assign({}, current.entries, { [String(block.id)]: entry })
        const blocks = translatableBlocksFor(target)
        let done = 0
        let failed = 0
        for (const itemBlock of blocks) {
          const pageEntry = entries[String(itemBlock.id)]
          if (!pageEntry) continue
          if (pageEntry.status === 'translated') done += 1
          else failed += 1
        }
        const pending = Object.assign({}, current.pending)
        delete pending[String(block.id)]
        const summary = summarizeEngines(blocks, entries)
        const status =
          Object.keys(pending).length > 0
            ? 'translating'
            : done === blocks.length
              ? 'translated'
              : done > 0
                ? 'partial'
                : 'unavailable'
        return Object.assign({}, current, {
          entries,
          pending,
          status,
          progress: { total: blocks.length, done, failed },
          provenance: { label: summary.label, model: summary.model, provider: current.provider || provider },
          engine: summary.engine && summary.engine.engine,
          cachedAll:
            blocks.length > 0 &&
            done === blocks.length &&
            blocks.every((itemBlock) => entries[String(itemBlock.id)] && entries[String(itemBlock.id)].cached),
        })
      })
      return entry
    },
    [apiCall, normalizeBlockEntry, preferredProvider, props.sessionId, rt, summarizeEngines, translatableBlocksFor, updateTranslationPage],
  )

  const translatePage = React.useCallback(
    (force, options) => {
      if (!paperId) return
      const opts = options || {}
      const target = pageRef.current
      const blocks = translatableBlocksFor(target)
      if (blocks.length === 0) {
        notify('info', rt('reader.toast.translateNoBlocks'))
        return
      }
      const current = translations[target]
      const entries = (current && current.entries) || {}
      const provider = opts.provider || preferredProvider || 'auto'
      const hasEntries = Object.keys(entries).length > 0
      if (!force && hasEntries) {
        const failed = blocks.filter((block) => {
          const entry = entries[String(block.id)]
          return !entry || entry.status !== 'translated'
        })
        // Partial page: retry only the failed paragraphs (cheap, keeps engines).
        if (failed.length > 0 && failed.length < blocks.length) {
          return Promise.all(failed.map((block) => translateBlockInternal(block, target, provider)))
        }
      }
      return runPageTranslation(target, { provider })
    },
    [notify, paperId, preferredProvider, rt, runPageTranslation, translateBlockInternal, translatableBlocksFor, translations],
  )

  const translateAiPage = React.useCallback(() => {
    return translatePage(true, { provider: 'llm' })
  }, [translatePage])

  const translateBlock = React.useCallback(
    (block) => translateBlockInternal(block, pageRef.current, preferredProvider || 'auto'),
    [preferredProvider, translateBlockInternal],
  )

  /**
   * v0.3 quick translation (fast / non-thinking mode). Tries the dedicated
   * `ai.quickTranslate` alias first, then `translate.text {fast:true}`; the
   * fallback keeps working against Host builds that have not shipped fast mode
   * yet (the result card then reports the real reason honestly).
   */
  /** Detect language for a selection; cached and softly degrading to a ratio heuristic. */
  const detectedCache = React.useRef(new Map())
  const detectLanguage = React.useCallback(
    async (text) => {
      const value = String(text || '').trim()
      if (!value) return 'empty'
      if (detectedCache.current.has(value)) return detectedCache.current.get(value)
      let language = 'unknown'
      try {
        const result = await apiCall('translate.detect', { text: value })
        const raw = firstText(
          result && result.language,
          result && result.lang,
          result && result.detected,
          result && result.code,
        )
        if (raw) language = /^(zh|cn|chinese|zh-cn|zh-hans|中文)/i.test(raw) ? 'zh' : 'other'
        else if (result && (result.isChinese === true || result.chinese === true)) language = 'zh'
      } catch (error) {
        const code = error && error.code
        if (code !== 'invalid' && code !== 'not_implemented' && code !== 'unknown_method' && code !== 'method_not_found') {
          // Host reachable but detection failed: fall through to the heuristic.
        }
      }
      if (language === 'unknown') language = isProbablyChinese(value) ? 'zh' : 'other'
      if (detectedCache.current.size > 200) detectedCache.current.clear()
      detectedCache.current.set(value, language)
      return language
    },
    [apiCall],
  )

  /**
   * Quick translation (v0.13): ONLY `translate.text {quick:true}` using the free
   * engine chain (Host deadline <= 6 s). It never silently falls back to the slow
   * LLM path: an unavailable/failed free result returns `suggestAi` plus a
   * user-facing reason, and the card offers 「用 AI 精译」. The AI-refine path
   * (`refine:true` / provider `llm`) keeps the LLM fast/refine call.
   */
  const quickTranslateText = React.useCallback(
    async (text, pageNo, options) => {
      const opts = options || {}
      const quote = String(text || '').trim()
      const targetPage = Math.max(1, Math.round(num(pageNo, pageRef.current)))
      if (!quote) throw makeApiError('invalid', 'empty selection')
      if (opts.detect !== false) {
        const language = await detectLanguage(quote)
        if (language === 'zh') {
          return { page: targetPage, quote, status: 'same-language', translation: '', reason: '', provider: 'auto' }
        }
      }
      const paperTitle = firstText(props.paper && props.paper.titleZh, props.paper && props.paper.title, '')
      const context = { paperTitle: paperTitle || undefined, page: targetPage }
      const base = { paperId, page: targetPage, text: quote, target: 'zh', paperTitle: paperTitle || undefined, context }
      // v0.17: send the normalised rectangles of the selection so the Host can
      // repair an unreliable text-layer quote from the region (image text).
      const requestRects = normalizeRectsForRequest(opts.rects)
      if (requestRects.length > 0) base.rects = requestRects
      if (props.sessionId) base.sessionId = props.sessionId
      const startedAt = Date.now()
      const isAiRefine = Boolean(opts.refine) || opts.provider === 'llm'

      if (!isAiRefine) {
        try {
          const result = await apiCall('translate.text', Object.assign({}, base, { quick: true }), { timeoutMs: 7000 })
          const provenance = (result && result.provenance) || {}
          const translation = firstText(result && result.translation, result && result.answer, result && result.text)
          const engine = readEngine(result, 'auto')
          const model = firstText(result && result.engine && result.engine.model, provenance.model, result && result.model)
          const rawLatency = result && result.latencyMs != null ? result.latencyMs : result && result.elapsedMs != null ? result.elapsedMs : result && result.elapsed
          const latency = rawLatency != null && rawLatency !== '' ? Number(rawLatency) : null
          const unavailable = !translation
          const reliability = assessTranslationReliability(result, quote)
          if (reliability.unreliable) {
            return {
              page: targetPage,
              quote,
              rects: requestRects,
              status: 'unreliable',
              translation: '',
              unreliable: true,
              reason: rt('reader.selection.unreliableRegion') + (reliability.reason ? '（' + reliability.reason + '）' : ''),
              provider: engine.provider || 'auto',
              engine,
              model,
              cached: false,
              latencyMs: latency != null && Number.isFinite(latency) ? latency : Date.now() - startedAt,
              fast: true,
              freeOnly: false,
              suggestAi: false,
              aiRefine: false,
              requestProvider: 'auto',
            }
          }
          return {
            page: targetPage,
            quote,
            rects: requestRects,
            status: translation ? 'translated' : firstText(result && result.status, 'unavailable'),
            translation,
            reason: translation ? '' : firstText(result && result.reason, provenance.reason, rt('reader.ai.reasonFallback')),
            provider: engine.provider || 'auto',
            engine,
            model,
            cached: Boolean(result && result.cached),
            latencyMs: latency != null && Number.isFinite(latency) ? latency : Date.now() - startedAt,
            fast: true,
            freeOnly: Boolean(result && (result.freeOnly || result.mode === 'free' || (result.engine && result.engine.free))),
            suggestAi: unavailable ? (result && result.suggestAi !== false) : false,
            aiRefine: false,
            requestProvider: 'auto',
          }
        } catch (error) {
          const timedOut = Boolean(error && (error.code === 'timeout' || error.code === 'timed_out' || error.name === 'TimeoutError'))
          return {
            page: targetPage,
            quote,
            rects: requestRects,
            status: 'unavailable',
            translation: '',
            reason: timedOut ? rt('reader.selection.quickTimeout') : firstText(error && error.message, rt('reader.ai.reasonFallback')),
            provider: 'auto',
            engine: null,
            model: '',
            cached: false,
            latencyMs: null,
            fast: true,
            freeOnly: true,
            suggestAi: true,
            aiRefine: false,
            requestProvider: 'auto',
          }
        }
      }

      const provider = opts.provider || 'llm'
      // v0.16.2: AI 精译 is the deep path with the model's MEDIUM thinking level;
      // never request fast/low here (that produced the cheap free-engine feel).
      const attempts = [
        { method: 'translate.text', params: Object.assign({}, base, { provider: 'llm', fast: false }) },
        { method: 'ai.quickTranslate', params: Object.assign({}, base, { provider: 'llm', fast: false }) },
      ]
      let lastError = null
      for (let index = 0; index < attempts.length; index += 1) {
        const attempt = attempts[index]
        const attemptStartedAt = Date.now()
        try {
          const result = await apiCall(attempt.method, attempt.params, { timeoutMs: 60000 })
          const provenance = (result && result.provenance) || {}
          const translation = firstText(result && result.translation, result && result.answer, result && result.text)
          const engine = readEngine(result, provider)
          const model = firstText(result && result.engine && result.engine.model, provenance.model, result && result.model)
          const rawLatency = result && result.latencyMs != null ? result.latencyMs : result && result.elapsedMs != null ? result.elapsedMs : result && result.elapsed
          const latency = rawLatency != null && rawLatency !== '' ? Number(rawLatency) : null
          const reliability = assessTranslationReliability(result, quote)
          if (reliability.unreliable) {
            return {
              page: targetPage,
              quote,
              rects: requestRects,
              status: 'unreliable',
              translation: '',
              unreliable: true,
              reason: rt('reader.selection.unreliableRegion') + (reliability.reason ? '（' + reliability.reason + '）' : ''),
              provider: engine.provider || provider,
              engine,
              model,
              cached: false,
              latencyMs: latency != null && Number.isFinite(latency) ? latency : Date.now() - attemptStartedAt,
              fast: true,
              freeOnly: false,
              suggestAi: false,
              aiRefine: true,
              requestProvider: provider,
            }
          }
          return {
            page: targetPage,
            quote,
            rects: requestRects,
            status: translation ? 'translated' : firstText(result && result.status, 'unavailable'),
            translation,
            reason: translation ? '' : firstText(result && result.reason, provenance.reason, rt('reader.ai.reasonFallback')),
            provider: engine.provider || provider,
            engine,
            model,
            cached: Boolean(result && result.cached),
            latencyMs: latency != null && Number.isFinite(latency) ? latency : Date.now() - attemptStartedAt,
            fast: true,
            freeOnly: false,
            suggestAi: false,
            aiRefine: true,
            reasoningEffort: firstText(result && result.reasoningEffort, provenance.reasoningEffort),
            requestProvider: provider,
          }
        } catch (error) {
          lastError = error
          const code = error && error.code
          if (code === 'invalid' || code === 'not_implemented' || code === 'unknown_method' || code === 'method_not_found' || code === 'unavailable') continue
          throw error
        }
      }
      throw lastError || makeApiError('unavailable', rt('reader.ai.reasonFallback'))
    },
    [apiCall, detectLanguage, paperId, props.paper, props.sessionId, rt],
  )

  const quickTranslateSelection = React.useCallback(
    (options) => {
      const opts = options || {}
      if (!selection) return
      const targetPage = Math.max(1, Math.round(num(selection.page, pageRef.current)))
      const quote = selection.quote
      setSelectionResult({
        page: targetPage,
        quote,
        kind: 'quickTranslate',
        loading: true,
        status: 'translating',
        provider: opts.provider || preferredProvider,
        aiRefine: Boolean(opts.refine),
        startedAt: Date.now(),
      })
      quickTranslateText(quote, targetPage, Object.assign({}, opts, { rects: selection.rects }))
        .then((result) => {
          if (result && result.status === 'same-language') {
            setSelectionResult(null)
            notify('info', rt('reader.selection.alreadyChinese'))
            return
          }
          setSelectionResult(Object.assign({}, result, { kind: 'quickTranslate', loading: false }))
        })
        .catch((error) => {
          setSelectionResult({
            page: targetPage,
            quote,
            kind: 'quickTranslate',
            loading: false,
            status: 'error',
            provider: opts.provider || preferredProvider,
            aiRefine: Boolean(opts.refine),
            reason: describeError(error),
          })
        })
    },
    [notify, preferredProvider, quickTranslateText, rt, selection],
  )

  const refineQuickTranslation = React.useCallback(() => {
    const quote = selection ? selection.quote : selectionResult && selectionResult.quote
    const targetPage = selection ? selection.page : selectionResult && selectionResult.page
    if (!quote) return
    setSelectionResult((previous) =>
      previous
        ? Object.assign({}, previous, { loading: true, status: 'translating', provider: 'llm', aiRefine: true, startedAt: Date.now() })
        : previous,
    )
    quickTranslateText(quote, targetPage, { provider: 'llm', fast: true, refine: true, detect: false, rects: (selection && selection.rects) || (selectionResult && selectionResult.rects) })
      .then((result) => setSelectionResult(Object.assign({}, result, { kind: 'quickTranslate', loading: false, aiRefine: true })))
      .catch((error) => {
        setSelectionResult((previous) =>
          previous
            ? Object.assign({}, previous, { loading: false, status: 'error', reason: describeError(error), aiRefine: true })
            : previous,
        )
      })
  }, [quickTranslateText, selection, selectionResult])

  const quickTranslateAnnotation = React.useCallback(
    (annotation) => {
      const text = firstText(annotation && annotation.quote, annotation && annotation.comment)
      return quickTranslateText(text, annotation && annotation.page, { detect: false, rects: annotation && annotation.rects })
    },
    [quickTranslateText],
  )

  const aiTranslateAnnotation = React.useCallback(
    (annotation) => {
      const text = firstText(annotation && annotation.quote, annotation && annotation.comment)
      return quickTranslateText(text, annotation && annotation.page, { detect: false, provider: 'llm', fast: true, refine: true, rects: annotation && annotation.rects })
    },
    [quickTranslateText],
  )

  /* ------------------------------ selection actions ---------------------- */
  const highlightSelection = React.useCallback(
    (color) => {
      if (!selection) return
      const chosen = color || lastColor.current || DEFAULT_COLOR
      lastColor.current = chosen
      const target = {
        page: selection.page || pageRef.current,
        quote: selection.quote,
        rects: selection.rects,
      }
      // Dismiss the floating toolbar immediately: the annotation appears
      // optimistically and a failed write still reports through a toast.
      clearNativeSelection()
      setSelection(null)
      setSelectionResult(null)
      createAnnotation({
        page: target.page,
        kind: 'highlight',
        quote: target.quote,
        rects: target.rects,
        color: chosen,
        comment: '',
        origin: 'user_note',
      })
        .then(() => notifyUndo('success', rt('reader.annot.created')))
        .catch((error) => notify('error', rt('reader.annot.failed', { message: describeError(error) })))
    },
    [createAnnotation, notifyUndo, notify, rt, selection],
  )

  const citeSelection = React.useCallback(() => {
    if (!selection) return
    const chosen = lastColor.current || DEFAULT_COLOR
    const target = {
      page: selection.page || pageRef.current,
      quote: selection.quote,
      rects: selection.rects,
    }
    clearNativeSelection()
    setSelection(null)
    setSelectionResult(null)
    createAnnotation({
      page: target.page,
      kind: 'highlight',
      quote: target.quote,
      rects: target.rects,
      color: chosen,
      comment: '',
      origin: 'user_note',
    })
      .then((saved) => {
        notifyUndo('success', rt('reader.annot.created'))
        return commitMaterials([{ kind: 'annotation', id: saved.id, page: saved.page, title: target.quote }])
      })
      .catch((error) => notify('error', rt('reader.toast.citeFailed', { message: describeError(error) })))
  }, [commitMaterials, createAnnotation, notifyUndo, notify, rt, selection])

  const sendQuickTranslation = React.useCallback(() => {
    if (!selection || !selectionResult) return
    const target = { page: selection.page || pageRef.current, quote: selection.quote, rects: selection.rects }
    const translationText = firstText(selectionResult.translation)
    if (!translationText) return
    createAnnotation({
      page: target.page,
      kind: 'highlight',
      quote: target.quote,
      rects: target.rects,
      color: lastColor.current || DEFAULT_COLOR,
      comment: translationText,
      origin: 'user_note',
    })
      .then((saved) => {
        return commitMaterials([{ kind: 'annotation', id: saved.id, page: saved.page, title: target.quote }]).then(() => {
          notifyUndo('success', rt('reader.selection.sentToChat'))
        })
      })
      .catch((error) => notify('error', rt('reader.toast.citeFailed', { message: describeError(error) })))
  }, [commitMaterials, createAnnotation, notifyUndo, notify, rt, selection, selectionResult])

  const handleSelectionAction = React.useCallback(
    (action, payload) => {
      if (action === 'closeResult') {
        setSelectionResult(null)
        return
      }
      if (!selection) return
      if (action === 'highlight') {
        highlightSelection(payload && payload.color)
        return
      }
      if (action === 'copy') {
        copyText(selection.quote).then((ok) => notify(ok ? 'success' : 'error', ok ? rt('reader.toast.copied') : rt('reader.toast.copyFailed')))
        return
      }
      if (action === 'quickTranslate') {
        quickTranslateSelection()
        return
      }
      if (action === 'copyQuickTranslation') {
        const value = firstText(selectionResult && selectionResult.translation)
        if (value) copyText(value).then((ok) => notify(ok ? 'success' : 'error', ok ? rt('reader.toast.copied') : rt('reader.toast.copyFailed')))
        return
      }
      if (action === 'replaceQuickTranslation') {
        setSelectionResult((previous) => (previous ? Object.assign({}, previous, { replace: true }) : previous))
        return
      }
      if (action === 'closeReplace') {
        setSelectionResult((previous) => (previous ? Object.assign({}, previous, { replace: false }) : previous))
        return
      }
      if (action === 'sendQuickTranslation') {
        sendQuickTranslation()
        return
      }
      if (action === 'refineQuickTranslation') {
        refineQuickTranslation()
        return
      }
      if (action === 'retryQuickTranslation') {
        quickTranslateSelection(selectionResult && selectionResult.aiRefine ? { provider: 'llm', fast: true, refine: true } : undefined)
        return
      }
      if (action === 'explain') {
        askAi({ type: 'explain', quote: selection.quote, auto: true, includeImage: false })
        return
      }
      if (action === 'ask') {
        askAi({ type: 'ask', quote: selection.quote, prompt: '', auto: false, includeImage: false })
        notify('info', rt('reader.toast.selectionAsk'))
        return
      }
      if (action === 'cite') citeSelection()
    },
    [askAi, citeSelection, highlightSelection, notify, notifyUndo, quickTranslateSelection, refineQuickTranslation, rt, selection, selectionResult, sendQuickTranslation],
  )

  /* ------------------------------ area / note ---------------------------- */
  const createArea = React.useCallback(
    (rect) => {
      const normalized = normalizeRect(rect)
      if (!normalized || normalized.w < 0.01 || normalized.h < 0.008) {
        notify('info', rt('reader.toast.regionTooSmall'))
        return
      }
      createAnnotation({
        page: pageRef.current,
        kind: 'area',
        quote: '',
        rects: [normalized],
        color: lastColor.current || DEFAULT_COLOR,
        comment: '',
        origin: 'user_note',
      })
        .then((saved) => {
          notifyUndo('success', rt('reader.annot.created'))
          setPopover({ id: saved.id, anchor: saved.rects[0] || normalized, autoFocus: true })
        })
        .catch((error) => notify('error', rt('reader.annot.failed', { message: describeError(error) })))
    },
    [createAnnotation, notifyUndo, notify, rt],
  )

  const [noteDraft, setNoteDraft] = React.useState(null)
  const createNote = React.useCallback((point) => {
    setNoteDraft({ page: pageRef.current, point, color: lastColor.current || DEFAULT_COLOR })
  }, [])
  const cancelNote = React.useCallback(() => setNoteDraft(null), [])
  const saveNote = React.useCallback(
    (payload) => {
      const point = payload.point || { x: 0.5, y: 0.5 }
      const rect = normalizeRect({
        x: clamp(point.x - 0.012, 0, 1),
        y: clamp(point.y - 0.012, 0, 1),
        w: 0.024,
        h: 0.024,
      })
      lastColor.current = payload.color || lastColor.current
      return createAnnotation({
        page: Math.max(1, Math.round(num(payload.page, pageRef.current))),
        kind: 'note',
        quote: '',
        rects: rect ? [rect] : [],
        color: payload.color || DEFAULT_COLOR,
        comment: payload.text,
        origin: 'user_note',
      })
        .then((saved) => {
          notifyUndo('success', rt('reader.note.created'))
          setNoteDraft(null)
          setPopover({ id: saved.id, anchor: saved.rects[0] || rect || { x: 0.5, y: 0.5, w: 0, h: 0 }, autoFocus: false })
          return saved
        })
        .catch((error) => {
          notify('error', rt('reader.note.failed', { message: describeError(error) }))
          throw error
        })
    },
    [createAnnotation, notifyUndo, notify, rt],
  )

  /* ------------------------------ annotation actions --------------------- */
  const askAnnotation = React.useCallback(
    (annotation) => {
      askAi({ type: 'ask', quote: firstText(annotation.quote, annotation.comment), prompt: '', auto: false })
    },
    [askAi],
  )
  const explainAnnotation = React.useCallback(
    (annotation) => {
      askAi({ type: 'explain', quote: firstText(annotation.quote, annotation.comment), auto: true })
    },
    [askAi],
  )
  const copyAnnotation = React.useCallback(
    (annotation) => {
      const text = firstText(annotation.quote, annotation.comment)
      copyText(text).then((ok) => notify(ok ? 'success' : 'error', ok ? rt('reader.annot.copyDone') : rt('reader.toast.copyFailed')))
    },
    [notify, rt],
  )
  const onAnnotationSelect = React.useCallback(
    (annotation) => {
      if (annotation.page !== pageRef.current) goToPage(annotation.page)
      const anchor =
        annotation.rects && annotation.rects.length > 0
          ? annotation.rects[0]
          : { x: 0.5, y: 0.25, w: 0, h: 0 }
      setPopover({ id: annotation.id, anchor, autoFocus: false })
    },
    [goToPage],
  )
  const deleteFromPopover = React.useCallback(
    (annotation) => {
      setPopover(null)
      deleteAnnotation(annotation).catch(() => {})
    },
    [deleteAnnotation],
  )

  /* ------------------------------ search --------------------------------- */
  const emptySearch = React.useCallback(() => ({ open: false, query: '', hits: [], index: 0, focus: null, forPage: 0, forVersion: -1 }), [])
  const [search, setSearch] = React.useState(emptySearch)
  const focusSeq = React.useRef(0)

  React.useEffect(() => {
    if (!search.open) return
    const query = search.query
    if (!query.trim()) {
      setSearch((previous) =>
        previous.hits.length === 0 && previous.index === 0 && !previous.focus
          ? previous
          : Object.assign({}, previous, { hits: [], index: 0, focus: null, forPage: 0, forVersion: -1 }),
      )
      return
    }
    const layerEntry = layerCache.current.get(page)
    let hits = []
    if (layerEntry && layerEntry.paperId === paperId && layerEntry.status === 'ready') {
      hits = findLayerMatches(layerEntry.data, query)
    }
    if (hits.length === 0) {
      const dataEntry = pageCache.current.get(page)
      if (dataEntry && dataEntry.paperId === paperId && dataEntry.status === 'ready') {
        hits = findBlockMatches(dataEntry.data, query)
      }
    }
    const withPage = hits.map((hit) => Object.assign({}, hit, { page }))
    setSearch((previous) => {
      if (
        previous.open &&
        previous.query === query &&
        previous.forPage === page &&
        previous.forVersion === dataVersion
      ) {
        return previous
      }
      focusSeq.current += 1
      return Object.assign({}, previous, {
        hits: withPage,
        index: 0,
        forPage: page,
        forVersion: dataVersion,
        focus: withPage.length > 0 ? { page, rect: withPage[0].rects[0], seq: focusSeq.current } : null,
      })
    })
  }, [paperId, page, search.open, search.query, dataVersion])

  const toggleSearch = React.useCallback(
    (open) => {
      setSearch((previous) => {
        if (open) return Object.assign({}, previous, { open: true, focus: previous.focus })
        return emptySearch()
      })
    },
    [emptySearch],
  )
  const setSearchQuery = React.useCallback((query) => {
    setSearch((previous) => Object.assign({}, previous, { query, hits: [], index: 0, focus: null, forPage: 0, forVersion: -1 }))
  }, [])
  const searchNext = React.useCallback(
    (delta) => {
      setSearch((previous) => {
        if (!previous.open || previous.hits.length === 0) {
          notify('info', rt('reader.search.none'))
          return previous
        }
        const index = (previous.index + delta + previous.hits.length) % previous.hits.length
        const hit = previous.hits[index]
        if (!hit) return previous
        focusSeq.current += 1
        return Object.assign({}, previous, {
          index,
          focus: { page: hit.page, rect: hit.rects[0], seq: focusSeq.current },
        })
      })
    },
    [notify, rt],
  )

  /* ------------------------------ keyboard ------------------------------- */
  React.useEffect(() => {
    if (typeof window === 'undefined') return undefined
    const onKeyDown = (event) => {
      const target = event.target
      const editable = target && target.closest && target.closest('input, textarea, [contenteditable="true"]')
      const meta = event.metaKey || event.ctrlKey
      // v0.3 §2.2.4: the core installs the global ⌘Z/⌘⇧Z shortcut when the undo
      // context is injected; only the standalone fallback handles it here.
      if (!undoApi.external && meta && !editable && (event.key === 'z' || event.key === 'Z')) {
        if (event.shiftKey) {
          if (!undoApi.canRedo) return
          event.preventDefault()
          Promise.resolve(undoApi.redo())
            .then((entry) => {
              if (entry) notify('info', rt('reader.undo.redone', { label: entry.label }))
            })
            .catch((error) => notify('error', rt('reader.undo.failed', { message: describeError(error) })))
          return
        }
        if (!undoApi.canUndo) return
        event.preventDefault()
        Promise.resolve(undoApi.undo())
          .then((entry) => {
            if (entry) notify('info', rt('reader.undo.done', { label: entry.label }))
          })
          .catch((error) => notify('error', rt('reader.undo.failed', { message: describeError(error) })))
        return
      }
      if (meta && (event.key === 'f' || event.key === 'F')) {
        event.preventDefault()
        toggleSearch(true)
        return
      }
      if (meta && (event.key === '+' || event.key === '=')) {
        event.preventDefault()
        zoomStep(1)
        return
      }
      if (meta && event.key === '-') {
        event.preventDefault()
        zoomStep(-1)
        return
      }
      if (event.key === 'Escape') {
        if (noteDraft) {
          setNoteDraft(null)
          return
        }
        if (popover) {
          setPopover(null)
          return
        }
        if (tool !== 'select') {
          setTool('select')
          return
        }
        if (search.open) {
          toggleSearch(false)
          return
        }
        if (selection) {
          clearSelection()
        }
        return
      }
      // v0.17 floating tools: keep the shortcuts the toolbar advertises.
      if (!editable && !meta && event.altKey && !event.shiftKey) {
        const lower = String(event.key || '').toLowerCase()
        if (lower === 'a') {
          event.preventDefault()
          changeTool(tool === 'area' ? 'select' : 'area')
          return
        }
        if (lower === 'n') {
          event.preventDefault()
          changeTool(tool === 'note' ? 'select' : 'note')
          return
        }
        if (lower === 'h') {
          event.preventDefault()
          if (selection) highlightSelection(penColor)
          else notify('info', rt('reader.tools.highlightHint'))
          return
        }
      }
      if (editable || meta) return
      if (event.key === 'ArrowLeft' && event.altKey) {
        event.preventDefault()
        goToPage(pageRef.current - 1)
      }
      if (event.key === 'ArrowRight' && event.altKey) {
        event.preventDefault()
        goToPage(pageRef.current + 1)
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [changeTool, clearSelection, goToPage, highlightSelection, noteDraft, notify, penColor, popover, rt, search.open, selection, tool, toggleSearch, undoApi, zoomStep])

  /* ------------------------------ paper lifecycle ------------------------ */
  const resetKeyRef = React.useRef(paperId)
  React.useEffect(() => {
    if (!paperId) return
    if (resetKeyRef.current === paperId) return
    resetKeyRef.current = paperId
    const explicit = Math.round(num(props.initialPage, 0))
    const restored = explicit > 0 ? explicit : readReadingPosition(paperId)
    const target = restored > 0 ? restored : 1
    setPage(target)
    jumpSeq.current += 1
    setJump({ page: target, seq: jumpSeq.current })
    setAnnotations(NO_ANNOTATIONS)
    setSelection(null)
    setSelectionResult(null)
    setPopover(null)
    setNoteDraft(null)
    setTool('select')
    setTranslations({})
    setSearch(emptySearch())
    setAiRequest(null)
    pageCache.current = new Map()
    layerCache.current = new Map()
    setDataVersion((value) => value + 1)
    const initial = firstText(props.annotationId)
    if (initial) {
      intentSeq.current += 1
      setAnnotationIntent({ id: initial, seq: intentSeq.current })
    } else {
      setAnnotationIntent(null)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [paperId])

  // Once the paper is open, clamp the restored page and emit the initial jump
  // (the page descriptor list is only known at this point).
  const jumpedRef = React.useRef('')
  React.useEffect(() => {
    if (openState.status !== 'ready' || !paperId) return
    if (jumpedRef.current === paperId) return
    jumpedRef.current = paperId
    const target = clamp(pageRef.current, 1, total)
    goToPage(target, { instant: true })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [openState.status, paperId, total])

  React.useEffect(() => {
    if (page > total) setPage(total)
  }, [page, total])

  // Reading position memory (host-settings API is not exposed in v0.2 yet, so
  // this stays a UI preference rather than authoritative data).
  React.useEffect(() => {
    if (!paperId) return undefined
    const timer = setTimeout(() => saveReadingPosition(paperId, page), 500)
    return () => clearTimeout(timer)
  }, [paperId, page])

  // Best-effort read marker.
  const markedRef = React.useRef('')
  React.useEffect(() => {
    if (openState.status !== 'ready' || !paperId) return undefined
    let alive = true
    Promise.resolve(apiCall('figures.list', { paperId }))
      .then((result) => {
        if (!alive) return
        const items = Array.isArray(result) ? result : Array.isArray(result && result.items) ? result.items : []
        setPaperFigures({ paperId, items })
      })
      .catch(() => { if (alive) setPaperFigures({ paperId, items: [] }) })
    return () => { alive = false }
  }, [apiCall, openState.status, paperId])

  React.useEffect(() => {
    if (openState.status !== 'ready' || !paperId || markedRef.current === paperId) return
    markedRef.current = paperId
    try {
      Promise.resolve(apiCall('library.setRead', { id: paperId, read: true, operationId: newOperationId('read') })).catch(() => {
        /* optional Host capability */
      })
    } catch {
      /* optional Host capability */
    }
  }, [apiCall, openState.status, paperId])

  /* ------------------------------ derived -------------------------------- */
  const pageEntry = getPageData(page)
  const translation = translations[page] || null
  const pagesForRail = pages
  const rawT = props.t || rt
  const sideTabs = [
    { id: 'outline', label: rt('reader.outline.title'), count: outlineItems.length || null },
    { id: 'annotations', label: rt('reader.annot.listTitle'), count: annotations.length || null },
    { id: 'figures', label: rt('reader.figures.tab') },
    { id: 'notes', label: rt('reader.notes.tab') },
    { id: 'ai', label: 'AI' },
  ]
  const canvasActions = {
    onSelection: handleSelection,
    onSelectionAction: handleSelectionAction,
    onAnnotationOpen: openAnnotation,
    onAnnotationClose: closePopover,
    onUpdateAnnotation: updateAnnotation,
    onDeleteAnnotation: deleteFromPopover,
    onCopyAnnotation: copyAnnotation,
    onCiteAnnotation: citeAnnotation,
    onLinkAnnotationNote: linkAnnotationToNote,
    onAskAnnotation: askAnnotation,
    onExplainAnnotation: explainAnnotation,
    onQuickTranslateAnnotation: quickTranslateAnnotation,
    onAiTranslateAnnotation: aiTranslateAnnotation,
    onCreateArea: createArea,
    onNoteCreate: createNote,
    onNoteSave: saveNote,
    onNoteCancel: cancelNote,
  }

  /* ------------------------------ early states --------------------------- */
  if (!paperId) {
    return React.createElement(StateScreen, {
      t: rt,
      icon: 'warning',
      tone: 'error',
      title: rt('reader.error.title'),
      desc: rt('reader.noPaper'),
      onBack: props.onBack,
    })
  }
  if (openState.status === 'error' && !detail) {
    const offline = isOfflineError(openState.error)
    return React.createElement(StateScreen, {
      t: rt,
      icon: 'warning',
      tone: 'error',
      title: offline ? rt('reader.offline.title') : rt('reader.error.title'),
      desc: offline ? rt('reader.offline.desc') : rt('reader.error.desc', { message: describeError(openState.error) }),
      retry: openState.reload,
      onBack: props.onBack,
    })
  }
  if (!detail && openState.status === 'loading') {
    return React.createElement(StateScreen, { t: rt, loading: true, onBack: props.onBack })
  }

  /* ------------------------------ panel bodies --------------------------- */
  let sideBody = null
  if (sideTab === 'outline') {
    sideBody = React.createElement(
      'div',
      { className: 'ph-r-side__scroll ph-r-scroll' },
      React.createElement(Outline, {
        t: rt,
        items: outlineItems,
        page,
        loading: outlineState.status === 'loading',
        error: outlineState.status === 'error' ? describeError(outlineState.error) : '',
        onJump: (target) => goToPage(target),
        onRetry: outlineState.reload,
      }),
    )
  } else if (sideTab === 'annotations') {
    sideBody = React.createElement(
      'div',
      { className: 'ph-r-side__scroll ph-r-scroll' },
      React.createElement('div', { className: 'ph-r-side__hint' }, rt('reader.annot.hint')),
      React.createElement(AnnotationListPanel, {
        t: rt,
        annotations,
        page,
        activeId: activeAnnotationId,
        onSelect: onAnnotationSelect,
        onCite: citeAnnotation,
        onLinkNote: linkAnnotationToNote,
        onDelete: (annotation) => deleteAnnotation(annotation).catch(() => {}),
      }),
    )
  } else if (sideTab === 'notes') {
    sideBody = React.createElement(ReaderNotesPanel, {
      t: rawT,
      api: apiCall,
      paperId,
      paper,
      sessionId: props.sessionId,
      notify,
      onOpenNoteLibrary: props.onOpenNoteLibrary,
      onOpenPaper: (targetPaperId, targetPage) => {
        if (props.onOpenPaper) props.onOpenPaper(targetPaperId, targetPage || 1)
      },
    })
  } else if (sideTab === 'figures') {
    sideBody = React.createElement('div', { className: 'ph-r-side__scroll ph-r-scroll' },
      React.createElement(ReaderFiguresPanel, {
        t: rt,
        api: apiCall,
        paperId,
        paper,
        onOpenFigure: (figure) => {
          if (!figure) return
          goToPage(Number(figure.page) || 1)
          setFigureFocus({ figureId: String(figure.id), page: Number(figure.page) || 1, bbox: figure.bbox || null, figureLabel: figure.label || '', seq: Date.now() })
          if (figureFocusTimer.current) clearTimeout(figureFocusTimer.current)
          figureFocusTimer.current = setTimeout(() => setFigureFocus(null), 4600)
        },
        onOpenNoteInsert: insertFigureIntoNote,
      }),
    )
  } else {
    sideBody = React.createElement(AiPanel, {
      t: rt,
      api: apiCall,
      paperId,
      page,
      paper,
      selection,
      request: aiRequest,
      onJumpPage: (target) => goToPage(target),
      onCiteAnswer: citeAiAnswer,
      onClearSelection: clearSelection,
      notify,
      sessionId: props.sessionId,
      onOpenSettings: props.onOpenSettings,
    })
  }

  // v0.17: page translation no longer owns a side tab — it is a docked sheet the
  // 原文/对照/仅译文 segment opens over the canvas (same BilingualPanel body).
  const translationSheet =
    mode === 'source'
      ? null
      : React.createElement(
          'div',
          {
            className: 'ph-r-tr',
            style: {
              left: 'var(--ph-r-rail)',
              right: sideOpen ? 'var(--ph-r-side)' : '0px',
            },
            'data-ph-translation-sheet': 'true',
          },
          React.createElement(
            'div',
            { className: 'ph-r-tr__head' },
            React.createElement(Icon, { name: 'translate', size: 14 }),
            React.createElement('span', { className: 'ph-r-tr__title' }, rt('reader.translation.sheet')),
            React.createElement(
              'div',
              {
                className: cx('ph-r-tr__modes', trSlider.rect && 'ph-r-tr__modes--sliding'),
                ref: trSlider.ref,
                role: 'group',
                'aria-label': rt('reader.translation.sheet'),
              },
              React.createElement(SlidingThumb, { rect: trSlider.rect, popKey: mode }),
              React.createElement(
                'button',
                {
                  type: 'button',
                  'data-ph-active': mode === 'compare' ? 'true' : undefined,
                  className: cx('ph-r-tr__mode', mode === 'compare' && 'ph-r-tr__mode--active'),
                  onClick: () => changeMode('compare'),
                },
                rt('reader.translation.mode.compare'),
              ),
              React.createElement(
                'button',
                {
                  type: 'button',
                  'data-ph-active': mode === 'translation' ? 'true' : undefined,
                  className: cx('ph-r-tr__mode', mode === 'translation' && 'ph-r-tr__mode--active'),
                  onClick: () => changeMode('translation'),
                },
                rt('reader.translation.mode.translation'),
              ),
            ),
            React.createElement('span', { className: 'ph-r-tr__spacer' }),
            React.createElement(IconBtn, { icon: 'close', title: rt('reader.translation.close'), onClick: () => changeMode('source') }),
          ),
          React.createElement(
            'div',
            { className: 'ph-r-tr__body ph-r-scroll' },
            React.createElement(BilingualPanel, {
              t: rt,
              page,
              total,
              mode: mode === 'translation' ? 'translation' : 'compare',
              blocksEntry: pageEntry,
              structurePending: Boolean(pageEntry && pageEntry.status === 'ready' && pageEntry.data && pageEntry.data.structureState === 'pending'),
              translation,
              providerPreference: preferredProvider,
              providerLabel: providerLabel(preferredProvider),
              onTranslatePage: (force) => translatePage(force),
              onAiTranslatePage: () => translateAiPage(),
              onTranslateBlock: (block) => translateBlock(block),
              onRetryBlocks: () => retryPage(page),
              onRetryLayer: () => retryLayer(page),
            }),
          ),
        )

  /* ------------------------------ render --------------------------------- */
  return React.createElement(
    'div',
    {
      className: cx(
        'ph-r-reader',
        scrolled && 'ph-r-reader--scrolled',
        search.open && 'ph-r-reader--searching',
        tool !== 'select' && 'ph-r-reader--tool-active',
      ),
      'data-ph-reader': paperId,
    },
    React.createElement(ReaderToolbar, {
      t: rt,
      paper,
      total,
      page,
      zoom,
      mode,
      tool,
      sideOpen,
      sideTab,
      search,
      loading: openState.status === 'loading',
      onBack: props.onBack,
      onCite: citePaperPage,
      noteContext,
      onLinkNote: linkCurrentPaper,
      onPage: (target) => goToPage(target),
      onZoomStep: zoomStep,
      onZoomFit: zoomFit,
      onMode: changeMode,
      onTool: changeTool,
      onSearchToggle: toggleSearch,
      onSearchQuery: setSearchQuery,
      onSearchNext: searchNext,
      onToggleAi: () => (sideOpen && sideTab === 'ai' ? setSideOpen(false) : openSide('ai')),
      onToggleNotes: () => (sideOpen && sideTab === 'notes' ? setSideOpen(false) : openSide('notes')),
      onToggleSide: toggleSide,
      onOpenSettings: props.onOpenSettings,
    }),
    tool !== 'select'
      ? React.createElement(
          'div',
          { className: 'ph-r-modehint' },
          React.createElement(Icon, { name: tool === 'area' ? 'area' : 'sticky', size: 14 }),
          React.createElement('span', null, tool === 'area' ? rt('reader.areaModeActive') : rt('reader.noteModeActive')),
          React.createElement(
            'button',
            { type: 'button', className: 'ph-r-toolbtn', onClick: () => changeTool('select') },
            rt('reader.exitMode'),
          ),
        )
      : null,
    React.createElement(
      'div',
      { className: 'ph-r-body' },
      React.createElement(Thumbnails, {
        t: rt,
        paperId,
        pages: pagesForRail,
        total,
        page,
        onSelect: (target) => goToPage(target),
      }),
      React.createElement(PageCanvas, {
        t: rt,
        paperId,
        pages,
        total,
        page,
        zoom,
        jump,
        focus: search.focus,
        figureFocus: figureFocus,
        figures: paperFigures.paperId === paperId ? paperFigures.items : null,
        mode: tool,
        annotations,
        activeAnnotationId,
        selection,
        selectionResult,
        onOpenSettings: props.onOpenSettings,
        popover: popoverProp,
        noteDraft,
        search,
        reducedMotion,
        dataVersion,
        getPageData,
        getLayer,
        ensurePage,
        ensureLayer,
        onPageChange: (next) => setPage((previous) => (previous === next ? previous : next)),
        onScrolledChange: handleScrolledChange,
        actions: canvasActions,
      }),
      React.createElement(
        'aside',
        { className: cx('ph-r-side', !sideOpen && 'ph-r-side--closed'), 'aria-label': rt('reader.sidePanel') },
        React.createElement(
          'div',
          { className: 'ph-r-side__head' },
          React.createElement(Tabs, {
            items: sideTabs,
            value: sideTab,
            onChange: (id) => {
              setSideTab(id)
              setSideOpen(true)
            },
            'aria-label': rt('reader.sidePanel'),
            className: 'ph-r-side__tabs',
          }),
          React.createElement(IconBtn, { icon: 'close', title: rt('reader.sidePanelToggle'), onClick: toggleSide }),
        ),
        React.createElement('div', { className: 'ph-r-side__body' }, sideBody),
      ),
      translationSheet,
      React.createElement(FloatingAnnotationTools, {
        t: rt,
        tool,
        selectionActive: Boolean(selection && selection.quote),
        penColor,
        onTool: changeTool,
        onHighlight: (color) => highlightSelection(color),
        onPen: setPenColor,
        showTip: toolsTip,
        onDismissTip: dismissToolsTip,
        onShowTip: showToolsTip,
        sidePanelOpen: sideOpen,
        translationOpen: mode !== 'source',
      }),
    ),
    notices.toasts.length > 0
      ? React.createElement(
          'div',
          { className: 'ph-r-toasts', 'aria-live': 'polite' },
          notices.toasts.map((toast) =>
            React.createElement(
              'div',
              { key: toast.id, className: cx('ph-r-toast', 'ph-r-toast--' + toast.kind) },
              React.createElement(Icon, {
                name: toast.kind === 'success' ? 'check' : toast.kind === 'error' || toast.kind === 'warning' ? 'warning' : 'note',
                size: 13,
              }),
              React.createElement('span', null, toast.text),
              toast.action
                ? React.createElement(
                    'button',
                    {
                      type: 'button',
                      className: 'ph-r-toast__action',
                      onClick: () => {
                        notices.dismiss(toast.id)
                        try {
                          toast.action.onClick()
                        } catch (error) {
                          console.warn('[pappers-hall] toast action failed', error)
                        }
                      },
                    },
                    toast.action.label,
                  )
                : null,
            ),
          ),
        )
      : null,
  )
}
