/**
 * Plugin settings centre (v0.11): capabilities & model installation, translation,
 * index/data and diagnostics. One modal shared by the paper centre, the sidebar
 * and the reader; model-install jobs are polled through `jobs.list` every 1.5 s.
 */
import React from 'react'
import { h } from '../../core/dom.js'
import { Icon } from '../../core/icons.jsx'
import { Badge, Button, IconButton, Skeleton } from '../../core/primitives.jsx'
import { describeError } from '../../core/api.js'
import { defaultApi } from '../../core/api.js'
import { notify } from '../../core/feedback.js'
import { modelForProvider } from '../../core/ai-models.js'

const JOB_POLL_MS = 1500

function opId(prefix) {
  const random = typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function' ? crypto.randomUUID() : Math.random().toString(36).slice(2)
  return (prefix || 'settings') + '-' + random
}

function bytes(value) {
  const n = Number(value)
  if (!Number.isFinite(n) || n <= 0) return '—'
  if (n >= 1024 * 1024 * 1024) return (n / (1024 * 1024 * 1024)).toFixed(1) + ' GB'
  if (n >= 1024 * 1024) return (n / (1024 * 1024)).toFixed(1) + ' MB'
  return Math.round(n / 1024) + ' KB'
}

function Toggle(props) {
  return h(
    'button',
    {
      type: 'button',
      role: 'switch',
      'aria-checked': props.checked ? 'true' : 'false',
      'aria-label': props.label,
      className: 'ph-switch' + (props.checked ? ' ph-switch--on' : '') + (props.disabled ? ' ph-switch--disabled' : ''),
      disabled: props.disabled,
      onClick: () => !props.disabled && props.onChange(!props.checked),
    },
    h('span', { className: 'ph-switch__dot' }),
  )
}

function statusOf(model) {
  if (!model) return { tone: 'muted', label: 'unknown' }
  if (model.job && (model.job.state === 'running' || model.job.state === 'queued')) return { tone: 'business', label: 'installing' }
  if (model.installed && model.enabled) return model.available === false ? { tone: 'warning', label: 'enabledUnavailable' } : { tone: 'success', label: 'ready' }
  if (model.installed && !model.enabled) return { tone: 'warning', label: 'disabled' }
  if (model.available === false || model.supported === false) return { tone: 'error', label: 'unavailable' }
  return { tone: 'warning', label: 'notInstalled' }
}

function stateLabel(t, status) {
  const map = { ready: 'ready', installing: 'installing', disabled: 'disabled', enabledUnavailable: 'enabledUnavailable', unavailable: 'unavailable', notInstalled: 'notInstalled', unknown: 'unknown' }
  return t('settings.state.' + map[status.label])
}

function JobBar(props) {
  const t = props.t
  const job = props.job
  if (!job) return null
  const progress = Number(job.progress)
  const percent = Number.isFinite(progress) ? Math.max(0, Math.min(100, progress <= 1 ? Math.round(progress * 100) : Math.round(progress))) : null
  return h(
    'div',
    { className: 'ph-job' + (job.state === 'failed' ? ' ph-job--error' : '') },
    h('div', { className: 'ph-job__head' },
      h(Icon, { name: job.state === 'failed' ? 'warning' : 'refresh', size: 12 }),
      h('span', null, job.label || t('settings.job.' + (job.kind || 'model')) || job.kind || 'job'),
      h('span', { className: 'ph-caption' }, t('settings.job.' + (job.state || 'running'))),
      percent != null ? h('span', { className: 'ph-caption' }, percent + '%') : null,
    ),
    percent != null ? h('div', { className: 'ph-progress' }, h('span', { className: 'ph-progress__bar', style: { width: percent + '%' } })) : null,
    job.error_message || job.error ? h('div', { className: 'ph-caption ph-caption--error' }, String(job.error_message || job.error)) : null,
    job.state === 'running' || job.state === 'queued' ? h('button', { type: 'button', className: 'ph-linkbtn', onClick: () => props.onCancel(job.kind) }, t('settings.cancel')) : null,
  )
}

function Section(props) {
  return h('section', { className: 'ph-settings__section' }, h('div', { className: 'ph-settings__sectionHead' }, h(Icon, { name: props.icon, size: 14 }), h('span', null, props.title), props.hint ? h('span', { className: 'ph-caption' }, props.hint) : null), props.children)
}

