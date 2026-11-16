/**
 * Continuous, virtualised page canvas.
 *
 * Responsibilities:
 *  - layout every page with a fixed placeholder size (stable scrolling),
 *  - render only viewport ± 2 pages of real content,
 *  - jump to a page / search hit without drift,
 *  - capture text selections, area drags and note clicks on the real page box,
 *  - paint transient overlays (selection toolbar, translation card, hover
 *    tooltip, annotation popover, note composer) inside the page so they scale
 *    and scroll with it.
 *
 * All page geometry is normalised 0–1 relative to the page; the only absolute
 * numbers are the rendered page box (width × zoom) which is derived from the
 * container width, so zooming and resizing never move annotations.
 */
import React from 'react'
import { AiWarning } from '../../core/ai-warning.jsx'
import {
  AnnotationMarks,
  AnnotationPopover,
  AnnotationTooltip,
  NoteComposer,
} from './annotation-layer.jsx'
import { PageTextLayer, selectableWords } from './text-layer.jsx'
import { dragProps } from '../../core/dnd.js'
import {
  Btn,
  Icon,
  IconBtn,
  Spinner,
  annotationAt,
  arrayOf,
  buildWordSelection,
  clamp,
  cx,
  firstText,
  hitTestWords,
  wordIndexAt,
  num,
  pageUrlOf,
  pointRect,
  rectStyle,
  unionRect,
} from './shared.jsx'
import { engineBadge, engineDetails, engineTitle, formatLatency, providerLabel } from './engines.js'

/** Vertical gap between two page boxes (px). */
const PAGE_GAP = 16
/** Vertical padding above the first page (px). */
const PAGE_TOP_PADDING = 18
/** Vertical padding below the last page (px). */
const PAGE_BOTTOM_PADDING = 48
/** Horizontal padding inside the scroll area (px). */
const CANVAS_SIDE_PADDING = 24
/** Pages rendered beyond the viewport on each side. */
const VIRTUAL_BUFFER = 2
/** Fallback page raster width for pagination metadata. */
const DEFAULT_PAGE_WIDTH = 595
const DEFAULT_PAGE_HEIGHT = 791
/** Width bounds of the base page box (before zoom). */
const MIN_BASE_WIDTH = 300
const MAX_BASE_WIDTH = 1000
/** Empty array reused for pages without annotations (stable memo input). */
const EMPTY_LIST = []

/* -------------------------------------------------------------------------- */
/* Small utilities                                                             */
/* -------------------------------------------------------------------------- */

/** Scroll one element to an absolute offset without depending on smooth scroll. */
function scrollElementTo(element, top, smooth) {
  if (!element) return
  const value = Math.max(0, Math.round(top))
  try {
    if (typeof element.scrollTo === 'function') {
      element.scrollTo({ top: value, behavior: smooth ? 'smooth' : 'auto' })
      return
    }
  } catch {
    /* fall back to the property write below */
  }
  element.scrollTop = value
}

/** Normalise the page descriptor list coming from `reader.open`. */
function usePageDescriptors(pages, total) {
  return React.useMemo(() => {
    const list = arrayOf(pages)
    if (list.length > 0) {
      return list.map((item, index) => {
        const page = Math.max(1, Math.round(num(item && item.page, index + 1)))
        const width = num(item && item.width, DEFAULT_PAGE_WIDTH) || DEFAULT_PAGE_WIDTH
        const height = num(item && item.height, DEFAULT_PAGE_HEIGHT) || DEFAULT_PAGE_HEIGHT
        return { page, width, height, imageUrl: item && item.imageUrl ? item.imageUrl : '' }
      })
    }
    const count = Math.max(1, Math.round(num(total, 1)))
    const generated = []
    for (let page = 1; page <= count; page += 1) {
      generated.push({ page, width: DEFAULT_PAGE_WIDTH, height: DEFAULT_PAGE_HEIGHT, imageUrl: '' })
    }
    return generated
  }, [pages, total])
}

/** Group annotations by page (new array only when the source list changes). */
function useAnnotationsByPage(annotations) {
  return React.useMemo(() => {
    const map = new Map()
    for (const annotation of arrayOf(annotations)) {
      if (!annotation) continue
      const list = map.get(annotation.page)
      if (list) list.push(annotation)
      else map.set(annotation.page, [annotation])
    }
    return map
  }, [annotations])
}

/** Compare two annotation lists without deep-comparing rect arrays. */
function sameAnnotations(left, right) {
  if (left === right) return true
  const a = left || EMPTY_LIST
  const b = right || EMPTY_LIST
  if (a.length !== b.length) return false
  for (let index = 0; index < a.length; index += 1) {
    const one = a[index]
    const two = b[index]
    if (one === two) continue
    if (!one || !two) return false
    if (one.id !== two.id || one.comment !== two.comment || one.color !== two.color || one.kind !== two.kind) return false
    if (one.rects !== two.rects || one.pending !== two.pending) return false
  }
  return true
}

/* -------------------------------------------------------------------------- */
/* Page view                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * One rendered page: raster + text layer + marks + interaction overlay.
 * Memoised so scrolling the canvas never re-renders a thousand word spans.
 */
