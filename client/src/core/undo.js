/**
 * Client-side undo stack: local entries (label + optional thunk / operationId)
 * with a Host fallback through `operations.recent` → `operations.undo`.
 * ⌘Z / Ctrl+Z is installed once and survives panel switches.
 */
import { defaultApi } from './api.js'
import { notify } from './feedback.js'

const MAX_ENTRIES = 40
let entries = []
let redoStack = []
let busy = false
let installed = false
const listeners = new Set()

function emit() {
  listeners.forEach((listener) => listener())
}

let snapshotValue = { canUndo: false, canRedo: false, last: null, depth: 0 }
function snapshot() {
  return snapshotValue
}
function refreshSnapshot() {
  const last = entries[entries.length - 1]
  snapshotValue = { canUndo: entries.length > 0, canRedo: redoStack.length > 0, last: last || null, depth: entries.length }
}

export const undo = {
  /** Register an undoable action. `entry.undo` is preferred; `operationId` targets the Host log. */
  push(entry) {
    if (!entry) return
    entries.push({ label: String(entry.label || ''), at: Date.now(), undo: entry.undo || null, operationId: entry.operationId || null })
    if (entries.length > MAX_ENTRIES) entries.shift()
    redoStack = []
    refreshSnapshot()
    emit()
    return entry
  },
  getSnapshot: snapshot,
  subscribe(listener) {
    listeners.add(listener)
    return () => listeners.delete(listener)
  },
  async undoLast() {
    if (busy) return { ok: false, reason: 'busy' }
    busy = true
    try {
      let entry = entries.pop()
      let label = entry && entry.label
      let result = null
      if (entry && typeof entry.undo === 'function') {
        result = await entry.undo()
      } else {
        let target = entry && entry.operationId ? { id: entry.operationId, summary: label } : null
        if (!target) {
          const recent = await defaultApi('operations.recent', { limit: 10 })
          const item = (recent && Array.isArray(recent.items) ? recent.items : []).find((candidate) => candidate && !candidate.undone)
          if (!item) {
            if (entry) entries.push(entry)
            return { ok: false, reason: 'empty' }
          }
          target = item
          label = label || item.summary || item.kind
        }
        result = await defaultApi('operations.undo', { operationId: target.id })
        if (result && result.status === 'not_undoable') {
          if (entry) entries.push(entry)
          return { ok: false, reason: result.reason || 'not_undoable' }
        }
      }
      const record = entry || { label: label }
      redoStack.push(record)
      if (redoStack.length > MAX_ENTRIES) redoStack.shift()
      refreshSnapshot()
      emit()
      return { ok: true, label: label || '' }
    } catch (error) {
      return { ok: false, error: error }
    } finally {
      busy = false
    }
  },
  async redoLast() {
    if (busy || redoStack.length === 0) return { ok: false, reason: 'empty' }
    busy = true
    try {
      const record = redoStack.pop()
      if (record && typeof record.redo === 'function') await record.redo()
      else if (record && record.operationId) await defaultApi('operations.redo', { operationId: record.operationId })
      else return { ok: false, reason: 'not_redoable' }
      entries.push(record)
      refreshSnapshot()
      emit()
      return { ok: true, label: record.label || '' }
    } catch (error) {
      return { ok: false, error: error }
    } finally {
      busy = false
    }
  },
  clear() {
    entries = []
    redoStack = []
    refreshSnapshot()
    emit()
  },
}

/** Install the global ⌘Z / ⌘⇧Z shortcuts exactly once. */
export function installUndoShortcuts() {
  if (installed || typeof document === 'undefined') return
  installed = true
  document.addEventListener('keydown', (event) => {
    const meta = event.metaKey || event.ctrlKey
    if (!meta || String(event.key).toLowerCase() !== 'z') return
    const target = event.target
    if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable)) return
    event.preventDefault()
    // Host has no operations.redo yet; ⌘⇧Z is intentionally not bound so the
    // UI never claims a redo that cannot work. ⌘Z undo stays available.
    undo.undoLast().then((result) => {
      if (result.ok) {
        notify('success', '已撤销' + (result.label ? '：' + result.label : ''), null, 2600)
      } else if (result.reason === 'empty') {
        notify('info', '没有可撤销的操作', null, 1800)
      } else if (result.reason && result.reason !== 'busy') {
        notify('warning', '无法撤销：' + result.reason, null, 3000)
      }
    })
  })
}
