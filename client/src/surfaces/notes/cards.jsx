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
 * columns plus markdown / cards / chart / gallery / tabs / disclosure / tasks /
 * status / progress / alert / empty / quotes / actions / diagrams. Figure blocks can only come from real `figures.list` candidates (the
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
import { getDataPath } from '../../core/notes-model.js'

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

/** Render a nested block list (used by tabs, disclosures and columns). */
function NestedBlocks(props) {
  const list = Array.isArray(props.blocks) ? props.blocks : []
  return React.createElement(
    React.Fragment,
    null,
    list.map((block, index) => React.createElement(Block, { key: index, block, t: props.t, onOpenFigure: props.onOpenFigure, data: props.data, onChangeData: props.onChangeData, onAction: props.onAction })),
  )
}

/** Markdown block: render the model's rich text, never raw HTML. */
function MarkdownBlock(props) {
  return React.createElement('div', { className: 'ph-n-doc__md' }, React.createElement(Markdown, { text: props.block.text, keyPrefix: 'note-md' }))
}

/** Text/number/select/date/checkbox form bound to contentJson.data. */
function FormBlock(props) {
  const fields = props.block.fields || []
  const data = props.data || {}
  const [local, setLocal] = React.useState({})
  const valueOf = (field) => {
    if (field.bind) {
      const bound = getDataPath(data, field.bind)
      if (bound !== undefined) return bound
    }
    if (Object.prototype.hasOwnProperty.call(local, field.id)) return local[field.id]
    return field.value
  }
  const change = (field, value) => {
    if (field.bind && typeof props.onChangeData === 'function') props.onChangeData(field.bind, value)
    setLocal((current) => ({ ...current, [field.id]: value }))
  }
  const control = (field) => {
    const value = valueOf(field)
    if (field.kind === 'textarea') {
      return React.createElement('textarea', { rows: 3, value: String(value == null ? '' : value), placeholder: field.placeholder || '', onChange: (event) => change(field, event.target.value) })
    }
    if (field.kind === 'select') {
      return React.createElement(
        'select',
        { value: String(value == null ? '' : value), onChange: (event) => change(field, event.target.value) },
        React.createElement('option', { value: '' }, '—'),
        (field.options || []).map((option) => React.createElement('option', { key: option.value, value: option.value }, option.label)),
      )
    }
    if (field.kind === 'multiselect') {
      const selected = Array.isArray(value) ? value : []
      return React.createElement(
        'select',
        { multiple: true, value: selected, onChange: (event) => change(field, [...event.target.selectedOptions].map((option) => option.value)) },
        (field.options || []).map((option) => React.createElement('option', { key: option.value, value: option.value }, option.label)),
      )
    }
    if (field.kind === 'slider') {
      const min = Number.isFinite(Number(field.min)) ? Number(field.min) : 0
      const max = Number.isFinite(Number(field.max)) ? Number(field.max) : 100
      return React.createElement(
        'div',
        { className: 'ph-n-doc__field-slider' },
        React.createElement('input', { type: 'range', min, max, step: field.step || 1, value: Number(value) || min, onChange: (event) => change(field, Number(event.target.value)) }),
        React.createElement('output', null, String(value == null ? min : value)),
      )
    }
    if (field.kind === 'stepper') {
      const min = Number.isFinite(Number(field.min)) ? Number(field.min) : 0
      const max = Number.isFinite(Number(field.max)) ? Number(field.max) : 100
      const step = field.step || 1
      const numeric = Number(value) || min
      return React.createElement(
        'div',
        { className: 'ph-n-doc__field-stepper' },
        React.createElement('button', { type: 'button', onClick: () => change(field, Math.max(min, numeric - step)) }, '−'),
        React.createElement('input', { type: 'number', min, max, step, value: numeric, onChange: (event) => change(field, Number(event.target.value)) }),
        React.createElement('button', { type: 'button', onClick: () => change(field, Math.min(max, numeric + step)) }, '+'),
      )
    }
    if (field.kind === 'date') return React.createElement('input', { type: 'date', value: String(value == null ? '' : value), onChange: (event) => change(field, event.target.value) })
    if (field.kind === 'checkbox') return React.createElement('input', { type: 'checkbox', checked: value === true, onChange: (event) => change(field, event.target.checked) })
    return React.createElement('input', { type: 'text', value: String(value == null ? '' : value), placeholder: field.placeholder || '', onChange: (event) => change(field, event.target.value) })
  }
  return React.createElement(
    'div',
    { className: 'ph-n-doc__form' },
    props.block.title ? React.createElement('div', { className: 'ph-n-doc__form-title' }, props.block.title) : null,
    fields.map((field) => React.createElement(
      'label',
      { key: field.id, className: 'ph-n-doc__field' + (field.kind === 'checkbox' ? ' ph-n-doc__field--check' : '') },
      React.createElement('span', { className: 'ph-n-doc__field-label' }, field.label),
      control(field),
      field.bind ? React.createElement('span', { className: 'ph-n-doc__field-bind' }, field.bind) : null,
    )),
  )
}

function AvatarBlock(props) {
  const block = props.block
  return React.createElement(
    'div',
    { className: 'ph-n-doc__avatar' },
    block.src ? React.createElement('img', { src: block.src, alt: block.name }) : React.createElement('span', { className: 'ph-n-doc__avatar-fallback' }, block.name.slice(0, 1)),
    React.createElement('div', null, React.createElement('strong', null, block.name), block.role ? React.createElement('span', null, block.role) : null),
  )
}

function CalendarBlock(props) {
  return React.createElement(
    'div',
    { className: 'ph-n-doc__calendar' },
    props.block.title ? React.createElement('div', { className: 'ph-n-doc__form-title' }, props.block.title) : null,
    (props.block.events || []).map((event, index) => React.createElement(
      'div',
      { key: index, className: 'ph-n-doc__calendar-event' },
      event.date ? React.createElement('span', { className: 'ph-n-doc__calendar-date' }, event.date) : null,
      React.createElement('strong', null, event.title),
      event.text ? React.createElement('span', null, event.text) : null,
    )),
  )
}

/** Safe aggregate functions over bound data paths (no eval). */
function computedValues(item, data) {
  const numbers = []
  for (const path of item.paths || []) {
    const value = getDataPath(data || {}, path)
    if (Array.isArray(value)) for (const entry of value) if (Number.isFinite(Number(entry))) numbers.push(Number(entry))
    else if (Number.isFinite(Number(value))) numbers.push(Number(value))
  }
  const op = item.op
  if (op === 'count') return numbers.length
  if (numbers.length === 0) return null
  if (op === 'sum') return numbers.reduce((sum, value) => sum + value, 0)
  if (op === 'avg') return numbers.reduce((sum, value) => sum + value, 0) / numbers.length
  if (op === 'min') return Math.min(...numbers)
  if (op === 'max') return Math.max(...numbers)
  return null
}

function ComputedBlock(props) {
  const items = props.block.items || []
  return React.createElement(
    'div',
    { className: 'ph-n-doc__stats ph-n-doc__computed' },
    props.block.title ? React.createElement('div', { className: 'ph-n-doc__form-title' }, props.block.title) : null,
    items.map((item, index) => {
      const value = computedValues(item, props.data)
      return React.createElement(
        'div',
        { key: index, className: 'ph-n-doc__stat' },
        React.createElement('div', { className: 'ph-n-doc__stat-value' }, value === null ? '—' : String(Math.round(value * 100) / 100)),
        React.createElement('div', { className: 'ph-n-doc__stat-label' }, item.label + (item.unit ? ' · ' + item.unit : '')),
      )
    }),
  )
}

/** Responsive nested block grid (1–4 columns). */
function GridBlock(props) {
  return React.createElement(
    'div',
    { className: 'ph-n-doc__grid', style: { '--ph-grid-cols': String(props.block.columns || 2) } },
    (props.block.blocks || []).map((block, index) => React.createElement(Block, { key: index, block, t: props.t, onOpenFigure: props.onOpenFigure, data: props.data, onChangeData: props.onChangeData, onAction: props.onAction })),
  )
}

/** Sortable data table with column definitions. */
function DataTableBlock(props) {
  const block = props.block
  const [sort, setSort] = React.useState({ key: '', dir: 1 })
  const columns = block.columns || []
  const boundRows = block.rowsPath ? getDataPath(props.data || {}, block.rowsPath) : undefined
  const rows = Array.isArray(boundRows)
    ? boundRows.map((row) => Array.isArray(row) ? row : columns.map((column) => row && typeof row === 'object' ? row[column.key] : ''))
    : (block.rows || [])
  const view = rows.map((row, index) => ({ row, index }))
  if (sort.key && block.sortable) {
    const columnIndex = columns.findIndex((column) => column.key === sort.key)
    if (columnIndex >= 0) view.sort((left, right) => String(left.row[columnIndex] || '').localeCompare(String(right.row[columnIndex] || ''), 'zh-Hans-CN', { numeric: true }) * sort.dir)
  }
  const toggle = (column) => {
    if (!block.sortable) return
    setSort((current) => current.key === column.key ? { key: column.key, dir: -current.dir } : { key: column.key, dir: 1 })
  }
  const headCells = columns.map((column) => React.createElement('th', {
    key: column.key,
    style: column.align ? { textAlign: column.align } : undefined,
    onClick: () => toggle(column),
    className: block.sortable ? 'is-sortable' : '',
  }, column.label + (sort.key === column.key ? (sort.dir > 0 ? ' ↑' : ' ↓') : '')))
  const bodyRows = view.map(({ row, index }) => React.createElement('tr', { key: index }, columns.map((column, cellIndex) => React.createElement('td', {
    key: column.key,
    style: column.align ? { textAlign: column.align } : undefined,
  }, row[cellIndex] || ''))))
  const table = React.createElement(
    'table',
    { className: 'ph-n-doc__table' },
    block.caption ? React.createElement('caption', { className: 'ph-n-doc__table-caption' }, block.caption) : null,
    React.createElement('thead', null, React.createElement('tr', null, headCells)),
    React.createElement('tbody', null, bodyRows),
  )
  return React.createElement(
    'div',
    { className: 'ph-n-doc__datatable' },
    block.title ? React.createElement('div', { className: 'ph-n-doc__datatable-title' }, block.title) : null,
    React.createElement('div', { className: 'ph-n-doc__tablewrap' }, table),
  )
}

/** Multi-column comparison table. */
function ComparisonTableBlock(props) {
  const columns = props.block.columns || []
  const max = Math.max(0, ...columns.map((column) => (column.items || []).length))
  return React.createElement(
    'div',
    { className: 'ph-n-doc__comparisontable' },
    props.block.title ? React.createElement('div', { className: 'ph-n-doc__datatable-title' }, props.block.title) : null,
    React.createElement(
      'div',
      { className: 'ph-n-doc__tablewrap' },
      React.createElement(
        'table',
        { className: 'ph-n-doc__table' },
        props.block.caption ? React.createElement('caption', { className: 'ph-n-doc__table-caption' }, props.block.caption) : null,
        React.createElement('thead', null, React.createElement('tr', null, columns.map((column, index) => React.createElement('th', { key: index }, column.title)))),
        React.createElement('tbody', null, Array.from({ length: max }, (_, rowIndex) => React.createElement('tr', { key: rowIndex }, columns.map((column, columnIndex) => React.createElement('td', { key: columnIndex }, (column.items || [])[rowIndex] || ''))))),
      ),
    ),
  )
}

/** Video/audio media block with a safe URL. */
function MediaBlock(props) {
  const block = props.block
  const media = block.kind === 'audio'
    ? React.createElement('audio', { controls: true, src: block.src, preload: 'metadata' })
    : React.createElement('video', { controls: true, src: block.src, poster: block.poster || undefined, preload: 'metadata', playsInline: true })
  return React.createElement(
    'figure',
    { className: 'ph-n-doc__media' },
    media,
    block.title || block.caption ? React.createElement('figcaption', null, block.title ? React.createElement('strong', null, block.title) : null, block.caption || '') : null,
  )
}

/** Small grid/list of content cards. */
function CardsBlock(props) {
  const block = props.block
  return React.createElement(
    'div',
    { className: 'ph-n-doc__cards ph-n-doc__cards--' + (block.layout || 'grid') },
    (block.items || []).map((item, index) => React.createElement(
      'div',
      { key: index, className: 'ph-n-doc__card' + (item.tone ? ' ph-n-doc__card--' + item.tone : '') },
      item.eyebrow ? React.createElement('div', { className: 'ph-n-doc__card-eyebrow' }, item.eyebrow) : null,
      item.title ? React.createElement('div', { className: 'ph-n-doc__card-title' }, item.title) : null,
      item.text ? React.createElement('div', { className: 'ph-n-doc__card-text' }, item.text) : null,
    )),
  )
}

/** Multi-series / stacked SVG chart. */
function MultiSeriesChart(props) {
  const block = props.block
  const series = (block.series || []).filter((entry) => entry && entry.values && entry.values.length > 0)
  const count = Math.max(0, ...series.map((entry) => entry.values.length))
  if (series.length === 0 || count === 0) return null
  const labels = Array.from({ length: count }, (_, index) => (block.labels || [])[index] || String(index + 1))
  const width = 640
  const height = 250
  const pad = { top: 22, right: 16, bottom: 42, left: 42 }
  const plotW = width - pad.left - pad.right
  const plotH = height - pad.top - pad.bottom
  const stacked = block.stacked === true && block.variant === 'bar'
  const totals = Array.from({ length: count }, (_, index) => series.reduce((sum, entry) => sum + Math.max(0, Number(entry.values[index]) || 0), 0))
  const max = Math.max(1, stacked ? Math.max(...totals) : Math.max(...series.flatMap((entry) => entry.values.map((value) => Math.max(0, Number(value) || 0)))))
  const slot = plotW / count
  const groupBar = Math.min(22, (slot * 0.7) / series.length)
  const y = (value) => pad.top + plotH - (Math.max(0, Number(value) || 0) / max) * plotH
  const bars = []
  const lines = []
  if (block.variant === 'line') {
    series.forEach((entry, seriesIndex) => {
      const points = Array.from({ length: count }, (_, index) => pad.left + slot * index + slot / 2 + ',' + y(entry.values[index])).join(' ')
      lines.push(React.createElement('polyline', { key: 'line' + seriesIndex, points, fill: 'none', stroke: 'var(--ph-chart-' + (seriesIndex % 6) + ')', strokeWidth: 2.4, strokeLinejoin: 'round', strokeLinecap: 'round' }))
      for (let index = 0; index < count; index += 1) lines.push(React.createElement('circle', { key: 'dot' + seriesIndex + '-' + index, cx: pad.left + slot * index + slot / 2, cy: y(entry.values[index]), r: 2.8, fill: 'var(--ph-chart-' + (seriesIndex % 6) + ')' }))
    })
  } else {
    for (let index = 0; index < count; index += 1) {
      let baseline = pad.top + plotH
      series.forEach((entry, seriesIndex) => {
        const value = Math.max(0, Number(entry.values[index]) || 0)
        const barHeight = (value / max) * plotH
        const x = stacked
          ? pad.left + slot * index + slot * 0.25
          : pad.left + slot * index + slot / 2 - (series.length * groupBar) / 2 + seriesIndex * groupBar
        const barWidth = stacked ? slot * 0.5 : Math.max(4, groupBar - 2)
        const top = stacked ? baseline - barHeight : y(value)
        bars.push(React.createElement('rect', { key: 'bar' + seriesIndex + '-' + index, x, y: top, width: barWidth, height: Math.max(1, barHeight), rx: 2, fill: 'var(--ph-chart-' + (seriesIndex % 6) + ')' }))
        if (stacked) baseline -= barHeight
      })
    }
  }
  const xLabels = labels.map((label, index) => React.createElement('text', { key: index, x: pad.left + slot * index + slot / 2, y: height - 16, textAnchor: 'middle', className: 'ph-n-doc__chart-label' }, String(label).slice(0, 8)))
  const legend = series.map((entry, index) => React.createElement(
    'div',
    { key: index, className: 'ph-n-doc__chart-legend-row' },
    React.createElement('span', { className: 'ph-n-doc__chart-dot', style: { background: 'var(--ph-chart-' + (index % 6) + ')' } }),
    React.createElement('span', { className: 'ph-n-doc__chart-legend-label' }, entry.name),
  ))
  return React.createElement(
    'div',
    { className: 'ph-n-doc__chart' },
    block.title ? React.createElement('div', { className: 'ph-n-doc__chart-title' }, block.title) : null,
    React.createElement(
      'svg',
      { viewBox: '0 0 640 250', role: 'img', 'aria-label': block.title || 'chart' },
      React.createElement('line', { x1: pad.left, y1: pad.top + plotH, x2: width - pad.right, y2: pad.top + plotH, stroke: 'var(--ph-line)', strokeWidth: 1 }),
      bars,
      lines,
      xLabels,
    ),
    React.createElement('div', { className: 'ph-n-doc__chart-legend' }, legend),
  )
}

/** Dependency-free SVG chart (bar / line / donut). */
function ChartBlock(props) {
  const block = props.block
  if (Array.isArray(block.series) && block.series.length > 0) return React.createElement(MultiSeriesChart, { block })
  const data = (block.data || []).filter((item) => Number.isFinite(Number(item.value))).slice(0, 12)
  if (data.length === 0) return null
  const values = data.map((item) => Number(item.value))
  const width = 640
  const height = 240
  const pad = { top: 20, right: 16, bottom: 42, left: 40 }
  const plotW = width - pad.left - pad.right
  const plotH = height - pad.top - pad.bottom
  const title = block.title ? React.createElement('div', { className: 'ph-n-doc__chart-title' }, block.title) : null
  if (block.variant === 'donut') {
    const positive = values.filter((value) => value > 0)
    if (positive.length === 0) return null
    const total = positive.reduce((sum, value) => sum + value, 0)
    const radius = 74
    const stroke = 26
    const circumference = 2 * Math.PI * radius
    let offset = 0
    const circles = positive.map((value, index) => {
      const fraction = value / total
      const dash = fraction * circumference
      const circle = React.createElement('circle', {
        key: index,
        cx: 150,
        cy: 116,
        r: radius,
        fill: 'none',
        stroke: 'var(--ph-chart-' + (index % 6) + ')',
        strokeWidth: stroke,
        strokeDasharray: dash + ' ' + (circumference - dash),
        strokeDashoffset: -offset,
        transform: 'rotate(-90 150 116)',
      })
      offset += dash
      return circle
    })
    const legend = data.map((item, index) => React.createElement(
      'div',
      { key: index, className: 'ph-n-doc__chart-legend-row' },
      React.createElement('span', { className: 'ph-n-doc__chart-dot', style: { background: 'var(--ph-chart-' + (index % 6) + ')' } }),
      React.createElement('span', { className: 'ph-n-doc__chart-legend-label' }, item.label),
      React.createElement('span', { className: 'ph-n-doc__chart-legend-value' }, item.value + (block.unit ? ' ' + block.unit : '')),
    ))
    return React.createElement(
      'div',
      { className: 'ph-n-doc__chart' },
      title,
      React.createElement(
        'div',
        { className: 'ph-n-doc__chart-donut' },
        React.createElement(
          'svg',
          { viewBox: '0 0 300 240', role: 'img', 'aria-label': block.title || 'chart' },
          circles,
          React.createElement('text', { x: 150, y: 112, textAnchor: 'middle', className: 'ph-n-doc__chart-total' }, String(Math.round(total))),
          React.createElement('text', { x: 150, y: 134, textAnchor: 'middle', className: 'ph-n-doc__chart-total-label' }, block.unit || 'total'),
        ),
        React.createElement('div', { className: 'ph-n-doc__chart-legend' }, legend),
      ),
    )
  }
  const max = Math.max(...values.map((value) => Math.max(0, value)), 1)
  const min = Math.min(0, ...values)
  const range = max - min || 1
  const y = (value) => pad.top + plotH - ((value - min) / range) * plotH
  const slot = plotW / data.length
  const barW = Math.max(12, Math.min(46, slot * 0.55))
  const bars = block.variant === 'bar'
    ? data.map((item, index) => React.createElement('rect', {
        key: index,
        x: pad.left + slot * index + (slot - barW) / 2,
        y: y(Math.max(0, Number(item.value))),
        width: barW,
        height: Math.max(1, pad.top + plotH - y(Math.max(0, Number(item.value)))),
        rx: 3,
        fill: 'var(--ph-chart-' + (index % 6) + ')',
      }))
    : []
  const points = data.map((item, index) => pad.left + slot * index + slot / 2 + ',' + y(Number(item.value))).join(' ')
  const line = block.variant === 'line'
    ? React.createElement(
        React.Fragment,
        null,
        React.createElement('polyline', { points, fill: 'none', stroke: 'var(--ph-chart-0)', strokeWidth: 2.5, strokeLinejoin: 'round', strokeLinecap: 'round' }),
        data.map((item, index) => React.createElement('circle', { key: index, cx: pad.left + slot * index + slot / 2, cy: y(Number(item.value)), r: 3.2, fill: 'var(--ph-chart-0)' })),
      )
    : null
  const labels = data.map((item, index) => React.createElement('text', {
    key: index,
    x: pad.left + slot * index + slot / 2,
    y: height - 16,
    textAnchor: 'middle',
    className: 'ph-n-doc__chart-label',
  }, String(item.label).slice(0, 8)))
  const valueLabels = data.map((item, index) => React.createElement('text', {
    key: index,
    x: pad.left + slot * index + slot / 2,
    y: Math.max(12, y(Number(item.value)) - 6),
    textAnchor: 'middle',
    className: 'ph-n-doc__chart-value',
  }, String(item.value)))
  return React.createElement(
    'div',
    { className: 'ph-n-doc__chart' },
    title,
    React.createElement(
      'svg',
      { viewBox: '0 0 640 240', role: 'img', 'aria-label': block.title || 'chart' },
      React.createElement('line', { x1: pad.left, y1: pad.top + plotH, x2: width - pad.right, y2: pad.top + plotH, stroke: 'var(--ph-line)', strokeWidth: 1 }),
      bars,
      line,
      labels,
      valueLabels,
    ),
  )
}

/** Image gallery with a local lightbox and real paper figures/cached web images. */
function GalleryBlock(props) {
  const items = props.block.items || []
  const [preview, setPreview] = React.useState(null)
  return React.createElement(
    React.Fragment,
    null,
    React.createElement(
      'div',
      { className: 'ph-n-doc__gallery' },
      props.block.title ? React.createElement('div', { className: 'ph-n-doc__gallery-title' }, props.block.title) : null,
      React.createElement(
        'div',
        { className: 'ph-n-doc__gallery-grid' },
        items.map((item, index) => {
          const src = item.kind === 'figure' ? (item.imageUrl || '/pappers-hall/figure/' + item.figureId + '.png') : item.src
          const caption = item.caption || item.alt || ''
          return React.createElement(
            'figure',
            { key: index, className: 'ph-n-doc__gallery-item' },
            React.createElement(
              'button',
              { type: 'button', className: 'ph-n-doc__gallery-media', title: props.t('notes.gallery.preview'), onClick: () => setPreview(item) },
              React.createElement('img', { src, alt: caption, loading: 'lazy', decoding: 'async' }),
            ),
            caption ? React.createElement('figcaption', null, caption) : null,
            item.kind === 'image' && (item.credit || item.sourceUrl)
              ? React.createElement(
                  'div',
                  { className: 'ph-n-doc__gallery-credit' },
                  item.credit ? React.createElement('span', null, item.credit + (item.license ? ' · ' + item.license : '')) : null,
                  item.sourceUrl ? React.createElement('a', { href: item.sourceUrl, target: '_blank', rel: 'noreferrer noopener' }, props.t('notes.block.source')) : null,
                )
              : null,
          )
        }),
      ),
    ),
    preview
      ? React.createElement(
          'div',
          { className: 'ph-n-doc__lightbox', role: 'dialog', 'aria-modal': 'true', onClick: () => setPreview(null) },
          React.createElement(
            'div',
            { className: 'ph-n-doc__lightbox-body', onClick: (event) => event.stopPropagation() },
            React.createElement('img', { src: preview.kind === 'figure' ? (preview.imageUrl || '/pappers-hall/figure/' + preview.figureId + '.png') : preview.src, alt: preview.caption || preview.alt || '' }),
            React.createElement(
              'div',
              { className: 'ph-n-doc__lightbox-meta' },
              React.createElement('span', null, preview.caption || preview.alt || ''),
              preview.credit ? React.createElement('span', null, preview.credit + (preview.license ? ' · ' + preview.license : '')) : null,
            ),
            React.createElement(
              'div',
              { className: 'ph-n-doc__lightbox-actions' },
              preview.kind === 'figure' && typeof props.onOpenFigure === 'function'
                ? React.createElement('button', { type: 'button', onClick: () => { props.onOpenFigure(preview.paperId, preview.page, preview.figureId); setPreview(null) } }, props.t('notes.figure.open'))
                : null,
              preview.sourceUrl ? React.createElement('a', { href: preview.sourceUrl, target: '_blank', rel: 'noreferrer noopener' }, props.t('notes.block.source')) : null,
              React.createElement('button', { type: 'button', onClick: () => setPreview(null) }, props.t('notes.gallery.close')),
            ),
          ),
        )
      : null,
  )
}

/** Tabs over nested block lists. */
function TabsBlock(props) {
  const tabs = props.block.tabs || []
  const bound = props.block.bind ? getDataPath(props.data || {}, props.block.bind) : undefined
  const [localActive, setLocalActive] = React.useState(0)
  const active = typeof bound === 'string' ? Math.max(0, tabs.findIndex((tab) => tab.id === bound)) : localActive
  const setActive = (index) => {
    if (props.block.bind && typeof props.onChangeData === 'function') props.onChangeData(props.block.bind, tabs[index] ? tabs[index].id : '')
    else setLocalActive(index)
  }
  const current = tabs[Math.min(active, tabs.length - 1)]
  return React.createElement(
    'div',
    { className: 'ph-n-doc__tabs' },
    React.createElement(
      'div',
      { className: 'ph-n-doc__tabs-bar', role: 'tablist' },
      tabs.map((tab, index) => React.createElement(
        'button',
        {
          key: tab.id || index,
          type: 'button',
          role: 'tab',
          'aria-selected': index === active,
          className: 'ph-n-doc__tab' + (index === active ? ' is-active' : ''),
          onClick: () => setActive(index),
        },
        tab.label,
      )),
    ),
    React.createElement('div', { className: 'ph-n-doc__tabpanel', role: 'tabpanel' }, current ? React.createElement(NestedBlocks, { blocks: current.blocks, t: props.t, onOpenFigure: props.onOpenFigure }) : null),
  )
}

/** Collapsible details. */
function DisclosureBlock(props) {
  const [open, setOpen] = React.useState(props.block.open === true)
  return React.createElement(
    'div',
    { className: 'ph-n-doc__disclosure' + (open ? ' is-open' : '') },
    React.createElement(
      'button',
      { type: 'button', className: 'ph-n-doc__disclosure-button', 'aria-expanded': open, onClick: () => setOpen((value) => !value) },
      React.createElement('span', { className: 'ph-n-doc__disclosure-caret' }, open ? '−' : '+'),
      React.createElement('span', null, props.block.title || 'Details'),
    ),
    open ? React.createElement('div', { className: 'ph-n-doc__disclosure-body' }, React.createElement(NestedBlocks, { blocks: props.block.blocks, t: props.t, onOpenFigure: props.onOpenFigure })) : null,
  )
}

/** Interactive reading/experiment checklist; persists to contentJson.data when bound. */
function TasksBlock(props) {
  const items = props.block.items || []
  const bound = props.block.bind ? getDataPath(props.data || {}, props.block.bind) : undefined
  const [local, setLocal] = React.useState(() => items.map((item) => item.done === true))
  const done = Array.isArray(bound) ? items.map((_, index) => bound[index] === true) : local
  const toggle = (index) => {
    const next = done.map((value, itemIndex) => (itemIndex === index ? !value : value))
    if (props.block.bind && typeof props.onChangeData === 'function') props.onChangeData(props.block.bind, next)
    else setLocal(next)
  }
  return React.createElement(
    'div',
    { className: 'ph-n-doc__tasks' },
    props.block.title ? React.createElement('div', { className: 'ph-n-doc__tasks-title' }, props.block.title) : null,
    items.map((item, index) => React.createElement(
      'label',
      { key: index, className: 'ph-n-doc__task' + (done[index] ? ' is-done' : '') },
      React.createElement('input', { type: 'checkbox', checked: Boolean(done[index]), onChange: () => toggle(index) }),
      React.createElement('span', null, item.text),
    )),
  )
}

/** Status badges. */
function StatusBlock(props) {
  return React.createElement(
    'div',
    { className: 'ph-n-doc__status' },
    (props.block.items || []).map((item, index) => React.createElement(
      'div',
      { key: index, className: 'ph-n-doc__status-item ph-n-doc__status-item--' + item.tone },
      item.label ? React.createElement('span', { className: 'ph-n-doc__status-label' }, item.label) : null,
      item.value ? React.createElement('strong', null, item.value) : null,
    )),
  )
}

/** Progress bars. */
function ProgressBlock(props) {
  return React.createElement(
    'div',
    { className: 'ph-n-doc__progress' },
    (props.block.items || []).map((item, index) => {
      const fraction = Math.max(0, Math.min(1, Number(item.value) / Math.max(1, Number(item.max) || 100)))
      return React.createElement(
        'div',
        { key: index, className: 'ph-n-doc__progress-item' },
        React.createElement(
          'div',
          { className: 'ph-n-doc__progress-head' },
          React.createElement('span', null, item.label),
          React.createElement('span', null, String(item.value) + ' / ' + String(item.max)),
        ),
        React.createElement('div', { className: 'ph-n-doc__progress-track' }, React.createElement('div', { className: 'ph-n-doc__progress-fill ph-n-doc__progress-fill--' + item.tone, style: { width: (fraction * 100).toFixed(1) + '%' } })),
      )
    }),
  )
}

function AlertBlock(props) {
  const tone = props.block.tone || 'info'
  return React.createElement(
    'div',
    { className: 'ph-n-doc__alert ph-n-doc__alert--' + tone },
    React.createElement(Icon, { name: tone === 'warn' || tone === 'danger' ? 'warning' : tone === 'success' ? 'checkCircle' : 'info', size: 14 }),
    React.createElement('div', null, props.block.title ? React.createElement('strong', null, props.block.title) : null, props.block.text ? React.createElement('div', null, props.block.text) : null),
  )
}

function EmptyBlock(props) {
  return React.createElement('div', { className: 'ph-n-doc__empty' }, React.createElement('strong', null, props.block.title || ''), React.createElement('span', null, props.block.text || ''))
}

function QuotesBlock(props) {
  return React.createElement(
    'div',
    { className: 'ph-n-doc__quotes' },
    (props.block.items || []).map((item, index) => React.createElement(
      'figure',
      { key: index, className: 'ph-n-doc__quote-card' },
      React.createElement('blockquote', null, item.text),
      (item.source || item.note) ? React.createElement('figcaption', null, item.source || '', item.note ? ' · ' + item.note : '') : null,
    )),
  )
}

/** Layered auto-layout for architecture/flow diagrams. */
function layoutLayered(nodes, edges) {
  const byId = new Map(nodes.map((node) => [node.id, node]))
  const incoming = new Map(nodes.map((node) => [node.id, 0]))
  const outgoing = new Map(nodes.map((node) => [node.id, []]))
  for (const edge of edges) {
    if (!byId.has(edge.from) || !byId.has(edge.to)) continue
    incoming.set(edge.to, (incoming.get(edge.to) || 0) + 1)
    outgoing.get(edge.from).push(edge.to)
  }
  const levels = new Map()
  const queue = nodes.filter((node) => (incoming.get(node.id) || 0) === 0).map((node) => node.id)
  if (queue.length === 0) queue.push(nodes[0].id)
  for (const id of queue) levels.set(id, 0)
  let cursor = 0
  while (cursor < queue.length) {
    const id = queue[cursor]
    cursor += 1
    const level = levels.get(id) || 0
    for (const next of outgoing.get(id) || []) {
      if (levels.has(next)) continue
      levels.set(next, level + 1)
      queue.push(next)
    }
  }
  for (const node of nodes) if (!levels.has(node.id)) levels.set(node.id, 0)
  const rows = []
  for (const node of nodes) {
    const level = levels.get(node.id) || 0
    if (!rows[level]) rows[level] = []
    rows[level].push(node)
  }
  return { rows, byId }
}

/** Architecture / flow / mind-map diagram. */
function DiagramBlock(props) {
  const block = props.block
  const nodes = block.nodes || []
  const edges = block.edges || []
  const dialogRef = React.useRef(null)
  if (nodes.length < 2) return null
  const openDialog = () => {
    const dialog = dialogRef.current
    if (dialog && typeof dialog.showModal === 'function') dialog.showModal()
  }
  const closeDialog = () => { const dialog = dialogRef.current; if (dialog && typeof dialog.close === 'function') dialog.close() }
  const title = React.createElement(
    'div',
    { className: 'ph-n-doc__diagram-title' },
    block.title || props.t('notes.diagram.label'),
    React.createElement('button', {
      type: 'button',
      className: 'ph-n-doc__diagram-expand',
      onClick: openDialog,
    }, props.t('notes.diagram.expand')),
  )
  const makeDialog = (svgNode, caption) => React.createElement(
    'dialog',
    {
      ref: dialogRef,
      className: 'ph-n-doc__diagram-dialog',
      onClick: (event) => { if (event.target === event.currentTarget) closeDialog() },
    },
    React.createElement(
      'div',
      { className: 'ph-n-doc__diagram-dialog-body' },
      React.createElement(
        'div',
        { className: 'ph-n-doc__diagram-dialog-head' },
        React.createElement('span', null, block.title || props.t('notes.diagram.label')),
        React.createElement('button', { type: 'button', className: 'ph-n-doc__diagram-expand', onClick: closeDialog }, props.t('notes.diagram.collapse')),
      ),
      React.createElement('div', { className: 'ph-n-doc__diagram-dialog-canvas' }, svgNode),
      caption ? React.createElement('div', { className: 'ph-n-doc__diagram-caption' }, caption) : null,
    ),
  )
  if (block.layout === 'mindmap') {
    const byId = new Map(nodes.map((node) => [node.id, node]))
    const incoming = new Map(nodes.map((node) => [node.id, 0]))
    const outgoing = new Map(nodes.map((node) => [node.id, []]))
    for (const edge of edges) {
      if (!byId.has(edge.from) || !byId.has(edge.to)) continue
      incoming.set(edge.to, (incoming.get(edge.to) || 0) + 1)
      outgoing.get(edge.from).push(edge.to)
    }
    const root = nodes.find((node) => (incoming.get(node.id) || 0) === 0) || nodes[0]
    const branches = (outgoing.get(root.id) || []).filter((id) => byId.has(id)).slice(0, 8)
    const right = branches.filter((_, index) => index % 2 === 0)
    const left = branches.filter((_, index) => index % 2 === 1)
    const width = 840
    const height = Math.max(300, Math.max(right.length, left.length, 1) * 82 + 70)
    const rootPoint = { x: 420, y: height / 2 }
    const positions = new Map([[root.id, rootPoint]])
    const placeColumn = (ids, x, gap) => {
      const total = (ids.length - 1) * gap
      ids.forEach((id, index) => positions.set(id, { x, y: height / 2 - total / 2 + index * gap }))
    }
    placeColumn(right, 600, 82)
    placeColumn(left, 240, 82)
    const sideOf = new Map()
    right.forEach((id) => sideOf.set(id, 'right'))
    left.forEach((id) => sideOf.set(id, 'left'))
    for (const id of branches) {
      const side = sideOf.get(id)
      const parentPoint = positions.get(id)
      if (!parentPoint) continue
      const children = (outgoing.get(id) || []).filter((child) => child !== root.id && byId.has(child) && !branches.includes(child)).slice(0, 4)
      children.forEach((child, index) => {
        const offset = (index - (children.length - 1) / 2) * 64
        positions.set(child, { x: side === 'left' ? 80 : 760, y: parentPoint.y + 58 + offset })
      })
    }
    for (const node of nodes) if (!positions.has(node.id)) positions.set(node.id, { x: 420, y: height / 2 + positions.size * 20 })
    const lines = edges.map((edge, index) => {
      const from = positions.get(edge.from); const to = positions.get(edge.to)
      if (!from || !to) return null
      const midX = (from.x + to.x) / 2
      return React.createElement('path', {
        key: 'e' + index,
        d: 'M ' + from.x + ' ' + from.y + ' C ' + midX + ' ' + from.y + ', ' + midX + ' ' + to.y + ', ' + to.x + ' ' + to.y,
        fill: 'none', stroke: 'var(--ph-line-strong)', strokeWidth: 1.4,
      })
    })
    const boxes = nodes.map((node) => {
      const point = positions.get(node.id)
      const isRoot = node.id === root.id
      const label = String(node.label)
      return React.createElement(
        'g',
        { key: node.id, transform: 'translate(' + (point.x - 74) + ',' + (point.y - 24) + ')' },
        React.createElement('rect', { width: 148, height: 48, rx: 12, className: 'ph-n-doc__diagram-box' + (isRoot ? ' is-root' : '') + (node.tone ? ' is-' + node.tone : '') }),
        React.createElement('text', { x: 74, y: 21, textAnchor: 'middle', className: 'ph-n-doc__diagram-label' }, label.length > 20 ? label.slice(0, 19) + '…' : label),
        React.createElement('text', { x: 74, y: 35, textAnchor: 'middle', className: 'ph-n-doc__diagram-detail' }, (node.detail || '').slice(0, 24)),
      )
    })
    const cardSvg = React.createElement('svg', { viewBox: '0 0 840 ' + height, role: 'img', 'aria-label': block.title || 'mind map' }, lines, boxes)
    const dialogSvg = React.createElement('svg', { viewBox: '0 0 840 ' + height, role: 'img', 'aria-label': block.title || 'mind map', style: { width: '840px', minWidth: '840px', height: 'auto', maxWidth: 'none' } }, lines, boxes)
    return React.createElement(
      React.Fragment,
      null,
      React.createElement(
        'div',
        { className: 'ph-n-doc__diagram' },
        title,
        React.createElement('div', { className: 'ph-n-doc__diagram-canvas' }, cardSvg),
      ),
      makeDialog(dialogSvg),
    )
  }
  const { rows } = layoutLayered(nodes, edges)
  // Architecture/flow reads left-to-right: levels become columns, siblings stack
  // vertically inside a column. This keeps a chain like A->B->C compact instead
  // of turning it into a very tall single-file strip.
  const columns = rows
  const width = Math.max(760, columns.length * 150)
  const maxRows = Math.max(1, ...columns.map((column) => column.length))
  const height = Math.max(210, maxRows * 78 + 52)
  const positions = new Map()
  columns.forEach((column, columnIndex) => {
    const x = 70 + columnIndex * ((width - 140) / Math.max(1, columns.length - 1))
    column.forEach((node, rowIndex) => {
      const y = 44 + ((height - 88) / (column.length + 1)) * (rowIndex + 1)
      positions.set(node.id, { x, y })
    })
  })
  const lines = edges.map((edge, index) => {
    const from = positions.get(edge.from); const to = positions.get(edge.to)
    if (!from || !to) return null
    const sameColumn = Math.abs(from.x - to.x) < 1
    const startX = sameColumn ? from.x : from.x + 70
    const startY = sameColumn ? from.y + 24 : from.y
    const endX = sameColumn ? to.x : to.x - 70
    const endY = sameColumn ? to.y - 24 : to.y
    const midX = sameColumn ? from.x : (startX + endX) / 2
    return React.createElement(
      'g',
      { key: 'e' + index },
      React.createElement('path', { d: 'M ' + startX + ' ' + startY + ' C ' + midX + ' ' + startY + ', ' + midX + ' ' + endY + ', ' + endX + ' ' + endY, fill: 'none', stroke: 'var(--ph-line-strong)', strokeWidth: 1.3, markerEnd: 'url(#ph-diagram-arrow)' }),
      edge.label ? React.createElement('text', { x: midX, y: (startY + endY) / 2 - 4, textAnchor: 'middle', className: 'ph-n-doc__diagram-edge-label' }, edge.label.slice(0, 18)) : null,
    )
  })
  const boxes = nodes.map((node) => {
    const point = positions.get(node.id)
    if (!point) return null
    const label = String(node.label)
    return React.createElement(
      'g',
      { key: node.id, transform: 'translate(' + (point.x - 70) + ',' + (point.y - 24) + ')' },
      React.createElement('rect', { width: 140, height: 48, rx: 10, className: 'ph-n-doc__diagram-box' + (node.tone ? ' is-' + node.tone : '') }),
      React.createElement('text', { x: 70, y: 20, textAnchor: 'middle', className: 'ph-n-doc__diagram-label' }, label.length > 18 ? label.slice(0, 17) + '…' : label),
      React.createElement('text', { x: 70, y: 36, textAnchor: 'middle', className: 'ph-n-doc__diagram-detail' }, (node.detail || '').slice(0, 22)),
    )
  })
  const defs = React.createElement('defs', null, React.createElement('marker', { id: 'ph-diagram-arrow', markerWidth: 8, markerHeight: 8, refX: 7, refY: 4, orient: 'auto' }, React.createElement('path', { d: 'M0,0 L8,4 L0,8 Z', fill: 'var(--ph-line-strong)' })))
  const cardSvg = React.createElement('svg', { viewBox: '0 0 ' + width + ' ' + height, role: 'img', 'aria-label': block.title || 'diagram' }, defs, lines, boxes)
  const dialogSvg = React.createElement('svg', { viewBox: '0 0 ' + width + ' ' + height, role: 'img', 'aria-label': block.title || 'diagram', style: { width: Math.min(width, 2600) + 'px', minWidth: Math.min(width, 2600) + 'px', height: 'auto', maxWidth: 'none' } }, defs, lines, boxes)
  return React.createElement(
    React.Fragment,
    null,
    React.createElement(
      'div',
      { className: 'ph-n-doc__diagram' },
      title,
      React.createElement('div', { className: 'ph-n-doc__diagram-canvas' }, cardSvg),
      block.caption ? React.createElement('div', { className: 'ph-n-doc__diagram-caption' }, block.caption) : null,
    ),
    makeDialog(dialogSvg, block.caption),
  )
}

/** One content block. */
function Block(props) {
  const t = props.t
  const block = props.block
  if (!block || !block.type) return null
  if (block.type === 'heading') return React.createElement('h4', { className: 'ph-n-doc__h' }, block.text)
  if (block.type === 'paragraph') return React.createElement('p', { className: 'ph-n-doc__p' }, block.text)
  if (block.type === 'quote') return React.createElement('blockquote', { className: 'ph-n-doc__quote' }, block.text)
  if (block.type === 'stats') {
    return React.createElement(
      'div',
      { className: 'ph-n-doc__stats' },
      (block.items || []).map((item, index) => React.createElement(
        'div',
        { key: index, className: 'ph-n-doc__stat' + (item.tone ? ' ph-n-doc__stat--tone-' + item.tone : '') },
        React.createElement('div', { className: 'ph-n-doc__stat-value' }, item.value),
        React.createElement('div', { className: 'ph-n-doc__stat-label' }, item.label),
        item.note ? React.createElement('div', { className: 'ph-n-doc__stat-note' }, item.note) : null,
      )),
    )
  }
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
            Array.from({ length: width }, (_, index) => React.createElement('th', { key: index, style: block.align ? { textAlign: block.align } : undefined }, block.headers[index] || '')),
          ),
        )
      : null
    return React.createElement(
      'div',
      { className: 'ph-n-doc__tablewrap' },
      React.createElement(
        'table',
        { className: 'ph-n-doc__table' },
        block.caption ? React.createElement('caption', { className: 'ph-n-doc__table-caption' }, block.caption) : null,
        head,
        React.createElement(
          'tbody',
          null,
          block.rows.map((row, rowIndex) =>
            React.createElement(
              'tr',
              { key: rowIndex },
              Array.from({ length: width }, (_, cellIndex) => React.createElement('td', { key: cellIndex, style: block.align ? { textAlign: block.align } : undefined }, row[cellIndex] || '')),
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
  if (block.type === 'web-image') {
    return React.createElement(
      'figure',
      { className: 'ph-n-doc__webimage' },
      React.createElement('img', { src: block.src, alt: block.alt || block.caption || '', loading: 'lazy', decoding: 'async' }),
      (block.caption || block.credit || block.sourceUrl)
        ? React.createElement(
            'figcaption',
            { className: 'ph-n-doc__webimage-cap' },
            block.caption ? React.createElement('span', null, block.caption) : null,
            block.credit ? React.createElement('span', { className: 'ph-n-doc__webimage-credit' }, block.credit + (block.license ? ' · ' + block.license : '')) : null,
            block.sourceUrl ? React.createElement('a', { href: block.sourceUrl, target: '_blank', rel: 'noreferrer noopener' }, t('notes.block.source')) : null,
          )
        : null,
    )
  }
  if (block.type === 'sources') {
    return React.createElement(
      'div',
      { className: 'ph-n-doc__sources' },
      React.createElement('div', { className: 'ph-n-doc__sources-title' }, t('notes.block.sources')),
      (block.items || []).map((item, index) => React.createElement(
        'a',
        { key: index, href: item.url, target: '_blank', rel: 'noreferrer noopener', className: 'ph-n-doc__source' },
        React.createElement(Icon, { name: 'link', size: 12 }),
        React.createElement('span', null, item.title || item.url),
        item.note ? React.createElement('span', { className: 'ph-n-doc__source-note' }, item.note) : null,
      )),
    )
  }
  if (block.type === 'timeline') {
    return React.createElement(
      'ol',
      { className: 'ph-n-doc__timeline' + (block.orientation === 'horizontal' ? ' ph-n-doc__timeline--horizontal' : '') },
      (block.items || []).map((item, index) => React.createElement(
        'li',
        { key: index, className: 'ph-n-doc__timeline-item' },
        item.when ? React.createElement('span', { className: 'ph-n-doc__timeline-when' }, item.when) : null,
        React.createElement('span', { className: 'ph-n-doc__timeline-body' },
          item.title ? React.createElement('strong', null, item.title) : null,
          item.text ? React.createElement('span', null, item.text) : null,
        ),
      )),
    )
  }
  if (block.type === 'compare') {
    return React.createElement(
      'div',
      { className: 'ph-n-doc__compare' },
      [['left', block.leftTitle], ['right', block.rightTitle]].map(([side, title]) => React.createElement(
        'div',
        { key: side, className: 'ph-n-doc__compare-col' },
        title ? React.createElement('div', { className: 'ph-n-doc__compare-title' }, title) : null,
        React.createElement('ul', null, (block[side] || []).map((item, index) => React.createElement('li', { key: index }, item))),
      )),
    )
  }
  if (block.type === 'steps') {
    return React.createElement(
      'ol',
      { className: 'ph-n-doc__steps' },
      (block.items || []).map((item, index) => React.createElement('li', { key: index }, item)),
    )
  }
  if (block.type === 'markdown') return React.createElement(MarkdownBlock, { block })
  if (block.type === 'form') return React.createElement(FormBlock, { block, data: props.data, onChangeData: props.onChangeData })
  if (block.type === 'computed') return React.createElement(ComputedBlock, { block, data: props.data })
  if (block.type === 'avatar') return React.createElement(AvatarBlock, { block })
  if (block.type === 'calendar') return React.createElement(CalendarBlock, { block })
  if (block.type === 'grid') return React.createElement(GridBlock, { block, t, data: props.data, onChangeData: props.onChangeData, onAction: props.onAction, onOpenFigure: props.onOpenFigure })
  if (block.type === 'data-table') return React.createElement(DataTableBlock, { block, data: props.data })
  if (block.type === 'comparison-table') return React.createElement(ComparisonTableBlock, { block })
  if (block.type === 'media') return React.createElement(MediaBlock, { block })
  if (block.type === 'cards') return React.createElement(CardsBlock, { block })
  if (block.type === 'chart') return React.createElement(ChartBlock, { block })
  if (block.type === 'gallery') return React.createElement(GalleryBlock, { block, t, onOpenFigure: props.onOpenFigure })
  if (block.type === 'tabs') return React.createElement(TabsBlock, { block, t, onOpenFigure: props.onOpenFigure, data: props.data, onChangeData: props.onChangeData })
  if (block.type === 'disclosure') return React.createElement(DisclosureBlock, { block, t, onOpenFigure: props.onOpenFigure })
  if (block.type === 'tasks') return React.createElement(TasksBlock, { block, data: props.data, onChangeData: props.onChangeData })
  if (block.type === 'status') return React.createElement(StatusBlock, { block })
  if (block.type === 'progress') return React.createElement(ProgressBlock, { block })
  if (block.type === 'alert') return React.createElement(AlertBlock, { block })
  if (block.type === 'empty') return React.createElement(EmptyBlock, { block })
  if (block.type === 'quotes') return React.createElement(QuotesBlock, { block })
  if (block.type === 'actions') {
    return React.createElement(
      'div',
      { className: 'ph-n-doc__actions' },
      (block.items || []).map((item, index) => React.createElement(
        'button',
        {
          key: index,
          type: 'button',
          className: 'ph-n-doc__action',
          onClick: () => {
            if (typeof props.onAction === 'function') props.onAction(item)
          },
        },
        item.label,
        item.note ? React.createElement('span', null, item.note) : null,
      )),
    )
  }
  if (block.type === 'diagram') return React.createElement(DiagramBlock, { block, t })
  if (block.type === 'divider') return React.createElement('hr', { className: 'ph-n-doc__divider' })
  if (block.type === 'figure') return React.createElement(FigureBlock, { t: props.t, block: block, onOpenFigure: props.onOpenFigure })
  if (block.type === 'columns') return React.createElement(ColumnsBlock, { t: props.t, block: block, onOpenFigure: props.onOpenFigure })
  return null
}

/** Wide blocks must not be split/flowed by the two-column section layout. */
function isWideBlock(block) {
  return Boolean(block && ['table', 'figure', 'columns', 'web-image', 'timeline', 'compare', 'sources', 'chart', 'gallery', 'tabs', 'diagram', 'cards', 'quotes', 'form', 'grid', 'data-table', 'comparison-table', 'media'].includes(block.type))
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
 * @param {object} [props.data] contentJson.data for bound form fields
 * @param {Function} [props.onChangeData] `(path, value)` persist a bound field
 * @param {Function} [props.onAction] `(action)` run an actions block callback
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
                React.createElement(Block, { t: t, block: block, onOpenFigure: props.onOpenFigure, data: props.data, onChangeData: props.onChangeData, onAction: props.onAction }),
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
