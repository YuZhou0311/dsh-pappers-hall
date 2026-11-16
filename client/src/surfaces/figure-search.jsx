/**
 * Figure search surface: caption text, screenshot upload and (v0.2) "find
 * similar to this indexed figure". Results show the real crop, page/figure
 * number, hit reasons and the honest channel state — never a fake similarity
 * percentage.
 */
import React from 'react'
import { h } from '../core/dom.js'
import { Icon } from '../core/icons.jsx'
import { Badge, Button, Check, EmptyState, IconButton, SearchInput, useToasts } from '../core/primitives.jsx'
import { describeError, isOffline } from '../core/api.js'
import { pendingStore } from '../core/pending.js'
import { commitReferenceBatch } from '../core/reference-actions.js'
import { navigation } from '../core/navigation.js'

function operationId(prefix) {
  const random =
    typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
      ? crypto.randomUUID()
      : Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 10)
  return (prefix ? prefix + '-' : '') + random
}

function useDebounced(value, delay) {
  const [debounced, setDebounced] = React.useState(value)
  React.useEffect(() => {
    const timer = setTimeout(() => setDebounced(value), delay == null ? 300 : delay)
    return () => clearTimeout(timer)
  }, [value, delay])
  return debounced
}

function readFileAsDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result || ''))
    reader.onerror = () => reject(reader.error || new Error('file read failed'))
    reader.readAsDataURL(file)
  })
}

function dataUrlPayload(dataUrl) {
  const text = String(dataUrl || '')
  const comma = text.indexOf(',')
  return comma >= 0 ? text.slice(comma + 1) : text
}

/** Map a contract `reasons[]` value to a localized chip label. */
function reasonLabel(t, reason) {
  const token = String(reason || '').toLowerCase()
  if (!token) return ''
  if (token.indexOf('near_duplicate') >= 0 || token.indexOf('near duplicate') >= 0 || token.indexOf('dhash') >= 0) return t('page.reason.neardup')
  if (token.indexOf('caption') >= 0) return t('page.reason.caption')
  if (token.indexOf('annotation') >= 0) return t('page.reason.annotation')
  if (token.indexOf('note') >= 0) return t('page.reason.note')
  if (token.indexOf('visual') >= 0 || token.indexOf('vector') >= 0 || token === 'image') return t('page.reason.visual')
  if (token.indexOf('full text') >= 0 || token === 'body' || token.indexOf('substring') >= 0) return t('page.reason.body')
  if (token.indexOf('title') >= 0 || token.indexOf('metadata') >= 0 || token.indexOf('fts') >= 0) return t('page.reason.title')
  return String(reason)
}

function figureImageUrl(figureId) {
  return figureId ? '/pappers-hall/figure/' + encodeURIComponent(String(figureId)) + '.png?width=900' : ''
}

function paperTitle(t, paper) {
  if (!paper) return t('common.untitled')
  return paper.titleZh || paper.displayTitle || paper.title || t('common.untitled')
}

function FigureThumb(props) {
  const [failed, setFailed] = React.useState(false)
  React.useEffect(() => setFailed(false), [props.src])
  if (failed || !props.src) return h(Icon, { name: 'figure', size: 24 })
  return h('img', { src: props.src, alt: props.alt || '', loading: 'lazy', decoding: 'async', draggable: false, onError: () => setFailed(true) })
}