function PageViewImpl(props) {
  const {
    t,
    paperId,
    pageInfo,
    width,
    height,
    active,
    mode,
    pageDataEntry,
    layerEntry,
    annotations,
    activeAnnotationId,
    selection,
    selectionResult,
    popover,
    noteDraft,
    search,
    reducedMotion,
  } = props
  const page = pageInfo.page
  const pageRef = React.useRef(null)
  const imgRef = React.useRef(null)
  const [imageState, setImageState] = React.useState('loading')
  const [imageVersion, setImageVersion] = React.useState(0)
  const [imageSlow, setImageSlow] = React.useState(false)
  const [areaDrag, setAreaDrag] = React.useState(null)
  const areaRectRef = React.useRef(null)
  const [hover, setHover] = React.useState(null)
  const hoverFrame = React.useRef(0)
  const hoverPoint = React.useRef(null)
  const dragRef = React.useRef(null)
  // v0.3 geometry selection (replaces DOM Range selection)
  const [selecting, setSelecting] = React.useState(false)
  const [dragSelect, setDragSelect] = React.useState(null)
  const selectRef = React.useRef(null)
  const selectFrame = React.useRef(0)
  const [noteGhost, setNoteGhost] = React.useState(null)

  const interactive = mode === 'select'
  const rawLayer = layerEntry && layerEntry.status === 'ready' ? layerEntry.data : null
  const pageData = pageDataEntry && pageDataEntry.status === 'ready' ? pageDataEntry.data : null
  const layer = React.useMemo(() => {
    if (!rawLayer) return null
    const width = num(rawLayer.width, pageInfo.width)
    const height = num(rawLayer.height, pageInfo.height)
    if (!(width > 0) || !(height > 0) || arrayOf(rawLayer.words).length === 0) {
      return Object.assign({}, rawLayer, { words: [], width, height })
    }
    if (rawLayer.width === width && rawLayer.height === height) return rawLayer
    return Object.assign({}, rawLayer, { width, height })
  }, [pageInfo.height, pageInfo.width, rawLayer])
  const selectable = React.useMemo(() => selectableWords(layer), [layer])

  React.useEffect(() => {
    setImageState('loading')
    setImageSlow(false)
    setImageVersion(0)
    setHover(null)
    setAreaDrag(null)
    setDragSelect(null)
    selectRef.current = null
    setSelecting(false)
    setNoteGhost(null)
  }, [paperId, page])

  const retryImage = React.useCallback(() => {
    setImageState('loading')
    setImageSlow(false)
    setImageVersion((value) => value + 1)
  }, [])

  /* -- geometry helpers ---------------------------------------------------- */

  const pointOf = React.useCallback((event) => {
    const element = pageRef.current
    if (!element) return null
    const box = element.getBoundingClientRect()
    if (!(box.width > 0) || !(box.height > 0)) return null
    return {
      x: clamp((event.clientX - box.left) / box.width, 0, 1),
      y: clamp((event.clientY - box.top) / box.height, 0, 1),
    }
  }, [])

  /**
   * Build a selection preview from two normalised page points: hit-test the
   * rendered word boxes geometrically (never DOM Range), rebuild quote/rects in
   * reading order and return the per-line merged rects for the live overlay.
   */
  const selectionForPoints = React.useCallback(
    (start, current) => {
      const rectNorm = pointRect(start, current)
      if (!rectNorm || !selectable || selectable.words.length === 0) return null
      if (!(selectable.width > 0) || !(selectable.height > 0)) return null
      if (rectNorm.w < 0.0015 && rectNorm.h < 0.0015) return null
      const rectPoints = {
        x: rectNorm.x * selectable.width,
        y: rectNorm.y * selectable.height,
        w: Math.max(rectNorm.w * selectable.width, 0.8),
        h: Math.max(rectNorm.h * selectable.height, 0.8),
      }
      // v0.8: normal text selection semantics. The word under the pointer-down
      // is the anchor and the word under the pointer-up is the focus; everything
      // between them in reading order is selected (no rectangular gaps). Only
      // when either endpoint sits in a margin do we fall back to rectangle hits.
      const startPoint = { x: start.x * selectable.width, y: start.y * selectable.height }
      const endPoint = { x: current.x * selectable.width, y: current.y * selectable.height }
      const anchorIndex = wordIndexAt(selectable.words, startPoint, selectable.width)
      const focusIndex = wordIndexAt(selectable.words, endPoint, selectable.width)
      if (anchorIndex >= 0 && focusIndex >= 0) {
        const low = Math.min(anchorIndex, focusIndex)
        const high = Math.max(anchorIndex, focusIndex)
        const rangeIndexes = []
        for (let index = low; index <= high; index += 1) rangeIndexes.push(index)
        const rangeBuilt = buildWordSelection(selectable.words, rangeIndexes, selectable.width, selectable.height)
        if (rangeBuilt && rangeBuilt.wordCount > 0) {
          return {
            quotes: rangeBuilt.quote,
            quote: rangeBuilt.quote,
            rects: rangeBuilt.rects,
            anchor: rangeBuilt.anchor,
            wordCount: rangeBuilt.wordCount,
            rect: rectNorm,
            sequential: true,
          }
        }
      }
      const allHits = hitTestWords(selectable.words, rectPoints)
      if (allHits.length === 0) return null
      // Column isolation: a diagonal drag across a two-column page must only
      // take the column under the pointer, never glue the far column (or the
      // page footer) into the quote. Cluster the hit boxes by x-gap and keep
      // the cluster nearest to the drag origin.
      const originX = start.x * selectable.width
      const boxes = allHits.map((index) => ({ index, word: selectable.words[index] })).filter((item) => item.word)
      boxes.sort((left, right) => left.word.x - right.word.x)
      const clusters = []
      let currentCluster = []
      let clusterRight = -Infinity
      for (const item of boxes) {
        if (currentCluster.length === 0) {
          currentCluster = [item]
          clusterRight = item.word.x + item.word.w
          continue
        }
        if (item.word.x - clusterRight > selectable.width * 0.045) {
          clusters.push(currentCluster)
          currentCluster = [item]
          clusterRight = item.word.x + item.word.w
        } else {
          currentCluster.push(item)
          clusterRight = Math.max(clusterRight, item.word.x + item.word.w)
        }
      }
      if (currentCluster.length > 0) clusters.push(currentCluster)
      let chosenCluster = clusters[0] || []
      if (clusters.length > 1) {
        let bestDistance = Infinity
        for (const cluster of clusters) {
          const left = cluster[0].word.x
          const right = Math.max.apply(null, cluster.map((item) => item.word.x + item.word.w))
          const distance = originX < left ? left - originX : originX > right ? originX - right : 0
          if (distance < bestDistance) {
            bestDistance = distance
            chosenCluster = cluster
          }
        }
      }
      const hits = chosenCluster.map((item) => item.index)
      if (hits.length === 0) return null
      const built = buildWordSelection(selectable.words, hits, selectable.width, selectable.height)
      if (!built) return null
      return {
        quotes: built.quote,
        quote: built.quote,
        rects: built.rects,
        anchor: built.anchor,
        wordCount: built.wordCount || hits.length,
        rect: rectNorm,
      }
    },
    [selectable],
  )

  /** Convert a normalised anchor into px position inside the page. */
  const anchorPx = React.useCallback(
    (anchor, placement) => {
      if (!anchor) return null
      const half = placement && placement.halfWidth ? placement.halfWidth : 150
      const centerX = (anchor.x + anchor.w / 2) * width
      const left = clamp(centerX, Math.min(half, width / 2), Math.max(width - Math.min(half, width / 2), Math.min(half, width / 2)))
      const bottom = (anchor.y + anchor.h) * height
      const top = (anchor.y + anchor.h) * height
      return {
        below: { left, top: clamp(top + 8, 4, Math.max(height - 8, 8)) },
        above: { left, top: clamp((anchor.y) * height - 8, 4, Math.max(height - 8, 8)), flip: true },
        bottom,
      }
    },
    [height, width],
  )

  /* -- interaction --------------------------------------------------------- */

  const openAnnotationAt = React.useCallback(
    (point) => {
      const annotation = annotationAt(annotations, point)
      if (!annotation) return false
      const anchor = annotation.kind === 'note' ? null : unionRect(annotation.rects)
      const noteRect = annotation.rects && annotation.rects[0] ? annotation.rects[0] : null
      const resolved = anchor || noteRect || { x: point.x, y: point.y, w: 0, h: 0 }
      props.onAnnotationOpen(annotation, resolved)
      return true
    },
    [annotations, props],
  )

  /**
   * Start a geometry selection. Word hit-testing (not the browser Range) is what
   * makes multi-column pages behave: only words whose boxes overlap the drag
   * rectangle are ever selected, so far-away affiliations cannot be glued in.
   */
  const handleMouseDown = React.useCallback(
    (event) => {
      if (event.button !== 0) return
      const target = event.target
      if (target && target.closest && target.closest('[data-ph-overlay]')) return
      if (mode === 'area') {
        const point = pointOf(event)
        if (!point) return
        event.preventDefault()
        dragRef.current = point
        setAreaDrag({ x: point.x, y: point.y, w: 0, h: 0 })
        return
      }
      if (mode === 'note') return
      if (mode !== 'select') return
      const point = pointOf(event)
      if (!point) return
      event.preventDefault()
      // Dismiss the previous selection/toolbar when a new drag starts.
      props.onSelection(null)
      props.onSelectionAction('closeResult')
      setHover(null)
      setDragSelect(null)
      if (selectRef.current && typeof selectRef.current.cleanup === 'function') selectRef.current.cleanup()
      const drag = { start: point, last: point, moved: false, preview: null, cleanup: null }
      selectRef.current = drag
      setSelecting(true)

      const updatePreview = (nextPoint) => {
        if (selectRef.current !== drag) return
        drag.last = nextPoint
        const dx = Math.abs(nextPoint.x - drag.start.x)
        const dy = Math.abs(nextPoint.y - drag.start.y)
        if (dx > 0.004 || dy > 0.004) drag.moved = true
        const preview = drag.moved ? selectionForPoints(drag.start, nextPoint) : null
        drag.preview = preview
        setDragSelect(preview)
      }

      const cleanup = () => {
        window.removeEventListener('mousemove', onMove)
        window.removeEventListener('mouseup', onUp)
        window.removeEventListener('keydown', onKeyDown)
        if (selectFrame.current && typeof cancelAnimationFrame === 'function') cancelAnimationFrame(selectFrame.current)
        selectFrame.current = 0
        selectRef.current = null
        setSelecting(false)
        setDragSelect(null)
      }
      drag.cleanup = cleanup

      const onMove = (moveEvent) => {
        if (selectRef.current !== drag) return
        // Hit-testing a few hundred word boxes is cheap; update synchronously so
        // the translucent selection tracks the pointer even before a repaint is
        // scheduled (and stays deterministic in jsdom/headless tests).
        const nextPoint = pointOf(moveEvent)
        if (nextPoint) updatePreview(nextPoint)
      }
      const onUp = (upEvent) => {
        if (selectRef.current !== drag) return
        // Recompute synchronously so a pending rAF can never lose the last move.
        const finalPoint = pointOf(upEvent) || drag.last
        if (finalPoint) updatePreview(finalPoint)
        const preview = drag.preview
        const moved = drag.moved
        cleanup()
        if (moved && preview && preview.wordCount > 0) {
          props.onSelection({
            page,
            quote: preview.quote,
            rects: preview.rects,
            anchor: preview.anchor,
            wordCount: preview.wordCount,
          })
          return
        }
        if (finalPoint && openAnnotationAt(finalPoint)) return
        props.onSelection(null)
      }
      const onKeyDown = (keyEvent) => {
        if (keyEvent.key !== 'Escape') return
        cleanup()
        props.onSelection(null)
      }
      window.addEventListener('mousemove', onMove)
      window.addEventListener('mouseup', onUp)
      window.addEventListener('keydown', onKeyDown)
    },
    [mode, openAnnotationAt, page, pointOf, props, selectionForPoints],
  )

  React.useEffect(() => {
    if (!areaDrag) return undefined
    const onMove = (event) => {
      const start = dragRef.current
      if (!start) return
      const point = pointOf(event)
      if (!point) return
      const next = {
        x: Math.min(start.x, point.x),
        y: Math.min(start.y, point.y),
        w: Math.abs(point.x - start.x),
        h: Math.abs(point.y - start.y),
      }
      areaRectRef.current = next
      setAreaDrag(next)
    }
    const onUp = () => {
      dragRef.current = null
      const current = areaRectRef.current
      areaRectRef.current = null
      setAreaDrag(null)
      if (current && current.w > 0.012 && current.h > 0.008) props.onCreateArea(current)
    }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
    return () => {
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
    }
  }, [areaDrag !== null, pointOf, props])

  const handleClick = React.useCallback(
    (event) => {
      if (mode !== 'note') return
      const target = event.target
      if (target && target.closest && target.closest('[data-ph-overlay]')) return
      const point = pointOf(event)
      if (point) props.onNoteCreate(point)
    },
    [mode, pointOf, props],
  )

  /* -- hover tooltip + note placement preview ------------------------------ */

  const handleMouseMove = React.useCallback(
    (event) => {
      if (selecting || event.buttons) {
        if (hover) setHover(null)
        return
      }
      if (mode === 'note') {
        const point = pointOf(event)
        setNoteGhost(point)
        return
      }
      if (!interactive || props.annotations.length === 0) {
        if (hover) setHover(null)
        return
      }
      hoverPoint.current = pointOf(event)
      if (hoverFrame.current) return
      const schedule = typeof requestAnimationFrame === 'function' ? requestAnimationFrame : (callback) => setTimeout(callback, 16)
      hoverFrame.current = schedule(() => {
        hoverFrame.current = 0
        const point = hoverPoint.current
        if (!point) {
          setHover(null)
          return
        }
        const annotation = annotationAt(props.annotations, point)
        setHover((previous) => {
          if (!annotation) return null
          if (previous && previous.annotationId === annotation.id) return previous
          return { annotationId: annotation.id, annotation, point }
        })
      })
    },
    [hover, interactive, mode, pointOf, props.annotations, selecting],
  )

  const clearHover = React.useCallback(() => {
    setHover(null)
    setNoteGhost(null)
  }, [])

  /* -- annotations / overlays --------------------------------------------- */

  const pageAnnotations = annotations
  const pageSelection = selection && selection.page === page ? selection : null
  const pagePopover = popover && popover.annotation && popover.annotation.page === page ? popover : null
  const pageNoteDraft = noteDraft && noteDraft.page === page ? noteDraft : null
  const pageSearchHits = React.useMemo(() => {
    if (!search || !search.query || !search.hits) return null
    return search.hits
      .map((hit, index) => ({ hit, index }))
      .filter((entry) => entry.hit.page === page)
      .map((entry) => Object.assign({}, entry.hit, { order: entry.index }))
  }, [page, search])
  const activeHitOrder = search && search.hits && search.hits.length > 0 ? search.index : -1

  const selectionToolbar = pageSelection
    ? (() => {
        const anchor = pageSelection.anchor
        const centerX = (anchor.x + anchor.w / 2) * width
        const half = Math.min(300, Math.max(180, width / 2 - 8))
        const left = clamp(centerX, half, Math.max(width - half, half))
        let top = anchor.y * height - 56
        let below = false
        if (top < 6) {
          top = (anchor.y + anchor.h) * height + 10
          below = true
        }
        return { left, top, below }
      })()
    : null

  const showTooltip = hover && hover.annotation ? hover : null
  const figureHighlight = props.figureFocus && Number(props.figureFocus.page) === page ? props.figureFocus : null
  const tooltipStyle = showTooltip
    ? {
        left: (showTooltip.point.x * 100).toFixed(3) + '%',
        top: (showTooltip.point.y * 100).toFixed(3) + '%',
        transform: showTooltip.point.y < 0.14 ? 'translate(-50%, 14px)' : 'translate(-50%, calc(-100% - 10px))',
      }
    : null

  const popoverPosition = pagePopover
    ? (() => {
        const anchor = pagePopover.anchor || { x: 0.5, y: 0.2, w: 0, h: 0 }
        const half = 170
        const centerX = (anchor.x + anchor.w / 2) * width
        const left = clamp(centerX, Math.min(half, width / 2), Math.max(width - Math.min(half, width / 2), Math.min(half, width / 2)))
        const below = (anchor.y + anchor.h) * height + 10
        const above = anchor.y * height - 10
        const estimated = 360
        const pageRect = pageRef.current ? pageRef.current.getBoundingClientRect() : null
        const viewportHeight = typeof window !== 'undefined' && window.innerHeight ? window.innerHeight : 900
        const pageTop = pageRect ? pageRect.top : 0
        // Flip above the annotation when the popover would cross the viewport
        // bottom; keep 12px breathing room and never push it off the page top.
        if (below + estimated > height || pageTop + below + estimated > viewportHeight - 12) {
          const flippedTop = above - estimated
          if (pageTop + flippedTop >= 12) return { left, top: Math.max(6, flippedTop), flipped: true }
        }
        return { left, top: clamp(below, 4, Math.max(height - 40, 4)), flipped: false }
      })()
    : null

  const notePosition = pageNoteDraft
    ? (() => {
        const half = 148
        const left = clamp(pageNoteDraft.point.x * width, Math.min(half, width / 2), Math.max(width - Math.min(half, width / 2), Math.min(half, width / 2)))
        const below = pageNoteDraft.point.y * height + 12
        const top = below + 240 <= height ? below : Math.max(4, pageNoteDraft.point.y * height - 250)
        return { left, top }
      })()
    : null

  const baseImageSrc = pageUrlOf(paperId, Object.assign({ page }, pageInfo, { imageUrl: pageInfo.imageUrl }))
  /* A retry must bypass a stale HTTP cache entry; the host ignores `retry`. */
  const imageSrc =
    imageVersion > 0
      ? baseImageSrc + (baseImageSrc.indexOf('?') >= 0 ? '&' : '?') + 'retry=' + imageVersion
      : baseImageSrc
  const showImageSkeleton = imageState === 'loading'

  /* A cached raster can finish before React attaches its load handler, which
     would leave the page skeleton up forever. Settle from `img.complete` and
     expose a retry after a few seconds instead of waiting silently. */
  React.useEffect(() => {
    setImageSlow(false)
    const node = imgRef.current
    if (!node) return undefined
    const settle = () => {
      if (!node.complete) return false
      setImageState(node.naturalWidth > 0 ? 'loaded' : 'error')
      return true
    }
    if (settle()) return undefined
    const slowTimer = setTimeout(() => setImageSlow(true), 8000)
    const poll = setInterval(() => {
      if (settle()) {
        clearInterval(poll)
        clearTimeout(slowTimer)
      }
    }, 500)
    const stopPoll = setTimeout(() => clearInterval(poll), 20000)
    return () => {
      clearTimeout(slowTimer)
      clearInterval(poll)
      clearTimeout(stopPoll)
    }
  }, [imageSrc, imageVersion])

  const layerStatus = layerEntry ? layerEntry.status : 'idle'

  return React.createElement(
    'div',
    {
      ref: pageRef,
      className: cx(
        'ph-r-page',
        active && 'ph-r-page--active',
        mode === 'area' && 'ph-r-page--area',
        mode === 'note' && 'ph-r-page--note',
        mode === 'select' && 'ph-r-page--select',
      ),
      style: { width, height },
      'data-ph-page': String(page),
      onMouseDown: handleMouseDown,
      onClick: handleClick,
      onMouseMove: handleMouseMove,
      onMouseLeave: clearHover,
    },
    React.createElement(
      'img',
      {
        key: 'img-' + imageVersion,
        ref: imgRef,
        className: cx('ph-r-page__img', imageState === 'loaded' && 'ph-r-page__img--loaded'),
        src: imageSrc,
        alt: t('reader.thumbPage', { page }),
        draggable: false,
        decoding: 'async',
        // Only the viewport buffer is mounted, so eager loading is bounded and
        // avoids lazy-loading races inside the virtualised scroll box.
        loading: 'eager',
        fetchPriority: active ? 'high' : 'auto',
        onLoad: () => {
          setImageSlow(false)
          setImageState('loaded')
        },
        onError: () => {
          setImageSlow(false)
          setImageState('error')
        },
      },
    ),
    showImageSkeleton ? React.createElement('div', { className: 'ph-r-page__skeleton' }) : null,
    showImageSkeleton && imageSlow
      ? React.createElement(
          'div',
          { className: 'ph-r-page__slow', role: 'status' },
          React.createElement(Spinner, { size: 14 }),
          React.createElement('span', null, t('reader.page.slow')),
          React.createElement(Btn, { size: 'sm', variant: 'soft', icon: 'refresh', onClick: retryImage }, t('reader.page.imageRetry')),
        )
      : null,
    imageState === 'error'
      ? React.createElement(
          'div',
          { className: 'ph-r-page__error' },
          React.createElement(Icon, { name: 'warning', size: 18 }),
          React.createElement('span', null, t('reader.page.imageFailed')),
          React.createElement(Btn, { size: 'sm', variant: 'soft', icon: 'refresh', onClick: retryImage }, t('reader.page.imageRetry')),
        )
      : null,
    interactive ? React.createElement(FigureDragRegions, { t: t, figures: props.figures, paperId: paperId, page: page }) : null,
    React.createElement(PageTextLayer, {
      key: 'text-' + page,
      page,
      words: selectable.words,
      width: selectable.width,
      height: selectable.height,
      active: true,
      // v0.3: the page canvas owns selection geometrically, so the text layer is
      // purely visual and must not start a native DOM Range selection.
      interactive: false,
    }),
    (() => {
      const overlayRects = dragSelect && dragSelect.rects ? dragSelect.rects : pageSelection ? pageSelection.rects : null
      if (!overlayRects || overlayRects.length === 0) return null
      return React.createElement(
        'div',
        { className: 'ph-r-selrect', 'data-ph-text-selection': String(dragSelect ? dragSelect.wordCount : pageSelection ? pageSelection.wordCount || 0 : 0) },
        overlayRects.map((rect, index) => React.createElement('span', { key: index, className: 'ph-r-selrect__box', style: rectStyle(rect) })),
      )
    })(),
    dragSelect && dragSelect.wordCount > 0
      ? React.createElement(
          'span',
          {
            className: 'ph-r-selcount',
            style: {
              left: (clamp((dragSelect.rect.x + dragSelect.rect.x + dragSelect.rect.w) / 2, 0, 1) * 100).toFixed(2) + '%',
              top: (clamp(dragSelect.rect.y + dragSelect.rect.h, 0, 1) * 100).toFixed(2) + '%',
            },
          },
          t('reader.selection.selectedWords', { count: dragSelect.wordCount }),
        )
      : null,
    noteGhost && mode === 'note' && !noteDraft
      ? React.createElement('span', {
          className: 'ph-r-note-ghost',
          style: { left: (noteGhost.x * 100).toFixed(2) + '%', top: (noteGhost.y * 100).toFixed(2) + '%' },
          'aria-hidden': 'true',
        }, React.createElement(Icon, { name: 'sticky', size: 12 }))
      : null,
    React.createElement(AnnotationMarks, {
      page,
      annotations: pageAnnotations,
      activeId: activeAnnotationId,
    }),
    figureHighlight
      ? React.createElement(FigureHighlightOverlay, { t: t, figureFocus: figureHighlight, page: page })
      : null,
    pageSearchHits && pageSearchHits.length > 0
      ? React.createElement(
          'div',
          { className: 'ph-r-hits' },
          pageSearchHits.map((hit) =>
            hit.rects.map((rect, index) =>
              React.createElement('span', {
                key: hit.order + ':' + index,
                className: cx('ph-r-hit', hit.order === activeHitOrder && 'ph-r-hit--active'),
                style: rectStyle(rect),
              }),
            ),
          ),
        )
      : null,
    areaDrag
      ? React.createElement('span', { className: 'ph-r-area-drag', style: rectStyle(areaDrag) })
      : null,
    active || pageSearchHits
      ? React.createElement(
          'span',
          { className: 'ph-r-page__chip' },
          React.createElement(Icon, { name: 'pages', size: 11 }),
          String(page),
        )
      : null,
    active && !layer
      ? React.createElement(
          'span',
          { className: 'ph-r-page__structure' },
          layerStatus === 'loading' || layerStatus === 'idle'
            ? t('reader.page.textLayer.loading')
            : t('reader.page.textLayer.unavailable'),
        )
      : null,
    showTooltip
      ? React.createElement(AnnotationTooltip, { annotation: showTooltip.annotation, style: tooltipStyle })
      : null,
    selectionToolbar
      ? React.createElement(
          'div',
          {
            className: cx('ph-r-float', 'ph-r-card', 'ph-r-selbar'),
            style: { left: selectionToolbar.left, top: selectionToolbar.top, transform: 'translateX(-50%)' },
            'data-ph-overlay': 'selection',
            onMouseDown: (event) => event.preventDefault(),
          },
          React.createElement('span', { className: 'ph-r-selbar__count' }, t('reader.selection.selectedWords', { count: pageSelection ? pageSelection.wordCount || 0 : 0 })),
          React.createElement('span', { className: 'ph-r-selbar__sep' }),
          React.createElement(
            'button',
            {
              type: 'button',
              className: 'ph-r-toolbtn ph-r-toolbtn--primary',
              onClick: () => props.onSelectionAction('quickTranslate'),
              title: t('reader.selection.quickTranslateHint'),
            },
            React.createElement(Icon, { name: 'sparkles', size: 14 }),
            React.createElement('span', null, t('reader.selection.quickTranslate')),
          ),
          React.createElement(ColorPenRow, {
            t,
            onPick: (color) => props.onSelectionAction('highlight', { color }),
          }),
          React.createElement('span', { className: 'ph-r-selbar__sep' }),
          React.createElement(
            'button',
            { type: 'button', className: 'ph-r-toolbtn', onClick: () => props.onSelectionAction('copy'), title: t('reader.selection.copy') },
            React.createElement(Icon, { name: 'copy', size: 14 }),
            React.createElement('span', null, t('reader.selection.copy')),
          ),
          React.createElement(
            'button',
            { type: 'button', className: 'ph-r-toolbtn', onClick: () => props.onSelectionAction('explain'), title: t('reader.selection.explain') },
            React.createElement(Icon, { name: 'book', size: 14 }),
            React.createElement('span', null, t('reader.selection.explain')),
          ),
          React.createElement(
            'button',
            { type: 'button', className: 'ph-r-toolbtn', onClick: () => props.onSelectionAction('ask'), title: t('reader.selection.ask') },
            React.createElement(Icon, { name: 'note', size: 14 }),
            React.createElement('span', null, t('reader.selection.ask')),
          ),
          React.createElement(
            'button',
            { type: 'button', className: 'ph-r-toolbtn', onClick: () => props.onSelectionAction('cite'), title: t('reader.selection.cite') },
            React.createElement(Icon, { name: 'quote', size: 14 }),
            React.createElement('span', null, t('reader.selection.cite')),
          ),
        )
      : null,
    pageSelection && selectionResult && selectionResult.page === page
      ? React.createElement(
          React.Fragment,
          null,
          selectionResult.replace
            ? React.createElement(
                'div',
                {
                  className: 'ph-r-card ph-r-replacecard',
                  style: {
                    left: selectionToolbar ? selectionToolbar.left : '50%',
                    top: selectionToolbar ? selectionToolbar.top : 40,
                    transform: 'translateX(-50%)',
                  },
                  'data-ph-overlay': 'selection-replace',
                  onMouseDown: (event) => event.stopPropagation(),
                },
                React.createElement(
                  'div',
                  { className: 'ph-r-resultcard__head' },
                  React.createElement(Icon, { name: 'translate', size: 13 }),
                  React.createElement('strong', null, t('reader.selection.translated')),
                  React.createElement('span', { className: 'ph-r-resultcard__spacer' }),
                  React.createElement(IconBtn, { icon: 'close', title: t('reader.selection.closeReplace'), onClick: () => props.onSelectionAction('closeReplace') }),
                ),
                React.createElement('div', { className: 'ph-r-replacecard__text' }, firstText(selectionResult.translation)),
              )
            : React.createElement(SelectionResultCard, {
                t,
                result: selectionResult,
                width,
                height,
                anchor: pageSelection.anchor,
                onClose: () => props.onSelectionAction('closeResult'),
                onCopy: () => props.onSelectionAction('copyQuickTranslation'),
                onReplace: () => props.onSelectionAction('replaceQuickTranslation'),
                onSend: () => props.onSelectionAction('sendQuickTranslation'),
                onRetry: () => props.onSelectionAction('retryQuickTranslation'),
                onRefine: () => props.onSelectionAction('refineQuickTranslation'),
                onOpenSettings: props.onOpenSettings,
              }),
        )
      : null,
    pagePopover
      ? React.createElement(AnnotationPopover, {
          t,
          annotation: pagePopover.annotation,
          busy: Boolean(pagePopover.busy),
          style: popoverPosition,
          autoFocus: Boolean(pagePopover.autoFocus),
          onClose: props.onAnnotationClose,
          onUpdate: (patch) => props.onUpdateAnnotation(pagePopover.annotation, patch),
          onDelete: () => props.onDeleteAnnotation(pagePopover.annotation),
          onCopy: props.onCopyAnnotation,
          onCite: props.onCiteAnnotation,
          onLinkNote: props.onLinkAnnotationNote,
          onAsk: props.onAskAnnotation,
          onExplain: props.onExplainAnnotation,
          onQuickTranslate: props.onQuickTranslateAnnotation ? () => props.onQuickTranslateAnnotation(pagePopover.annotation) : undefined,
          onAiTranslate: props.onAiTranslateAnnotation ? () => props.onAiTranslateAnnotation(pagePopover.annotation) : undefined,
          onUndoDelete: () => props.onDeleteAnnotation(pagePopover.annotation),
        })
      : null,
    pageNoteDraft && notePosition
      ? React.createElement(NoteComposer, {
          t,
          color: noteDraft.color,
          style: notePosition,
          onSave: (payload) => props.onNoteSave(Object.assign({ page, point: pageNoteDraft.point }, payload)),
          onCancel: props.onNoteCancel,
        })
      : null,
  )
}

