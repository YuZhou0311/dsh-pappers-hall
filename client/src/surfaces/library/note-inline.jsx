/**
 * Inline note editor inside the paper library (v0.18).
 *
 * Opening a note from the notes tree no longer replaces the whole paper center:
 * the left library sidebar (paper folders + notes tree) stays put and the note
 * editor fills the middle pane. The full-screen notes workspace remains
 * available for the "open full notes library" path, but day-to-day writing while
 * browsing the library happens here.
 */
import React from 'react'
import { h } from '../../core/dom.js'
import { Icon } from '../../core/icons.jsx'
import { IconButton, Spinner } from '../../core/primitives.jsx'
import { createNotesService } from '../../core/notes-api.js'
import { ensureNotesStyles } from '../notes/styles.js'
import { NoteEditor } from '../notes/editor.jsx'

export function NoteInline(props) {
  const t = props.t
  const api = props.api
  const releaseStyles = React.useMemo(() => ensureNotesStyles(), [])
  const service = React.useMemo(() => createNotesService(api), [api])
  const [state, setState] = React.useState({ status: 'loading', note: null, folders: [], error: null })
  const [reload, setReload] = React.useState(0)
  React.useEffect(() => () => releaseStyles(), [releaseStyles])
  React.useEffect(() => {
    let alive = true
    if (!props.noteId) { setState({ status: 'empty', note: null, folders: [], error: null }); return undefined }
    setState((previous) => Object.assign({}, previous, { status: 'loading' }))
    Promise.all([
      service.get(props.noteId),
      service.foldersTree().catch(() => []),
    ])
      .then(([note, tree]) => {
        if (!alive) return
        const folders = []
        const walk = (nodes, depth) => { for (const node of nodes || []) { folders.push({ id: node.id, name: node.name, depth, parentId: node.parentId }); walk(node.children, (depth || 0) + 1) } }
        walk(tree || [], 0)
        setState({ status: 'ready', note: note || null, folders, error: null })
      })
      .catch((error) => { if (alive) setState({ status: 'error', note: null, folders: [], error: String((error && error.message) || error) }) })
    return () => { alive = false }
  }, [service, props.noteId, reload])
  React.useEffect(() => {
    const onLinked = (event) => {
      if (event && event.detail && String(event.detail.noteId) === String(props.noteId)) setReload((value) => value + 1)
    }
    window.addEventListener('pappers-hall:note-linked', onLinked)
    return () => window.removeEventListener('pappers-hall:note-linked', onLinked)
  }, [props.noteId])
  if (!props.noteId) return null
  return h(
    'div',
    { className: 'ph-n-inline' },
    h(
      'div',
      { className: 'ph-n-inline__head' },
      h(IconButton, { icon: 'panelLeft', title: t('notes.inline.toggleSidebar') || '展开/收起侧栏', onClick: () => props.onToggleLeft && props.onToggleLeft() }),
      h(Icon, { name: 'note', size: 15 }),
      h('span', { className: 'ph-n-inline__title' }, t('notes.library.title') || '笔记'),
      h('span', { className: 'ph-spacer' }),
      h(IconButton, { icon: 'close', title: t('common.close') || '关闭', onClick: () => props.onClose && props.onClose() }),
    ),
    state.status === 'loading'
      ? h('div', { className: 'ph-n-inline__state' }, h(Spinner), h('span', null, t('common.loading') || '加载中…'))
      : state.status === 'error'
        ? h('div', { className: 'ph-n-inline__state' }, h('span', null, t('notes.error.load') || '笔记加载失败'), h('button', { type: 'button', className: 'ph-btn ph-btn--sm', onClick: () => setReload((value) => value + 1) }, t('common.retry') || '重试'))
        : state.note
          ? h(NoteEditor, {
              t,
              api: api,
              service,
              note: state.note,
              variant: 'full',
              folders: state.folders,
              onSaved: (note) => setState((previous) => Object.assign({}, previous, { note: note || previous.note })),
              onDeleted: () => props.onClose && props.onClose(),
              onOpenPaper: props.onOpenPaper,
              notify: props.notify,
            })
          : h('div', { className: 'ph-n-inline__state' }, t('notes.empty') || '还没有笔记'),
  )
}
