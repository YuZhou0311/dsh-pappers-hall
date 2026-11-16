/**
 * Composer dock: pending conversation material bundles.
 *
 * The pending reference set renders as one inline chip above the composer. It
 * is never written into the draft as a protocol string: the chip is the UI, and
 * `references.attach` + the `papers_references` tool carry the same set to the
 * model. The dock shares the plugin-level pending store with the drawer, the
 * library details pane and the reader.
 */
import React from 'react'
import { h } from '../core/dom.js'
import { Icon } from '../core/icons.jsx'
import { IconButton, useToasts } from '../core/primitives.jsx'
import { pendingStore } from '../core/pending.js'
import { dropPendingReferences, dropPendingMaterial } from '../core/reference-actions.js'
import { registerComposerBridge } from '../core/dnd.js'
import { installCitationTokens } from '../core/cite-token.js'
import { defaultApi } from '../core/api.js'
import { FeedbackHost, notify } from '../core/feedback.js'

/** Localized material mix label ("论文 3 · 图 1") instead of the Host's English display. */
export function bundleSummaryLabel(t, bundle) {
  const counts = { paper: 0, figure: 0, annotation: 0, note: 0 }
  ;(bundle && Array.isArray(bundle.materials) ? bundle.materials : []).forEach((material) => {
    const kind = material && material.kind
    if (kind && counts[kind] !== undefined) counts[kind] += 1
  })
  const parts = []
  ;['paper', 'figure', 'annotation', 'note'].forEach((kind) => {
    if (counts[kind] > 0) parts.push(t('dock.card.unit.' + kind, { count: counts[kind] }))
  })
  return parts.join(' · ')
}

function usePendingSnapshot() {
  return React.useSyncExternalStore(pendingStore.subscribe, pendingStore.getSnapshot, pendingStore.getSnapshot)
}

/**
 * Compact, always-mounted composer entry (v0.25).
 *
 * The native `conversation.input.dock` slot is not rendered for a brand-new
 * conversation (no Session/InputState yet), so the dock and its composer bridge
 * were absent there. This entry lives in `conversation.input.left` — which the
 * hero composer always renders — registers the same insertion bridge and, in a
 * new conversation, auto-inserts pending citations into the draft.
 */
export function ComposerEntry(props) {
  const t = props.t
  return h(
    'button',
    {
      type: 'button',
      className: 'ph-composer-entry',
      title: t('composer.papers'),
      'aria-label': t('composer.papers'),
      onClick: () => props.openPapers && props.openPapers(),
    },
    h(Icon, { name: 'book', size: 14 }),
    h('span', { className: 'ph-composer-entry__label' }, t('composer.papers')),
  )
}