/** Memo comparator: ignore callback identity, compare the data that matters. */
const PageView = React.memo(PageViewImpl, (previous, next) => {
  return (
    previous.paperId === next.paperId &&
    previous.pageInfo === next.pageInfo &&
    previous.width === next.width &&
    previous.height === next.height &&
    previous.active === next.active &&
    previous.mode === next.mode &&
    previous.reducedMotion === next.reducedMotion &&
    previous.pageDataEntry === next.pageDataEntry &&
    previous.layerEntry === next.layerEntry &&
    previous.activeAnnotationId === next.activeAnnotationId &&
    previous.selection === next.selection &&
    previous.selectionResult === next.selectionResult &&
    previous.popover === next.popover &&
    previous.noteDraft === next.noteDraft &&
    previous.search === next.search &&
    previous.figures === next.figures &&
    previous.t === next.t &&
    sameAnnotations(previous.annotations, next.annotations)
  )
})

/* -------------------------------------------------------------------------- */
/* Selection toolbar colour row                                                */
/* -------------------------------------------------------------------------- */

function ColorPenRow(props) {
  return React.createElement(
    'div',
    { className: 'ph-r-pens', role: 'group', 'aria-label': props.t('reader.selection.colors') },
    ['yellow', 'green', 'blue', 'red', 'purple'].map((color) =>
      React.createElement('button', {
        key: color,
        type: 'button',
        className: 'ph-r-pen ph-r-pen--' + color,
        title: props.t('reader.annot.color.' + color),
        'aria-label': props.t('reader.annot.color.' + color),
        onClick: () => props.onPick(color),
      }),
    ),
  )
}

