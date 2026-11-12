/**
 * Left pane of the Zotero-style library: smart views, collections (field-derived
 * and custom) and tags with AND filtering. Items can be dragged onto a
 * collection to assign them.
 */
import React from 'react'
import { h } from '../../core/dom.js'
import { Icon } from '../../core/icons.jsx'
import { Badge, Check, IconButton } from '../../core/primitives.jsx'
import { COLLECTION_COLORS, MATERIAL_MIME } from '../../core/constants.js'
import { tagColor } from '../../core/tag-colors.js'
import { FolderTree } from './folders.jsx'
import { NotesSidebar } from './notes-sidebar.jsx'

const SMART_VIEWS = [
  { id: 'all', icon: 'book', label: 'library.smart.all' },
  { id: 'recentAdded', icon: 'clock', label: 'library.smart.recentAdded' },
  { id: 'annotated', icon: 'highlighter', label: 'library.smart.annotated' },
  { id: 'trash', icon: 'trash', label: 'library.smart.trash' },
]

function readPaperIds(event) {
  try {
    const raw = event.dataTransfer.getData(MATERIAL_MIME)
    if (!raw) return []
    const payload = JSON.parse(raw)
    return Array.isArray(payload && payload.materials) ? payload.materials.filter((item) => item && item.kind === 'paper').map((item) => String(item.id)) : []
  } catch {
    return []
  }
}

function CollectionRow(props) {
  const t = props.t
  const collection = props.collection
  const [dropActive, setDropActive] = React.useState(false)
  const [editing, setEditing] = React.useState(false)
  const [name, setName] = React.useState(collection.name || '')
  const [color, setColor] = React.useState(collection.color || 'blue')
  const [armed, setArmed] = React.useState(false)
  const isField = collection.kind === 'field'

  React.useEffect(() => {
    setName(collection.name || '')
    setColor(collection.color || 'blue')
  }, [collection.name, collection.color])

  const save = () => {
    const value = name.trim()
    if (!value) return
    props.onUpdate(collection, { name: value, color: color })
    setEditing(false)
  }

  return h(
    'div',
    { className: 'ph-collection__wrap' },
    h(
      'button',
      {
        type: 'button',
        className:
          'ph-collection' +
          (props.active ? ' ph-collection--active' : '') +
          (isField ? ' ph-collection--field' : '') +
          (dropActive ? ' ph-collection--drop' : ''),
        onClick: () => !editing && props.onSelect(collection),
        onDoubleClick: () => {
          if (!isField) setEditing(true)
        },
        onDragOver: (event) => {
          if (isField) return
          if (!event.dataTransfer || Array.prototype.indexOf.call(event.dataTransfer.types, MATERIAL_MIME) < 0) return
          event.preventDefault()
          event.dataTransfer.dropEffect = 'copy'
          if (!dropActive) setDropActive(true)
        },
        onDragLeave: () => setDropActive(false),
        onDrop: (event) => {
          if (isField) return
          event.preventDefault()
          setDropActive(false)
          const ids = readPaperIds(event)
          if (ids.length > 0) props.onAssign(collection, ids)
        },
        title: isField ? collection.name : collection.name + ' · ' + t('library.collection.rename'),
      },
      h('span', { className: 'ph-collection__dot', 'data-color': collection.color || (isField ? 'slate' : 'blue') }),
      h('span', { className: 'ph-collection__label' }, collection.name),
      h('span', { className: 'ph-collection__count' }, collection.count != null ? String(collection.count) : ''),
      !isField
        ? h(IconButton, {
            icon: 'more',
            title: t('library.collection.rename'),
            className: 'ph-collection__edit',
            onClick: (event) => {
              event.stopPropagation()
              setEditing(!editing)
            },
          })
        : null,
    ),
    editing
      ? h(
          'div',
          { className: 'ph-collection__editor' },
          h('div', { className: 'ph-collection__editorRow' }, h('input', { className: 'ph-inlineinput', value: name, autoFocus: true, onChange: (event) => setName(event.target.value), onKeyDown: (event) => { if (event.key === 'Enter') save(); if (event.key === 'Escape') setEditing(false) } })),
          h(
            'div',
            { className: 'ph-colors' },
            COLLECTION_COLORS.map((value) =>
              h('button', {
                key: value,
                type: 'button',
                className: 'ph-color ph-color--' + value + (color === value ? ' ph-color--active' : ''),
                title: value,
                'aria-label': value,
                onClick: () => setColor(value),
              }),
            ),
          ),
          h(
            'div',
            { className: 'ph-collection__editorActions' },
            h('button', { type: 'button', className: 'ph-btn ph-btn--primary ph-btn--sm', onClick: save }, t('common.confirm')),
            h('button', { type: 'button', className: 'ph-btn ph-btn--ghost ph-btn--sm', onClick: () => setEditing(false) }, t('common.cancel')),
            h(
              'button',
              {
                type: 'button',
                className: 'ph-btn ph-btn--danger ph-btn--sm',
                onClick: () => {
                  if (!armed) {
                    setArmed(true)
                    return
                  }
                  props.onDelete(collection)
                  setEditing(false)
                },
              },
              armed ? t('library.collection.deleteConfirm') : t('library.collection.delete'),
            ),
          ),
        )
      : null,
  )
}

