/**
 * Annotation rendering + editing surfaces.
 *
 *  - `AnnotationMarks` paints the normalised rects of every annotation on one
 *    page as translucent highlights / dashed areas / sticky-note pins.
 *  - `AnnotationTooltip` is the lightweight hover preview (quote + comment).
 *  - `AnnotationPopover` is the click-through editor: colour switch, comment
 *    edit, delete, copy, cite to chat and ask-AI shortcuts.
 *  - `AnnotationListPanel` powers the right-hand “批注” tab.
 *  - `NoteComposer` creates a sticky note at a clicked page position.
 *
 * Marks are pointer-events:none on purpose: the page canvas hit-tests pointer
 * positions so text can still be selected across an existing highlight.
 */
import React from 'react'
import { engineBadge } from './engines.js'
import {
  ANNOTATION_COLORS,
  Badge,
  Btn,
  Empty,
  Icon,
  IconBtn,
  Spinner,
  annotationKindLabel,
  annotationOriginLabel,
  colorHex,
  cx,
  firstText,
  formatTime,
  noteAnchor,
  rectStyle,
} from './shared.jsx'

/** Colour swatch row shared by the popover and the note composer. */
export function ColorPens(props) {
  const value = props.value || 'yellow'
  const rt = props.t
  return React.createElement(
    'div',
    { className: 'ph-r-pens', role: 'group', 'aria-label': props.label || rt('reader.annot.color') },
    ANNOTATION_COLORS.map((name) =>
      React.createElement('button', {
        key: name,
        type: 'button',
        className: cx('ph-r-pen', 'ph-r-pen--' + name, value === name && 'ph-r-pen--current'),
        style: value === name ? { boxShadow: '0 0 0 2px var(--dsw-alias-bg-base), 0 0 0 3.5px ' + colorHex(name) } : undefined,
        title: rt('reader.annot.color.' + name),
        'aria-label': rt('reader.annot.color.' + name),
        'aria-pressed': value === name ? 'true' : 'false',
        onClick: () => props.onChange(name),
      }),
    ),
  )
}

/* -------------------------------------------------------------------------- */
/* Marks                                                                       */
/* -------------------------------------------------------------------------- */

function NotePin(props) {
  const annotation = props.annotation
  const anchor = noteAnchor(annotation)
  if (!anchor) return null
  return React.createElement(
    'span',
    {
      className: cx(
        'ph-r-mark',
        'ph-r-mark--note',
        'ph-r-mark--' + annotation.color,
        annotation.id === props.activeId && 'ph-r-mark--active',
      ),
      style: {
        left: (anchor.x * 100).toFixed(3) + '%',
        top: (anchor.y * 100).toFixed(3) + '%',
        width: 20,
        height: 20,
        transform: 'translate(-6px, -100%)',
      },
      'data-ph-annotation': annotation.id,
    },
    React.createElement(
      'span',
      { className: cx('ph-r-note-pin', 'ph-r-note-pin--' + annotation.color) },
      React.createElement(Icon, { name: 'sticky', size: 11 }),
    ),
  )
}

/**
 * Render the marks of one page.
 * @param {object} props
 * @param {Array} props.annotations Normalised annotations already filtered by page.
 * @param {string|null} props.activeId Annotation whose popover is open.
 * @param {number} props.page Page number (data attribute only).
 */
export function AnnotationMarks(props) {
  const annotations = props.annotations || []
  const marks = []
  for (const annotation of annotations) {
    if (!annotation || annotation.state === 'trash') continue
    if (annotation.kind === 'note') {
      marks.push(React.createElement(NotePin, { key: annotation.id, annotation, activeId: props.activeId }))
      continue
    }
    annotation.rects.forEach((rect, index) => {
      marks.push(
        React.createElement('span', {
          key: annotation.id + ':' + index,
          className: cx(
            'ph-r-mark',
            'ph-r-mark--' + annotation.color,
            annotation.kind === 'area' && 'ph-r-mark--area',
            annotation.id === props.activeId && 'ph-r-mark--active',
            annotation.pending && 'ph-r-mark--pending',
          ),
          style: rectStyle(rect),
          'data-ph-annotation': annotation.id,
        }),
      )
    })
  }
  if (marks.length === 0) return null
  return React.createElement('div', { className: 'ph-r-marks', 'aria-hidden': 'true', 'data-ph-annotations': String(props.page || '') }, marks)
}

