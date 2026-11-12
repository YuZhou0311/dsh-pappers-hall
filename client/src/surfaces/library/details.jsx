/**
 * Right pane: Zotero-style item details with tabs for info, notes, tags and
 * annotations. Metadata edits go through `library.update`; tags and collections
 * use the v0.2 APIs with graceful fallbacks; every action reports through toast.
 */
import React from 'react'
import { h } from '../../core/dom.js'
import { Icon } from '../../core/icons.jsx'
import { Badge, Button, Check, EmptyState, IconButton, Skeleton, TabStrip, formatTime } from '../../core/primitives.jsx'
import { describeError } from '../../core/api.js'
import { copyText, downloadText, formatBytes } from '../../core/files.js'
import { firstText, metaLine, paperTitle } from '../../core/texts.js'
import { dragProps } from '../../core/dnd.js'
import { MetricsSection } from './metrics.jsx'
import { FavoriteButton, FolderPicker } from './folders.jsx'
import { pendingStore } from '../../core/pending.js'

function operationId(prefix) {
  const random =
    typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
      ? crypto.randomUUID()
      : Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 10)
  return (prefix ? prefix + '-' : '') + random
}

function Field(props) {
  if (props.value == null || props.value === '') return null
  return h(React.Fragment, null, h('dt', null, props.label), h('dd', { className: props.mono ? 'ph-mono' : undefined }, props.value))
}

let figureDragActive = false

function figureUrl(figure) {
  return (figure && figure.imageUrl) || (figure && figure.id ? '/pappers-hall/figure/' + figure.id + '.png?width=480' : '')
}

function AbstractBlock(props) {
  const [open, setOpen] = React.useState(false)
  const t = props.t
  if (!props.text) {
    return h(
      'div',
      null,
      h('p', { className: 'ph-abstract ph-muted' }, t('library.details.abstractEmpty')),
      props.source ? h('div', { className: 'ph-caption' }, t('library.details.abstractSource') + ': ' + sourceLabel(t, props.source)) : null,
    )
  }
  return h(
    'div',
    null,
    h('p', { className: 'ph-abstract' + (open ? '' : ' clamped') }, props.text),
    h('button', { type: 'button', className: 'ph-linkbtn ph-abstract__more', onClick: () => setOpen(!open) }, open ? t('library.details.abstractLess') : t('library.details.abstractMore')),
    props.source ? h('div', { className: 'ph-caption' }, t('library.details.abstractSource') + ': ' + sourceLabel(t, props.source)) : null,
  )
}

/** Localized label for `abstractSource` (pdf metadata / bibliographic metadata). */
function sourceLabel(t, source) {
  if (source === 'pdf') return t('library.details.source.pdf')
  if (source === 'metadata') return t('library.details.source.metadata')
  return String(source)
}

