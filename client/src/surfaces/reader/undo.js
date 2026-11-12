/**
 * Reader undo/redo adapter.
 *
 * v0.3 integration (client-engineer, 2026-11-10):
 *   core/undo.js exports a singleton `undo` context with
 *     push({label, undo?, operationId?}) / undoLast() / redoLast() /
 *     getSnapshot() / subscribe()   and installs the global ⌘Z shortcut.
 * center.jsx injects it into ReaderShell as the `undo` prop.
 *
 * When that context is present the reader delegates to it entirely (single
 * global history, no duplicated keyboard handler). When it is absent (e.g.
 * isolated jsdom tests, older client bundle) the reader keeps a bounded local
 * stack with the same semantics, so standalone usage still has undo.
 */
import React from 'react'

/** Bounded history depth for the local fallback stack. */
const MAX_ENTRIES = 60

/** True when the injected value looks like the core undo context. */
export function isUndoContext(value) {
  return Boolean(value && typeof value.push === 'function' && typeof value.undoLast === 'function')
}

/** Create one observable local undo/redo store (standalone fallback). */
export function createUndoStore() {
  const state = { entries: [], redo: [], revision: 0, busy: false }
  const listeners = new Set()
  let snapshotValue = { revision: 0, busy: false, canUndo: false, canRedo: false, labels: [] }

  function refresh() {
    snapshotValue = {
      revision: state.revision,
      busy: state.busy,
      canUndo: state.entries.length > 0,
      canRedo: state.redo.length > 0,
      labels: state.entries.map((entry) => entry.label),
    }
  }

  function publish() {
    state.revision += 1
    refresh()
    listeners.forEach((listener) => {
      try {
        listener()
      } catch (error) {
        console.error('[pappers-hall] undo listener failed', error)
      }
    })
  }

  refresh()

  async function run(entry, direction) {
    state.busy = true
    publish()
    try {
      if (direction === 'undo') await entry.undo()
      else await entry.redo()
      return entry
    } finally {
      state.busy = false
      publish()
    }
  }

  return {
    getSnapshot() {
      return snapshotValue
    },
    subscribe(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    /** Register one completed, undoable action. */
    push(entry) {
      if (!entry || typeof entry.undo !== 'function') return
      state.entries.push({
        id: 'undo-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 6),
        label: String(entry.label || ''),
        undo: entry.undo,
        redo: typeof entry.redo === 'function' ? entry.redo : async () => {},
      })
      if (state.entries.length > MAX_ENTRIES) state.entries.splice(0, state.entries.length - MAX_ENTRIES)
      state.redo = []
      publish()
    },
    async undo() {
      if (state.busy) return null
      const entry = state.entries.pop()
      if (!entry) return null
      publish()
      try {
        return await run(entry, 'undo')
      } finally {
        state.redo.push(entry)
        publish()
      }
    },
    async redo() {
      if (state.busy) return null
      const entry = state.redo.pop()
      if (!entry) return null
      publish()
      try {
        return await run(entry, 'redo')
      } finally {
        state.entries.push(entry)
        publish()
      }
    },
    clear() {
      state.entries = []
      state.redo = []
      publish()
    },
  }
}

const EMPTY_SNAPSHOT = { revision: 0, busy: false, canUndo: false, canRedo: false, labels: [] }

/**
 * Hook returning a uniform `{push, undo, redo, canUndo, canRedo, external}` API.
 * `external` is the core undo context injected by center.jsx (preferred path).
 */
export function useReaderUndo(external) {
  const storeRef = React.useRef(null)
  if (storeRef.current === null) storeRef.current = createUndoStore()
  const store = storeRef.current
  const externalActive = isUndoContext(external)
  const localSnapshot = React.useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot)

  const subscribeExternal = React.useCallback(
    (listener) => {
      if (!externalActive) return () => {}
      try {
        const unsubscribe = external.subscribe(listener)
        return typeof unsubscribe === 'function' ? unsubscribe : () => {}
      } catch {
        return () => {}
      }
    },
    [external, externalActive],
  )
  const externalSnapshot = React.useCallback(() => {
    if (!externalActive) return EMPTY_SNAPSHOT
    try {
      return external.getSnapshot() || EMPTY_SNAPSHOT
    } catch {
      return EMPTY_SNAPSHOT
    }
  }, [external, externalActive])
  const externalState = React.useSyncExternalStore(subscribeExternal, externalSnapshot, externalSnapshot)

  const push = React.useCallback(
    (entry) => {
      if (externalActive) {
        try {
          external.push({
            label: entry.label,
            undo: entry.undo,
            operationId: entry.operationId,
          })
          return
        } catch (error) {
          console.warn('[pappers-hall] global undo rejected the entry, using local stack', error)
        }
      }
      store.push(entry)
    },
    [external, externalActive, store],
  )

  const undo = React.useCallback(async () => {
    if (externalActive) {
      try {
        const result = await external.undoLast()
        if (result && result.ok === false) return null
        return { label: (result && result.label) || '' }
      } catch (error) {
        console.warn('[pappers-hall] global undo failed', error)
        return null
      }
    }
    return store.undo()
  }, [external, externalActive, store])

  const redo = React.useCallback(async () => {
    if (externalActive) {
      try {
        const result = await external.redoLast()
        if (result && result.ok === false) return null
        return { label: (result && result.label) || '' }
      } catch (error) {
        console.warn('[pappers-hall] global redo failed', error)
        return null
      }
    }
    return store.redo()
  }, [external, externalActive, store])

  const snapshot = externalActive ? externalState : localSnapshot
  return {
    push,
    undo,
    redo,
    clear: store.clear,
    canUndo: Boolean(snapshot && snapshot.canUndo),
    canRedo: Boolean(snapshot && snapshot.canRedo),
    labels: (snapshot && snapshot.labels) || [],
    busy: Boolean(snapshot && snapshot.busy),
    external: externalActive,
  }
}
