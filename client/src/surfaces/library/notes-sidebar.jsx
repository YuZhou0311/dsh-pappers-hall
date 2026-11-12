/**
 * Notes tree inside the paper-library left sidebar (v0.18).
 *
 * The standalone notes route remains the editor workspace, but the notes folder
 * tree and note list live next to the paper folders so the library is one place
 * instead of two disconnected products. The tree uses the same `notes.folders.*`
 * and `notes.list` APIs as the notes workspace; every action is the basic API
 * call (create/rename/delete folder, create note) and selecting a note hands it
 * to the notes editor route.
 */
import React from 'react'
import { h } from '../../core/dom.js'
import { Icon } from '../../core/icons.jsx'
import { IconButton, Spinner } from '../../core/primitives.jsx'
import { createNotesService } from '../../core/notes-api.js'
import { ensureNotesStyles } from '../notes/styles.js'

/** One folder row with inline create/rename/delete. */
function FolderRow(props) {
  const t = props.t
  const node = props.node
  const [editing, setEditing] = React.useState(false)
  const [value, setValue] = React.useState(node.name)
  const [armed, setArmed] = React.useState(false)
  React.useEffect(() => setValue(node.name), [node.name])
  const submit = () => {
    const next = String(value || '').trim()
    setEditing(false)
    if (next === '' || next === node.name) return
    props.onRename(node.id, next)
  }
  return h(
    'div',
    { className: 'ph-n-tree__row' + (props.active ? ' ph-n-tree__row--active' : ''), style: { paddingLeft: 6 + props.depth * 14 } },
    h('span', { className: 'ph-n-tree__icon' }, h(Icon, { name: props.depth === 0 ? 'folder' : 'folderOpen', size: 13 })),
    editing
      ? h('input', {
          className: 'ph-n-tree__input',
          value: value,
          autoFocus: true,
          onChange: (event) => setValue(event.target.value),
          onKeyDown: (event) => {
            if (event.key === 'Enter') submit()
            if (event.key === 'Escape') setEditing(false)
          },
          onBlur: submit,
        })
      : h(
          'button',
          { type: 'button', className: 'ph-n-tree__label', style: { background: 'transparent', border: 'none', textAlign: 'left', padding: 0, color: 'inherit', font: 'inherit', cursor: 'pointer' }, onClick: () => props.onSelect(node.id), title: node.name },
          node.name,
        ),
    h('span', { className: 'ph-n-tree__count' }, String(node.count || 0)),
    h(
      'span',
      { className: 'ph-n-tree__tools' },
      h(IconButton, { icon: 'plus', size: 12, title: t('notes.folders.newChild') || '新建子文件夹', onClick: () => props.onCreateChild(node.id) }),
      h(IconButton, { icon: 'edit', size: 12, title: t('notes.folders.rename') || '重命名', onClick: () => setEditing(true) }),
      h(IconButton, {
        icon: 'trash',
        size: 12,
        title: armed ? (t('notes.folders.deleteConfirm') || '确认删除') : (t('notes.folders.delete') || '删除文件夹'),
        active: armed,
        onClick: () => {
          if (!armed) { setArmed(true); return }
          setArmed(false)
          props.onDelete(node.id)
        },
      }),
    ),
  )
}