/* -------------------------------------------------------------------------- */
/* Selection translation / explanation result card                             */
/* -------------------------------------------------------------------------- */

export function SelectionResultCard(props) {
  const { t, result, anchor, width, height } = props
  const [now, setNow] = React.useState(() => Date.now())
  React.useEffect(() => {
    if (!result.loading) return undefined
    const timer = setInterval(() => setNow(Date.now()), 200)
    return () => clearInterval(timer)
  }, [result.loading])
  const half = 170
  const centerX = (anchor.x + anchor.w / 2) * width
  const left = clamp(centerX, Math.min(half, width / 2), Math.max(width - Math.min(half, width / 2), Math.min(half, width / 2)))
  let top = (anchor.y + anchor.h) * height + 12
  if (top + 240 > height) top = Math.max(6, anchor.y * height - 240)
  const value = firstText(result.translation)
  const elapsedMs =
    result.latencyMs != null
      ? Number(result.latencyMs)
      : result.elapsedMs != null
        ? Number(result.elapsedMs)
        : result.loading && result.startedAt
          ? Math.max(0, now - result.startedAt)
          : null
  const elapsedLabel =
    elapsedMs == null ? '' : elapsedMs >= 1000 ? (elapsedMs / 1000).toFixed(1) + ' s' : Math.round(elapsedMs) + ' ms'
  const translated = result.status === 'translated' || Boolean(value)
  const engineText = translated && (result.engine || result.provider)
    ? engineBadge(result.engine, result.model, result.latencyMs, result.cached)
    : ''
  const loadingText = result.aiRefine ? t('reader.selection.refining') : t('reader.selection.quickTranslating')
  return React.createElement(
    'div',
    {
      className: cx('ph-r-float', 'ph-r-card', 'ph-r-resultcard'),
      style: { left, top },
      'data-ph-overlay': 'selection-result',
      onMouseDown: (event) => event.stopPropagation(),
    },
    React.createElement(
      'div',
      { className: 'ph-r-resultcard__head' },
      React.createElement(Icon, { name: 'sparkles', size: 13 }),
      React.createElement('strong', null, result.aiRefine ? t('reader.selection.aiRefine') : t('reader.selection.quickTranslate')),
      engineText
        ? React.createElement('span', { className: 'ph-r-resultcard__engine', title: engineDetails(result.engine, result.model) }, engineText)
        : null,
      result.freeOnly || result.mode === 'free' || (result.engine && result.engine.free)
        ? React.createElement(
            'span',
            { className: 'ph-r-resultcard__free', title: t('reader.selection.freeFastHint') },
            t('reader.selection.freeFast') + (!translated && elapsedLabel ? ' · ' + elapsedLabel : ''),
          )
        : null,
      result.provider === 'llm' && result.fast
        ? React.createElement('span', { className: 'ph-r-ai__fast' }, t('reader.selection.fastMode'))
        : null,
      React.createElement('span', { className: 'ph-r-resultcard__spacer' }),
      React.createElement(IconBtn, { icon: 'close', title: t('reader.selection.close'), onClick: props.onClose }),
    ),
    result.loading
      ? React.createElement(
          'div',
          { className: 'ph-r-resultcard__loading' },
          React.createElement(Spinner, { size: 12 }),
          React.createElement('span', null, loadingText),
          elapsedLabel
            ? React.createElement(
                'span',
                { className: 'ph-r-resultcard__meta' },
                (result.provider ? providerLabel(result.provider) + ' · ' : '') + elapsedLabel,
              )
            : null,
        )
      : null,
    !result.loading && !value
      ? React.createElement(AiWarning, {
          t: t,
          compact: true,
          status: 'error',
          reason: firstText(result.reason, t('reader.ai.reasonFallback')),
          onRetry: props.onRetry,
          onOpenSettings: props.onOpenSettings,
          extra: props.onRefine
            ? React.createElement(Btn, { size: 'sm', variant: 'soft', icon: 'sparkles', onClick: props.onRefine }, t('reader.selection.aiRefineCta'))
            : null,
        })
      : null,
    !result.loading && value
      ? React.createElement('div', { className: 'ph-r-resultcard__body' }, value)
      : null,
    !result.loading && value
      ? React.createElement(
          'div',
          { className: 'ph-r-resultcard__actions' },
          React.createElement(Btn, { size: 'sm', variant: 'ghost', icon: 'copy', onClick: props.onCopy }, t('reader.selection.copyTranslation')),
          React.createElement(Btn, { size: 'sm', variant: 'ghost', icon: 'translate', onClick: props.onReplace }, t('reader.selection.replace')),
          React.createElement(Btn, { size: 'sm', variant: 'ghost', icon: 'quote', onClick: props.onSend }, t('reader.selection.sendToChat')),
          props.onRefine && !result.aiRefine
            ? React.createElement(Btn, { size: 'sm', variant: 'soft', icon: 'sparkles', onClick: props.onRefine, title: t('reader.selection.aiRefineHint') }, t('reader.selection.aiRefine'))
            : null,
        )
      : null,
  )
}

