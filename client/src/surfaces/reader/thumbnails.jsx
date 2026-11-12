/**
 * Page thumbnail rail.
 *
 * Pages are laid out with exact pixel offsets (thumbnail width is fixed, height
 * follows the real PDF aspect ratio), virtualised to the current scroll window,
 * and thumbnails load lazily as they approach the viewport. The current page is
 * marked by a sliding rail indicator plus a highlighted frame.
 */
import React from 'react'
import { Icon, cx, num, pageImageUrl, useElementSize } from './shared.jsx'

/** Width of one thumbnail image inside the rail (rail width minus paddings). */
const THUMB_INSET = 30
/** Extra rows rendered above/below the viewport. */
const OVERSCAN = 250
/** Fallback rail width when layout information is unavailable (jsdom). */
const FALLBACK_RAIL_WIDTH = 118
const DEFAULT_RATIO = 791 / 595

/** Normalise the page descriptor list (page number + aspect ratio). */
function offsetsOf(pages, total, railWidth) {
  const thumbWidth = Math.max(60, railWidth - THUMB_INSET)
  const list = Array.isArray(pages) && pages.length > 0 ? pages : null
  const count = list ? list.length : Math.max(1, Math.round(num(total, 1)))
  const items = []
  let offset = 8
  for (let index = 0; index < count; index += 1) {
    const descriptor = list ? list[index] || {} : {}
    const page = Math.max(1, Math.round(num(descriptor.page, index + 1)))
    const width = num(descriptor.width, 0) || 595
    const height = num(descriptor.height, 0) || 791
    const imageHeight = Math.round(thumbWidth * (height / width)) || Math.round(thumbWidth * DEFAULT_RATIO)
    const itemHeight = imageHeight + 26
    const reportedUrl = typeof descriptor.imageUrl === 'string' ? descriptor.imageUrl : ''
    items.push({ page, offset, imageHeight, itemHeight, width: thumbWidth, imageUrl: reportedUrl })
    offset += itemHeight
  }
  return { items, totalHeight: offset + 16, thumbWidth }
}

/**
 * @param {object} props
 * @param {object} props.t
 * @param {string} props.paperId
 * @param {Array} props.pages `reader.open.pages`
 * @param {number} props.total
 * @param {number} props.page Current page
 * @param {Function} props.onSelect page -> jump
 */
export function Thumbnails(props) {
  const t = props.t
  const scrollRef = React.useRef(null)
  const listRef = React.useRef(null)
  const [scrollTop, setScrollTop] = React.useState(0)
  const size = useElementSize(scrollRef)
  const railWidth = size.width > 0 ? size.width : FALLBACK_RAIL_WIDTH
  const layout = React.useMemo(() => offsetsOf(props.pages, props.total, railWidth), [props.pages, props.total, railWidth])

  const activeIndex = layout.items.findIndex((item) => item.page === props.page)

  const visible = React.useMemo(() => {
    const height = size.height > 0 ? size.height : 900
    const top = scrollTop - OVERSCAN
    const bottom = scrollTop + height + OVERSCAN
    return layout.items.filter((item) => item.offset + item.itemHeight >= top && item.offset <= bottom)
  }, [layout.items, scrollTop, size.height])

  const handleScroll = React.useCallback(() => {
    const element = scrollRef.current
    if (!element) return
    setScrollTop(element.scrollTop || 0)
  }, [])

  // Keep the active thumbnail visible without hijacking user scrolling.
  React.useEffect(() => {
    const element = scrollRef.current
    const item = layout.items[activeIndex]
    if (!element || !item) return
    const height = element.clientHeight || 0
    if (height <= 0) return
    const top = element.scrollTop || 0
    if (item.offset < top + 8) element.scrollTop = Math.max(0, item.offset - 8)
    else if (item.offset + item.itemHeight > top + height - 8) element.scrollTop = item.offset + item.itemHeight - height + 8
  }, [activeIndex, layout.items, props.page])

  return React.createElement(
    'div',
    {
      ref: scrollRef,
      className: 'ph-r-rail ph-r-scroll',
      onScroll: handleScroll,
      role: 'navigation',
      'aria-label': t('reader.thumbnails'),
      'data-ph-scroll': 'rail',
    },
    React.createElement(
      'div',
      { ref: listRef, className: 'ph-r-rail__inner', style: { height: layout.totalHeight } },
      activeIndex >= 0
        ? React.createElement('span', {
            className: 'ph-r-rail__indicator',
            style: {
              height: 30,
              transform: 'translateY(' + (layout.items[activeIndex].offset + 8) + 'px)',
            },
            'aria-hidden': 'true',
          })
        : null,
      visible.map((item) => {
        const active = item.page === props.page
        return React.createElement(
          'button',
          {
            key: item.page,
            type: 'button',
            className: cx('ph-r-rail__item', active && 'ph-r-rail__item--active'),
            style: { position: 'absolute', left: 0, right: 0, top: item.offset },
            onClick: () => props.onSelect(item.page),
            'aria-label': t('reader.thumbPage', { page: item.page }),
            'aria-current': active ? 'page' : undefined,
            'data-ph-thumb': String(item.page),
          },
          React.createElement(
            'span',
            { className: 'ph-r-rail__thumb', style: { height: item.imageHeight } },
            React.createElement(
              'span',
              {
                style: {
                  display: 'block',
                  width: '100%',
                  height: '100%',
                  background: 'color-mix(in srgb, var(--dsw-alias-label-primary) 7%, #fff)',
                },
                'aria-hidden': 'true',
              },
            ),
            React.createElement('img', {
              src: item.imageUrl || pageImageUrl(props.paperId, item.page, 220),
              alt: '',
              loading: 'lazy',
              decoding: 'async',
              draggable: false,
              style: { position: 'absolute', inset: 0, width: '100%', height: '100%', objectFit: 'cover' },
              onLoad: (event) => {
                const image = event.currentTarget
                if (image && image.parentElement) image.parentElement.style.background = 'transparent'
              },
              onError: (event) => {
                const image = event.currentTarget
                if (image) image.style.display = 'none'
              },
            }),
          ),
          React.createElement(
            'span',
            { className: 'ph-r-rail__num' },
            String(item.page),
          ),
        )
      }),
      layout.items.length === 0
        ? React.createElement(Icon, { name: 'pages', size: 20 })
        : null,
    ),
  )
}
