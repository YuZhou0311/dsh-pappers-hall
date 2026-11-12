/**
 * Inline 24×24 outline icons shared by every surface. Every icon inherits
 * `currentColor`, so callers colour them with theme tokens only.
 */
import React from 'react'
import { h } from './dom.js'

/** name → array of SVG shape specs. */
export const ICONS = {
  book: [['path', 'M6 4.5h9l3 3v12a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1v-14a1 1 0 0 1 1-1Z'], ['path', 'M8.5 9h5M8.5 12.5h4']],
  note: [['path', 'M6 4.5h12a1 1 0 0 1 1 1V19a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1V5.5a1 1 0 0 1 1-1Z'], ['path', 'M8.5 9h7M8.5 12.5h7M8.5 16h4']],
  image: [['rect', { x: 4, y: 5, width: 16, height: 14, rx: 2 }], ['circle', { cx: 9, cy: 10, r: 1.4 }], ['path', 'm5 17.5 5-5 3.5 3.5 2.5-2.5 3 3']],
  figure: [['rect', { x: 4, y: 5, width: 16, height: 14, rx: 2 }], ['path', 'M4 15.5 9 11l3.5 3.5L17 10l3 3']],
  pages: [['rect', { x: 4.5, y: 4.5, width: 11, height: 15, rx: 1.2 }], ['path', 'M8 9h4M8 12.5h4']],
  search: [['circle', { cx: 10.5, cy: 10.5, r: 6.2 }], ['path', 'M15.2 15.2 20 20']],
  close: [['path', 'M6 6l12 12M18 6 6 18']],
  check: [['path', 'm5 12.5 4.5 4.5L19 7.5']],
  plus: [['path', 'M12 5v14M5 12h14']],
  minus: [['path', 'M5 12h14']],
  chevronLeft: [['path', 'm14.5 6-6 6 6 6']],
  chevronRight: [['path', 'm9.5 6 6 6-6 6']],
  chevronDown: [['path', 'm6 9.5 6 6 6-6']],
  chevronUp: [['path', 'm6 14.5 6-6 6 6']],
  arrowLeft: [['path', 'M19 12H5'], ['path', 'm10 7-5 5 5 5']],
  arrowRight: [['path', 'M5 12h14'], ['path', 'm14 7 5 5-5 5']],
  import: [['path', 'M12 4v10.5'], ['path', 'm8 10.5 4 4 4-4'], ['path', 'M5 17.5V19a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-1.5']],
  download: [['path', 'M12 4v10.5'], ['path', 'm8 10.5 4 4 4-4'], ['path', 'M5 18.5h14']],
  tag: [['path', 'M4.5 5.5h9l6 6a2 2 0 0 1 0 2.8l-3.2 3.2a2 2 0 0 1-2.8 0l-6-6v-9Z'], ['circle', { cx: 8.5, cy: 9.5, r: 1.1 }]],
  folder: [['path', 'M4 7.5a1.5 1.5 0 0 1 1.5-1.5h3.6l1.8 2H18a1.5 1.5 0 0 1 1.5 1.5V18a1.5 1.5 0 0 1-1.5 1.5H5.5A1.5 1.5 0 0 1 4 18V7.5Z']],
  folderOpen: [['path', 'M4 18V7.5A1.5 1.5 0 0 1 5.5 6h3.6l1.8 2H17a1.5 1.5 0 0 1 1.5 1.5V11'], ['path', 'M4 18l2.4-6.2A1.5 1.5 0 0 1 7.8 11h12.3a1 1 0 0 1 .9 1.4L18.6 18H4Z']],
  collection: [['rect', { x: 4, y: 4, width: 7, height: 7, rx: 1.4 }], ['rect', { x: 13, y: 4, width: 7, height: 7, rx: 1.4 }], ['rect', { x: 4, y: 13, width: 7, height: 7, rx: 1.4 }], ['path', 'M16.5 13.5v6M13.5 16.5h6']],
  clock: [['circle', { cx: 12, cy: 12, r: 7.5 }], ['path', 'M12 7.5V12l3 2']],
  eye: [['path', 'M3.5 12S6.8 6.5 12 6.5 20.5 12 20.5 12 17.2 17.5 12 17.5 3.5 12 3.5 12Z'], ['circle', { cx: 12, cy: 12, r: 2.6 }],
  ],
  circle: [['circle', { cx: 12, cy: 12, r: 7 }]],
  circleDot: [['circle', { cx: 12, cy: 12, r: 7 }], ['circle', { cx: 12, cy: 12, r: 2.6, fill: 'currentColor', stroke: 'none' }]],
  checkCircle: [['circle', { cx: 12, cy: 12, r: 8 }], ['path', 'm8.2 12.3 2.6 2.6 5-5.2']],
  trash: [['path', 'M5 7h14M10 7V5a1 1 0 0 1 1-1h2a1 1 0 0 1 1 1v2M7 7l1 13h8l1-13'], ['path', 'M10 11v5.5M14 11v5.5']],
  restore: [['path', 'M4.5 12a7.5 7.5 0 1 0 2.2-5.3'], ['path', 'M4.5 5v4h4']],
  refresh: [['path', 'M20 12a8 8 0 1 1-2.3-5.6'], ['path', 'M20 5.5V10h-4.4']],
  warning: [['path', 'M12 4.5 21 19.5H3L12 4.5Z'], ['path', 'M12 10v4.2M12 17.2v.2']],
  info: [['circle', { cx: 12, cy: 12, r: 8 }], ['path', 'M12 11v5M12 8.2v.2']],
  external: [['path', 'M13.5 5.5H19v5.5'], ['path', 'M19 5.5 11 13.5'], ['path', 'M17 14v4a1.5 1.5 0 0 1-1.5 1.5h-10A1.5 1.5 0 0 1 4 18V8a1.5 1.5 0 0 1 1.5-1.5H9']],
  link: [['path', 'M10 14a4 4 0 0 0 5.7 0l2.6-2.6a4 4 0 0 0-5.7-5.7L11.4 6.9'], ['path', 'M14 10a4 4 0 0 0-5.7 0L5.7 12.6a4 4 0 0 0 5.7 5.7l1.2-1.2']],
  copy: [['rect', { x: 8.5, y: 8.5, width: 11, height: 11, rx: 2 }], ['path', 'M15.5 8.5V6A1.5 1.5 0 0 0 14 4.5H6A1.5 1.5 0 0 0 4.5 6v8A1.5 1.5 0 0 0 6 15.5h2.5']],
  edit: [['path', 'M4.5 19.5h4L19 9a2.1 2.1 0 0 0-3-3L5.5 16.5v3Z'], ['path', 'm13.8 7.2 3 3']],
  quote: [['path', 'M9.5 6.5H6.5a2 2 0 0 0-2 2v3a2 2 0 0 0 2 2h2v2.5a2 2 0 0 1-2 2'], ['path', 'M19 6.5h-3a2 2 0 0 0-2 2v3a2 2 0 0 0 2 2h2v2.5a2 2 0 0 1-2 2']],
  drag: [['circle', { cx: 9, cy: 6, r: 1.1 }], ['circle', { cx: 15, cy: 6, r: 1.1 }], ['circle', { cx: 9, cy: 12, r: 1.1 }], ['circle', { cx: 15, cy: 12, r: 1.1 }], ['circle', { cx: 9, cy: 18, r: 1.1 }], ['circle', { cx: 15, cy: 18, r: 1.1 }]],
  more: [['circle', { cx: 6, cy: 12, r: 1.2 }], ['circle', { cx: 12, cy: 12, r: 1.2 }], ['circle', { cx: 18, cy: 12, r: 1.2 }]],
  pause: [['path', 'M9.5 6v12M14.5 6v12']],
  play: [['path', 'M8 5.5v13l10-6.5-10-6.5Z']],
  grid: [['rect', { x: 4, y: 4, width: 6.4, height: 6.4, rx: 1.2 }], ['rect', { x: 13.6, y: 4, width: 6.4, height: 6.4, rx: 1.2 }], ['rect', { x: 4, y: 13.6, width: 6.4, height: 6.4, rx: 1.2 }], ['rect', { x: 13.6, y: 13.6, width: 6.4, height: 6.4, rx: 1.2 }]],
  list: [['path', 'M4 6.5h16M4 12h16M4 17.5h16']],
  columns: [['rect', { x: 4, y: 4.5, width: 16, height: 15, rx: 1.6 }], ['path', 'M10 4.5v15M15.5 4.5v15']],
  panelLeft: [['rect', { x: 3.5, y: 4.5, width: 17, height: 15, rx: 2 }], ['path', 'M9.5 4.5v15']],
  panelRight: [['rect', { x: 3.5, y: 4.5, width: 17, height: 15, rx: 2 }], ['path', 'M14.5 4.5v15']],
  sort: [['path', 'M7 5v14M4 16l3 3 3-3'], ['path', 'M17 19V5M14 8l3-3 3 3']],
  filter: [['path', 'M4 5.5h16l-6 7v6l-4 2v-8l-6-7Z']],
  palette: [['path', 'M12 3.5a8.5 8.5 0 1 0 0 17c1.4 0 2-1 2-2s-.7-2-2-2h-1a2 2 0 0 1 0-4h2.5A4.5 4.5 0 0 0 18 8.1'], ['circle', { cx: 8, cy: 9, r: 1 }], ['circle', { cx: 11.5, cy: 6.5, r: 1 }], ['circle', { cx: 15, cy: 8.5, r: 1 }]],
  pin: [['path', 'M9 4h6l-1 5 3 3v2H7v-2l3-3-1-5Z'], ['path', 'M12 14v6']],
  sparkle: [['path', 'M12 3.5 13.8 9l5.5 1.8-5.5 1.8L12 18l-1.8-5.4L4.7 10.8 10.2 9 12 3.5Z'], ['path', 'M18.5 15.5 19.2 18l2.3.7-2.3.7-.7 2.4-.7-2.4-2.3-.7 2.3-.7.7-2.5Z']],
  highlighter: [['path', 'm9 14.5 6.5-6.5a2.3 2.3 0 0 1 3.2 3.2L12.2 17.7a3 3 0 0 1-2.1.9H6.5l1-1.6'], ['path', 'M4 21h7']],
  message: [['path', 'M5 5.5h14a1.5 1.5 0 0 1 1.5 1.5v8a1.5 1.5 0 0 1-1.5 1.5h-7l-4.5 3v-3H5A1.5 1.5 0 0 1 3.5 15V7A1.5 1.5 0 0 1 5 5.5Z']],
  users: [['circle', { cx: 9.5, cy: 9, r: 3 }], ['path', 'M4 19.5c0-3 2.5-5 5.5-5s5.5 2 5.5 5'], ['path', 'M15.5 6.6a3 3 0 0 1 0 5.8'], ['path', 'M17 14.8c2 .6 3.5 2.3 3.5 4.7']],
  calendar: [['rect', { x: 4, y: 5.5, width: 16, height: 14, rx: 2 }], ['path', 'M8 3.5v4M16 3.5v4M4 10h16']],
  zoomIn: [['circle', { cx: 10.5, cy: 10.5, r: 6 }], ['path', 'M15 15 20 20M10.5 8v5M8 10.5h5']],
  zoomOut: [['circle', { cx: 10.5, cy: 10.5, r: 6 }], ['path', 'M15 15 20 20M8 10.5h5']],
  fitWidth: [['path', 'M4 6v12M20 6v12'], ['path', 'M8 12h8M8 12l2.5-2.5M8 12l2.5 2.5M16 12l-2.5-2.5M16 12l-2.5 2.5']],
  file: [['path', 'M6.5 3.5h7l4 4v13h-11v-17Z'], ['path', 'M13.5 3.8v4h4']],
  layers: [['path', 'm12 4 8 4-8 4-8-4 8-4Z'], ['path', 'm4 12 8 4 8-4'], ['path', 'm4 16 8 4 8-4']],
  table: [['rect', { x: 4, y: 5, width: 16, height: 14, rx: 1.6 }], ['path', 'M4 10h16M4 14.5h16M10 5v14']],
  bullets: [['path', 'M9 6.5h11M9 12h11M9 17.5h11'], ['circle', { cx: 4.8, cy: 6.5, r: 1.1, fill: 'currentColor', stroke: 'none' }], ['circle', { cx: 4.8, cy: 12, r: 1.1, fill: 'currentColor', stroke: 'none' }], ['circle', { cx: 4.8, cy: 17.5, r: 1.1, fill: 'currentColor', stroke: 'none' }]],
  listOrdered: [['path', 'M9.5 6.5H20M9.5 12H20M9.5 17.5H20'], ['path', 'M4 5.5h1.4v3M4 11h1.2c.5 0 .9.3.9.8s-.4.9-.9.9H4c-.2.7 1.6 1.6 2.3 2.3l-2.3.1']],
  folderPlus: [['path', 'M4 7.5a1.5 1.5 0 0 1 1.5-1.5h3.6l1.8 2H18a1.5 1.5 0 0 1 1.5 1.5V18a1.5 1.5 0 0 1-1.5 1.5H5.5A1.5 1.5 0 0 1 4 18V7.5Z'], ['path', 'M12 11.5v5M9.5 14h5']],
  unlink: [['path', 'M10 14a4 4 0 0 0 5.7 0l2.6-2.6a4 4 0 0 0-5.7-5.7L11.4 6.9'], ['path', 'M14 10a4 4 0 0 0-5.7 0L5.7 12.6a4 4 0 0 0 5.7 5.7l1.2-1.2'], ['path', 'M4 4l16 16']],
  translate: [['path', 'M4 6h9M8.5 4v2M11 6c0 4-3 7-6.5 8.5M6 10.5c1.2 2.2 3 3.7 5 4.6'], ['path', 'M13 20l3.8-9.5L20.5 20M14.4 16.8h4.9']],
  history: [['path', 'M4.5 12a7.5 7.5 0 1 0 2.2-5.3'], ['path', 'M4.5 5v4h4'], ['path', 'M12 8v4.2l2.8 1.8']],
  panelBottom: [['rect', { x: 3.5, y: 4.5, width: 17, height: 15, rx: 2 }], ['path', 'M3.5 14h17']],
  settings: [['circle', { cx: 12, cy: 12, r: 2.6 }], ['path', 'M19.2 13.5a7.6 7.6 0 0 0 0-3l2-1.4-2-3.4-2.3 1a7.6 7.6 0 0 0-2.6-1.5L14 2.5h-4l-.3 2.7a7.6 7.6 0 0 0-2.6 1.5l-2.3-1-2 3.4 2 1.4a7.6 7.6 0 0 0 0 3l-2 1.4 2 3.4 2.3-1a7.6 7.6 0 0 0 2.6 1.5l.3 2.7h4l.3-2.7a7.6 7.6 0 0 0 2.6-1.5l2.3 1 2-3.4-2-1.4Z']],
}

// aliases used by newer surfaces (v0.11 settings)
ICONS.scan = ICONS.pages
ICONS.globe = ICONS.link
ICONS.sparkles = ICONS.sparkle
ICONS.chart = ICONS.grid

/** Render one outline icon. */
export function Icon(props) {
  const size = Number(props.size) || 16
  const shapes = ICONS[props.name] || ICONS.book
  const children = shapes.map((shape, index) => {
    if (shape[0] === 'path') return h('path', { key: index, d: shape[1] })
    if (shape[0] === 'circle') return h('circle', Object.assign({ key: index }, shape[1]))
    return h('rect', Object.assign({ key: index }, shape[1]))
  })
  return h(
    'svg',
    {
      className: props.className ? 'ph-icon ' + props.className : 'ph-icon',
      width: size,
      height: size,
      viewBox: '0 0 24 24',
      fill: 'none',
      stroke: 'currentColor',
      strokeWidth: props.weight || 1.6,
      strokeLinecap: 'round',
      strokeLinejoin: 'round',
      'aria-hidden': 'true',
      focusable: 'false',
    },
    children,
  )
}
