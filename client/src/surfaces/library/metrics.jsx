/** Journal metrics section: strict source labelling, manual edit, refresh with honest failure. */
import React from 'react'
import { h } from '../../core/dom.js'
import { Icon } from '../../core/icons.jsx'
import { Badge, Button, IconButton } from '../../core/primitives.jsx'
import { describeError } from '../../core/api.js'

function num(value) {
  if (value === null || value === undefined || value === '') return null
  const n = Number(value)
  return Number.isFinite(n) ? n : null
}

/** Integer with thousands separators. */
function intText(value) {
  const n = num(value)
  return n == null ? '' : new Intl.NumberFormat('zh-CN', { maximumFractionDigits: 0 }).format(Math.round(n))
}

/** Two decimals (impact factor / citedness). */
function decimalText(value) {
  const n = num(value)
  return n == null ? '' : new Intl.NumberFormat('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(n)
}

/** "刚刚 / 3 分钟前 / 2 小时前 / 4 天前 / yyyy-mm-dd". */
function relativeTime(value) {
  if (!value) return ''
  const time = typeof value === 'number' ? value : Date.parse(String(value))
  if (!Number.isFinite(time)) return String(value).slice(0, 16)
  const delta = Date.now() - time
  if (delta < 60 * 1000) return 'just-now'
  if (delta < 60 * 60 * 1000) return 'minutes'
  if (delta < 24 * 60 * 60 * 1000) return 'hours'
  if (delta < 30 * 24 * 60 * 60 * 1000) return 'days'
  return 'date'
}

function relativeText(t, value) {
  const kind = relativeTime(value)
  if (kind === '') return ''
  if (kind === 'just-now') return t('metrics.justNow')
  const time = Date.parse(String(value))
  const delta = Date.now() - time
  if (kind === 'minutes') return t('metrics.minutesAgo', { count: Math.max(1, Math.round(delta / 60000)) })
  if (kind === 'hours') return t('metrics.hoursAgo', { count: Math.round(delta / 3600000) })
  if (kind === 'days') return t('metrics.daysAgo', { count: Math.round(delta / 86400000) })
  return String(value).slice(0, 16).replace('T', ' ')
}

function sourceLabel(t, source) {
  if (!source) return ''
  if (source === 'manual') return t('metrics.source.manual')
  if (source === 'openalex') return t('metrics.source.openalex')
  if (source === 'crossref') return t('metrics.source.crossref')
  if (source.indexOf('openalex') >= 0 && source.indexOf('crossref') >= 0) return t('metrics.source.openalexCrossref')
  return source
}

export function MetricsSection(props) {
  const t = props.t
  const detail = props.detail
  const metrics = (detail && detail.metrics) || {}
  const [editing, setEditing] = React.useState(false)
  const [busy, setBusy] = React.useState(false)
  const [failed, setFailed] = React.useState('')
  const [form, setForm] = React.useState({})
  const [saving, setSaving] = React.useState(false)
  const [armed, setArmed] = React.useState(false)

  React.useEffect(() => {
    setEditing(false)
    setFailed('')
  }, [detail && detail.id])

  const refresh = () => {
    if (busy || !detail) return
    setBusy(true)
    setFailed('')
    props.onRefresh([detail.id]).catch((error) => setFailed(describeError(t, error))).then(() => setBusy(false))
  }
  const openEdit = () => {
    setForm({
      impactFactor: metrics.impactFactor != null ? String(metrics.impactFactor) : '',
      impactFactorYear: metrics.impactFactorYear != null ? String(metrics.impactFactorYear) : '',
      fiveYearImpactFactor: metrics.fiveYearImpactFactor != null ? String(metrics.fiveYearImpactFactor) : '',
      quartile: metrics.quartile || '',
      citationCount: metrics.citationCount != null ? String(metrics.citationCount) : '',
      issn: metrics.issn || '',
      publisher: metrics.publisher || '',
    })
    setEditing(true)
  }
  const save = () => {
    const fields = {}
    ;['impactFactor', 'fiveYearImpactFactor', 'citationCount'].forEach((key) => {
      const value = num(form[key])
      if (value != null) fields[key] = value
    })
    ;['impactFactorYear'].forEach((key) => {
      const value = num(form[key])
      if (value != null) fields[key] = value
    })
    ;['quartile', 'issn', 'publisher'].forEach((key) => {
      if (form[key] && String(form[key]).trim()) fields[key] = String(form[key]).trim()
    })
    if (Object.keys(fields).length === 0) {
      setEditing(false)
      return
    }
    setSaving(true)
    props.onSave(detail.id, fields)
      .then(() => props.onToast('success', t('metrics.saved')))
      .catch((error) => props.onToast('error', t('metrics.saveFailed', { message: describeError(t, error) })))
      .then(() => { setSaving(false); setEditing(false) })
  }

  const ifValue = num(metrics.impactFactor)
  const meanValue = num(metrics.twoYearMeanCitedness != null ? metrics.twoYearMeanCitedness : metrics.meanCitedness)
  const citations = num(metrics.citationCount)
  const hIndex = num(metrics.hIndex)
  const quartile = metrics.quartile || ''
  const updated = metrics.updatedAt || (detail && detail.metricsUpdatedAt) || ''
  const missingText = t('metrics.unavailableShort')
  const ifText = ifValue != null ? decimalText(ifValue) + (metrics.impactFactorYear ? ' · ' + metrics.impactFactorYear : '') : missingText
  const rows = [
    ['metrics.impactFactor', ifText, ifValue != null ? 'jcr' : ''],
    ['metrics.meanCitedness', meanValue != null ? decimalText(meanValue) : missingText, meanValue != null ? 'openalex' : ''],
    ['metrics.citationCount', citations != null ? intText(citations) : missingText, ''],
    ['metrics.hIndex', hIndex != null ? intText(hIndex) : missingText, ''],
    ['metrics.quartile', quartile || missingText, quartile ? 'jcr' : ''],
  ]
  const hasMissing = rows.some((row) => row[1] === missingText)

  return h(
    'div',
    { className: 'ph-detailblock ph-metrics' },
    h(
      'div',
      { className: 'ph-detailblock__head' },
      h(Icon, { name: 'chart', size: 13 }),
      h('span', null, t('metrics.title')),
      h('span', { className: 'ph-spacer' }),
      metrics.stale ? h(Badge, { tone: 'warning' }, t('metrics.stale')) : null,
      h(Button, { size: 'sm', variant: 'ghost', icon: 'refresh', disabled: busy || saving, onClick: refresh }, busy ? t('metrics.refreshing') : t('metrics.refresh')),
      h(IconButton, { icon: 'edit', title: t('metrics.manualEdit'), onClick: openEdit }),
      h(
        'button',
        {
          type: 'button',
          className: 'ph-linkbtn ph-metrics__reset' + (armed ? ' ph-linkbtn--danger' : ''),
          title: t('metrics.resetHint'),
          onClick: () => {
            if (!armed) { setArmed(true); return }
            setArmed(false)
            setBusy(true)
            props.onReset(detail.id)
              .then(() => props.onToast('success', t('metrics.resetDone')))
              .catch((error) => props.onToast('error', t('metrics.resetFailed', { message: describeError(t, error) })))
              .then(() => setBusy(false))
          },
        },
        armed ? t('metrics.resetConfirm') : t('metrics.reset'),
      ),
    ),
    h(
      'dl',
      { className: 'ph-metricgrid' },
      rows.map(([key, value, kind]) =>
        h(
          'div',
          { key: key, className: 'ph-metricrow' + (value === t('metrics.unavailable') ? ' ph-metricrow--empty' : '') },
          h('dt', null, t(key), kind === 'openalex' ? h('span', { className: 'ph-metricrow__hint' }, t('metrics.meanHint')) : null),
          h('dd', null, value),
        ),
      ),
    ),
    h('div', { className: 'ph-caption', title: updated ? String(updated) : '' }, t('metrics.source') + ': ' + (sourceLabel(t, metrics.source) || t('metrics.source.none')) + (updated ? ' · ' + t('metrics.updatedRelative', { time: relativeText(t, updated) }) : '')),
    hasMissing ? h('div', { className: 'ph-caption ph-caption--hint' }, t('metrics.missingHint')) : null,
    failed ? h('div', { className: 'ph-caption ph-caption--error', role: 'status' }, failed) : null,
    editing
      ? h(
          'div',
          { className: 'ph-metricform' },
          [
            ['impactFactor', 'metrics.impactFactor'],
            ['impactFactorYear', 'metrics.impactFactorYear'],
            ['fiveYearImpactFactor', 'metrics.fiveYearImpactFactor'],
            ['quartile', 'metrics.quartile'],
            ['citationCount', 'metrics.citationCount'],
            ['issn', 'metrics.issn'],
            ['publisher', 'metrics.publisher'],
          ].map(([key, label]) =>
            h('label', { key: key, className: 'ph-metricfield' }, h('span', null, t(label)), h('input', { value: form[key] || '', onChange: (event) => setForm(Object.assign({}, form, { [key]: event.target.value })) })),
          ),
          h(
            'div',
            { className: 'ph-dialog__actions' },
            h(Button, { size: 'sm', variant: 'primary', icon: 'check', loading: saving, onClick: save }, t('metrics.save')),
            h(Button, { size: 'sm', variant: 'ghost', onClick: () => setEditing(false) }, t('common.cancel')),
          ),
        )
      : null,
  )
}
