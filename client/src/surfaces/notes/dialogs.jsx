/**
 * Notes dialogs (v0.17): the AI-beautify consent sheet, the revision history and
 * the paper linker. All three are plain in-tree overlays (no portal) so unmounting
 * the notes surface cleans them up, and all three degrade honestly when an
 * optional Host capability is missing.
 */
import React from 'react'
import { Icon } from '../../core/icons.jsx'
import { Badge, Button, EmptyState, IconButton, SearchInput, Spinner } from '../../core/primitives.jsx'
import { formatNoteTime, sectionsForSelection } from '../../core/notes-model.js'

/* -------------------------------------------------------------------------- */
/* Modal shell                                                                */
/* -------------------------------------------------------------------------- */

export function Modal(props) {
  const t = props.t
  React.useEffect(() => {
    if (typeof document === 'undefined') return undefined
    const onKey = (event) => {
      if (event.key === 'Escape' && !props.busy) {
        event.stopPropagation()
        props.onClose && props.onClose()
      }
    }
    document.addEventListener('keydown', onKey, true)
    return () => document.removeEventListener('keydown', onKey, true)
  }, [props.busy, props.onClose])
  return React.createElement(
    'div',
    { className: 'ph-n-modal-backdrop', onMouseDown: (event) => { if (event.target === event.currentTarget && !props.busy && props.onClose) props.onClose() } },
    React.createElement(
      'div',
      { className: 'ph-n-modal' + (props.wide ? ' ph-n-modal--wide' : ''), role: 'dialog', 'aria-modal': 'true', 'aria-label': props.title },
      React.createElement(
        'div',
        { className: 'ph-n-modal__head' },
        React.createElement(
          'div',
          { className: 'ph-n-modal__titles' },
          React.createElement('h2', { className: 'ph-n-modal__title' }, props.title),
          props.desc ? React.createElement('p', { className: 'ph-n-modal__desc' }, props.desc) : null,
        ),
        React.createElement(IconButton, { icon: 'close', title: t('common.close'), onClick: props.busy ? undefined : props.onClose, disabled: props.busy }),
      ),
      React.createElement('div', { className: 'ph-n-modal__body ph-n-scroll' }, props.children),
      React.createElement('div', { className: 'ph-n-modal__foot' }, props.footer),
    ),
  )
}

/* -------------------------------------------------------------------------- */
/* AI beautify consent + direction sheet                                      */
/* -------------------------------------------------------------------------- */

const DIRECTIONS = [
  { id: 'plain', title: 'notes.beautify.direction.plain', desc: 'notes.beautify.direction.plainDesc' },
  { id: 'vivid', title: 'notes.beautify.direction.vivid', desc: 'notes.beautify.direction.vividDesc' },
  { id: 'scientific', title: 'notes.beautify.direction.scientific', desc: 'notes.beautify.direction.scientificDesc' },
]
const LAYOUTS = [
  { id: 'auto', label: 'notes.beautify.layout.auto' },
  { id: 'bullets', label: 'notes.beautify.layout.bullets' },
  { id: 'table', label: 'notes.beautify.layout.table' },
]

/**
 * @param {object} props
 * @param {object} props.t
 * @param {object} props.service notes service
 * @param {object} props.note normalised note (needs paperIds/papers for the ai.ask context)
 * @param {string} props.paperId grounding paper (reader binding or first link)
 * @param {Array} props.sections every section of the current text
 * @param {Array<string>} props.incompleteIds sections the user marked unfinished
 * @param {object|null} props.selection `{start,end}` captured when the dialog opened
 * @param {Array<string>} props.beautifiedIds sections whose cards are currently valid
 * @param {object|null} props.aiStatus `ai.status` answer (null when unknown)
 * @param {object|null} [props.baseContentJson] previous v2 structure to merge into
 * @param {Array} [props.liveSections] current `{id,hash}` list for merge ordering
 * @param {Array} [props.paperLinks] linked papers (for real figure candidates)
 * @param {string} [props.mode] `manual` (kept for prompt wording)
 * @param {string} [props.sessionId]
 * @param {Function} props.onClose
 * @param {Function} props.onApplied `(contentJson, meta)` after notes.update succeeded upstream
 * @param {Function} props.persistCards async (contentJson) => saved note — provided by the editor
 */