function CollectionsBlock(props) {
  const t = props.t
  const detail = props.detail
  const controller = props.controller
  const [busyId, setBusyId] = React.useState('')
  const all = Array.isArray(props.collections) ? props.collections : []
  const fields = all.filter((collection) => collection.kind === 'field')
  const customs = all.filter((collection) => collection.kind !== 'field')
  const joined = Array.isArray(detail.collections) ? detail.collections : []
  const joinedIds = new Set(joined.map((collection) => collection.id))
  const detailFields = joined.filter((collection) => collection.kind === 'field' || (collection.id && String(collection.id).startsWith('field:')))
  const fieldBadges = (detailFields.length > 0 ? detailFields : fields.filter((collection) => joinedIds.has(collection.id))).map((collection) => collection.name)

  const toggle = (collection) => {
    if (busyId) return
    const add = !joinedIds.has(collection.id)
    setBusyId(collection.id)
    controller
      .assignCollection(collection.id, [detail.id], add)
      .then(() => props.pushToast('success', (add ? t('library.collection.assign') : t('library.collection.remove')) + ' · ' + collection.name))
      .catch((error) => props.pushToast('error', t('library.collection.assignFailed', { message: describeError(t, error) })))
      .then(() => setBusyId(''))
  }

  return h(
    'div',
    { className: 'ph-detailblock' },
    h('div', { className: 'ph-detailblock__head' }, h(Icon, { name: 'collection', size: 13 }), h('span', null, t('library.details.collections'))),
    fieldBadges.length > 0 ? h('div', { className: 'ph-tagsuggest' }, fieldBadges.map((name) => h(Badge, { key: name, tone: 'business' }, name))) : null,
    customs.length > 0
      ? h(
          'div',
          { className: 'ph-collectionlist' },
          customs.map((collection) =>
            h(
              'div',
              { key: collection.id, className: 'ph-collectionlist__row' + (busyId === collection.id ? ' ph-collectionlist__row--busy' : '') },
              h(Check, {
                checked: joinedIds.has(collection.id),
                onChange: () => toggle(collection),
                label: collection.name,
                'aria-label': collection.name,
              }),
              h('span', { className: 'ph-spacer' }),
              collection.count != null ? h('span', { className: 'ph-caption' }, String(collection.count)) : null,
              busyId === collection.id ? h('span', { className: 'ph-spinner ph-spinner--inline', 'aria-hidden': 'true' }) : null,
            ),
          ),
        )
      : h('div', { className: 'ph-caption' }, props.collectionsAvailable === false ? t('library.collection.unavailable') : t('library.details.collectionsEmpty')),
  )
}

