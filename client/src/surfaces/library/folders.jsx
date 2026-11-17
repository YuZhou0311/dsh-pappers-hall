/** Zotero-style folder tree, reusable folder picker, filter chips and semantic channel chips. */
import React from 'react'
import { h } from '../../core/dom.js'
import { Icon } from '../../core/icons.jsx'
import { Badge, Button, Check, IconButton } from '../../core/primitives.jsx'
import { MATERIAL_MIME } from '../../core/constants.js'
import { COLLECTION_COLORS } from '../../core/constants.js'
import { describeError } from '../../core/api.js'

/** Keep nodes whose name matches, or that have a matching descendant. */
function filterTree(nodes, query) {
  const needle = String(query || '').trim().toLowerCase()
  if (!needle) return nodes
  const walk = (list) => (list || []).map((node) => {
    const children = walk(node.children)
    const self = String(node.name || '').toLowerCase().includes(needle)
    if (!self && children.length === 0) return null
    return Object.assign({}, node, { children: children })
  }).filter(Boolean)
  return walk(nodes)
}

function flatten(nodes, depth, out) {
  ;(nodes || []).forEach((node) => {
    out.push({ node: node, depth: depth })
    if (Array.isArray(node.children) && node.children.length > 0) flatten(node.children, depth + 1, out)
  })
  return out
}

function readPaperIds(event) {
  try {
    const raw = event.dataTransfer.getData(MATERIAL_MIME)
    const payload = JSON.parse(raw)
    return (payload.materials || []).filter((m) => m && m.kind === 'paper').map((m) => String(m.id))
  } catch (error) {
    return []
  }
}

/** Recursive folder node with inline create/rename/colour/delete and paper drop. */
function Node(props) {
  const t = props.t
  const node = props.node
  const [open, setOpen] = React.useState(true)
  const expanded = Boolean(props.forceOpen) || open
  const [editing, setEditing] = React.useState(false)
  const [name, setName] = React.useState(node.name || '')
  const [armed, setArmed] = React.useState(false)
  const [drop, setDrop] = React.useState(false)
  const [childOpen, setChildOpen] = React.useState(false)
  const [childName, setChildName] = React.useState('')
  const readOnly = false
  const children = Array.isArray(node.children) ? node.children : []
  const color = node.color || 'blue'
  const childBoxRef = React.useRef(null)
  React.useEffect(() => { setName(node.name || '') }, [node.name])
  // An inline "new child folder" editor is transient: clicking anywhere outside
  // (or blurring) dismisses it instead of leaving an empty input behind.
  React.useEffect(() => {
    if (!childOpen) return undefined
    const onPointerDown = (event) => {
      const box = childBoxRef.current
      if (box && !box.contains(event.target)) { setChildOpen(false); setChildName('') }
    }
    document.addEventListener('pointerdown', onPointerDown, true)
    return () => document.removeEventListener('pointerdown', onPointerDown, true)
  }, [childOpen])

  return h(
    'div',
    { className: 'ph-folder' + (props.depth > 0 ? ' ph-folder--nested' : ''), style: { paddingLeft: Math.min(36, props.depth * 12) + 'px' } },
    h(
      'div',
      {
        className: 'ph-folder__row' + (props.active ? ' ph-folder__row--active' : '') + (drop ? ' ph-folder__row--drop' : ''),
        onClick: () => props.onSelect(node),
        onDragOver: (event) => { if (readOnly) return; if (event.dataTransfer && Array.prototype.indexOf.call(event.dataTransfer.types, MATERIAL_MIME) >= 0) { event.preventDefault(); if (!drop) setDrop(true) } },
        onDragLeave: () => setDrop(false),
        onDrop: (event) => {
          if (readOnly) return
          event.preventDefault()
          setDrop(false)
          const ids = readPaperIds(event)
          if (ids.length > 0) props.onDropPapers(node, ids)
        },
        role: 'treeitem',
        'aria-expanded': children.length > 0 ? (expanded ? 'true' : 'false') : undefined,
      },
      h(IconButton, { icon: expanded && children.length > 0 ? 'chevronDown' : children.length > 0 ? 'chevronRight' : 'collection', title: expanded ? t('folders.collapse') : t('folders.expand'), className: 'ph-folder__caret', onClick: (event) => { event.stopPropagation(); setOpen(!open) } }),
      h('span', { className: 'ph-collection__dot', 'data-color': color, style: { opacity: readOnly ? 0.6 : 1 } }),
      editing
        ? h('input', { className: 'ph-inlineinput ph-folder__input', value: name, autoFocus: true, onClick: (event) => event.stopPropagation(), onChange: (event) => setName(event.target.value), onKeyDown: (event) => { if (event.key === 'Enter') { props.onRename(node, name.trim() || node.name); setEditing(false) } if (event.key === 'Escape') setEditing(false) }, onBlur: () => setEditing(false) })
        : h('span', { className: 'ph-folder__name', title: node.name }, node.name),
      h('span', { className: 'ph-folder__count' }, String(node.count != null ? node.count : 0)),
      readOnly ? null : h(
        'span',
        { className: 'ph-folder__actions', onClick: (event) => event.stopPropagation() },
        h(IconButton, { icon: 'plus', title: t('folders.newChild'), onClick: () => setChildOpen(true) }),
        h(IconButton, { icon: 'edit', title: t('folders.rename'), onClick: () => setEditing(true) }),
        h(IconButton, { icon: 'palette', title: t('folders.colour'), onClick: () => props.onRecolor(node, COLLECTION_COLORS[(COLLECTION_COLORS.indexOf(color) + 1) % COLLECTION_COLORS.length]) }),
        h(IconButton, { icon: 'trash', title: armed ? t('folders.deleteConfirm') : t('folders.delete'), onClick: () => { if (!armed) { setArmed(true); return } props.onDelete(node) } }),
      ),
    ),
    childOpen ? h('div', { className: 'ph-folder__childnew', ref: childBoxRef }, h('input', { className: 'ph-inlineinput', autoFocus: true, placeholder: t('folders.childPlaceholder'), value: childName, onChange: (event) => setChildName(event.target.value), onClick: (event) => event.stopPropagation(), onBlur: (event) => { const box = childBoxRef.current; if (!box || !box.contains(event.relatedTarget)) { setChildOpen(false); setChildName('') } }, onKeyDown: (event) => { if (event.key === 'Enter' && childName.trim()) { props.onCreate(node, childName.trim()); setChildName(''); setChildOpen(false) } if (event.key === 'Escape') setChildOpen(false) } })) : null,
    expanded && children.length > 0 ? children.map((child) => h(Node, Object.assign({}, props, { key: child.id, node: child, depth: props.depth + 1, active: props.activeId === child.id }))) : null,
  )
}

