/**
 * Paper Center router: the Zotero library, the figure-search surface and the
 * reader share one main panel. Navigation intents (tool cards, AI panel sources,
 * drawer rows) flow through the global navigation store, so any surface can ask
 * the reader to open a paper at a page/annotation.
 */
import React from 'react'
import { h } from '../core/dom.js'
import { ToastStack, useToasts } from '../core/primitives.jsx'
import { FeedbackHost } from '../core/feedback.js'
import { undo } from '../core/undo.js'
import { bus } from '../core/bus.js'
import { translationStore } from '../core/translation.js'
import { navigation } from '../core/navigation.js'
import { LibraryShell } from './library/shell.jsx'
import { FigureSearch } from './figure-search.jsx'
import { ReaderShell } from './reader/shell.jsx'
import { NotesWorkspace } from './notes/workspace.jsx'

function useNavigation() {
  return React.useSyncExternalStore(navigation.subscribe, navigation.getSnapshot, navigation.getSnapshot)
}

/** Read the current session id from the standard `useSessions` hook when present. */
function useSessionId(props) {
  const useSessions = typeof props.useSessions === 'function' ? props.useSessions : (selector) => selector({})
  let sessionId
  try {
    sessionId = useSessions((sessions) => (sessions && (sessions.current || sessions.selectedSessionId || sessions.selected)) || undefined)
  } catch (error) {
    sessionId = undefined
  }
  return typeof sessionId === 'string' ? sessionId : undefined
}

export function PaperCenter(props) {
  const t = props.t
  const api = props.api
  const pending = props.pending
  const library = props.library
  const nav = useNavigation()
  const sessionId = useSessionId(props)
  const { toasts, push, dismiss } = useToasts()
  const route = nav.route || { view: 'library' }

  // One-shot intents are consumed by the reader; clear the stale focus when the
  // library becomes visible again.
  React.useEffect(() => {
    if (route.view !== 'library') return
    navigation.consumeIntent()
  }, [route.view, nav.seq])

  const openPaper = React.useCallback((paperId, page, annotationId) => {
    if (!paperId) return
    navigation.openPaper({ paperId: paperId, page: page || 1, annotationId: annotationId || null, source: 'library' })
  }, [])

  const openFigure = React.useCallback((paperId, figure) => {
    if (!paperId || !figure) return
    navigation.openPaper({
      paperId: paperId,
      page: figure.page || 1,
      figureId: figure.id,
      figureLabel: figure.label || '',
      bbox: figure.bbox || null,
      source: 'details-figure',
    })
  }, [])

  if (route.view === 'reader' && route.paperId) {
    const summary = library.findPaper(route.paperId)
    return h(
      'div',
      { className: 'ph-app' },
      h(ReaderShell, {
        t: t,
        api: api,
        pending: pending,
        paperId: route.paperId,
        initialPage: route.page || 1,
        initialTab: route.annotationId ? 'annotations' : undefined,
        annotationId: route.annotationId || undefined,
        onBack: () => (route.returnTo === 'notes' ? navigation.backToNotes({ noteId: route.noteId }) : navigation.backToLibrary()),
        // v0.17: the reader notes tab can hand the current note to the library.
        onOpenNoteLibrary: (noteId) => navigation.openNotes({ noteId: noteId || null }),
        onOpenPaper: (paperId, page) => navigation.openPaper({ paperId: paperId, page: page || 1, source: 'reader' }),
        onToast: push,
        sessionId: sessionId,
        paper: summary || undefined,
        navigation: navigation,
        undo: undo,
        translation: translationStore,
        onOpenSettings: () => bus.emit('open-settings'),
      }),
      h(ToastStack, { toasts: toasts, onDismiss: dismiss }),
      h(FeedbackHost, null),
    )
  }

  if (route.view === 'notes') {
    return h(
      'div',
      { className: 'ph-app' },
      h(NotesWorkspace, {
        t: t,
        api: api,
        sessionId: sessionId,
        initialNoteId: route.noteId || '',
        onBack: () => navigation.backToLibrary(),
        onOpenPaper: (paperId, page, annotationId) =>
          navigation.openPaper({
            paperId: paperId,
            page: page || 1,
            annotationId: annotationId || null,
            source: 'notes',
            returnTo: 'notes',
            noteId: route.noteId || undefined,
          }),
        onOpenSettings: () => bus.emit('open-settings'),
      }),
      h(ToastStack, { toasts: toasts, onDismiss: dismiss }),
      h(FeedbackHost, null),
    )
  }

  if (route.view === 'figures') {
    return h(React.Fragment, null, h(LibraryShell, {
      t: t,
      api: api,
      pending: pending,
      library: library,
      figuresActive: true,
      onOpenPaper: openPaper,
      onOpenFigure: openFigure,
      figureContent: h(FigureSearch, {
        t: t,
        api: api,
        initialQuery: '',
        focusFigure:
          route.figureId && route.paperId
            ? { paperId: route.paperId, figureId: route.figureId, imageUrl: '/pappers-hall/figure/' + route.figureId + '.png?width=900' }
            : null,
        onBack: () => navigation.backToLibrary(),
        onFindSimilar: (figure) => navigation.openFigureSearch({ paperId: figure.paperId, figureId: figure.figureId, page: figure.page, label: figure.label, caption: figure.caption, imageUrl: figure.imageUrl, paperTitle: figure.paperTitle }),
      }),
    }),
      h(FeedbackHost, null),
    )
  }

  return h(
    React.Fragment,
    null,
    h(LibraryShell, {
      t: t,
      api: api,
      pending: pending,
      library: library,
      figuresActive: false,
      onOpenPaper: openPaper,
      onOpenFigure: openFigure,
      onOpenFigures: () => navigation.openFigureSearch({}),
      onFindSimilar: (figure) =>
        navigation.openFigureSearch({ paperId: figure.paperId, figureId: figure.id, page: figure.page, label: figure.label, caption: figure.caption, imageUrl: figure.imageUrl, paperTitle: '' }),
    }),
      h(FeedbackHost, null),
  )
}
