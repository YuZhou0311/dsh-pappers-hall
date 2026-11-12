/**
 * Shared atoms for the Pappers-Hall surfaces. Every colour and radius comes from
 * a DSH theme token through `core/styles.js` (class names are `ph-` prefixed).
 */
import React from 'react'
import { h } from './dom.js'
import { Icon } from './icons.jsx'
import { SlidingThumb, useSlidingThumb } from './motion.js'

/** Standard button. Variants: primary | secondary | ghost | danger | subtle. */
export function Button(props) {
  const variant = props.variant || 'secondary'
  const size = props.size || 'md'
  const classes = ['ph-btn', 'ph-btn--' + variant, 'ph-btn--' + size]
  if (props.active) classes.push('ph-btn--active')
  if (props.className) classes.push(props.className)
  return h(
    'button',
    {
      type: 'button',
      className: classes.join(' '),
      onClick: props.onClick,
      disabled: props.disabled || props.loading,
      title: props.title,
      'aria-label': props['aria-label'],
      'aria-pressed': props.active === undefined ? undefined : props.active ? 'true' : 'false',
      'aria-expanded': props['aria-expanded'],
      'aria-haspopup': props['aria-haspopup'],
    },
    props.loading ? h('span', { className: 'ph-spinner ph-spinner--inline', 'aria-hidden': 'true' }) : props.icon ? h(Icon, { name: props.icon, size: size === 'sm' ? 14 : size === 'lg' ? 18 : 15 }) : null,
    props.children == null ? null : h('span', { className: 'ph-btn__label' }, props.children),
  )
}

/** Icon-only button with an accessible name. */
export function IconButton(props) {
  const classes = ['ph-iconbtn']
  if (props.active) classes.push('ph-iconbtn--active')
  if (props.className) classes.push(props.className)
  return h(
    'button',
    {
      type: 'button',
      className: classes.join(' '),
      onClick: props.onClick,
      disabled: props.disabled,
      title: props.title,
      'aria-label': props['aria-label'] || props.title || props.icon,
      'aria-pressed': props.active === undefined ? undefined : props.active ? 'true' : 'false',
      'aria-expanded': props['aria-expanded'],
    },
    h(Icon, { name: props.icon, size: props.size || 15 }),
  )
}

/** Small status pill. */
export function Badge(props) {
  return h(
    'span',
    { className: 'ph-badge' + (props.tone ? ' ph-badge--' + props.tone : '') + (props.className ? ' ' + props.className : ''), title: props.title },
    props.icon ? h(Icon, { name: props.icon, size: 12 }) : null,
    props.children,
  )
}

/** Label + native checkbox. */
export function Check(props) {
  return h(
    'label',
    {
      className: 'ph-check' + (props.className ? ' ' + props.className : ''),
      onClick: (event) => event.stopPropagation(),
      title: props.title,
    },
    h('input', {
      type: 'checkbox',
      checked: Boolean(props.checked),
      disabled: props.disabled,
      onChange: () => {
        if (props.onChange) props.onChange(!props.checked)
      },
      'aria-label': props['aria-label'] || props.label,
    }),
    props.label ? h('span', { className: 'ph-check__label' }, props.label) : null,
  )
}

/** Search input with icon and optional clear control. */
export function SearchInput(props) {
  return h(
    'div',
    { className: 'ph-search' + (props.className ? ' ' + props.className : '') + (props.compact ? ' ph-search--compact' : '') },
    h(Icon, { name: 'search', size: 15, className: 'ph-search__icon' }),
    h('input', {
      type: 'search',
      value: props.value,
      placeholder: props.placeholder,
      'aria-label': props['aria-label'] || props.placeholder,
      onChange: (event) => props.onChange(event.target.value),
      onKeyDown: props.onKeyDown,
      disabled: props.disabled,
      autoFocus: props.autoFocus,
    }),
    props.loading ? h('span', { className: 'ph-spinner ph-spinner--inline', 'aria-hidden': 'true' }) : null,
    props.value && props.clearLabel
      ? h(IconButton, { icon: 'close', title: props.clearLabel, onClick: () => props.onChange(''), className: 'ph-search__clear' })
      : null,
  )
}

/** Horizontal tab strip. Variant: underline (default) | pill. */
export function TabStrip(props) {
  const variant = props.variant || 'underline'
  const slider = useSlidingThumb()
  const underline = variant === 'underline'
  return h(
    'div',
    {
      className: 'ph-tabs ph-tabs--' + variant + (slider.rect ? ' ph-tabs--sliding' : '') + (props.className ? ' ' + props.className : ''),
      ref: slider.ref,
      role: 'tablist',
      'aria-label': props['aria-label'],
    },
    h(SlidingThumb, {
      rect: slider.rect,
      popKey: props.value,
      className: underline ? 'ph-thumb--bar' : 'ph-thumb--pill',
      height: underline ? 3 : undefined,
      alignBottom: underline,
      inset: underline ? 0 : 3,
    }),
    (props.items || []).map((item) =>
      h(
        'button',
        {
          key: item.id,
          type: 'button',
          role: 'tab',
          'aria-selected': item.id === props.value ? 'true' : 'false',
          'data-ph-active': item.id === props.value ? 'true' : undefined,
          className: 'ph-tab' + (item.id === props.value ? ' ph-tab--active' : ''),
          onClick: () => props.onChange(item.id),
        },
        item.icon ? h(Icon, { name: item.icon, size: 14 }) : null,
        h('span', { className: 'ph-tab__label' }, item.label),
        item.count != null ? h('span', { className: 'ph-tab__count' }, String(item.count)) : null,
      ),
    ),
  )
}