function ResultCard(props) {
  const t = props.t
  const card = props.card
  return h(
    'article',
    {
      className: 'ph-figcard',
      draggable: Boolean(card.figureId),
      onDragStart: (event) => {
        try {
          event.dataTransfer.setData('application/x-pappers-hall', JSON.stringify({ materials: [{ kind: 'figure', id: card.figureId, page: card.page, title: card.paperTitle }] }))
          event.dataTransfer.effectAllowed = 'copy'
        } catch (error) {
          /* drag is best-effort */
        }
      },
    },
    h('div', { className: 'ph-figcard__img' }, h(FigureThumb, { src: card.imageUrl, alt: card.caption || '' })),
    h(
      'div',
      { className: 'ph-figcard__body' },
      h('div', { className: 'ph-figcard__title' }, card.paperTitle || t('common.untitled')),
      card.caption ? h('p', { className: 'ph-figcard__caption' }, card.caption) : null,
      h(
        'div',
        { className: 'ph-figcard__meta' },
        h('span', null, t('figure.search.pageFigure', { page: Number(card.page) || 1, label: card.figureLabel || '?' })),
        h(
          'div',
          { className: 'ph-reasons' },
          (Array.isArray(card.reasons) ? card.reasons : []).slice(0, 3).map((reason, index) => h(Badge, { key: index, tone: 'business' }, reasonLabel(t, reason))),
        ),
      ),
      card.annotation ? h('div', { className: 'ph-figcard__annotation' }, h(Icon, { name: 'note', size: 13 }), h('span', null, card.annotation)) : null,
      h(
        'div',
        { className: 'ph-figcard__actions' },
        card.paperId ? h(Button, { size: 'sm', icon: 'external', onClick: () => props.onOpen(card) }, t('figure.search.open')) : null,
        card.figureId ? h(Button, { size: 'sm', icon: 'search', onClick: () => props.onSimilar(card) }, t('figure.search.fromLibrary')) : null,
        card.figureId || card.materialId ? h(Button, { size: 'sm', variant: 'primary', icon: 'quote', onClick: () => props.onCite(card) }, t('figure.search.cite')) : null,
      ),
    ),
  )
}