function InfoTab(props) {
  const t = props.t
  const detail = props.detail
  const summary = props.summary
  const controller = props.controller
  const [editing, setEditing] = React.useState(false)
  const [titleZh, setTitleZh] = React.useState(firstText(detail && detail.titleZh, summary && summary.titleZh))
  const [saving, setSaving] = React.useState(false)
  const fileInfo = (detail && detail.fileInfo) || {}
  const sources = Array.isArray(detail && detail.sources) ? detail.sources : []

  React.useEffect(() => {
    setTitleZh(firstText(detail && detail.titleZh, summary && summary.titleZh))
    setEditing(false)
  }, [detail && detail.id, detail && detail.titleZh, summary && summary.titleZh])

  const save = () => {
    const value = titleZh.trim()
    setSaving(true)
    controller
      .updatePaper(detail.id, { titleZh: value })
      .then(() => props.pushToast('success', t('library.details.titleZhSaved')))
      .catch((error) => props.pushToast('error', t('library.details.updateFailed', { message: describeError(t, error) })))
      .then(() => {
        setSaving(false)
        setEditing(false)
      })
  }

  return h(
    'div',
    { className: 'ph-detailblock' },
    h(
      'div',
      { className: 'ph-editabletitle' },
      editing
        ? h(
            'div',
            { className: 'ph-editabletitle__row' },
            h('input', { value: titleZh, autoFocus: true, onChange: (event) => setTitleZh(event.target.value), onKeyDown: (event) => { if (event.key === 'Enter') save(); if (event.key === 'Escape') setEditing(false) } }),
            h(IconButton, { icon: 'check', title: t('library.details.saveTitleZh'), onClick: save, disabled: saving }),
            h(IconButton, { icon: 'close', title: t('common.cancel'), onClick: () => setEditing(false) }),
          )
        : h(
            'div',
            { className: 'ph-editabletitle__row' },
            h('span', { className: 'ph-editabletitle__text' }, firstText(detail.titleZh, summary.titleZh, detail.displayTitle, detail.title, t('common.untitled'))),
            h(IconButton, { icon: 'edit', title: t('library.details.editTitleZh'), onClick: () => setEditing(true) }),
          ),
      detail.title ? h('span', { className: 'ph-editabletitle__original' }, detail.title) : null,
    ),
    h(
      'dl',
      { className: 'ph-fieldgrid' },
      h(Field, { label: t('library.details.authors'), value: metaLine(t, detail).split(' · ')[0] }),
      h(Field, { label: t('library.details.year'), value: detail.year ? String(detail.year) : '' }),
      h(Field, { label: t('library.details.venue'), value: firstText(detail.venue, detail.containerTitle) }),
      h(Field, { label: t('library.details.doi'), value: detail.doi, mono: true }),
      h(Field, { label: t('library.details.arxiv'), value: detail.arxivId, mono: true }),
      h(Field, { label: t('library.details.issn'), value: detail.issn || (detail.metrics && detail.metrics.issn), mono: true }),
      h(Field, { label: t('library.details.publisher'), value: detail.publisher || (detail.metrics && detail.metrics.publisher) }),
      h(Field, { label: t('library.details.volume'), value: detail.volume }),
      h(Field, { label: t('library.details.issue'), value: detail.issue }),
      h(Field, { label: t('library.details.publicationDate'), value: detail.publicationDate }),
      h(Field, { label: t('library.details.license'), value: detail.license }),
      h(Field, { label: t('library.details.version'), value: fileInfo.sourceVersion }),
      h(Field, { label: t('library.details.pages'), value: Number(detail.pageCount || fileInfo.pageCount) || '' }),
      h(Field, { label: t('library.details.size'), value: fileInfo.bytes ? formatBytes(fileInfo.bytes) : '' }),
      h(Field, { label: t('library.details.sha'), value: fileInfo.sha256 ? String(fileInfo.sha256).slice(0, 12) : '', mono: true }),
    ),
    h(MetricsSection, {
      t: t,
      detail: detail,
      onRefresh: props.onUpdateMetrics,
      onSave: props.onEditMetrics,
      onReset: props.onResetMetrics,
      onToast: props.onToast || props.pushToast,
    }),
    Array.isArray(detail.keywords) && detail.keywords.length > 0
      ? h(
          'div',
          { className: 'ph-detailblock' },
          h('div', { className: 'ph-detailblock__head' }, h(Icon, { name: 'tag', size: 13 }), h('span', null, t('metrics.keywords'))),
          h('div', { className: 'ph-tagsuggest' }, detail.keywords.map((keyword) => h(Badge, { key: keyword, tone: 'muted' }, keyword))),
        )
      : null,
    h(
      'div',
      { className: 'ph-detailblock' },
      h('div', { className: 'ph-detailblock__head' }, h(Icon, { name: 'edit', size: 13 }), h('span', null, t('library.details.abstract'))),
      h(AbstractBlock, { t: t, text: firstText(detail.abstract), source: detail.abstractSource }),
    ),
    h(
      'div',
      { className: 'ph-detailblock' },
      h('div', { className: 'ph-detailblock__head' }, h(Icon, { name: 'star', size: 13 }), h('span', null, t('folders.favorite'))),
      h('div', { className: 'ph-favoriterow' },
        h(FavoriteButton, { t: t, paper: detail, onToggle: (next) => controller.setFavorite([detail.id], next).then(() => props.onToast('success', next ? t('details.favoriteOn') : t('folders.unfavorite'))).catch((error) => props.onToast('error', describeError(t, error))) }),
        h('span', { className: detail.favorite ? 'ph-favlabel ph-favlabel--on' : 'ph-favlabel' }, detail.favorite ? t('details.favoriteOn') : t('details.favoriteOff')),
      ),
      h('div', { className: 'ph-caption' }, t('folders.mine')),
      h(FolderPicker, {
        t: t,
        folders: props.folders,
        // library.get returns memberships as `collections`; older hosts used
        // `folders`. Prefer collections so the picker reflects reality.
        value: (() => {
          const all = Array.isArray(detail.collections) ? detail.collections : Array.isArray(detail.folders) ? detail.folders : []
          // Field membership is not a pickable folder; prefer the first custom folder.
          const folder = all.find((entry) => entry && entry.kind !== 'field' && !String(entry.id || '').startsWith('field:')) || all[0]
          return folder && folder.id ? folder.id : ''
        })(),
        className: 'ph-select--block',
        onChange: (id) => {
          if (id) {
            controller.assignFolder(id, [detail.id], true)
              .then(() => props.onToast('success', t('folders.assigned')))
              .catch((error) => props.onToast('error', describeError(t, error)))
            return
          }
          // "未分类" = release every current membership; Host has no null
          // collectionId, so call assign(add:false) per existing folder.
          const memberships = Array.isArray(detail.collections) && detail.collections.length > 0
            ? detail.collections
            : (Array.isArray(detail.folders) ? detail.folders : [])
          const current = memberships
            .filter((folder) => folder && folder.kind !== 'field' && !String(folder.id || '').startsWith('field:'))
            .map((folder) => folder && (folder.id || folder.collectionId))
            .filter(Boolean)
          if (current.length === 0) {
            props.onToast('info', t('folders.alreadyNone'))
            return
          }
          Promise.all(current.map((folderId) => controller.assignFolder(folderId, [detail.id], false)))
            .then(() => props.onToast('success', t('folders.released')))
            .catch((error) => props.onToast('error', describeError(t, error)))
        },
      }),
    ),
    Array.isArray(props.figures) && props.figures.length > 0
      ? h(
          'div',
          { className: 'ph-detailblock' },
          h('div', { className: 'ph-detailblock__head' }, h(Icon, { name: 'figure', size: 13 }), h('span', null, t('library.details.figures'))),
          props.figures.slice(0, 8).map((figure) =>
            h(
              'div',
              {
                key: figure.id,
                className: 'ph-figrow',
                role: 'button',
                tabIndex: 0,
                title: t('library.details.figureLocate'),
                onClick: () => {
                  if (figureDragActive) {
                    figureDragActive = false
                    return
                  }
                  if (props.onLocateFigure) props.onLocateFigure(detail.id, figure)
                  else props.onOpenPaper(detail.id, figure.page || 1)
                },
                onKeyDown: (event) => {
                  if (event.key !== 'Enter' && event.key !== ' ') return
                  event.preventDefault()
                  if (props.onLocateFigure) props.onLocateFigure(detail.id, figure)
                  else props.onOpenPaper(detail.id, figure.page || 1)
                },
                onDragStartCapture: () => { figureDragActive = true },
                onDragEndCapture: () => { setTimeout(() => { figureDragActive = false }, 80) },
              },
              h('div', { className: 'ph-figrow__thumb' }, h('img', { src: figureUrl(figure), alt: '', loading: 'lazy', decoding: 'async', draggable: false })),
              h(
                'div',
                Object.assign({ className: 'ph-figrow__body' }, dragProps(t, [{ kind: 'figure', id: figure.id, page: figure.page, title: paperTitle(t, detail) }], { source: 'details-figure' })),
                h('div', { className: 'ph-figrow__meta' }, t('figure.search.pageFigure', { page: Number(figure.page) || 1, label: figure.label || '?' })),
                h('div', { className: 'ph-figrow__caption' }, firstText(figure.caption, t('reader.figure.noCaption'))),
              ),
              h(IconButton, {
                icon: 'external',
                title: t('library.details.figureLocate'),
                'aria-label': t('library.details.figureLocate'),
                onClick: (event) => {
                  event.stopPropagation()
                  if (props.onLocateFigure) props.onLocateFigure(detail.id, figure)
                  else props.onOpenPaper(detail.id, figure.page || 1)
                },
              }),
            ),
          ),
        )
      : null,
    sources.length > 0
      ? h(
          'div',
          { className: 'ph-detailblock' },
          h('div', { className: 'ph-detailblock__head' }, h(Icon, { name: 'link', size: 13 }), h('span', null, t('library.details.sources'))),
          h('dl', { className: 'ph-fieldgrid' }, sources.map((source, index) => h(Field, { key: index, label: source.kind || 'source', value: source.url, mono: true }))),
        )
      : null,
    h(
      'div',
      { className: 'ph-detailblock' },
      h('div', { className: 'ph-detailblock__head' }, h(Icon, { name: 'settings', size: 13 }), h('span', null, t('library.details.actions'))),
      h(
        'div',
        { className: 'ph-actiongrid' },
        h(Button, { variant: 'primary', icon: 'book', onClick: () => props.onOpenPaper(detail.id, 1) }, t('library.details.open')),
        h(Button, { icon: 'quote', onClick: () => props.onCite(detail) }, t('library.details.cite')),
        h(Button, { icon: 'copy', onClick: () => props.onCopyCitation && props.onCopyCitation(detail, 'bibtex') }, t('library.details.copyBibtex')),
        h(Button, { icon: 'key', onClick: () => props.onCopyCitationKey && props.onCopyCitationKey(detail) }, t('library.details.copyCitationKey')),
        h(Button, { icon: 'download', onClick: () => props.onExport(detail) }, t('library.details.export')),
        h(Button, { icon: 'external', disabled: !detail.id, onClick: () => { if (typeof window !== 'undefined') window.open('/pappers-hall/pdf/' + encodeURIComponent(detail.id), '_blank', 'noopener') } }, t('library.details.openPdf')),
        h(
          Button,
          {
            icon: 'copy',
            onClick: () => {
              copyText(fileInfo.path || '').then((ok) => props.pushToast(ok ? 'success' : 'warning', ok ? t('library.details.pathCopied') : t('common.unavailable')))
            },
          },
          t('library.details.copyPath'),
        ),
        h(
          Button,
          {
            icon: detail.read ? 'circle' : 'checkCircle',
            onClick: () => {
              controller
                .setRead(detail.id, !detail.read)
                .then(() => props.pushToast('success', t('library.details.readUpdated')))
                .catch((error) => props.pushToast('error', t('toast.failed', { message: describeError(t, error) })))
            },
          },
          detail.read ? t('library.details.markUnread') : t('library.details.markRead'),
        ),
      ),
    ),
  )
}

