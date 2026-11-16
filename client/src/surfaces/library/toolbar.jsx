/**
 * Middle-pane toolbar (search / sort / view / import) and the floating batch bar
 * for the current multi-selection.
 */
import React from 'react'
import { h } from '../../core/dom.js'
import { Icon } from '../../core/icons.jsx'
import { Badge, Button, IconButton, Segmented, useToasts } from '../../core/primitives.jsx'
import { describeError } from '../../core/api.js'
import { copyText, dataUrlPayload, importFormatOf, readFileAsDataUrl } from '../../core/files.js'
import { pendingStore } from '../../core/pending.js'
import { notify } from '../../core/feedback.js'
import { FolderPicker } from './folders.jsx'
import { withViewTransition } from '../../core/motion.js'

function operationId(prefix) {
  const random =
    typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
      ? crypto.randomUUID()
      : Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 10)
  return (prefix ? prefix + '-' : '') + random
}

const SORT_OPTIONS = [
  ['recent', 'library.sort.recent'],
  ['added', 'library.sort.added'],
  ['title', 'library.sort.title'],
  ['year', 'library.sort.year'],
  ['authors', 'library.sort.authors'],
]

/**
 * Global import control. It lives in the library top bar because importing is a
 * workspace-level action, not a table filter; the hidden file input stays here
 * so the command palette can trigger the same element.
 */
export function ImportControl(props) {
  const t = props.t
  const api = props.api
  const controller = props.controller
  const [importing, setImporting] = React.useState(false)
  const fileRef = React.useRef(null)

  const importFiles = (fileList) => {
    const files = Array.prototype.slice.call(fileList || [])
    if (files.length === 0) return
    setImporting(true)
    const groups = new Map()
    const reads = files.map((file) =>
      readFileAsDataUrl(file).then((dataUrl) => {
        const format = importFormatOf(file.name)
        const bucket = groups.get(format) || []
        bucket.push({ name: String(file.name || 'upload'), base64: dataUrlPayload(dataUrl) })
        groups.set(format, bucket)
      }),
    )
    Promise.all(reads)
      .then(() => {
        const calls = []
        groups.forEach((uploads, format) => {
          const params = { uploads: uploads, operationId: operationId('import') }
          if (format) params.format = format
          calls.push(api('library.import', params))
        })
        return Promise.all(calls)
      })
      .then((results) => {
        let accepted = 0
        let duplicates = 0
        let errors = 0
        results.forEach((result) => {
          accepted += Number(result && result.accepted) || 0
          duplicates += Array.isArray(result && result.duplicates) ? result.duplicates.length : 0
          errors += Array.isArray(result && result.errors) ? result.errors.length : 0
        })
        props.pushToast(errors > 0 ? 'warning' : 'success', duplicates > 0 ? t('toast.importedSkipped', { count: accepted, dupes: duplicates }) : t('toast.imported', { count: accepted }))
        let classified = 0
        let createdFolders = 0
        let embeddingIssue = ''
        results.forEach((result) => {
          const classification = (result && result.classification) || (result && result.items ? result.items.map((item) => item && item.classification).filter(Boolean) : [])
          const list = Array.isArray(classification) ? classification : [classification]
          list.filter(Boolean).forEach((entry) => {
            if (entry.folder || entry.folderId) classified += 1
            if (entry.created) createdFolders += 1
            if (entry.embedding === 'unavailable' && entry.reason) embeddingIssue = String(entry.reason)
          })
        })
        if (accepted > 0 && (classified > 0 || createdFolders > 0 || embeddingIssue)) {
          notify('info', t('import.classified', { count: classified || accepted }) + (createdFolders > 0 ? ' · ' + t('import.createdFolders', { count: createdFolders }) : '') + (embeddingIssue ? ' · ' + t('import.embeddingUnavailable', { message: embeddingIssue }) : ''), { label: t('common.undo'), onClick: () => { controller.refresh() } }, 9000)
        }
        controller.refresh()
      })
      .catch((error) => props.pushToast('error', t('toast.importFailed', { message: describeError(t, error) })))
      .then(() => setImporting(false))
  }

  return h(
    React.Fragment,
    null,
    h('input', {
      ref: fileRef,
      type: 'file',
      multiple: true,
      accept: '.pdf,.bib,.bibtex,.ris,.json',
      className: 'ph-hidden-input',
      onChange: (event) => {
        importFiles(event.target.files)
        event.target.value = ''
      },
    }),
    h(
      Button,
      {
        variant: 'primary',
        icon: 'import',
        loading: importing,
        className: 'ph-importbtn',
        onClick: () => fileRef.current && fileRef.current.click(),
        title: t('library.import'),
      },
      importing ? t('library.importing') : t('library.import'),
    ),
  )
}

