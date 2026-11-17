/**
 * Middle-pane item table (Zotero rows) and the optional grid presentation.
 * Handles click / Cmd-Ctrl / Shift selection, keyboard navigation, the read
 * dot, per-row context menu and internal material drags.
 */
import React from 'react'
import { h } from '../../core/dom.js'
import { Icon } from '../../core/icons.jsx'
import { bus } from '../../core/bus.js'
import { Badge, Button, Check, EmptyState, IconButton, Skeleton } from '../../core/primitives.jsx'
import { MATERIAL_MIME } from '../../core/constants.js'
import { dragProps } from '../../core/dnd.js'
import { tagColor } from '../../core/tag-colors.js'
import { authorLine, firstText, metaLine, paperOriginalTitle, paperTitle } from '../../core/texts.js'

const COLUMNS = ['check', 'title', 'authors', 'year', 'venue', 'tags', 'read', 'annotations']

function thumbUrl(paper) {
  return (paper && paper.thumbnailUrl) || (paper && paper.id ? '/pappers-hall/thumb/' + paper.id + '.png' : '')
}

function materialOfPaper(t, paper) {
  return { kind: 'paper', id: paper.id, title: paperTitle(t, paper) }
}

function beginDrag(event, t, papers) {
  try {
    event.dataTransfer.setData(MATERIAL_MIME, JSON.stringify({ materials: papers.map((paper) => materialOfPaper(t, paper)) }))
    event.dataTransfer.effectAllowed = 'copy'
  } catch (error) {
    /* drag is best-effort */
  }
}

function SortHeader(props) {
  const active = props.sort === props.value
  return h(
    'button',
    {
      type: 'button',
      className: 'ph-table__headcell ph-table__headcell--sortable' + (active ? ' ph-table__headcell--sorted' : ''),
      onClick: () => props.onSort(active ? 'recent' : props.value),
      title: props.title,
    },
    h('span', { className: 'ph-nowrap' }, props.title),
    active ? h(Icon, { name: 'chevronDown', size: 11 }) : null,
  )
}

function PaperTagChips(props) {
  const tags = Array.isArray(props.paper.tags) ? props.paper.tags : []
  if (tags.length === 0) return null
  return h(
    'div',
    { className: 'ph-rowitem__tags' },
    tags.slice(0, 2).map((tag) => h(Badge, { key: tag, tone: 'muted', className: 'ph-rowitem__tag', 'data-tag-color': tagColor(tag) }, tag)),
    tags.length > 2 ? h('span', { className: 'ph-caption' }, '+' + (tags.length - 2)) : null,
  )
}