function TagsTab(props) {
  const t = props.t
  const detail = props.detail
  const controller = props.controller
  const [value, setValue] = React.useState('')
  const tags = Array.isArray(detail.tags) ? detail.tags : []
  const suggestions = (props.tags || []).filter((tag) => tags.indexOf(tag.name) < 0 && (!value || String(tag.name).toLowerCase().includes(value.toLowerCase()))).slice(0, 8)

  const add = () => {
    const tag = value.trim()
    if (!tag) {
      props.pushToast('info', t('toast.tagRequired'))
      return
    }
    setValue('')
    controller
      .addTag(detail.id, tag)
      .then(() => props.pushToast('success', t('library.details.tagAdded')))
      .catch((error) => props.pushToast('error', t('toast.failed', { message: describeError(t, error) })))
  }

  return h(
    'div',
    { className: 'ph-detailblock' },
    h('div', { className: 'ph-detailblock__head' }, h(Icon, { name: 'tag', size: 13 }), h('span', null, t('library.details.tags'))),
    h(
      'div',
      { className: 'ph-tageditor' },
      tags.map((tag) =>
        h(
          'span',
          { key: tag, className: 'ph-tagitem' },
          h('span', null, tag),
          h('button', { type: 'button', title: t('library.details.tagRemove'), 'aria-label': t('library.details.tagRemove'), onClick: () => controller.removeTag(detail.id, tag).then(() => props.pushToast('success', t('library.details.tagRemoved'))).catch((error) => props.pushToast('error', t('toast.failed', { message: describeError(t, error) }))) }, h(Icon, { name: 'close', size: 10 })),
        ),
      ),
      h('input', { className: 'ph-taginput', value: value, placeholder: t('library.details.tagPlaceholder'), onChange: (event) => setValue(event.target.value), onKeyDown: (event) => { if (event.key === 'Enter') add() } }),
    ),
    tags.length === 0 ? h('div', { className: 'ph-caption' }, t('library.details.tagsEmpty')) : null,
    suggestions.length > 0
      ? h(
          'div',
          { className: 'ph-tagsuggest' },
          h('span', { className: 'ph-tagsuggest__label' }, t('library.details.tagAdd') + ':'),
          suggestions.map((tag) => h('button', { key: tag.name, type: 'button', className: 'ph-tagchip', onClick: () => controller.addTag(detail.id, tag.name).then(() => props.pushToast('success', t('library.details.tagAdded'))).catch((error) => props.pushToast('error', t('toast.failed', { message: describeError(t, error) }))) }, h('span', { className: 'ph-tagchip__label' }, tag.name), h('span', { className: 'ph-tagchip__count' }, String(tag.count)))),
        )
      : null,
    props.tagsAvailable === false ? h('div', { className: 'ph-caption' }, t('library.collection.unavailable')) : null,
  )
}