/**
 * Normalise a `figures.list` bbox to a page-relative box. Figures usually carry
 * PDF points plus pageWidth/pageHeight; older callers pass 0–1 values already.
 */
function figureRectStyle(bbox) {
  if (!bbox) return null
  let x = Number(bbox.x)
  let y = Number(bbox.y)
  let w = Number(bbox.w)
  let h = Number(bbox.h)
  if (![x, y, w, h].every((value) => Number.isFinite(value))) return null
  const pageWidth = Number(bbox.pageWidth)
  const pageHeight = Number(bbox.pageHeight)
  if (Number.isFinite(pageWidth) && pageWidth > 0 && Number.isFinite(pageHeight) && pageHeight > 0 && (x > 1 || y > 1 || w > 1 || h > 1)) {
    x /= pageWidth
    y /= pageHeight
    w /= pageWidth
    h /= pageHeight
  }
  return {
    left: (clamp(x, 0, 1) * 100).toFixed(3) + '%',
    top: (clamp(y, 0, 1) * 100).toFixed(3) + '%',
    width: (clamp(w, 0.001, 1) * 100).toFixed(3) + '%',
    height: (clamp(h, 0.001, 1) * 100).toFixed(3) + '%',
  }
}

/**
 * Drag ghosts for on-page figures. A transparent hit box makes a blank native
 * drag image, so a small offscreen <img> of the real figure is snapshotted
 * instead. Cached per figure id and capped; the nodes live outside the page.
 */