/** Full "我的文件夹 + 领域 + 收藏夹" tree for the left rail. */
export function FolderTree(props) {
  const t = props.t
  const folders = (props.folders && props.folders.items) || []
  const query = String(props.filter || '').trim()
  const queryLower = query.toLowerCase()
  const favoriteMatches = !queryLower || t('folders.favorite').toLowerCase().includes(queryLower)
  const userFolders = filterTree(folders, query)
  const [newOpen, setNewOpen] = React.useState(false)
  const [newName, setNewName] = React.useState('')
  const newBoxRef = React.useRef(null)
  const filters = props.snapshot.filters
  React.useEffect(() => {
    if (!newOpen) return undefined
    const onPointerDown = (event) => {
      const box = newBoxRef.current
      if (box && !box.contains(event.target)) { setNewOpen(false); setNewName('') }
    }
    document.addEventListener('pointerdown', onPointerDown, true)
    return () => document.removeEventListener('pointerdown', onPointerDown, true)
  }, [newOpen])
  const create = () => {
    if (!newName.trim()) return
    props.controller.createFolder(null, newName.trim()).then(() => { props.onToast('success', t('folders.created')); setNewName(''); setNewOpen(false) }).catch((error) => props.onToast('error', describeError(t, error)))
  }
  return h(
    'div',
    { className: 'ph-folders' },
    favoriteMatches && Number(props.favoriteCount || 0) > 0 ? h('button', { type: 'button', className: 'ph-navitem' + (filters.view === 'favorite' ? ' ph-navitem--active' : ''), onClick: () => { if (props.onLeaveNote) props.onLeaveNote(); props.controller.setView('favorite') } }, h(Icon, { name: 'star', size: 14, className: 'ph-navitem__icon' }), h('span', { className: 'ph-navitem__label' }, t('folders.favorite')), h('span', { className: 'ph-navitem__count' }, String(props.favoriteCount))) : null,
    h('div', { className: 'ph-left__sectionHead' },
      h(Icon, { name: 'collection', size: 13 }), h('span', null, t('folders.mine')),
      h(IconButton, { icon: 'plus', title: t('folders.new'), onClick: () => setNewOpen(!newOpen), 'aria-expanded': newOpen ? 'true' : 'false' }),
    ),
    newOpen ? h('div', { className: 'ph-folder__childnew', ref: newBoxRef }, h('input', { className: 'ph-inlineinput', autoFocus: true, placeholder: t('folders.newPlaceholder'), value: newName, onChange: (event) => setNewName(event.target.value), onBlur: (event) => { const box = newBoxRef.current; if (!box || !box.contains(event.relatedTarget)) { setNewOpen(false); setNewName('') } }, onKeyDown: (event) => { if (event.key === 'Enter') create(); if (event.key === 'Escape') setNewOpen(false) } }), h(IconButton, { icon: 'check', title: t('common.confirm'), onClick: create })) : null,
    h('div', { className: 'ph-folders__tree', role: 'tree', 'aria-label': t('folders.mine') },
      userFolders.length === 0 ? h('div', { className: 'ph-left__empty' }, query ? t('library.sidebar.folderEmpty') : t('folders.empty')) : null,
      userFolders.map((node) => h(Node, {
        key: node.id, t: t, node: node, depth: 0, folders: folders, forceOpen: Boolean(query),
        activeId: filters.folderId, active: filters.folderId === node.id,
        onSelect: (target) => { if (props.onLeaveNote) props.onLeaveNote(); props.controller.setFolderFilter(target.id) },
        onCreate: (parent, name) => props.controller.createFolder(parent.id, name).catch((error) => props.onToast('error', describeError(t, error))),
        onRename: (target, name) => props.controller.updateFolder(target.id, { name: name }).catch((error) => props.onToast('error', describeError(t, error))),
        onRecolor: (target, color) => props.controller.updateFolder(target.id, { color: color }).catch((error) => props.onToast('error', describeError(t, error))),
        onDelete: (target) => props.controller.deleteFolder(target.id).then(() => props.onToast('success', t('folders.deleted'))).catch((error) => props.onToast('error', describeError(t, error))),
        onDropPapers: (target, ids) => props.controller.assignFolder(target.id, ids, true).then(() => props.onToast('success', t('folders.assigned'))).catch((error) => props.onToast('error', describeError(t, error))),
      })),
    ),
  )
}

