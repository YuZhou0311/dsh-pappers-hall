/**
 * Sidebar entry glyph: a paper page with a highlighted passage, searched by a
 * magnifier. Sized by the sidebar owner and coloured with `currentColor`.
 */
import React from 'react'
import { h } from '../core/dom.js'

export function PanelIcon(props) {
  const size = Number(props && props.size) || 24
  return h(
    'svg',
    {
      className: 'ph-panel-icon',
      width: size,
      height: size,
      viewBox: '0 0 24 24',
      fill: 'none',
      stroke: 'currentColor',
      strokeWidth: 1.6,
      strokeLinecap: 'round',
      strokeLinejoin: 'round',
      'aria-hidden': 'true',
      focusable: 'false',
    },
    h('path', { d: 'M6.2 3.4h7.1l4.3 4.3v6.6a2 2 0 0 1-2 2H6.2a2 2 0 0 1-2-2V5.4a2 2 0 0 1 2-2Z' }),
    h('path', { d: 'M13.2 3.5v4.4h4.4' }),
    h('path', { d: 'M7.6 9.1h3.9' }),
    h('path', { d: 'M7.6 12h2.6' }),
    h('rect', { x: 6.6, y: 9.9, width: 4.9, height: 2.9, rx: 1.1, fill: 'currentColor', fillOpacity: 0.22, stroke: 'none' }),
    h('circle', { cx: 15.4, cy: 15.4, r: 3.2 }),
    h('path', { d: 'm17.8 17.8 2.5 2.5' }),
  )
}