function Card(props) {
  const t = props.t
  const model = props.model
  const status = statusOf(model)
  const job = model && model.job ? model.job : null
  return h(
    'div',
    { className: 'ph-capcard' },
    h('div', { className: 'ph-capcard__head' },
      h('span', { className: 'ph-capcard__icon' }, h(Icon, { name: props.icon, size: 18 })),
      h('div', { className: 'ph-capcard__titlewrap' }, h('div', { className: 'ph-capcard__title' }, props.title, props.optional ? h('span', { className: 'ph-caption' }, t('settings.optional')) : null), h('div', { className: 'ph-caption' }, props.description)),
      h(Badge, { tone: status.tone }, stateLabel(t, status)),
      props.model && typeof props.onToggleEnabled === 'function' ? h(Toggle, { checked: Boolean(model.enabled), label: props.title, onChange: props.onToggleEnabled }) : null,
    ),
    h('div', { className: 'ph-capcard__facts' },
      (props.facts || []).map(([label, value]) => h('div', { key: label, className: 'ph-fact' }, h('span', { className: 'ph-fact__label' }, label), h('span', { className: 'ph-fact__value' }, value))),
    ),
    job ? h(JobBar, { t: t, job: job, onCancel: props.onCancel }) : null,
    model && model.reason ? h('div', { className: 'ph-caption ph-caption--error' }, String(model.reason)) : null,
    h('div', { className: 'ph-capcard__actions' }, props.actions || null),
  )
}