export function BeautifyDialog(props) {
  const t = props.t
  const service = props.service
  const sections = Array.isArray(props.sections) ? props.sections : []
  const incomplete = new Set(Array.isArray(props.incompleteIds) ? props.incompleteIds : [])
  const beautified = new Set(Array.isArray(props.beautifiedIds) ? props.beautifiedIds : [])
  const completeSections = sections.filter((section) => !incomplete.has(section.id) && String(section.text || '').trim() !== '')
  const selectionSections = props.selection
    ? sectionsForSelection(completeSections, props.selection.start, props.selection.end)
    : []
  const scene = {
    all: completeSections,
    unbeautified: completeSections.filter((section) => !beautified.has(section.id)),
    selection: selectionSections,
  }
  const [scope, setScope] = React.useState(() => (scene.unbeautified.length > 0 ? 'unbeautified' : 'all'))
  const [direction, setDirection] = React.useState('scientific')
  const [layout, setLayout] = React.useState('auto')
  const [status, setStatus] = React.useState({ phase: 'idle', message: '', meta: null })
  const [ai, setAi] = React.useState(() => ({ loading: true, available: null, reason: '', model: '' }))
  const [figures, setFigures] = React.useState({ status: 'loading', candidates: [] })
  const [useFigures, setUseFigures] = React.useState(false)
  const busy = status.phase === 'running'

  // Real figure candidates from the linked papers (never invented by the model).
  React.useEffect(() => {
    let alive = true
    if (!service || typeof service.figureCandidates !== 'function') {
      setFigures({ status: 'ready', candidates: [] })
      return undefined
    }
    const links = Array.isArray(props.paperLinks) && props.paperLinks.length > 0
      ? props.paperLinks
      : (Array.isArray(props.note && props.note.paperIds) ? props.note.paperIds : []).map((paperId) => ({ paperId: paperId }))
    if (links.length === 0) {
      setFigures({ status: 'ready', candidates: [] })
      return undefined
    }
    Promise.resolve(service.figureCandidates(links, { limit: 12 }))
      .then((result) => {
        if (!alive) return
        setFigures({ status: 'ready', candidates: Array.isArray(result && result.candidates) ? result.candidates : [] })
      })
      .catch(() => {
        if (alive) setFigures({ status: 'error', candidates: [] })
      })
    return () => {
      alive = false
    }
  }, [props.note, props.paperLinks, service])

  React.useEffect(() => {
    let alive = true
    if (props.aiStatus) {
      setAi({
        loading: false,
        available: props.aiStatus.available !== false,
        reason: String((props.aiStatus && props.aiStatus.reason) || ''),
        model: String((props.aiStatus && props.aiStatus.model) || ''),
      })
      return undefined
    }
    Promise.resolve(service && typeof service.aiStatus === 'function' ? service.aiStatus() : null)
      .then((result) => {
        if (!alive) return
        setAi({
          loading: false,
          available: result ? result.available !== false : false,
          reason: String((result && result.reason) || ''),
          model: String((result && result.model) || ''),
        })
      })
      .catch(() => {
        if (alive) setAi({ loading: false, available: false, reason: '', model: '' })
      })
    return () => {
      alive = false
    }
  }, [props.aiStatus, service])

  const activeSections = scene[scope] || []
  const skippedIncomplete = completeSections.length === 0

  const start = () => {
    if (busy || activeSections.length === 0) return
    // The unfinished previous section travels as context only: the model must not
    // output it now, but it needs it to avoid a disjoint rewrite. Next round it is
    // included again once the user marks it finished.
    const firstSent = activeSections[0]
    const contextSection = sections
      .filter((section) => incomplete.has(section.id) && section.start < (firstSent ? firstSent.start : Number.MAX_SAFE_INTEGER))
      .slice(-1)[0]
    const contextText = contextSection ? String(contextSection.raw || contextSection.text || '').slice(0, 600) : ''
    setStatus({ phase: 'running', message: '', meta: null })
    Promise.resolve(service.beautify({
      note: props.note,
      sections: activeSections,
      direction,
      layout,
      paperId: props.paperId,
      contextText,
      sessionId: props.sessionId,
      baseContentJson: props.baseContentJson || null,
      liveSections: Array.isArray(props.liveSections) ? props.liveSections : [],
      figureCandidates: figures.candidates,
      useFigures: useFigures && figures.candidates.length > 0,
      mode: 'manual',
    }))
      .then((result) => props.persistCards(result.contentJson))
      .then(() => {
        setStatus({ phase: 'done', message: '', meta: null })
        props.onApplied && props.onApplied()
      })
      .catch((error) => {
        const code = String((error && error.code) || '')
        let message = ''
        if (code === 'no_paper') message = t('notes.beautify.noPaper')
        else if (code === 'invalid_json' || code === 'shape' || code === 'empty') message = t('notes.beautify.invalid')
        else if (code === 'unavailable') message = t('notes.beautify.unavailable', { reason: String((error && (error.reason || error.message)) || '') })
        else message = t('notes.beautify.failed', { message: String((error && error.message) || error) })
        setStatus({ phase: 'error', message, meta: null })
      })
  }

  const scopeItems = [
    { id: 'unbeautified', label: t('notes.beautify.scope.unbeautified'), count: scene.unbeautified.length },
    { id: 'all', label: t('notes.beautify.scope.all'), count: scene.all.length },
  ]
  if (props.selection) scopeItems.push({ id: 'selection', label: t('notes.beautify.scope.selection'), count: scene.selection.length })

  return React.createElement(
    Modal,
    {
      t: t,
      title: t('notes.beautify.consentTitle'),
      desc: t('notes.beautify.consent'),
      onClose: props.onClose,
      busy: busy,
      wide: true,
      footer: [
        React.createElement(
          'button',
          { key: 'cancel', type: 'button', className: 'ph-btn ph-btn--secondary ph-btn--md', onClick: props.onClose, disabled: busy },
          React.createElement('span', { className: 'ph-btn__label' }, t('common.cancel')),
        ),
        React.createElement('span', { key: 'spacer', className: 'ph-n-spacer' }),
        React.createElement(
          'button',
          {
            key: 'start',
            type: 'button',
            className: 'ph-btn ph-btn--primary ph-btn--md',
            onClick: start,
            disabled: busy || activeSections.length === 0 || ai.available === false,
            title: ai.available === false ? t('notes.beautify.aiUnavailable') : undefined,
          },
          busy ? React.createElement('span', { className: 'ph-spinner ph-spinner--inline', 'aria-hidden': 'true' }) : React.createElement(Icon, { name: 'sparkle', size: 14 }),
          React.createElement('span', { className: 'ph-btn__label' }, busy ? t('notes.beautify.running') : t('notes.beautify.start')),
        ),
      ],
    },
    ai.loading
      ? React.createElement('div', { className: 'ph-n-progress' }, React.createElement(Spinner), React.createElement('span', null, t('notes.beautify.checkingAi')))
      : ai.available === false
        ? React.createElement(
            'div',
            { className: 'ph-n-error' },
            React.createElement(Icon, { name: 'warning', size: 14 }),
            React.createElement('span', null, t('notes.beautify.unavailable', { reason: ai.reason || t('common.unavailable') })),
          )
        : null,
    React.createElement(
      'div',
      { className: 'ph-n-field' },
      React.createElement('div', { className: 'ph-n-field__label' }, t('notes.beautify.direction')),
      React.createElement(
        'div',
        { className: 'ph-n-choices' },
        DIRECTIONS.map((item) =>
          React.createElement(
            'button',
            {
              key: item.id,
              type: 'button',
              className: 'ph-n-choice' + (direction === item.id ? ' ph-n-choice--active' : ''),
              onClick: () => setDirection(item.id),
              'aria-pressed': direction === item.id ? 'true' : 'false',
              disabled: busy,
            },
            React.createElement('span', { className: 'ph-n-choice__title' }, t(item.title)),
            React.createElement('span', { className: 'ph-n-choice__desc' }, t(item.desc)),
          ),
        ),
      ),
      React.createElement('div', { className: 'ph-n-field__hint' }, t('notes.beautify.directionHint')),
    ),
    React.createElement(
      'div',
      { className: 'ph-n-field' },
      React.createElement('div', { className: 'ph-n-field__label' }, t('notes.beautify.layout')),
      React.createElement(
        'div',
        { className: 'ph-n-radio-row' },
        LAYOUTS.map((item) =>
          React.createElement(
            'label',
            { key: item.id, className: 'ph-n-radio', onClick: () => setLayout(item.id) },
            React.createElement('input', { type: 'radio', checked: layout === item.id, onChange: () => setLayout(item.id), disabled: busy, name: 'ph-n-layout' }),
            React.createElement('span', null, t(item.label)),
          ),
        ),
      ),
    ),
    React.createElement(
      'div',
      { className: 'ph-n-field' },
      React.createElement('div', { className: 'ph-n-field__label' }, t('notes.beautify.scope')),
      React.createElement(
        'div',
        { className: 'ph-n-radio-row' },
        scopeItems.map((item) =>
          React.createElement(
            'label',
            { key: item.id, className: 'ph-n-radio', onClick: () => setScope(item.id) },
            React.createElement('input', {
              type: 'radio',
              checked: scope === item.id,
              onChange: () => setScope(item.id),
              disabled: busy || item.count === 0,
              name: 'ph-n-scope',
            }),
            React.createElement('span', null, item.label + ' (' + item.count + ')'),
          ),
        ),
      ),
    ),
    React.createElement(
      'div',
      { className: 'ph-n-field' },
      React.createElement('div', { className: 'ph-n-field__label' }, t('notes.beautify.figures')),
      figures.status === 'loading'
        ? React.createElement('div', { className: 'ph-n-progress' }, React.createElement(Spinner), React.createElement('span', null, t('notes.beautify.figuresLoading')))
        : figures.candidates.length > 0
          ? React.createElement(
              'div',
              { className: 'ph-n-radio-row' },
              React.createElement(
                'label',
                { className: 'ph-n-radio', onClick: () => setUseFigures((value) => !value) },
                React.createElement('input', {
                  type: 'checkbox',
                  checked: useFigures,
                  onChange: () => setUseFigures((value) => !value),
                  disabled: busy,
                }),
                React.createElement('span', null, t('notes.beautify.useFigures', { count: figures.candidates.length })),
              ),
            )
          : React.createElement('div', { className: 'ph-n-field__hint' }, t('notes.beautify.noFigures')),
      React.createElement('div', { className: 'ph-n-field__hint' }, t('notes.beautify.figuresHint')),
    ),
    React.createElement(
      'div',
      { className: 'ph-n-summary' },
      React.createElement(Icon, { name: 'info', size: 14, className: 'ph-n-summary__icon' }),
      React.createElement(
        'div',
        null,
        t('notes.beautify.sections', { count: activeSections.length }),
        incomplete.size > 0 ? ' · ' + t('notes.beautify.skipped', { sections: incomplete.size }) : '',
        skippedIncomplete ? ' · ' + t('notes.beautify.noComplete') : '',
      ),
    ),
    status.phase === 'running'
      ? React.createElement('div', { className: 'ph-n-progress' }, React.createElement(Spinner), React.createElement('span', null, t('notes.beautify.running')))
      : null,
    status.phase === 'error' ? React.createElement('div', { className: 'ph-n-error' }, React.createElement(Icon, { name: 'warning', size: 14 }), React.createElement('span', null, status.message)) : null,
  )
}

