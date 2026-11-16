/**
 * Sliding "bubble" highlight for grouped option controls (segmented buttons,
 * tab strips, vertical navigation lists).
 *
 * A control renders one absolutely-positioned bubble and marks its active child
 * with `data-ph-active="true"`. The hook measures that child after every render
 * and returns its box; CSS springs the bubble between positions and the inner
 * element replays a squash/pop each time the selection changes.
 *
 * Measurement is skipped when the control is not laid out (zero width), and the
 * caller then keeps its plain active style — the UI never depends on the effect
 * to be usable.
 */
import React from 'react'
import { h } from './dom.js'

/**
 * Measure the active child of a group.
 * @returns {{ ref: object, rect: null | {x:number,y:number,w:number,h:number} }}
 */
export function useSlidingThumb() {
  const ref = React.useRef(null)
  const [rect, setRect] = React.useState(null)

  const measure = React.useCallback(() => {
    const host = ref.current
    if (!host || typeof host.querySelector !== 'function') return
    const active = host.querySelector('[data-ph-active="true"]')
    const width = active ? active.offsetWidth || active.getBoundingClientRect().width : 0
    if (!active || !width) {
      setRect((previous) => (previous === null ? previous : null))
      return
    }
    const next = { x: active.offsetLeft, y: active.offsetTop, w: width, h: active.offsetHeight }
    setRect((previous) =>
      previous && previous.x === next.x && previous.y === next.y && previous.w === next.w && previous.h === next.h ? previous : next,
    )
  }, [])

  /* Layout is settled in the layout phase, so measuring synchronously avoids
     the one-frame gap a rAF would leave (and the cancel/reschedule race that
     came with it). */
  React.useLayoutEffect(measure)

  React.useEffect(() => {
    const host = ref.current
    if (!host) return undefined
    let observer = null
    if (typeof ResizeObserver !== 'undefined') {
      observer = new ResizeObserver(measure)
      try {
        observer.observe(host)
      } catch {
        observer = null
      }
    }
    if (typeof window !== 'undefined') window.addEventListener('resize', measure)
    return () => {
      if (observer) observer.disconnect()
      if (typeof window !== 'undefined') window.removeEventListener('resize', measure)
    }
  }, [measure])

  return { ref, rect }
}

/**
 * The bubble itself. Renders nothing until a measurement exists.
 * @param {object} props `rect` from {@link useSlidingThumb}; optional `inset`
 *   (vertical breathing room inside a tall tab), `height`, `alignBottom`
 *   (bar style), `popKey` (changing it replays the squash) and `className`.
 */
export function SlidingThumb(props) {
  const rect = props.rect
  if (!rect) return null
  const inset = props.inset || 0
  const height = props.height != null ? props.height : Math.max(2, rect.h - inset * 2)
  const top = props.alignBottom ? rect.y + rect.h - height : rect.y + inset
  return h(
    'span',
    {
      className: 'ph-thumb' + (props.className ? ' ' + props.className : ''),
      style: {
        width: rect.w + 'px',
        height: height + 'px',
        transform: 'translate(' + rect.x + 'px,' + top + 'px)',
      },
      'aria-hidden': 'true',
    },
    /* Remounting on selection change replays the squash/pop animation. */
    h('span', { key: props.popKey == null ? 'thumb' : String(props.popKey), className: 'ph-thumb__inner' }),
  )
}

/**
 * Run one View Transition around a DOM/React state update.
 *
 * This is deliberately a thin progressive-enhancement wrapper: unsupported
 * engines and reduced-motion users get the update immediately. Element-scoped
 * transitions are preferred when the caller supplies a scope element; the
 * fallback is the document transition, which is safe for the paper-grid view
 * switch because no top-layer surface is open at that point.
 *
 * @param {Element|Document|null} scope
 * @param {() => void} update
 */
export function withViewTransition(scope, update) {
  const run = typeof update === 'function' ? update : () => {}
  let reduced = false
  try { reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches } catch { reduced = false }
  if (reduced) { run(); return null }
  const target = scope && typeof scope.startViewTransition === 'function' ? scope : null
  // When a component scope is supplied, never fall back to a document-wide
  // transition: that would block the page and hide top-layer surfaces.
  const owner = target || (!scope && typeof document !== 'undefined' && typeof document.startViewTransition === 'function' ? document : null)
  if (!owner) { run(); return null }
  try {
    const transition = owner.startViewTransition(run)
    if (transition && transition.ready && typeof transition.ready.catch === 'function') transition.ready.catch(() => {})
    return transition
  } catch {
    run()
    return null
  }
}