function TableRow(props) {
  const t = props.t
  const paper = props.paper
  const selected = props.selected
  const title = paperTitle(t, paper)
  const original = paperOriginalTitle(paper)
  const annotations = Number(paper.annotationCount) || 0
  return h(
    'div',
    {
      className: 'ph-rowitem' + (selected ? ' ph-rowitem--selected' : ''),
      'data-ph-id': paper.id,
      role: 'row',
      'aria-selected': selected ? 'true' : 'false',
      draggable: true,
      onDragStart: (event) => dragProps(t, (props.selectedPapers && props.selectedPapers.length > 0 ? props.selectedPapers : [paper]).map((entry) => ({ kind: 'paper', id: entry.id, title: paperTitle(t, entry) })), { source: 'library-row' }).onDragStart(event),
      onDragEnd: () => dragProps(t, []).onDragEnd ? dragProps(t, []).onDragEnd() : null,
      onClick: (event) => {
        props.onSelect(paper.id, props.index, event)
        props.onDetail(paper.id)
      },
      onDoubleClick: () => props.onOpen(paper.id),
      onContextMenu: (event) => {
        event.preventDefault()
        props.onContextMenu({ x: event.clientX, y: event.clientY, paperId: paper.id })
      },
      onKeyDown: (event) => {
        if (event.key === 'Enter') {
          event.preventDefault()
          props.onOpen(paper.id)
        }
      },
    },
    h('div', { className: 'ph-rowitem__cell ph-rowitem__cell--check' }, h(Check, { checked: selected, onChange: () => props.onSelect(paper.id, props.index, { metaKey: true }), 'aria-label': title })),
    h(
      'div',
      { className: 'ph-rowitem__titlewrap' },
      h('div', { className: 'ph-rowitem__title' }, title, Number(paper.similarity) > 0 ? h('span', { className: 'ph-sim', title: t('library.search.similarity', { score: Number(paper.similarity).toFixed(2) }) }, Number(paper.similarity).toFixed(2)) : null),
      original ? h('div', { className: 'ph-rowitem__original' }, original) : null,
      paper.snippet && Number(paper.similarity) > 0 ? h('div', { className: 'ph-rowitem__snippet' }, paper.snippet) : null,
    ),
    h('div', { className: 'ph-rowitem__cell ph-rowitem__cell--authors' }, h('span', { className: 'ph-rowitem__authors' }, authorLine(paper.authors) || t('common.unknownAuthors'))),
    h('div', { className: 'ph-rowitem__cell ph-rowitem__cell--year' }, h('span', { className: 'ph-rowitem__year' }, paper.year ? String(paper.year) : '—')),
    h('div', { className: 'ph-rowitem__cell ph-rowitem__cell--venue' }, h('span', { className: 'ph-rowitem__venue' }, firstText(paper.venue, paper.containerTitle) || '—')),
    h('div', { className: 'ph-rowitem__cell ph-rowitem__cell--tags' }, h(PaperTagChips, { paper: paper })),
    h(
      'div',
      { className: 'ph-rowitem__cell ph-rowitem__read' },
      h('button', {
        type: 'button',
        className: 'ph-rowitem__dot ' + (paper.read ? 'ph-rowitem__dot--read' : 'ph-rowitem__dot--unread'),
        title: paper.read ? t('library.details.markUnread') : t('library.details.markRead'),
        'aria-label': paper.read ? t('library.details.markUnread') : t('library.details.markRead'),
        onClick: (event) => {
          event.stopPropagation()
          props.onToggleRead(paper, !paper.read)
        },
      }),
    ),
    h(
      'div',
      { className: 'ph-rowitem__cell ph-rowitem__cell--annot' },
      h('span', { className: 'ph-rowitem__annot' + (annotations > 0 ? ' ph-rowitem__annot--some' : '') }, h(Icon, { name: 'highlighter', size: 12 }), String(annotations)),
    ),
    h('div', { className: 'ph-rowitem__cell' }, h(IconButton, { icon: 'external', title: t('library.row.open'), className: 'ph-rowitem__open', onClick: (event) => { event.stopPropagation(); props.onOpen(paper.id) } })),
  )
}

function GridCard(props) {
  const t = props.t
  const paper = props.paper
  const [failed, setFailed] = React.useState(false)
  React.useEffect(() => setFailed(false), [paper.id])
  return h(
    'article',
    {
      className: 'ph-gridcard' + (props.selected ? ' ph-gridcard--selected' : ''),
      'data-ph-id': paper.id,
      tabIndex: 0,
      draggable: true,
      onDragStart: (event) => dragProps(t, [{ kind: 'paper', id: paper.id, title: paperTitle(t, paper) }], { source: 'library-grid' }).onDragStart(event),
      onClick: (event) => {
        props.onSelect(paper.id, props.index, event)
        props.onDetail(paper.id)
      },
      onDoubleClick: () => props.onOpen(paper.id),
      onKeyDown: (event) => {
        if (event.key === 'Enter') props.onOpen(paper.id)
      },
    },
    h(
      'div',
      { className: 'ph-gridcard__thumb' },
      failed ? h(Icon, { name: 'book', size: 26 }) : h('img', { src: thumbUrl(paper), alt: '', loading: 'lazy', decoding: 'async', draggable: false, onError: () => setFailed(true) }),
      h('span', { className: 'ph-card__check' }, h(Check, { checked: props.selected, onChange: () => props.onSelect(paper.id, props.index, { metaKey: true }), 'aria-label': paperTitle(t, paper) })),
    ),
    h(
      'div',
      { className: 'ph-gridcard__body' },
      h('div', { className: 'ph-gridcard__title' }, paperTitle(t, paper)),
      h('div', { className: 'ph-gridcard__meta' }, metaLine(t, paper)),
      h('div', { className: 'ph-badges' }, [
        h(Badge, { key: 'read', tone: paper.read ? 'success' : 'muted' }, paper.read ? t('page.read') : t('page.unread')),
        Number(paper.annotationCount) > 0 ? h(Badge, { key: 'annot', tone: 'business' }, t('page.annotationCount', { count: Number(paper.annotationCount) })) : null,
      ]),
    ),
  )
}

