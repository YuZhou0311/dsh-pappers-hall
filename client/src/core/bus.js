/** Tiny typed event bus shared by plugin surfaces (palette, drag, undo feedback). */
const handlers = new Map()

export const bus = {
  on(event, handler) {
    if (typeof handler !== 'function') return () => {}
    const set = handlers.get(event) || new Set()
    set.add(handler)
    handlers.set(event, set)
    return () => set.delete(handler)
  },
  emit(event, payload) {
    const set = handlers.get(event)
    if (!set) return
    set.forEach((handler) => {
      try {
        handler(payload)
      } catch (error) {
        console.warn('[pappers-hall] bus handler failed', event, error)
      }
    })
  },
}
