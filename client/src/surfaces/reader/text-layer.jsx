/**
 * Transparent, selectable text layer.
 *
 * The Host renders the page as a PNG; `reader.layer` gives us the words of that
 * page in PDF points (origin top-left). Each word becomes an absolutely
 * positioned, color-transparent span whose box is the real word box, so native
 * browser selection drives the reading experience while the quote/rects are
 * rebuilt from word geometry in `shared.jsx#readPageSelection`.
 *
 * Rotated text (e.g. the vertical arXiv side stamp) is excluded from the
 * selectable layer: those glyph boxes would otherwise stack into a column,
 * pollute drag selections and produce glued-together quotes.
 */
import React from 'react'
import { arrayOf, cx, num } from './shared.jsx'

/** Minimum word box worth rendering (in normalised page units). */
const MIN_WORD_SIZE = 0.0006

/**
 * Filter the layer words down to the selectable set: drops empty boxes and any
 * word that belongs to a rotated/vertical line (or is itself clearly vertical).
 * @param {object|null} layer `reader.layer` payload.
 * @returns {{words:Array, width:number, height:number}}
 */
export function selectableWords(layer) {
  const words = arrayOf(layer && layer.words)
  const width = num(layer && layer.width, 0)
  const height = num(layer && layer.height, 0)
  if (!(width > 0) || !(height > 0) || words.length === 0) return { words: [], width, height }
  // Rotated lines: much taller than wide (the 90° side stamp on arXiv pages).
  const rotatedLines = arrayOf(layer.lines).filter((line) => {
    if (!line) return false
    const lineWidth = num(line.w)
    const lineHeight = num(line.h)
    return lineHeight > lineWidth * 2.5 && lineHeight > height * 0.08
  })
  const filtered = []
  for (const word of words) {
    if (!word || word.t == null || String(word.t) === '') continue
    const x = num(word.x)
    const y = num(word.y)
    const w = num(word.w)
    const h = num(word.h)
    if (!(w > 0.25) || !(h > 0.25)) continue
    const centerX = x + w / 2
    const centerY = y + h / 2
    let rotated = false
    for (const line of rotatedLines) {
      const lineX = num(line.x)
      const lineY = num(line.y)
      if (
        centerX >= lineX - 1.5 &&
        centerX <= lineX + num(line.w) + 1.5 &&
        centerY >= lineY - 1.5 &&
        centerY <= lineY + num(line.h) + 1.5
      ) {
        rotated = true
        break
      }
    }
    // Defensive: extremely tall single tokens are vertical even without a line.
    if (!rotated && h > w * 4 && h > height * 0.04) rotated = true
    if (rotated) continue
    filtered.push(word)
  }
  return { words: filtered, width, height }
}

/** Compute the inline style of one word box. */
function wordStyle(word, width, height) {
  const x = num(word.x)
  const y = num(word.y)
  const w = num(word.w)
  const h = num(word.h)
  const xNorm = x / width
  const yNorm = y / height
  const wNorm = w / width
  const hNorm = h / height
  if (!(wNorm > MIN_WORD_SIZE) || !(hNorm > MIN_WORD_SIZE) || xNorm < -0.02 || yNorm < -0.02 || xNorm > 1.02 || yNorm > 1.02) return null
  return {
    left: (xNorm * 100).toFixed(4) + '%',
    top: (yNorm * 100).toFixed(4) + '%',
    width: (wNorm * 100).toFixed(4) + '%',
    height: (hNorm * 100).toFixed(4) + '%',
    // Font size follows the word box height (the layer inherits --ph-r-pageh).
    fontSize: 'calc(var(--ph-r-pageh, 100px) * ' + (hNorm * 0.94).toFixed(5) + ')',
  }
}

/**
 * @param {object} props
 * @param {number} props.page Page number (data attribute only).
 * @param {Array} props.words Selectable words from `selectableWords`.
 * @param {number} props.width Page width in points (layer coordinate base).
 * @param {number} props.height Page height in points.
 * @param {boolean} props.active Only visible pages need their text layer.
 * @param {boolean} props.interactive False while area/note mode is active.
 */
function PageTextLayerImpl(props) {
  const words = arrayOf(props.words)
  const width = num(props.width)
  const height = num(props.height)
  if (!props.active || words.length === 0 || !(width > 0) || !(height > 0)) return null
  const interactive = props.interactive !== false
  const spans = []
  for (let index = 0; index < words.length; index += 1) {
    const word = words[index]
    const style = wordStyle(word, width, height)
    if (!style) continue
    spans.push(
      React.createElement(
        'span',
        {
          key: index,
          className: 'ph-r-word',
          style: style,
          'data-ph-i': index,
        },
        String(word.t),
      ),
    )
  }
  if (spans.length === 0) return null
  return React.createElement(
    'div',
    {
      className: cx('ph-r-textlayer', !interactive && 'ph-r-textlayer--static'),
      'data-ph-text-layer': String(num(props.page, 0)),
      'aria-hidden': 'true',
    },
    spans,
  )
}

/** Memoised: scroll/selection updates must not re-render thousands of spans. */
export const PageTextLayer = React.memo(PageTextLayerImpl, (previous, next) => {
  return (
    previous.words === next.words &&
    previous.width === next.width &&
    previous.height === next.height &&
    previous.active === next.active &&
    previous.interactive === next.interactive &&
    previous.page === next.page
  )
})