export function ItemTable(props) {
  const t = props.t
  const snapshot = props.snapshot
  const controller = props.controller
  const items = snapshot.items || []
  const selection = React.useMemo(() => new Set(snapshot.selection || []), [snapshot.selection])
  const selectedPapers = React.useMemo(() => items.filter((paper) => selection.has(paper.id)), [items, selection])
  const scrollRef = React.useRef(null)
  const [focused, setFocused] = React.useState(0)

  const ensureVisible = (index) => {
    const container = scrollRef.current
    if (!container) return
    const paper = items[index]
    if (!paper) return
    const node = container.querySelector('[data-ph-id="' + paper.id + '"]')
    if (node && typeof node.scrollIntoView === 'function') {
      try {
        node.scrollIntoView({ block: 'nearest' })
      } catch (error) {
        /* older engines */
      }
    }
  }

  const onKeyDown = (event) => {
    if (items.length === 0) return
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp' || event.key === 'Home' || event.key === 'End') {
      event.preventDefault()
      let next = focused
      if (event.key === 'ArrowDown') next = Math.min(items.length - 1, focused + 1)
      else if (event.key === 'ArrowUp') next = Math.max(0, focused - 1)
      else if (event.key === 'Home') next = 0
      else next = items.length - 1
      setFocused(next)
      const paper = items[next]
      if (paper) controller.toggleSelect(paper.id, next, {})
      ensureVisible(next)
      return
    }
    if (event.key === 'Enter') {
      const paper = items[focused]
      if (paper) {
        event.preventDefault()
        props.onOpenPaper(paper.id, 1)
      }
      return
    }
    if (event.key === ' ') {
      const paper = items[focused]
      if (paper) {
        event.preventDefault()
        controller.toggleSelect(paper.id, focused, { metaKey: true })
      }
    }
  }

  if (snapshot.status === 'loading' && items.length === 0) {
    return h(
      'div',
      { className: 'ph-table-skeleton' },
      [0, 1, 2, 3, 4, 5, 6, 7].map((index) =>
        h(
          'div',
          { key: index, className: 'ph-table-skeleton__row' },
          h(Skeleton, { width: 14, height: 14 }),
          h('div', { className: 'ph-table-skeleton__main' }, h(Skeleton, { width: '58%' }), h(Skeleton, { width: '36%', height: 9 })),
          h(Skeleton, { width: 72, height: 10 }),
          h(Skeleton, { width: 34, height: 10 }),
          h(Skeleton, { width: 64, height: 10 }),
        ),
      ),
    )
  }

  if (snapshot.status === 'error') {
    return h(EmptyState, {
      tone: 'error',
      icon: 'warning',
      title: t('library.error.title'),
      desc: (snapshot.error && snapshot.error.message) || t('common.unknownError'),
      action: h(Button, { variant: 'secondary', icon: 'refresh', onClick: () => controller.refresh() }, t('library.error.retry')),
    })
  }

  if (items.length === 0) {
    const semantic = snapshot.semantic || {}
    if (snapshot.filters.mode === 'semantic' && semantic.available === false) {
      return h(EmptyState, {
        icon: 'sparkles',
        title: t('library.search.semanticOfflineTitle'),
        desc: (semantic.reason ? semantic.reason + ' · ' : '') + t('library.search.semanticOfflineDesc'),
        action: h(Button, { variant: 'secondary', icon: 'settings', onClick: () => { try { bus.emit('open-settings') } catch (error) { /* ignore */ } } }, t('library.search.semanticOfflineAction')),
      })
    }
    const trash = snapshot.filters.view === 'trash'
    const filtering = snapshot.filters.query || snapshot.filters.tags.length > 0 || snapshot.filters.collectionId || snapshot.filters.field
    if (trash) return h(EmptyState, { icon: 'trash', title: t('library.trash.empty'), desc: t('library.trash.hint') })
    if (filtering) {
      return h(EmptyState, {
        icon: 'search',
        title: t('library.noMatch.title'),
        desc: t('library.noMatch.desc'),
        action: h(Button, { variant: 'secondary', icon: 'close', onClick: () => { controller.setView('all'); controller.setQuery('') } }, t('library.noMatch.clear')),
      })
    }
    return h(EmptyState, {
      icon: 'book',
      title: t('library.empty.title'),
      desc: t('library.empty.desc'),
    })
  }

  const allSelected = items.length > 0 && items.every((paper) => selection.has(paper.id))

  if (snapshot.viewMode === 'grid') {
    return h(
      'div',
      { className: 'ph-gridview ph-scroll', onKeyDown: onKeyDown, tabIndex: -1 },
      items.map((paper, index) =>
        h(GridCard, {
          key: paper.id,
          t: t,
          paper: paper,
          index: index,
          selected: selection.has(paper.id),
          onSelect: (id, rowIndex, event) => controller.toggleSelect(id, rowIndex, event),
          onDetail: (id) => controller.selectPaper(id),
          onOpen: props.onOpenPaper,
        }),
      ),
    )
  }

  return h(
    'div',
    { className: 'ph-table' },
    h(
      'div',
      { className: 'ph-table__head', role: 'row' },
      h('div', { className: 'ph-table__headcell ph-table__headcell--check' }, h(Check, { checked: allSelected, onChange: () => (allSelected ? controller.clearSelection() : controller.selectAll()), 'aria-label': t('library.selectAll') })),
      h(SortHeader, { sort: snapshot.filters.sort, value: 'title', title: t('library.table.title'), onSort: (value) => controller.setSort(value) }),
      h('div', { className: 'ph-table__headcell' }, t('library.table.creators')),
      h(SortHeader, { sort: snapshot.filters.sort, value: 'year', title: t('library.table.year'), onSort: (value) => controller.setSort(value) }),
      h('div', { className: 'ph-table__headcell' }, t('library.table.venue')),
      h('div', { className: 'ph-table__headcell' }, t('library.table.tags')),
      h('div', { className: 'ph-table__headcell' }, t('library.table.read')),
      h('div', { className: 'ph-table__headcell' }, t('library.table.annotations')),
      h('div', { className: 'ph-table__headcell' }),
    ),
    h(
      'div',
      { className: 'ph-table__body ph-scroll', ref: scrollRef, onKeyDown: onKeyDown, tabIndex: 0, role: 'grid', 'aria-label': t('panel.title') },
      h(
        'div',
        { className: 'ph-table__rows' },
        items.map((paper, index) =>
          h(TableRow, {
            key: paper.id,
            t: t,
            paper: paper,
            index: index,
            selected: selection.has(paper.id),
            selectedPapers: selectedPapers,
            onSelect: (id, rowIndex, event) => controller.toggleSelect(id, rowIndex, event),
            onDetail: (id) => controller.selectPaper(id),
            onOpen: props.onOpenPaper,
            onToggleRead: props.onToggleRead,
            onContextMenu: (menu) => controller.openContextMenu(menu),
          }),
        ),
      ),
    ),
    items.length < snapshot.total
      ? h('div', { className: 'ph-table__more' }, h(Button, { variant: 'ghost', icon: 'chevronDown', loading: snapshot.loadingMore, onClick: () => controller.loadMore() }, snapshot.loadingMore ? t('library.table.loadingMore') : t('library.table.loadMore')))
      : null,
  )
}
