/** Duplicate-paper workbench (Zotero Duplicate parity): pick a primary, merge, undo. */
import React from 'react'
import { h } from '../../core/dom.js'
import { Icon } from '../../core/icons.jsx'
import { Badge, Button, EmptyState, Spinner } from '../../core/primitives.jsx'
import { describeError } from '../../core/api.js'
import { paperTitle, metaLine } from '../../core/texts.js'

export function DuplicatesPane(props) {
  const t = props.t
  const snapshot = props.snapshot
  const controller = props.controller
  const duplicates = snapshot.duplicates || { status: 'idle', groups: [], error: null }
  const [primary, setPrimary] = React.useState({})
  const [busy, setBusy] = React.useState('')

  React.useEffect(() => {
    if (duplicates.status === 'idle') controller.loadDuplicates()
  }, [duplicates.status, controller])

  if (duplicates.status === 'loading' || duplicates.status === 'idle') {
    return h('div', { className: 'ph-dup ph-scroll' }, h('div', { className: 'ph-dup__hint' }, h(Spinner, { size: 14 }), t('duplicates.loading')))
  }
  if (duplicates.status === 'error') {
    return h('div', { className: 'ph-dup ph-scroll' }, h(EmptyState, { tone: 'error', icon: 'warning', title: t('duplicates.failed', { message: describeError(t, duplicates.error) }), action: h(Button, { variant: 'secondary', icon: 'refresh', onClick: () => controller.loadDuplicates() }, t('common.retry')) }))
  }
  if (duplicates.groups.length === 0) {
    return h('div', { className: 'ph-dup ph-scroll' }, h(EmptyState, { icon: 'copy', title: t('duplicates.emptyTitle'), desc: t('duplicates.emptyDesc'), action: h(Button, { variant: 'secondary', icon: 'refresh', onClick: () => controller.loadDuplicates() }, t('duplicates.recheck')) }))
  }

  const merge = (group, primaryId) => {
    if (!primaryId) return
    setBusy(group.key)
    const duplicateIds = group.items.filter((paper) => paper.id !== primaryId).map((paper) => paper.id)
    controller
      .mergeDuplicates(primaryId, duplicateIds, t('duplicates.mergedLabel', { count: duplicateIds.length }))
      .then(() => props.pushToast('success', t('duplicates.merged', { count: duplicateIds.length })))
      .catch((error) => props.pushToast('error', t('duplicates.mergeFailed', { message: describeError(t, error) })))
      .then(() => setBusy(''))
  }

  return h(
    'div',
    { className: 'ph-dup ph-scroll' },
    h('div', { className: 'ph-dup__head' }, h(Icon, { name: 'copy', size: 15 }), h('span', null, t('duplicates.title', { count: duplicates.groups.length })), h('span', { className: 'ph-spacer' }), h(Button, { size: 'sm', variant: 'ghost', icon: 'refresh', onClick: () => controller.loadDuplicates() }, t('duplicates.recheck'))),
    duplicates.groups.map((group) => {
      const picked = primary[group.key] || (group.items[0] && group.items[0].id)
      return h(
        'section',
        { key: group.key, className: 'ph-dupg' },
        h('div', { className: 'ph-dupg__head' }, h(Badge, { tone: 'business' }, group.reason === 'sha256' ? t('duplicates.reason.sha256') : t('duplicates.reason.title')), h('span', { className: 'ph-caption' }, t('duplicates.items', { count: group.items.length })), h('span', { className: 'ph-spacer' }), h(Button, { size: 'sm', variant: 'primary', icon: 'merge', disabled: Boolean(busy), onClick: () => merge(group, picked) }, t('duplicates.merge'))),
        group.items.map((paper) =>
          h(
            'label',
            { key: paper.id, className: 'ph-duprow' + (picked === paper.id ? ' ph-duprow--primary' : '') },
            h('input', { type: 'radio', name: 'primary-' + group.key, checked: picked === paper.id, onChange: () => setPrimary(Object.assign({}, primary, { [group.key]: paper.id })) }),
            h('div', { className: 'ph-duprow__main' }, h('div', { className: 'ph-duprow__title' }, paperTitle(t, paper)), h('div', { className: 'ph-caption' }, metaLine(t, paper))),
            paper.state === 'trash' ? h(Badge, { tone: 'muted' }, t('library.smart.trash')) : null,
            picked === paper.id ? h(Badge, { tone: 'success' }, t('duplicates.primary')) : null,
          ),
        ),
      )
    }),
  )
}