export function DockBody(props) {
  const t = props.t
  const inputActions = props.inputActions
  const snapshot = usePendingSnapshot()
  const { toasts, push, dismiss } = useToasts()
  const [expanded, setExpanded] = React.useState({})
  const bundles = snapshot.bundles.filter((bundle) => !bundle.sessionId || bundle.sessionId === props.sessionId)
  const attachedRef = React.useRef(null)

  React.useEffect(() => registerComposerBridge(inputActions), [inputActions])
  React.useEffect(() => installCitationTokens(), [])

  // A draft persisted by an older version can still hold protocol tokens. The
  // reference lives in the chip now, so those leftovers are removed once.
  React.useEffect(() => {
    const timer = setTimeout(() => {
      const composer = document.querySelector('[data-composer-input="true"]')
      if (!composer) return
      const text = String(composer.innerText || '')
      const legacy = text.match(/⟦Pappers-Hall[\s\S]*?⟧/g) || []
      if (legacy.length === 0) return
      let next = text
      legacy.forEach((token) => { next = next.replace(token, '') })
      next = next.replace(/\n{3,}/g, '\n\n').replace(/^\s+|\s+$/g, '')
      try { if (inputActions && typeof inputActions.setDraft === 'function') inputActions.setDraft(next) } catch { /* best effort */ }
    }, 900)
    return () => clearTimeout(timer)
  }, [inputActions])

  // Attach the pending bundle to the session as soon as it exists. The reference
  // stays a UI chip above the composer — it is never written into the draft as a
  // protocol string, and `papers_references` resolves it for the model.
  React.useEffect(() => {
    const bundle = bundles[0]
    if (!bundle || attachedRef.current === bundle.bundleId) return
    attachedRef.current = bundle.bundleId
    defaultApi('references.attach', { bundleId: bundle.bundleId, ...(props.sessionId ? { sessionId: props.sessionId } : {}) }).catch(() => {})
  }, [bundles.map((bundle) => bundle.bundleId).join(','), props.sessionId])

  const toggleExpanded = React.useCallback((bundleId) => {
    setExpanded((previous) => Object.assign({}, previous, { [bundleId]: !previous[bundleId] }))
  }, [])

  const clearAllReferences = React.useCallback(async () => {
    pendingStore.clear()
  }, [])

  if (bundles.length === 0) {
    return h('div', { className: 'ph-dock-slot ph-dock-slot--empty' }, h(FeedbackHost, null))
  }

  const materialIcon = (kind) => (kind === 'figure' ? 'figure' : kind === 'annotation' ? 'highlighter' : kind === 'note' ? 'note' : 'book')
  const bundle = bundles[0]
  const count = bundle.materials.length
  const isOpen = Boolean(expanded[bundle.bundleId])
  return h(
    'div',
    { className: 'ph-dock-slot' },
    h(FeedbackHost, null),
    h(
      'div',
      { className: 'ph-refchip', role: 'group', 'aria-label': t('dock.materials') },
      h(
        'button',
        {
          type: 'button',
          className: 'ph-refchip__main',
          'aria-expanded': isOpen ? 'true' : 'false',
          title: t('dock.card.hint'),
          onClick: () => toggleExpanded(bundle.bundleId),
        },
        h(Icon, { name: bundle.materials.some((material) => material.kind === 'figure') ? 'figure' : 'book', size: 13 }),
        h('span', { className: 'ph-refchip__label' }, bundleSummaryLabel(t, bundle) || t('dock.card.count', { count: count })),
        h(Icon, { name: isOpen ? 'chevronDown' : 'chevronRight', size: 12, className: 'ph-refchip__chev' }),
      ),
      h(IconButton, { icon: 'close', className: 'ph-refchip__remove', title: t('dock.remove'), onClick: () => { dropPendingReferences(bundle.bundleId).catch(() => {}) } }),
    ),
    isOpen
      ? h(
          'div',
          { className: 'ph-refchip__panel' },
          bundle.materials.map((material, index) =>
            h(
              'div',
              { key: material.kind + ':' + material.id + ':' + index, className: 'ph-refchip__item' },
              h('span', { className: 'ph-refchip__icon' }, h(Icon, { name: materialIcon(material.kind), size: 12 })),
              h('span', { className: 'ph-refchip__title', title: material.title || material.figureLabel || material.id }, material.title || material.figureLabel || material.id),
              h('span', { className: 'ph-refchip__meta' }, material.page ? t('reader.pages', { page: material.page }) : t('dock.item.' + (material.kind || 'paper'))),
              h(IconButton, { icon: 'close', className: 'ph-refchip__itemRemove', title: t('dock.remove'), onClick: () => { dropPendingMaterial(bundle.bundleId, index).catch(() => {}) } }),
            ),
          ),
          h('button', { type: 'button', className: 'ph-linkbtn', onClick: () => { clearAllReferences().then(() => push('info', t('dock.card.cleared'), null, 2000)).catch(() => {}) } }, t('dock.card.clear')),
        )
      : null,
    toasts.length > 0
      ? h('div', { className: 'ph-dock__toasts', role: 'status' }, toasts.map((toast) => h('span', { key: toast.id, className: 'ph-dock__toastText' }, toast.text)))
      : null,
  )
}