const dragGhosts = new Map()
function dragGhostFor(figure, id) {
  if (typeof document === 'undefined' || !id) return null
  const cached = dragGhosts.get(id)
  if (cached) return cached
  const url = (figure && figure.imageUrl) || '/pappers-hall/figure/' + id + '.png?width=320'
  const img = document.createElement('img')
  img.src = url
  img.alt = ''
  img.setAttribute('aria-hidden', 'true')
  img.style.cssText = 'position:fixed;left:-10000px;top:-10000px;width:140px;height:auto;pointer-events:none;'
  document.body.appendChild(img)
  dragGhosts.set(id, img)
  if (dragGhosts.size > 40) {
    const oldest = dragGhosts.keys().next().value
    const node = dragGhosts.get(oldest)
    if (node && node.parentNode) node.parentNode.removeChild(node)
    dragGhosts.delete(oldest)
  }
  return img
}

/**
 * The real figure box on the page doubles as a draggable material source, so a
 * figure can be dragged straight into the conversation or an open note instead
 * of going through a side-panel figure list. Regions only exist in select mode:
 * area/note tools need the raw page surface.
 */
export function FigureDragRegions(props) {
  const t = props.t
  const regions = []
  for (const figure of arrayOf(props.figures)) {
    const id = figure && (figure.id || figure.figureId)
    const style = figureRectStyle(figure && figure.bbox)
    if (!id || !style) continue
    const label = firstText(figure.label)
    const page = Math.round(num(figure.page, props.page))
    const material = {
      kind: 'figure',
      id,
      figureId: id,
      paperId: figure.paperId || props.paperId,
      page: page > 0 ? page : props.page,
      label,
      title: label,
      caption: firstText(figure.caption),
    }
    const baseDrag = dragProps(t, [material], { source: 'page' })
    const regionDrag = Object.assign({}, baseDrag, {
      onDragStart: (event) => {
        const ghost = dragGhostFor(figure, String(id))
        if (ghost) {
          try { event.dataTransfer.setDragImage(ghost, 24, 24) } catch (error) { /* engines without a drag image */ }
        }
        baseDrag.onDragStart(event)
      },
    })
    regions.push(React.createElement(
      'div',
      Object.assign(
        {
          key: 'figdrag-' + id,
          className: 'ph-r-figdrag',
          style,
          title: t('reader.figure.dragHint'),
          role: 'img',
          'aria-label': label ? t('reader.figure.dragLabel', { label }) : t('reader.figure.dragHint'),
          'data-ph-figure-drag': String(id),
          // A native material drag must never race the geometric text selection.
          onMouseDown: (event) => event.stopPropagation(),
          onClick: (event) => event.stopPropagation(),
        },
        regionDrag,
      ),
      React.createElement(
        'span',
        { className: 'ph-r-figdrag__chip', 'aria-hidden': 'true' },
        label ? t('reader.figure.dragChip', { label }) : t('reader.figure.dragChipNoLabel'),
      ),
    ))
  }
  if (regions.length === 0) return null
  return React.createElement('div', { className: 'ph-r-figdrags' }, regions)
}

