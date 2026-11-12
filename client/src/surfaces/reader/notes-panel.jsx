/**
 * Reader side panel → 「笔记」 tab (v0.17).
 *
 * A single-paper note stream: every note created here is linked to the paper the
 * reader currently shows. Notes are edited with the shared `NoteEditor`, so
 * autosave, AI beautification, revision history and "恢复原文" behave exactly like
 * the standalone notes library; only the chrome differs.
 *
 * The Host half may not expose `notes.*` yet (v0.16 builds answer
 * `unknown API method`). That state is rendered honestly as 「笔记服务未就绪」
 * with a retry, never as an empty/crashed panel.
 */
import React from 'react'
import { ensureNotesStyles } from '../notes/styles.js'
import { NoteEditor } from '../notes/editor.jsx'
import { Empty, Icon, IconBtn, Spinner } from './shared.jsx'
import { createNotesService } from '../../core/notes-api.js'

/** Subscribe to one notes service instance. */
function useServiceState(service) {
  const subscribe = React.useCallback((listener) => service.subscribe(listener), [service])
  const getSnapshot = React.useCallback(() => service.getSnapshot(), [service])
  return React.useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
}

/**
 * @param {object} props
 * @param {Function} props.t normal translator (notes.* keys)
 * @param {Function} props.api Host API callable
 * @param {string} props.paperId
 * @param {object|null} props.paper
 * @param {string} [props.sessionId]
 * @param {Function} props.notify `(kind, text)`
 * @param {Function} [props.onOpenNoteLibrary] `(noteId)` switch to the notes library
 * @param {Function} [props.onOpenPaper] `(paperId, page)`
 */
