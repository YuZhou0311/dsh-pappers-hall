/**
 * Collapsible 「论文面板」 of the standalone notes library (v0.17).
 *
 * Lets the user read a paper while writing notes without leaving the notes
 * workspace: search the library, open one paper, page through the rendered PDF
 * page, read the page text, request a free/AI page translation, inspect the page
 * annotations, and link the open paper to the current note (or filter the note
 * list to it). "在阅读器中打开" hands over to the full reader through the shared
 * navigation store.
 */
import React from 'react'
import { Icon } from '../../core/icons.jsx'
import { Button, EmptyState, IconButton, SearchInput, Spinner } from '../../core/primitives.jsx'
import { PageTextLayer, selectableWords } from '../reader/text-layer.jsx'
import { ReaderShell } from '../reader/shell.jsx'
import { readPageSelection } from '../reader/shared.jsx'

/** Page image URL for the panel-width raster. */
function pageImageUrl(paperId, page, width) {
  return '/pappers-hall/page/' + encodeURIComponent(String(paperId)) + '/' + String(page) + '.png?width=' + String(width || 900)
}

/** First non-empty string. */
function text() {
  for (let index = 0; index < arguments.length; index += 1) {
    const value = arguments[index]
    if (typeof value === 'string' && value.trim() !== '') return value
  }
  return ''
}

/** Paper display title. */
function paperTitle(t, paper) {
  return text(paper && paper.titleZh, paper && paper.displayTitle, paper && paper.title) || t('common.untitled')
}

const ANNOTATION_COLORS = {
  yellow: 'var(--dsw-alias-state-warn-primary, #d9a400)',
  green: 'var(--dsw-alias-state-success-primary, #16a34a)',
  blue: 'var(--dsw-alias-state-business-primary, #3d7bfd)',
  red: 'var(--dsw-alias-state-error-primary, #dc2626)',
  purple: '#9b59b6',
}

/**
 * @param {object} props
 * @param {object} props.t
 * @param {Function} props.api
 * @param {string|null} [props.noteId] current note (for link buttons)
 * @param {Array<string>} [props.linkedPaperIds] papers already linked to that note
 * @param {string|null} [props.filterPaperId] paper currently filtering the note list
 * @param {Function} [props.onOpenPaper] `(paperId, page, annotationId)` open the full reader
 * @param {Function} [props.onFilterByPaper] `(paper)` filter the notes list by this paper
 * @param {Function} [props.onLinkPaper] `(paper)` link the open paper to the current note
 * @param {Function} [props.onCreateNote] `(paper)` create a note for this paper
 * @param {Function} [props.onClose]
 */
