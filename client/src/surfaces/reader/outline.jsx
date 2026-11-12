/**
 * Outline (table of contents) tab.
 *
 * Renders the Host-provided outline (`reader.outline.items`) with indentation by
 * level; the entry matching the current page is highlighted, falling back to the
 * closest preceding entry when the current page has no exact match.
 */
import React from 'react'
import { Badge, Empty, Icon, cx, num } from './shared.jsx'

/**
 * @param {object} props
 * @param {object} props.t
 * @param {Array} props.items `[{title, page, level}]`
 * @param {number} props.page
 * @param {boolean} props.loading
 * @param {string} props.error
 * @param {Function} props.onJump page -> jump
 * @param {Function} props.onRetry
 */
export function Outline(props) {
  const t = props.t
  const items = Array.isArray(props.items)
    ? props.items
        .filter((item) => item && (item.title || item.page))
        .map((item) => ({
          title:
            String(item.title || '').trim() ||
            (item.page == null ? t('reader.outline.title') : t('reader.outline.page', { page: num(item.page, 1) })),
          // Heuristic outlines may not resolve a page (Host returns null); keep
          // the entry visible but non-jumpable instead of pretending it is page 1.
          page: item.page == null || item.page === '' ? null : Math.max(1, Math.round(num(item.page, 1))),
          level: Math.max(1, Math.min(4, Math.round(num(item.level, 1)))),
        }))
    : []

  if (props.loading && items.length === 0) {
    return React.createElement(
      'div',
      { className: 'ph-r-outline', 'aria-busy': 'true' },
      [1, 2, 3, 4, 5].map((index) =>
        React.createElement('div', { key: index, style: { padding: '7px 8px' } },
          React.createElement('span', { className: 'ph-r-skeleton', style: { width: 40 + ((index * 37) % 50) + '%', height: 11 } }),
        ),
      ),
    )
  }

  if (props.error && items.length === 0) {
    return React.createElement(Empty, {
      icon: 'warning',
      tone: 'error',
      title: t('reader.outline.empty'),
      desc: String(props.error),
      action: props.onRetry
        ? React.createElement('button', { type: 'button', className: 'ph-r-btn ph-r-btn--soft ph-r-btn--sm', onClick: props.onRetry },
            React.createElement(Icon, { name: 'refresh', size: 13 }),
            React.createElement('span', null, t('reader.retry')),
          )
        : null,
    })
  }

  if (items.length === 0) {
    return React.createElement(Empty, {
      icon: 'list',
      title: t('reader.outline.empty'),
      desc: t('reader.outline.emptyDesc'),
    })
  }

  let activeIndex = -1
  for (let index = 0; index < items.length; index += 1) {
    const itemPage = items[index].page
    if (itemPage != null && itemPage <= props.page) activeIndex = index
  }
  if (activeIndex < 0 && items.length > 0) activeIndex = 0

  return React.createElement(
    'div',
    { className: 'ph-r-outline' },
    React.createElement(
      'div',
      { style: { display: 'flex', alignItems: 'center', gap: 6, padding: '4px 8px 6px' } },
      React.createElement(Icon, { name: 'list', size: 13 }),
      React.createElement('span', { style: { fontSize: 11, fontWeight: 600, color: 'var(--dsw-alias-label-secondary)' } }, t('reader.outline.title')),
      React.createElement(Badge, null, String(items.length)),
    ),
    items.map((item, index) =>
      React.createElement(
        'button',
        {
          key: index + ':' + item.page + ':' + item.title,
          type: 'button',
          className: cx('ph-r-outline__item', index === activeIndex && 'ph-r-outline__item--active'),
          style: { paddingLeft: 8 + (item.level - 1) * 13 },
          onClick: () => {
            if (item.page != null) props.onJump(item.page)
          },
          title: item.page == null ? item.title : t('reader.outline.jump', { title: item.title }),
          disabled: item.page == null,
          'aria-current': index === activeIndex ? 'location' : undefined,
        },
        React.createElement('span', { className: 'ph-r-outline__level' }, String(item.level)),
        React.createElement('span', { className: 'ph-r-outline__label' }, item.title),
        React.createElement('span', { className: 'ph-r-outline__page' }, item.page == null ? '—' : String(item.page)),
      ),
    ),
  )
}