export function LibraryToolbar(props) {
  const t = props.t
  const [narrow, setNarrow] = React.useState(() => typeof window !== 'undefined' && window.innerWidth <= 1100)
  React.useEffect(() => {
    const onResize = () => setNarrow(typeof window !== 'undefined' && window.innerWidth <= 1100)
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [])
  const leftOpen = narrow ? Boolean(props.snapshot.mobileLeftOpen) && !props.snapshot.ui.leftCollapsed : !props.snapshot.ui.leftCollapsed
  const snapshot = props.snapshot
  const controller = props.controller

  return h(
    'div',
    { className: 'ph-toolbar ph-toolbar--library' },
    h(
      'div',
      { className: 'ph-toolbar__lead' },
      h(IconButton, {
        icon: 'panelLeft',
        title: leftOpen ? t('library.sidebar.hide') : t('library.sidebar.show'),
        'aria-label': leftOpen ? t('library.sidebar.hide') : t('library.sidebar.show'),
        'aria-pressed': leftOpen ? 'true' : 'false',
        active: leftOpen,
        onClick: () => (narrow && controller.toggleMobileLeft ? controller.toggleMobileLeft() : controller.toggleLeft()),
      }),
      h('span', { className: 'ph-toolbar__divider', 'aria-hidden': 'true' }),
      h(
        'label',
        { className: 'ph-toolbar__sort' },
        h(Icon, { name: 'sort', size: 13, className: 'ph-toolbar__sorticon' }),
        h(
          'select',
          { className: 'ph-select ph-select--quiet', value: snapshot.filters.sort, onChange: (event) => controller.setSort(event.target.value), 'aria-label': t('library.sort') },
          SORT_OPTIONS.map(([value, key]) => h('option', { key: value, value: value }, t(key))),
        ),
      ),
      h(Segmented, {
        'aria-label': t('library.view.table'),
        value: snapshot.viewMode,
        items: [
          { id: 'table', icon: 'list', title: t('library.view.table') },
          { id: 'grid', icon: 'grid', title: t('library.view.grid') },
        ],
        onChange: (value) => {
          if (value === snapshot.viewMode) return
          withViewTransition(props.scopeRef && props.scopeRef.current, () => controller.setViewMode(value))
        },
      }),
    ),
    h('span', { className: 'ph-spacer' }),
    h(
      'div',
      { className: 'ph-toolbar__tail' },
      h('span', { className: 'ph-toolbar__count' }, t('library.table.total', { count: snapshot.total || snapshot.items.length })),
      h(IconButton, {
        icon: 'panelRight',
        title: snapshot.ui.rightCollapsed ? t('library.details.expand') : t('library.details.collapse'),
        'aria-label': snapshot.ui.rightCollapsed ? t('library.details.expand') : t('library.details.collapse'),
        active: !snapshot.ui.rightCollapsed,
        onClick: () => controller.toggleRight(),
      }),
    ),
  )
}

/**
 * Floating batch bar for the current selection: reference in conversation, add
 * tags, add to a collection, and move to/restore/purge from Trash.
 */
export function BatchBar(props) {
  const t = props.t
  const api = props.api
  const snapshot = props.snapshot
  const controller = props.controller
  const { push } = useToasts()
  const [tagOpen, setTagOpen] = React.useState(false)
  const [tagValue, setTagValue] = React.useState('')
  const [collectionOpen, setCollectionOpen] = React.useState(false)
  const [busy, setBusy] = React.useState('')
  const [armed, setArmed] = React.useState(false)
  const count = snapshot.selection.length
  const selectedPapers = (snapshot.items || []).filter((paper) => snapshot.selection.indexOf(paper.id) >= 0)
  const allFavorite = selectedPapers.length > 0 && selectedPapers.every((paper) => paper.favorite === true)
  if (count === 0) return null

  const toast = (tone, text) => {
    push(tone, text)
    if (props.pushToast) props.pushToast(tone, text)
  }

  const cite = () => {
    const papers = controller.selectedPapers()
    setBusy('cite')
    api('references.commit', {
      items: papers.map((paper) => ({ kind: 'paper', id: paper.id })),
      operationId: operationId('refs'),
    })
      .then((result) => {
        pendingStore.add(result, papers.map((paper) => ({ kind: 'paper', id: paper.id, title: paper.titleZh || paper.displayTitle || paper.title })))
        toast('success', t('toast.cited'))
        controller.clearSelection()
      })
      .catch((error) => toast('error', t('toast.citeFailed', { message: describeError(t, error) })))
      .then(() => setBusy(''))
  }

  const applyTag = () => {
    const value = tagValue.trim()
    if (!value) {
      toast('info', t('toast.tagRequired'))
      return
    }
    setBusy('tag')
    controller
      .addTagsToSelection([value])
      .then(() => {
        toast('success', t('library.batch.tagsAdded'))
        setTagValue('')
        setTagOpen(false)
        controller.clearSelection()
      })
      .catch((error) => toast('error', t('toast.failed', { message: describeError(t, error) })))
      .then(() => setBusy(''))
  }

  const assign = (collection) => {
    setBusy('collection')
    controller
      .assignCollection(collection.id, snapshot.selection, true)
      .then(() => {
        toast('success', t('library.collection.assign') + ' · ' + collection.name)
        setCollectionOpen(false)
      })
      .catch((error) => toast('error', t('toast.failed', { message: describeError(t, error) })))
      .then(() => setBusy(''))
  }

  const trashMode = snapshot.filters.view === 'trash'
  const collections = (snapshot.collections || []).filter((collection) => collection.kind !== 'field')

  return h(
    'div',
    { className: 'ph-batch', role: 'toolbar' },
    h('span', { className: 'ph-batch__count' }, t('library.selectedCount', { count: count })),
    h('span', { className: 'ph-batch__divider' }),
    trashMode
      ? h(
          React.Fragment,
          null,
          h(Button, { size: 'sm', icon: 'restore', loading: busy === 'restore', onClick: () => { setBusy('restore'); controller.restoreSelection().then(() => toast('success', t('toast.restored'))).catch((error) => toast('error', t('toast.failed', { message: describeError(t, error) }))).then(() => setBusy('')) } }, t('library.batch.restore')),
          h(Button, { size: 'sm', variant: 'danger', icon: 'trash', loading: busy === 'purge', onClick: () => { if (!armed) { setArmed(true); return } setBusy('purge'); controller.purgeSelection().then(() => { toast('success', t('toast.purged')); setArmed(false) }).catch((error) => toast('error', t('toast.failed', { message: describeError(t, error) }))).then(() => setBusy('')) } }, armed ? t('library.batch.purgeConfirm') : t('library.batch.purge')),
        )
      : h(
          React.Fragment,
          null,
          h(
            'div',
            { className: 'ph-batch__group ph-batch__group--primary' },
            h(Button, { size: 'sm', variant: 'primary', icon: 'quote', loading: busy === 'cite', onClick: cite }, t('library.batch.cite')),
            h(Button, { size: 'sm', icon: 'star', className: allFavorite ? 'ph-batch__icon ph-batch__icon--on' : 'ph-batch__icon', title: allFavorite ? t('folders.unfavorite') : t('details.favoriteOff'), onClick: () => { const next = !allFavorite; setBusy('fav'); controller.setFavorite(snapshot.selection, next).then(() => toast('success', next ? t('details.favoriteOn') : t('folders.unfavorite'))).catch((error) => toast('error', describeError(t, error))).then(() => setBusy('')) } }, allFavorite ? t('folders.unfavorite') : t('details.favoriteOff')),
          ),
          h('span', { className: 'ph-batch__divider ph-batch__divider--soft' }),
          h(
            'div',
            { className: 'ph-batch__group ph-batch__group--secondary' },
            h(FolderPicker, { t: t, folders: props.folders, value: '', allowAll: true, className: 'ph-select--inline ph-select--quiet', label: t('folders.assignTo'), onChange: (id) => { if (!id) return; setBusy('folder'); controller.assignFolder(id, snapshot.selection, true).then(() => toast('success', t('folders.assigned'))).catch((error) => toast('error', describeError(t, error))).then(() => setBusy('')) } }),
            tagOpen
              ? h(
                  'span',
                  { className: 'ph-batch__tag' },
                  h('input', { value: tagValue, autoFocus: true, placeholder: t('library.batch.tagPlaceholder'), onChange: (event) => setTagValue(event.target.value), onKeyDown: (event) => { if (event.key === 'Enter') applyTag(); if (event.key === 'Escape') { setTagOpen(false); setTagValue('') } } }),
                  h(Button, { size: 'sm', variant: 'primary', loading: busy === 'tag', onClick: applyTag }, t('library.batch.tagApply')),
                )
              : h(Button, { size: 'sm', icon: 'tag', title: t('library.batch.tag'), onClick: () => setTagOpen(true) }, t('library.batch.tag')),
            collectionOpen
              ? h(
                  'span',
                  { className: 'ph-batch__tag' },
                  h(
                    'select',
                    {
                      className: 'ph-select',
                      defaultValue: '',
                      onChange: (event) => {
                        const collection = collections.find((item) => item.id === event.target.value)
                        if (collection) assign(collection)
                      },
                    },
                    h('option', { value: '', disabled: true }, t('library.batch.collection')),
                    collections.map((collection) => h('option', { key: collection.id, value: collection.id }, collection.name)),
                  ),
                  h(IconButton, { icon: 'close', title: t('common.cancel'), onClick: () => setCollectionOpen(false) }),
                )
              : h(Button, { size: 'sm', icon: 'collection', title: t('library.batch.collection'), onClick: () => setCollectionOpen(true) }, t('library.batch.collection')),
            h('select', { className: 'ph-select ph-select--inline ph-select--quiet', defaultValue: '', 'aria-label': t('library.batch.reading'), onChange: (event) => { const value = event.target.value; if (!value) return; setBusy('reading'); controller.setReadingSelection(snapshot.selection, value).then(() => toast('success', t('library.batch.readingUpdated'))).catch((error) => toast('error', t('toast.failed', { message: describeError(t, error) }))).then(() => setBusy('')) } }, h('option', { value: '' }, t('library.batch.reading')), h('option', { value: 'to-read' }, t('library.smart.toRead')), h('option', { value: 'reading' }, t('library.smart.reading')), h('option', { value: 'read' }, t('library.smart.read'))),
            h(Button, { size: 'sm', icon: 'copy', loading: busy === 'citeCopy', title: t('library.batch.copyCitation'), onClick: () => { setBusy('citeCopy'); api('citation.format', { ids: snapshot.selection, style: 'bibtex' }).then((result) => copyText(result && result.content ? result.content : '')).then((ok) => toast(ok ? 'success' : 'warning', ok ? t('common.copied') : t('common.unavailable'))).catch((error) => toast('error', t('toast.failed', { message: describeError(t, error) }))).then(() => setBusy('')) } }, t('library.batch.copyCitation')),
            h(Button, { size: 'sm', icon: 'chart', loading: busy === 'metrics', title: t('library.batch.updateMetrics'), onClick: () => { setBusy('metrics'); controller.refreshMetrics(snapshot.selection).then((result) => { const results = result && Array.isArray(result.results) ? result.results : []; const ok = results.filter((entry) => entry && entry.status !== 'failed').length; toast(ok > 0 ? 'success' : 'warning', ok > 0 ? t('metrics.batchUpdated', { count: ok }) : t('metrics.refreshUnavailable')) }).catch((error) => toast('error', t('metrics.refreshFailed', { message: describeError(t, error) }))).then(() => setBusy('')) } }, t('library.batch.updateMetrics')),
            h(Button, { size: 'sm', variant: 'danger', icon: 'trash', className: 'ph-batch__trash', loading: busy === 'trash', title: armed ? t('library.batch.trashConfirm') : t('library.batch.trash'), onClick: () => { if (!armed) { setArmed(true); setTimeout(() => setArmed(false), 4500); return } setBusy('trash'); controller.trashSelection().then((removed) => { toast('success', t('toast.trashed') + (removed ? ' · ' + removed : '')); setArmed(false) }).catch((error) => toast('error', t('toast.failed', { message: describeError(t, error) }))).then(() => setBusy('')) } }, armed ? t('library.batch.trashConfirm') : t('library.batch.trash')),
          ),
        ),
    h('span', { className: 'ph-batch__divider' }),
    h(IconButton, { icon: 'close', title: t('library.clearSelection'), onClick: () => { controller.clearSelection(); setTagOpen(false); setCollectionOpen(false); setArmed(false) } }),
  )
}