/** Segmented control for mutually exclusive display modes. */
export function Segmented(props) {
  const slider = useSlidingThumb()
  return h(
    'div',
    {
      className: 'ph-segment' + (slider.rect ? ' ph-segment--sliding' : '') + (props.className ? ' ' + props.className : ''),
      ref: slider.ref,
      role: 'group',
      'aria-label': props['aria-label'],
    },
    h(SlidingThumb, { rect: slider.rect, popKey: props.value }),
    (props.items || []).map((item) =>
      h(
        'button',
        {
          key: item.id,
          type: 'button',
          'data-ph-active': item.id === props.value ? 'true' : undefined,
          className: 'ph-segment__item' + (item.id === props.value ? ' ph-segment__item--active' : ''),
          onClick: () => props.onChange(item.id),
          title: item.title,
          'aria-pressed': item.id === props.value ? 'true' : 'false',
        },
        item.icon ? h(Icon, { name: item.icon, size: 14 }) : null,
        item.label ? h('span', null, item.label) : null,
      ),
    ),
  )
}

/** Empty / offline / error state block. */
export function EmptyState(props) {
  return h(
    'div',
    { className: 'ph-empty' + (props.tone ? ' ph-empty--' + props.tone : '') + (props.compact ? ' ph-empty--compact' : '') + (props.className ? ' ' + props.className : '') },
    h(Icon, { name: props.icon || 'book', size: props.compact ? 26 : 40, className: 'ph-empty__icon' }),
    props.title ? h('p', { className: 'ph-empty__title' }, props.title) : null,
    props.desc ? h('p', { className: 'ph-empty__desc' }, props.desc) : null,
    props.action ? h('div', { className: 'ph-empty__action' }, props.action) : null,
  )
}

/** Small spinner. */
export function Spinner(props) {
  return h('span', { className: 'ph-spinner' + (props.className ? ' ' + props.className : ''), 'aria-hidden': 'true' })
}

/** One-line notice bar. */
export function Notice(props) {
  if (!props.notice || !props.notice.text) return null
  const tone = props.notice.tone || 'info'
  const icon = tone === 'error' ? 'warning' : tone === 'warning' ? 'warning' : tone === 'success' ? 'checkCircle' : 'info'
  return h(
    'div',
    { className: 'ph-notice ph-notice--' + tone, role: 'status' },
    h(Icon, { name: icon, size: 14 }),
    h('span', { className: 'ph-notice__text' }, props.notice.text),
    props.onDismiss ? h(IconButton, { icon: 'close', title: 'dismiss', onClick: props.onDismiss, className: 'ph-notice__close' }) : null,
  )
}

/** Shimmering skeleton block used by loading states. */
export function Skeleton(props) {
  const style = {}
  if (props.width != null) style.width = typeof props.width === 'number' ? props.width + 'px' : props.width
  if (props.height != null) style.height = typeof props.height === 'number' ? props.height + 'px' : props.height
  if (props.radius != null) style.borderRadius = typeof props.radius === 'number' ? props.radius + 'px' : props.radius
  if (props.flex != null) style.flex = props.flex
  return h('span', { className: 'ph-skeleton' + (props.className ? ' ' + props.className : ''), style: style, 'aria-hidden': 'true' })
}

/** A stack of transient toasts (rendered by the paper center). */
export function ToastStack(props) {
  const toasts = props.toasts || []
  if (toasts.length === 0) return null
  return h(
    'div',
    { className: 'ph-toasts', role: 'status', 'aria-live': 'polite' },
    toasts.map((toast) =>
      h(
        'div',
        { key: toast.id, className: 'ph-toast ph-toast--' + (toast.tone || 'info') },
        h(Icon, { name: toast.tone === 'error' ? 'warning' : toast.tone === 'success' ? 'checkCircle' : 'info', size: 15 }),
        h('span', { className: 'ph-toast__text' }, toast.text),
        h(IconButton, { icon: 'close', title: 'dismiss', onClick: () => props.onDismiss(toast.id), className: 'ph-toast__close' }),
      ),
    ),
  )
}

/** Toast queue hook: push(kind, text), dismiss(id), auto-expires. */
export function useToasts() {
  const counter = React.useRef(0)
  const timers = React.useRef(new Map())
  const [toasts, setToasts] = React.useState([])
  const dismiss = React.useCallback((id) => {
    const timer = timers.current.get(id)
    if (timer) {
      clearTimeout(timer)
      timers.current.delete(id)
    }
    setToasts((list) => list.filter((toast) => toast.id !== id))
  }, [])
  const push = React.useCallback(
    (tone, text) => {
      if (!text) return
      counter.current += 1
      const id = 'toast-' + counter.current
      setToasts((list) => list.concat([{ id: id, tone: tone || 'info', text: text }]).slice(-4))
      const timer = setTimeout(() => {
        timers.current.delete(id)
        setToasts((list) => list.filter((toast) => toast.id !== id))
      }, 5200)
      timers.current.set(id, timer)
    },
    [],
  )
  React.useEffect(
    () => () => {
      timers.current.forEach((timer) => clearTimeout(timer))
      timers.current.clear()
    },
    [],
  )
  return { toasts: toasts, push: push, dismiss: dismiss }
}

/** Localized time label for annotation/note timestamps. */
export function formatTime(value) {
  const date = value ? new Date(value) : null
  if (!date || Number.isNaN(date.getTime())) return ''
  try {
    return date.toLocaleString()
  } catch {
    return date.toISOString().slice(0, 16).replace('T', ' ')
  }
}