/**
 * Temporary figure highlight (v0.15). `figureFocus.bbox` is normalised to the
 * rendered page (x/y/w/h 0–1, from figures.list pageWidth/pageHeight), so the
 * dashed box scales with zoom without recomputing pixel geometry.
 */
export function FigureHighlightOverlay(props) {
  const t = props.t
  const focus = props.figureFocus
  // v0.15: the overlay owns its visual lifetime. Parent-state timers can be
  // swallowed by StrictMode effect cleanup, leaving an invisible-but-present
  // node for many seconds; a local timer removes the actual DOM node instead.
  const focusKey = focus && focus.figureId ? String(focus.figureId) + ':' + String(focus.seq || '') + ':' + String(props.page == null ? '' : props.page) : ''
  const [expired, setExpired] = React.useState(false)
  React.useEffect(() => {
    setExpired(false)
    if (focusKey === '') return undefined
    const timer = setTimeout(() => setExpired(true), 4600)
    return () => clearTimeout(timer)
  }, [focusKey])
  if (!focus || !focus.bbox) return null
  if (expired) return null
  if (props.page != null && Number(focus.page) !== Number(props.page)) return null
  // v0.15 fix: figures.list returns PDF-point bboxes (with pageWidth/pageHeight);
  // harness/older callers may pass already-normalised 0-1 values, so the shared
  // helper normalises here and the highlight lands on the real figure box.
  const style = figureRectStyle(focus.bbox)
  if (!style) return null
  const label = focus.figureLabel ? t('reader.figure.highlightLabel', { label: focus.figureLabel }) : t('reader.figure.highlight')
  return React.createElement(
    'div',
    { className: 'ph-r-fighl', style: style, 'data-ph-figure-focus': String(focus.figureId || ''), 'aria-hidden': 'true' },
    React.createElement('span', { className: 'ph-r-fighl__label' }, label),
  )
}

/* -------------------------------------------------------------------------- */
/* Canvas                                                                      */
/* -------------------------------------------------------------------------- */

/**
 * @param {object} props
 * @param {object} props.t
 * @param {string} props.paperId
 * @param {Array} props.pages `reader.open.pages` (may be empty)
 * @param {number} props.total
 * @param {number} props.zoom 0.75–2 relative to fit width
 * @param {number} props.jump `{page, seq}` — every change scrolls to that page
 * @param {object|null} props.focus `{page, rect, seq}` — scroll to a search hit
 * @param {object|null} props.figureFocus `{figureId, page, bbox, figureLabel, seq}` — temporary figure box
 * @param {Array} props.figures `figures.list` rows for this paper; each renders a draggable box on its page
 * @param {Array} props.annotations normalised annotations (all pages)
 * @param {string|null} props.activeAnnotationId
 * @param {object|null} props.selection
 * @param {object|null} props.selectionResult
 * @param {object|null} props.popover
 * @param {object|null} props.noteDraft
 * @param {object|null} props.search
 * @param {'select'|'area'|'note'} props.mode
 * @param {number} props.page Current page (mobile/reporting)
 * @param {number} props.dataVersion Bumped whenever a page/layer cache entry changed.
 * @param {Function} props.getPageData page -> entry
 * @param {Function} props.getLayer page -> entry
 * @param {Function} props.onPageChange
 * @param {Function} props.onScrolledChange
 * @param {Function} props.ensurePage
 * @param {Function} props.ensureLayer
 * @param {object} props.actions Selection/annotation callbacks forwarded to pages.
 */
