/**
 * Global dialogs: command palette (⌘K), quick citation (⌘⇧C) and shortcut help (?).
 * All dialogs are bounded to the viewport, close on Escape/backdrop and trap
 * keyboard selection without touching global state outside their lifetime.
 */
import React from 'react'
import { h } from '../../core/dom.js'
import { Icon } from '../../core/icons.jsx'
import { Button, IconButton, SearchInput } from '../../core/primitives.jsx'
import { describeError } from '../../core/api.js'
import { copyText } from '../../core/files.js'

function useDebounced(value, delay) {
  const [debounced, setDebounced] = React.useState(value)
  React.useEffect(() => {
    const timer = setTimeout(() => setDebounced(value), delay == null ? 240 : delay)
    return () => clearTimeout(timer)
  }, [value, delay])
  return debounced
}

function Dialog(props) {
  const ref = React.useRef(null)
  React.useEffect(() => {
    const onKey = (event) => {
      if (event.key === 'Escape') {
        event.preventDefault()
        props.onClose()
      }
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [props.onClose])
  return h(
    'div',
    { className: 'ph-modalbackdrop', onMouseDown: (event) => { if (event.target === event.currentTarget) props.onClose() } },
    h('div', { className: 'ph-dialog ' + (props.className || ''), ref: ref, role: 'dialog', 'aria-modal': 'true', 'aria-label': props.label || props.title },
      h('div', { className: 'ph-dialog__head' }, h(Icon, { name: props.icon || 'terminal', size: 15 }), h('span', { className: 'ph-dialog__title' }, props.title), h(IconButton, { icon: 'close', title: '关闭', onClick: props.onClose })),
      props.children,
    ),
  )
}

/** ⌘K command palette. `commands`: [{id,label,hint,icon,run}] */
export function CommandPalette(props) {
  const t = props.t
  const [query, setQuery] = React.useState('')
  const [index, setIndex] = React.useState(0)
  const inputRef = React.useRef(null)
  const commands = (props.commands || []).filter((command) => !query || String(command.label + ' ' + (command.hint || '')).toLowerCase().indexOf(query.toLowerCase()) >= 0)
  React.useEffect(() => {
    if (props.open) {
      setQuery('')
      setIndex(0)
      setTimeout(() => inputRef.current && inputRef.current.focus(), 30)
    }
  }, [props.open])
  React.useEffect(() => { setIndex(0) }, [query])
  if (!props.open) return null
  const run = (command) => {
    props.onClose()
    setTimeout(() => command.run(), 20)
  }
  return h(
    Dialog,
    { title: t('palette.title'), icon: 'search', onClose: props.onClose, className: 'ph-dialog--palette', label: t('palette.title') },
    h('div', { className: 'ph-dialog__search' }, h(SearchInput, { value: query, onChange: setQuery, placeholder: t('palette.placeholder'), 'aria-label': t('palette.placeholder'), clearLabel: t('common.clear'), ref: inputRef })),
    h(
      'div',
      {
        className: 'ph-commandlist',
        onKeyDown: (event) => {
          if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
            event.preventDefault()
            const delta = event.key === 'ArrowDown' ? 1 : -1
            setIndex((previous) => (commands.length === 0 ? 0 : (previous + delta + commands.length) % commands.length))
          } else if (event.key === 'Enter') {
            event.preventDefault()
            if (commands[index]) run(commands[index])
          }
        },
        tabIndex: 0,
      },
      commands.length === 0 ? h('div', { className: 'ph-dialog__empty' }, t('palette.empty')) : null,
      commands.map((command, position) =>
        h(
          'button',
          {
            key: command.id,
            type: 'button',
            className: 'ph-command' + (position === index ? ' ph-command--active' : ''),
            onMouseEnter: () => setIndex(position),
            onClick: () => run(command),
          },
          h(Icon, { name: command.icon || 'terminal', size: 14 }),
          h('span', { className: 'ph-command__label' }, command.label),
          command.hint ? h('span', { className: 'ph-command__hint' }, command.hint) : null,
        ),
      ),
    ),
    h('div', { className: 'ph-dialog__foot' }, t('palette.hint')),
  )
}

/** ⌘⇧C quick citation dialog: search a paper, pick a style, insert the token. */
export function CitationDialog(props) {
  const t = props.t
  const api = props.api
  const [query, setQuery] = React.useState('')
  const debounced = useDebounced(query, 260)
  const [results, setResults] = React.useState([])
  const [picked, setPicked] = React.useState(null)
  const [style, setStyle] = React.useState('bibtex')
  const [preview, setPreview] = React.useState('')
  const [busy, setBusy] = React.useState(false)
  const [error, setError] = React.useState('')
  const [tick, setTick] = React.useState(0)
  const dialogRef = React.useRef(null)

  React.useEffect(() => {
    if (!props.open) return
    setQuery('')
    setPicked(null)
    setPreview('')
    setError('')
    setTimeout(() => dialogRef.current && dialogRef.current.focus(), 30)
  }, [props.open])

  React.useEffect(() => {
    if (!props.open) return undefined
    let alive = true
    api('library.list', { query: debounced.trim() || undefined, state: 'active', sort: 'recent', limit: 8 })
      .then((value) => { if (alive) setResults(Array.isArray(value && value.items) ? value.items : []) })
      .catch(() => { if (alive) setResults([]) })
    return () => { alive = false }
  }, [api, debounced, props.open, tick])

  React.useEffect(() => {
    if (!picked) { setPreview(''); return undefined }
    let alive = true
    setBusy(true)
    api('citation.format', { ids: [picked.id], style: style })
      .then((value) => { if (alive) setPreview(String(value && value.content ? value.content : '')) })
      .catch((err) => { if (alive) setError(describeError(t, err)) })
      .then(() => { if (alive) setBusy(false) })
    return () => { alive = false }
  }, [api, picked, style, tick])

  if (!props.open) return null
  const styles = [['bibtex', 'BibTeX'], ['apa', 'APA'], ['gbt7714', 'GB/T 7714'], ['ris', 'RIS'], ['csljson', 'CSL-JSON']]
  return h(
    Dialog,
    { title: t('citation.title'), icon: 'quote', onClose: props.onClose, className: 'ph-dialog--citation', label: t('citation.title') },
    h('div', { className: 'ph-dialog__search' }, h(SearchInput, { value: query, onChange: setQuery, placeholder: t('citation.placeholder'), 'aria-label': t('citation.placeholder'), clearLabel: t('common.clear') })),
    h(
      'div',
      { className: 'ph-citation', tabIndex: -1, ref: dialogRef },
      h(
        'div',
        { className: 'ph-citation__results ph-scroll' },
        results.length === 0 ? h('div', { className: 'ph-dialog__empty' }, t('citation.empty')) : null,
        results.map((paper) =>
          h(
            'button',
            { key: paper.id, type: 'button', className: 'ph-citation__row' + (picked && picked.id === paper.id ? ' ph-citation__row--active' : ''), onClick: () => setPicked(paper) },
            h(Icon, { name: 'book', size: 14 }),
            h('span', { className: 'ph-citation__name' }, paper.titleZh || paper.displayTitle || paper.title || paper.id),
            h('span', { className: 'ph-caption' }, paper.year || ''),
          ),
        ),
      ),
      h(
        'div',
        { className: 'ph-citation__side' },
        h('div', { className: 'ph-citation__label' }, t('citation.style')),
        h(
          'select',
          { className: 'ph-select', value: style, onChange: (event) => setStyle(event.target.value) },
          styles.map(([value, label]) => h('option', { key: value, value: value }, label)),
        ),
        h('pre', { className: 'ph-citation__preview' }, busy ? t('common.loading') : preview || t('citation.previewEmpty')),
        error ? h('div', { className: 'ph-caption ph-caption--error' }, error) : null,
        h(
          'div',
          { className: 'ph-dialog__actions' },
          h(Button, { size: 'sm', icon: 'copy', disabled: !preview, onClick: () => copyText(preview).then((ok) => props.onToast(ok ? 'success' : 'warning', ok ? t('common.copied') : t('common.unavailable'))) }, t('citation.copy')),
          h(Button, { size: 'sm', variant: 'primary', icon: 'quote', disabled: !picked, onClick: () => props.onInsert(picked) }, t('citation.insert')),
        ),
      ),
    ),
  )
}

/** `?` shortcut help. */
export function HelpDialog(props) {
  const t = props.t
  if (!props.open) return null
  const rows = [
    ['⌘K', t('help.palette')],
    ['⌘⇧C', t('help.citation')],
    ['⌘Z', t('help.undo')],
    ['↑ ↓ / Home End', t('help.navigate')],
    ['Enter', t('help.open')],
    ['Space', t('help.select')],
    ['⌘ / Ctrl + A', t('help.selectAll')],
    ['?', t('help.help')],
    ['Esc', t('help.close')],
  ]
  return h(
    Dialog,
    { title: t('help.title'), icon: 'info', onClose: props.onClose, className: 'ph-dialog--help', label: t('help.title') },
    h('div', { className: 'ph-help' }, rows.map(([key, label]) => h('div', { key: key, className: 'ph-help__row' }, h('kbd', { className: 'ph-kbd' }, key), h('span', null, label)))),
    h('div', { className: 'ph-dialog__foot' }, t('help.hint')),
  )
}
