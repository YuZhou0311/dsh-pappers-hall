/**
 * Global paper navigation intent shared by every surface.
 *
 * The Zotero library, the reader, the AI tool cards in the conversation and the
 * reader's own source links all navigate through this one store. The Paper
 * Center subscribes to decide `library | reader | figures`; the reader consumes
 * one-shot intents (page / annotation focus) and can subscribe for later jumps.
 *
 * Shape: `{route:{view:'library'}|{view:'reader',paperId,page,annotationId,source,returnTo?,noteId?}
 *          |{view:'notes',noteId?,paperId?}|{view:'figures',...},
 *          intent:{kind:'paper'|'figure',paperId,page,figureId,annotationId,seq}|null,
 *          seq:number}`.
 */

function createStore() {
  let state = { route: { view: 'library' }, intent: null, seq: 0 }
  const listeners = new Set()

  function publish(next) {
    state = next
    listeners.forEach((listener) => {
      try {
        listener()
      } catch (error) {
        console.error('[pappers-hall] navigation listener failed', error)
      }
    })
  }

  function intentOf(kind, payload, sequence) {
    return {
      kind: kind,
      paperId: payload.paperId ? String(payload.paperId) : null,
      page: Number.isFinite(Number(payload.page)) ? Number(payload.page) : null,
      figureId: payload.figureId ? String(payload.figureId) : null,
      figureLabel: payload.figureLabel != null ? String(payload.figureLabel) : null,
      bbox: payload.bbox && typeof payload.bbox === 'object' ? payload.bbox : null,
      annotationId: payload.annotationId ? String(payload.annotationId) : null,
      seq: sequence,
    }
  }

  return {
    getSnapshot() {
      return state
    },
    subscribe(listener) {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    /** Open the reader on one paper (or jump to a page when already there). */
    openPaper(payload = {}) {
      const paperId = payload.paperId ? String(payload.paperId) : ''
      if (!paperId) return
      const page = Number.isFinite(Number(payload.page)) ? Number(payload.page) : 1
      const nextSeq = state.seq + 1
      // v0.17: notes library → reader hand-off keeps a return address so "返回"
      // lands back on the note instead of the paper library.
      const returnTo = payload.returnTo === 'notes' ? 'notes' : null
      publish({
        route: {
          view: 'reader',
          paperId: paperId,
          page: page,
          annotationId: payload.annotationId ? String(payload.annotationId) : null,
          source: payload.source || 'library',
          returnTo: returnTo,
          noteId: returnTo && payload.noteId ? String(payload.noteId) : null,
        },
        intent: intentOf(payload.figureId ? 'figure' : 'paper', Object.assign({}, payload, { page: page }), nextSeq),
        seq: nextSeq,
      })
    },
    /** Jump within the open reader, opening it when another paper is targeted. */
    jumpTo(payload = {}) {
      const paperId = payload.paperId ? String(payload.paperId) : ''
      const current = state.route
      if (!paperId || current.view !== 'reader' || current.paperId !== paperId) {
        this.openPaper(payload)
        return
      }
      const nextSeq = state.seq + 1
      const page = Number.isFinite(Number(payload.page)) ? Number(payload.page) : current.page
      publish({
        route: Object.assign({}, current, {
          page: page,
          annotationId: payload.annotationId ? String(payload.annotationId) : current.annotationId,
        }),
        intent: intentOf(payload.figureId ? 'figure' : 'paper', Object.assign({}, payload, { page: page }), nextSeq),
        seq: nextSeq,
      })
    },
    /** Show the standalone notes library (optionally focusing one note). */
    openNotes(payload = {}) {
      const nextSeq = state.seq + 1
      publish({
        route: {
          view: 'notes',
          noteId: payload.noteId ? String(payload.noteId) : null,
          paperId: payload.paperId ? String(payload.paperId) : null,
        },
        intent: null,
        seq: nextSeq,
      })
    },
    /** Return to the notes library from the reader opened out of it. */
    backToNotes(payload = {}) {
      const nextSeq = state.seq + 1
      publish({
        route: {
          view: 'notes',
          noteId: payload.noteId ? String(payload.noteId) : null,
          paperId: payload.paperId ? String(payload.paperId) : null,
        },
        intent: null,
        seq: nextSeq,
      })
    },
    /** Show the library (or the figure-search view) again. */
    backToLibrary(options = {}) {
      const nextSeq = state.seq + 1
      publish({ route: { view: options.view === 'figures' ? 'figures' : 'library' }, intent: null, seq: nextSeq })
    },
    /** Show the figure-search surface, optionally focused on one figure. */
    openFigureSearch(payload = {}) {
      const nextSeq = state.seq + 1
      publish({
        route: { view: 'figures', paperId: payload.paperId || null, figureId: payload.figureId || null },
        intent: intentOf('figure', payload, nextSeq),
        seq: nextSeq,
      })
    },
    /**
     * Read and clear the pending one-shot intent. Reading does not notify, so
     * callers can consume it from an effect without triggering a render loop.
     * @returns {object|null} the intent, or null when already consumed.
     */
    consumeIntent() {
      const intent = state.intent
      if (intent) state = Object.assign({}, state, { intent: null })
      return intent || null
    },
    /** Test helper: restore the initial library route without listeners. */
    reset() {
      state = { route: { view: 'library' }, intent: null, seq: state.seq + 1 }
    },
  }
}

/** The one navigation store every surface shares. */
export const navigation = createStore()

/** Idempotent factory for tests/embedding. */
export function createNavigationStore() {
  return navigation
}