/* -------------------------------------------------------------------------- */
/* Hover tooltip                                                               */
/* -------------------------------------------------------------------------- */

/**
 * @param {object} props
 * @param {object} props.annotation Normalised annotation.
 * @param {object} props.style Absolute position/size within the page.
 */
export function AnnotationTooltip(props) {
  const annotation = props.annotation
  if (!annotation) return null
  const quote = firstText(annotation.quote)
  const comment = firstText(annotation.comment)
  if (!quote && !comment) return null
  return React.createElement(
    'div',
    { className: 'ph-r-tip', style: props.style, role: 'tooltip' },
    quote ? React.createElement('div', { className: 'ph-r-tip__quote' }, quote.length > 180 ? quote.slice(0, 180) + '…' : quote) : null,
    comment ? React.createElement('div', { className: 'ph-r-tip__comment' }, comment.length > 220 ? comment.slice(0, 220) + '…' : comment) : null,
  )
}

/* -------------------------------------------------------------------------- */
/* Popover                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * @param {object} props
 * @param {object} props.t Reader translator.
 * @param {object} props.annotation Normalised annotation being edited.
 * @param {object} props.style Absolute position within the page.
 * @param {boolean} props.busy A write is in flight.
 * @param {Function} props.onClose
 * @param {Function} props.onUpdate patch -> Promise
 * @param {Function} props.onDelete
 * @param {Function} props.onCopy
 * @param {Function} props.onCite
 * @param {Function} props.onAsk
 * @param {Function} props.onExplain
 * @param {Function} props.onJumpPage
 * @param {boolean} props.autoFocus
 */
