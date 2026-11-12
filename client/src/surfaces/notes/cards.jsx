/**
 * v2 note renderer: a continuous, varied research document (not a stack of cards).
 *
 * The AI only ever re-lays-out the *finished* sections; `contentMd` stays the
 * single source of truth. Per section:
 *
 *   - `plain`   — continuous document text (default, no chrome);
 *   - `accent`  — a quiet tinted emphasis block for a key point;
 *   - `columns` — the section body flows in two columns (tables/figures span);
 *   - `figure`  — figure-forward section with one real paper figure;
 *
 * Blocks: heading / paragraph / bullets / table / quote / callout / figure /
 * columns. Figure blocks can only come from real `figures.list` candidates (the
 * client validates `figureId`), render the real crop + caption, and open the
 * reader on the figure's page when a handler is provided.
 *
 * A section whose stored `sourceHash` no longer matches the live text (edited,
 * never beautified, or marked unfinished) renders the original Markdown instead,
 * labelled 「原文」 so the state is never ambiguous.
 */
import React from 'react'
import { Icon } from '../../core/icons.jsx'
import { Markdown } from '../reader/markdown.jsx'

/** Build the reader URL handler once. */
function figureClick(props, block) {
  if (typeof props.onOpenFigure !== 'function') return null
  return () => props.onOpenFigure(block.paperId, block.page, block.figureId)
}

/** Caption without the duplicated 「图 3」 prefix already shown in the label chip. */
function captionWithoutLabel(block) {
  const caption = String(block.caption || '')
  const label = String(block.label || '')
  const escape = (value) => String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  if (label) {
    const patterns = [
      new RegExp('^图\\s*' + escape(label) + '\\s*[.、:：\\-—]?\\s*'),
      new RegExp('^Fig(?:ure)?\\.?\\s*' + escape(label) + '\\s*[.、:：\\-—]?\\s*', 'i'),
    ]
    for (const pattern of patterns) {
      if (pattern.test(caption)) return caption.replace(pattern, '').trim()
    }
    return caption
  }
  return caption.replace(/^图\s*\d+[.、:：\-—]?\s*/, '').replace(/^Fig(?:ure)?\.?\s*\d+[.、:：\-—]?\s*/i, '').trim()
}

/** One real paper figure with its caption. */
function FigureBlock(props) {
  const t = props.t
  const block = props.block
  const captionText = captionWithoutLabel(block)
  const onClick = figureClick(props, block)
  const media = React.createElement('img', {
    className: 'ph-n-doc__figure-img',
    src: block.imageUrl || '/pappers-hall/figure/' + block.figureId + '.png',
    alt: block.caption || (block.label ? t('notes.figure.label', { label: block.label }) : ''),
    loading: 'lazy',
  })
  return React.createElement(
    'figure',
    { className: 'ph-n-doc__figure', 'data-figure-id': block.figureId },
    onClick
      ? React.createElement('button', { type: 'button', className: 'ph-n-doc__figure-media', onClick, title: t('notes.figure.open') }, media)
      : React.createElement('div', { className: 'ph-n-doc__figure-media' }, media),
    React.createElement(
      'figcaption',
      { className: 'ph-n-doc__figure-cap' },
      React.createElement('span', { className: 'ph-n-doc__figure-label' }, t('notes.figure.label', { label: block.label || '?' })),
      React.createElement('span', { className: 'ph-n-doc__figure-text' }, captionText),
      onClick
        ? React.createElement(
            'button',
            { type: 'button', className: 'ph-n-doc__figure-jump', onClick, title: t('notes.figure.open') },
            React.createElement(Icon, { name: 'external', size: 11 }),
            t('notes.figure.openShort'),
          )
        : null,
    ),
  )
}

/** Two-column block (nested text blocks; columns must be exactly two). */
function ColumnsBlock(props) {
  const columns = Array.isArray(props.block.columns) ? props.block.columns : []
  return React.createElement(
    'div',
    { className: 'ph-n-doc__columns' },
    columns.map((column, index) =>
      React.createElement(
        'div',
        { key: index, className: 'ph-n-doc__col' },
        (column.blocks || []).map((block, blockIndex) => React.createElement(Block, { key: blockIndex, block: block, t: props.t, onOpenFigure: props.onOpenFigure })),
      ),
    ),
  )
}

