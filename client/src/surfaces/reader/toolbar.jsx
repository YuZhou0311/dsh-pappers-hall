/**
 * Reader toolbar: identity row (back / title / cite / PDF / AI) plus a tool row
 * (pager, zoom, reading mode, annotation modes, in-page find, side panel).
 *
 * The toolbar itself is static; the scroll-collapse glass effect is applied by
 * the shell through the `ph-r-reader--scrolled` root class so the whole header
 * shrinks together (CSS transitions only, honouring reduced motion).
 */
import React from 'react'
import { Btn, Icon, IconBtn, arrayOf, cx, firstText, num } from './shared.jsx'
import { SlidingThumb, useSlidingThumb } from '../../core/motion.js'

/** Build a single-line author list. */
function authorLine(authors) {
  const list = arrayOf(authors)
  const names = []
  for (const author of list) {
    if (!author || typeof author !== 'object') continue
    if (author.family) names.push([author.given, author.family].filter(Boolean).join(' '))
    else if (author.literal) names.push(author.literal)
    if (names.length === 3) break
  }
  if (names.length === 0) return ''
  return list.length > 3 ? names.join(', ') + ' et al.' : names.join(', ')
}

/** Paper title shown in the toolbar (Chinese metadata first). */
function displayTitle(paper, rt) {
  if (!paper) return rt('reader.untitled')
  return firstText(paper.titleZh, paper.displayTitle, paper.title, rt('reader.untitled'))
}

/** Original-language title when it differs from the displayed one. */
function originalTitle(paper) {
  if (!paper) return ''
  const title = firstText(paper.title)
  const shown = firstText(paper.titleZh, paper.displayTitle, paper.title)
  return title && title !== shown ? title : ''
}

/**
 * @param {object} props
 * @param {object} props.t Reader translator.
 * @param {object|null} props.paper
 * @param {number} props.total
 * @param {number} props.page
 * @param {number} props.zoom
 * @param {'source'|'compare'|'translation'} props.mode
 * @param {'select'|'area'|'note'} props.tool
 * @param {boolean} props.sideOpen
 * @param {string} props.sideTab
 * @param {object} props.search `{open, query, hits, index}`
 * @param {boolean} props.loading
 * @param {Function} props.onBack
 * @param {Function} props.onCite
 * @param {Function} props.onPage
 * @param {Function} props.onZoomStep
 * @param {Function} props.onZoomFit
 * @param {Function} props.onMode
 * @param {Function} props.onTool
 * @param {Function} props.onSearchToggle
 * @param {Function} props.onSearchQuery
 * @param {Function} props.onSearchNext
 * @param {Function} props.onToggleAi
 * @param {Function} props.onToggleNotes
 * @param {Function} props.onToggleSide
 */