/* -------------------------------------------------------------------------- */
/* Revision history                                                           */
/* -------------------------------------------------------------------------- */

export function RevisionsDialog(props) {
  const t = props.t
  const service = props.service
  const [state, setState] = React.useState({ status: 'loading', items: [], error: '' })
  const [confirming, setConfirming] = React.useState(0)
  const [busy, setBusy] = React.useState(false)

  const load = React.useCallback(() => {
    setState({ status: 'loading', items: [], error: '' })
    Promise.resolve(service.revisions(props.noteId))
      .then((items) => setState({ status: 'ready', items: Array.isArray(items) ? items : [], error: '' }))
      .catch((error) => setState({ status: 'error', items: [], error: String((error && error.message) || error) }))
  }, [props.noteId, service])

  React.useEffect(() => {
    load()
  }, [load])

  const restore = (revision) => {
    if (busy) return
    setBusy(true)
    Promise.resolve(service.restoreRevision(props.noteId, revision))
      .then((note) => {
        props.onRestored && props.onRestored(note)
        props.onClose && props.onClose()
      })
      .catch((error) => {
        setBusy(false)
        setConfirming(0)
        setState((previous) => Object.assign({}, previous, { status: previous.items.length > 0 ? 'ready' : 'error', error: String((error && error.message) || error) }))
      })
  }

  const reasonLabel = (reason) => {
    const key = 'notes.history.reason.' + String(reason || 'update')
    const translated = t(key)
    return translated === key ? t('notes.history.reason.update') : translated
  }

  return React.createElement(
    Modal,
    {
      t: t,
      title: t('notes.history'),
      desc: t('notes.history.desc', { count: state.items.length }),
      onClose: props.onClose,
      busy: busy,
      footer: [
        React.createElement('span', { key: 'spacer', className: 'ph-n-spacer' }),
        React.createElement(
          'button',
          { key: 'close', type: 'button', className: 'ph-btn ph-btn--secondary ph-btn--md', onClick: props.onClose, disabled: busy },
          React.createElement('span', { className: 'ph-btn__label' }, t('common.close')),
        ),
      ],
    },
    state.status === 'loading'
      ? React.createElement('div', { className: 'ph-n-progress' }, React.createElement(Spinner), React.createElement('span', null, t('notes.history.loading')))
      : null,
    state.status === 'error'
      ? React.createElement(
          'div',
          { className: 'ph-n-error' },
          React.createElement(Icon, { name: 'warning', size: 14 }),
          React.createElement('span', null, state.error || t('common.unavailable')),
          React.createElement(
            'button',
            { type: 'button', className: 'ph-btn ph-btn--secondary ph-btn--sm', onClick: load },
            React.createElement('span', { className: 'ph-btn__label' }, t('common.retry')),
          ),
        )
      : null,
    state.status === 'ready' && state.items.length === 0
      ? React.createElement(EmptyState, { compact: true, icon: 'history', title: t('notes.history.empty') })
      : null,
    state.items.length > 0
      ? React.createElement(
          'div',
          { className: 'ph-n-revlist' },
          state.items.map((item, index) =>
            React.createElement(
              'div',
              { key: String(item.revision) + '-' + index, className: 'ph-n-revrow' + (item.revision === props.currentRevision ? ' ph-n-revrow--current' : '') },
              React.createElement(
                'div',
                { className: 'ph-n-revrow__main' },
                React.createElement(
                  'span',
                  { className: 'ph-n-revrow__label' },
                  'r' + item.revision + ' · ' + reasonLabel(item.reason) + (item.revision === props.currentRevision ? ' · ' + t('notes.history.current') : ''),
                ),
                React.createElement(
                  'span',
                  { className: 'ph-n-revrow__meta' },
                  formatNoteTime(item.createdAt) + ' · ' + t('notes.history.length', { count: item.contentMdLength || 0 }) + (item.hasContentJson ? ' · ' + t('notes.cards.beautified') : ''),
                ),
              ),
              React.createElement(
                'button',
                {
                  type: 'button',
                  className: 'ph-btn ph-btn--' + (confirming === item.revision ? 'danger' : 'secondary') + ' ph-btn--sm',
                  onClick: () => (confirming === item.revision ? restore(item.revision) : setConfirming(item.revision)),
                  disabled: busy || item.revision === props.currentRevision,
                  title: t('notes.history.restore'),
                },
                React.createElement('span', { className: 'ph-btn__label' }, confirming === item.revision ? t('notes.history.restoreConfirm') : t('notes.history.restore')),
              ),
            ),
          ),
        )
      : null,
    React.createElement('p', { className: 'ph-n-field__hint' }, t('notes.history.restoreHint')),
  )
}

