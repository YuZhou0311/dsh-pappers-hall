/**
 * Composer dock: pending conversation material bundles.
 *
 * "加入草稿" inserts the Host's human-readable bundle token through the composer
 * `inputActions` (captureInsertion → insertText), retries once while keeping the
 * bundle, marks it added and never submits. The dock shares the plugin-level
 * pending store with the drawer, library details and the reader.
 */
import React from 'react'
import { h } from '../core/dom.js'
import { Icon } from '../core/icons.jsx'
import { Badge, Button, IconButton, useToasts } from '../core/primitives.jsx'
import { pendingStore } from '../core/pending.js'
import { commitReferenceBatch, dropPendingReferences, dropPendingMaterial } from '../core/reference-actions.js'
import { insertTokenIntoComposer, registerComposerBridge, removeTokenFromComposer, composerHasToken } from '../core/dnd.js'
import { installCitationTokens } from '../core/cite-token.js'
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
  const [busyId, setBusyId] = React.useState(null)
  const [errors, setErrors] = React.useState({})
  const insertingRef = React.useRef({})
  const bundles = snapshot.bundles.filter((bundle) => !bundle.sessionId || bundle.sessionId === props.sessionId)

  // The mention in the draft is the citation itself: if the user deletes it,
  // the card above must not keep claiming the material is attached.
  React.useEffect(() => {
    const timer = setInterval(() => {
      const state = pendingStore.getSnapshot()
      const composer = document.querySelector('[data-composer-input="true"]')
      const text = composer ? String(composer.innerText || '') : ''
      state.bundles.forEach((bundle) => {
        if (!bundle.token) return
        if (props.sessionId && bundle.sessionId && bundle.sessionId !== props.sessionId) return
        if (text.includes(bundle.token)) return
        pendingStore.remove(bundle.bundleId)
      })
    }, 900)
    return () => clearInterval(timer)
  }, [props.sessionId])

  const toggleExpanded = React.useCallback((bundleId) => {
    setExpanded((previous) => Object.assign({}, previous, { [bundleId]: !previous[bundleId] }))
  }, [])

  React.useEffect(() => registerComposerBridge(inputActions), [inputActions])

  // A draft persisted by an older version can still hold raw protocol tokens.
  // They are not backed by a pending bundle, so drop them once on mount.
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
  React.useEffect(() => installCitationTokens(), [])

  React.useEffect(() => {
    bundles.forEach((bundle) => {
      if (!bundle.autoInsert || bundle.added || insertingRef.current[bundle.bundleId]) return
      if (!bundle.token) return
      insertingRef.current[bundle.bundleId] = true
      const attempt = (retries) => {
        // Marking the bundle added is only honest once the token is really in
        // the draft: a composer that is still mounting can accept the insert
        // call and drop the text.
        if (insertTokenIntoComposer(bundle.token) && composerHasToken(bundle.token)) {
          // The card's own 已加入草稿 badge + undo button is the feedback; a
          // second generic toast would duplicate and crowd the composer.
          pendingStore.markAdded(bundle.bundleId)
          // Reset the guard: the same bundle id gets a new token when the set
          // grows, and that token must be allowed to enter the draft too.
          insertingRef.current[bundle.bundleId] = false
          return
        }
        if (retries > 0) setTimeout(() => attempt(retries - 1), 260)
        else {
          insertingRef.current[bundle.bundleId] = false
          notify('warning', t('dnd.pendingInsert'), { label: t('dnd.addManual'), onClick: () => insertBundle(bundle) }, 9000)
        }
      }
      setTimeout(() => attempt(14), 180)
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bundles.map((bundle) => bundle.bundleId + ':' + bundle.added + ':' + Boolean(bundle.autoInsert)).join(','), t])

  const attemptInsert = React.useCallback(
    (bundle) => {
      if (!inputActions || typeof inputActions.captureInsertion !== 'function' || typeof inputActions.insertText !== 'function') return false
      if (!bundle || !bundle.token) return false
      try {
        const span = inputActions.captureInsertion()
        const accepted = inputActions.insertText(bundle.token, span)
        return accepted !== false
      } catch (error) {
        console.warn('[pappers-hall] insertText failed', error)
        return false
      }
    },
    [inputActions],
  )

  const insertBundle = React.useCallback(
    (bundle) => {
      if (!bundle || bundle.added || busyId) return
      if (insertingRef.current[bundle.bundleId]) return
      if (!inputActions) {
        setErrors((previous) => Object.assign({}, previous, { [bundle.bundleId]: t('dock.noInput') }))
        return
      }
      setErrors((previous) => {
        const next = Object.assign({}, previous)
        delete next[bundle.bundleId]
        return next
      })
      insertingRef.current[bundle.bundleId] = true
      setBusyId(bundle.bundleId)
      const first = attemptInsert(bundle) && composerHasToken(bundle.token)
      if (first) {
        pendingStore.markAdded(bundle.bundleId)
        setBusyId(null)
        insertingRef.current[bundle.bundleId] = false
        return
      }
      setTimeout(() => {
        const second = attemptInsert(bundle) && composerHasToken(bundle.token)
        if (second) {
          pendingStore.markAdded(bundle.bundleId)
        } else {
          setErrors((previous) => Object.assign({}, previous, { [bundle.bundleId]: t('dock.failed') }))
        }
        setBusyId(null)
        insertingRef.current[bundle.bundleId] = false
      }, 150)
    },
    [attemptInsert, busyId, inputActions, push, t],
  )

  const clearAllReferences = React.useCallback(async () => {
    const tokens = snapshot.bundles.map((bundle) => bundle.token).filter(Boolean)
    tokens.forEach((token) => removeTokenFromComposer(token))
    pendingStore.clear()
  }, [snapshot.bundles])

  if (bundles.length === 0) {
    return h(
      'div',
      { className: 'ph-dock-slot ph-dock-slot--empty' },
      h(FeedbackHost, null),
    )
  }

  const materialIcon = (kind) => (kind === 'figure' ? 'figure' : kind === 'annotation' ? 'highlighter' : kind === 'note' ? 'note' : 'book')
  const visibleBundles = bundles.slice(0, 3)
  const hiddenCount = bundles.length - visibleBundles.length
  return h(
    'div',
    { className: 'ph-dock-slot' },
    h(FeedbackHost, null),
    h(
      'div',
      { className: 'ph-dock', role: 'group', 'aria-label': t('dock.materials') },
      visibleBundles.map((bundle) => {
        const count = bundle.materials.length
        const isOpen = Boolean(expanded[bundle.bundleId])
        return h(
          'div',
          {
            key: bundle.bundleId,
            className: 'ph-refcard' + (bundle.added ? ' ph-refcard--added' : '') + (isOpen ? ' ph-refcard--open' : ''),
            'data-bundle': bundle.bundleId,
            title: t('dock.card.hint'),
          },
          h(
            'div',
            { className: 'ph-refcard__main' },
            h('span', { className: 'ph-refcard__icon' }, h(Icon, { name: bundle.materials.some((material) => material.kind === 'figure') ? 'figure' : 'book', size: 15 })),
            h(
              'div',
              { className: 'ph-refcard__body' },
              h('div', { className: 'ph-refcard__title' }, bundleSummaryLabel(t, bundle) || t('dock.card.title', { count: count })),
              h(
                'div',
                { className: 'ph-refcard__chips' },
                bundle.materials.slice(0, 2).map((material, index) =>
                  h('span', {
                    key: material.kind + ':' + material.id + ':' + index,
                    className: 'ph-refcard__chip',
                    title: material.title || material.figureLabel || material.id,
                  }, material.title || material.figureLabel || material.id),
                ),
                count > 2 ? h('button', { type: 'button', className: 'ph-refcard__chip ph-refcard__chip--more', onClick: (event) => { event.stopPropagation(); toggleExpanded(bundle.bundleId) } }, '+' + (count - 2)) : null,
              ),
              errors[bundle.bundleId] ? h('div', { className: 'ph-refcard__error', role: 'status' }, errors[bundle.bundleId]) : null,
            ),
            h(
              'div',
              { className: 'ph-refcard__actions' },
              bundle.added
                ? h('span', { className: 'ph-refcard__added' }, h(Icon, { name: 'checkCircle', size: 12 }), t('dock.card.added'))
                : h(
                    Button,
                    {
                      size: 'sm',
                      variant: 'primary',
                      icon: 'plus',
                      loading: busyId === bundle.bundleId,
                      disabled: Boolean(busyId) || !bundle.token,
                      onClick: () => insertBundle(bundle),
                    },
                    busyId === bundle.bundleId ? t('dock.adding') : t('dock.card.add'),
                  ),
              bundle.added
                ? h(IconButton, {
                    icon: 'restore',
                    className: 'ph-refcard__undo',
                    title: t('dock.card.undo'),
                    onClick: () => {
                      dropPendingReferences(bundle.bundleId)
                        .then(() => push('info', t('dock.card.removed'), null, 2000))
                        .catch(() => push('error', t('dock.failed'), null, 3000))
                    },
                  })
                : null,
              h(IconButton, { icon: 'close', className: 'ph-refcard__remove', title: t('dock.remove'), onClick: () => { dropPendingReferences(bundle.bundleId).catch(() => {}) } }),
              h(
                'button',
                {
                  type: 'button',
                  className: 'ph-refcard__chevron',
                  'aria-expanded': isOpen ? 'true' : 'false',
                  'aria-label': isOpen ? t('dock.collapse') : t('dock.expand'),
                  title: isOpen ? t('dock.collapse') : t('dock.expand'),
                  onClick: () => toggleExpanded(bundle.bundleId),
                },
                h(Icon, { name: isOpen ? 'chevronDown' : 'chevronRight', size: 14 }),
              ),
            ),
          ),
          isOpen
            ? h(
                'div',
                { className: 'ph-refcard__materials' },
                h(
                  'div',
                  { className: 'ph-refcard__list' },
                  bundle.materials.map((material, index) =>
                    h(
                      'div',
                      { key: material.kind + ':' + material.id + ':' + index, className: 'ph-refcard__material' },
                      h('span', { className: 'ph-refcard__materialIcon' }, h(Icon, { name: materialIcon(material.kind), size: 13 })),
                      h('span', { className: 'ph-refcard__materialTitle', title: material.title || material.figureLabel || material.id }, material.title || material.figureLabel || material.id),
                      h('span', { className: 'ph-refcard__materialMeta' }, material.page ? t('reader.pages', { page: material.page }) : t('dock.item.' + (material.kind || 'paper'))),
                      h(IconButton, { icon: 'close', className: 'ph-refcard__materialRemove', title: t('dock.remove'), onClick: () => { dropPendingMaterial(bundle.bundleId, index).catch(() => {}) } }),
                    ),
                  ),
                ),
                h(
                  'div',
                  { className: 'ph-refcard__foot' },
                  h('span', { className: 'ph-refcard__hint' }, t('dock.card.hint')),
                  h('button', { type: 'button', className: 'ph-linkbtn', onClick: () => { clearAllReferences().then(() => push('info', t('dock.card.cleared'), null, 2000)).catch(() => {}) } }, t('dock.card.clear')),
                ),
              )
            : null,
        )
      }),
      hiddenCount > 0 ? h('div', { className: 'ph-dock__more' }, t('dock.card.more', { count: hiddenCount })) : null,
      bundles.length > 1
        ? h('button', { type: 'button', className: 'ph-dock__clearAll', onClick: () => { clearAllReferences().then(() => push('info', t('dock.card.cleared'), null, 2000)).catch(() => {}) } }, t('dock.clearAll'))
        : null,
      toasts.length > 0
        ? h(
            'div',
            { className: 'ph-dock__toasts', role: 'status' },
            toasts.map((toast) => h('span', { key: toast.id, className: 'ph-dock__toastText' }, toast.text)),
          )
        : null,
    ),
  )
}