function NotesTab(props) {
  const t = props.t
  const notes = Array.isArray(props.notes) ? props.notes : []
  if (notes.length === 0) return h(EmptyState, { compact: true, icon: 'note', title: t('library.details.notesEmpty'), desc: t('library.details.notesHint') })
  return h(
    'div',
    { className: 'ph-detailblock' },
    notes.map((note) =>
      h(
        'div',
        { key: note.id || note.createdAt || Math.random(), className: 'ph-detailannot' },
        h('div', { className: 'ph-detailannot__head' }, h(Icon, { name: 'note', size: 12 }), h('span', null, formatTime(note.createdAt))),
        h('div', { className: 'ph-detailannot__text' }, note.text || ''),
      ),
    ),
  )
}

function AnnotationsTab(props) {
  const t = props.t
  const annotations = Array.isArray(props.annotations) ? props.annotations : []
  if (annotations.length === 0) return h(EmptyState, { compact: true, icon: 'highlighter', title: t('library.details.annotationsEmpty') })
  return h(
    'div',
    { className: 'ph-detailblock' },
    props.onExportAnnotations
      ? h(
          'div',
          { className: 'ph-toolrow' },
          h(Button, { size: 'sm', icon: 'copy', onClick: () => props.onExportAnnotations(props.detail, 'markdown', 'copy') }, t('annotations.copyMarkdown')),
          h(Button, { size: 'sm', icon: 'download', onClick: () => props.onExportAnnotations(props.detail, 'markdown', 'download') }, t('annotations.downloadMarkdown')),
          h(Button, { size: 'sm', icon: 'json', onClick: () => props.onExportAnnotations(props.detail, 'json', 'download') }, t('annotations.downloadJson')),
        )
      : null,
    annotations.map((annotation) =>
      h(
        'div',
        { key: annotation.id, className: 'ph-detailannot ph-detailannot--' + (annotation.color || 'yellow') },
        h(
          'div',
          { className: 'ph-detailannot__head' },
          h('button', { type: 'button', className: 'ph-linkbtn', onClick: () => props.onOpenPaper(annotation.paperId, annotation.page || 1, annotation.id) }, t('library.details.annotationPage', { page: Number(annotation.page) || 1 })),
          h(Badge, { tone: 'muted' }, t('reader.annotation.origin.' + (annotation.origin === 'ai_explanation' ? 'ai' : annotation.origin === 'test_note' ? 'test' : 'user'))),
          h('span', { className: 'ph-spacer' }),
          h(IconButton, { icon: 'quote', title: t('library.details.annotationCite'), onClick: () => props.onCiteAnnotation(annotation) }),
        ),
        annotation.quote ? h('div', { className: 'ph-detailannot__quote' }, annotation.quote) : null,
        h('div', { className: 'ph-detailannot__text' }, annotation.comment || annotation.text || ''),
      ),
    ),
  )
}