export function CollectionsPane(props) {
  const t = props.t
  const snapshot = props.snapshot
  const controller = props.controller
  const filter = ''
  const [newOpen, setNewOpen] = React.useState(false)
  const [newName, setNewName] = React.useState('')
  const [newColor, setNewColor] = React.useState('blue')

  const filters = snapshot.filters
  const collections = (snapshot.collections || []).filter((collection) => !filter || String(collection.name).toLowerCase().includes(filter.toLowerCase()))
  const tags = (snapshot.tags || []).filter((tag) => !filter || String(tag.name).toLowerCase().includes(filter.toLowerCase()))
  const counts = snapshot.counts || {}

  const smartCount = (id) => {
    if (id === 'all') return counts.papers != null ? counts.papers : snapshot.total
    if (id === 'trash') return counts.trash
    if (id === 'toRead') return counts.toRead
    if (id === 'reading') return counts.reading
    if (id === 'annotated') return counts.annotations
    return undefined
  }

  const create = () => {
    const value = newName.trim()
    if (!value) return
    controller.createCollection(value, newColor).then(
      () => {
        setNewOpen(false)
        setNewName('')
        props.pushToast('success', t('library.collection.created'))
      },
      (error) => props.pushToast('error', t('toast.failed', { message: String(error && error.message ? error.message : error) })),
    )
  }

  return h(
    'div',
    { className: 'ph-left' },
    h(
      'div',
      { className: 'ph-left__head' },
      h(
        'div',
        { className: 'ph-left__toolbar' },
        h('span', { className: 'ph-left__title' }, t('library.sidebar.title')),
        h('span', { className: 'ph-spacer' }),
        h(IconButton, { icon: 'plus', title: t('library.sidebar.newCollection'), onClick: () => setNewOpen(true) }),
      ),
    ),
    h(
      'div',
      { className: 'ph-left__scroll ph-scroll' },
      h(
        'div',
        { className: 'ph-left__section' },
        h('div', { className: 'ph-left__list' },
          SMART_VIEWS.map((view) =>
            h(
              'button',
              {
                key: view.id,
                type: 'button',
                className: 'ph-navitem' + (filters.view === view.id && !filters.collectionId && !filters.field ? ' ph-navitem--active' : '') + (view.id === 'trash' && filters.view === 'trash' ? ' ph-navitem--active' : ''),
                onClick: () => controller.setView(view.id),
              },
              h(Icon, { name: view.icon, size: 14, className: 'ph-navitem__icon' }),
              h('span', { className: 'ph-navitem__label' }, t(view.label)),
              smartCount(view.id) != null ? h('span', { className: 'ph-navitem__count' }, String(smartCount(view.id))) : null,
            ),
          ),
        ),
      ),
      h(FolderTree, { t: t, folders: snapshot.folders, filter: filter, snapshot: snapshot, controller: controller, favoriteCount: (snapshot.statusData && snapshot.statusData.counts && snapshot.statusData.counts.favorite) || snapshot.items.filter((p) => p.favorite).length, onToast: props.pushToast }),
      tags.length === 0 ? null : h(
        'div',
        { className: 'ph-left__section' },
        h(
          'div',
          { className: 'ph-left__sectionHead' },
          h(Icon, { name: 'tag', size: 13 }),
          h('span', null, t('library.sidebar.tags')),
          filters.tags.length > 0 ? h(IconButton, { icon: 'close', title: t('library.sidebar.clearTags'), onClick: () => controller.clearTags() }) : null,
        ),
        h(
              'div',
              { className: 'ph-tagcloud' },
              tags.map((tag) =>
                h(
                  'button',
                  {
                    key: tag.name,
                    type: 'button',
                    className: 'ph-tagchip' + (filters.tags.indexOf(tag.name) >= 0 ? ' ph-tagchip--active' : ''),
                    'data-tag-color': tagColor(tag.name),
                    onClick: () => controller.toggleTag(tag.name),
                    title: t('library.sidebar.tagHint'),
                  },
                  h('span', { className: 'ph-tagchip__label' }, tag.name),
                  h('span', { className: 'ph-tagchip__count' }, String(tag.count)),
                  filters.tags.indexOf(tag.name) >= 0 ? h(Icon, { name: 'check', size: 10, className: 'ph-tagchip__x' }) : null,
                ),
              ),
            ),
        filters.tags.length > 0 ? h('div', { className: 'ph-left__empty' }, t('library.sidebar.selectedTags') + ': ' + filters.tags.join(' + ')) : null,
      ),
      h(NotesSidebar, {
        t: t,
        api: props.api,
        onOpenNote: props.onOpenNote,
        pushToast: props.pushToast,
      }),
    ),
  )
}