export function FigureSearch(props) {
  const t = props.t
  const api = props.api
  const { toasts, push } = useToasts()
  const focus = props.focusFigure || null
  const [query, setQuery] = React.useState(props.initialQuery || '')
  const debounced = useDebounced(query, 320)
  const [upload, setUpload] = React.useState(null)
  const [readOnly, setReadOnly] = React.useState(false)
  const [annotatedOnly, setAnnotatedOnly] = React.useState(false)
  const [mode, setMode] = React.useState(focus && focus.figureId ? 'figure' : 'text')
  const [revision, setRevision] = React.useState(0)
  const [state, setState] = React.useState({ status: 'idle', data: null, error: null })
  const fileRef = React.useRef(null)

  React.useEffect(() => {
    if (focus && focus.figureId) {
      setMode('figure')
      setQuery('')
      setUpload(null)
      setRevision((value) => value + 1)
    }
  }, [focus && focus.figureId, focus && focus.paperId])

  React.useEffect(() => {
    let alive = true
    const controller = new AbortController()
    const value = debounced.trim()
    const run = async () => {
      if (mode === 'figure' && focus && focus.figureId) {
        const card = {
          key: 'focus:' + focus.figureId,
          figureId: focus.figureId,
          paperId: focus.paperId,
          paperTitle: focus.paperTitle || '',
          page: focus.page || 1,
          figureLabel: focus.label || '',
          caption: focus.caption || '',
          imageUrl: focus.imageUrl || figureImageUrl(focus.figureId),
          reasons: ['visual_near_duplicate'],
          materialId: focus.figureId,
        }
        try {
          const result = await api('figures.search', { figureId: focus.figureId, mode: 'image', limit: 36 }, { signal: controller.signal })
          const items = Array.isArray(result && result.items) ? result.items : []
          const channels = Array.isArray(result && result.channels) ? result.channels : []
          const cards = items.map((entry, index) => {
            const figure = (entry && entry.figure) || {}
            const paper = (entry && entry.paper) || {}
            return {
              key: 'figure:' + String(figure.id || index),
              figureId: figure.id,
              paperId: figure.paperId || paper.id,
              paperTitle: paperTitle(t, paper),
              page: figure.page || entry.page || 1,
              figureLabel: figure.label,
              caption: figure.caption,
              imageUrl: figure.imageUrl || figureImageUrl(figure.id),
              reasons: entry.reasons,
              annotation: '',
              materialId: figure.id,
            }
          })
          return { status: 'ready', data: { source: 'figure', cards: cards, channels: channels, focusCard: card, fallback: false }, error: null }
        } catch (error) {
          if (error && error.name === 'AbortError') throw error
          const caption = (focus.caption || '').trim()
          if (!caption) {
            return {
              status: 'ready',
              data: { source: 'figure', cards: [], channels: [], focusCard: card, fallback: true, fallbackReason: describeError(t, error) },
              error: null,
            }
          }
          const result = await api('search.query', { q: caption, scope: 'figures', offset: 0, limit: 36 }, { signal: controller.signal })
          const items = Array.isArray(result && result.items) ? result.items : []
          const cards = items.map((hit, index) => ({
            key: 'hit:' + (hit.id || index),
            figureId: hit.kind === 'figure' ? hit.id : null,
            paperId: hit.paperId,
            paperTitle: paperTitle(t, hit),
            page: hit.page || 1,
            figureLabel: hit.figureLabel,
            caption: hit.snippet,
            imageUrl: hit.kind === 'figure' ? figureImageUrl(hit.id) : '',
            reasons: hit.reasons,
            annotation: '',
            materialId: hit.id,
          }))
          return { status: 'ready', data: { source: 'figure', cards: cards, channels: Array.isArray(result && result.channels) ? result.channels : [], focusCard: card, fallback: true, fallbackReason: describeError(t, error) }, error: null }
        }
      }
      if (upload && upload.base64) {
        try {
          const result = await api('figures.search', { imageBase64: upload.base64, mode: 'image', limit: 36 }, { signal: controller.signal })
          const items = Array.isArray(result && result.items) ? result.items : []
          const cards = items.map((entry, index) => {
            const figure = (entry && entry.figure) || {}
            const paper = (entry && entry.paper) || {}
            return {
              key: 'figure:' + String(figure.id || index),
              figureId: figure.id,
              paperId: figure.paperId || paper.id,
              paperTitle: paperTitle(t, paper),
              page: figure.page || entry.page || 1,
              figureLabel: figure.label,
              caption: figure.caption,
              imageUrl: figure.imageUrl || figureImageUrl(figure.id),
              reasons: entry.reasons,
              annotation: '',
              materialId: figure.id,
            }
          })
          return { status: 'ready', data: { source: 'image', cards: cards, channels: Array.isArray(result && result.channels) ? result.channels : [] }, error: null }
        } catch (error) {
          if (error && error.name === 'AbortError') throw error
          return { status: 'error', data: null, error: error }
        }
      }
      if (!value) return { status: 'idle', data: null, error: null }
      try {
        const filters = {}
        if (readOnly) filters.read = true
        if (annotatedOnly) filters.annotated = true
        const result = await api('search.query', { q: value, scope: 'figures', filters: filters, offset: 0, limit: 36 }, { signal: controller.signal })
        const cards = (Array.isArray(result && result.items) ? result.items : []).map((hit, index) => ({
          key: 'hit:' + (hit.id || index),
          figureId: hit.kind === 'figure' ? hit.id : null,
          paperId: hit.paperId,
          paperTitle: paperTitle(t, hit),
          page: hit.page || 1,
          figureLabel: hit.figureLabel,
          caption: hit.snippet,
          imageUrl: hit.kind === 'figure' ? figureImageUrl(hit.id) : '',
          reasons: hit.reasons,
          annotation: hit.kind === 'annotation' ? hit.snippet : '',
          materialId: hit.id,
          materialKind: hit.kind,
        }))
        return { status: 'ready', data: { source: 'text', cards: cards, channels: Array.isArray(result && result.channels) ? result.channels : [] }, error: null }
      } catch (error) {
        if (error && error.name === 'AbortError') throw error
        return { status: 'error', data: null, error: error }
      }
    }
    setState((previous) => ({ status: 'loading', data: previous.data, error: null }))
    run().then(
      (next) => {
        if (alive && next) setState(next)
      },
      (error) => {
        if (!alive || (error && error.name === 'AbortError')) return
        setState({ status: 'error', data: null, error: error })
      },
    )
    return () => {
      alive = false
      controller.abort()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode, debounced, upload && upload.base64, focus && focus.figureId, readOnly, annotatedOnly, revision])

  const cards = (state.data && state.data.cards) || []
  const channels = (state.data && state.data.channels) || []
  const warnings = channels
    .filter((channel) => channel && channel.status && channel.status !== 'ok')
    .map((channel) => ({ name: channel.name || 'image', status: channel.status, note: channel.note || '' }))
  const imageWarning = warnings.find((warning) => {
    const name = String(warning.name).toLowerCase()
    return name.indexOf('image') >= 0 || name.indexOf('visual') >= 0
  })
  const offline = state.status === 'error' && isOffline(state.error)

  const pickScreenshot = (fileList) => {
    const file = Array.prototype.slice.call(fileList || [])[0]
    if (!file) return
    if (!/^image\//.test(String(file.type || ''))) {
      push('warning', t('figure.search.uploadTip'))
      return
    }
    readFileAsDataUrl(file)
      .then((dataUrl) => {
        setUpload({ base64: dataUrlPayload(dataUrl), name: file.name })
        setQuery('')
        setMode('image')
      })
      .catch((error) => push('error', describeError(t, error)))
  }

  const cite = (card) => {
    const kind = card.materialKind === 'annotation' ? 'annotation' : card.materialKind === 'paper' ? 'paper' : 'figure'
    const material = { kind: kind, id: card.figureId || card.materialId, page: card.page, title: card.paperTitle }
    commitReferenceBatch([material], { operationId: operationId('refs') })
      .then(() => {
        push('success', t('toast.cited'))
        setRevision((value) => value + 1)
      })
      .catch((error) => push('error', t('toast.citeFailed', { message: describeError(t, error) })))
  }

  const findSimilar = (card) => {
    if (!card.figureId) return
    if (props.onFindSimilar) {
      props.onFindSimilar({
        paperId: card.paperId,
        figureId: card.figureId,
        page: card.page,
        label: card.figureLabel,
        caption: card.caption,
        imageUrl: card.imageUrl,
        paperTitle: card.paperTitle,
      })
      return
    }
    navigation.openFigureSearch({ paperId: card.paperId, figureId: card.figureId })
  }

  let body
  if (offline) {
    body = h(EmptyState, { tone: 'warning', icon: 'warning', title: t('common.offline.title'), desc: t('common.offline.desc') })
  } else if (state.status === 'error') {
    body = h(EmptyState, { tone: 'error', icon: 'warning', title: t('library.error.title'), desc: describeError(t, state.error), action: h(Button, { variant: 'secondary', icon: 'refresh', onClick: () => setRevision((value) => value + 1) }, t('common.retry')) })
  } else if (state.status === 'loading' && cards.length === 0) {
    body = h('div', { className: 'ph-figgrid' }, [0, 1, 2, 3].map((index) => h('div', { key: index, className: 'ph-figcard' }, h('div', { className: 'ph-skeleton', style: { aspectRatio: '4 / 3', width: '100%', borderRadius: 0 } }), h('div', { className: 'ph-figcard__body' }, h('div', { className: 'ph-skeleton', style: { width: '70%' } }), h('div', { className: 'ph-skeleton', style: { width: '45%' } })))))
  } else if (state.status === 'idle' && cards.length === 0) {
    body = h(EmptyState, { icon: 'image', title: t('figure.search.title'), desc: t('figure.search.hint') })
  } else if (cards.length === 0) {
    body = h(EmptyState, { icon: 'search', title: t('figure.search.empty') })
  } else {
    body = h(
      'div',
      { className: 'ph-figgrid' },
      cards.map((card, index) =>
        h(ResultCard, {
          key: card.key || index,
          t: t,
          card: card,
          onOpen: (value) => navigation.openPaper({ paperId: value.paperId, page: value.page || 1, source: 'figures' }),
          onCite: cite,
          onSimilar: findSimilar,
        }),
      ),
    )
  }

  const focusCard = state.data && state.data.focusCard
  return h(
    'div',
    { className: 'ph-figsearch ph-scroll' },
    h(
      'div',
      { className: 'ph-figsearch__head' },
      props.onBack ? h(Button, { variant: 'ghost', icon: 'arrowLeft', onClick: props.onBack }, t('figure.search.back')) : null,
      h('div', null, h('h2', { className: 'ph-figsearch__title' }, t('figure.search.title')), h('p', { className: 'ph-figsearch__desc' }, t('figure.search.desc'))),
    ),
    mode === 'figure' && focusCard
      ? h(
          'div',
          { className: 'ph-figsource' },
          h(Icon, { name: 'figure', size: 15 }),
          h('span', null, t('figure.search.byFigure', { label: focusCard.figureLabel || '?' }) + (focusCard.paperTitle ? ' · ' + focusCard.paperTitle : '')),
          h(Button, { size: 'sm', variant: 'ghost', icon: 'close', onClick: () => setMode('text') }, t('figure.search.tab.text')),
        )
      : null,
    h(
      'div',
      { className: 'ph-figsearch__bar' },
      h(SearchInput, {
        value: query,
        onChange: (value) => {
          setQuery(value)
          if (value) {
            setUpload(null)
            setMode('text')
          }
        },
        placeholder: t('figure.search.placeholder'),
        'aria-label': t('figure.search.placeholder'),
        clearLabel: t('common.clear'),
        disabled: state.status === 'loading',
      }),
      h('input', {
        ref: fileRef,
        type: 'file',
        accept: 'image/png,image/jpeg,image/webp',
        className: 'ph-hidden-input',
        onChange: (event) => {
          pickScreenshot(event.target.files)
          event.target.value = ''
        },
      }),
      h(Button, { variant: 'primary', icon: 'image', onClick: () => fileRef.current && fileRef.current.click() }, t('figure.search.upload')),
    ),
    upload ? h('div', { className: 'ph-uploadchip' }, h(Icon, { name: 'image', size: 14 }), h('span', null, t('figure.search.imageMode') + ' · ' + (upload.name || 'screenshot')), h(IconButton, { icon: 'close', title: t('common.clear'), onClick: () => setUpload(null) })) : null,
    h(
      'div',
      { className: 'ph-figsearch__filters' },
      h(Check, { checked: readOnly, onChange: setReadOnly, label: t('figure.search.onlyRead') }),
      h(Check, { checked: annotatedOnly, onChange: setAnnotatedOnly, label: t('figure.search.onlyAnnotated') }),
      h('span', { className: 'ph-spacer' }),
      state.status === 'ready' && cards.length > 0 ? h('span', { className: 'ph-caption' }, t('figure.search.results', { count: cards.length })) : null,
      h('span', { className: 'ph-caption' }, t('figure.search.matchHint')),
    ),
    state.data && state.data.fallback ? h('div', { className: 'ph-channelwarn' }, h(Icon, { name: 'warning', size: 15 }), h('div', { className: 'ph-channelwarn__text' }, h('p', null, t('figure.search.fallbackCaption')), state.data.fallbackReason ? h('p', { className: 'ph-muted' }, state.data.fallbackReason) : null)) : null,
    warnings.length > 0
      ? h('div', { className: 'ph-channelwarn' }, [
          h(Icon, { key: 'icon', name: 'warning', size: 15 }),
          h(
            'div',
            { key: 'text', className: 'ph-channelwarn__text' },
            h('p', null, imageWarning ? t('figure.search.degraded', { reason: imageWarning.note || t('figure.search.degradedGeneric') }) : t('figure.search.degradedGeneric')),
            warnings.map((warning, index) => h('p', { key: index, className: 'ph-muted' }, t('figure.search.channelRow', { name: warning.name, status: t('figure.search.channel.' + (warning.status || 'degraded')) }) + (warning.note ? ' — ' + warning.note : ''))),
          ),
        ])
      : null,
    toasts.length > 0 ? h('div', null, toasts.map((toast) => h('div', { key: toast.id, className: 'ph-notice ph-notice--' + (toast.tone || 'info') }, h('span', { className: 'ph-notice__text' }, toast.text)))) : null,
    body,
  )
}