/** Reusable indented folder picker (detail rail, batch bar, filters). */
export function FolderPicker(props) {
  const t = props.t
  const items = flatten((props.folders && props.folders.items) || [], 0, [])
  const value = props.value || ''
  return h(
    'select',
    { className: 'ph-select ' + (props.className || ''), value: value, 'aria-label': props.label || t('folders.pick'), onChange: (event) => props.onChange(event.target.value || null) },
    h('option', { value: '' }, props.allowAll ? t('folders.all') : t('folders.none')),
    items.map((entry) => h('option', { key: entry.node.id, value: entry.node.id }, '　'.repeat(entry.depth) + (entry.depth > 0 ? '└ ' : '') + entry.node.name + ' (' + (entry.node.count || 0) + ')')),
  )
}

/** Search filter chips: favourite + folder + read state + tag multi-select. */
export function SearchFilters(props) {
  const t = props.t
  const snapshot = props.snapshot
  const controller = props.controller
  const filters = snapshot.filters
  const tags = (snapshot.tags || []).slice(0, 8)
  return h(
    'div',
    { className: 'ph-searchfilters' },
    h('button', { type: 'button', className: 'ph-fchip' + (filters.favorite ? ' ph-fchip--active' : ''), onClick: () => controller.setFavoriteFilter(!filters.favorite) }, h(Icon, { name: 'star', size: 11 }), t('folders.favorite')),
    h(FolderPicker, { t: t, folders: snapshot.folders, value: filters.folderId || '', allowAll: true, label: t('folders.filterLabel'), className: 'ph-select--inline', onChange: (id) => (id ? controller.setFolderFilter(id) : controller.setFolderFilter(null)) }),
    h('select', { className: 'ph-select ph-select--inline', value: filters.reading || '', 'aria-label': t('library.batch.reading'), onChange: (event) => { const value = event.target.value; controller.patchFilters ? controller.patchFilters({ reading: value || null, view: 'all' }) : null; if (!controller.patchFilters) { controller.setView(value === 'read' ? 'read' : value === 'reading' ? 'reading' : value === 'to-read' ? 'toRead' : 'all') } } },
      h('option', { value: '' }, t('folders.anyState')),
      h('option', { value: 'to-read' }, t('library.smart.toRead')),
      h('option', { value: 'reading' }, t('library.smart.reading')),
      h('option', { value: 'read' }, t('library.smart.read')),
    ),
    h(
      'div',
      { className: 'ph-searchmode', role: 'group', 'aria-label': t('library.search.mode') },
      h('button', {
        type: 'button',
        className: 'ph-searchmode__btn' + ((filters.mode || 'hybrid') === 'hybrid' ? ' is-active' : ''),
        'aria-pressed': (filters.mode || 'hybrid') === 'hybrid' ? 'true' : 'false',
        title: t('library.search.hybridHint'),
        onClick: () => controller.setSearchMode('hybrid'),
      }, h(Icon, { name: 'search', size: 11 }), t('library.search.hybrid')),
      h('button', {
        type: 'button',
        className: 'ph-searchmode__btn' + (filters.mode === 'semantic' ? ' is-active' : ''),
        'aria-pressed': filters.mode === 'semantic' ? 'true' : 'false',
        title: t('library.search.semanticHint'),
        onClick: () => controller.setSearchMode('semantic'),
      }, h(Icon, { name: 'sparkles', size: 11 }), t('library.search.semantic')),
    ),
    h('span', { className: 'ph-spacer' }),
    filters.mode === 'semantic' ? h(SemanticChips, { t: t, snapshot: snapshot }) : null,
    tags.map((tag) => h('button', { key: tag.name, type: 'button', className: 'ph-fchip' + (filters.tags.indexOf(tag.name) >= 0 ? ' ph-fchip--active' : ''), onClick: () => controller.toggleTag(tag.name) }, tag.name, h('span', { className: 'ph-fchip__count' }, String(tag.count)))),
    filters.tags.length > 0 ? h(IconButton, { icon: 'close', title: t('drawer.filter.clear'), onClick: () => controller.clearTags() }) : null,
  )
}