export function ReaderNotesPanel(props) {
  const t = props.t
  const paperId = String(props.paperId || '')
  const releaseStyles = React.useMemo(() => ensureNotesStyles(), [])
  const service = React.useMemo(() => createNotesService(props.api), [props.api])
  const serviceState = useServiceState(service)
  const [list, setList] = React.useState({ status: 'loading', items: [], error: null })
  const [activeId, setActiveId] = React.useState('')
  const [active, setActive] = React.useState({ status: 'idle', note: null, error: null })
  const [creating, setCreating] = React.useState(false)
  // Two-level navigation: the notes tab opens the paper's note list first; only
  // a chosen note shows the editor. Back returns to the list to switch notes.
  const [mode, setMode] = React.useState('list')
  const [activeRetry, setActiveRetry] = React.useState(0)

  React.useEffect(() => () => releaseStyles(), [releaseStyles])

  React.useEffect(() => {
    let alive = true
    service.probe()
      .then((state) => {
        if (!alive) return
        if (state.status === 'unavailable' || state.status === 'offline') return
        load(alive)
      })
      .catch((error) => {
        if (alive) setList({ status: 'error', items: [], error })
      })
    return () => {
      alive = false
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [service, paperId])

  const load = React.useCallback(
    (alive) => {
      setList((previous) => Object.assign({}, previous, { status: 'loading', error: null }))
      Promise.resolve(service.list({ paperId: paperId, limit: 100 }))
        .then((result) => {
          if (alive === false) return
          const items = result.items || []
          setList({ status: 'ready', items, error: null })
          setActiveId((previous) => {
            if (previous && items.some((item) => item.id === previous)) return previous
            // Prefer a written note over an empty placeholder so the editor
            // does not open on a blank note just because it is newest.
            const meaningful = items.find((item) => String(item.title || '').trim() !== '' || String(item.preview || '').trim() !== '')
            return (meaningful || items[0] || {}).id || ''
          })
        })
        .catch((error) => {
          if (alive === false) return
          setList({ status: 'error', items: [], error })
        })
    },
    [paperId, service],
  )

  const reload = React.useCallback(() => {
    service.probe().then((state) => {
      if (state.status === 'unavailable' || state.status === 'offline') return
      load(true)
    })
  }, [load, service])

  React.useEffect(() => {
    if (!activeId) {
      setActive({ status: 'idle', note: null, error: null })
      return undefined
    }
    let alive = true
    setActive({ status: 'loading', note: null, error: null })
    let timer = null
    let request
    try {
      request = Promise.resolve(service.get(activeId))
    } catch (error) {
      setActive({ status: 'error', note: null, error })
      return undefined
    }
    timer = setTimeout(() => {
      if (alive) setActive({ status: 'error', note: null, error: new Error('加载笔记超时，请重试') })
    }, 8000)
    request
      .then((note) => {
        if (timer) clearTimeout(timer)
        if (alive) setActive({ status: 'ready', note, error: null })
      })
      .catch((error) => {
        if (timer) clearTimeout(timer)
        if (alive) setActive({ status: 'error', note: null, error })
      })
    return () => {
      alive = false
      if (timer) clearTimeout(timer)
    }
  }, [activeId, service, activeRetry])

  const createNote = React.useCallback(() => {
    if (creating) return
    setCreating(true)
    Promise.resolve(service.create({ title: '', content: '', paperIds: paperId ? [paperId] : [], status: 'draft' }))
      .then((note) => {
        if (!note) throw new Error('notes.create returned no note')
        setList((previous) => ({ status: 'ready', items: [Object.assign({}, note, { preview: note.preview || note.contentMd.slice(0, 120) })].concat(previous.items), error: null }))
        setActive({ status: 'ready', note, error: null })
        setActiveId(note.id)
        setMode('editor')
      })
      .catch((error) => props.notify('error', t('notes.createFailed', { message: String((error && error.message) || error) })))
      .then(() => setCreating(false))
  }, [creating, paperId, props, service, t])

  const onSaved = React.useCallback((saved) => {
    if (!saved) return
    setList((previous) => {
      const items = previous.items.map((item) =>
        item.id === saved.id
          ? Object.assign({}, item, {
              title: saved.title,
              preview: (saved.contentMd || '').slice(0, 120),
              revision: saved.revision,
              updatedAt: saved.updatedAt,
              paperIds: saved.paperIds,
            })
          : item,
      )
      if (!items.some((item) => item.id === saved.id)) items.unshift(Object.assign({}, saved, { preview: (saved.contentMd || '').slice(0, 120) }))
      return Object.assign({}, previous, { items })
    })
    setActive((previous) => (previous.note && previous.note.id === saved.id ? { status: 'ready', note: saved, error: null } : previous))
  }, [])

  const onDeleted = React.useCallback((deleted) => {
    setList((previous) => {
      const items = previous.items.filter((item) => item.id !== deleted.id)
      setActiveId('')
      setActive({ status: 'idle', note: null, error: null })
      setMode('list')
      return Object.assign({}, previous, { items })
    })
  }, [])

  /* ------------------------------ degraded states ------------------------ */
  if (serviceState.status === 'unavailable' || serviceState.status === 'offline') {
    return React.createElement(
      'div',
      { className: 'ph-r-side__scroll' },
      React.createElement(Empty, {
        icon: 'warning',
        tone: 'warning',
        title: serviceState.status === 'offline' ? t('notes.service.offlineTitle') : t('notes.service.unavailableTitle'),
        desc: serviceState.status === 'offline' ? t('notes.service.offlineDesc') : t('notes.service.unavailableDesc'),
        action: React.createElement(
          'button',
          {
            type: 'button',
            className: 'ph-r-btn ph-r-btn--soft ph-r-btn--sm',
            onClick: () => {
              service.probe().then((state) => {
                if (state.status === 'ready') load(true)
              })
            },
          },
          React.createElement(Icon, { name: 'refresh', size: 13 }),
          React.createElement('span', { className: 'ph-r-btn__label' }, t('notes.service.retry')),
        ),
      }),
    )
  }

  const showList = list.items.length > 0
  const editing = mode === 'editor' && activeId !== ''
  const activeTitle = active.note && (active.note.title || '') ? active.note.title : t('notes.untitled')
  return React.createElement(
    'div',
    { className: 'ph-n-readernotes' },
    React.createElement(
      'div',
      { className: 'ph-n-readernotes__head' },
      editing
        ? React.createElement(IconBtn, { icon: 'chevronLeft', title: t('reader.notes.backToList'), onClick: () => setMode('list') })
        : React.createElement(Icon, { name: 'note', size: 13 }),
      React.createElement('span', { className: 'ph-n-readernotes__title' }, editing ? activeTitle : t('reader.notes.title')),
      !editing && list.status === 'ready' ? React.createElement('span', { className: 'ph-n-caption' }, String(list.items.length)) : null,
      React.createElement('span', { className: 'ph-n-spacer' }),
      editing
        ? React.createElement(IconBtn, { icon: 'external', title: t('notes.library.open'), onClick: () => props.onOpenNoteLibrary && props.onOpenNoteLibrary(activeId) })
        : React.createElement(IconBtn, { icon: 'plus', title: t('reader.notes.new'), onClick: createNote, disabled: creating }),
      !editing && props.onOpenNoteLibrary
        ? React.createElement(IconBtn, { icon: 'external', title: t('notes.library.open'), onClick: () => props.onOpenNoteLibrary(activeId || '') })
        : null,
      !editing
        ? React.createElement(IconBtn, { icon: 'refresh', title: t('notes.refresh'), onClick: reload })
        : null,
    ),
    editing
      ? active.status === 'loading'
        ? React.createElement('div', { className: 'ph-n-editor__loading' }, React.createElement(Spinner, { size: 13 }), React.createElement('span', null, t('notes.loadingNote')))
        : active.status === 'error'
          ? React.createElement(
              'div',
              { className: 'ph-r-side__scroll' },
              React.createElement(Empty, {
                icon: 'warning',
                tone: 'error',
                title: t('notes.loadFailed', { message: String((active.error && active.error.message) || '') }),
                action: React.createElement(
                  'button',
                  { type: 'button', className: 'ph-r-btn ph-r-btn--soft ph-r-btn--sm', onClick: () => { setActive({ status: 'loading', note: null, error: null }); setActiveRetry((value) => value + 1) } },
                  React.createElement(Icon, { name: 'refresh', size: 13 }),
                  React.createElement('span', { className: 'ph-r-btn__label' }, t('common.retry')),
                ),
              }),
            )
          : active.status === 'ready' && active.note
            ? React.createElement(NoteEditor, {
                t: t,
                api: props.api,
                service: service,
                note: active.note,
                variant: 'compact',
                paperId: paperId,
                sessionId: props.sessionId,
                notify: props.notify,
                linkable: true,
                onSaved: onSaved,
                onDeleted: onDeleted,
                onOpenNoteLibrary: props.onOpenNoteLibrary,
                onOpenPaper: props.onOpenPaper,
              })
            : null
      : list.status === 'loading' && list.items.length === 0
        ? React.createElement('div', { className: 'ph-n-editor__loading' }, React.createElement(Spinner, { size: 13 }), React.createElement('span', null, t('notes.loading')))
        : list.status === 'error'
          ? React.createElement(
              'div',
              { className: 'ph-r-side__scroll' },
              React.createElement(Empty, {
                icon: 'warning',
                tone: 'error',
                title: t('common.failed'),
                desc: t('notes.loadFailed', { message: String((list.error && list.error.message) || '') }),
                action: React.createElement(
                  'button',
                  { type: 'button', className: 'ph-r-btn ph-r-btn--soft ph-r-btn--sm', onClick: reload },
                  React.createElement(Icon, { name: 'refresh', size: 13 }),
                  React.createElement('span', { className: 'ph-r-btn__label' }, t('common.retry')),
                ),
              }),
            )
          : !showList
            ? React.createElement(
                'div',
                { className: 'ph-r-side__scroll' },
                React.createElement(Empty, {
                  icon: 'note',
                  title: t('reader.notes.empty'),
                  desc: t('reader.notes.emptyDesc'),
                  action: React.createElement(
                    'button',
                    { type: 'button', className: 'ph-r-btn ph-r-btn--solid ph-r-btn--sm', onClick: createNote, disabled: creating },
                    React.createElement(Icon, { name: 'plus', size: 13 }),
                    React.createElement('span', { className: 'ph-r-btn__label' }, t('reader.notes.new')),
                  ),
                }),
              )
            : React.createElement(
                React.Fragment,
                null,
                React.createElement(
                  'div',
                  { className: 'ph-n-readernotes__hint' },
                  React.createElement(Icon, { name: 'info', size: 12 }),
                  React.createElement('span', null, t('reader.notes.pick')),
                ),
                React.createElement(
                  'div',
                  { className: 'ph-n-readernotes__list ph-n-scroll' },
                  list.items.map((item) =>
                    React.createElement(
                      'button',
                      {
                        key: item.id,
                        type: 'button',
                        className: 'ph-n-readernotes__row',
                        onClick: () => {
                          setActiveId(item.id)
                          // The list may already have hydated this note as the
                          // default activeId; without a retry token the load
                          // effect would not run again and the editor would
                          // stay on "加载笔记内容…" forever.
                          setActiveRetry((value) => value + 1)
                          setMode('editor')
                        },
                        title: item.title || t('notes.untitled'),
                      },
                      React.createElement('span', { className: 'ph-n-readernotes__rowtitle' }, item.title || t('notes.untitled')),
                      React.createElement(
                        'span',
                        { className: 'ph-n-readernotes__rowmeta' },
                        (item.preview || '').replace(/\s+/g, ' ').slice(0, 80) || t('notes.empty.preview'),
                      ),
                    ),
                  ),
                ),
              ),
    React.createElement('p', { className: 'ph-n-caption', style: { padding: '6px 12px 10px', margin: 0 } }, editing ? t('reader.notes.boundHint') : t('reader.notes.listHint')),
  )
}