export function NotesSidebar(props) {
  const t = props.t
  const api = props.api
  const releaseStyles = React.useMemo(() => ensureNotesStyles(), [])
  const service = React.useMemo(() => createNotesService(api), [api])
  const [status, setStatus] = React.useState('loading')
  const [tree, setTree] = React.useState([])
  const [notes, setNotes] = React.useState([])
  const [total, setTotal] = React.useState(0)
  const [folderId, setFolderId] = React.useState('')
  const [refresh, setRefresh] = React.useState(0)
  const [open, setOpen] = React.useState(true)
  const [editing, setEditing] = React.useState(null)
  const [busy, setBusy] = React.useState(false)
  React.useEffect(() => () => releaseStyles(), [releaseStyles])
  React.useEffect(() => {
    let alive = true
    setStatus('loading')
    service.probe()
      .then((state) => {
        if (!alive) return
        if (state.status === 'unavailable' || state.status === 'offline') { setStatus('unavailable'); return }
        return Promise.all([
          service.foldersTree(),
          service.list({ limit: 100, folderId: folderId || undefined }),
        ]).then(([folders, list]) => {
          if (!alive) return
          setTree(Array.isArray(folders) ? folders : [])
          setNotes(Array.isArray(list.items) ? list.items : [])
          setTotal(Number(list.total) || 0)
          setStatus('ready')
        })
      })
      .catch(() => { if (alive) setStatus('error') })
    return () => { alive = false }
  }, [service, folderId, refresh])
  const refreshAll = () => setRefresh((value) => value + 1)
  const createFolder = (name, parentId) => {
    setBusy(true)
    service.createFolder({ name, parentId: parentId || undefined })
      .then(() => { setEditing(null); refreshAll() })
      .catch((error) => props.pushToast && props.pushToast('error', String((error && error.message) || error)))
      .then(() => setBusy(false))
  }
  const renameFolder = (id, name) => {
    setBusy(true)
    service.renameFolder({ id, name })
      .then(() => refreshAll())
      .catch((error) => props.pushToast && props.pushToast('error', String((error && error.message) || error)))
      .then(() => setBusy(false))
  }
  const deleteFolder = (id) => {
    setBusy(true)
    service.deleteFolder(id)
      .then(() => { if (folderId === id) setFolderId(''); refreshAll() })
      .catch((error) => props.pushToast && props.pushToast('error', String((error && error.message) || error)))
      .then(() => setBusy(false))
  }
  const createNote = () => {
    setBusy(true)
    service.create({ title: '', content: '', folderId: folderId || null, paperIds: props.paperId ? [props.paperId] : [], status: 'draft' })
      .then((note) => {
        if (note && note.id && props.onOpenNote) props.onOpenNote(note.id)
        refreshAll()
      })
      .catch((error) => props.pushToast && props.pushToast('error', String((error && error.message) || error)))
      .then(() => setBusy(false))
  }
  const walk = (nodes, depth) => nodes.map((node) => h(
    React.Fragment,
    { key: 'nf-' + node.id },
    h(FolderRow, { t, node, depth, active: folderId === node.id, onSelect: (id) => setFolderId(folderId === id ? '' : id), onCreateChild: (parentId) => setEditing({ mode: 'create', parentId, value: '' }), onRename: renameFolder, onDelete: deleteFolder }),
    node.children && node.children.length > 0 ? walk(node.children, depth + 1) : null,
  ))
  return h(
    'div',
    { className: 'ph-left__section ph-notes-sidebar' },
    h(
      'div',
      { className: 'ph-left__sectionHead' },
      h('button', { type: 'button', className: 'ph-notes-sidebar__toggle', onClick: () => setOpen((value) => !value), 'aria-expanded': open ? 'true' : 'false' },
        h(Icon, { name: open ? 'chevronDown' : 'chevronRight', size: 12 }),
        h(Icon, { name: 'note', size: 13 }),
        h('span', null, t('notes.sidebar.title') || '笔记'),
        h('span', { className: 'ph-left__count' }, String(total)),
      ),
      h('span', { className: 'ph-spacer' }),
      h(IconButton, { icon: 'plus', size: 13, title: t('notes.new') || '新建笔记', onClick: createNote, disabled: busy || status !== 'ready' }),
      h(IconButton, { icon: 'folderPlus', size: 13, title: t('notes.folders.new') || '新建笔记文件夹', onClick: () => setEditing({ mode: 'create', parentId: null, value: '' }), disabled: busy || status !== 'ready' }),
    ),
    !open ? null : status === 'loading'
      ? h('div', { className: 'ph-left__empty' }, h(Spinner))
      : status === 'unavailable' || status === 'error'
        ? h('div', { className: 'ph-left__empty' }, t('notes.unavailable') || '笔记服务未就绪')
        : h(
            React.Fragment,
            null,
            h(
              'div',
              { className: 'ph-n-tree' },
              h('button', { type: 'button', className: 'ph-n-tree__row' + (folderId === '' ? ' ph-n-tree__row--active' : ''), onClick: () => setFolderId('') },
                h('span', { className: 'ph-n-tree__icon' }, h(Icon, { name: 'layers', size: 13 })),
                h('span', { className: 'ph-n-tree__label' }, t('notes.folders.all') || '全部笔记'),
                h('span', { className: 'ph-n-tree__count' }, String(total)),
              ),
              walk(tree, 0),
              editing && editing.mode === 'create' && !editing.parentId
                ? h('input', {
                    className: 'ph-n-tree__input',
                    autoFocus: true,
                    value: editing.value,
                    placeholder: t('notes.folders.namePlaceholder') || '文件夹名称',
                    onChange: (event) => setEditing(Object.assign({}, editing, { value: event.target.value })),
                    onKeyDown: (event) => { if (event.key === 'Enter' && String(editing.value || '').trim()) createFolder(String(editing.value).trim(), null); if (event.key === 'Escape') setEditing(null) },
                    onBlur: () => setEditing(null),
                  })
                : h('button', { type: 'button', className: 'ph-n-tree__row', onClick: () => setEditing({ mode: 'create', parentId: null, value: '' }) },
                    h('span', { className: 'ph-n-tree__icon' }, h(Icon, { name: 'folderPlus', size: 13 })),
                    h('span', { className: 'ph-n-tree__label ph-n-muted' }, t('notes.folders.new') || '新建文件夹'),
                  ),
            ),
            notes.length === 0
              ? h('div', { className: 'ph-left__empty' }, t('notes.empty.title') || '还没有笔记')
              : h('div', { className: 'ph-notes-sidebar__list' }, notes.map((note) => h(
                  'button',
                  { key: note.id, type: 'button', className: 'ph-notes-sidebar__note', onClick: () => props.onOpenNote && props.onOpenNote(note.id), title: note.title || note.id },
                  h(Icon, { name: 'note', size: 12 }),
                  h('span', { className: 'ph-notes-sidebar__title' }, note.title || t('notes.untitled') || '未命名笔记'),
                  note.folder ? h('span', { className: 'ph-notes-sidebar__folder' }, note.folder.name) : null,
                ))),
          ),
  )
}