/** Semantic/vector channel chips from `status.index.channels`. */
export function SemanticChips(props) {
  const t = props.t
  const status = props.snapshot && props.snapshot.statusData
  const semantic = (props.snapshot && props.snapshot.semantic) || {}
  const channels = (status && status.index && status.index.channels) || {}
  const vector = channels.vector || 'unavailable'
  // Host marks component readiness as 'ready'; search channels use 'ok'.
  // Accept both so a live vector index never renders as unavailable.
  const vectorState = vector === 'ready' ? 'ok' : vector
  const vectorInfo = (status && status.index && status.index.vectorInfo) || {}
  const items = [
    { id: 'fts', label: t('semantic.fts'), state: channels.fts === 'ready' ? 'ok' : channels.fts || 'unknown' },
    { id: 'tags', label: t('semantic.tags'), state: channels.tags || (channels.fts === 'ok' || channels.fts === 'ready' ? 'ok' : 'unknown') },
    { id: 'ai', label: t('semantic.ai'), state: channels.ai || channels.ai_expand || 'unavailable' },
    { id: 'vector', label: t('semantic.vector'), state: vectorState, model: vectorInfo.model, latencyMs: vectorInfo.latencyMs, reason: vectorInfo.reason },
  ]
  return h(
    'div',
    { className: 'ph-semantic' },
    items.map((item) => h('span', { key: item.id, className: 'ph-semchip ph-semchip--' + item.state, title: item.reason || '' }, h(Icon, { name: item.id === 'vector' ? 'search' : 'tag', size: 10 }), item.label, item.state === 'ok' && item.model ? h('span', { className: 'ph-semchip__meta' }, item.model + (item.latencyMs ? ' · ' + item.latencyMs + 'ms' : '')) : null)),
    semantic.pending === true ? h('span', { className: 'ph-caption ph-semantic__hint' }, t('library.search.semanticPending')) : null,
    semantic.pending === true ? null : vectorState !== 'ok' ? h('span', { className: 'ph-caption ph-semantic__hint' }, t('semantic.vectorUnavailable') + (vectorInfo.reason ? '：' + vectorInfo.reason : '')) : null,
  )
}

/** Small star toggle used by rows/details. */
export function FavoriteButton(props) {
  const t = props.t
  const favorite = Boolean(props.paper && props.paper.favorite)
  return h(IconButton, { icon: 'star', className: 'ph-favbtn' + (favorite ? ' ph-favbtn--on' : ''), title: favorite ? t('folders.unfavorite') : t('folders.favorite'), onClick: (event) => { event.stopPropagation(); props.onToggle(!favorite) } })
}