export function PaperPanel(props) {
  const t = props.t
  const api = props.api
  const [query, setQuery] = React.useState('')
  const [folders, setFolders] = React.useState([])
  const [folderId, setFolderId] = React.useState('')
  const [annotatedOnly, setAnnotatedOnly] = React.useState(false)
  const [readFilter, setReadFilter] = React.useState('')
  const [results, setResults] = React.useState({ status: 'idle', items: [], error: '' })
  const [open, setOpen] = React.useState(null) // {id, paper, total, page}
  const [page, setPage] = React.useState(1)
  const [pageState, setPageState] = React.useState({ status: 'idle', text: '', source: '', error: '' })
  const [translation, setTranslation] = React.useState({ status: 'idle', blocks: [], reason: '' })
  const [annotations, setAnnotations] = React.useState({ status: 'idle', items: [], error: '' })
  const [busy, setBusy] = React.useState('')
  const [linkedPaperIds, setLinkedPaperIds] = React.useState(() => Array.isArray(props.linkedPaperIds) ? props.linkedPaperIds : [])
  const [selection, setSelection] = React.useState(null)
  const [region, setRegion] = React.useState({ status: 'idle', text: '', translation: '', reason: '' })
  const [ai, setAi] = React.useState({ status: 'idle', answer: '', reason: '' })
  const dragRef = React.useRef(null)
  const imageWrapRef = React.useRef(null)
  const [layer, setLayer] = React.useState(null)
  const [renderWidth, setRenderWidth] = React.useState(0)

  const restoredRef = React.useRef(false)
  React.useEffect(() => {
    if (!props.noteId || restoredRef.current) return undefined
    restoredRef.current = true
    let saved = null
    try { saved = JSON.parse(sessionStorage.getItem('pappers-hall:notes-open-paper') || 'null') } catch { saved = null }
    if (!saved || !saved.paperId) return undefined
    let alive = true
    Promise.resolve(api('reader.open', { id: saved.paperId }))
      .then((data) => {
        if (!alive) return
        const paper = (data && data.paper) || { id: saved.paperId }
        const total = Number(data && data.version && data.version.pageCount) || Number(data && data.paper && data.paper.pageCount) || 1
        setOpen({ id: saved.paperId, paper, total, page: Number(saved.page) || 1 })
        setPage(Number(saved.page) || 1)
      })
      .catch(() => {})
    return () => { alive = false }
  }, [props.noteId, api])
  React.useEffect(() => {
    try {
      if (open) sessionStorage.setItem('pappers-hall:notes-open-paper', JSON.stringify({ paperId: open.id, page: page }))
      else sessionStorage.removeItem('pappers-hall:notes-open-paper')
    } catch {
      /* storage unavailable */
    }
  }, [open, page])

  React.useEffect(() => {
    let alive = true
    Promise.resolve(api('library.folders.tree', {}))
      .then((result) => {
        if (!alive) return
        const root = result && (result.items || result.folders)
        const flat = []
        const walk = (nodes, depth) => {
          for (const node of nodes || []) {
            flat.push({ id: node.id, name: node.name, depth })
            walk(node.children, (depth || 0) + 1)
          }
        }
        walk(Array.isArray(root) ? root : [], 0)
        setFolders(flat)
      })
      .catch(() => { if (alive) setFolders([]) })
    return () => { alive = false }
  }, [api])

  /* ------------------------------ search --------------------------------- */
  React.useEffect(() => {
    const timer = setTimeout(() => {
      setResults((previous) => Object.assign({}, previous, { status: 'loading', error: '' }))
      Promise.resolve(api('library.list', { query: query.trim(), limit: 100, ...(folderId ? { folderId: folderId } : {}) }))
        .then((result) => {
          let items = Array.isArray(result && result.items) ? result.items : Array.isArray(result) ? result : []
          if (annotatedOnly) items = items.filter((paper) => Number(paper.annotationCount) > 0)
          if (readFilter === 'read') items = items.filter((paper) => paper.read === true)
          if (readFilter === 'unread') items = items.filter((paper) => paper.read !== true)
          setResults({ status: 'ready', items: items.slice(0, 60), error: '' })
        })
        .catch((error) => setResults({ status: 'error', items: [], error: String((error && error.message) || error) }))
    }, 260)
    return () => clearTimeout(timer)
  }, [api, query, folderId, annotatedOnly, readFilter])

  /* ------------------------------ open paper ------------------------------ */
  const openPaper = (paper) => {
    if (!paper || !paper.id) return
    setOpen({ id: paper.id, paper: paper, total: Number(paper.pageCount || paper.page_count || paper.pages) || 1, page: 1 })
    setPage(1)
    setTranslation({ status: 'idle', blocks: [], reason: '' })
  }

  React.useEffect(() => {
    if (!open) return undefined
    let alive = true
    setPageState({ status: 'loading', text: '', source: '', error: '' })
    setAnnotations({ status: 'loading', items: [], error: '' })
    Promise.resolve(api('reader.pageText', { id: open.id, page: page }))
      .then((result) => {
        if (!alive) return
        setPageState({ status: 'ready', text: String((result && result.text) || ''), source: String((result && result.source) || ''), error: '' })
      })
      .catch((error) => {
        if (!alive) return
        setPageState({ status: 'error', text: '', source: '', error: String((error && error.message) || error) })
      })
    Promise.resolve(api('annotations.list', { paperId: open.id, page: page }))
      .then((result) => {
        if (!alive) return
        setAnnotations({ status: 'ready', items: Array.isArray(result) ? result : Array.isArray(result && result.items) ? result.items : [], error: '' })
      })
      .catch((error) => {
        if (!alive) return
        setAnnotations({ status: 'error', items: [], error: String((error && error.message) || error) })
      })
    setTranslation({ status: 'idle', blocks: [], reason: '' })
    setSelection(null)
    setRegion({ status: 'idle', text: '', translation: '', reason: '' })
    setAi({ status: 'idle', answer: '', reason: '' })
    return () => {
      alive = false
    }
  }, [api, open, page])

  React.useEffect(() => {
    if (!open) return undefined
    let alive = true
    setLayer(null)
    Promise.resolve(api('reader.layer', { id: open.id, page: page }))
      .then((value) => { if (alive) setLayer(value || null) })
      .catch(() => { if (alive) setLayer(null) })
    return () => { alive = false }
  }, [api, open, page])

  React.useEffect(() => {
    const element = imageWrapRef.current
    if (!element || typeof ResizeObserver === 'undefined') return undefined
    const observer = new ResizeObserver((entries) => {
      const width = entries && entries[0] && entries[0].contentRect ? entries[0].contentRect.width : element.clientWidth
      if (width > 0) setRenderWidth(width)
    })
    observer.observe(element)
    return () => observer.disconnect()
  }, [open, page, layer])

  const translatePage = () => {
    if (!open || busy) return
    setBusy('translate')
    setTranslation({ status: 'translating', blocks: [], reason: '' })
    Promise.resolve(api('translate.blocks', { paperId: open.id, page: page, provider: 'auto' }))
      .then((result) => {
        const blocks = Array.isArray(result && result.blocks) ? result.blocks : []
        setTranslation({ status: String((result && result.status) || 'ready'), blocks: blocks, reason: String((result && result.reason) || '') })
      })
      .catch((error) => setTranslation({ status: 'error', blocks: [], reason: String((error && error.message) || error) }))
      .then(() => setBusy(''))
  }

  const goPage = (next) => {
    if (!open) return
    const target = Math.max(1, Math.min(open.total || 1, next))
    if (target !== page) setPage(target)
  }

  const selectable = React.useMemo(() => selectableWords(layer), [layer])
  const pageHeight = layer && layer.width > 0 && renderWidth > 0 ? renderWidth * (layer.height / layer.width) : 0

  const onPageMouseUp = () => {
    if (!open || !layer) return
    const pageElement = imageWrapRef.current
    if (!pageElement) return
    const picked = readPageSelection(pageElement, selectable)
    if (!picked || !picked.quote) return
    setRegion({ status: 'loading', text: picked.quote, translation: '', reason: '' })
    Promise.resolve(api('translate.text', { paperId: open.id, page: page, text: picked.quote, provider: 'auto', fast: true }))
      .then((result) => {
        const translated = result && (result.translation || result.translatedText || result.text || '')
        if (translated) {
          setRegion({ status: 'ready', text: picked.quote, translation: String(translated), reason: '' })
          return
        }
        // Reader-equivalent fallback: ask the model for the selection.
        return Promise.resolve(api('ai.complete', { prompt: '把下面论文选区翻译成简体中文，只输出译文：\n\n' + picked.quote, fast: false, maxTokens: 1200, kind: 'translate-region' }))
          .then((ai) => {
            const answer = ai && ai.status === 'ok' ? String(ai.answer || '') : ''
            setRegion({ status: answer ? 'ready' : 'error', text: picked.quote, translation: answer, reason: answer ? '' : String((ai && ai.reason) || '翻译不可用') })
          })
      })
      .catch((error) => setRegion({ status: 'error', text: picked.quote, translation: '', reason: String((error && error.message) || error) }))
  }

  const askAiPage = () => {
    if (!open || busy === 'ai') return
    setBusy('ai')
    setAi({ status: 'loading', answer: '', reason: '' })
    Promise.resolve(api('ai.ask', { paperId: open.id, page: page, prompt: '用要点总结这一页：研究问题、方法、关键结果、局限。不要编造。', mode: 'deep' }))
      .then((result) => {
        if (!result || result.status !== 'ok') {
          setAi({ status: 'error', answer: '', reason: String((result && result.reason) || 'AI 不可用') })
          return
        }
        setAi({ status: 'ready', answer: String(result.answer || ''), reason: '' })
      })
      .catch((error) => setAi({ status: 'error', answer: '', reason: String((error && error.message) || error) }))
      .then(() => setBusy(''))
  }

  React.useEffect(() => {
    if (!props.noteId) {
      setLinkedPaperIds([])
      return undefined
    }
    let alive = true
    Promise.resolve(api('notes.get', { id: props.noteId }))
      .then((data) => {
        const note = data && (data.note || data)
        if (alive && note && Array.isArray(note.paperIds)) setLinkedPaperIds(note.paperIds)
      })
      .catch(() => {})
    return () => { alive = false }
  }, [props.noteId, api])

  const linkOpenPaper = () => {
    if (!props.noteId || !open || busy === 'link') return
    setBusy('link')
    Promise.resolve(api('notes.link', { noteId: props.noteId, paperIds: [open.id] }))
      .then((data) => {
        const note = data && (data.note || data)
        if (note && Array.isArray(note.paperIds)) setLinkedPaperIds(note.paperIds)
        else setLinkedPaperIds((previous) => previous.indexOf(open.id) >= 0 ? previous : previous.concat([open.id]))
        try {
          window.dispatchEvent(new CustomEvent('pappers-hall:note-linked', { detail: { noteId: props.noteId, paperId: open.id } }))
        } catch { /* event is best effort */ }
      })
      .catch(() => {})
      .then(() => setBusy(''))
  }

  if (open) {
    // Reuse the real reader surface: continuous page canvas, native text
    // selection, quick-translation card, annotation popup and floating tools.
    // Only the reader chrome is hidden so it fits the side panel exactly.
    return React.createElement(
      'div',
      { className: 'ph-n-embedded-reader' },
      React.createElement(
        'div',
        { className: 'ph-n-embedded-reader__bar' },
        React.createElement(IconButton, { icon: 'chevronLeft', title: t('notes.papers.backToList'), onClick: () => setOpen(null) }),
        React.createElement('span', { className: 'ph-n-embedded-reader__title' }, paperTitle(t, open.paper)),
        props.noteId
          ? React.createElement(Button, {
              size: 'sm',
              variant: linkedPaperIds.indexOf(open.id) >= 0 ? 'soft' : 'primary',
              icon: linkedPaperIds.indexOf(open.id) >= 0 ? 'checkCircle' : 'link',
              loading: busy === 'link',
              disabled: linkedPaperIds.indexOf(open.id) >= 0,
              onClick: linkOpenPaper,
            }, linkedPaperIds.indexOf(open.id) >= 0 ? t('notes.papers.linkedDone') : t('notes.papers.linkCurrent'))
          : null,
      ),
      React.createElement(
        'div',
        { className: 'ph-n-embedded-reader__body' },
        React.createElement(ReaderShell, {
          t: t,
          api: api,
          paperId: open.id,
          paper: open.paper,
          initialPage: 1,
          onBack: () => setOpen(null),
          sessionId: props.sessionId,
          onOpenSettings: null,
        }),
      ),
    )
  }

  return React.createElement(
    'div',
    { className: 'ph-n-paperpane' },
    React.createElement(
      'div',
      { className: 'ph-n-paperpane__head' },
      React.createElement(Icon, { name: 'book', size: 14 }),
      React.createElement('span', { className: 'ph-n-paperpane__title' }, t('notes.papers.panel')),
      props.onClose ? React.createElement(IconButton, { icon: 'panelRight', title: t('notes.papers.panelClose'), onClick: props.onClose }) : null,
    ),
    React.createElement(
      'div',
      { className: 'ph-n-paperpane__search' },
      React.createElement(SearchInput, {
        value: query,
        onChange: setQuery,
        placeholder: t('notes.papers.panelSearch'),
        clearLabel: t('common.clear'),
        loading: results.status === 'loading',
      }),
    ),
    React.createElement(
      'div',
      { className: 'ph-n-paperpane__filters' },
      React.createElement(
        'select',
        { className: 'ph-select ph-select--inline', value: folderId, 'aria-label': t('folders.pick'), onChange: (event) => setFolderId(event.target.value) },
        React.createElement('option', { value: '' }, t('folders.all')),
        folders.map((folder) => React.createElement('option', { key: folder.id, value: folder.id }, '　'.repeat(folder.depth || 0) + folder.name)),
      ),
      React.createElement(
        'select',
        { className: 'ph-select ph-select--inline', value: readFilter, 'aria-label': t('library.batch.reading'), onChange: (event) => setReadFilter(event.target.value) },
        React.createElement('option', { value: '' }, t('folders.anyState')),
        React.createElement('option', { value: 'unread' }, t('library.smart.toRead')),
        React.createElement('option', { value: 'read' }, t('library.smart.read')),
      ),
      React.createElement(
        'label',
        { className: 'ph-n-paperpane__annot' },
        React.createElement('input', { type: 'checkbox', checked: annotatedOnly, onChange: (event) => setAnnotatedOnly(event.target.checked) }),
        t('notes.papers.annotatedOnly'),
      ),
    ),
    React.createElement(
      'div',
      { className: 'ph-n-paperpane__body' },
      React.createElement(
        'div',
        { className: 'ph-n-paperpane__scroll ph-n-scroll' },
        !open
          ? React.createElement(
              'div',
              { className: 'ph-n-paperlist' },
              results.status === 'loading' && results.items.length === 0
                ? React.createElement('div', { className: 'ph-n-progress' }, React.createElement(Spinner), React.createElement('span', null, t('common.loading')))
                : null,
              results.status === 'error'
                ? React.createElement('div', { className: 'ph-n-error' }, React.createElement(Icon, { name: 'warning', size: 14 }), React.createElement('span', null, results.error))
                : null,
              results.status === 'ready' && results.items.length === 0
                ? React.createElement(EmptyState, { compact: true, icon: 'search', title: t('notes.papers.noMatch'), desc: t('notes.papers.panelHint') })
                : null,
              results.items.map((paper) =>
                React.createElement(
                  'button',
                  {
                    key: paper.id,
                    type: 'button',
                    className: 'ph-n-paperrow' + (props.filterPaperId === paper.id ? ' ph-n-paperrow--active' : ''),
                    onClick: () => openPaper(paper),
                    title: paperTitle(t, paper),
                  },
                  React.createElement(
                    'span',
                    { className: 'ph-n-paperrow__thumb' },
                    paper.thumbnailUrl ? React.createElement('img', { src: paper.thumbnailUrl, alt: '', loading: 'lazy' }) : null,
                  ),
                  React.createElement(
                    'span',
                    { className: 'ph-n-paperrow__text' },
                    React.createElement('span', { className: 'ph-n-paperrow__title' }, paperTitle(t, paper)),
                    React.createElement('span', { className: 'ph-n-paperrow__meta' }, [paper.year, paper.venue, Number(paper.annotationCount) > 0 ? '批注 ' + paper.annotationCount : ''].filter(Boolean).join(' · ') || t('common.noVenue')),
                  ),
                ),
              ),
            )
          : React.createElement(
              'div',
              { className: 'ph-n-paperview' },
              React.createElement(
                'div',
                { className: 'ph-n-paperview__head' },
                React.createElement(
                  'div',
                  { className: 'ph-n-paperview__titles' },
                  React.createElement('div', { className: 'ph-n-paperview__title' }, paperTitle(t, open.paper)),
                  React.createElement(
                    'div',
                    { className: 'ph-n-paperview__meta' },
                    [text(open.paper && open.paper.title), open.paper && open.paper.year, open.paper && open.paper.venue].filter(Boolean).join(' · '),
                  ),
                ),
                React.createElement(IconButton, { icon: 'close', title: t('notes.papers.closeView'), onClick: () => setOpen(null) }),
              ),
              React.createElement(
                'div',
                { className: 'ph-n-paperview__pager' },
                React.createElement(IconButton, { icon: 'chevronLeft', title: t('reader.prevPage'), disabled: page <= 1, onClick: () => goPage(page - 1) }),
                React.createElement('span', null, t('notes.papers.pageOf', { page: page, total: open.total || 1 })),
                React.createElement(IconButton, { icon: 'chevronRight', title: t('reader.nextPage'), disabled: page >= (open.total || 1), onClick: () => goPage(page + 1) }),
                React.createElement('span', { className: 'ph-n-spacer' }),
                React.createElement(Button, { size: 'sm', variant: 'ghost', icon: 'external', onClick: () => props.onOpenPaper && props.onOpenPaper(open.id, page) }, t('notes.papers.open')),
              ),
              React.createElement(
                'div',
                {
                  className: 'ph-n-readerpage',
                  ref: imageWrapRef,
                  onMouseUp: onPageMouseUp,
                  title: t('notes.papers.regionHint'),
                  style: { '--ph-r-pageh': (pageHeight > 0 ? pageHeight : 640) + 'px' },
                },
                React.createElement('img', {
                  className: 'ph-n-readerpage__img',
                  src: pageImageUrl(open.id, page, 1200),
                  alt: t('reader.thumbPage', { page: page }),
                  loading: 'lazy',
                  draggable: false,
                }),
                layer && selectable.words.length > 0
                  ? React.createElement(PageTextLayer, { page: page, words: selectable.words, width: selectable.width, height: selectable.height, active: true, interactive: true })
                  : null,
              ),
              React.createElement(
                'div',
                { className: 'ph-n-paperview__section' },
                React.createElement('div', { className: 'ph-n-paperview__section-title' }, React.createElement(Icon, { name: 'translate', size: 12 }), t('notes.papers.regionTitle')),
                React.createElement('p', { className: 'ph-n-caption' }, t('notes.papers.regionHint')),
                region.status === 'loading' ? React.createElement('div', { className: 'ph-n-progress' }, React.createElement(Spinner), React.createElement('span', null, t('common.loading'))) : null,
                region.status === 'error' || (region.status === 'ready' && region.reason && !region.text)
                  ? React.createElement('div', { className: 'ph-n-error' }, React.createElement(Icon, { name: 'warning', size: 14 }), React.createElement('span', null, region.reason || t('common.unavailable')))
                  : null,
                region.text
                  ? React.createElement('div', { className: 'ph-n-region-result' },
                      React.createElement('div', { className: 'ph-n-region-result__source' }, region.text),
                      region.translation ? React.createElement('div', { className: 'ph-n-region-result__translation' }, region.translation) : React.createElement('div', { className: 'ph-n-caption' }, t('notes.papers.regionPending')),
                    )
                  : null,
                React.createElement(Button, { size: 'sm', variant: 'soft', icon: 'sparkle', loading: busy === 'ai', onClick: askAiPage }, t('notes.papers.askAi')),
                ai.status === 'loading' ? React.createElement('div', { className: 'ph-n-progress' }, React.createElement(Spinner), React.createElement('span', null, t('common.loading'))) : null,
                ai.status === 'error' ? React.createElement('div', { className: 'ph-n-error' }, React.createElement(Icon, { name: 'warning', size: 14 }), React.createElement('span', null, ai.reason)) : null,
                ai.answer ? React.createElement('div', { className: 'ph-n-region-result__translation' }, ai.answer) : null,
              ),
              React.createElement(
                'div',
                { className: 'ph-n-paperview__section' },
                React.createElement(
                  'div',
                  { className: 'ph-n-paperview__section-title' },
                  React.createElement(Icon, { name: 'translate', size: 12 }),
                  t('notes.papers.translation'),
                  React.createElement(Button, { size: 'sm', variant: 'soft', icon: 'translate', loading: busy === 'translate', onClick: translatePage }, t('notes.papers.translatePage')),
                  React.createElement('span', { className: 'ph-n-spacer' }),
                  translation.blocks.length > 0
                    ? React.createElement('span', { className: 'ph-n-caption' }, t('notes.papers.translatedCount', { count: translation.blocks.filter((block) => block && block.translation).length }))
                    : null,
                ),
                translation.status === 'translating'
                  ? React.createElement('div', { className: 'ph-n-progress' }, React.createElement(Spinner), React.createElement('span', null, t('notes.papers.translating')))
                  : null,
                translation.status === 'error' || (translation.reason && translation.blocks.length === 0)
                  ? React.createElement('div', { className: 'ph-n-error' }, React.createElement(Icon, { name: 'warning', size: 14 }), React.createElement('span', null, translation.reason || t('common.unavailable')))
                  : null,
                translation.blocks.length > 0
                  ? React.createElement(
                      'div',
                      { className: 'ph-n-paperview__trans' },
                      translation.blocks.slice(0, 14).map((block, index) =>
                        React.createElement(
                          'div',
                          { key: (block && block.id) || index },
                          block && block.translation
                            ? React.createElement('p', null, block.translation)
                            : React.createElement('p', { className: 'muted' }, (block && block.text ? String(block.text).slice(0, 180) : '') + ' · ' + t('notes.papers.untranslated')),
                        ),
                      ),
                    )
                  : translation.status === 'idle'
                    ? React.createElement('p', { className: 'ph-n-caption' }, t('notes.papers.translateHint'))
                    : null,
              ),
              React.createElement(
                'div',
                { className: 'ph-n-paperview__section' },
                React.createElement(
                  'div',
                  { className: 'ph-n-paperview__section-title' },
                  React.createElement(Icon, { name: 'highlighter', size: 12 }),
                  t('notes.papers.annotations'),
                  React.createElement('span', { className: 'ph-n-caption' }, String(annotations.items.length)),
                ),
                annotations.status === 'ready' && annotations.items.length === 0
                  ? React.createElement('p', { className: 'ph-n-caption' }, t('notes.papers.noAnnotations'))
                  : null,
                annotations.items.slice(0, 8).map((annotation) =>
                  React.createElement(
                    'button',
                    {
                      key: annotation.id,
                      type: 'button',
                      className: 'ph-n-paperview__annot',
                      onClick: () => props.onOpenPaper && props.onOpenPaper(open.id, page, annotation.id),
                      title: t('reader.annot.openInReader'),
                      style: { textAlign: 'left', cursor: 'pointer' },
                    },
                    React.createElement('span', { className: 'ph-n-paperview__annot-dot', style: { background: ANNOTATION_COLORS[annotation.color] || ANNOTATION_COLORS.yellow } }),
                    React.createElement('span', { className: 'ph-n-paperview__annot-text' }, text(annotation.quote, annotation.comment) || annotation.kind),
                  ),
                ),
              ),
              React.createElement(
                'div',
                { className: 'ph-n-paperview__section' },
                React.createElement(
                  'div',
                  { className: 'ph-n-paperview__section-title' },
                  React.createElement(Icon, { name: 'note', size: 12 }),
                  t('notes.papers.useInNotes'),
                ),
                pageState.status === 'loading'
                  ? React.createElement('div', { className: 'ph-n-progress' }, React.createElement(Spinner), React.createElement('span', null, t('common.loading')))
                  : pageState.status === 'error'
                    ? React.createElement('div', { className: 'ph-n-error' }, React.createElement(Icon, { name: 'warning', size: 14 }), React.createElement('span', null, pageState.error))
                    : React.createElement(
                        'p',
                        { className: 'ph-n-caption', style: { maxHeight: 120, overflow: 'hidden' } },
                        (pageState.text || '').replace(/\s+/g, ' ').slice(0, 360) || t('reader.noText'),
                      ),
                React.createElement(
                  'div',
                  { className: 'ph-n-paperview__actions', style: { display: 'flex', gap: 6, flexWrap: 'wrap' } },
                  props.noteId
                    ? React.createElement(Button, {
                        size: 'sm',
                        variant: 'soft',
                        icon: 'link',
                        onClick: () => props.onLinkPaper && props.onLinkPaper(open.paper),
                        disabled: Array.isArray(props.linkedPaperIds) && props.linkedPaperIds.indexOf(open.id) >= 0,
                      }, t('notes.papers.linkCurrent'))
                    : null,
                  React.createElement(Button, { size: 'sm', variant: 'ghost', icon: 'filter', onClick: () => props.onFilterByPaper && props.onFilterByPaper(open.paper) }, t('notes.fromPaper')),
                  React.createElement(Button, { size: 'sm', variant: 'ghost', icon: 'note', onClick: () => props.onCreateNote && props.onCreateNote(open.paper) }, t('notes.papers.newNote')),
                ),
              ),
            ),
      ),
    ),
  )
}
