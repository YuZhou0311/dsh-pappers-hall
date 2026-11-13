/**
 * Shared note editor (v0.17).
 *
 * One editor powers both the reader side tab (compact, paper-bound) and the
 * standalone notes library (full, 0..N linked papers). It owns the save pipeline:
 *
 *   - 800 ms debounce, plus an immediate flush on blur / tab switch / unmount /
 *     pagehide, so the Host always gets the latest body;
 *   - every failed write first lands in a localStorage draft (`saveDraft`) and is
 *     retried twice; the panel then offers a manual retry — content is never lost;
 *   - `expectedRevision` guards against concurrent edits (`conflict` banner with
 *     "reload" / "overwrite");
 *   - AI beautification only ever writes `contentJson`; `contentMd` is untouched
 *     and "恢复原文" flips the renderer back at any time;
 *   - v2 边写边美化: a per-note auto-beautify switch persists in localStorage,
 *     after a successful save it incrementally re-lays-out only the finished,
 *     not-yet-beautified sections (never incomplete ones), first asking the model
 *     for 3 micro-directions shown in a non-blocking overlay (one-click adopt or
 *     ignore). Manual and automatic passes share the same merge path.
 */
import React from 'react'
import { downloadText } from '../../core/files.js'
import { Icon } from '../../core/icons.jsx'
import { Badge, Button, EmptyState, IconButton, Spinner } from '../../core/primitives.jsx'
import {
  AUTO_MIN_CHARS,
  countDirectives,
  AUTOFIX_INTRO_FLAG,
  DEFAULT_AUTOFIX_DIRECTION,
  clearDraft,
  formatClock,
  formatNoteTime,
  matchSectionCards,
  noteToMarkdown,
  patchAutoFix,
  planBeautifySections,
  readAutoFix,
  readDraft,
  readFlag,
  resolveIncompleteSections,
  saveDraft,
  saveIncompleteSections,
  sectionizeMarkdown,
  writeFlag,
} from '../../core/notes-model.js'
import { NoteCards } from './cards.jsx'
import { BeautifyDialog, Modal, PaperLinkDialog, RevisionsDialog } from './dialogs.jsx'

/** localStorage draft age shown in the recovery banner. */
function draftTimeLabel(value) {
  return formatNoteTime(value) || ''
}

/** Inline two-step confirm button. */
function ConfirmButton(props) {
  const [armed, setArmed] = React.useState(false)
  React.useEffect(() => {
    if (!armed) return undefined
    const timer = setTimeout(() => setArmed(false), 4500)
    return () => clearTimeout(timer)
  }, [armed])
  return React.createElement(
    Button,
    {
      size: 'sm',
      variant: armed ? 'danger' : props.variant || 'ghost',
      icon: props.icon,
      loading: props.loading,
      onClick: () => {
        if (armed) {
          setArmed(false)
          props.onConfirm()
        } else setArmed(true)
      },
      title: props.title,
    },
    armed ? props.confirmLabel || props.children : props.children,
  )
}