export function AnnotationPopover(props) {
  const rt = props.t
  const annotation = props.annotation
  const annotationId = annotation.id
  const [comment, setComment] = React.useState(() => firstText(annotation.comment))
  const [color, setColor] = React.useState(annotation.color)
  const [quoteExpanded, setQuoteExpanded] = React.useState(false)
  const [saving, setSaving] = React.useState(false)
  const [savedAt, setSavedAt] = React.useState(0)
  const [translation, setTranslation] = React.useState(null)
  const [translating, setTranslating] = React.useState(false)
  const savedCommentRef = React.useRef(firstText(annotation.comment))

  // Re-sync only when the annotation itself changes (not while the user types).
  React.useEffect(() => {
    if (annotationId !== undefined) {
      setComment(firstText(annotation.comment))
      setColor(annotation.color)
      savedCommentRef.current = firstText(annotation.comment)
      setSavedAt(0)
      setTranslation(null)
      setQuoteExpanded(false)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [annotationId])

  // Auto-save the comment with a short debounce (v0.3 §2.2.5).
  const updateRef = React.useRef(props.onUpdate)
  updateRef.current = props.onUpdate
  React.useEffect(() => {
    const next = comment.trim()
    if (next === savedCommentRef.current) return undefined
    const timer = setTimeout(() => {
      setSaving(true)
      Promise.resolve(updateRef.current({ comment: next }))
        .then(() => {
          savedCommentRef.current = next
          setSavedAt(Date.now())
        })
        .catch(() => {})
        .then(() => setSaving(false))
    }, 650)
    return () => clearTimeout(timer)
  }, [comment])

  if (!annotation) return null
  const quote = firstText(annotation.quote)
  const longQuote = quote.length > 170 || (quote.match(/\n/g) || []).length >= 3
  const dirty = comment.trim() !== savedCommentRef.current

  const cancelComment = () => {
    setComment(savedCommentRef.current)
    setSavedAt(0)
  }
  const changeColor = (name) => {
    setColor(name)
    Promise.resolve(props.onUpdate({ color: name })).catch(() => {})
  }
  const aiTranslate = () => {
    if (!props.onAiTranslate || translating) return
    setTranslating(true)
    Promise.resolve(props.onAiTranslate(annotation))
      .then((result) => { if (result) setTranslation(result) })
      .catch((error) => setTranslation({ status: 'error', reason: firstText(error && error.message, 'error') }))
      .then(() => setTranslating(false))
  }

  const quickTranslate = () => {
    if (!props.onQuickTranslate || translating) return
    setTranslating(true)
    setTranslation(null)
    Promise.resolve(props.onQuickTranslate(annotation))
      .then((result) => {
        if (result) setTranslation(result)
      })
      .catch((error) => {
        setTranslation({ status: 'error', reason: firstText(error && error.message, 'error') })
      })
      .then(() => setTranslating(false))
  }

  const actionButton = (key, icon, label, onClick, options) =>
    React.createElement(
      'button',
      {
        key,
        type: 'button',
        className: 'ph-r-popover__action',
        onClick,
        disabled: options && options.disabled,
        title: (options && options.title) || label,
      },
      React.createElement(Icon, { name: icon, size: 13 }),
      React.createElement('span', null, label),
    )

  return React.createElement(
    'div',
    {
      className: cx('ph-r-card', 'ph-r-popover'),
      style: props.style,
      'data-ph-overlay': 'annotation-popover',
      'data-ph-popover': annotationId,
      onMouseDown: (event) => event.stopPropagation(),
    },
    React.createElement(
      'div',
      { className: 'ph-r-popover__head' },
      React.createElement('span', { className: 'ph-r-annotcard__swatch', style: { background: colorHex(annotation.color) } }),
      React.createElement('strong', null, annotationKindLabel(rt, annotation.kind)),
      React.createElement('span', { className: 'ph-r-popover__meta' }, rt('reader.annot.pageChip', { page: annotation.page })),
      React.createElement('span', { className: 'ph-r-popover__meta' }, formatTime(annotation.createdAt)),
      React.createElement('span', { className: 'ph-r-popover__spacer' }),
      React.createElement(IconBtn, { icon: 'close', title: rt('reader.close'), onClick: props.onClose }),
    ),
    quote
      ? React.createElement(
          'div',
          { className: cx('ph-r-popover__quotewrap', longQuote && !quoteExpanded && 'ph-r-popover__quotewrap--clamped') },
          React.createElement('blockquote', { className: 'ph-r-popover__quote' }, quote),
          longQuote
            ? React.createElement(
                'button',
                { type: 'button', className: 'ph-r-popover__expand', onClick: () => setQuoteExpanded((value) => !value) },
                quoteExpanded ? rt('reader.popover.collapseQuote') : rt('reader.popover.expandQuote'),
              )
            : null,
        )
      : null,
    React.createElement(
      'div',
      { className: 'ph-r-popover__commenthead' },
      React.createElement('span', null, rt('reader.annot.comment')),
      React.createElement('span', { className: 'ph-r-popover__spacer' }),
      saving
        ? React.createElement('span', { className: 'ph-r-popover__autosave' }, rt('reader.popover.saving'))
        : savedAt
          ? React.createElement('span', { className: 'ph-r-popover__autosave ph-r-popover__autosave--ok' }, rt('reader.popover.saved'))
          : React.createElement('span', { className: 'ph-r-popover__autosave' }, rt('reader.popover.autosave')),
      dirty
        ? React.createElement('button', { type: 'button', className: 'ph-r-popover__expand', onClick: cancelComment }, rt('reader.popover.cancelEdit'))
        : null,
    ),
    React.createElement('textarea', {
      className: 'ph-r-popover__textarea',
      value: comment,
      rows: 3,
      placeholder: rt('reader.annot.placeholder'),
      autoFocus: Boolean(props.autoFocus),
      onChange: (event) => setComment(event.target.value),
      onKeyDown: (event) => {
        if (event.key === 'Escape') {
          event.stopPropagation()
          props.onClose()
        }
        if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {
          event.preventDefault()
          const next = comment.trim()
          setSaving(true)
          Promise.resolve(props.onUpdate({ comment: next }))
            .then(() => {
              savedCommentRef.current = next
              setSavedAt(Date.now())
            })
            .catch(() => {})
            .then(() => setSaving(false))
        }
      },
    }),
    React.createElement(
      'div',
      { className: 'ph-r-popover__row' },
      React.createElement('span', { className: 'ph-r-popover__hint' }, rt('reader.annot.color')),
      React.createElement(ColorPens, { t: rt, value: color, onChange: changeColor }),
    ),
    React.createElement(
      'div',
      { className: 'ph-r-popover__grid' },
      quote ? actionButton('copy', 'copy', rt('reader.popover.copyQuote'), () => props.onCopy(annotation)) : null,
      actionButton('quick', 'sparkles', translating ? rt('reader.popover.translating') : rt('reader.popover.quickTranslate'), quickTranslate, {
        disabled: translating || !quote,
      }),
      actionButton('explain', 'book', rt('reader.annot.explain'), () => props.onExplain(annotation)),
      actionButton('ask', 'note', rt('reader.annot.ask'), () => props.onAsk(annotation)),
      actionButton('cite', 'quote', rt('reader.annot.cite'), () => props.onCite(annotation)),
      actionButton('delete', 'trash', rt('reader.annot.delete'), () => props.onDelete(annotation)),
    ),
    translating
      ? React.createElement('div', { className: 'ph-r-popover__translation' }, React.createElement(Spinner, { size: 11 }), React.createElement('span', null, rt('reader.popover.translating')))
      : translation
        ? React.createElement(
            'div',
            { className: 'ph-r-popover__translation' },
            translation.status === 'translated' || translation.translation
              ? React.createElement('div', { className: 'ph-r-popover__translationtext' }, firstText(translation.translation))
              : React.createElement(
                  'div',
                  { className: 'ph-r-resultcard__warn' },
                  rt('reader.selection.quickUnavailable', { reason: firstText(translation.reason, rt('reader.ai.reasonFallback')) }),
                ),
            React.createElement(
              'div',
              { className: 'ph-r-popover__translationmeta' },
              translation.engine || translation.provider
                ? React.createElement('span', null, engineBadge(translation.engine, translation.model, translation.latencyMs, translation.cached))
                : translation.model
                  ? React.createElement('span', null, String(translation.model).split('/').pop())
                  : null,
              translation.translation && props.onAiTranslate
                ? React.createElement('button', { type: 'button', className: 'ph-r-popover__expand', onClick: aiTranslate, disabled: translating }, rt('reader.selection.aiRefine'))
                : null,
              translation.translation
                ? React.createElement(
                    'button',
                    {
                      type: 'button',
                      className: 'ph-r-popover__expand',
                      onClick: () => {
                        try {
                          if (typeof navigator !== 'undefined' && navigator.clipboard) navigator.clipboard.writeText(firstText(translation.translation))
                        } catch {
                          /* clipboard unavailable */
                        }
                      },
                    },
                    rt('reader.selection.copyTranslation'),
                  )
                : null,
            ),
          )
        : null,
  )
}

/* -------------------------------------------------------------------------- */
/* Note composer                                                               */
/* -------------------------------------------------------------------------- */

/**
 * Create a sticky note at a page position (composer-first so no empty notes are
 * written). Position is supplied by the page canvas through `style`.
 */
export function NoteComposer(props) {
  const rt = props.t
  const [text, setText] = React.useState('')
  const [color, setColor] = React.useState(props.color || 'yellow')
  const [saving, setSaving] = React.useState(false)
  const textareaRef = React.useRef(null)

  React.useEffect(() => {
    const timer = setTimeout(() => {
      if (textareaRef.current && typeof textareaRef.current.focus === 'function') textareaRef.current.focus()
    }, 30)
    return () => clearTimeout(timer)
  }, [])

  const save = () => {
    const value = text.trim()
    if (!value || saving) return
    setSaving(true)
    Promise.resolve(props.onSave({ text: value, color }))
      .catch(() => {
        /* shell surfaced the error */
      })
      .then(() => setSaving(false))
  }

  return React.createElement(
    'div',
    { className: cx('ph-r-card', 'ph-r-noteform'), style: props.style, onMouseDown: (event) => event.stopPropagation() },
    React.createElement(
      'div',
      { className: 'ph-r-noteform__title' },
      React.createElement(Icon, { name: 'sticky', size: 14 }),
      React.createElement('span', null, rt('reader.note.title')),
      React.createElement('span', { className: 'ph-r-popover__spacer' }),
      React.createElement(IconBtn, { icon: 'close', title: rt('reader.note.cancel'), onClick: props.onCancel }),
    ),
    React.createElement('textarea', {
      ref: textareaRef,
      className: 'ph-r-popover__textarea',
      value: text,
      rows: 3,
      placeholder: rt('reader.note.placeholder'),
      onChange: (event) => setText(event.target.value),
      onKeyDown: (event) => {
        if (event.key === 'Escape') {
          event.stopPropagation()
          props.onCancel()
        }
        if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {
          event.preventDefault()
          save()
        }
      },
    }),
    React.createElement(ColorPens, { t: rt, value: color, onChange: setColor }),
    React.createElement(
      'div',
      { className: 'ph-r-noteform__actions' },
      React.createElement(Btn, { size: 'sm', variant: 'ghost', onClick: props.onCancel }, rt('reader.note.cancel')),
      React.createElement(
        Btn,
        { size: 'sm', variant: 'solid', onClick: save, disabled: saving || text.trim() === '' },
        saving ? React.createElement(Spinner, { size: 11 }) : React.createElement(Icon, { name: 'check', size: 12 }),
        ' ',
        rt('reader.note.save'),
      ),
    ),
  )
}

/* -------------------------------------------------------------------------- */
/* Annotation list panel (right-hand “批注” tab)                               */
/* -------------------------------------------------------------------------- */

/**
 * @param {object} props
 * @param {object} props.t
 * @param {Array} props.annotations All normalised annotations of the paper.
 * @param {number} props.page Current page.
 * @param {string|null} props.activeId
 * @param {Function} props.onSelect annotation -> open popover / jump.
 * @param {Function} props.onCite
 * @param {Function} props.onDelete
 */
export function AnnotationListPanel(props) {
  const rt = props.t
  const [colorFilter, setColorFilter] = React.useState('all')
  const [kindFilter, setKindFilter] = React.useState('all')
  const annotations = (props.annotations || []).slice().sort((left, right) => {
    return left.page - right.page || String(left.createdAt).localeCompare(String(right.createdAt))
  })
  const filtered = annotations.filter((annotation) => {
    if (colorFilter !== 'all' && annotation.color !== colorFilter) return false
    if (kindFilter !== 'all' && annotation.kind !== kindFilter) return false
    return true
  })

  if (annotations.length === 0) {
    return React.createElement(Empty, {
      icon: 'highlighter',
      title: rt('reader.annot.empty'),
      desc: rt('reader.annot.emptyDesc'),
    })
  }

  const filters = React.createElement(
    'div',
    { className: 'ph-r-annotfilters' },
    React.createElement(
      'div',
      { className: 'ph-r-annotfilters__row' },
      React.createElement(
        'button',
        {
          type: 'button',
          className: cx('ph-r-annotfilters__chip', colorFilter === 'all' && 'ph-r-annotfilters__chip--active'),
          onClick: () => setColorFilter('all'),
        },
        rt('reader.annot.filter.allColors'),
      ),
      ANNOTATION_COLORS.map((name) =>
        React.createElement(
          'button',
          {
            key: name,
            type: 'button',
            className: cx('ph-r-annotfilters__swatch', colorFilter === name && 'ph-r-annotfilters__swatch--active'),
            style: { background: colorHex(name) },
            title: rt('reader.annot.color.' + name),
            'aria-label': rt('reader.annot.color.' + name),
            'aria-pressed': colorFilter === name ? 'true' : 'false',
            onClick: () => setColorFilter((value) => (value === name ? 'all' : name)),
          },
        ),
      ),
    ),
    React.createElement(
      'div',
      { className: 'ph-r-annotfilters__row' },
      ['all', 'highlight', 'area', 'note'].map((kind) =>
        React.createElement(
          'button',
          {
            key: kind,
            type: 'button',
            className: cx('ph-r-annotfilters__chip', kindFilter === kind && 'ph-r-annotfilters__chip--active'),
            onClick: () => setKindFilter(kind),
          },
          kind === 'all' ? rt('reader.annot.filter.allKinds') : annotationKindLabel(rt, kind),
        ),
      ),
      React.createElement('span', { className: 'ph-r-annotfilters__count' }, rt('reader.annot.filter.count', { shown: filtered.length, total: annotations.length })),
    ),
  )

  return React.createElement(
    'div',
    { className: 'ph-r-annotlistwrap' },
    filters,
    filtered.length === 0
      ? React.createElement(Empty, { icon: 'highlighter', title: rt('reader.annot.filter.empty'), desc: rt('reader.annot.filter.emptyDesc') })
      : React.createElement(
          'div',
          { className: 'ph-r-annotlist' },
          filtered.map((annotation) =>
            React.createElement(
              'div',
              {
                key: annotation.id,
                className: cx('ph-r-annotcard', annotation.id === props.activeId && 'ph-r-annotcard--active'),
                onClick: () => props.onSelect(annotation),
                role: 'button',
                tabIndex: 0,
                onKeyDown: (event) => {
                  if (event.key === 'Enter' || event.key === ' ') {
                    event.preventDefault()
                    props.onSelect(annotation)
                  }
                },
              },
              React.createElement(
                'div',
                { className: 'ph-r-annotcard__head' },
                React.createElement('span', { className: 'ph-r-annotcard__swatch', style: { background: colorHex(annotation.color) } }),
                React.createElement(Badge, { tone: annotation.origin === 'ai_explanation' ? 'business' : 'muted' }, annotationKindLabel(rt, annotation.kind)),
                React.createElement('span', { className: 'ph-r-annotcard__page' }, rt('reader.annot.pageChip', { page: annotation.page })),
                React.createElement('span', { className: 'ph-r-annotcard__spacer' }),
                React.createElement(
                  'span',
                  { className: 'ph-r-annotcard__actions' },
                  React.createElement(IconBtn, {
                    icon: 'quote',
                    title: rt('reader.annot.cite'),
                    onClick: (event) => {
                      event.stopPropagation()
                      props.onCite(annotation)
                    },
                  }),
                  React.createElement(IconBtn, {
                    icon: 'trash',
                    title: rt('reader.annot.delete'),
                    onClick: (event) => {
                      event.stopPropagation()
                      props.onDelete(annotation)
                    },
                  }),
                ),
              ),
              annotation.quote
                ? React.createElement('p', { className: 'ph-r-annotcard__quote' }, annotation.quote)
                : null,
              annotation.comment
                ? React.createElement('div', { className: 'ph-r-annotcard__comment' }, annotation.comment)
                : React.createElement('div', { className: 'ph-r-annotcard__foot' }, rt('reader.annot.commentEmpty')),
              React.createElement(
                'div',
                { className: 'ph-r-annotcard__foot' },
                formatTime(annotation.createdAt),
                annotation.page !== props.page ? React.createElement('span', null, ' · ' + rt('reader.annot.jump', { page: annotation.page })) : null,
              ),
            ),
          ),
        ),
  )
}
