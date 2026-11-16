/**
 * Client-side onboarding state (task-based).
 *
 * The Host derives every task from the library itself, so this store only polls
 * `onboarding.status`, exposes a snapshot to React and runs the few actions a row
 * can trigger (import the sample, reset, finish, dismiss).
 */
import { defaultApi } from './api.js'

const EMPTY = { loaded: false, visible: false, tasks: [], doneCount: 0, total: 6, allDone: false, next: null, sample: null, state: null }

function createStore() {
  let state = EMPTY
  let listeners = new Set()
  let timer = null
  let inFlight = null

  function publish(next) {
    state = Object.assign({}, state, next)
    listeners.forEach((listener) => { try { listener() } catch (error) { console.error('[pappers-hall] onboarding listener failed', error) } })
  }

  function apply(payload) {
    if (payload === null || typeof payload !== 'object') return
    publish({
      loaded: true,
      visible: payload.visible === true,
      tasks: Array.isArray(payload.tasks) ? payload.tasks : [],
      doneCount: Number(payload.doneCount) || 0,
      total: Number(payload.total) || 6,
      allDone: payload.allDone === true,
      next: payload.next ?? null,
      sample: payload.sample ?? null,
      state: payload.state ?? null,
    })
  }

  async function refresh() {
    if (inFlight !== null) return inFlight
    inFlight = defaultApi('onboarding.status')
      .then((payload) => { apply(payload); return payload })
      .catch(() => null)
      .then((value) => { inFlight = null; return value })
    return inFlight
  }

  function stopPolling() {
    if (timer !== null) { clearInterval(timer); timer = null }
  }

  function startPolling(intervalMs = 2500) {
    if (timer !== null) return
    timer = setInterval(() => {
      if (typeof document !== 'undefined' && document.hidden === true) return
      refresh()
    }, intervalMs)
    refresh()
  }

  return {
    subscribe(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    getSnapshot() { return state },
    refresh,
    startPolling,
    stopPolling,
    /** Import the bundled sample PDF, remember it, and return its paper id. */
    async importSample() {
      const current = state.sample || {}
      if (typeof current.path !== 'string' || current.path === '') throw new Error('sample path unavailable')
      const result = await defaultApi('library.import', { paths: [current.path] })
      const accepted = (result && result.acceptedItems) || []
      const duplicates = (result && result.duplicates) || []
      const paperId = accepted.length > 0 ? accepted[0].paperId : duplicates.length > 0 ? duplicates[0].paperId : null
      if (paperId !== null) await defaultApi('onboarding.sampleImported', { paperId })
      await refresh()
      return paperId
    },
    async dismiss() {
      await defaultApi('onboarding.update', { patch: { dismissedAt: new Date().toISOString(), expanded: false } }).catch(() => {})
      await refresh()
    },
    async finish() {
      await defaultApi('onboarding.finish').catch(() => {})
      await refresh()
    },
    async reset() {
      await defaultApi('onboarding.reset').catch(() => {})
      await refresh()
    },
    async toggleExpanded(expanded) {
      await defaultApi('onboarding.update', { patch: { expanded: expanded === true } }).catch(() => {})
      await refresh()
    },
  }
}

/** Shared singleton: the library card and the reader coach read the same state. */
export const onboardingStore = createStore()