/** Dropdown menu (inline, closes on outside click / Escape). */
function Menu(props) {
  const ref = React.useRef(null)
  React.useEffect(() => {
    const onDown = (event) => {
      if (ref.current && !ref.current.contains(event.target)) props.onClose()
    }
    const onKey = (event) => {
      if (event.key === 'Escape') props.onClose()
    }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [props])
  return React.createElement(
    'div',
    { className: 'ph-n-menu', ref: ref, role: 'menu' },
    (props.items || []).filter(Boolean).map((item) =>
      React.createElement(
        'button',
        {
          key: item.id,
          type: 'button',
          role: 'menuitem',
          className: 'ph-n-menu__item' + (item.danger ? ' ph-n-menu__item--danger' : ''),
          onClick: () => {
            props.onClose()
            item.run()
          },
          disabled: item.disabled,
          title: item.title,
        },
        item.icon ? React.createElement(Icon, { name: item.icon, size: 14 }) : null,
        React.createElement('span', { className: 'ph-n-menu__label' }, item.label),
      ),
    ),
  )
}

/**
 * @param {object} props
 * @param {object} props.t
 * @param {Function} props.service notes service (`core/notes-api.js`)
 * @param {object|null} props.note normalised note (full content) or null
 * @param {'compact'|'full'} [props.variant]
 * @param {Function} [props.notify] toast helper `(kind, text)`
 * @param {string} [props.paperId] reader-bound paper (AI grounding + chip)
 * @param {string} [props.sessionId]
 * @param {Array} [props.folders] flattened note folders for the move control
 * @param {Function} [props.onSaved] `(note)` after a successful Host write
 * @param {Function} [props.onDeleted] `(note)`
 * @param {Function} [props.onOpenPaper] `(paperId)`
 * @param {Function} [props.onMoveFolder] `(folderId)` returns a promise
 * @param {boolean} [props.linkable] show the "link papers" dialog (full variant)
 * @param {object|null} [props.aiStatus] preloaded ai.status
 * @param {Function} [props.onOpenNoteLibrary]
 */
export function NoteEditor(props) {
  const t = props.t
  const service = props.service
  const compact = props.variant === 'compact'
  const note = props.note && props.note.id ? props.note : null
  const noteId = note ? String(note.id) : ''

  const [title, setTitle] = React.useState(note ? note.title : '')
  const [content, setContent] = React.useState(note ? note.contentMd : '')
  const [contentJson, setContentJson] = React.useState(note ? note.contentJson : null)
  const [viewMode, setViewMode] = React.useState(note && note.contentJson ? 'cards' : 'original')
  const [saveState, setSaveState] = React.useState({ status: note ? 'saved' : 'idle', at: 0, message: '' })
  const [conflict, setConflict] = React.useState(null)
  const [draftFound, setDraftFound] = React.useState(null)
  const [incompleteIds, setIncompleteIds] = React.useState(() => (note ? resolveIncompleteSections(note.id, sectionizeMarkdown(note.contentMd)) : []))
  const [beautifyOpen, setBeautifyOpen] = React.useState(false)
  const [directiveMenuOpen, setDirectiveMenuOpen] = React.useState(false)
  const [directiveRunning, setDirectiveRunning] = React.useState(false)
  const [beautifySelection, setBeautifySelection] = React.useState(null)
  const [historyOpen, setHistoryOpen] = React.useState(false)
  const [linkOpen, setLinkOpen] = React.useState(false)
  const [menuOpen, setMenuOpen] = React.useState(false)
  const [deleting, setDeleting] = React.useState(false)
  const [deleteOpen, setDeleteOpen] = React.useState(false)
  const [sectionsOpen, setSectionsOpen] = React.useState(false)
  const [aiStatus, setAiStatus] = React.useState(props.aiStatus || null)
  const [autoFix, setAutoFix] = React.useState(() => readAutoFix(note ? note.id : ''))
  const [autoIntro, setAutoIntro] = React.useState(false)
  const [autoOverlay, setAutoOverlay] = React.useState(null)
  const [autoRunning, setAutoRunning] = React.useState(false)
  const [autoStatus, setAutoStatus] = React.useState(null)

  const titleRef = React.useRef(null)
  const contentRef = React.useRef(null)
  const textareaRef = React.useRef(null)
  const noteRef = React.useRef(note)
  const revisionRef = React.useRef(note ? note.revision : 0)
  const localRef = React.useRef({ title: note ? note.title : '', content: note ? note.contentMd : '' })
  const dirtyRef = React.useRef(false)
  const debounceRef = React.useRef(null)
  const retryRef = React.useRef(null)
  const retryCountRef = React.useRef(0)
  const saveSeqRef = React.useRef(0)
  // Idempotency: one operation id per *body snapshot*, reused by retries so a
  // network failure after a successful commit cannot duplicate the write.
  const saveOpRef = React.useRef({ id: '', snapshot: '' })
  const mountedRef = React.useRef(true)
  const loadKeyRef = React.useRef('')
  const onSavedRef = React.useRef(props.onSaved)
  onSavedRef.current = props.onSaved
  // v2: auto-beautify pipeline refs (single concurrency, non-blocking).
  const contentJsonRef = React.useRef(note ? note.contentJson : null)
  const incompleteRef = React.useRef(incompleteIds)
  const autoEnabledRef = React.useRef(false)
  const autoDirectionRef = React.useRef(DEFAULT_AUTOFIX_DIRECTION)
  const autoBusyRef = React.useRef(false)
  const autoTimerRef = React.useRef(null)
  const autoOverlayRef = React.useRef(null)
  const autoOverlayTimerRef = React.useRef(null)
  const autoStatusTimerRef = React.useRef(null)
  const autoLastAtRef = React.useRef(0)
  // Fingerprint of the last auto attempt that failed; avoids retrying the same
  // unchanged content forever when the model returned an unusable layout.
  const autoFailRef = React.useRef('')
  const sameNoteRef = React.useRef('')

  React.useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
    }
  }, [])
  React.useEffect(() => {
    contentJsonRef.current = contentJson
  }, [contentJson])
  React.useEffect(() => {
    incompleteRef.current = incompleteIds
  }, [incompleteIds])
  React.useEffect(() => {
    autoEnabledRef.current = autoFix.enabled
    autoDirectionRef.current = autoFix.direction
  }, [autoFix])

  /* ---------------------- hydrate on note changes ------------------------ */
  const loadKey = note ? String(note.id) + ':' + String(note.revision) + ':' + String(note.updatedAt || '') : ''
  React.useEffect(() => {
    if (loadKey === loadKeyRef.current) return
    loadKeyRef.current = loadKey
    if (!note) return
    // A write of ours came back while the user kept typing: adopt the revision
    // only, never the (older) body.
    if (dirtyRef.current && noteRef.current && noteRef.current.id === note.id) {
      revisionRef.current = note.revision
      return
    }
    const sameNote = sameNoteRef.current === String(note.id)
    sameNoteRef.current = String(note.id)
    noteRef.current = note
    revisionRef.current = note.revision
    localRef.current = { title: note.title, content: note.contentMd }
    setTitle(note.title)
    setContent(note.contentMd)
    setContentJson(note.contentJson || null)
    contentJsonRef.current = note.contentJson || null
    // Keep the current render mode when only the contentJson of the same note
    // came back from an automatic pass, so writing in 原文 view is never yanked.
    setViewMode((previous) => (sameNote ? previous : note.contentJson ? 'cards' : 'original'))
    dirtyRef.current = false
    setSaveState({ status: 'saved', at: Date.now(), message: '' })
    setConflict(null)
    const sections = sectionizeMarkdown(note.contentMd)
    setIncompleteIds(resolveIncompleteSections(note.id, sections))
    const draft = readDraft(note.id)
    const differs = draft && (draft.title !== note.title || draft.content !== note.contentMd)
    setDraftFound(differs ? draft : null)
    // per-note auto-beautify preference
    const loadedAuto = readAutoFix(note.id)
    autoEnabledRef.current = loadedAuto.enabled
    autoDirectionRef.current = loadedAuto.direction
    autoLastAtRef.current = loadedAuto.lastBeautifiedAt || 0
    setAutoFix(loadedAuto)
    setAutoIntro(false)
    setAutoStatus(null)
    setAutoOverlayState(null)
    if (autoTimerRef.current) { clearTimeout(autoTimerRef.current); autoTimerRef.current = null }
    if (autoOverlayTimerRef.current) { clearTimeout(autoOverlayTimerRef.current); autoOverlayTimerRef.current = null }
    // Also evaluate the loaded body (not only local saves). Notes can arrive
    // from the Agent/notes API or another editor, and opening such a note with
    // auto-beautify on should still lay out its finished sections.
    if (loadedAuto.enabled) {
      autoFailRef.current = ''
      scheduleAutoCheck(1200)
    }
  }, [loadKey, note])

  /* ------------------------------- saving -------------------------------- */
  const buildDraftPayload = React.useCallback(() => {
    const current = noteRef.current
    if (!current) return null
    return {
      title: localRef.current.title,
      content: localRef.current.content,
      at: Date.now(),
      baseRevision: revisionRef.current,
    }
  }, [])

  const persist = React.useCallback(
    (options) => {
      const current = noteRef.current
      if (!current || !current.id) return Promise.resolve(null)
      if (!dirtyRef.current) return Promise.resolve(null)
      const opts = options || {}
      const snapshot = { title: localRef.current.title, content: localRef.current.content }
      const fingerprint = JSON.stringify([current.id, snapshot.title, snapshot.content])
      if (saveOpRef.current.snapshot !== fingerprint) {
        const random =
          typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
            ? crypto.randomUUID()
            : Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 10)
        saveOpRef.current = { id: 'notes-save-' + random, snapshot: fingerprint }
      }
      const seq = (saveSeqRef.current += 1)
      setSaveState({ status: 'saving', at: Date.now(), message: '' })
      const params = { id: current.id, patch: { title: snapshot.title, content: snapshot.content }, operationId: saveOpRef.current.id }
      if (!opts.force && revisionRef.current > 0) params.expectedRevision = revisionRef.current
      return Promise.resolve(service.update(params))
        .then((saved) => {
          if (!saved) throw new Error('notes.update returned no note')
          if (!mountedRef.current || seq !== saveSeqRef.current) return saved
          revisionRef.current = Number(saved.revision) || revisionRef.current
          loadKeyRef.current = String(saved.id || current.id) + ':' + String(revisionRef.current) + ':' + String(saved.updatedAt || '')
          if (localRef.current.title === snapshot.title && localRef.current.content === snapshot.content) dirtyRef.current = false
          clearDraft(current.id)
          retryCountRef.current = 0
          setConflict(null)
          // A successful (re)try makes any "recovered draft" banner obsolete.
          setDraftFound(null)
          setSaveState({ status: 'saved', at: Date.now(), message: '' })
          if (onSavedRef.current) onSavedRef.current(saved)
          // 边写边美化: only after a real body save; auto pass never blocks typing.
          scheduleAutoCheck()
          return saved
        })
        .catch((error) => {
          if (!mountedRef.current) throw error
          const draft = buildDraftPayload()
          if (draft) saveDraft(current.id, draft)
          if (error && error.code === 'conflict') {
            setConflict({ currentRevision: Number(error.currentRevision) || 0 })
            setSaveState({ status: 'conflict', at: Date.now(), message: String(error.message || '') })
            return null
          }
          const offline = Boolean(error && (error.code === 'notes_unavailable' || error.code === 'not_running' || error.code === 'network'))
          setSaveState({
            status: offline ? 'offline' : 'error',
            at: Date.now(),
            message: String((error && error.message) || error || ''),
          })
          if (retryCountRef.current < 2) {
            retryCountRef.current += 1
            const delay = retryCountRef.current === 1 ? 1500 : 3500
            if (retryRef.current) clearTimeout(retryRef.current)
            retryRef.current = setTimeout(() => {
              retryRef.current = null
              if (mountedRef.current) persist({ force: opts.force })
            }, delay)
          }
          return null
        })
    },
    [buildDraftPayload, service],
  )

  const scheduleSave = React.useCallback(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current)
    debounceRef.current = setTimeout(() => {
      debounceRef.current = null
      persist()
    }, 800)
  }, [persist])

  const flush = React.useCallback(() => {
    if (debounceRef.current) {
      clearTimeout(debounceRef.current)
      debounceRef.current = null
    }
    return persist()
  }, [persist])

  const applyLocal = React.useCallback(
    (patch) => {
      localRef.current = Object.assign({}, localRef.current, patch)
      if ('title' in patch) setTitle(patch.title)
      if ('content' in patch) setContent(patch.content)
      dirtyRef.current = true
      retryCountRef.current = 0
      autoFailRef.current = ''
      setSaveState((previous) => (previous.status === 'saving' ? previous : { status: 'saving', at: Date.now(), message: '' }))
      setConflict(null)
      scheduleSave()
    },
    [scheduleSave],
  )

  // Flush on unmount and when the tab/window is being closed.
  React.useEffect(() => {
    const onPageHide = () => {
      if (!dirtyRef.current || !noteRef.current) return
      const draft = buildDraftPayload()
      if (draft) saveDraft(noteRef.current.id, draft)
      // Best-effort network write; a cancelled request still leaves the draft.
      try {
        service.update({ id: noteRef.current.id, patch: { title: localRef.current.title, content: localRef.current.content } }).catch(() => {})
      } catch {
        /* ignore */
      }
    }
    if (typeof window !== 'undefined') {
      window.addEventListener('pagehide', onPageHide)
      window.addEventListener('beforeunload', onPageHide)
    }
    return () => {
      if (typeof window !== 'undefined') {
        window.removeEventListener('pagehide', onPageHide)
        window.removeEventListener('beforeunload', onPageHide)
      }
      if (debounceRef.current) clearTimeout(debounceRef.current)
      if (retryRef.current) clearTimeout(retryRef.current)
      if (autoTimerRef.current) clearTimeout(autoTimerRef.current)
      if (autoOverlayTimerRef.current) clearTimeout(autoOverlayTimerRef.current)
      if (autoStatusTimerRef.current) clearTimeout(autoStatusTimerRef.current)
      if (dirtyRef.current && noteRef.current) {
        const draft = buildDraftPayload()
        if (draft) saveDraft(noteRef.current.id, draft)
        try {
          service.update({ id: noteRef.current.id, patch: { title: localRef.current.title, content: localRef.current.content } }).catch(() => {})
        } catch {
          /* ignore */
        }
      }
    }
  }, [buildDraftPayload, service])

  /* ---------------------- derived sections / cards ----------------------- */
  const sections = React.useMemo(() => sectionizeMarkdown(content), [content])
  const cardRows = React.useMemo(() => matchSectionCards(content, contentJson).sections, [content, contentJson])
  const beautifiedIds = React.useMemo(() => cardRows.filter((row) => row.beautified).map((row) => row.section.id), [cardRows])
  const incompleteSet = new Set(incompleteIds)
  const incompleteCount = incompleteIds.length

  const toggleIncomplete = React.useCallback(
    (sectionId) => {
      if (!noteId) return
      const next = new Set(incompleteIds)
      if (next.has(sectionId)) next.delete(sectionId)
      else next.add(sectionId)
      const list = [...next]
      saveIncompleteSections(noteId, list)
      setIncompleteIds(list)
    },
    [incompleteIds, noteId],
  )

  /* ------------------------------ actions -------------------------------- */
  /**
   * Persist a v2 contentJson structurally. Shared by the manual dialog and the
   * automatic pass; `contentMd` is never part of this patch.
   */
  function saveContentJson(nextContentJson, options) {
    const current = noteRef.current
    if (!current) return Promise.reject(new Error('no note'))
    const random =
      typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
        ? crypto.randomUUID()
        : Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 10)
    return Promise.resolve(service.update({
      id: current.id,
      patch: {
        contentJson: nextContentJson,
        beautifiedRevision: revisionRef.current,
        formatVersion: service.formatVersion,
      },
      expectedRevision: revisionRef.current || undefined,
      operationId: 'notes-beautify-' + random,
    }))
      .then((saved) => {
        if (!saved) throw new Error('notes.update returned no note')
        revisionRef.current = Number(saved.revision) || revisionRef.current
        loadKeyRef.current = String(saved.id || current.id) + ':' + String(revisionRef.current) + ':' + String(saved.updatedAt || '')
        const next = saved.contentJson || nextContentJson
        contentJsonRef.current = next
        setContentJson(next)
        if (options && options.switchView) setViewMode('cards')
        if (onSavedRef.current) onSavedRef.current(saved)
        return saved
      })
      .catch((error) => {
        // Keep the revision guard honest for a later retry.
        if (error && error.code === 'conflict') setConflict({ currentRevision: Number(error.currentRevision) || 0 })
        throw error
      })
  }

  const persistCards = React.useCallback(
    (nextContentJson) => {
      const flushFirst = dirtyRef.current ? flush() : Promise.resolve(null)
      return flushFirst.then(() => saveContentJson(nextContentJson, { switchView: true }))
    },
    [flush],
  )

  const openBeautify = React.useCallback(() => {
    // Manual beautification takes over the single AI slot; cancel a pending
    // automatic suggestion (its overlay is not modal, so this is cheap).
    cancelPendingAuto()
    const textarea = textareaRef.current
    let selection = null
    if (!compact && textarea && typeof textarea.selectionStart === 'number' && textarea.selectionEnd > textarea.selectionStart) {
      selection = { start: textarea.selectionStart, end: textarea.selectionEnd }
    } else if (compact && textarea && typeof textarea.selectionStart === 'number' && textarea.selectionEnd > textarea.selectionStart) {
      selection = { start: textarea.selectionStart, end: textarea.selectionEnd }
    }
    setBeautifySelection(selection)
    setBeautifyOpen(true)
    if (!aiStatus) {
      Promise.resolve(service.aiStatus()).then((status) => {
        if (mountedRef.current && status) setAiStatus(status)
      }).catch(() => {})
    }
  }, [aiStatus, compact, service])

  const directiveCount = countDirectives(content)
  const directiveItems = [
    { id: 'figure', icon: 'figure', label: t('notes.directive.insertFigure'), run: () => insertDirective('{{figure: Figure 1}}') },
    { id: 'table', icon: 'table', label: t('notes.directive.insertTable'), run: () => insertDirective('{{table: 指标 | 数值}}') },
    { id: 'web-image', icon: 'image', label: t('notes.directive.insertWebImage'), run: () => insertDirective('{{web-image: 关键词}}') },
    { id: 'web', icon: 'link', label: t('notes.directive.insertWebSource'), run: () => insertDirective('{{web: 关键词或网址}}') },
    { id: 'stats', icon: 'table', label: t('notes.directive.insertStats'), run: () => insertDirective('{{stats: 关键数字}}') },
    { id: 'callout', icon: 'info', label: t('notes.directive.insertCallout'), run: () => insertDirective('{{callout: 需要强调的结论}}') },
    directiveCount > 0 ? { id: 'run', icon: 'sparkle', label: t('notes.directive.run', { count: directiveCount }), run: runDirectives } : null,
  ].filter(Boolean)

  function insertDirective(snippet) {
    const textarea = textareaRef.current
    const source = localRef.current.content || ''
    const start = textarea && typeof textarea.selectionStart === 'number' ? textarea.selectionStart : source.length
    const end = textarea && typeof textarea.selectionEnd === 'number' ? textarea.selectionEnd : start
    const prefix = start > 0 && !/\s/.test(source[start - 1]) ? ' ' : ''
    const suffix = end < source.length && !/\s/.test(source[end]) ? ' ' : ''
    const next = source.slice(0, start) + prefix + snippet + suffix + source.slice(end)
    applyLocal({ content: next })
    requestAnimationFrame(() => {
      const current = textareaRef.current
      if (!current) return
      const caret = start + prefix.length + snippet.length
      current.focus()
      current.setSelectionRange(caret, caret)
    })
  }

  function runDirectives() {
    if (!note || directiveRunning) return
    if (directiveCount === 0) {
      if (props.notify) props.notify('info', t('notes.directive.empty'))
      return
    }
    cancelPendingAuto()
    setDirectiveRunning(true)
    const current = noteRef.current
    const flushFirst = dirtyRef.current ? flush() : Promise.resolve(null)
    flushFirst
      .then(() => service.runDirectives({
        note: noteRef.current || current,
        sessionId: props.sessionId,
        paperId: props.paperId || '',
        baseContentJson: contentJsonRef.current,
      }))
      .then((result) => saveContentJson(result.contentJson, { switchView: true }).then(() => result))
      .then((result) => {
        if (props.notify) props.notify('success', t('notes.directive.done', { count: directiveCount, tools: Number(result.calls) || 0 }))
      })
      .catch((error) => {
        const code = String((error && error.code) || '')
        const message = code === 'unavailable'
          ? t('notes.directive.unavailable', { reason: String((error && (error.reason || error.message)) || '') })
          : t('notes.directive.failed', { message: String((error && error.message) || error) })
        if (props.notify) props.notify('error', message)
      })
      .then(() => { if (mountedRef.current) setDirectiveRunning(false) })
  }

  const reloadNote = React.useCallback(() => {
    if (!noteId) return
    const current = noteRef.current
    Promise.resolve(service.get(noteId))
      .then((fresh) => {
        if (!fresh) return
        if (current) saveDraft(noteId, { title: current.title, content: current.contentMd, at: Date.now(), baseRevision: current.revision })
        clearDraft(noteId)
        noteRef.current = fresh
        revisionRef.current = fresh.revision
        loadKeyRef.current = String(fresh.id) + ':' + String(fresh.revision) + ':' + String(fresh.updatedAt || '')
        localRef.current = { title: fresh.title, content: fresh.contentMd }
        setTitle(fresh.title)
        setContent(fresh.contentMd)
        setContentJson(fresh.contentJson || null)
        setViewMode(fresh.contentJson ? 'cards' : 'original')
        setIncompleteIds(resolveIncompleteSections(fresh.id, sectionizeMarkdown(fresh.contentMd)))
        dirtyRef.current = false
        setConflict(null)
        setSaveState({ status: 'saved', at: Date.now(), message: '' })
        if (onSavedRef.current) onSavedRef.current(fresh)
      })
      .catch(() => {})
  }, [noteId, service])

  const overwriteConflict = React.useCallback(() => {
    setConflict(null)
    flush()
    persist({ force: true })
    setTimeout(() => {
      if (dirtyRef.current) persist({ force: true })
    }, 10)
  }, [flush, persist])

  const deleteNote = React.useCallback(() => {
    if (!note || deleting) return
    setDeleting(true)
    Promise.resolve(service.remove([note.id]))
      .then(() => {
        clearDraft(note.id)
        if (props.notify) props.notify('success', t('notes.deleted'))
        if (props.onDeleted) props.onDeleted(note)
      })
      .catch((error) => {
        setDeleting(false)
        if (props.notify) props.notify('error', t('notes.deleteFailed', { message: String((error && error.message) || error) }))
      })
  }, [deleting, note, props, service, t])

  const clearFormat = React.useCallback(() => {
    if (!note) return
    Promise.resolve(service.update({ id: note.id, patch: { contentJson: null }, expectedRevision: revisionRef.current || undefined }))
      .then((saved) => {
        if (saved) {
          revisionRef.current = Number(saved.revision) || revisionRef.current
          loadKeyRef.current = String(saved.id) + ':' + String(revisionRef.current) + ':' + String(saved.updatedAt || '')
        }
        setContentJson(null)
        setViewMode('original')
        if (props.notify) props.notify('success', t('notes.clearFormatDone'))
        if (onSavedRef.current) onSavedRef.current(saved)
      })
      .catch((error) => {
        if (props.notify) props.notify('error', t('notes.clearFormatFailed', { message: String((error && error.message) || error) }))
      })
  }, [note, props, service, t])

  const exportNote = React.useCallback(() => {
    if (!note) return
    const fallback = () => {
      const markdown = noteToMarkdown(Object.assign({}, note, { title: localRef.current.title, contentMd: localRef.current.content }))
      downloadText((localRef.current.title || t('notes.untitled')) + '.md', 'text/markdown', markdown)
      if (props.notify) props.notify('success', t('notes.exportDone'))
    }
    Promise.resolve(service.exportNotes([note.id], 'both'))
      .then((result) => {
        const item = result && Array.isArray(result.items) ? result.items[0] : null
        if (item && item.content) downloadText(item.filename || 'note.md', item.mediaType || 'text/markdown', item.content)
        else fallback()
        if (props.notify) props.notify('success', t('notes.exportDone'))
      })
      .catch(fallback)
  }, [note, props, service, t])

  /* --------------------------- auto beautify ----------------------------- */
  // v2 边写边美化: after a successful save and a threshold, re-layout only the
  // finished sections that are new/stale. One AI call at a time, never blocking
  // typing, and `contentMd` is never part of any of these writes.

  function autoNoteId() {
    return noteRef.current && noteRef.current.id ? String(noteRef.current.id) : ''
  }

  function setAutoOverlayState(next) {
    autoOverlayRef.current = next
    setAutoOverlay(next)
  }

  function clearOverlayTimer() {
    if (autoOverlayTimerRef.current) {
      clearTimeout(autoOverlayTimerRef.current)
      autoOverlayTimerRef.current = null
    }
  }

  function clearIdeaTimers() {
    if (autoTimerRef.current) {
      clearTimeout(autoTimerRef.current)
      autoTimerRef.current = null
    }
    clearOverlayTimer()
    if (autoStatusTimerRef.current) {
      clearTimeout(autoStatusTimerRef.current)
      autoStatusTimerRef.current = null
    }
  }

  function showAutoStatus(kind, text, ttl) {
    if (!mountedRef.current) return
    setAutoStatus({ kind: kind || 'info', text: String(text || ''), at: Date.now() })
    if (autoStatusTimerRef.current) clearTimeout(autoStatusTimerRef.current)
    if (ttl && ttl > 0) {
      autoStatusTimerRef.current = setTimeout(() => {
        autoStatusTimerRef.current = null
        if (mountedRef.current) setAutoStatus(null)
      }, ttl)
    }
  }

  function cancelPendingAuto() {
    clearOverlayTimer()
    if (autoTimerRef.current) {
      clearTimeout(autoTimerRef.current)
      autoTimerRef.current = null
    }
    if (autoOverlayRef.current) setAutoOverlayState(null)
    autoBusyRef.current = false
    if (mountedRef.current) setAutoRunning(false)
  }

  function autoPlanNow() {
    return planBeautifySections(localRef.current.content, contentJsonRef.current, incompleteRef.current)
  }

  function scheduleAutoCheck(delay) {
    if (!autoEnabledRef.current || !mountedRef.current) return
    if (autoTimerRef.current) clearTimeout(autoTimerRef.current)
    const ms = typeof delay === 'number' ? Math.max(0, delay) : 0
    autoTimerRef.current = setTimeout(() => {
      autoTimerRef.current = null
      runAutoCheck()
    }, ms)
  }

  function runAutoCheck() {
    if (!mountedRef.current || !autoEnabledRef.current || autoBusyRef.current) return
    if (!noteRef.current) return
    // Wait for the body to be saved: beautify must never race the autosave.
    if (dirtyRef.current) {
      scheduleAutoCheck(2000)
      return
    }
    const plan = autoPlanNow()
    if (!plan || plan.eligible.length === 0) {
      autoFailRef.current = ''
      return
    }
    // Pure character-count trigger: at least ~500 newly written/updated chars
    // since the last layout. Never wait for an idle pause.
    if (plan.pendingChars < AUTO_MIN_CHARS) {
      autoFailRef.current = ''
      return
    }
    const fingerprint = String(localRef.current.content.length) + ':' + String(plan.pendingChars) + ':' + (contentJsonRef.current ? '1' : '0')
    if (autoFailRef.current === fingerprint) return
    triggerAuto(plan)
  }

  function autoContextText(eligible) {
    const sections = sectionizeMarkdown(localRef.current.content)
    const incomplete = new Set(incompleteRef.current)
    const firstStart = eligible.length > 0 ? eligible[0].start : Number.MAX_SAFE_INTEGER
    const previous = sections.filter((section) => incomplete.has(section.id) && section.start < firstStart).slice(-1)[0]
    return previous ? String(previous.raw || previous.text || '').slice(0, 600) : ''
  }

  function loadFigureCandidates(current) {
    if (!current) return Promise.resolve([])
    const links = Array.isArray(current.paperLinks) && current.paperLinks.length > 0
      ? current.paperLinks
      : (Array.isArray(current.paperIds) ? current.paperIds : []).map((paperId) => ({ paperId: paperId }))
    if (links.length === 0) return Promise.resolve([])
    return Promise.resolve(service.figureCandidates(links, { limit: 12 }))
      .then((result) => (result && Array.isArray(result.candidates) ? result.candidates : []))
      .catch(() => [])
  }

  function triggerAuto(plan) {
    if (autoBusyRef.current || !mountedRef.current) return
    autoBusyRef.current = true
    setAutoRunning(true)
    const current = noteRef.current
    if (!current) {
      autoBusyRef.current = false
      setAutoRunning(false)
      return
    }
    loadFigureCandidates(current)
      .then((candidates) => Promise.resolve(service.suggestDirections({
        noteId: noteRef.current && noteRef.current.id,
        title: localRef.current.title,
        sections: plan.eligible,
        figureCandidates: candidates,
        direction: autoDirectionRef.current,
        sessionId: props.sessionId,
        minChars: plan.pendingChars,
      })).then((suggestion) => ({ suggestion, candidates })))
      .then(({ suggestion, candidates }) => {
        if (!mountedRef.current) return
        const directions = Array.isArray(suggestion && suggestion.directions) ? suggestion.directions : []
        if (directions.length === 0) throw Object.assign(new Error('no direction suggestion'), { code: 'empty' })
        setAutoOverlayState({
          sections: plan.eligible,
          figureCandidates: candidates,
          directions,
          recommended: String(suggestion.recommended || directions[0].id),
          pendingChars: plan.pendingChars,
          degraded: Boolean(suggestion.degraded),
          reason: String(suggestion.reason || ''),
          provider: String(suggestion.provider || ''),
          model: String(suggestion.model || ''),
        })
        // Non-blocking: adopt the recommended direction automatically after 10s.
        clearOverlayTimer()
        autoOverlayTimerRef.current = setTimeout(() => {
          autoOverlayTimerRef.current = null
          adoptAutoDirection('__timeout__')
        }, 10000)
      })
      .catch(() => {
        autoBusyRef.current = false
        if (mountedRef.current) setAutoRunning(false)
        showAutoStatus('warn', t('notes.autofix.dirFailed'), 8000)
      })
  }

  function adoptAutoDirection(optionId) {
    const overlay = autoOverlayRef.current
    if (!overlay) return
    clearOverlayTimer()
    const option = overlay.directions.find((entry) => entry.id === optionId)
      || overlay.directions.find((entry) => entry.id === overlay.recommended)
      || overlay.directions[0]
    setAutoOverlayState(null)
    runAutoBeautify(overlay, option)
  }

  function ignoreAuto() {
    const overlay = autoOverlayRef.current
    clearOverlayTimer()
    setAutoOverlayState(null)
    autoBusyRef.current = false
    if (mountedRef.current) setAutoRunning(false)
    showAutoStatus('info', t('notes.autofix.ignored'), 5000)
    // Coming back is cheap: the next successful save schedules a fresh check.
    if (overlay) autoLastAtRef.current = Date.now()
  }

  function runAutoBeautify(overlay, option) {
    const current = noteRef.current
    if (!current || !overlay) {
      autoBusyRef.current = false
      if (mountedRef.current) setAutoRunning(false)
      return
    }
    autoBusyRef.current = true
    if (mountedRef.current) setAutoRunning(true)
    showAutoStatus('info', t('notes.autofix.running', { count: overlay.sections.length }), 0)
    const liveSections = sectionizeMarkdown(localRef.current.content).map((section) => ({ id: section.id, hash: section.hash, heading: section.heading }))
    Promise.resolve(service.beautify({
      note: current,
      sections: overlay.sections,
      direction: option.direction,
      layout: option.layout,
      useFigures: option.useFigures === true,
      figureCandidates: overlay.figureCandidates,
      baseContentJson: contentJsonRef.current,
      liveSections,
      mode: 'auto',
      paperId: props.paperId || '',
      sessionId: props.sessionId,
      contextText: autoContextText(overlay.sections),
    }))
      .then((result) => {
        if (!mountedRef.current) return null
        // First automatic layout switches to the document view so the user sees
        // it; later incremental passes never yank the current editing view.
        const hadLayout = Boolean(contentJsonRef.current)
        return saveContentJson(result.contentJson, { switchView: !hadLayout }).then(() => {
          const at = Date.now()
          autoLastAtRef.current = at
          const id = autoNoteId()
          if (id) patchAutoFix(id, { lastBeautifiedAt: at, lastBeautifiedRevision: revisionRef.current })
          showAutoStatus('ok', t('notes.autofix.done', {
            count: Number(result.sentCount) || overlay.sections.length,
            styles: Array.isArray(result.styles) ? result.styles.length : 0,
            figures: Number(result.figureCount) || 0,
          }), 7000)
          return result
        })
      })
      .catch((error) => {
        if (!mountedRef.current) return
        const code = String((error && error.code) || '')
        let message
        if (code === 'invalid_json' || code === 'shape' || code === 'empty') message = t('notes.autofix.badAnswer')
        else if (code === 'unavailable') message = t('notes.autofix.unavailable')
        else if (code === 'conflict') message = t('notes.autofix.conflict')
        else message = t('notes.autofix.failed', { message: String((error && error.message) || error) })
        showAutoStatus('warn', message + ' ' + t('notes.autofix.contentSafe'), 9000)
        autoFailRef.current = String(localRef.current.content.length) + ':' + String((overlay && overlay.pendingChars) || 0) + ':' + (contentJsonRef.current ? '1' : '0')
        if (code === 'conflict') setConflict({ currentRevision: Number(error.currentRevision) || 0 })
      })
      .then(() => {
        autoBusyRef.current = false
        if (mountedRef.current) setAutoRunning(false)
      })
  }

  function toggleAuto() {
    const current = noteRef.current
    if (!current) return
    const next = !autoEnabledRef.current
    const saved = patchAutoFix(current.id, { enabled: next, direction: autoDirectionRef.current })
    autoEnabledRef.current = saved.enabled
    autoDirectionRef.current = saved.direction
    setAutoFix(saved)
    if (next) {
      if (!readFlag(AUTOFIX_INTRO_FLAG)) setAutoIntro(true)
      autoFailRef.current = ''
      showAutoStatus('ok', t('notes.autofix.enabled'), 5000)
      scheduleAutoCheck(1500)
    } else {
      clearIdeaTimers()
      setAutoOverlayState(null)
      autoBusyRef.current = false
      setAutoRunning(false)
      setAutoStatus(null)
    }
  }

  function changeAutoDirection(direction) {
    const current = noteRef.current
    if (!current) return
    const saved = patchAutoFix(current.id, { direction: direction })
    autoDirectionRef.current = saved.direction
    setAutoFix(saved)
  }

  function dismissAutoIntro() {
    writeFlag(AUTOFIX_INTRO_FLAG, true)
    setAutoIntro(false)
  }

  /* ------------------------------ rendering ------------------------------ */
  if (!note) {
    return React.createElement(
      'div',
      { className: 'ph-n-editor' },
      React.createElement(
        'div',
        { className: 'ph-n-main__empty' },
        React.createElement(EmptyState, { icon: 'note', title: t('notes.editor.emptyTitle'), desc: t('notes.editor.emptyDesc') }),
      ),
    )
  }

  const stateLabel = (() => {
    if (saveState.status === 'saving') return t('notes.saving')
    if (saveState.status === 'conflict') return t('notes.conflict.short')
    if (saveState.status === 'offline') return t('notes.offlineSave')
    if (saveState.status === 'error') return t('notes.saveFailed')
    if (saveState.at) return t('notes.savedAt', { time: formatClock(saveState.at) })
    return t('notes.saved')
  })()

  const saveStateClass = 'ph-n-savestate ph-n-savestate--' + (saveState.status || 'saved')
  const papers = Array.isArray(note.paperLinks) && note.paperLinks.length > 0 ? note.paperLinks : []
  const boundPaperId = props.paperId || note.paperIds[0] || ''
  const menuItems = [
    { id: 'history', icon: 'history', label: t('notes.history'), run: () => setHistoryOpen(true) },
    { id: 'export', icon: 'download', label: t('notes.export'), run: exportNote },
    contentJson ? { id: 'clearFormat', icon: 'restore', label: t('notes.clearFormat'), run: clearFormat, title: t('notes.clearFormatHint') } : null,
    { id: 'delete', icon: 'trash', label: t('notes.delete'), run: () => setDeleteOpen(true), danger: true, title: t('notes.deleteConfirm') },
  ]

  return React.createElement(
    'div',
    { className: 'ph-n-editor' + (compact ? ' ph-n-editor--compact' : '') },
    /* head ------------------------------------------------------------------ */
    React.createElement(
      'div',
      { className: 'ph-n-editor__head' },
      React.createElement(
        'div',
        { className: 'ph-n-editor__titlerow' },
        props.onOpenNoteLibrary && compact
          ? React.createElement(IconButton, { icon: 'external', title: t('notes.library.open'), onClick: () => props.onOpenNoteLibrary(note.id), className: 'ph-n-editor__back' })
          : null,
        React.createElement('input', {
          ref: titleRef,
          className: 'ph-n-editor__title',
          value: title,
          placeholder: t('notes.title.placeholder'),
          'aria-label': t('notes.title.placeholder'),
          onChange: (event) => applyLocal({ title: event.target.value }),
          onBlur: () => flush(),
          onKeyDown: (event) => {
            if (event.key === 'Enter') {
              event.preventDefault()
              if (textareaRef.current) textareaRef.current.focus()
            }
          },
        }),
        React.createElement(
          'div',
          { className: 'ph-n-editor__actions' },
          React.createElement('div', { className: 'ph-n-directivewrap' },
            React.createElement(Button, {
              size: 'sm',
              variant: 'ghost',
              icon: 'listOrdered',
              onClick: () => setDirectiveMenuOpen((value) => !value),
              loading: directiveRunning,
              title: t('notes.directive.title'),
            }, compact ? (directiveCount > 0 ? String(directiveCount) : '') : t('notes.directive.button') + (directiveCount > 0 ? ' ' + directiveCount : '')),
            directiveMenuOpen ? React.createElement(Menu, { items: directiveItems, onClose: () => setDirectiveMenuOpen(false) }) : null,
          ),
          React.createElement(Button, {
            size: 'sm',
            variant: 'soft',
            icon: 'sparkle',
            onClick: openBeautify,
            title: autoRunning ? t('notes.beautifyBusy') : t('notes.beautify'),
            disabled: sections.length === 0 || autoRunning,
          }, compact ? null : t('notes.beautify')),
          contentJson
            ? React.createElement(IconButton, {
                icon: viewMode === 'cards' ? 'book' : 'layers',
                title: viewMode === 'cards' ? t('notes.view.original') : t('notes.view.cards'),
                onClick: () => setViewMode(viewMode === 'cards' ? 'original' : 'cards'),
                active: viewMode === 'cards',
              })
            : null,
          React.createElement(IconButton, { icon: 'history', title: t('notes.history'), onClick: () => setHistoryOpen(true) }),
          React.createElement('div', { style: { position: 'relative' } },
            React.createElement(IconButton, { icon: 'more', title: t('notes.menu'), onClick: () => setMenuOpen((value) => !value), active: menuOpen }),
            menuOpen ? React.createElement(Menu, { items: menuItems, onClose: () => setMenuOpen(false) }) : null,
          ),
        ),
      ),
      /* meta row: folder + linked papers + save state ---------------------- */
      React.createElement(
        'div',
        { className: 'ph-n-editor__meta' },
        props.folders && props.folders.length > 0
          ? React.createElement(
              'select',
              {
                className: 'ph-select ph-select--sm',
                value: note.folderId || '',
                title: t('notes.folder.moveTo'),
                'aria-label': t('notes.folder.moveTo'),
                onChange: (event) => {
                  const value = event.target.value || null
                  if (props.onMoveFolder) props.onMoveFolder(value)
                },
              },
              React.createElement('option', { value: '' }, t('notes.folder.uncategorized')),
              props.folders.map((folder) => React.createElement('option', { key: folder.id, value: folder.id }, '\u3000'.repeat(folder.depth || 0) + folder.name)),
            )
          : null,
        papers.length > 0
          ? papers.map((link) =>
              React.createElement(
                'span',
                { key: link.paperId, className: 'ph-n-chip' },
                React.createElement(Icon, { name: 'book', size: 11 }),
                React.createElement('span', { className: 'ph-n-chip__label', title: link.titleZh || link.title || link.paperId }, link.titleZh || link.title || link.paperId),
                props.onOpenPaper
                  ? React.createElement(IconButton, { icon: 'external', title: t('notes.papers.open'), onClick: () => props.onOpenPaper(link.paperId), size: 12 })
                  : null,
              ),
            )
          : boundPaperId
            ? React.createElement(
                'span',
                { className: 'ph-n-chip ph-n-chip--folder', title: t('notes.papers.boundToCurrentHint') },
                React.createElement(Icon, { name: 'link', size: 11 }),
                React.createElement('span', { className: 'ph-n-chip__label' }, t('notes.papers.boundToCurrent')),
              )
            : React.createElement('span', { className: 'ph-n-caption' }, t('notes.papers.none')),
        props.linkable || props.linkable === undefined
          ? React.createElement(Button, { size: 'sm', variant: 'ghost', icon: 'link', onClick: () => setLinkOpen(true), title: t('notes.papers.add') }, compact ? null : t('notes.papers.add'))
          : null,
        React.createElement('span', { className: 'ph-n-editor__meta-spacer' }),
        React.createElement('span', { className: 'ph-n-caption' }, t('notes.wordCount', { count: content.length })),
        React.createElement(
          'span',
          { className: saveStateClass, title: saveState.message || stateLabel, role: 'status' },
          saveState.status === 'saving' ? React.createElement(Spinner) : React.createElement('span', { className: 'ph-n-savestate__dot' }),
          React.createElement('span', null, stateLabel),
          saveState.status === 'offline' || saveState.status === 'error'
            ? React.createElement('button', { type: 'button', className: 'ph-btn ph-btn--ghost ph-btn--sm ph-n-savestate__retry', onClick: () => { retryCountRef.current = 0; flush() } }, React.createElement('span', { className: 'ph-btn__label' }, t('notes.retrySave')))
            : null,
        ),
      ),
    ),
    /* auto-beautify controls (v2 边写边美化) -------------------------------- */
    React.createElement(
      'div',
      { className: 'ph-n-editor__toolbar' },
      React.createElement(
        'div',
        { className: 'ph-n-autofix' },
        React.createElement(
          'button',
          {
            type: 'button',
            className: 'ph-n-autofix__toggle' + (autoFix.enabled ? ' ph-n-autofix__toggle--on' : ''),
            onClick: toggleAuto,
            title: t('notes.autofix.toggleHint'),
            'aria-pressed': autoFix.enabled ? 'true' : 'false',
          },
          React.createElement('span', { className: 'ph-n-autofix__dot' + (autoRunning ? ' ph-n-autofix__dot--pulse' : '') }),
          t('notes.autofix.toggle'),
          autoFix.enabled
            ? React.createElement('span', { className: 'ph-n-autofix__state' }, autoRunning ? t('notes.autofix.stateRunning') : t('notes.autofix.stateOn'))
            : null,
        ),
        autoFix.enabled
          ? React.createElement(
              'select',
              {
                className: 'ph-n-autofix__select',
                value: autoFix.direction,
                title: t('notes.autofix.directionTitle'),
                'aria-label': t('notes.autofix.directionTitle'),
                onChange: (event) => changeAutoDirection(event.target.value),
              },
              [
                ['plain', 'notes.beautify.direction.plain'],
                ['vivid', 'notes.beautify.direction.vivid'],
                ['scientific', 'notes.beautify.direction.scientific'],
              ].map(([value, key]) => React.createElement('option', { key: value, value: value }, t(key))),
            )
          : null,
        autoStatus
          ? React.createElement(
              'span',
              {
                className: 'ph-n-autofix__status'
                  + (autoStatus.kind === 'warn' ? ' ph-n-autofix__status--warn' : autoStatus.kind === 'ok' ? ' ph-n-autofix__status--ok' : ''),
                title: autoStatus.text,
              },
              autoStatus.kind === 'info' && autoRunning ? React.createElement(Spinner) : null,
              autoStatus.text,
            )
          : null,
        autoOverlay
          ? React.createElement(
              'div',
              { className: 'ph-n-autofix__overlay', role: 'dialog', 'aria-label': t('notes.autofix.overlayTitle') },
              React.createElement(
                'div',
                { className: 'ph-n-autofix__overlay-head' },
                React.createElement(Icon, { name: 'sparkle', size: 13 }),
                t('notes.autofix.overlayTitle'),
              ),
              React.createElement(
                'div',
                { className: 'ph-n-autofix__overlay-sub' },
                t('notes.autofix.overlaySub', { count: autoOverlay.sections.length, chars: autoOverlay.pendingChars })
                  + (autoOverlay.degraded ? ' · ' + t('notes.autofix.degraded') : ''),
              ),
              autoOverlay.directions.map((option) =>
                React.createElement(
                  'button',
                  {
                    key: option.id,
                    type: 'button',
                    className: 'ph-n-autofix__option' + (option.id === autoOverlay.recommended ? ' ph-n-autofix__option--recommended' : ''),
                    onClick: () => adoptAutoDirection(option.id),
                    title: option.reason || '',
                  },
                  React.createElement(
                    'span',
                    { className: 'ph-n-autofix__option-main' },
                    React.createElement(
                      'span',
                      { className: 'ph-n-autofix__option-label' },
                      option.label,
                      option.id === autoOverlay.recommended
                        ? React.createElement('span', { className: 'ph-n-autofix__option-tag' }, t('notes.autofix.recommended'))
                        : null,
                      option.useFigures ? React.createElement(Icon, { name: 'figure', size: 10 }) : null,
                    ),
                    option.reason ? React.createElement('span', { className: 'ph-n-autofix__option-reason' }, option.reason) : null,
                  ),
                ),
              ),
              React.createElement(
                'div',
                { className: 'ph-n-autofix__overlay-foot' },
                React.createElement('span', { className: 'ph-n-caption' }, t('notes.autofix.autoAdopt')),
                React.createElement('span', { className: 'ph-n-spacer' }),
                React.createElement(
                  'button',
                  { type: 'button', className: 'ph-n-autofix__toggle', onClick: ignoreAuto },
                  t('notes.autofix.ignore'),
                ),
              ),
            )
          : null,
      ),
      React.createElement('span', { className: 'ph-n-toolbar__spacer' }),
      React.createElement('span', { className: 'ph-n-caption' }, autoFix.enabled ? t('notes.autofix.hint') : t('notes.autofix.offHint')),
    ),
    /* banners --------------------------------------------------------------- */
    React.createElement(
      'div',
      { className: 'ph-n-editor__bars' },
      autoIntro
        ? React.createElement(
            'div',
            { className: 'ph-n-autofix__intro', role: 'status' },
            React.createElement(Icon, { name: 'sparkle', size: 14 }),
            React.createElement('span', null, t('notes.autofix.intro')),
            React.createElement('span', { className: 'ph-n-spacer' }),
            React.createElement(
              'button',
              { type: 'button', className: 'ph-n-autofix__toggle', onClick: dismissAutoIntro },
              t('notes.autofix.introOk'),
            ),
          )
        : null,
      conflict
        ? React.createElement(
            'div',
            { className: 'ph-n-banner ph-n-banner--warn' },
            React.createElement(Icon, { name: 'warning', size: 14 }),
            React.createElement('span', null, t('notes.conflict.title', { revision: conflict.currentRevision || '?' })),
            React.createElement(
              'span',
              { className: 'ph-n-banner__actions' },
              React.createElement(Button, { size: 'sm', variant: 'secondary', onClick: reloadNote }, t('notes.conflict.reload')),
              React.createElement(Button, { size: 'sm', variant: 'danger', onClick: overwriteConflict }, t('notes.conflict.keep')),
            ),
          )
        : null,
      draftFound
        ? React.createElement(
            'div',
            { className: 'ph-n-banner' },
            React.createElement(Icon, { name: 'note', size: 14 }),
            React.createElement('span', null, t('notes.draftFound', { time: draftTimeLabel(draftFound.at) })),
            React.createElement(
              'span',
              { className: 'ph-n-banner__actions' },
              React.createElement(Button, {
                size: 'sm',
                variant: 'secondary',
                onClick: () => {
                  applyLocal({ title: draftFound.title, content: draftFound.content })
                  setDraftFound(null)
                },
              }, t('notes.draft.restore')),
              React.createElement(Button, {
                size: 'sm',
                variant: 'ghost',
                onClick: () => {
                  clearDraft(note.id)
                  setDraftFound(null)
                },
              }, t('notes.draft.discard')),
            ),
          )
        : null,
      saveState.status === 'error'
        ? React.createElement(
            'div',
            { className: 'ph-n-banner ph-n-banner--error' },
            React.createElement(Icon, { name: 'warning', size: 14 }),
            React.createElement('span', null, t('notes.saveFailedDetail', { message: saveState.message || t('common.unknownError') })),
            React.createElement(
              'span',
              { className: 'ph-n-banner__actions' },
              React.createElement(Button, { size: 'sm', variant: 'secondary', onClick: () => { retryCountRef.current = 0; flush() } }, t('notes.retrySave')),
            ),
          )
        : null,
    ),
    /* sections protection --------------------------------------------------- */
    sections.length > 0
      ? React.createElement(
          'div',
          { className: 'ph-n-sections' },
          React.createElement(
            'button',
            { type: 'button', className: 'ph-n-sections__head', onClick: () => setSectionsOpen((value) => !value), 'aria-expanded': sectionsOpen ? 'true' : 'false' },
            React.createElement(Icon, { name: sectionsOpen ? 'chevronDown' : 'chevronRight', size: 12 }),
            React.createElement('span', null, t('notes.sections.title')),
            React.createElement('span', { className: 'ph-n-sections__hint' }, t('notes.sections.count', { done: sections.length - incompleteCount, total: sections.length })),
            incompleteCount > 0 ? React.createElement(Badge, { tone: 'warn' }, t('notes.sections.incompleteCount', { count: incompleteCount })) : null,
          ),
          sectionsOpen
            ? React.createElement(
                'div',
                { className: 'ph-n-sections__list' },
                sections.map((section) => {
                  const incomplete = incompleteSet.has(section.id)
                  return React.createElement(
                    'div',
                    { key: section.id, className: 'ph-n-sections__row' },
                    React.createElement('span', { className: 'ph-n-sections__heading', title: section.text || '' }, section.heading || t('notes.section.untitled')),
                    React.createElement(
                      'button',
                      {
                        type: 'button',
                        className: 'ph-n-sections__toggle' + (incomplete ? ' ph-n-sections__toggle--incomplete' : ''),
                        onClick: () => toggleIncomplete(section.id),
                        title: t('notes.sections.toggleHint'),
                      },
                      incomplete ? t('notes.sections.incomplete') : t('notes.sections.complete'),
                    ),
                  )
                }),
                React.createElement('p', { className: 'ph-n-sections__hint' }, t('notes.sections.hint')),
              )
            : null,
        )
      : null,
    /* content --------------------------------------------------------------- */
    React.createElement(
      'div',
      { className: 'ph-n-editor__content' },
      viewMode === 'cards' && contentJson
        ? React.createElement(
            'div',
            { className: 'ph-n-editor__cards ph-n-scroll' },
            React.createElement(NoteCards, {
              t: t,
              rows: cardRows,
              incompleteIds: incompleteIds,
              onToggleIncomplete: toggleIncomplete,
              onOpenFigure: (paperId, page) => {
                if (props.onOpenPaper) props.onOpenPaper(paperId, page || 1)
              },
            }),
          )
        : React.createElement('textarea', {
            ref: textareaRef,
            className: 'ph-n-editor__textarea ph-n-scroll',
            value: content,
            placeholder: t('notes.content.placeholder'),
            'aria-label': t('notes.content.placeholder'),
            spellCheck: false,
            onChange: (event) => applyLocal({ content: event.target.value }),
            onBlur: () => flush(),
            onKeyDown: (event) => {
              // Tab inserts two spaces instead of leaving the editor.
              if (event.key === 'Tab' && !event.shiftKey) {
                event.preventDefault()
                const target = event.currentTarget
                const start = target.selectionStart
                const end = target.selectionEnd
                const next = content.slice(0, start) + '  ' + content.slice(end)
                applyLocal({ content: next })
                setTimeout(() => {
                  if (textareaRef.current) textareaRef.current.setSelectionRange(start + 2, start + 2)
                }, 0)
              }
              if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 's') {
                event.preventDefault()
                flush()
              }
            },
          }),
    ),
    /* dialogs --------------------------------------------------------------- */
    beautifyOpen
      ? React.createElement(BeautifyDialog, {
          t: t,
          service: service,
          note: Object.assign({}, note, { contentMd: content }),
          paperId: boundPaperId,
          baseContentJson: contentJson,
          liveSections: sections.map((section) => ({ id: section.id, hash: section.hash, heading: section.heading })),
          paperLinks: papers.length > 0 ? papers : note.paperIds.map((paperId) => ({ paperId: paperId })),
          mode: 'manual',
          sections: sections,
          incompleteIds: incompleteIds,
          beautifiedIds: beautifiedIds,
          selection: beautifySelection,
          aiStatus: aiStatus,
          sessionId: props.sessionId,
          persistCards: persistCards,
          onApplied: () => {
            setBeautifyOpen(false)
            if (props.notify) props.notify('success', t('notes.beautify.done'))
          },
          onClose: () => setBeautifyOpen(false),
        })
      : null,
    historyOpen
      ? React.createElement(RevisionsDialog, {
          t: t,
          service: service,
          noteId: note.id,
          currentRevision: revisionRef.current,
          onRestored: (fresh) => {
            if (fresh) {
              noteRef.current = fresh
              revisionRef.current = fresh.revision
              loadKeyRef.current = String(fresh.id) + ':' + String(fresh.revision) + ':' + String(fresh.updatedAt || '')
              localRef.current = { title: fresh.title, content: fresh.contentMd }
              setTitle(fresh.title)
              setContent(fresh.contentMd)
              setContentJson(fresh.contentJson || null)
              setViewMode(fresh.contentJson ? 'cards' : 'original')
              dirtyRef.current = false
              setSaveState({ status: 'saved', at: Date.now(), message: '' })
              setIncompleteIds(resolveIncompleteSections(fresh.id, sectionizeMarkdown(fresh.contentMd)))
              if (onSavedRef.current) onSavedRef.current(fresh)
            }
          },
          onClose: () => setHistoryOpen(false),
        })
      : null,
    deleteOpen
      ? React.createElement(
          Modal,
          {
            t: t,
            title: t('notes.delete'),
            desc: t('notes.deleteConfirm'),
            onClose: () => {
              if (!deleting) setDeleteOpen(false)
            },
            busy: deleting,
            footer: [
              React.createElement(
                'button',
                { key: 'cancel', type: 'button', className: 'ph-btn ph-btn--secondary ph-btn--md', onClick: () => setDeleteOpen(false), disabled: deleting },
                React.createElement('span', { className: 'ph-btn__label' }, t('common.cancel')),
              ),
              React.createElement('span', { key: 'spacer', className: 'ph-n-spacer' }),
              React.createElement(
                'button',
                { key: 'confirm', type: 'button', className: 'ph-btn ph-btn--danger ph-btn--md', onClick: deleteNote, disabled: deleting },
                React.createElement('span', { className: 'ph-btn__label' }, t('common.confirm')),
              ),
            ],
          },
        )
      : null,
    linkOpen
      ? React.createElement(PaperLinkDialog, {
          t: t,
          api: props.api,
          note: note,
          onLink: (ids) => Promise.resolve(props.onLinkPapers ? props.onLinkPapers(ids) : service.link(note.id, ids)).then((fresh) => { if (fresh) onSavedRef.current && onSavedRef.current(fresh) }),
          onUnlink: (ids) => Promise.resolve(props.onUnlinkPapers ? props.onUnlinkPapers(ids) : service.unlink(note.id, ids)).then((fresh) => { if (fresh) onSavedRef.current && onSavedRef.current(fresh) }),
          onClose: () => setLinkOpen(false),
        })
      : null,
  )
}
