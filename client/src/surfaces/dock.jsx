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
import { insertTokenIntoComposer, registerComposerBridge } from '../core/dnd.js'
import { installCitationTokens } from '../core/cite-token.js'
import { FeedbackHost, notify } from '../core/feedback.js'
import { bus } from '../core/bus.js'
import { SettingsHost } from './settings/host.jsx'

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

export function DockBody(props) {
  const t = props.t
  const inputActions = props.inputActions
  const snapshot = usePendingSnapshot()
  const { toasts, push, dismiss } = useToasts()
  const [expanded, setExpanded] = React.useState({})
  const [busyId, setBusyId] = React.useState(null)
  const [errors, setErrors] = React.useState({})
  const [pdfPrompt, setPdfPrompt] = React.useState(false)
  const [pdfDismissed, setPdfDismissed] = React.useState('')
  const [pdfName, setPdfName] = React.useState('')
  const insertingRef = React.useRef({})
  const bundles = snapshot.bundles.filter((bundle) => !bundle.sessionId || bundle.sessionId === props.sessionId)

  const toggleExpanded = React.useCallback((bundleId) => {
    setExpanded((previous) => Object.assign({}, previous, { [bundleId]: !previous[bundleId] }))
  }, [])

  React.useEffect(() => registerComposerBridge(inputActions), [inputActions])
  React.useEffect(() => installCitationTokens(), [])

  // Detect PDF attachments in the live composer draft (public DOM only) and
  // suggest adding them to the paper centre; never imports automatically.
  React.useEffect(() => {
    if (typeof document === 'undefined') return undefined
    const scan = () => {
      const composer = document.querySelector('[data-conversation-region="composer"]')
      if (!composer) { setPdfPrompt(false); setPdfName(''); return }
      const text = (composer.innerText || '')
      const names = text.match(/[\w\- .()\u4e00-\u9fff]+\.pdf/gi) || []
      const name = names.length > 0 ? names[0].trim() : ''
      setPdfName(name)
      if (!name && pdfDismissed) setPdfDismissed('')
      setPdfPrompt(Boolean(name) && name !== pdfDismissed)
    }
    const observer = new MutationObserver(scan)
    observer.observe(document.body, { childList: true, subtree: true, characterData: true })
    scan()
    return () => observer.disconnect()
  }, [pdfDismissed])

  React.useEffect(() => {
    bundles.forEach((bundle) => {
      if (!bundle.autoInsert || bundle.added || insertingRef.current[bundle.bundleId]) return
      if (!bundle.token) return
      insertingRef.current[bundle.bundleId] = true
      const attempt = (retries) => {
        if (insertTokenIntoComposer(bundle.token)) {
          // The card's own 已加入草稿 badge + undo button is the feedback; a
          // second generic toast would duplicate and crowd the composer.
          pendingStore.markAdded(bundle.bundleId)
          return
        }
        if (retries > 0) setTimeout(() => attempt(retries - 1), 300)
        else {
          insertingRef.current[bundle.bundleId] = false
          notify('warning', t('dnd.pendingInsert'), { label: t('dnd.addManual'), onClick: () => insertBundle(bundle) }, 9000)
        }
      }
      setTimeout(() => attempt(12), 150)
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
      const first = attemptInsert(bundle)
      if (first) {
        pendingStore.markAdded(bundle.bundleId)
        setBusyId(null)
        insertingRef.current[bundle.bundleId] = false
        return
      }
      setTimeout(() => {
        const second = attemptInsert(bundle)
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

  if (bundles.length === 0) {
    return h(
      'div',
      null,
      h(FeedbackHost, null),
      h(SettingsHost, { t: t }),
      pdfPrompt ? h('div', { className: 'ph-pdfprompt', role: 'status' },
        h('span', { className: 'ph-pdfprompt__text' }, t('pdf.prompt')),
        h('button', { type: 'button', className: 'ph-btn ph-btn--sm ph-btn--primary', onClick: () => { bus.emit('open-library-view', { view: 'all' }) } }, t('pdf.open')),
        h('button', { type: 'button', className: 'ph-btn ph-btn--sm ph-btn--ghost', onClick: () => { setPdfDismissed(pdfName); setPdfPrompt(false) } }, t('pdf.dismiss')),
      ) : null,
    )
  }

  const materialIcon = (kind) => (kind === 'figure' ? 'figure' : kind === 'annotation' ? 'highlighter' : kind === 'note' ? 'note' : 'book')
  const visibleBundles = bundles.slice(0, 3)
  const hiddenCount = bundles.length - visibleBundles.length
  return h(
    'div',
    null,
    h(FeedbackHost, null),
    h(SettingsHost, { t: t }),
    pdfPrompt ? h('div', { className: 'ph-pdfprompt', role: 'status' },
      h('span', { className: 'ph-pdfprompt__text' }, t('pdf.prompt')),
      h('button', { type: 'button', className: 'ph-btn ph-btn--sm ph-btn--primary', onClick: () => { bus.emit('open-library-view', { view: 'all' }) } }, t('pdf.open')),
      h('button', { type: 'button', className: 'ph-btn ph-btn--sm ph-btn--ghost', onClick: () => { setPdfDismissed(pdfName); setPdfPrompt(false) } }, t('pdf.dismiss')),
    ) : null,
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
              h('div', { className: 'ph-refcard__title' }, t('dock.card.title', { count: count })),
              h('div', { className: 'ph-refcard__sub' }, bundleSummaryLabel(t, bundle) || t('dock.card.count', { count: count })),
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
                      pendingStore.remove(bundle.bundleId)
                      push('info', t('dock.card.removed'), null, 2000)
                    },
                  })
                : null,
              h(IconButton, { icon: 'close', className: 'ph-refcard__remove', title: t('dock.remove'), onClick: () => pendingStore.remove(bundle.bundleId) }),
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
                      h(IconButton, { icon: 'close', className: 'ph-refcard__materialRemove', title: t('dock.remove'), onClick: () => pendingStore.removeMaterial(bundle.bundleId, index) }),
                    ),
                  ),
                ),
                h(
                  'div',
                  { className: 'ph-refcard__foot' },
                  h('span', { className: 'ph-refcard__hint' }, t('dock.card.hint')),
                  h('button', { type: 'button', className: 'ph-linkbtn', onClick: () => { pendingStore.clear(); push('info', t('dock.card.cleared'), null, 2000) } }, t('dock.card.clear')),
                ),
              )
            : null,
        )
      }),
      hiddenCount > 0 ? h('div', { className: 'ph-dock__more' }, t('dock.card.more', { count: hiddenCount })) : null,
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
