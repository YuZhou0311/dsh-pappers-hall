/**
 * Standalone notes library (v0.17) — a full-screen notes workspace inside the
 * Paper Center main panel.
 *
 *   ┌ topbar: back · 笔记库 · search · new note · panels · settings ┐
 *   │ folders │ notes list │ editor                    │ paper panel │
 *   └ status ────────────────────────────────────────────────────────┘
 *
 * Data always comes from `notes.*` (docs/CONTRACT-NOTES.md). When the Host half
 * is older (`unknown API method`) the whole surface degrades to one honest
 * 「笔记服务未就绪」 state with a retry — never a crash and never an empty-list lie.
 *
 * Notes may link 0..N papers; the right 「论文面板」 mirrors the reader's page /
 * translation / annotation helpers so the user can write while reading.
 */
import React from 'react'
import { Icon } from '../../core/icons.jsx'
import { Badge, Button, EmptyState, IconButton, SearchInput, ToastStack, useToasts } from '../../core/primitives.jsx'
import { createNotesService } from '../../core/notes-api.js'
import { flattenFolders, formatNoteTime } from '../../core/notes-model.js'
import { ensureNotesStyles } from './styles.js'
import { NoteEditor } from './editor.jsx'
import { PaperPanel } from './paper-panel.jsx'

/** Subscribe to a notes service instance. */
function useServiceState(service) {
  const subscribe = React.useCallback((listener) => service.subscribe(listener), [service])
  const getSnapshot = React.useCallback(() => service.getSnapshot(), [service])
  return React.useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
}

/** Folder tree with inline rename/create/delete. */
function FolderTree(props) {
  const t = props.t
  const tree = props.tree
  const [editing, setEditing] = React.useState(null)
  const [armedDelete, setArmedDelete] = React.useState('')
  const inputRef = React.useRef(null)

  React.useEffect(() => {
    if (editing && inputRef.current) inputRef.current.focus()
  }, [editing])
  React.useEffect(() => {
    if (!armedDelete) return undefined
    const timer = setTimeout(() => setArmedDelete(''), 4500)
    return () => clearTimeout(timer)
  }, [armedDelete])

  const submit = () => {
    if (!editing) return
    const name = String(editing.value || '').trim()
    if (!name) {
      setEditing(null)
      return
    }
    const done = () => setEditing(null)
    if (editing.mode === 'create') props.onCreateFolder(name, editing.parentId || null).then(done).catch(done)
    else props.onRenameFolder(editing.id, name).then(done).catch(done)
  }

  const rows = []
  const walk = (nodes, depth) => {
    for (const node of nodes) {
      const isEditing = editing && editing.mode === 'rename' && editing.id === node.id
      rows.push(
        React.createElement(
          'div',
          { key: 'f-' + node.id, className: 'ph-n-tree__row' + (props.folderId === node.id ? ' ph-n-tree__row--active' : ''), style: { paddingLeft: 6 + depth * 14 } },
          React.createElement('span', { className: 'ph-n-tree__icon' }, React.createElement(Icon, { name: depth === 0 ? 'folder' : 'folderOpen', size: 13 })),
          isEditing
            ? React.createElement('input', {
                ref: inputRef,
                className: 'ph-n-tree__input',
                value: editing.value,
                onChange: (event) => setEditing(Object.assign({}, editing, { value: event.target.value })),
                onKeyDown: (event) => {
                  if (event.key === 'Enter') submit()
                  if (event.key === 'Escape') setEditing(null)
                },
                onBlur: submit,
              })
            : React.createElement(
                'button',
                {
                  type: 'button',
                  className: 'ph-n-tree__label',
                  style: { background: 'transparent', border: 'none', textAlign: 'left', padding: 0, color: 'inherit', font: 'inherit', cursor: 'pointer' },
                  onClick: () => props.onSelect(node.id),
                  title: node.name,
                },
                node.name,
              ),
          React.createElement('span', { className: 'ph-n-tree__count' }, String(node.count || 0)),
          React.createElement(
            'span',
            { className: 'ph-n-tree__tools' },
            React.createElement(IconButton, {
              icon: 'plus',
              size: 12,
              title: t('notes.folders.newChild'),
              onClick: () => setEditing({ mode: 'create', parentId: node.id, value: '' }),
            }),
            React.createElement(IconButton, {
              icon: 'edit',
              size: 12,
              title: t('notes.folders.rename'),
              onClick: () => setEditing({ mode: 'rename', id: node.id, value: node.name }),
            }),
            React.createElement(IconButton, {
              icon: 'trash',
              size: 12,
              title: armedDelete === node.id ? t('notes.folders.deleteConfirm') : t('notes.folders.delete'),
              active: armedDelete === node.id,
              onClick: () => {
                if (armedDelete === node.id) {
                  setArmedDelete('')
                  props.onDeleteFolder(node.id)
                } else setArmedDelete(node.id)
              },
            }),
          ),
        ),
      )
      if (node.children && node.children.length > 0) walk(node.children, depth + 1)
    }
  }
  walk(tree, 0)

  return React.createElement(
    'div',
    { className: 'ph-n-tree' },
    React.createElement(
      'button',
      { type: 'button', className: 'ph-n-tree__row' + (props.folderId === '' ? ' ph-n-tree__row--active' : ''), onClick: () => props.onSelect('') },
      React.createElement('span', { className: 'ph-n-tree__icon' }, React.createElement(Icon, { name: 'layers', size: 13 })),
      React.createElement('span', { className: 'ph-n-tree__label' }, t('notes.folders.all')),
      React.createElement('span', { className: 'ph-n-tree__count' }, String(props.total || 0)),
    ),
    rows,
    editing && editing.mode === 'create' && !editing.parentId
      ? React.createElement(
          'div',
          { className: 'ph-n-tree__row' },
          React.createElement('span', { className: 'ph-n-tree__icon' }, React.createElement(Icon, { name: 'folder', size: 13 })),
          React.createElement('input', {
            ref: inputRef,
            className: 'ph-n-tree__input',
            value: editing.value,
            placeholder: t('notes.folders.namePlaceholder'),
            onChange: (event) => setEditing(Object.assign({}, editing, { value: event.target.value })),
            onKeyDown: (event) => {
              if (event.key === 'Enter') submit()
              if (event.key === 'Escape') setEditing(null)
            },
            onBlur: submit,
          }),
        )
      : React.createElement(
          'button',
          {
            type: 'button',
            className: 'ph-n-tree__row',
            onClick: () => setEditing({ mode: 'create', parentId: null, value: '' }),
            title: t('notes.folders.new'),
          },
          React.createElement('span', { className: 'ph-n-tree__icon' }, React.createElement(Icon, { name: 'folderPlus', size: 13 })),
          React.createElement('span', { className: 'ph-n-tree__label ph-n-muted' }, t('notes.folders.new')),
        ),
    tree.length === 0 ? React.createElement('p', { className: 'ph-n-folders__empty' }, t('notes.folders.empty')) : null,
  )
}