export function DetailsPane(props) {
  const t = props.t
  const snapshot = props.snapshot
  const controller = props.controller
  const details = snapshot.details
  const paperId = details.paperId
  const summary = paperId ? snapshot.items.find((paper) => paper.id === paperId) : null
  const detail = details.data || summary
  const collapsed = snapshot.ui.rightCollapsed
  const tab = details.tab || 'info'
  const tabs = [
    { id: 'info', label: t('library.details.tab.info') },
    { id: 'notes', label: t('library.details.tab.notes'), count: Array.isArray(details.notes) ? details.notes.length : 0 },
    { id: 'tags', label: t('library.details.tab.tags') },
    { id: 'annotations', label: t('library.details.tab.annotations'), count: Array.isArray(details.annotations) ? details.annotations.length : 0 },
  ]

  const head = h(
    'div',
    { className: 'ph-details__head' },
    h(
      'div',
      { className: 'ph-details__heading' },
      h('span', { className: 'ph-details__title', title: paperId ? paperTitle(t, detail || {}) : '' }, paperId ? paperTitle(t, detail || {}) : t('library.details.tab.info')),
      paperId && detail && detail.title && detail.title !== paperTitle(t, detail) ? h('span', { className: 'ph-details__original', title: detail.title }, detail.title) : null,
    ),
    h(
      'div',
      { className: 'ph-details__actions' },
      paperId ? h(IconButton, { icon: 'close', title: t('common.close'), onClick: () => controller.closeDetails() }) : null,
      h(IconButton, { icon: collapsed ? 'chevronLeft' : 'chevronRight', title: collapsed ? t('library.details.expand') : t('common.close'), onClick: () => controller.toggleRight() }),
    ),
  )

  if (!paperId) {
    return h('div', { className: 'ph-details' }, head, h('div', { className: 'ph-details__empty' }, h(EmptyState, { compact: true, icon: 'file', title: t('library.details.emptyTitle'), desc: t('library.details.emptyDesc') })))
  }

  let body = null
  if (!detail && details.status === 'loading') {
    body = h(
      'div',
      { className: 'ph-details__scroll ph-scroll' },
      h(
        'div',
        { className: 'ph-details__skeleton' },
        h(Skeleton, { width: '78%', height: 18 }),
        h(Skeleton, { width: '52%', height: 11 }),
        h('div', { style: { height: 8 } }),
        [0, 1, 2, 3, 4, 5].map((index) => h('div', { key: index, className: 'ph-details__skeletonrow' }, h(Skeleton, { width: 64, height: 10 }), h(Skeleton, { flex: 1, width: 'auto', height: 10 }))),
      ),
    )
  } else if (details.status === 'error' && !detail) {
    body = h('div', { className: 'ph-details__scroll ph-scroll' }, h(EmptyState, { compact: true, tone: 'error', icon: 'warning', title: t('library.details.error', { message: describeError(t, details.error) }), action: h(Button, { size: 'sm', variant: 'secondary', icon: 'refresh', onClick: () => controller.selectPaper(paperId) }, t('common.retry')) }))
  } else if (!detail) {
    body = h('div', { className: 'ph-details__scroll ph-scroll' }, h(EmptyState, { compact: true, icon: 'book', title: t('library.details.notFound') }))
  } else {
    body = h(
      'div',
      { className: 'ph-details__scroll ph-scroll' },
      tab === 'info'
        ? h(InfoTab, {
            t: t,
            detail: detail,
            summary: summary,
            controller: controller,
            snapshot: snapshot,
            collections: snapshot.collections,
            collectionsAvailable: snapshot.collectionsAvailable,
            figures: details.figures,
            onOpenPaper: props.onOpenPaper,
            onLocateFigure: props.onLocateFigure,
            onCite: props.onCite,
            onExport: props.onExport,
            onFindSimilar: props.onFindSimilar,
            onCopyCitation: props.onCopyCitation,
            onCopyCitationKey: props.onCopyCitationKey,
            onUpdateMetrics: props.onUpdateMetrics,
            onEditMetrics: props.onEditMetrics,
            onResetMetrics: props.onResetMetrics,
            folders: snapshot.folders,
            onToast: props.pushToast,
            pushToast: props.pushToast,
          })
        : tab === 'tags'
          ? h(TagsTab, { t: t, detail: detail, controller: controller, tags: snapshot.tags, tagsAvailable: snapshot.tagsAvailable, pushToast: props.pushToast })
          : tab === 'notes'
            ? h(NotesTab, { t: t, notes: details.notes })
            : h(AnnotationsTab, { t: t, detail: detail, annotations: details.annotations, onOpenPaper: props.onOpenPaper, onCiteAnnotation: props.onCiteAnnotation, onExportAnnotations: props.onExportAnnotations, pushToast: props.pushToast }),
    )
  }

  return h(
    'div',
    { className: 'ph-details' },
    head,
    !detail ? null : h('div', { className: 'ph-details__tabs' }, h(TabStrip, { items: tabs, value: tab, onChange: (value) => controller.setDetailTab(value), 'aria-label': t('library.details.tab.info'), variant: 'pill' })),
    body,
  )
}