export function SettingsPanel(props) {
  const t = props.t
  const [state, setState] = React.useState({ status: 'loading', data: null, error: null })
  const [jobs, setJobs] = React.useState([])
  const [busy, setBusy] = React.useState('')
  const [test, setTest] = React.useState(null)
  const [error, setError] = React.useState('')
  const [aiCatalog, setAiCatalog] = React.useState({ status: 'idle', selection: null, providers: [], available: false, error: null })
  const [aiProvider, setAiProvider] = React.useState('')
  const [aiModel, setAiModel] = React.useState('')
  const [aiSaving, setAiSaving] = React.useState(false)
  const [backupState, setBackupState] = React.useState({ busy: '', result: null, error: '' })
  const backupInputRef = React.useRef(null)
  const pollRef = React.useRef(null)

  const load = React.useCallback(() => {
    setState((previous) => ({ status: previous.data ? 'refreshing' : 'loading', data: previous.data, error: null }))
    defaultApi('settings.get', {})
      .then((value) => {
        if (value && value.ok === false) throw Object.assign(new Error(value.error && value.error.message ? value.error.message : 'settings.get failed'), { code: value.error && value.error.code })
        setState({ status: 'ready', data: value, error: null })
      })
      .catch((err) => setState({ status: 'error', data: null, error: err }))
  }, [])

  const loadJobs = React.useCallback(() => {
    defaultApi('jobs.list', {}).then((value) => {
      const items = Array.isArray(value && value.items) ? value.items : Array.isArray(value && value.jobs) ? value.jobs : []
      setJobs(items)
    }).catch(() => {})
  }, [])

  const loadAi = React.useCallback(() => {
    setAiCatalog((previous) => Object.assign({}, previous, { status: previous.providers && previous.providers.length > 0 ? 'refreshing' : 'loading', error: null }))
    defaultApi('ai.providers', {})
      .then((value) => {
        const providers = Array.isArray(value && value.providers) ? value.providers : []
        const selection = value && value.selection ? value.selection : null
        setAiCatalog({ status: 'ready', selection: selection, providers: providers, available: Boolean(value && value.available), error: null })
        const provider = selection && selection.provider ? selection.provider : (providers[0] && providers[0].id) || ''
        const model = selection && selection.model ? selection.model : modelForProvider({ providers: providers, selection: selection }, provider)
        setAiProvider(provider)
        setAiModel(model)
      })
      .catch((err) => setAiCatalog((previous) => Object.assign({}, previous, { status: 'error', error: err })))
  }, [])

  React.useEffect(() => {
    if (!props.open) return undefined
    load()
    loadJobs()
    loadAi()
    const timer = setInterval(() => { loadJobs() }, JOB_POLL_MS)
    const onKey = (event) => { if (event.key === 'Escape') props.onClose() }
    document.addEventListener('keydown', onKey)
    return () => { clearInterval(timer); document.removeEventListener('keydown', onKey) }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.open])

  const runningJob = jobs.find((job) => job && (job.state === 'running' || job.state === 'queued'))
  const wasRunning = React.useRef(null)
  React.useEffect(() => {
    const id = runningJob ? runningJob.id : null
    if (wasRunning.current && !id) load()
    wasRunning.current = id
  }, [runningJob, load])

  if (!props.open) return null
  const data = state.data || {}
  const features = data.features || {}
  const models = data.models || {}
  const translation = data.translation || {}
  const index = data.index || {}
  const diagnostics = data.diagnostics || {}

  const patchSettings = (patch, label) => {
    const previous = state.data
    setState((current) => ({ status: current.status, data: Object.assign({}, current.data, patch.optimistic || {}), error: null }))
    setBusy(label || '')
    setError('')
    defaultApi('settings.update', { patch: patch.body || {}, operationId: opId('settings') })
      .then((value) => {
        if (value && value.features) setState({ status: 'ready', data: value, error: null })
        else load()
        notify('success', t('settings.saved'), null, 1800)
      })
      .catch((err) => {
        setState({ status: 'ready', data: previous, error: null })
        setError(describeError(t, err))
        notify('error', t('settings.saveFailed', { message: describeError(t, err) }), null, 4000)
      })
      .then(() => setBusy(''))
  }

  const toggleFeature = (key, value) => patchSettings({ optimistic: { features: Object.assign({}, features, { [key]: value }) }, body: { features: { [key]: value } } }, key)

  const toggleModel = (kind, value) => {
    const model = models[kind] || {}
    patchSettings({ optimistic: { models: Object.assign({}, models, { [kind]: Object.assign({}, model, { enabled: value }) }) }, body: { features: kind === 'ocr' ? { ocr: value } : { vectorSearch: value } } }, kind)
  }

  const clearPdfCache = () => {
    setBusy('clear-pdf-cache')
    setError('')
    defaultApi('cache.clearPdfPreviews', {})
      .then((value) => {
        const count = Number(value && value.cleared) || 0
        const freed = Number(value && value.freedBytes) || 0
        notify('success', count > 0 ? t('settings.clearPdfCacheDone', { count: count, size: bytes(freed) }) : t('settings.clearPdfCacheEmpty'), null, 3000)
      })
      .catch((err) => {
        const message = describeError(t, err)
        setError(message)
        notify('error', t('settings.clearPdfCacheFailed', { message }), null, 4000)
      })
      .then(() => setBusy(''))
  }

  const install = (kind) => {
    setBusy('install-' + kind)
    setError('')
    defaultApi('models.install', { kind: kind, operationId: opId('install') })
      .then((value) => {
        const job = value && value.job ? value.job : null
        if (job) setJobs((previous) => previous.concat([job]))
        loadJobs()
        load()
        notify('info', t('settings.installStarted'), null, 3000)
      })
      .catch((err) => { setError(describeError(t, err)); notify('error', t('settings.installFailed', { message: describeError(t, err) }), null, 5000) })
      .then(() => setBusy(''))
  }

  const uninstallPython = () => {
    setBusy('uninstall-python')
    setError('')
    defaultApi('models.uninstallPython', {})
      .then(() => { notify('info', t('settings.python.uninstalled'), null, 4000); load(); loadJobs() })
      .catch((err) => { setError(describeError(t, err)); notify('error', t('settings.installFailed', { message: describeError(t, err) }), null, 5000) })
      .then(() => setBusy(''))
  }

  const cancel = (kind) => {
    defaultApi('models.cancel', { kind: kind }).then(loadJobs).catch((err) => setError(describeError(t, err)))
  }
  const rebuild = () => {
    setBusy('rebuild')
    defaultApi('models.rebuildIndex', { operationId: opId('rebuild') }).then(() => { loadJobs(); notify('info', t('settings.rebuildStarted'), null, 3000) }).catch((err) => setError(describeError(t, err))).then(() => setBusy(''))
  }
  const ocrIndex = () => {
    setBusy('ocr-index')
    defaultApi('ocr.index', { operationId: opId('ocr') }).then(() => { loadJobs(); notify('info', t('settings.ocrIndexStarted'), null, 3000) }).catch((err) => setError(describeError(t, err))).then(() => setBusy(''))
  }
  const runTranslationTest = () => {
    setBusy('translation-test')
    setTest(null)
    defaultApi('translation.test', { provider: 'auto', text: 'We propose a general paradigm that combines reasoning and acting.' })
      .then((value) => setTest(value || { ok: false, reason: 'empty' }))
      .catch((err) => setTest({ ok: false, reason: describeError(t, err) }))
      .then(() => setBusy(''))
  }

  const saveAiDefault = () => {
    if (aiSaving || aiProvider === '' || aiModel === '') return
    setAiSaving(true)
    setError('')
    defaultApi('ai.setDefault', { provider: aiProvider, model: aiModel })
      .then((value) => {
        if (!value || value.ok === false) throw new Error((value && value.reason) || 'save failed')
        setAiCatalog((previous) => Object.assign({}, previous, { selection: value.selection || { provider: aiProvider, model: aiModel } }))
        notify('success', t('ai.settings.saved'), null, 2200)
      })
      .catch((err) => { const message = describeError(t, err); setError(t('ai.settings.saveFailed', { message: message })); notify('error', message, null, 4000) })
      .then(() => setAiSaving(false))
  }

  const exportBackup = async () => {
    if (backupState.busy) return
    setBackupState({ busy: 'export', result: null, error: '' })
    try {
      const response = await fetch('/pappers-hall/backup/export', { credentials: 'same-origin' })
      if (!response.ok) throw new Error('备份导出失败（HTTP ' + response.status + '）')
      const blob = await response.blob()
      const disposition = response.headers.get('content-disposition') || ''
      const match = /filename="([^"]+)"/i.exec(disposition)
      const filename = match ? match[1] : 'pappers-hall-backup.zip'
      let picked = false
      if (typeof window.showSaveFilePicker === 'function') {
        try {
          const handle = await window.showSaveFilePicker({
            suggestedName: filename,
            types: [{ description: 'Pappers-Hall backup', accept: { 'application/zip': ['.zip'] } }],
          })
          const writable = await handle.createWritable()
          await writable.write(blob)
          await writable.close()
          picked = true
        } catch (error) {
          if (error && error.name === 'AbortError') {
            setBackupState({ busy: '', result: null, error: '' })
            return
          }
          picked = false
        }
      }
      if (!picked) {
        const url = URL.createObjectURL(blob)
        const anchor = document.createElement('a')
        anchor.href = url
        anchor.download = filename
        anchor.rel = 'noopener'
        document.body.appendChild(anchor)
        anchor.click()
        anchor.remove()
        setTimeout(() => URL.revokeObjectURL(url), 1500)
      }
      notify('success', t('backup.exported'), null, 2600)
      setBackupState({ busy: '', result: null, error: '' })
    } catch (error) {
      setBackupState({ busy: '', result: null, error: String((error && error.message) || error) })
      notify('error', t('backup.exportFailed', { message: String((error && error.message) || error) }), null, 5000)
    }
  }

  const importBackup = (file) => {
    if (!file || backupState.busy) return
    setBackupState({ busy: 'import', result: null, error: '' })
    file.arrayBuffer()
      .then((buffer) => fetch('/pappers-hall/backup/import', { method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/zip' }, body: buffer }))
      .then((response) => response.json().then((payload) => {
        if (!response.ok || !payload || payload.ok !== true) {
          const message = payload && payload.error && payload.error.message ? payload.error.message : 'HTTP ' + response.status
          throw new Error(message)
        }
        return payload.data
      }))
      .then((result) => {
        setBackupState({ busy: '', result: result, error: '' })
        notify('success', t('backup.imported', { papers: result.counts.papers, notes: result.counts.notes }), null, 3500)
        load()
        loadJobs()
      })
      .catch((error) => {
        setBackupState({ busy: '', result: null, error: String((error && error.message) || error) })
        notify('error', t('backup.importFailed', { message: String((error && error.message) || error) }), null, 5000)
      })
  }

  const ACTIVE_JOB = (job) => job && (job.state === 'running' || job.state === 'queued' || job.state === 'failed')
  const jobFor = (kind) => {
    const model = (models && models[kind]) || null
    if (model && model.job && ACTIVE_JOB(model.job)) return model.job
    const direct = jobs.find((job) => ACTIVE_JOB(job) && job.kind === (kind === 'ocr' ? 'ocr.index' : kind === 'python' ? 'model.install' : 'embedding.index'))
    if (direct) return direct
    return jobs.find((job) => ACTIVE_JOB(job) && job.kind === 'model.install' && (job.modelKind === kind || job.model === kind)) || null
  }
  const providers = Array.isArray(translation.providers) ? translation.providers : []
  const channels = index.channels || {}
  const channelLabels = { fts: t('settings.channel.fts'), vector: t('settings.channel.vector'), ocr: t('settings.channel.ocr'), translation: t('settings.channel.translation') }
  const embedding = models.embedding || {}
  const ocr = models.ocr || {}
  const python = models.python || {}
  const providerList = Array.isArray(translation.providers) ? translation.providers : []
  const capabilities = diagnostics.capabilities || {}
  const translationState = capabilities.translation
    ? String(capabilities.translation)
    : providerList.some((provider) => provider.enabled && provider.available !== false)
      ? 'ready'
      : providerList.some((provider) => provider.enabled)
        ? 'degraded'
        : 'disabled'
  const pythonState = python.installed ? (python.available === false ? 'unavailable' : 'ready') : 'notInstalled'
  const ocrState = ocr.installed
    ? (ocr.available === false ? 'unavailable' : (ocr.enabled ? 'ready' : 'disabled'))
    : 'notInstalled'
  const aiProviders = Array.isArray(aiCatalog.providers) ? aiCatalog.providers : []
  const aiSelection = aiCatalog.selection || {}
  const aiProviderEntry = aiProviders.find((entry) => entry.id === aiProvider) || null
  const aiModelList = aiProviderEntry && Array.isArray(aiProviderEntry.models) ? aiProviderEntry.models : []
  const aiSynced = Boolean(aiSelection.provider === aiProvider && aiSelection.model === aiModel)
  const channelStates = {
    fts: channels.fts || 'unknown',
    vector: channels.vector || (embedding.installed ? (embedding.enabled ? 'ready' : 'disabled') : 'notInstalled'),
    ocr: ocrState,
    translation: translationState,
  }
  const stateTone = (state) => (state === 'ready' || state === 'ok' ? 'success' : state === 'degraded' ? 'warning' : state === 'unavailable' || state === 'error' ? 'error' : state === 'disabled' || state === 'notInstalled' ? 'muted' : 'muted')
  const stateText = (state) => {
    const key = 'settings.state.' + String(state || 'unknown')
    const text = t(key)
    return text === key ? String(state || 'unknown') : text
  }
  const pluginVersion = diagnostics.pluginVersion || diagnostics.version || '—'
  const schemaVersion = diagnostics.schemaVersion != null ? String(diagnostics.schemaVersion) : diagnostics.schema != null ? String(diagnostics.schema) : '—'
  const embeddingWithJob = Object.assign({}, embedding, { job: jobFor('embedding') })
  const ocrWithJob = Object.assign({}, ocr, { job: jobFor('ocr') })
  const status = index.embedding || index
  const counts = Object.assign({}, diagnostics.counts || {}, (status && status.counts) || {})

  const dialogRef = React.useRef(null)
  React.useEffect(() => {
    const dialog = dialogRef.current
    if (dialog === null) return undefined
    try { if (!dialog.open) dialog.showModal() } catch (error) { /* fallback: rendered inline */ }
    return () => { try { if (dialog.open) dialog.close() } catch (error) { /* ignore */ } }
  }, [])

  return h(
    'dialog',
    {
      ref: dialogRef,
      className: 'ph-settingsdialog',
      'aria-label': t('settings.title'),
      onCancel: (event) => { event.preventDefault(); props.onClose() },
    },
    h(
      'div',
      { className: 'ph-settingsbackdrop', onMouseDown: (event) => { if (event.target === event.currentTarget) props.onClose() } },
    h(
      'div',
      { className: 'ph-settings', role: 'dialog', 'aria-modal': 'true', 'aria-label': t('settings.title') },
      h('div', { className: 'ph-settings__head' },
        h(Icon, { name: 'settings', size: 16 }),
        h('span', { className: 'ph-settings__title' }, t('settings.title')),
        h('span', { className: 'ph-caption' }, t('settings.versionTag', { version: pluginVersion })),
        h('span', { className: 'ph-spacer' }),
        state.status === 'refreshing' ? h('span', { className: 'ph-caption' }, t('common.loading')) : null,
        h(IconButton, { icon: 'refresh', title: t('settings.refresh'), onClick: () => { load(); loadJobs() } }),
        h(IconButton, { icon: 'close', title: t('common.close'), onClick: props.onClose }),
      ),
      h('div', { className: 'ph-settings__body ph-scroll' },
        state.status === 'loading' && !state.data
          ? h('div', { className: 'ph-settings__skeleton' }, [0, 1, 2, 3].map((i) => h(Skeleton, { key: i, width: '100%', height: 72, radius: 10 })))
          : state.status === 'error' && !state.data
            ? h('div', { className: 'ph-settings__error' }, h(Icon, { name: 'warning', size: 18 }), h('div', null, h('div', { className: 'ph-settings__errorTitle' }, t('settings.loadFailed')), h('div', { className: 'ph-caption' }, describeError(t, state.error)), h(Button, { size: 'sm', variant: 'secondary', icon: 'refresh', onClick: load }, t('common.retry'))))
            : h(React.Fragment, null,
                h(Section, { icon: 'sparkles', title: t('ai.settings.title'), hint: t('ai.settings.desc') },
                  h('div', { className: 'ph-ai-modelcard' },
                    h('div', { className: 'ph-ai-modelcard__head' },
                      h('div', { className: 'ph-ai-modelcard__current' },
                        h('span', { className: 'ph-caption' }, t('ai.settings.current')),
                        h('strong', null, (aiSelection.provider || '—') + ' / ' + (aiSelection.model || '—')),
                      ),
                      aiSynced ? h(Badge, { tone: 'success' }, t('ai.settings.sync')) : null,
                    ),
                    aiCatalog.status === 'loading'
                      ? h('div', { className: 'ph-caption' }, t('common.loading'))
                      : aiCatalog.status === 'error'
                        ? h('div', { className: 'ph-caption ph-caption--error' }, describeError(t, aiCatalog.error))
                        : aiProviders.length === 0
                          ? h('div', { className: 'ph-caption' }, t('ai.settings.noProvider'))
                          : h('div', { className: 'ph-ai-modelcard__form' },
                              h('label', { className: 'ph-ai-modelcard__field' },
                                h('span', { className: 'ph-caption' }, t('ai.settings.provider')),
                                h('select', { className: 'ph-select', value: aiProvider, onChange: (event) => {
                                  const provider = event.target.value
                                  setAiProvider(provider)
                                  setAiModel(modelForProvider({ providers: aiProviders, selection: aiSelection }, provider))
                                } }, aiProviders.map((provider) => h('option', { key: provider.id, value: provider.id }, provider.name || provider.id))),
                              ),
                              h('label', { className: 'ph-ai-modelcard__field' },
                                h('span', { className: 'ph-caption' }, t('ai.settings.model')),
                                aiModelList.length > 0
                                  ? h('select', { className: 'ph-select', value: aiModel, onChange: (event) => setAiModel(event.target.value) }, aiModelList.map((model) => h('option', { key: model.id, value: model.id }, model.name || model.id)))
                                  : h('input', { className: 'ph-select', value: aiModel, placeholder: t('ai.settings.modelPlaceholder'), onChange: (event) => setAiModel(event.target.value) }),
                                aiModelList.length === 0 ? h('span', { className: 'ph-caption' }, t('ai.settings.noModels')) : null,
                              ),
                              h('div', { className: 'ph-ai-modelcard__actions' },
                                h(Button, { size: 'sm', variant: 'primary', loading: aiSaving, disabled: aiProvider === '' || aiModel === '' || aiSynced, onClick: saveAiDefault }, t('ai.settings.save')),
                                h(Button, { size: 'sm', icon: 'refresh', onClick: loadAi }, t('ai.settings.reload')),
                              ),
                            ),
                  ),
                ),
                h(Section, { icon: 'sparkles', title: t('settings.section.capabilities'), hint: t('settings.section.capabilitiesHint') },
                  h(Card, {
                    t: t, icon: 'search', title: t('settings.embedding.title'), description: t('settings.embedding.desc'), model: embeddingWithJob,
                    facts: [
                      [t('settings.model'), embedding.model || t('settings.notConfigured')],
                      [t('settings.dims'), embedding.dims ? String(embedding.dims) : '—'],
                      [t('settings.size'), bytes(embedding.sizeBytes)],
                      [t('settings.indexedChunks'), counts.chunks != null ? String(counts.chunks) : '—'],
                    ],
                    onToggleEnabled: (value) => toggleModel('embedding', value),
                    onCancel: cancel,
                    actions: [
                      h(Button, { key: 'install', size: 'sm', variant: 'primary', icon: 'download', loading: busy === 'install-embedding', disabled: Boolean(runningJob), onClick: () => install('embedding') }, embedding.installed ? t('settings.reinstallEmbedding') : t('settings.installEmbedding')),
                      h(Button, { key: 'rebuild', size: 'sm', icon: 'refresh', loading: busy === 'rebuild', onClick: rebuild }, t('settings.rebuildIndex')),
                      h('span', { key: 'hint', className: 'ph-caption' }, t('settings.embeddingHint', { script: embedding.setupScript || 'scripts/setup-embedding.sh' })),
                    ],
                  }),
                  h(Card, {
                    t: t, icon: 'cpu', title: t('settings.python.title'), description: t('settings.python.desc'), model: Object.assign({}, python, { job: jobFor('python') }), optional: true,
                    facts: [
                      [t('settings.python.pdfBackend'), python.engines && python.engines.pdf ? python.engines.pdf : t('settings.python.fallbackPdf')],
                      [t('settings.python.ocrEngine'), python.engines && python.engines.ocr ? python.engines.ocr : '—'],
                      [t('settings.python.layoutEngine'), python.engines && python.engines.layout ? python.engines.layout : '—'],
                      [t('settings.size'), bytes(python.sizeBytes)],
                    ],
                    onCancel: cancel,
                    actions: [
                      h(Button, { key: 'install', size: 'sm', variant: 'primary', icon: 'download', loading: busy === 'install-python', disabled: Boolean(runningJob), onClick: () => install('python') }, python.installed ? t('settings.python.reinstall') : t('settings.python.install')),
                      python.installed ? h(Button, { key: 'uninstall', size: 'sm', icon: 'trash', loading: busy === 'uninstall-python', disabled: Boolean(runningJob), onClick: uninstallPython }, t('settings.python.uninstall')) : null,
                      h('span', { key: 'hint', className: 'ph-caption' }, t('settings.python.hint')),
                    ],
                  }),
                  h(Card, {
                    t: t, icon: 'scan', title: t('settings.ocr.title'), description: t('settings.ocr.desc'), model: ocrWithJob, optional: true,
                    facts: [
                      [t('settings.engine'), ocr.engine || 'PP-OCRv6'],
                      [t('settings.python.layoutEngine'), ocr.layoutModel ? 'PP-DocLayout-S' : '—'],
                      [t('settings.size'), bytes(ocr.sizeBytes)],
                      [t('settings.scanPages'), ocr.scanPages != null ? String(ocr.scanPages) : '—'],
                      [t('settings.indexedPages'), (ocr.job && ocr.job.state === 'running') ? '…' : (ocr.indexedPages != null ? String(ocr.indexedPages) : '—')],
                    ],
                    onToggleEnabled: (value) => toggleModel('ocr', value),
                    onCancel: cancel,
                    actions: [
                      h(Button, { key: 'idx', size: 'sm', icon: 'scan', loading: busy === 'ocr-index', disabled: !ocr.available || !ocr.enabled, onClick: ocrIndex }, t('settings.ocrIndex')),
                      h('span', { key: 'hint', className: 'ph-caption' }, t('settings.ocrHint')),
                    ],
                  }),
                ),
                h(Section, { icon: 'compass', title: t('settings.section.guide'), hint: t('settings.guide.hint') },
                  h('div', { className: 'ph-settings__testrow' },
                    h(Button, { size: 'sm', icon: 'compass', onClick: () => { defaultApi('onboarding.reset').catch(() => {}).then(() => notify('success', t('settings.guide.reset'), null, 2500)) } }, t('settings.guide.reopen')),
                    h('span', { className: 'ph-caption' }, t('settings.guide.body')),
                  ),
                ),
                h(Section, { icon: 'globe', title: t('settings.section.translation') },
                  h('div', { className: 'ph-settings__list' }, providers.map((provider) => h('div', { key: provider.id, className: 'ph-settingrow' },
                    h('span', { className: 'ph-settingrow__name' }, provider.label || provider.id, provider.free ? h(Badge, { tone: 'muted' }, t('settings.free')) : null),
                    h('span', { className: 'ph-caption' }, provider.enabled
                      ? (provider.available === false ? t('settings.state.enabledUnavailable') : t('settings.state.enabled'))
                      : (provider.id === 'llm' ? t('settings.state.disabled') + ' · ' + t('settings.llmExplicit') : t('settings.state.disabled'))),
                    h(Toggle, { checked: Boolean(provider.enabled), label: provider.id, onChange: (value) => { const next = providers.map((entry) => entry.id === provider.id ? Object.assign({}, entry, { enabled: value }) : entry); patchSettings({ optimistic: { translation: Object.assign({}, translation, { providers: next }) }, body: { translation: { providers: next.map((entry) => ({ id: entry.id, enabled: entry.enabled })) } } }, 'provider-' + provider.id) } }),
                  ))),
                  h('div', { className: 'ph-settingrow' }, h('span', { className: 'ph-settingrow__name' }, t('settings.fallback')), h(Toggle, { checked: translation.fallbackEnabled !== false, label: t('settings.fallback'), onChange: (value) => patchSettings({ optimistic: { translation: Object.assign({}, translation, { fallbackEnabled: value }) }, body: { translation: { fallbackEnabled: value } } }, 'fallback') })),
                  h('div', { className: 'ph-settings__testrow' }, h(Button, { size: 'sm', icon: 'play', loading: busy === 'translation-test', onClick: runTranslationTest }, t('settings.translation.test')), h('span', { className: 'ph-caption' }, t('settings.translation.testHint'))),
                  test ? h('div', { className: 'ph-testbox' + (test.ok ? '' : ' ph-testbox--error') }, h('div', { className: 'ph-testbox__head' }, h(Badge, { tone: test.ok ? 'success' : 'error' }, test.ok ? t('settings.translation.ok') : t('settings.translation.failed')), h('span', { className: 'ph-caption' }, (test.provider || '—') + (test.latencyMs ? ' · ' + test.latencyMs + 'ms' : '')), test.cached ? h(Badge, { tone: 'muted' }, t('settings.cached')) : null), h('div', { className: 'ph-testbox__text' }, test.ok ? String(test.translated || test.translation || '') : String(test.reason || t('common.unavailable')))) : null,
                ),
                h(Section, { icon: 'chart', title: t('settings.section.index'), hint: t('settings.section.indexHint') },
                  h('div', { className: 'ph-channelgrid' }, Object.keys(channelLabels).map((id) => h('div', { key: id, className: 'ph-channel' }, h('span', { className: 'ph-channel__name' }, channelLabels[id]), h(Badge, { tone: stateTone(channelStates[id]) }, stateText(channelStates[id]))))),
                  h('div', { className: 'ph-settingrow' }, h('span', { className: 'ph-settingrow__name' }, t('settings.autoIndex')), h('span', { className: 'ph-caption' }, t('settings.autoIndexHint')), h(Toggle, { checked: features.autoIndex !== false, label: t('settings.autoIndex'), onChange: (value) => toggleFeature('autoIndex', value) })),
                  h('div', { className: 'ph-settingrow' },
                    h('span', { className: 'ph-settingrow__name' }, t('settings.lastSync')),
                    h('span', { className: 'ph-caption' }, (status && status.sync && status.sync.lastSyncedAt) ? String(status.sync.lastSyncedAt).slice(0, 19).replace('T', ' ') : t('settings.never')),
                    h(Badge, { tone: features.autoIndex === false ? 'muted' : ((status && status.sync && (status.sync.running || status.sync.state === 'running')) ? 'business' : 'success') }, features.autoIndex === false ? t('settings.sync.autoOff') : ((status && status.sync && (status.sync.running || status.sync.state === 'running')) ? t('settings.sync.syncing') : t('settings.sync.completed'))),
                  ),
                  h('div', { className: 'ph-settings__testrow' }, h(Button, { size: 'sm', icon: 'refresh', loading: busy === 'rebuild', onClick: rebuild }, t('settings.rebuildIndex'))),
                  h('div', { className: 'ph-settings__testrow' },
                    h(Button, { size: 'sm', icon: 'trash', loading: busy === 'clear-pdf-cache', onClick: clearPdfCache }, t('settings.clearPdfCache')),
                    h('span', { className: 'ph-caption' }, t('settings.clearPdfCacheHint')),
                  ),
                ),
                h(Section, { icon: 'download', title: t('backup.title'), hint: t('backup.desc') },
                  h('div', { className: 'ph-backup' },
                    h('div', { className: 'ph-backup__row' },
                      h('div', { className: 'ph-backup__copy' },
                        h('div', { className: 'ph-backup__label' }, t('backup.exportTitle')),
                        h('div', { className: 'ph-caption' }, t('backup.exportHint')),
                      ),
                      h(Button, { size: 'sm', variant: 'primary', icon: 'download', loading: backupState.busy === 'export', onClick: exportBackup }, t('backup.export')),
                    ),
                    h('div', { className: 'ph-backup__row' },
                      h('div', { className: 'ph-backup__copy' },
                        h('div', { className: 'ph-backup__label' }, t('backup.importTitle')),
                        h('div', { className: 'ph-caption' }, t('backup.importHint')),
                      ),
                      h(Button, { size: 'sm', icon: 'import', loading: backupState.busy === 'import', onClick: () => backupInputRef.current && backupInputRef.current.click() }, t('backup.import')),
                      h('input', { ref: backupInputRef, type: 'file', accept: '.zip,application/zip', style: { display: 'none' }, onChange: (event) => { const file = event.target.files && event.target.files[0]; event.target.value = ''; if (file) importBackup(file) } }),
                    ),
                    backupState.result
                      ? h('div', { className: 'ph-backup__result' }, h(Icon, { name: 'check', size: 14 }), h('span', null, t('backup.result', { papers: backupState.result.counts.papers, notes: backupState.result.counts.notes, pdfs: backupState.result.counts.pdfs, annotations: backupState.result.counts.annotations })))
                      : null,
                    backupState.error ? h('div', { className: 'ph-caption ph-caption--error', role: 'status' }, backupState.error) : null,
                  ),
                ),
                h(Section, { icon: 'info', title: t('settings.section.about') },
                  h('div', { className: 'ph-aboutgrid' },
                    [['settings.version', pluginVersion], ['settings.schema', schemaVersion], ['settings.dataDir', diagnostics.dataDir || '—'], ['settings.papers', counts.papers != null ? String(counts.papers) : '—'], ['settings.annotations', counts.annotations != null ? String(counts.annotations) : '—'], ['settings.figures', counts.figures != null ? String(counts.figures) : '—']].map(([key, value]) => h('div', { key: key, className: 'ph-fact' }, h('span', { className: 'ph-fact__label' }, t(key)), h('span', { className: 'ph-fact__value ph-fact__value--mono' }, value))),
                  ),
                  h('div', { className: 'ph-caption' }, t('settings.noSecrets')),
                ),
                error ? h('div', { className: 'ph-caption ph-caption--error', role: 'status' }, error) : null,
              ),
      ),
      h('div', { className: 'ph-settings__foot' },
        h('span', { className: 'ph-caption' }, t('settings.footerHint')),
        h('span', { className: 'ph-spacer' }),
        h(Button, { size: 'sm', variant: 'secondary', onClick: props.onClose }, t('settings.done')),
      ),
    ),
    ),
  )
}
