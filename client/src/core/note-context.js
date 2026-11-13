/**
 * Cross-surface bridge for the note currently being edited.
 *
 * The reader toolbar and annotation popover can act on the open note without
 * knowing which React tree hosts it. NoteEditor publishes a small command
 * object; ReaderShell subscribes. The bridge is in-memory only and clears when
 * the editor unmounts.
 */
let current = null
let listeners = new Set()
let revision = 0

function publish(next) {
  current = next
  revision += 1
  for (const listener of listeners) {
    try { listener() } catch (error) { console.warn('[pappers-hall] note-context listener failed', error) }
  }
}

export function getNoteContext() {
  return current
}

export function subscribeNoteContext(listener) {
  if (typeof listener !== 'function') return () => {}
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}

export function getNoteContextRevision() {
  return revision
}

/** Set the active note; pass null to clear only when the same note is active. */
export function setNoteContext(context, noteId) {
  if (context === null || context === undefined) {
    if (current === null) return
    if (noteId !== undefined && current.noteId !== String(noteId)) return
    publish(null)
    return
  }
  publish(context)
}

export function clearNoteContext(noteId) {
  setNoteContext(null, noteId)
}