/** One content block. */
function Block(props) {
  const block = props.block
  if (!block || !block.type) return null
  if (block.type === 'heading') return React.createElement('h4', { className: 'ph-n-doc__h' }, block.text)
  if (block.type === 'paragraph') return React.createElement('p', { className: 'ph-n-doc__p' }, block.text)
  if (block.type === 'quote') return React.createElement('blockquote', { className: 'ph-n-doc__quote' }, block.text)
  if (block.type === 'bullets') {
    return React.createElement(
      'ul',
      { className: 'ph-n-doc__ul' },
      (block.items || []).map((item, index) => React.createElement('li', { key: index }, item)),
    )
  }
  if (block.type === 'table') {
    const width = block.width || Math.max(block.headers.length, ...block.rows.map((row) => row.length))
    const head = block.headers.length > 0
      ? React.createElement(
          'thead',
          null,
          React.createElement(
            'tr',
            null,
            Array.from({ length: width }, (_, index) => React.createElement('th', { key: index }, block.headers[index] || '')),
          ),
        )
      : null
    return React.createElement(
      'div',
      { className: 'ph-n-doc__tablewrap' },
      React.createElement(
        'table',
        { className: 'ph-n-doc__table' },
        head,
        React.createElement(
          'tbody',
          null,
          block.rows.map((row, rowIndex) =>
            React.createElement(
              'tr',
              { key: rowIndex },
              Array.from({ length: width }, (_, cellIndex) => React.createElement('td', { key: cellIndex }, row[cellIndex] || '')),
            ),
          ),
        ),
      ),
    )
  }
  if (block.type === 'callout') {
    const tone = block.tone === 'warn' || block.tone === 'success' ? ' ph-n-doc__callout--' + block.tone : ''
    const icon = block.tone === 'warn' ? 'warning' : block.tone === 'success' ? 'checkCircle' : 'info'
    return React.createElement(
      'div',
      { className: 'ph-n-doc__callout' + tone },
      React.createElement(Icon, { name: icon, size: 14, className: 'ph-n-doc__callout-icon' }),
      React.createElement(
        'div',
        { className: 'ph-n-doc__callout-body' },
        block.title ? React.createElement('div', { className: 'ph-n-doc__callout-title' }, block.title) : null,
        React.createElement('div', null, block.text),
      ),
    )
  }
  if (block.type === 'figure') return React.createElement(FigureBlock, { t: props.t, block: block, onOpenFigure: props.onOpenFigure })
  if (block.type === 'columns') return React.createElement(ColumnsBlock, { t: props.t, block: block, onOpenFigure: props.onOpenFigure })
  return null
}

/** Wide blocks must not be split/flowed by the two-column section layout. */
function isWideBlock(block) {
  return Boolean(block && (block.type === 'table' || block.type === 'figure' || block.type === 'columns'))
}

/** Section heading label: the stored heading, the Markdown heading, or neutral. */
function headingLabel(row) {
  return row.heading || row.section.heading || ''
}

/** Tiny meta chips (AI / 原文 / 未完成) — deliberately light, never card chrome. */
function SectionBadges(props) {
  const t = props.t
  const row = props.row
  const incomplete = props.incomplete
  return React.createElement(
    'span',
    { className: 'ph-n-doc__badges' },
    row.beautified
      ? React.createElement('span', { className: 'ph-n-doc__badge ph-n-doc__badge--ai', title: t('notes.cards.beautifiedHint') }, React.createElement(Icon, { name: 'sparkle', size: 10 }), 'AI')
      : React.createElement('span', { className: 'ph-n-doc__badge', title: t('notes.cards.originalHint') }, t('notes.cards.original')),
    incomplete
      ? React.createElement('span', { className: 'ph-n-doc__badge ph-n-doc__badge--warn', title: t('notes.cards.incompleteHint') }, t('notes.sections.incomplete'))
      : null,
    props.onToggleIncomplete
      ? React.createElement(
          'button',
          {
            type: 'button',
            className: 'ph-n-doc__toggle' + (incomplete ? ' ph-n-doc__toggle--warn' : ''),
            title: t('notes.cards.toggleHint'),
            onClick: () => props.onToggleIncomplete(row.section.id),
          },
          incomplete ? t('notes.sections.markComplete') : t('notes.sections.markIncomplete'),
        )
      : null,
  )
}