/* -------------------------------------------------------------------------- */
/* Link papers (0..N)                                                         */
/* -------------------------------------------------------------------------- */

export function PaperLinkDialog(props) {
  const t = props.t
  const api = props.api
  const initial = Array.isArray(props.note && props.note.paperIds) ? props.note.paperIds : []
  const [selected, setSelected] = React.useState(() => new Set(initial))
  const [query, setQuery] = React.useState('')
  const [state, setState] = React.useState({ status: 'idle', items: [], error: '' })
  const [folders, setFolders] = React.useState([])
  const [folderId, setFolderId] = React.useState('')
  const [annotatedOnly, setAnnotatedOnly] = React.useState(false)
  const [linkFilter, setLinkFilter] = React.useState('all')
  const [busy, setBusy] = React.useState(false)
  const debounced = React.useRef('')

  React.useEffect(() => {
    let alive = true
    Promise.resolve(api('library.folders.tree', {}))
      .then((result) => {
        if (!alive) return
        const root = result && (result.items || result.folders)
        const list = Array.isArray(root) ? root : []
        const flat = []
        const walk = (nodes, depth) => {
          for (const node of nodes || []) {
            flat.push({ id: node.id, name: node.name, depth })
            walk(node.children, (depth || 0) + 1)
          }
        }
        walk(list, 0)
        setFolders(flat)
      })
      .catch(() => { if (alive) setFolders([]) })
    return () => { alive = false }
  }, [api])

  React.useEffect(() => {
    const timer = setTimeout(() => {
      debounced.current = query
      setState((previous) => Object.assign({}, previous, { status: 'loading' }))
      // Defensive: an inline/misused editor may not receive the Host `api`.
      // Surface that clearly instead of leaving the dialog on "加载中…" forever.
      if (typeof api !== 'function') {
        setState({ status: 'error', items: [], error: 'paper link dialog is missing the Host api' })
        return
      }
      let request
      try {
        request = Promise.resolve(api('library.list', { query: query.trim(), limit: 100, ...(folderId ? { folderId: folderId } : {}) }))
      } catch (error) {
        setState({ status: 'error', items: [], error: String((error && error.message) || error) })
        return
      }
      request
        .then((result) => {
          let items = Array.isArray(result && result.items) ? result.items : Array.isArray(result) ? result : []
          if (annotatedOnly) items = items.filter((paper) => Number(paper.annotationCount) > 0)
          setState({ status: 'ready', items: items.slice(0, 60), error: '' })
        })
        .catch((error) => setState({ status: 'error', items: [], error: String((error && error.message) || error) }))
    }, 240)
    return () => clearTimeout(timer)
  }, [api, query, folderId, annotatedOnly])

  const toggle = (paperId) => {
    setSelected((previous) => {
      const next = new Set(previous)
      if (next.has(paperId)) next.delete(paperId)
      else next.add(paperId)
      return next
    })
  }

  const save = () => {
    if (busy) return
    const before = new Set(initial)
    const added = [...selected].filter((id) => !before.has(id))
    const removed = [...before].filter((id) => !selected.has(id))
    setBusy(true)
    let chain = Promise.resolve(null)
    if (added.length > 0) chain = chain.then(() => props.onLink(added))
    if (removed.length > 0) chain = chain.then(() => props.onUnlink(removed))
    chain
      .then(() => props.onClose && props.onClose())
      .catch(() => setBusy(false))
  }

  const titleOf = (paper) => (paper && (paper.titleZh || paper.displayTitle || paper.title)) || t('common.untitled')
  const visibleItems = state.items.filter((paper) => {
    if (linkFilter === 'linked') return selected.has(paper.id)
    if (linkFilter === 'unlinked') return !selected.has(paper.id)
    return true
  })

  return React.createElement(
    Modal,
    {
      t: t,
      title: t('notes.papers.dialogTitle'),
      desc: t('notes.papers.dialogDesc'),
      onClose: props.onClose,
      busy: busy,
      footer: [
        React.createElement(
          'button',
          { key: 'cancel', type: 'button', className: 'ph-btn ph-btn--secondary ph-btn--md', onClick: props.onClose, disabled: busy },
          React.createElement('span', { className: 'ph-btn__label' }, t('common.cancel')),
        ),
        React.createElement('span', { key: 'spacer', className: 'ph-n-spacer' }),
        React.createElement(
          'button',
          { key: 'save', type: 'button', className: 'ph-btn ph-btn--primary ph-btn--md', onClick: save, disabled: busy },
          busy ? React.createElement('span', { className: 'ph-spinner ph-spinner--inline', 'aria-hidden': 'true' }) : null,
          React.createElement('span', { className: 'ph-btn__label' }, t('notes.papers.save')),
        ),
      ],
    },
    React.createElement(SearchInput, { value: query, onChange: setQuery, placeholder: t('notes.papers.search'), clearLabel: t('common.clear') }),
    React.createElement(
      'div',
      { className: 'ph-n-paperpick__filters' },
      React.createElement(
        'select',
        { className: 'ph-select ph-select--inline', value: folderId, 'aria-label': t('folders.pick'), onChange: (event) => setFolderId(event.target.value) },
        React.createElement('option', { value: '' }, t('folders.all')),
        folders.map((folder) => React.createElement('option', { key: folder.id, value: folder.id }, '　'.repeat(folder.depth || 0) + folder.name)),
      ),
      React.createElement(
        'label',
        { className: 'ph-n-paperpick__annot' },
        React.createElement('input', { type: 'checkbox', checked: annotatedOnly, onChange: (event) => setAnnotatedOnly(event.target.checked) }),
        t('notes.papers.annotatedOnly'),
      ),
      React.createElement(
        'select',
        { className: 'ph-select ph-select--inline', value: linkFilter, 'aria-label': t('notes.papers.filterLabel'), onChange: (event) => setLinkFilter(event.target.value) },
        React.createElement('option', { value: 'all' }, t('notes.papers.filter.all')),
        React.createElement('option', { value: 'linked' }, t('notes.papers.filter.linked')),
        React.createElement('option', { value: 'unlinked' }, t('notes.papers.filter.unlinked')),
      ),
    ),
    React.createElement(
      'div',
      { className: 'ph-n-paperpick' },
      state.status === 'loading'
        ? React.createElement('div', { className: 'ph-n-progress' }, React.createElement(Spinner), React.createElement('span', null, t('common.loading')))
        : null,
      state.status === 'error'
        ? React.createElement('div', { className: 'ph-n-error' }, React.createElement(Icon, { name: 'warning', size: 14 }), React.createElement('span', null, state.error))
        : null,
      state.status === 'ready' && visibleItems.length === 0
        ? React.createElement(EmptyState, { compact: true, icon: 'search', title: t('notes.papers.noMatch') })
        : null,
      React.createElement(
        'div',
        { className: 'ph-n-paperpick__list' },
        visibleItems.map((paper) =>
          React.createElement(
            'label',
            { key: paper.id, className: 'ph-n-paperpick__row' },
            React.createElement('input', { type: 'checkbox', checked: selected.has(paper.id), onChange: () => toggle(paper.id) }),
            React.createElement('span', { className: 'ph-n-paperpick__title', title: titleOf(paper) }, titleOf(paper)),
            paper.year ? React.createElement('span', { className: 'ph-n-caption' }, String(paper.year)) : null,
            Number(paper.annotationCount) > 0 ? React.createElement('span', { className: 'ph-n-caption' }, '批注 ' + paper.annotationCount) : null,
          ),
        ),
      ),
    ),
    selected.size > 0
      ? React.createElement('div', { className: 'ph-n-summary' }, React.createElement(Icon, { name: 'link', size: 14, className: 'ph-n-summary__icon' }), React.createElement('span', null, t('notes.papers.selected', { count: selected.size })))
      : React.createElement('div', { className: 'ph-n-summary' }, React.createElement(Icon, { name: 'info', size: 14, className: 'ph-n-summary__icon' }), React.createElement('span', null, t('notes.papers.none'))),
  )
}