export function ReaderToolbar(props) {
  const rt = props.t
  const paper = props.paper
  const title = displayTitle(paper, rt)
  const original = originalTitle(paper)
  const authors = authorLine(paper && paper.authors)
  const total = Math.max(1, Math.round(num(props.total, 1)))
  const page = Math.max(1, Math.min(total, Math.round(num(props.page, 1))))
  const search = props.search || { open: false, query: '', hits: [], index: 0 }
  const searchInputRef = React.useRef(null)
  const modeSlider = useSlidingThumb()

  React.useEffect(() => {
    if (!search.open) return
    const timer = setTimeout(() => {
      const element = searchInputRef.current
      if (element && typeof element.focus === 'function') element.focus()
    }, 30)
    return () => clearTimeout(timer)
  }, [search.open])

  const commitPage = (raw) => {
    const value = Math.round(num(raw, page))
    if (value < 1 || value > total) {
      props.onPage(page)
      return
    }
    if (value !== page) props.onPage(value)
  }

  const metaParts = []
  if (authors) metaParts.push(authors)
  if (paper && paper.year) metaParts.push(String(paper.year))
  const venue = firstText(paper && paper.venue, paper && paper.containerTitle)
  if (venue) metaParts.push(venue)
  if (paper && paper.pageCount) metaParts.push(rt('reader.pagesCount', { count: paper.pageCount }))

  const modeItems = [
    { id: 'source', label: rt('reader.mode.source') },
    { id: 'compare', label: rt('reader.mode.compare') },
    { id: 'translation', label: rt('reader.mode.translation') },
  ]

  return React.createElement(
    'div',
    { className: 'ph-r-toolbar', role: 'toolbar', 'aria-label': rt('reader.mode.label') },
    /* ---------------- identity row ---------------- */
    React.createElement(
      'div',
      { className: 'ph-r-toolbar__row ph-r-toolbar__row--main' },
      React.createElement(
        Btn,
        {
          className: 'ph-r-toolbar__back',
          size: 'sm',
          variant: 'ghost',
          icon: 'arrowLeft',
          onClick: props.onBack,
          title: rt('reader.back'),
        },
        rt('reader.back'),
      ),
      React.createElement(
        'div',
        { className: 'ph-r-toolbar__titles' },
        React.createElement(
          'div',
          { className: 'ph-r-toolbar__titleline' },
          React.createElement('h1', { className: 'ph-r-toolbar__title', title: String(title) }, title),
          React.createElement('span', { className: 'ph-r-toolbar__badge' }, rt('reader.pageOf', { page, total })),
        ),
        React.createElement(
          'div',
          { className: 'ph-r-toolbar__meta', title: original ? original + (metaParts.length ? ' · ' + metaParts.join(' · ') : '') : metaParts.join(' · ') },
          original ? React.createElement('span', { style: { opacity: 0.85, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis' } }, original) : null,
          original && metaParts.length ? React.createElement('span', { className: 'ph-r-toolbar__meta-sep' }, '·') : null,
          metaParts.length ? React.createElement('span', { style: { minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis' } }, metaParts.join(' · ')) : null,
        ),
      ),
      React.createElement(
        'div',
        { className: 'ph-r-toolbar__actions' },
        React.createElement(Btn, { size: 'sm', variant: 'soft', icon: 'quote', onClick: props.onCite, title: rt('reader.cite') }, rt('reader.cite')),
        React.createElement(
          'a',
          {
            className: 'ph-r-btn ph-r-btn--ghost ph-r-btn--sm',
            href: '/pappers-hall/pdf/' + encodeURIComponent(String((paper && paper.id) || '')),
            target: '_blank',
            rel: 'noopener noreferrer',
            title: rt('reader.openPdf'),
          },
          React.createElement(Icon, { name: 'external', size: 14 }),
          React.createElement('span', { className: 'ph-r-btn__label' }, rt('reader.openPdf')),
        ),
        React.createElement(
          Btn,
          {
            size: 'sm',
            variant: props.sideOpen && props.sideTab === 'notes' ? 'solid' : 'soft',
            icon: 'note',
            onClick: props.onToggleNotes,
            title: rt('reader.notes.tab'),
            active: props.sideOpen && props.sideTab === 'notes',
          },
          rt('reader.notes.tab'),
        ),
        React.createElement(
          Btn,
          {
            size: 'sm',
            variant: props.sideOpen && props.sideTab === 'ai' ? 'solid' : 'soft',
            icon: 'sparkles',
            onClick: props.onToggleAi,
            title: rt('reader.ai'),
            active: props.sideOpen && props.sideTab === 'ai',
          },
          'AI',
        ),
        props.onOpenSettings
          ? React.createElement(IconBtn, {
              icon: 'settings',
              title: '设置',
              'aria-label': '设置',
              onClick: props.onOpenSettings,
            })
          : null,
      ),
    ),
    /* ---------------- tool row ---------------- */
    React.createElement(
      'div',
      { className: 'ph-r-toolbar__row ph-r-toolbar__row--tools' },
      React.createElement(
        'div',
        { className: 'ph-r-pager', role: 'group', 'aria-label': rt('reader.pageOf', { page, total }) },
        React.createElement(IconBtn, {
          icon: 'chevronLeft',
          title: rt('reader.prevPage'),
          disabled: page <= 1 || props.loading,
          onClick: () => props.onPage(Math.max(1, page - 1)),
        }),
        React.createElement('input', {
          key: 'page-input-' + page,
          className: 'ph-r-pager__input',
          type: 'text',
          inputMode: 'numeric',
          defaultValue: String(page),
          'aria-label': rt('reader.jumpPage'),
          title: rt('reader.jumpPage'),
          onKeyDown: (event) => {
            if (event.key === 'Enter') {
              event.preventDefault()
              commitPage(event.currentTarget.value)
              event.currentTarget.blur()
            }
            if (event.key === 'Escape') event.currentTarget.blur()
          },
          onBlur: (event) => commitPage(event.currentTarget.value),
        }),
        React.createElement('span', { className: 'ph-r-pager__total' }, '/ ' + total),
        React.createElement(IconBtn, {
          icon: 'chevronRight',
          title: rt('reader.nextPage'),
          disabled: page >= total || props.loading,
          onClick: () => props.onPage(Math.min(total, page + 1)),
        }),
      ),
      React.createElement('span', { className: 'ph-r-toolbar__meta-sep' }, ''),
      React.createElement(
        'div',
        { className: 'ph-r-zoom', role: 'group', 'aria-label': rt('reader.zoomValue', { percent: Math.round(props.zoom * 100) }) },
        React.createElement(IconBtn, { icon: 'zoomOut', title: rt('reader.zoomOut'), onClick: () => props.onZoomStep(-1) }),
        React.createElement(
          'button',
          {
            type: 'button',
            className: 'ph-r-zoom__value',
            title: rt('reader.zoomFit'),
            onClick: props.onZoomFit,
          },
          Math.round(num(props.zoom, 1) * 100) + '%',
        ),
        React.createElement(IconBtn, { icon: 'zoomIn', title: rt('reader.zoomIn'), onClick: () => props.onZoomStep(1) }),
        React.createElement(IconBtn, { icon: 'fit', title: rt('reader.zoomFit'), onClick: props.onZoomFit }),
      ),
      React.createElement('span', { className: 'ph-r-toolbar__meta-sep' }, ''),
      React.createElement(
        'div',
        {
          className: cx('ph-r-segment', modeSlider.rect && 'ph-r-segment--sliding'),
          ref: modeSlider.ref,
          role: 'group',
          'aria-label': rt('reader.mode.label'),
        },
        React.createElement(SlidingThumb, { rect: modeSlider.rect, inset: 2, popKey: props.mode }),
        modeItems.map((item) =>
          React.createElement(
            'button',
            {
              key: item.id,
              type: 'button',
              'data-ph-active': props.mode === item.id ? 'true' : undefined,
              className: cx('ph-r-segment__item', props.mode === item.id && 'ph-r-segment__item--active'),
              onClick: () => props.onMode(item.id),
              'aria-pressed': props.mode === item.id ? 'true' : 'false',
            },
            item.label,
          ),
        ),
      ),
      React.createElement('span', { className: 'ph-r-toolbar__spacer' }),
      search.open
        ? React.createElement(
            'div',
            { className: 'ph-r-find' },
            React.createElement(Icon, { name: 'search', size: 13, className: 'ph-r-find__icon' }),
            React.createElement('input', {
              ref: searchInputRef,
              className: 'ph-r-find__input',
              type: 'text',
              value: search.query,
              placeholder: rt('reader.search.placeholder'),
              'aria-label': rt('reader.search.title'),
              onChange: (event) => props.onSearchQuery(event.target.value),
              onKeyDown: (event) => {
                if (event.key === 'Enter') {
                  event.preventDefault()
                  props.onSearchNext(event.shiftKey ? -1 : 1)
                }
                if (event.key === 'Escape') {
                  event.preventDefault()
                  props.onSearchToggle(false)
                }
              },
            }),
            React.createElement(
              'span',
              { className: cx('ph-r-find__count', search.query && search.hits.length === 0 && 'ph-r-find__count--empty') },
              !search.query
                ? ''
                : search.hits.length === 0
                  ? rt('reader.search.none')
                  : rt('reader.search.count', { index: Math.min(search.index + 1, search.hits.length), total: search.hits.length }),
            ),
            React.createElement(IconBtn, { icon: 'chevronUp', title: rt('reader.search.prev'), disabled: search.hits.length === 0, onClick: () => props.onSearchNext(-1) }),
            React.createElement(IconBtn, { icon: 'chevronDown', title: rt('reader.search.next'), disabled: search.hits.length === 0, onClick: () => props.onSearchNext(1) }),
            React.createElement(IconBtn, { icon: 'close', title: rt('reader.search.close'), onClick: () => props.onSearchToggle(false) }),
          )
        : React.createElement(IconBtn, { icon: 'search', title: rt('reader.search'), onClick: () => props.onSearchToggle(true) }),
      React.createElement(IconBtn, {
        icon: 'sidePanel',
        title: rt('reader.sidePanelToggle'),
        active: props.sideOpen,
        onClick: props.onToggleSide,
      }),
    ),
  )
}