export function PageCanvas(props) {
  const scrollRef = React.useRef(null)
  const layoutRef = React.useRef([])
  const previousLayoutRef = React.useRef(null)
  const rafRef = React.useRef(0)
  const scrolledRef = React.useRef(false)
  const [scrollTop, setScrollTop] = React.useState(0)
  const [viewport, setViewport] = React.useState({ width: 0, height: 0 })
  const size = useElementSizeCompat(scrollRef)

  React.useEffect(() => {
    setViewport({ width: size.width, height: size.height })
  }, [size.width, size.height])

  const descriptors = usePageDescriptors(props.pages, props.total)
  const baseWidth = React.useMemo(() => {
    if (viewport.width > 0) {
      return clamp(viewport.width - CANVAS_SIDE_PADDING * 2, MIN_BASE_WIDTH, MAX_BASE_WIDTH)
    }
    return 640
  }, [viewport.width])

  const layout = React.useMemo(() => {
    const list = []
    let top = PAGE_TOP_PADDING
    for (const descriptor of descriptors) {
      const pageWidth = baseWidth * props.zoom
      const pageHeight = pageWidth * (descriptor.height / descriptor.width)
      list.push({ descriptor, width: pageWidth, height: pageHeight, top })
      top += pageHeight + PAGE_GAP
    }
    return list
  }, [baseWidth, descriptors, props.zoom])
  layoutRef.current = layout

  const contentHeight = layout.length > 0 ? layout[layout.length - 1].top + layout[layout.length - 1].height + PAGE_BOTTOM_PADDING : 0

  /* -- keep the current page anchored across zoom/resize ------------------- */

  React.useLayoutEffect(() => {
    const element = scrollRef.current
    const previous = previousLayoutRef.current
    if (!element || !previous || previous.length === 0 || layout.length === 0) {
      previousLayoutRef.current = layout
      return
    }
    if (previous.length === layout.length) {
      // Locate the page under the viewport top in the previous layout.
      let anchorIndex = 0
      for (let index = 0; index < previous.length; index += 1) {
        if (previous[index].top <= scrollTop + 8) anchorIndex = index
        else break
      }
      const previousItem = previous[anchorIndex]
      const nextItem = layout[anchorIndex]
      if (previousItem && nextItem) {
        const ratio = previousItem.height > 0 ? (scrollTop - previousItem.top) / previousItem.height : 0
        const nextTop = nextItem.top + ratio * nextItem.height
        if (Math.abs(nextTop - scrollTop) > 1) {
          scrollElementTo(element, nextTop, false)
          setScrollTop(nextTop)
        }
      }
    }
    previousLayoutRef.current = layout
  }, [layout, scrollTop])

  /* -- jump to page -------------------------------------------------------- */

  React.useEffect(() => {
    const jump = props.jump
    if (!jump || !jump.page) return
    const element = scrollRef.current
    const index = layout.findIndex((item) => item.descriptor.page === jump.page)
    if (!element || index < 0) return
    // Page jumps are instant: scrolling through intermediate pages would make
    // the "current page" flicker and defeat the cross-fade. The active-page CSS
    // animation provides the visual transition instead.
    scrollElementTo(element, layout[index].top, false)
    setScrollTop(layout[index].top)
    props.onPageChange(jump.page)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.jump && props.jump.seq])

  /* -- search focus -------------------------------------------------------- */

  React.useEffect(() => {
    const focus = props.focus
    if (!focus || !focus.page || !focus.rect) return
    const element = scrollRef.current
    const index = layout.findIndex((item) => item.descriptor.page === focus.page)
    if (!element || index < 0) return
    const item = layout[index]
    scrollElementTo(element, item.top + focus.rect.y * item.height - 140, !props.reducedMotion)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.focus && props.focus.seq])

  /* -- scroll tracking + current page -------------------------------------- */

  const handleScroll = React.useCallback(() => {
    const element = scrollRef.current
    if (!element) return
    if (rafRef.current) return
    const run = () => {
      rafRef.current = 0
      const currentTop = element.scrollTop || 0
      setScrollTop(currentTop)
      const collapsed = currentTop > 20
      if (collapsed !== scrolledRef.current) {
        scrolledRef.current = collapsed
        if (props.onScrolledChange) props.onScrolledChange(collapsed)
      }
      const list = layoutRef.current
      if (list.length === 0) return
      const probe = currentTop + Math.max(120, (element.clientHeight || 0) * 0.32)
      let current = list[0].descriptor.page
      for (const item of list) {
        if (item.top <= probe) current = item.descriptor.page
        else break
      }
      if (current !== props.page) props.onPageChange(current)
    }
    if (typeof requestAnimationFrame === 'function') rafRef.current = requestAnimationFrame(run)
    else run()
  }, [props])

  const visibleRange = React.useMemo(() => {
    if (layout.length === 0) return { start: 0, end: -1 }
    const height = viewport.height > 0 ? viewport.height : 900
    const top = scrollTop - height * VIRTUAL_BUFFER
    const bottom = scrollTop + height * (VIRTUAL_BUFFER + 1)
    let start = 0
    let end = layout.length - 1
    for (let index = 0; index < layout.length; index += 1) {
      const item = layout[index]
      if (item.top + item.height >= top) {
        start = index
        break
      }
    }
    for (let index = start; index < layout.length; index += 1) {
      const item = layout[index]
      if (item.top > bottom) {
        end = index - 1
        break
      }
    }
    // Always include the active page so the "current page" state never points
    // at a placeholder while the user scrolls quickly.
    const activeIndex = layout.findIndex((item) => item.descriptor.page === props.page)
    if (activeIndex >= 0) {
      start = Math.min(start, Math.max(0, activeIndex - 1))
      end = Math.max(end, Math.min(layout.length - 1, activeIndex + 1))
    }
    return { start, end }
  }, [layout, props.page, scrollTop, viewport.height])

  /* -- request data for visible pages -------------------------------------- */

  React.useEffect(() => {
    const list = layoutRef.current
    for (let index = visibleRange.start; index <= visibleRange.end; index += 1) {
      const item = list[index]
      if (!item) continue
      if (props.ensurePage) props.ensurePage(item.descriptor.page)
      if (props.ensureLayer) props.ensureLayer(item.descriptor.page)
    }
  }, [props.ensureLayer, props.ensurePage, props.dataVersion, visibleRange])

  const annotationsByPage = useAnnotationsByPage(props.annotations)

  const figuresByPage = React.useMemo(() => {
    const map = new Map()
    for (const figure of arrayOf(props.figures)) {
      const figurePage = Math.round(num(figure && figure.page, 0))
      if (!(figurePage > 0)) continue
      if (!map.has(figurePage)) map.set(figurePage, [])
      map.get(figurePage).push(figure)
    }
    return map
  }, [props.figures])

  const children = []
  for (let index = 0; index < layout.length; index += 1) {
    const item = layout[index]
    const descriptor = item.descriptor
    const visible = index >= visibleRange.start && index <= visibleRange.end
    if (!visible) {
      children.push(
        React.createElement(
          'div',
          {
            key: 'ph-' + descriptor.page,
            className: 'ph-r-page__placeholder',
            style: { width: item.width, height: item.height },
            'aria-hidden': 'true',
          },
          String(descriptor.page),
        ),
      )
      continue
    }
    children.push(
      React.createElement(PageView, {
        key: 'ph-' + descriptor.page,
        t: props.t,
        paperId: props.paperId,
        pageInfo: descriptor,
        width: item.width,
        height: item.height,
        active: descriptor.page === props.page,
        mode: props.mode,
        pageDataEntry: props.getPageData ? props.getPageData(descriptor.page) : null,
        layerEntry: props.getLayer ? props.getLayer(descriptor.page) : null,
        annotations: annotationsByPage.get(descriptor.page) || EMPTY_LIST,
        activeAnnotationId: props.activeAnnotationId,
        selection: props.selection,
        selectionResult: props.selectionResult,
        popover: props.popover,
        noteDraft: props.noteDraft,
        search: props.search,
        figureFocus: props.figureFocus,
        figures: figuresByPage.get(descriptor.page) || EMPTY_LIST,
        reducedMotion: props.reducedMotion,
        onSelection: props.actions.onSelection,
        onSelectionAction: props.actions.onSelectionAction,
        onAnnotationOpen: props.actions.onAnnotationOpen,
        onAnnotationClose: props.actions.onAnnotationClose,
        onUpdateAnnotation: props.actions.onUpdateAnnotation,
        onDeleteAnnotation: props.actions.onDeleteAnnotation,
        onCopyAnnotation: props.actions.onCopyAnnotation,
        onCiteAnnotation: props.actions.onCiteAnnotation,
        onAskAnnotation: props.actions.onAskAnnotation,
        onExplainAnnotation: props.actions.onExplainAnnotation,
        onQuickTranslateAnnotation: props.actions.onQuickTranslateAnnotation,
        onAiTranslateAnnotation: props.actions.onAiTranslateAnnotation,
        onCreateArea: props.actions.onCreateArea,
        onNoteCreate: props.actions.onNoteCreate,
        onNoteSave: props.actions.onNoteSave,
        onNoteCancel: props.actions.onNoteCancel,
      }),
    )
  }

  return React.createElement(
    'div',
    {
      ref: scrollRef,
      className: 'ph-r-canvas ph-r-scroll',
      onScroll: handleScroll,
      'data-ph-scroll': 'canvas',
    },
    React.createElement(
      'div',
      { className: 'ph-r-pages', style: { minHeight: contentHeight } },
      children,
    ),
  )
}

/* -------------------------------------------------------------------------- */
/* Local size observer (kept separate to avoid importing the full hook file)   */
/* -------------------------------------------------------------------------- */

function useElementSizeCompat(ref) {
  const [size, setSize] = React.useState({ width: 0, height: 0 })
  React.useEffect(() => {
    const element = ref.current
    if (!element) return undefined
    let frame = 0
    const measure = () => {
      frame = 0
      const width = element.clientWidth || 0
      const height = element.clientHeight || 0
      setSize((previous) => (previous.width === width && previous.height === height ? previous : { width, height }))
    }
    const schedule = () => {
      if (frame) return
      frame = typeof requestAnimationFrame === 'function' ? requestAnimationFrame(measure) : setTimeout(measure, 16)
    }
    measure()
    let observer = null
    if (typeof ResizeObserver !== 'undefined') {
      observer = new ResizeObserver(schedule)
      observer.observe(element)
    } else if (typeof window !== 'undefined') {
      window.addEventListener('resize', schedule)
    }
    return () => {
      if (frame) {
        if (typeof cancelAnimationFrame === 'function') cancelAnimationFrame(frame)
        else clearTimeout(frame)
      }
      if (observer) observer.disconnect()
      else if (typeof window !== 'undefined') window.removeEventListener('resize', schedule)
    }
  }, [ref])
  return size
}