/**
 * @param {object} props
 * @param {object} props.t
 * @param {Array<{section:object, blocks:Array|null, style:string, heading:string, beautified:boolean}>} props.rows
 * @param {Array<string>} [props.incompleteIds]
 * @param {Function} [props.onToggleIncomplete] section id toggle
 * @param {Function} [props.onOpenFigure] `(paperId, page, figureId)` open the reader
 */
export function NoteCards(props) {
  const t = props.t
  const rows = Array.isArray(props.rows) ? props.rows : []
  const incomplete = new Set(Array.isArray(props.incompleteIds) ? props.incompleteIds : [])
  if (rows.length === 0) {
    return React.createElement(
      'div',
      { className: 'ph-n-doc__empty' },
      React.createElement('p', { className: 'ph-n-caption' }, t('notes.cards.empty')),
    )
  }
  return React.createElement(
    'div',
    { className: 'ph-n-doc' },
    rows.map((row) => {
      const section = row.section || {}
      const isIncomplete = incomplete.has(section.id)
      const style = row.beautified ? row.style || 'plain' : 'plain'
      const classes = ['ph-n-doc__sec', 'ph-n-doc__sec--' + style]
      if (!row.beautified) classes.push('ph-n-doc__sec--original')
      if (isIncomplete) classes.push('ph-n-doc__sec--incomplete')
      const heading = headingLabel(row)
      const body = row.beautified
        ? React.createElement(
            'div',
            { className: 'ph-n-doc__body' + (style === 'columns' ? ' ph-n-doc__flow' : '') },
            (row.blocks || []).map((block, index) =>
              React.createElement(
                'div',
                { key: index, className: 'ph-n-doc__block' + (isWideBlock(block) ? ' ph-n-doc__block--wide' : '') },
                React.createElement(Block, { t: t, block: block, onOpenFigure: props.onOpenFigure }),
              ),
            ),
          )
        : React.createElement(
            'div',
            { className: 'ph-n-doc__body ph-n-doc__body--original' },
            React.createElement(Markdown, { text: section.text || '', className: 'ph-n-md', keyPrefix: 'sec-' + section.id }),
          )
      return React.createElement(
        'section',
        { key: section.id, className: classes.join(' '), 'data-section-id': section.id, 'data-style': style, 'data-beautified': row.beautified ? 'true' : 'false' },
        React.createElement(
          'div',
          { className: 'ph-n-doc__eyebrow' },
          heading ? React.createElement('h3', { className: 'ph-n-doc__heading', title: heading }, heading) : React.createElement('span', { className: 'ph-n-doc__heading ph-n-doc__heading--none' }, t('notes.section.untitled')),
          React.createElement(SectionBadges, {
            t: t,
            row: row,
            incomplete: isIncomplete,
            onToggleIncomplete: props.onToggleIncomplete,
          }),
        ),
        body,
        !row.beautified && !isIncomplete
          ? React.createElement('p', { className: 'ph-n-doc__note' }, t('notes.cards.staleHint'))
          : null,
      )
    }),
  )
}

/** Small helper: how many sections a given contentJson actually covers. */
export function summariseCards(rows) {
  const list = Array.isArray(rows) ? rows : []
  const styles = {}
  for (const row of list) {
    const style = row.beautified ? row.style || 'plain' : 'original'
    styles[style] = (styles[style] || 0) + 1
  }
  return {
    total: list.length,
    beautified: list.filter((row) => row.beautified).length,
    stale: list.filter((row) => !row.beautified).length,
    styles,
  }
}
