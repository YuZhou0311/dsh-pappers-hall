/**
 * Global feedback toasts. Surfaces mount <FeedbackHost> once; actions may carry
 * a primary affordance (e.g. 撤销) and an optional progress lifetime.
 */
import React from 'react'
import { h } from './dom.js'
import { Icon } from './icons.jsx'

let seq = 0
const items = []
let snapshot = { items: [] }
const listeners = new Set()

function emit() {
  snapshot = { items: items.slice() }
  listeners.forEach((listener) => listener())
}

function scheduleDismiss(id, timeout) {
  if (!timeout) return
  setTimeout(() => dismiss(id), timeout)
}

/** Show one toast; `action` is `{label, onClick}`. */
export function notify(tone, text, action, timeout) {
  const id = 'fb-' + ++seq
  items.push({ id: id, tone: tone || 'info', text: String(text || ''), action: action || null, createdAt: Date.now() })
  if (items.length > 4) items.shift()
  emit()
  scheduleDismiss(id, timeout === undefined ? (action ? 9000 : 4200) : timeout)
  return id
}

/** Remove one toast by id. */
export function dismiss(id) {
  const index = items.findIndex((item) => item.id === id)
  if (index < 0) return
  items.splice(index, 1)
  emit()
}

export function clearFeedback() {
  items.length = 0
  emit()
}

export const feedback = {
  getSnapshot() {
    return snapshot
  },
  subscribe(listener) {
    listeners.add(listener)
    return () => listeners.delete(listener)
  },
}

const TONES = { success: 'checkCircle', error: 'warning', warning: 'warning', info: 'info' }

/** Mount once per visible root (paper centre and conversation dock both mount it). */
export function FeedbackHost() {
  const snapshot = React.useSyncExternalStore(feedback.subscribe, feedback.getSnapshot, feedback.getSnapshot)
  if (snapshot.items.length === 0) return null
  return h(
    'div',
    { className: 'ph-fbhost', role: 'status', 'aria-live': 'polite' },
    snapshot.items.map((item) =>
      h(
        'div',
        { key: item.id, className: 'ph-fb ph-fb--' + (item.tone || 'info') },
        h(Icon, { name: TONES[item.tone] || 'info', size: 14 }),
        h('span', { className: 'ph-fb__text' }, item.text),
        item.action
          ? h(
              'button',
              {
                type: 'button',
                className: 'ph-fb__action',
                onClick: () => {
                  try {
                    item.action.onClick()
                  } catch (error) {
                    console.warn('[pappers-hall] feedback action failed', error)
                  }
                  dismiss(item.id)
                },
              },
              item.action.label,
            )
          : null,
        h('button', { type: 'button', className: 'ph-fb__close', title: 'dismiss', 'aria-label': 'dismiss', onClick: () => dismiss(item.id) }, h(Icon, { name: 'close', size: 11 })),
      ),
    ),
  )
}