/**
 * @param {object} props
 * @param {object} props.t
 * @param {Function} props.api
 * @param {string} [props.initialNoteId]
 * @param {Function} props.onBack
 * @param {Function} [props.onOpenPaper] `(paperId, page, annotationId)` open the reader
 * @param {Function} [props.onOpenSettings]
 * @param {string} [props.sessionId]
 */
export function NotesWorkspace(props) {
  const t = props.t
  const api = props.api
  const releaseStyles = React.useMemo(() => ensureNotesStyles(), [])
  const service = React.useMemo(() => createNotesService(api), [api])
  const serviceState = useServiceState(service)
  const { toasts, push, dismiss } = useToasts()

  const [folders, setFolders] = React.useState({ status: 'idle', tree: [] })
  const [list, setList] = React.useState({ status: 'idle', items: [], total: 0, error: null })
  const [query, setQuery] = React.useState('')
  const [debounced, setDebounced] = React.useState('')
  const [folderId, setFolderId] = React.useState('')
  const [paperFilter, setPaperFilter] = React.useState(null)
  const [activeId, setActiveId] = React.useState(() => String(props.initialNoteId || ''))
  const [active, setActive] = React.useState({ status: 'idle', note: null, error: null })
  const [foldersOpen, setFoldersOpen] = React.useState(true)
  const [paperOpen, setPaperOpen] = React.useState(true)
  const [refreshToken, setRefreshToken] = React.useState(0)
  const activeIdRef = React.useRef(activeId)
  activeIdRef.current = activeId

  React.useEffect(() => () => releaseStyles(), [releaseStyles])
  React.useEffect(() => {
    const timer = setTimeout(() => setDebounced(query), 260)
    return () => clearTimeout(timer)
  }, [query])

  const refresh = React.useCallback(() => setRefreshToken((value) => value + 1), [])

  /* ------------------------------ probe + folders ------------------------ */
  React.useEffect(() => {
    let alive = true
    service.probe().then((state) => {
      if (!alive || state.status === 'unavailable' || state.status === 'offline') return
      setFolders((previous) => Object.assign({}, previous, { status: 'loading' }))
      Promise.resolve(service.foldersTree())
        .then((tree) => {
          if (alive) setFolders({ status: 'ready', tree: tree })
        })
        .catch((error) => {
          if (alive) setFolders({ status: 'error', tree: [], error: String((error && error.message) || error) })
        })
    })
    return () => {
      alive = false
    }
  }, [service, refreshToken])

  /* ------------------------------ notes list ----------------------------- */
  React.useEffect(() => {
    if (serviceState.status !== 'ready') return undefined
    let alive = true
    setList((previous) => Object.assign({}, previous, { status: 'loading', error: null }))
    const params = { limit: 200, folderId: folderId || undefined, paperId: paperFilter ? paperFilter.id : undefined }
    const promise = debounced.trim()
      ? service.search({ q: debounced.trim(), folderId: folderId || undefined, paperId: paperFilter ? paperFilter.id : undefined, limit: 100 }).then((result) => ({
          items: result.items.map((item) => ({
            id: item.id,
            title: item.title,
            preview: item.snippet,
            folderId: item.folderId,
            folder: item.folder,
            paperIds: item.paperIds,
            updatedAt: item.updatedAt,
            searchHit: true,
          })),
          total: result.total,
        }))
      : service.list(params).then((result) => ({ items: result.items, total: result.total }))
    Promise.resolve(promise)
      .then((result) => {
        if (!alive) return
        setList({ status: 'ready', items: result.items, total: result.total || result.items.length, error: null })
        setActiveId((previous) => {
          if (previous && result.items.some((item) => item.id === previous)) return previous
          return result.items.length > 0 ? result.items[0].id : ''
        })
      })
      .catch((error) => {
        if (alive) setList({ status: 'error', items: [], total: 0, error })
      })
    return () => {
      alive = false
    }
  }, [debounced, folderId, paperFilter, refreshToken, service, serviceState.status])

  /* ------------------------------ active note ---------------------------- */
  React.useEffect(() => {
    if (!activeId) {
      setActive({ status: 'idle', note: null, error: null })
      return undefined
    }
    let alive = true
    setActive({ status: 'loading', note: null, error: null })
    Promise.resolve(service.get(activeId))
      .then((note) => {
        if (alive) setActive({ status: 'ready', note, error: null })
      })
      .catch((error) => {
        if (alive) setActive({ status: 'error', note: null, error })
      })
    return () => {
      alive = false
    }
  }, [activeId, refreshToken, service])

  /* ------------------------------ actions -------------------------------- */
  const updateRow = React.useCallback((saved) => {
    if (!saved) return
    setList((previous) => {
      const items = previous.items.map((item) =>
        item.id === saved.id
          ? Object.assign({}, item, {
              title: saved.title,
              preview: (saved.contentMd || '').slice(0, 140),
              folderId: saved.folderId,
              folder: saved.folder,
              paperIds: saved.paperIds,
              updatedAt: saved.updatedAt,
              revision: saved.revision,
              hasContentJson: saved.hasContentJson,
            })
          : item,
      )
      if (!items.some((item) => item.id === saved.id)) items.unshift(saved)
      return Object.assign({}, previous, { items })
    })
    setActive((previous) => (previous.note && previous.note.id === saved.id ? { status: 'ready', note: saved, error: null } : previous))
  }, [])

  const createNote = React.useCallback(
    (options) => {
      const opts = options || {}
      const paperIds = opts.paperIds || (paperFilter ? [paperFilter.id] : [])
      return Promise.resolve(service.create({ title: '', content: '', folderId: folderId || null, paperIds: paperIds, status: 'draft' }))
        .then((note) => {
          if (!note) throw new Error('notes.create returned no note')
          setList((previous) => ({ status: 'ready', items: [Object.assign({}, note, { preview: '' })].concat(previous.items), total: previous.total + 1, error: null }))
          setActive({ status: 'ready', note, error: null })
          setActiveId(note.id)
          refresh()
          return note
        })
        .catch((error) => {
          push('error', t('notes.createFailed', { message: String((error && error.message) || error) }))
          throw error
        })
    },
    [folderId, paperFilter, push, refresh, service, t],
  )

  const createFolder = React.useCallback(
    (name, parentId) => Promise.resolve(service.createFolder({ name: name, parentId: parentId || undefined }))
      .then((folder) => {
        push('success', t('notes.folders.created'))
        refresh()
        return folder
      })
      .catch((error) => {
        push('error', t('notes.folders.createFailed', { message: String((error && error.message) || error) }))
        throw error
      }),
    [push, refresh, service, t],
  )

  const renameFolder = React.useCallback(
    (id, name) => Promise.resolve(service.renameFolder({ id: id, name: name }))
      .then(() => refresh())
      .catch((error) => {
        push('error', t('notes.folders.renameFailed', { message: String((error && error.message) || error) }))
        throw error
      }),
    [push, refresh, service, t],
  )

  const deleteFolder = React.useCallback(
    (id) => Promise.resolve(service.deleteFolder(id))
      .then(() => {
        push('success', t('notes.folders.deleted'))
        if (folderId === id) setFolderId('')
        refresh()
      })
      .catch((error) => push('error', t('notes.folders.deleteFailed', { message: String((error && error.message) || error) }))),
    [folderId, push, refresh, service, t],
  )

  const moveNote = React.useCallback(
    (targetFolderId) => {
      const note = active.note
      if (!note) return Promise.resolve(null)
      if ((note.folderId || null) === (targetFolderId || null)) return Promise.resolve(null)
      const promise = targetFolderId ? service.assignFolder(targetFolderId, [note.id]) : service.unassignFolder([note.id])
      return Promise.resolve(promise)
        .then(() => {
          // Optimistic update: reloading the note here would make the controlled
          // <select> snap back and fire a bogus second change (assign → unassign).
          const nextFolder = targetFolderId
            ? flattenFolders(folders.tree || []).find((folder) => folder.id === targetFolderId) || null
            : null
          setActive((previous) => (previous.note && previous.note.id === note.id
            ? { status: 'ready', note: Object.assign({}, previous.note, { folderId: nextFolder ? nextFolder.id : null, folder: nextFolder ? { id: nextFolder.id, name: nextFolder.name } : null }), error: null }
            : previous))
          setList((previous) => Object.assign({}, previous, {
            items: previous.items.map((item) => (item.id === note.id ? Object.assign({}, item, { folderId: nextFolder ? nextFolder.id : null, folder: nextFolder ? { id: nextFolder.id, name: nextFolder.name } : null }) : item)),
          }))
          push('success', t('notes.folders.moved'))
          return Promise.resolve(service.foldersTree()).then((tree) => {
            setFolders({ status: 'ready', tree: tree })
          }).catch(() => {})
        })
        .catch((error) => {
          push('error', t('notes.folders.moveFailed', { message: String((error && error.message) || error) }))
          throw error
        })
    },
    [active.note, folders.tree, push, service, t],
  )

  const linkPapers = React.useCallback(
    (ids) => Promise.resolve(service.link(activeIdRef.current, ids)),
    [service],
  )
  const unlinkPapers = React.useCallback(
    (ids) => Promise.resolve(service.unlink(activeIdRef.current, ids)),
    [service],
  )

  const onDeleted = React.useCallback(
    (deleted) => {
      setList((previous) => {
        const items = previous.items.filter((item) => item.id !== deleted.id)
        const nextId = items.length > 0 ? items[0].id : ''
        setActiveId(nextId)
        if (!nextId) setActive({ status: 'idle', note: null, error: null })
        return Object.assign({}, previous, { items, total: Math.max(0, previous.total - 1) })
      })
      refresh()
    },
    [refresh],
  )

  const openPaper = React.useCallback(
    (paperId, page, annotationId) => {
      if (props.onOpenPaper) props.onOpenPaper(paperId, page || 1, annotationId || null)
    },
    [props],
  )

  /* ------------------------------ derived -------------------------------- */
  const flatFolders = React.useMemo(() => flattenFolders(folders.tree || []), [folders.tree])
  const folderName = React.useMemo(() => {
    if (!folderId) return ''
    const found = flatFolders.find((folder) => folder.id === folderId)
    return found ? found.name : ''
  }, [flatFolders, folderId])
  const listTitle = paperFilter ? t('notes.fromPaperTitle', { title: paperFilter.title }) : folderName || t('notes.folders.all')
  const unavailable = serviceState.status === 'unavailable' || serviceState.status === 'offline'

  /* ------------------------------ render --------------------------------- */
  return React.createElement(
    'div',
    { className: 'ph-n-app' },
    React.createElement(
      'div',
      { className: 'ph-n-topbar' },
      React.createElement(Button, { size: 'sm', variant: 'ghost', icon: 'arrowLeft', onClick: props.onBack, title: t('notes.library.back') }, t('notes.library.back')),
      React.createElement(
        'div',
        { className: 'ph-n-brand' },
        React.createElement(Icon, { name: 'note', size: 18, className: 'ph-n-brand__mark' }),
        React.createElement('h1', { className: 'ph-n-brand__title' }, t('notes.library.title')),
        React.createElement('span', { className: 'ph-n-brand__sub' }, t('notes.library.subtitle')),
      ),
      React.createElement(SearchInput, {
        className: 'ph-n-topbar__search',
        value: query,
        onChange: setQuery,
        placeholder: t('notes.search.placeholder'),
        clearLabel: t('common.clear'),
        loading: list.status === 'loading',
        'aria-label': t('notes.search.placeholder'),
      }),
      React.createElement('span', { className: 'ph-n-topbar__spacer' }),
      React.createElement(
        'div',
        { className: 'ph-n-topbar__actions' },
        React.createElement(Button, { variant: 'primary', size: 'sm', icon: 'plus', onClick: () => createNote().catch(() => {}), title: t('notes.new') }, t('notes.new')),
        React.createElement(IconButton, { icon: 'panelLeft', title: t('notes.folders.toggle'), active: foldersOpen, onClick: () => setFoldersOpen((value) => !value) }),
        React.createElement(IconButton, { icon: 'panelRight', title: paperOpen ? t('notes.papers.panelClose') : t('notes.papers.panelOpen'), active: paperOpen, onClick: () => setPaperOpen((value) => !value) }),
        React.createElement(IconButton, { icon: 'refresh', title: t('notes.refresh'), onClick: refresh }),
        props.onOpenSettings ? React.createElement(IconButton, { icon: 'settings', title: t('settings.open'), onClick: props.onOpenSettings }) : null,
      ),
    ),
    unavailable
      ? React.createElement(
          'div',
          { className: 'ph-n-main__empty' },
          React.createElement(EmptyState, {
            icon: 'warning',
            tone: 'warning',
            title: serviceState.status === 'offline' ? t('notes.service.offlineTitle') : t('notes.service.unavailableTitle'),
            desc: serviceState.status === 'offline' ? t('notes.service.offlineDesc') : t('notes.service.unavailableDesc'),
            action: React.createElement(Button, { variant: 'secondary', icon: 'refresh', onClick: () => service.probe().then((state) => { if (state.status === 'ready') refresh() }) }, t('notes.service.retry')),
          }),
        )
      : React.createElement(
          'div',
          { className: 'ph-n-body' },
          React.createElement(
            'div',
            { className: 'ph-n-folders' + (foldersOpen ? '' : ' ph-n-folders--closed') },
            React.createElement(
              'div',
              { className: 'ph-n-folders__head' },
              React.createElement(Icon, { name: 'folder', size: 13 }),
              React.createElement('span', null, t('notes.folders.title')),
              React.createElement(IconButton, { icon: 'panelLeft', title: t('notes.folders.toggle'), onClick: () => setFoldersOpen(false) }),
            ),
            React.createElement(
              'div',
              { className: 'ph-n-folders__scroll ph-n-scroll' },
              folders.status === 'loading' && folders.tree.length === 0
                ? React.createElement('div', { className: 'ph-n-folders__empty' }, t('common.loading'))
                : null,
              folders.status === 'error'
                ? React.createElement(
                    'div',
                    { className: 'ph-n-folders__empty' },
                    t('notes.folders.loadFailed'),
                    React.createElement(Button, { size: 'sm', variant: 'ghost', icon: 'refresh', onClick: refresh }, t('common.retry')),
                  )
                : null,
              React.createElement(FolderTree, {
                t: t,
                tree: folders.tree || [],
                folderId: folderId,
                total: list.total,
                onSelect: (id) => {
                  setFolderId(id)
                  setPaperFilter(null)
                },
                onCreateFolder: createFolder,
                onRenameFolder: renameFolder,
                onDeleteFolder: deleteFolder,
              }),
            ),
          ),
          React.createElement(
            'div',
            { className: 'ph-n-listpane' },
            React.createElement(
              'div',
              { className: 'ph-n-listpane__head' },
              React.createElement('span', { className: 'ph-n-listpane__title', title: listTitle }, listTitle),
              React.createElement('span', { className: 'ph-n-listpane__count' }, list.status === 'ready' ? String(list.items.length) : '…'),
            ),
            paperFilter
              ? React.createElement(
                  'div',
                  { className: 'ph-n-listpane__filter' },
                  React.createElement(Icon, { name: 'filter', size: 12 }),
                  React.createElement('span', { className: 'ph-n-chip ph-n-chip--folder' }, React.createElement('span', { className: 'ph-n-chip__label', title: paperFilter.title }, paperFilter.title)),
                  React.createElement(IconButton, { icon: 'close', size: 12, title: t('notes.fromPaper.clear'), onClick: () => setPaperFilter(null) }),
                )
              : debounced.trim()
                ? React.createElement('div', { className: 'ph-n-listpane__filter' }, React.createElement(Icon, { name: 'search', size: 12 }), React.createElement('span', null, t('notes.search.results', { count: list.items.length })))
                : null,
            list.status === 'error'
              ? React.createElement(
                  'div',
                  { className: 'ph-n-listpane__filter' },
                  React.createElement(Icon, { name: 'warning', size: 12 }),
                  React.createElement('span', null, t('notes.loadFailed', { message: String((list.error && list.error.message) || '') })),
                  React.createElement(IconButton, { icon: 'refresh', size: 12, title: t('common.retry'), onClick: refresh }),
                )
              : null,
            React.createElement(
              'div',
              { className: 'ph-n-list ph-n-scroll' },
              list.status === 'loading' && list.items.length === 0
                ? [0, 1, 2, 3].map((index) => React.createElement('div', { key: index, className: 'ph-n-skeletonrow' }))
                : null,
              list.status === 'ready' && list.items.length === 0
                ? React.createElement(EmptyState, {
                    compact: true,
                    icon: 'note',
                    title: debounced.trim() ? t('notes.search.empty') : t('notes.empty.title'),
                    desc: debounced.trim() ? t('notes.search.emptyDesc') : t('notes.empty.desc'),
                    action: React.createElement(Button, { size: 'sm', variant: 'primary', icon: 'plus', onClick: () => createNote().catch(() => {}) }, t('notes.new')),
                  })
                : null,
              list.items.map((item) =>
                React.createElement(
                  'button',
                  {
                    key: item.id,
                    type: 'button',
                    className: 'ph-n-listrow' + (item.id === activeId ? ' ph-n-listrow--active' : ''),
                    onClick: () => setActiveId(item.id),
                    title: item.title || t('notes.untitled'),
                  },
                  React.createElement(
                    'span',
                    { className: 'ph-n-listrow__top' },
                    React.createElement('span', { className: 'ph-n-listrow__title' }, item.title || t('notes.untitled')),
                    React.createElement('span', { className: 'ph-n-listrow__time' }, formatNoteTime(item.updatedAt)),
                  ),
                  React.createElement('span', { className: 'ph-n-listrow__preview' }, String(item.preview || '').replace(/\s+/g, ' ').slice(0, 160) || t('notes.empty.preview')),
                  React.createElement(
                    'span',
                    { className: 'ph-n-listrow__meta' },
                    item.folder ? React.createElement('span', { className: 'ph-n-listrow__folder' }, React.createElement(Icon, { name: 'folder', size: 10 }), React.createElement('span', null, item.folder.name)) : null,
                    item.paperIds && item.paperIds.length > 0
                      ? React.createElement('span', { className: 'ph-n-listrow__folder' }, React.createElement(Icon, { name: 'book', size: 10 }), React.createElement('span', null, t('notes.list.paperCount', { count: item.paperIds.length })))
                      : null,
                    item.searchHit ? React.createElement(Badge, { tone: 'soft' }, t('notes.search.hit')) : null,
                    item.hasContentJson ? React.createElement('span', { title: t('notes.cards.beautifiedHint') }, React.createElement(Icon, { name: 'sparkle', size: 10 })) : null,
                  ),
                ),
              ),
            ),
          ),
          React.createElement(
            'div',
            { className: 'ph-n-main' },
            active.status === 'loading'
              ? React.createElement('div', { className: 'ph-n-editor__loading' }, React.createElement(Icon, { name: 'note', size: 14 }), React.createElement('span', null, t('notes.loadingNote')))
              : null,
            active.status === 'error'
              ? React.createElement(
                  'div',
                  { className: 'ph-n-main__empty' },
                  React.createElement(EmptyState, {
                    icon: 'warning',
                    tone: 'error',
                    title: t('notes.loadFailed', { message: String((active.error && active.error.message) || '') }),
                    action: React.createElement(Button, { variant: 'secondary', icon: 'refresh', onClick: refresh }, t('common.retry')),
                  }),
                )
              : null,
            active.status === 'ready' && active.note
              ? React.createElement(NoteEditor, {
                  t: t,
                  api: api,
                  service: service,
                  note: active.note,
                  variant: 'full',
                  sessionId: props.sessionId,
                  notify: push,
                  folders: flatFolders,
                  linkable: true,
                  onSaved: updateRow,
                  onDeleted: onDeleted,
                  onMoveFolder: moveNote,
                  onOpenPaper: openPaper,
                  onLinkPapers: linkPapers,
                  onUnlinkPapers: unlinkPapers,
                })
              : active.status !== 'loading'
                ? React.createElement(
                    'div',
                    { className: 'ph-n-main__empty' },
                    React.createElement(EmptyState, {
                      icon: 'note',
                      title: t('notes.select.title'),
                      desc: t('notes.select.desc'),
                      action: React.createElement(Button, { variant: 'primary', icon: 'plus', onClick: () => createNote().catch(() => {}) }, t('notes.new')),
                    }),
                  )
                : null,
          ),
          paperOpen
            ? React.createElement(PaperPanel, {
                t: t,
                api: api,
                noteId: active.note ? active.note.id : null,
                linkedPaperIds: active.note ? active.note.paperIds : [],
                filterPaperId: paperFilter ? paperFilter.id : null,
                onOpenPaper: openPaper,
                onFilterByPaper: (paper) => {
                  setPaperFilter({ id: paper.id, title: paper.titleZh || paper.displayTitle || paper.title || paper.id })
                  setFolderId('')
                  setQuery('')
                },
                onLinkPaper: (paper) => {
                  if (!active.note) {
                    push('info', t('notes.papers.linkNeedsNote'))
                    return
                  }
                  Promise.resolve(service.link(active.note.id, [paper.id]))
                    .then((fresh) => {
                      if (fresh) updateRow(fresh)
                      push('success', t('notes.papers.linkedDone'))
                    })
                    .catch((error) => push('error', t('notes.papers.linkFailed', { message: String((error && error.message) || error) })))
                },
                onCreateNote: (paper) => createNote({ paperIds: [paper.id] }).catch(() => {}),
                onClose: () => setPaperOpen(false),
              })
            : null,
        ),
    React.createElement(
      'div',
      { className: 'ph-n-statusbar' },
      React.createElement(Icon, { name: 'note', size: 12 }),
      React.createElement('span', null, t('notes.status.counts', { count: list.total || 0, folders: flatFolders.length })),
      React.createElement('span', { className: 'ph-n-statusbar__spacer' }),
      React.createElement(
        'span',
        { className: serviceState.status === 'ready' ? '' : 'ph-n-statusbar__warn', title: serviceState.reason || '' },
        serviceState.status === 'ready' ? t('notes.service.ready') : serviceState.status === 'unknown' ? t('notes.service.checking') : t('notes.service.notReady'),
      ),
      React.createElement('span', null, '·'),
      React.createElement('span', null, t('notes.status.autosaveHint')),
    ),
    React.createElement(ToastStack, { toasts: toasts, onDismiss: dismiss }),
  )
}
